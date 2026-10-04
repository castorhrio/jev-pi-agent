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
} from '@ucad/contracts';
import { describeError } from '@ucad/contracts';
import type { Logger } from '@ucad/observability';
import { silentLogger, ulid } from '@ucad/observability';

export interface UniversalAdapterOptions {
  logger: Logger;
  secrets: SecretLike;
  client?: ProviderClient;
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
  private initialized = false;

  constructor(opts: UniversalAdapterOptions) {
    this.opts = opts;
    this.client = opts.client ?? new ProviderClient({ logger: opts.logger, secrets: opts.secrets });
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
    this.opts.logger.info('universal adapter initialised', {
      agentHostId: ctx.agentHostId,
      workspaceRoot: ctx.workspaceRoot,
    });
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

class UniversalSession implements AgentSessionHandle {
  readonly ucadSessionId: string;
  readonly nativeSessionId?: string;
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

    const providerId = this.opts.defaultProviderId ?? 'openai';
    const model = this.opts.defaultModelId ?? 'gpt-4o-mini';

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
 * injection, so the secrets seam is constructed here against the environment.
 * A key that is not in the environment resolves to `null`, the provider reports
 * a clear 401-shaped failure, and the user is told to add it in Settings — no
 * silent misconfiguration.
 */
export function createAdapter(): UniversalAgentAdapter {
  const apiKey = process.env.UCAD_PROVIDER_API_KEY ?? process.env.OPENAI_API_KEY ?? '';
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

  return new UniversalAgentAdapter({
    logger: silentLogger('universal'),
    secrets: {
      get: async () => (apiKey ? apiKey : null),
      exists: async () => Boolean(apiKey),
    },
    defaultProviderId: resolvedProvider.id,
    defaultModelId: modelId,
  });
}
