/**
 * §6.1 Host-side runner.
 *
 * `AgentHostRunner` is the process-local half of the Agent Host. It consumes
 * `MainToAgentHost` frames, drives a real `AgentAdapter`, and emits
 * `AgentHostToMain` frames back over the fork IPC channel.
 *
 * Two invariants matter most:
 * - **B6 / SEQ-1** — every `InboundEventProposal` is forwarded *exactly as the
 *   adapter produced it*. No `seq` is added, nothing is renumbered, nothing is
 *   wrapped. Main's `SessionSequencer` is the only `seq` allocator.
 * - **§4.1.2** — the adapter's injected `onPermissionRequest` is turned into a
 *   `permission_request` frame to Main and blocks until `permission_response`.
 */

import { toAppError, appError } from '@ucad/contracts';
import type {
  AdapterInitializeContext,
  AgentAdapter,
  AgentHostToMain,
  AgentSessionHandle,
  AgentTurnInput,
  CreateAgentSessionInput,
  InboundEventProposal,
  MainToAgentHost,
  PermissionDecision,
  PermissionRequest,
  ResumeAgentSessionInput,
  Unsubscribe,
} from '@ucad/contracts';
import { nowIso, ulid } from '@ucad/observability';
import type { Logger } from '@ucad/observability';

import { frame, isMainFrame } from './frame';
import type { HostInitializePayload } from './agent-host-process';

/** Default `health` cadence (§7.1: 5 seconds). */
export const DEFAULT_HEARTBEAT_MS = 5_000;
/**
 * A permission prompt that is never answered must not leak a promise for the
 * lifetime of the process. Denying is the fail-safe answer.
 */
export const DEFAULT_PERMISSION_TIMEOUT_MS = 120_000;

/** The channel the runner speaks on. `processTransport()` binds it to the fork IPC. */
export interface HostTransport {
  send(msg: AgentHostToMain): void;
  onMessage(cb: (msg: MainToAgentHost) => void): Unsubscribe;
}

export interface AgentHostRunnerOptions {
  adapter: AgentAdapter;
  agentHostId: string;
  logger: Logger;
  transport?: HostTransport;
  heartbeatMs?: number;
  permissionTimeoutMs?: number;
  /**
   * `AdapterInitializeContext.secretResolver` is a function and therefore cannot
   * survive the IPC boundary; Main can never supply it. The Host injects its own
   * and rejects every lookup by default — the mock needs none.
   */
  secretResolver?: AdapterInitializeContext['secretResolver'];
  /** defaults to `process.exit`; overridable so the runner stays testable. */
  exit?: (code: number) => void;
}

interface PendingPermission {
  resolve: (decision: PermissionDecision) => void;
  timer: NodeJS.Timeout;
}

/** `process.send` / `process.on('message')` bound to the fork IPC channel. */
export function processTransport(): HostTransport {
  return {
    send(msg: AgentHostToMain): void {
      // `process.send` is optional on the Process interface; on a forked child
      // the IPC channel is always present.
      if (!process.connected) return;
      process.send?.(frame(msg));
    },
    onMessage(cb: (msg: MainToAgentHost) => void): Unsubscribe {
      const listener = (raw: unknown): void => {
        if (!isMainFrame(raw)) return;
        cb(raw);
      };
      process.on('message', listener);
      return () => {
        process.off('message', listener);
      };
    },
  };
}

export class AgentHostRunner {
  readonly agentHostId: string;

  private readonly adapter: AgentAdapter;
  private readonly logger: Logger;
  private readonly transport: HostTransport;
  private readonly heartbeatMs: number;
  private readonly permissionTimeoutMs: number;
  private readonly secretResolver: AdapterInitializeContext['secretResolver'];
  private readonly exitFn: (code: number) => void;

  private readonly sessions = new Map<string, AgentSessionHandle>();
  /** turnId -> ucadSessionId, so `cancel_turn` can find the owning handle. */
  private readonly turnOwners = new Map<string, string>();
  private readonly pendingPermissions = new Map<string, PendingPermission>();

  private started = false;
  private initialized = false;
  private disposed = false;
  private activeTurnId: string | undefined;
  private lastSessionId: string | undefined;
  private heartbeat: NodeJS.Timeout | undefined;
  private unsubscribe: Unsubscribe | undefined;
  /**
   * Serializes frame handling so `create_session` is guaranteed to complete
   * before the `send_turn` that follows it. Turn *streaming* is not part of
   * this chain, so `cancel_turn` still gets through while a turn is running.
   */
  private queue: Promise<void> = Promise.resolve();

  constructor(opts: AgentHostRunnerOptions) {
    this.adapter = opts.adapter;
    this.agentHostId = opts.agentHostId;
    this.logger = opts.logger.child('agent-host-runner');
    this.transport = opts.transport ?? processTransport();
    this.heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.permissionTimeoutMs = opts.permissionTimeoutMs ?? DEFAULT_PERMISSION_TIMEOUT_MS;
    this.secretResolver = opts.secretResolver ?? (async () => null);
    this.exitFn = opts.exit ?? ((code: number) => process.exit(code));
  }

  /** Attach to the transport and start the heartbeat. Idempotent. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.unsubscribe = this.transport.onMessage((msg) => {
      // Never let a rejected dispatch become an unhandled rejection (NFR-02).
      this.queue = this.queue.then(() => this.dispatch(msg)).catch(() => undefined);
    });
    this.heartbeat = setInterval(() => this.emitHealth(), this.heartbeatMs);
    this.heartbeat.unref();
  }

  /** Release the transport, the heartbeat and the adapter. Idempotent. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    this.unsubscribe?.();
    this.unsubscribe = undefined;

    // Never leave a permission prompt hanging on a dying process.
    for (const [requestId, pending] of [...this.pendingPermissions]) {
      this.pendingPermissions.delete(requestId);
      clearTimeout(pending.timer);
      pending.resolve('deny');
    }
    for (const handle of [...this.sessions.values()]) {
      try {
        await handle.dispose();
      } catch (err) {
        this.reportAdapterError(err);
      }
    }
    this.sessions.clear();
    this.turnOwners.clear();
    try {
      await this.adapter.dispose();
    } catch (err) {
      this.reportAdapterError(err);
    }
  }

  // -------------------------------------------------------------------------
  // dispatch
  // -------------------------------------------------------------------------

  private async dispatch(msg: MainToAgentHost): Promise<void> {
    const op: string = msg.op;
    try {
      switch (msg.op) {
        case 'initialize':
          await this.onInitialize(msg.payload);
          return;
        case 'create_session':
          await this.onCreateSession(msg.payload);
          return;
        case 'resume_session':
          await this.onResumeSession(msg.payload);
          return;
        case 'send_turn':
          await this.onSendTurn(msg.payload);
          return;
        case 'cancel_turn':
          await this.onCancelTurn(msg.payload);
          return;
        case 'permission_response':
          this.onPermissionResponse(msg.payload);
          return;
        case 'dispose_session':
          await this.onDisposeSession(msg.payload);
          return;
        case 'shutdown':
          await this.onShutdown(msg.payload);
          return;
      }
    } catch (err) {
      // Any adapter throw surfaces as `adapter_error`; the host never dies silently.
      this.reportAdapterError(err);
      return;
    }
    // The switch is exhaustive, so control only reaches here for an op this
    // build does not know.
    this.logger.warn('unknown host op', { op });
  }

  private async onInitialize(payload: HostInitializePayload): Promise<void> {
    // `logger`, `secretResolver` and `onPermissionRequest` are functions and do
    // not survive JSON serialization, so the Host re-injects all three.
    await this.adapter.initialize({
      agentHostId: this.agentHostId,
      workspaceRoot: payload.workspaceRoot,
      configDir: payload.configDir,
      env: payload.env ?? {},
      secretResolver: this.secretResolver,
      logger: this.logger,
      onPermissionRequest: (request) => this.requestPermission(request),
    });
    this.initialized = true;
    this.emit({ op: 'ready', payload: { agentHostId: this.agentHostId, manifest: this.adapter.manifest } });
  }

  private async onCreateSession(payload: CreateAgentSessionInput): Promise<void> {
    const handle = await this.adapter.createSession(payload);
    this.sessions.set(handle.ucadSessionId, handle);
    this.lastSessionId = handle.ucadSessionId;
    // §4.3 S-3: Main owns the ucad -> native mapping. Without this frame the
    // native id would exist only in the Host's log, leaving
    // `agent_sessions.native_session_id` (§8.1) unpersistable and resume
    // (§4.1.3 `ResumeAgentSessionInput`) impossible.
    this.emit({
      op: 'session_created',
      payload: {
        ucadSessionId: handle.ucadSessionId,
        ...(handle.nativeSessionId ? { nativeSessionId: handle.nativeSessionId } : {}),
        adapterVersion: this.adapter.manifest.version,
        resumed: false,
      },
    });
    this.logger.info('session created', {
      ucadSessionId: handle.ucadSessionId,
      nativeSessionId: handle.nativeSessionId,
      agentId: this.adapter.manifest.id,
    });
  }

  private async onResumeSession(payload: ResumeAgentSessionInput): Promise<void> {
    const handle = await this.adapter.resumeSession(payload);
    this.sessions.set(handle.ucadSessionId, handle);
    this.lastSessionId = handle.ucadSessionId;
    this.emit({
      op: 'session_created',
      payload: {
        ucadSessionId: handle.ucadSessionId,
        ...(handle.nativeSessionId ? { nativeSessionId: handle.nativeSessionId } : {}),
        adapterVersion: this.adapter.manifest.version,
        resumed: true,
      },
    });
  }

  private async onSendTurn(input: AgentTurnInput): Promise<void> {
    if (!this.initialized) {
      this.reportAdapterError(appError('AGENT_START_FAILED', 'send_turn before initialize', 'agent'));
      return;
    }
    const handle = this.resolveSession(input);
    if (!handle) {
      this.reportAdapterError(
        appError('AGENT_START_FAILED', `no agent session for turn ${input.turnId}`, 'agent'),
      );
      return;
    }

    this.turnOwners.set(input.turnId, handle.ucadSessionId);
    this.activeTurnId = input.turnId;

    // The proposal stream is consumed in the background: `send_turn` must not
    // block the message loop, otherwise a cancel could never be delivered.
    void this.pumpTurn(input.turnId, handle.send(input));
  }

  private async onCancelTurn(payload: { turnId: string; reason?: string }): Promise<void> {
    const sessionId = this.turnOwners.get(payload.turnId);
    const handle = sessionId ? this.sessions.get(sessionId) : undefined;
    if (handle) {
      try {
        await handle.cancel(payload.reason);
      } catch (err) {
        this.reportAdapterError(err);
      }
    } else {
      this.logger.warn('cancel for unknown turn', { turnId: payload.turnId });
    }
    // §7.1: the ack for `cancel_turn` is a `health` frame.
    this.emitHealth(payload.turnId);
  }

  private onPermissionResponse(payload: { requestId: string; decision: PermissionDecision }): void {
    const pending = this.pendingPermissions.get(payload.requestId);
    if (!pending) {
      this.logger.warn('permission response for unknown request', { requestId: payload.requestId });
      return;
    }
    this.pendingPermissions.delete(payload.requestId);
    clearTimeout(pending.timer);
    pending.resolve(payload.decision);
  }

  private async onDisposeSession(payload: { ucadSessionId: string }): Promise<void> {
    const handle = this.sessions.get(payload.ucadSessionId);
    if (!handle) return;
    this.sessions.delete(payload.ucadSessionId);
    if (this.lastSessionId === payload.ucadSessionId) this.lastSessionId = undefined;
    try {
      await handle.dispose();
    } catch (err) {
      this.reportAdapterError(err);
    }
  }

  private async onShutdown(payload: { gracePeriodMs: number }): Promise<void> {
    const graceMs = Number.isFinite(payload.gracePeriodMs) && payload.gracePeriodMs > 0 ? payload.gracePeriodMs : 2_000;
    await Promise.race([
      this.dispose(),
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, graceMs);
        timer.unref();
      }),
    ]);
    this.exitFn(0);
  }

  // -------------------------------------------------------------------------
  // turn pump
  // -------------------------------------------------------------------------

  private async pumpTurn(turnId: string, stream: AsyncIterable<InboundEventProposal>): Promise<void> {
    try {
      for await (const proposal of stream) {
        if (this.disposed) break;
        // B6: forwarded byte-for-byte. No `seq`, no renumbering, no wrapping.
        this.emit({ op: 'event', payload: proposal });
      }
    } catch (err) {
      this.reportAdapterError(err);
    } finally {
      if (this.activeTurnId === turnId) this.activeTurnId = undefined;
      this.turnOwners.delete(turnId);
    }
  }

  /**
   * `AgentTurnInput` carries no `ucadSessionId`, so an explicit
   * `ucadSessionId` on the wire wins; otherwise V1's single-active-turn rule
   * (§4.3 S-1) means the one (or most recently created) session is the owner.
   */
  private resolveSession(input: AgentTurnInput): AgentSessionHandle | undefined {
    const explicit = (input as { ucadSessionId?: unknown }).ucadSessionId;
    if (typeof explicit === 'string') return this.sessions.get(explicit);
    if (this.sessions.size === 1) return this.sessions.values().next().value;
    if (this.lastSessionId) return this.sessions.get(this.lastSessionId);
    return undefined;
  }

  // -------------------------------------------------------------------------
  // permission interception
  // -------------------------------------------------------------------------

  private async requestPermission(request: unknown): Promise<PermissionDecision> {
    const normalized = normalizePermissionRequest(request, {
      agentHostId: this.agentHostId,
      turnId: this.activeTurnId,
      sessionId: this.activeTurnId ? this.turnOwners.get(this.activeTurnId) : undefined,
    });

    return new Promise<PermissionDecision>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingPermissions.delete(normalized.id);
        this.reportAdapterError(
          appError('PERMISSION_DENIED', `permission request ${normalized.id} timed out`, 'agent'),
        );
        resolve('deny');
      }, this.permissionTimeoutMs);
      timer.unref();

      this.pendingPermissions.set(normalized.id, { resolve, timer });
      this.emit({ op: 'permission_request', payload: normalized });
    });
  }

  // -------------------------------------------------------------------------
  // emit helpers
  // -------------------------------------------------------------------------

  private emit(msg: AgentHostToMain): void {
    try {
      this.transport.send(msg);
    } catch (err) {
      this.logger.error('failed to send host frame', {
        op: msg.op,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private emitHealth(activeTurnId?: string): void {
    const turnId = activeTurnId ?? this.activeTurnId;
    this.emit({
      op: 'health',
      payload: {
        at: nowIso(),
        ...(turnId ? { activeTurnId: turnId } : {}),
        rssBytes: process.memoryUsage().rss,
      },
    });
  }

  private reportAdapterError(err: unknown): void {
    const appErr = toAppError(err, 'agent');
    this.logger.error('adapter error', { code: appErr.code, message: appErr.message });
    this.emit({ op: 'adapter_error', payload: appErr });
  }
}

/**
 * Adapters hand the injected `onPermissionRequest` an `unknown`; fill the
 * context fields the Host owns and default the risk-sensitive parts, so the
 * frame always satisfies the `PermissionRequest` shape Main Zod-validates.
 */
export function normalizePermissionRequest(
  request: unknown,
  fallback: { agentHostId: string; turnId?: string; sessionId?: string },
): PermissionRequest {
  const raw = (request && typeof request === 'object' ? request : {}) as Partial<PermissionRequest>;
  const id = typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : ulid('pm_');
  return {
    id,
    sessionId: raw.sessionId ?? fallback.sessionId ?? fallback.agentHostId,
    turnId: raw.turnId ?? fallback.turnId ?? fallback.agentHostId,
    agentId: raw.agentId ?? fallback.agentHostId,
    category: raw.category ?? 'EXTERNAL_TOOL',
    risk: raw.risk ?? 'medium',
    ...(raw.resource !== undefined ? { resource: raw.resource } : {}),
    ...(raw.command !== undefined ? { command: raw.command } : {}),
    ...(raw.mcpServerId !== undefined ? { mcpServerId: raw.mcpServerId } : {}),
    ...(raw.mcpToolName !== undefined ? { mcpToolName: raw.mcpToolName } : {}),
    ...(raw.reason !== undefined ? { reason: raw.reason } : {}),
    ...(raw.decisionEngineSignal !== undefined
      ? { decisionEngineSignal: raw.decisionEngineSignal }
      : {}),
  };
}
