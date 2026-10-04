/**
 * §7.2 reference mock adapter — the executable specification of the
 * `AgentAdapter` contract, in executable form.
 *
 * Two behaviours are contractual, not decorative:
 * - **NFR-13 / I-3** — `injection.rendered` is echoed **verbatim** as the
 *   prefix of the first `text.delta`. The adapter must not rewrite, truncate or
 *   reorder it; `respectsInjectionPlan` asserts exactly this.
 * - **B6** — proposals carry `hostSeq` starting at 1 and increasing
 *   monotonically per session. The adapter never produces `seq`: only Main's
 *   `SessionSequencer` allocates it (SEQ-1).
 */

import { appError } from '@ucad/contracts';
import type {
  AdapterInitializeContext,
  AgentAdapter,
  AgentManifest,
  AgentSessionHandle,
  AgentTurnInput,
  ContextInjectionPlan,
  CreateAgentSessionInput,
  InboundEventProposal,
  ModelDescriptor,
  ModelListContext,
  ResumeAgentSessionInput,
  TurnEventType,
} from '@ucad/contracts';
import { nowIso, ulid } from '@ucad/observability';

export const MOCK_AGENT_VERSION = '0.1.0';
export const MOCK_PROVIDER_ID = 'mock';
/** Default pacing between yielded proposals; keeps a turn well under 200ms. */
export const DEFAULT_LATENCY_MS = 5;

/**
 * Env override for `latencyMs`, read only when the constructor is given no
 * explicit value.
 *
 * This exists because the adapter is normally loaded by `host-entry.ts` in a
 * **forked** child, and that entry calls the exported factory with **no
 * arguments** — there is no constructor channel from a test into a real agent
 * host. `fork()` does inherit `process.env`, so a variable is the one seam
 * that reaches it. Without it, `latencyMs` is only reachable by unit tests
 * that construct the adapter in-process, which is precisely why an
 * out-of-process cancellation test could not ask for a slow enough turn.
 */
export const MOCK_LATENCY_ENV = 'UCAD_MOCK_LATENCY_MS';

function latencyFromEnv(): number | undefined {
  const raw = process.env[MOCK_LATENCY_ENV];
  if (raw === undefined || raw.trim() === '') return undefined;
  const parsed = Number(raw);
  // A malformed value is ignored rather than thrown: the mock must not be the
  // reason an agent host fails to boot.
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return parsed;
}

export interface MockAdapterOptions {
  /** artificial per-step pacing so tests can drive cancellation timing */
  latencyMs?: number;
  /** `'stream'` emits a vendor `error` mid-turn, then ends `failed` */
  failOn?: string;
}

const MOCK_MODELS: ReadonlyArray<ModelDescriptor> = [
  {
    id: 'mock-standard',
    providerId: MOCK_PROVIDER_ID,
    displayName: 'Mock Standard',
    contextWindowTokens: 128_000,
    maxOutputTokens: 8_192,
    pricingHint: { inputPerMTokUsd: 1, outputPerMTokUsd: 3 },
  },
  {
    id: 'mock-fast',
    providerId: MOCK_PROVIDER_ID,
    displayName: 'Mock Fast',
    contextWindowTokens: 32_000,
    maxOutputTokens: 4_096,
    pricingHint: { inputPerMTokUsd: 0.25, outputPerMTokUsd: 0.75 },
  },
];

export class MockAgentAdapter implements AgentAdapter {
  readonly manifest: AgentManifest = {
    id: 'mock',
    displayName: 'Mock Agent',
    /** S-3: `adapterVersion` is compared on resume, so the mock must declare one. */
    version: MOCK_AGENT_VERSION,
    kind: 'mock',
    isDefaultRuntime: false,
    transport: 'child_process',
    providerBinding: 'both',
    pinned: [],
    capabilities: {
      streaming: true,
      sessionResume: true,
      modelSelection: true,
      fileTools: true,
      shellTools: true,
      permissionCallbacks: 'pre_execution',
      nativeSandbox: false,
      mcp: true,
      skills: false,
      subagents: false,
      usageReporting: 'full',
      injectionModes: ['prompt_prefix', 'ucad_tools'],
      toolContract: 'mcp',
      contextWindowTokens: 128_000,
    },
  };

  private readonly latencyMs: number;
  private readonly failOn: string | undefined;
  private readonly sessions = new Map<string, MockSession>();
  private disposed = false;

  constructor(opts: MockAdapterOptions = {}) {
    this.latencyMs = Math.max(0, opts.latencyMs ?? latencyFromEnv() ?? DEFAULT_LATENCY_MS);
    this.failOn = opts.failOn;
  }

  async initialize(_ctx: AdapterInitializeContext, _signal?: AbortSignal): Promise<void> {
    /* the mock has no vendor CLI to boot */
  }

  async listModels(_ctx: ModelListContext, _signal?: AbortSignal): Promise<ModelDescriptor[]> {
    return MOCK_MODELS.map((model) => ({ ...model }));
  }

  async createSession(input: CreateAgentSessionInput, _signal?: AbortSignal): Promise<AgentSessionHandle> {
    // S-3: the native id is a separate ULID namespace from the UCAD session id.
    const session = new MockSession({
      ucadSessionId: input.ucadSessionId,
      nativeSessionId: ulid('native_'),
      adapterId: this.manifest.id,
      providerId: input.providerId,
      modelId: input.modelId,
      latencyMs: this.latencyMs,
      failOn: this.failOn,
    });
    this.sessions.set(session.ucadSessionId, session);
    return session;
  }

  async resumeSession(input: ResumeAgentSessionInput, _signal?: AbortSignal): Promise<AgentSessionHandle> {
    const existing = this.sessions.get(input.ucadSessionId);
    if (!existing || existing.nativeSessionId !== input.nativeSessionId) {
      throw appError('NATIVE_SESSION_LOST', `no native session for ${input.ucadSessionId}`, 'agent');
    }
    if (input.adapterVersion !== MOCK_AGENT_VERSION) {
      // §4.1 S-3: mismatch => reject so Main can degrade and re-create.
      throw appError(
        'NATIVE_SESSION_LOST',
        `adapter version ${input.adapterVersion} != ${MOCK_AGENT_VERSION}`,
        'agent',
      );
    }
    return existing;
  }

  async dispose(): Promise<void> {
    for (const session of this.sessions.values()) await session.dispose();
    this.sessions.clear();
    this.disposed = true;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }
}

export function createMockAdapter(opts?: MockAdapterOptions): MockAgentAdapter {
  return new MockAgentAdapter(opts);
}

// ---------------------------------------------------------------------------
// session
// ---------------------------------------------------------------------------

interface CancelToken {
  promise: Promise<void>;
  wake: () => void;
}

interface MockSessionInit {
  ucadSessionId: string;
  nativeSessionId: string;
  adapterId: string;
  providerId?: string;
  modelId?: string;
  latencyMs: number;
  failOn?: string;
}

type TurnStatus = 'completed' | 'failed' | 'cancelled';

class MockSession implements AgentSessionHandle {
  readonly ucadSessionId: string;
  readonly nativeSessionId: string;

  private readonly adapterId: string;
  private readonly providerId: string | undefined;
  private readonly modelId: string | undefined;
  private readonly latencyMs: number;
  private readonly failOn: string | undefined;

  /** B6: host-local ordering only. Starts at 1, monotonic per session. */
  private hostSeq = 0;
  private cancelled = false;
  private disposed = false;
  private token: CancelToken | null = null;

  constructor(init: MockSessionInit) {
    this.ucadSessionId = init.ucadSessionId;
    this.nativeSessionId = init.nativeSessionId;
    this.adapterId = init.adapterId;
    this.providerId = init.providerId;
    this.modelId = init.modelId;
    this.latencyMs = init.latencyMs;
    this.failOn = init.failOn;
  }

  async *send(input: AgentTurnInput): AsyncGenerator<InboundEventProposal, void> {
    const startedAt = Date.now();
    const messageId = ulid('msg_');
    this.token = newCancelToken();
    this.cancelled = false;

    const status = yield* this.runTurn(input, this.token, startedAt, messageId);

    if (this.disposed) return;
    yield this.propose(input, 'turn.completed', {
      status,
      durationMs: Math.max(0, Date.now() - startedAt),
      messageId,
    });
  }

  async cancel(_reason?: string): Promise<void> {
    this.cancelled = true;
    // Wakes the in-flight pacing immediately: the iterator must finish well
    // inside the 200ms contract window.
    this.token?.wake();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.token?.wake();
  }

  // -------------------------------------------------------------------------

  private async *runTurn(
    input: AgentTurnInput,
    token: CancelToken,
    startedAt: number,
    messageId: string,
  ): AsyncGenerator<InboundEventProposal, TurnStatus> {
    yield this.propose(input, 'turn.started', { objective: input.objective });

    // §7.2: the `ucad.context.list` pair is skipped *only* when the binding is
    // explicitly `none`; the mock is Tool-Contract capable, so an absent
    // binding still exercises the call.
    if (input.toolContract?.kind !== 'none') {
      const toolCallId = ulid('tc_');
      const toolStartedAt = Date.now();
      yield this.propose(input, 'tool.started', {
        toolCallId,
        name: 'ucad.context.list',
        input: { packId: input.injection.packId, revision: input.injection.packRevision },
        origin: 'ucad',
      });
      await this.pace(token);
      if (this.cancelled) return 'cancelled';
      yield this.propose(input, 'tool.completed', {
        toolCallId,
        status: 'ok',
        outputPreview: `${input.injection.index.length} index entries`,
        durationMs: Math.max(0, Date.now() - toolStartedAt),
      });
    }

    if (this.failOn === 'stream') {
      await this.pace(token);
      if (this.cancelled) return 'cancelled';
      yield this.propose(
        input,
        'error',
        appError('NETWORK_ERROR', 'mock vendor stream failure', 'agent', { vendor: { name: 'mock' } }),
      );
      return 'failed';
    }

    // NFR-13 / I-3: the injection is echoed byte-for-byte as the prefix of the
    // first delta. The remaining deltas stream the mock's own body.
    const chunks = renderBodyChunks(input.injection);
    for (let i = 0; i < chunks.length; i += 1) {
      const chunk = chunks[i];
      if (chunk === undefined) continue;
      await this.pace(token);
      if (this.cancelled) return 'cancelled';
      const text = i === 0 ? input.injection.rendered + chunk : chunk;
      yield this.propose(input, 'text.delta', { text, messageId });
    }

    const readCallId = ulid('tc_');
    const readStartedAt = Date.now();
    yield this.propose(input, 'tool.started', {
      toolCallId: readCallId,
      name: 'read_file',
      input: { path: targetPath(input) },
      origin: 'vendor',
    });
    await this.pace(token);
    if (this.cancelled) return 'cancelled';
    yield this.propose(input, 'tool.completed', {
      toolCallId: readCallId,
      status: 'ok',
      outputPreview: `${targetPath(input)} (mock)`,
      durationMs: Math.max(0, Date.now() - readStartedAt),
    });

    // `read_only` must never report a mutation (§4.9 baseline).
    if (input.objective.toLowerCase().includes('write') && input.permissionMode !== 'read_only') {
      yield this.propose(input, 'file.changed', {
        path: targetPath(input),
        operation: 'modify',
        detectedBy: 'vendor_event',
      });
    }

    yield this.propose(input, 'usage', {
      record: {
        sessionId: this.ucadSessionId,
        turnId: input.turnId,
        agentId: this.adapterId,
        ...(this.providerId ? { providerId: this.providerId } : {}),
        ...(this.modelId ? { modelId: this.modelId } : {}),
        // Derived from the injection length, and explicitly marked `computed`
        // so the UI learns to label it as an estimate (§4.12.2).
        inputTokens: Math.ceil(input.injection.rendered.length / 4),
        outputTokens: Math.ceil(bodyLength(chunks) / 4),
        durationMs: Math.max(0, Date.now() - startedAt),
        source: 'computed',
      },
    });

    await this.pace(token);
    if (this.cancelled) return 'cancelled';
    return 'completed';
  }

  /**
   * Builds a proposal. Deliberately emits `hostSeq` and nothing else — no `seq`
   * (B6, rule E-1).
   */
  private propose(input: AgentTurnInput, type: TurnEventType, payload: unknown): InboundEventProposal {
    this.hostSeq += 1;
    return {
      hostSeq: this.hostSeq,
      turnId: input.turnId,
      type,
      source: {
        kind: 'agent',
        agentId: this.adapterId,
        ...(this.providerId ? { providerId: this.providerId } : {}),
        nativeType: 'mock',
      },
      payload,
      ts: nowIso(),
    };
  }

  /** Waits `latencyMs`, or returns immediately once the turn is cancelled. */
  private async pace(token: CancelToken): Promise<void> {
    if (this.cancelled || this.disposed) return;
    if (this.latencyMs <= 0) return;
    await Promise.race([sleep(this.latencyMs), token.promise]);
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Character length of the streamed body, i.e. everything after the injection. */
function bodyLength(chunks: readonly string[]): number {
  return chunks.join('').length;
}

function newCancelToken(): CancelToken {
  let wake: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    wake = resolve;
  });
  return { promise, wake: () => wake?.() };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

/**
 * One chunk per `<index>` entry, so the delta count itself proves the injection
 * was consumed. Concatenating the chunks reproduces the body exactly.
 */
function renderBodyChunks(injection: ContextInjectionPlan): string[] {
  const lines: string[] = [
    `<agent-mock pack="${injection.packId}" revision="${injection.packRevision}">`,
    `objective-context: ${injection.estTokens} estimated tokens via ${injection.estimateSource}`,
  ];
  const entries = injection.index;
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (!entry) continue;
    lines.push(
      `<index n="${i + 1}" id="${entry.itemId}" kind="${entry.kind}" stale="${entry.stale}" tokens="${entry.tokens}"/>`,
    );
  }
  if (injection.omitted.length > 0) {
    lines.push(`<omitted count="${injection.omitted.length}"/>`);
  }
  lines.push('</agent-mock>');

  const body = lines.join('\n');
  const n = Math.max(1, entries.length);
  const size = Math.max(1, Math.ceil(body.length / n));
  const chunks: string[] = [];
  for (let i = 0; i < body.length; i += size) chunks.push(body.slice(i, i + size));
  return chunks.length > 0 ? chunks : [''];
}

function targetPath(input: AgentTurnInput): string {
  const match = /\S+\.\w+/.exec(input.objective);
  return match ? match[0] : 'src/index.ts';
}
