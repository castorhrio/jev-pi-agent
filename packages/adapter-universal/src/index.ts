/**
 * @ucad/adapter-universal — the reference *real* adapter.
 *
 * The mock adapter proved the protocol. This one is what makes the product
 * usable: it speaks to any OpenAI-compatible provider through `@ucad/providers`,
 * and it honours the two contracts that make this product different:
 *
 *   I-3  the injection is placed in the system prompt **verbatim**, never
 *        rewritten, re-wrapped, or "cleaned up"
 *   NFR-13 the bytes we send are what `renderContextPack` produced, so
 *        `renderedHash` is a real claim about a real request
 *
 * It deliberately does NOT implement tool calling yet. Every provider in the
 * catalogue reports `toolCalls: false`, so claiming otherwise would put a lie in
 * the Capability block — and the whole repository's rule is that an absent
 * capability must be absent, not empty.
 */

import {
  ProviderClient,
  ModelRegistry,
  getProvider,
  listProviders,
  type SecretLike,
} from '@ucad/providers';
import {
  appError,
  type AdapterInitializeContext,
  type AgentAdapter,
  type AgentCapabilities,
  type AgentManifest,
  type AgentSessionHandle,
  type AgentTurnInput,
  type CreateAgentSessionInput,
  type InboundEventProposal,
  type ModelDescriptor,
  type ModelListContext,
  type ResumeAgentSessionInput,
  type SecretRef,
} from '@ucad/contracts';
import { describeError } from '@ucad/contracts';
import type { Logger } from '@ucad/observability';
import { silentLogger, ulid } from '@ucad/observability';

export interface UniversalAdapterOptions {
  logger: Logger;
  /**
   * The adapter's own credential source — the *last* resort.
   *
   * For the real adapter this is the environment (a development convenience);
   * for a test it is a fixture. An adapter that has a credential channel does
   * not need one, which is why it is optional.
   */
  secrets?: SecretLike;
  /**
   * The credential channel Main opened for this Host.
   *
   * It wins over `secrets`: a key the user saved in Settings is the answer
   * they gave, and the environment must never override it.
   */
  secretResolver?: (ref: SecretRef) => Promise<string | null>;
  client?: ProviderClient;
  /**
   * The transport the provider client uses.
   *
   * It exists so a test can point the adapter at a local mock server without
   * replacing the whole client — replacing the client would also replace the
   * credential seam, which is the thing under test.
   */
  fetchImpl?: typeof fetch;
  registry?: ModelRegistry;
  /** default provider when the session does not name one */
  defaultProviderId?: string;
  defaultModelId?: string;
  temperature?: number;
  maxOutputTokens?: number;
}

const CAPABILITIES: AgentCapabilities = {
  streaming: true,
  sessionResume: false,
  modelSelection: true,
  fileTools: false,
  shellTools: false,
  permissionCallbacks: 'none',
  nativeSandbox: false,
  mcp: false,
  skills: false,
  subagents: false,
  usageReporting: 'full',
  injectionModes: ['prompt_prefix', 'ucad_tools'],
  toolContract: 'none',
  contextWindowTokens: 128_000,
};

export class UniversalAgentAdapter implements AgentAdapter {
  readonly manifest: AgentManifest;
  private readonly opts: UniversalAdapterOptions;
  private readonly client: ProviderClient;
  private readonly registry: ModelRegistry;
  private readonly sessions = new Map<string, UniversalSession>();
  /**
   * The credential channel, injected by the Host at `initialize`.
   *
   * It is set late on purpose: the adapter is constructed before the Host
   * initialises it, and a credential is read at request time — never at
   * construction time.
   */
  private secretResolver: ((ref: SecretRef) => Promise<string | null>) | undefined;
  private initialized = false;

  constructor(opts: UniversalAdapterOptions) {
    this.opts = opts;
    this.secretResolver = opts.secretResolver;
    this.client =
      opts.client ??
      new ProviderClient({
        logger: opts.logger,
        secrets: this.effectiveSecrets(),
        ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
      });
    this.registry = opts.registry ?? new ModelRegistry({ client: this.client, logger: opts.logger });
    this.manifest = {
      id: 'universal',
      displayName: 'Universal (any provider)',
      // ADR-017: `universal` + `ucad_managed` is exactly this shape — UCAD picks
      // the provider and the model, the vendor runtime does not own them.
      kind: 'universal',
      isDefaultRuntime: true,
      version: '0.1.0',
      pinned: [],
      transport: 'child_process',
      providerBinding: 'ucad_managed',
      capabilities: CAPABILITIES,
    };
  }

  async initialize(ctx: AdapterInitializeContext): Promise<void> {
    this.initialized = true;
    // The credential channel arrives with the initialisation context and is
    // used from the first request onwards.
    this.secretResolver = ctx.secretResolver;
    this.opts.logger.info('universal adapter initialised', {
      agentHostId: ctx.agentHostId,
      workspaceRoot: ctx.workspaceRoot,
    });
  }

  /**
   * The credential source the provider client reads from.
   *
   * Order: the channel Main opened, then the adapter's own fallback. The
   * channel is asked first because a key saved in Settings is the user's
   * answer; the environment is a development convenience and must never win
   * over it.
   */
  private effectiveSecrets(): SecretLike {
    return {
      get: async (ref) => this.resolveSecret(ref, true),
      exists: async (ref) => (await this.resolveSecret(ref, false)) !== null,
    };
  }

  /**
   * Resolve one credential.
   *
   * `announceFallback` exists so that the "the key came from the environment"
   * warning is logged once per lookup that actually uses it — `exists()` is a
   * probe and must not double the noise.
   */
  private async resolveSecret(ref: SecretRef, announceFallback: boolean): Promise<string | null> {
    const resolver = this.secretResolver;
    if (resolver) {
      try {
        const value = await resolver(ref);
        if (value !== null && value.trim() !== '') return value;
      } catch (err) {
        // A broken channel is not a broken credential: the fallback may still
        // have one, and the failure is worth saying out loud either way.
        this.opts.logger.warn('credential channel failed', {
          providerId: ref.providerId,
          key: ref.key,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const fallback = this.opts.secrets;
    if (!fallback) return null;
    let value: string | null;
    try {
      value = await fallback.get(ref);
    } catch (err) {
      this.opts.logger.warn('credential fallback failed', {
        providerId: ref.providerId,
        key: ref.key,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
    if (value !== null && value.trim() !== '' && announceFallback) {
      // The user must be able to tell where the key came from. A key that
      // silently comes from the environment is a key the Settings panel does
      // not describe.
      this.opts.logger.warn('credential came from the environment, not from Settings', {
        providerId: ref.providerId,
      });
    }
    return value;
  }

  async listModels(_ctx: ModelListContext): Promise<ModelDescriptor[]> {
    const id = this.opts.defaultProviderId ?? this.manifest.id;
    try {
      return await this.registry.refresh(id);
    } catch {
      // A provider that is down still has a catalogued list; showing it beats
      // showing nothing.
      return getProvider(id)?.models ?? [];
    }
  }

  async createSession(input: CreateAgentSessionInput): Promise<AgentSessionHandle> {
    if (!this.initialized) {
      throw appError('AGENT_START_FAILED', 'adapter not initialised', 'agent');
    }
    const session = new UniversalSession(input, this.opts, this.client, this.registry);
    this.sessions.set(input.ucadSessionId, session);
    return session;
  }

  async resumeSession(input: ResumeAgentSessionInput): Promise<AgentSessionHandle> {
    // The vendor conversation id is UCAD's to keep, not ours; UCAD keeps the
    // transcript and re-plays a handoff instead. Say so honestly rather than
    // pretending a native resume happened.
    this.opts.logger.info('resume is served from the UCAD transcript, not the vendor', {
      ucadSessionId: input.ucadSessionId,
    });
    throw appError(
      'NATIVE_SESSION_LOST',
      '该 Provider 不支持原生会话恢复；UCAD 会用交接摘要开启新会话',
      'agent',
    );
  }

  async dispose(): Promise<void> {
    for (const session of this.sessions.values()) await session.dispose();
    this.sessions.clear();
  }
}

interface TurnRuntime {
  controller: AbortController;
  messageId: string;
}

/**
 * The model a turn names.
 *
 * A model id belongs to a vendor: `gpt-4o-mini` means nothing to DeepSeek, so
 * a provider that changed without a model would produce a request the vendor
 * rejects with a 400 about the model — which reads like a broken product and
 * is not one.
 *
 * The order is therefore: what the session names, then the pair the adapter
 * was configured with *if that pair's vendor is the one in play*, then the
 * chosen vendor's own seeded model. A vendor with no seeded model (a local
 * runtime serves whatever is pulled) falls back to the configured default,
 * which is the best guess available and no worse than before.
 */
function pickModel(
  providerId: string,
  named: string | undefined,
  opts: UniversalAdapterOptions,
): string {
  if (named !== undefined && named.trim() !== '') return named;
  const defaultProviderId = opts.defaultProviderId ?? 'openai';
  if (providerId === defaultProviderId && opts.defaultModelId !== undefined) {
    return opts.defaultModelId;
  }
  const seeded = getProvider(providerId)?.models[0]?.id;
  return seeded ?? opts.defaultModelId ?? 'gpt-4o-mini';
}

class UniversalSession implements AgentSessionHandle {
  readonly ucadSessionId: string;
  readonly nativeSessionId?: string;
  /** the vendor this session talks to */
  private readonly providerId: string;
  /** the model this session talks to */
  private readonly modelId: string;
  private readonly turns = new Map<string, TurnRuntime>();
  private disposed = false;

  constructor(
    input: CreateAgentSessionInput,
    private readonly opts: UniversalAdapterOptions,
    private readonly client: ProviderClient,
    private readonly registry: ModelRegistry,
  ) {
    this.ucadSessionId = input.ucadSessionId;
    // Providers are stateless per request, so there is no native session id to
    // keep. Reporting a fabricated one would break §4.3 S-3.
    this.nativeSessionId = undefined;
    // ADR-017: `ucad_managed` means UCAD picks the provider and the model.
    // The session names them — the adapter's defaults only fill a gap. Reading
    // the defaults instead made the Composer's choice a decoration: the card
    // said one vendor and the request went to another.
    this.providerId = input.providerId ?? opts.defaultProviderId ?? 'openai';
    this.modelId = pickModel(this.providerId, input.modelId, opts);
  }

  async *send(input: AgentTurnInput): AsyncIterable<InboundEventProposal> {
    const startedAt = Date.now();
    let hostSeq = 0;
    const emit = (
      type: InboundEventProposal['type'],
      payload: unknown,
      source: InboundEventProposal['source'] = { kind: 'agent', agentId: 'universal' },
    ): InboundEventProposal => ({
      hostSeq: ++hostSeq,
      turnId: input.turnId,
      type,
      source,
      payload,
      ts: new Date().toISOString(),
    });

    yield emit('turn.started', { objective: input.objective });

    const controller = new AbortController();
    const messageId = ulid('msg_');
    this.turns.set(input.turnId, { controller, messageId });

    const providerId = this.providerId;
    const model = this.modelId;

    let usage: { input?: number; output?: number; source: 'vendor' | 'computed' | 'unknown' } = {
      source: 'unknown',
    };
    let finishReason: string | undefined;

    try {
      // §4.6 I-3: the rendered context goes into the system message **byte for
      // byte**. `renderedHash` is computed over exactly this string, so if we
      // ever wrapped, trimmed or reformatted it here, the hash would stop being
      // evidence.
      const messages = [
        { role: 'system' as const, content: input.injection.rendered },
        { role: 'user' as const, content: input.objective },
      ];

      for await (const chunk of this.client.stream({
        providerId,
        model,
        messages,
        stream: true,
        signal: controller.signal,
        ...(this.opts.temperature !== undefined ? { temperature: this.opts.temperature } : {}),
        ...(this.opts.maxOutputTokens !== undefined
          ? { maxOutputTokens: this.opts.maxOutputTokens }
          : {}),
      })) {
        if (this.disposed) break;
        if (chunk.delta) {
          yield emit('text.delta', { text: chunk.delta, messageId });
        }
        if (chunk.usage) {
          usage = {
            ...(chunk.usage.inputTokens !== undefined ? { input: chunk.usage.inputTokens } : {}),
            ...(chunk.usage.outputTokens !== undefined ? { output: chunk.usage.outputTokens } : {}),
            source: chunk.usage.source,
          };
        }
        if (chunk.finishReason) finishReason = chunk.finishReason;
        if (chunk.done) break;
      }

      yield emit('usage', {
        record: {
          sessionId: this.ucadSessionId,
          turnId: input.turnId,
          agentId: 'universal',
          providerId,
          modelId: model,
          ...(usage.input !== undefined ? { inputTokens: usage.input } : {}),
          ...(usage.output !== undefined ? { outputTokens: usage.output } : {}),
          durationMs: Date.now() - startedAt,
          // A vendor that reported nothing is `unknown`, never a made-up count
          // and never a zero cost presented as free.
          source: usage.source,
        },
      });

      yield emit('turn.completed', {
        status: 'completed',
        durationMs: Date.now() - startedAt,
        ...(finishReason ? { messageId } : {}),
      });
    } catch (error) {
      const aborted = controller.signal.aborted;
      const message =
        describeError(error);
      if (aborted) {
        yield emit('turn.completed', {
          status: 'cancelled',
          durationMs: Date.now() - startedAt,
        });
      } else {
        this.opts.logger.warn('universal turn failed', {
          turnId: input.turnId,
          providerId,
          model,
          message,
        });
        yield emit('error', {
          code: 'NETWORK_ERROR',
          message: `模型调用失败：${message}`,
          retryable: true,
          component: 'agent',
          vendor: { name: providerId },
        });
        yield emit('turn.completed', {
          status: 'failed',
          durationMs: Date.now() - startedAt,
        });
      }
    } finally {
      this.turns.delete(input.turnId);
    }
  }

  async cancel(reason?: string): Promise<void> {
    for (const [turnId, runtime] of this.turns) {
      this.opts.logger.info('cancelling turn', { turnId, reason });
      runtime.controller.abort();
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const runtime of this.turns.values()) runtime.controller.abort();
    this.turns.clear();
  }
}

export function createUniversalAdapter(opts: UniversalAdapterOptions): UniversalAgentAdapter {
  return new UniversalAgentAdapter(opts);
}

/**
 * The zero-argument factory the Agent Host bootstrap looks for.
 *
 * The Host runs in a forked process with no Electron and no dependency
 * injection, so this is where the adapter's own seams are constructed.
 *
 * The credential is **not** read from the environment here. Main opens a
 * channel for it: the Host asks for a reference, Main answers from the OS
 * keychain where the user saved it in Settings. The environment is only a
 * fallback for development and CI, and it is scoped to one vendor each — an
 * unscoped fallback would answer a request for DeepSeek with the OpenAI key
 * the shell happened to export, which is a credential sent to the wrong
 * vendor.
 *
 * A key that is in neither place resolves to `null`, the provider reports a
 * clear 401-shaped failure, and the user is told to add it in Settings — no
 * silent misconfiguration.
 */
export function createAdapter(): UniversalAgentAdapter {
  const requestedProviderId = process.env.UCAD_PROVIDER_ID ?? 'openai';
  const modelId = process.env.UCAD_MODEL_ID ?? 'gpt-4o-mini';

  // The provider is resolved to its catalogue descriptor *here*, and only the
  // descriptor's own canonical id travels into the adapter's options: an
  // unknown `UCAD_PROVIDER_ID` is a boot-time misconfiguration and must fail
  // loudly with its name, not surface minutes later as a mystery vendor error
  // from inside a turn. The environment string itself never flows further —
  // the id that reaches requests is the catalogue's, byte for byte.
  const resolvedProvider = getProvider(requestedProviderId);
  if (resolvedProvider === undefined) {
    const known = listProviders()
      .map((p) => p.id)
      .join(', ');
    throw new Error(
      `UCAD_PROVIDER_ID "${requestedProviderId}" is not a known provider (known: ${known})`,
    );
  }

  // `OPENAI_API_KEY` belongs to OpenAI; `UCAD_PROVIDER_API_KEY` belongs to
  // whichever provider `UCAD_PROVIDER_ID` names, and wins over the former
  // when both are exported for the same vendor.
  const envKeys = new Map<string, string>();
  const openAiKey = process.env.OPENAI_API_KEY;
  if (openAiKey) envKeys.set('openai', openAiKey);
  const explicitKey = process.env.UCAD_PROVIDER_API_KEY;
  if (explicitKey) envKeys.set(resolvedProvider.id, explicitKey);

  return new UniversalAgentAdapter({
    logger: silentLogger('universal'),
    secrets: {
      get: async (ref) => envKeys.get(ref.providerId) ?? null,
      exists: async (ref) => envKeys.has(ref.providerId),
    },
    defaultProviderId: resolvedProvider.id,
    defaultModelId: modelId,
  });
}
