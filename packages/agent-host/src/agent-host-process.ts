/**
 * §6.1 Main-side Agent Host process.
 *
 * `AgentHostProcess` owns one forked child per Agent. This class is the
 * isolation boundary required by **NFR-02**: a crashing or hanging Agent is
 * reported through `onExit` / `onMessage` and can never throw an unhandled
 * exception into Main, and a `cancelTurn` that is not acknowledged inside the
 * grace window escalates to a process kill (**NFR-05 boundary 1**).
 */

import { fork } from 'node:child_process';
import * as path from 'node:path';
import type { ChildProcess } from 'node:child_process';

import { appError } from '@ucad/contracts';
import type {
  AdapterInitializeContext,
  AgentHostToMain,
  AgentManifest,
  AppError,
  MainToAgentHost,
  Unsubscribe,
} from '@ucad/contracts';
import { nowIso } from '@ucad/observability';
import type { Logger } from '@ucad/observability';

import { frame, parseHostFrame } from './frame';

/** §7.1: `handshakeTimeoutMs` default 10000. */
export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
/** NFR-05 boundary 1: a cancel that is not acked within 2s escalates to kill. */
export const DEFAULT_CANCEL_GRACE_MS = 2_000;
/** Graceful `shutdown` window before `SIGKILL`. */
export const DEFAULT_DISPOSE_GRACE_MS = 2_000;

export interface AgentHostOptions {
  /** absolute path to the adapter's `dist` entry */
  adapterModule: string;
  agentHostId: string;
  logger: Logger;
  /** workspaceRoot — the child's cwd */
  cwd: string;
  /** `.ucad/` absolute path */
  configDir: string;
  handshakeTimeoutMs?: number;
  /**
   * Script executed by `fork()`. Defaults to {@link resolveHostEntry}, the
   * compiled bootstrap shipped next to this package's `dist/`.
   */
  hostEntry?: string;
  /** extra environment entries; the redacted allow-list is supplied by Main. */
  env?: Record<string, string | undefined>;
}

/**
 * Wire form of `AdapterInitializeContext`. The three function-valued fields
 * (`logger`, `secretResolver`, `onPermissionRequest`) cannot be serialized
 * across the IPC channel, so Main sends only the data fields and the Host
 * re-injects the rest.
 */
export type HostInitializePayload = Pick<
  AdapterInitializeContext,
  'agentHostId' | 'workspaceRoot' | 'configDir' | 'env'
>;

/** Absolute path of the compiled `host-entry.js` sitting next to `dist/`. */
export function resolveHostEntry(): string {
  return path.join(__dirname, 'host-entry.js');
}

/** Only `string` entries travel over JSON; `undefined` is dropped. */
function redactEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

export interface AgentHostExitInfo {
  code: number | null;
  signal?: string;
}

export class AgentHostProcess {
  readonly agentHostId: string;

  private readonly adapterModule: string;
  private readonly logger: Logger;
  private readonly cwd: string;
  private readonly configDir: string;
  private readonly handshakeTimeoutMs: number;
  private readonly hostEntry: string;
  private readonly extraEnv: Record<string, string | undefined>;

  private child: ChildProcess | null = null;
  private manifestValue: AgentManifest | null = null;
  private exitInfo: AgentHostExitInfo | null = null;
  private lastRssBytes: number | undefined;

  private readonly messageCbs = new Set<(msg: AgentHostToMain) => void>();
  private readonly exitCbs = new Set<(info: AgentHostExitInfo) => void>();

  private settleReady: ((manifest: AgentManifest) => void) | null = null;
  /** Rejects the handshake with an `AppError`, never a raw `Error`. */
  private failReady: ((error: AppError) => void) | null = null;
  private disposePromise: Promise<void> | null = null;

  constructor(opts: AgentHostOptions) {
    this.adapterModule = opts.adapterModule;
    this.agentHostId = opts.agentHostId;
    this.logger = opts.logger.child('agent-host');
    this.cwd = opts.cwd;
    this.configDir = opts.configDir;
    this.handshakeTimeoutMs = opts.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    this.hostEntry = opts.hostEntry ?? resolveHostEntry();
    this.extraEnv = opts.env ?? {};
  }

  /**
   * Resolved by `start()`. Throws before the handshake completes — read
   * `start()`'s return value (or await it) instead of polling this.
   */
  get manifest(): AgentManifest {
    if (!this.manifestValue) {
      throw new Error('AgentHostProcess.manifest is only available after start() resolves');
    }
    return this.manifestValue;
  }

  get alive(): boolean {
    return this.child !== null && this.exitInfo === null && this.child.connected;
  }

  /** Last `rssBytes` reported by the Host's periodic `health` frame. */
  get rssBytes(): number | undefined {
    return this.lastRssBytes;
  }

  /**
   * §6.1 handshake: fork the host, drive `initialize`, and resolve with the
   * manifest carried by the Host's `ready` frame. On timeout the child is
   * killed and the promise rejects with `AGENT_START_FAILED` (NFR-02 — the
   * failure never escapes into Main).
   *
   * The `initialize` context is assembled from this process's own options,
   * because the three function-valued fields of `AdapterInitializeContext`
   * (`logger`, `secretResolver`, `onPermissionRequest`) cannot cross the IPC
   * boundary and are re-injected by the Host.
   */
  start(): Promise<AgentManifest> {
    if (this.child) {
      return Promise.reject(
        appError('AGENT_START_FAILED', `agent host ${this.agentHostId} already started`, 'ipc'),
      );
    }

    const child = fork(
      this.hostEntry,
      [`--adapter=${this.adapterModule}`, `--host-id=${this.agentHostId}`],
      {
        cwd: this.cwd,
        env: {
          ...process.env,
          ...this.extraEnv,
          UCAD_AGENT_HOST_ID: this.agentHostId,
          UCAD_CONFIG_DIR: this.configDir,
          // When Main runs inside Electron, `process.execPath` is `electron.exe`,
          // so a plain `fork()` would start a *second Electron application*
          // instead of a Node process: no `process.on('message')`, no ready
          // frame, and a stray window. `ELECTRON_RUN_AS_NODE` is the documented
          // way to make that binary behave as Node. Setting it unconditionally
          // is harmless under plain Node, where the variable is ignored.
          ELECTRON_RUN_AS_NODE: '1',
          // Electron's child processes otherwise inherit GPU/notification
          // plumbing they have no use for, which slows startup and can keep
          // the process alive after `shutdown`.
          ELECTRON_NO_ATTACH_CONSOLE: '1',
        },
        // stdout/stderr are drained, never parsed — the protocol rides the IPC
        // channel. The IPC channel itself is element 3 of `stdio`.
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        serialization: 'json',
      },
    );
    this.child = child;

    // Drain both pipes so the child can never block on a full buffer, and keep
    // the diagnostics in the log.
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => this.logger.debug('host stdout', { chunk }));
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => this.logger.warn('host stderr', { chunk }));

    child.on('message', (raw: unknown) => this.handleRaw(raw));
    // NFR-02: an 'error' may be followed by no 'exit' at all, so both paths
    // funnel through notifyExit, which is idempotent.
    child.on('error', (err: Error) => {
      this.logger.error('agent host process error', { error: err.message });
      this.notifyExit({ code: null });
    });
    child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      this.notifyExit({ code, ...(signal ? { signal } : {}) });
    });

    const handshake = new Promise<AgentManifest>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.failReady?.(
          appError('AGENT_START_FAILED', `agent host ${this.agentHostId} handshake timed out`, 'ipc', {
            details: { timeoutMs: this.handshakeTimeoutMs },
          }),
        );
        this.killNow();
      }, this.handshakeTimeoutMs);
      timer.unref();

      this.settleReady = (manifest) => {
        clearTimeout(timer);
        this.settleReady = null;
        this.failReady = null;
        resolve(manifest);
      };
      this.failReady = (error) => {
        clearTimeout(timer);
        this.settleReady = null;
        this.failReady = null;
        reject(error);
      };
    });

    // §7.1: `ready` is the Host's *reply* to `initialize`, so the handshake has
    // to drive `initialize` itself. Sent once the resolvers are wired, so the
    // reply can never race the listener.
    this.send({
      op: 'initialize',
      payload: {
        agentHostId: this.agentHostId,
        workspaceRoot: this.cwd,
        configDir: this.configDir,
        env: redactEnv(this.extraEnv),
      },
    } as MainToAgentHost);

    return handshake;
  }

  /** Fire-and-forget. Never throws: a dead or wedged child is logged, not raised. */
  send(msg: MainToAgentHost): void {
    const child = this.child;
    if (!child || !child.connected) {
      this.logger.warn('dropping frame: host not connected', { op: msg.op });
      return;
    }
    try {
      child.send(frame(msg));
    } catch (err) {
      this.logger.error('failed to send frame', {
        op: msg.op,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  onMessage(cb: (msg: AgentHostToMain) => void): Unsubscribe {
    this.messageCbs.add(cb);
    return () => {
      this.messageCbs.delete(cb);
    };
  }

  onExit(cb: (info: AgentHostExitInfo) => void): Unsubscribe {
    this.exitCbs.add(cb);
    return () => {
      this.exitCbs.delete(cb);
    };
  }

  /**
   * NFR-05 boundary 1. Sends `cancel_turn` and waits `graceMs` for the Host's
   * ack (the runner answers every `cancel_turn` with a `health` frame). On
   * timeout the Host is escalated: graceful `dispose()` then `kill()`.
   */
  async cancelTurn(turnId: string, reason?: string, graceMs = DEFAULT_CANCEL_GRACE_MS): Promise<'acked' | 'killed'> {
    if (!this.alive) return 'killed';

    const acked = await new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.messageCbs.delete(ackListener);
        resolve(ok);
      };
      const timer = setTimeout(() => finish(false), graceMs);
      timer.unref();
      // Registered before `send` so the ack cannot be missed. The Host's
      // heartbeat is 5s, far beyond the 2s default grace, so the next `health`
      // frame inside the window is the ack and not a heartbeat.
      const ackListener = (msg: AgentHostToMain): void => {
        if (msg.op === 'health') finish(true);
      };
      this.messageCbs.add(ackListener);
      this.send({ op: 'cancel_turn', payload: { turnId, ...(reason !== undefined ? { reason } : {}) } });
    });

    if (acked) return 'acked';

    this.logger.warn('cancel escalation: host did not ack, killing', { turnId, graceMs });
    await this.dispose(graceMs);
    return 'killed';
  }

  /** Graceful `shutdown`, then `SIGKILL` if the child outlives `graceMs`. Idempotent. */
  dispose(graceMs = DEFAULT_DISPOSE_GRACE_MS): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposePromise = this.runDispose(graceMs);
    return this.disposePromise;
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  private async runDispose(graceMs: number): Promise<void> {
    const child = this.child;
    if (!child || this.exitInfo) {
      this.cleanup();
      return;
    }

    const exited = new Promise<void>((resolve) => {
      const onExit = (): void => resolve();
      this.exitCbs.add(onExit);
    });

    this.send({ op: 'shutdown', payload: { gracePeriodMs: graceMs } });

    const timer = setTimeout(() => this.killNow(), graceMs);
    timer.unref();
    await exited;
    clearTimeout(timer);
    this.cleanup();
  }

  private killNow(): void {
    const child = this.child;
    if (!child) return;
    try {
      child.kill('SIGKILL');
    } catch (err) {
      this.logger.error('kill failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private handleRaw(raw: unknown): void {
    const msg = parseHostFrame(raw);
    if (!msg) {
      this.logger.warn('ignoring frame with mismatched or malformed protocolVersion', {
        protocolVersion:
          raw && typeof raw === 'object'
            ? (raw as { protocolVersion?: unknown }).protocolVersion
            : undefined,
      });
      return;
    }
    if (msg.op === 'ready') {
      this.manifestValue = msg.payload.manifest;
      this.settleReady?.(msg.payload.manifest);
    }
    if (msg.op === 'health' && typeof msg.payload.rssBytes === 'number') {
      this.lastRssBytes = msg.payload.rssBytes;
    }
    for (const cb of [...this.messageCbs]) {
      try {
        cb(msg);
      } catch (err) {
        this.logger.error('onMessage callback threw', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  private notifyExit(info: AgentHostExitInfo): void {
    if (this.exitInfo) return;
    this.exitInfo = info;
    this.failReady?.(
      appError('AGENT_START_FAILED', `agent host ${this.agentHostId} exited before ready`, 'ipc', {
        details: { ...info, at: nowIso() },
      }),
    );
    this.logger.warn('agent host exited', { ...info, at: nowIso() });
    for (const cb of [...this.exitCbs]) {
      try {
        cb(info);
      } catch {
        /* a broken listener must not keep the process from being reaped */
      }
    }
  }

  private cleanup(): void {
    const child = this.child;
    this.child = null;
    this.messageCbs.clear();
    this.exitCbs.clear();
    if (!child) return;
    child.removeAllListeners();
    try {
      if (child.connected) child.disconnect();
    } catch {
      /* already gone */
    }
  }
}
