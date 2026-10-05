/**
 * §9 CommandRunner — the single place UCAD executes a command on the user's
 * machine.
 *
 * Security posture:
 *  - a `permissionDecision` that is not an `allow_*` throws BEFORE `spawn`, so
 *    `deny` cannot execute anything (not even an argv probe)
 *  - `shell: false` with an argv array (§11.1): no command string, no shell
 *    metacharacter ever becomes syntax
 *  - the process TREE is killed on abort / kill, so no grandchild outlives the
 *    run (NFR-05)
 *
 * This class is NOT the user terminal. §11.2's interactive PTY lives in
 * `pty-host.ts` (`PtyHost`) and is a separate, additive surface with its own
 * IPC channels; it is deliberately not permission-gated, because the user
 * typing into their own terminal is not the agent acting on their behalf
 * (NFR-02 gates the agent, not the human).
 *
 * What still degrades: this console remains a PIPED stdio shell, so it has no
 * echo, no cursor addressing, no full-screen programs, and no per-command exit
 * code. It is kept as the surface that works when the optional `node-pty`
 * native module is unavailable, which is why the panel still offers it.
 */

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import { ulid } from '@ucad/observability';
import type { Logger } from '@ucad/observability';
import { containCwdToRoot } from './contain-cwd';
import type {
  CommandCompletedPayload,
  CommandOutputPayload,
  CommandStartedPayload,
  PermissionDecision,
} from '@ucad/contracts';
import type { PermissionEngine } from '@ucad/permissions';
import { AppErrorThrow, errnoOf, fail } from './errors';
import { killProcessTree } from './process-tree';

/** NFR-06: one event payload never exceeds this; larger output is cut. */
const MAX_CHUNK_BYTES = 64 * 1024;

/**
 * Per stream, per command. A pipe read is already at most 64 KiB, so a per-chunk
 * cut almost never happens on Windows; this budget is what actually makes
 * `truncated` reachable and stops a chatty process from flooding the event log
 * (NFR-06 keeps the rest out of the payload via the blob store).
 */
const MAX_STREAM_OUTPUT_BYTES = 4 * 1024 * 1024;

/** Reported in `command.started`; `shell: false` means there is no shell. */
const EXECUTION_MODE = 'direct';

export interface CommandOutputChunk {
  commandId: string;
  stream: 'stdout' | 'stderr';
  chunk: string;
  truncated: boolean;
}

/**
 * What the injected sink receives. Deliberately NOT a `TurnEvent`: Main's
 * `SessionSequencer` is the only allocator of `eventId` and `seq` (§5.2, E-1),
 * so this package must not invent them.
 */
export interface CommandEventProposal {
  sessionId: string;
  turnId: string;
  type: 'command.started' | 'command.output' | 'command.completed';
  payload: CommandStartedPayload | CommandOutputPayload | CommandCompletedPayload;
  ts: string;
}

export type CommandEventSink = (event: CommandEventProposal) => void;

/** §7.2 `IPC_PUSH.terminalData` shape for the non-interactive console. */
export interface ConsoleDataEvent {
  terminalId: string;
  stream: 'stdout' | 'stderr';
  chunk: string;
}

export interface CommandRunnerOptions {
  logger: Logger;
  permissions: PermissionEngine;
  /** Where `command.started` / `command.output` / `command.completed` go. */
  onEvent?: CommandEventSink;
  /** Where console output goes (the console is not tied to a turn). */
  onConsoleData?: (event: ConsoleDataEvent) => void;
  /** Console shell override; defaults to ComSpec on Windows, $SHELL elsewhere. */
  shell?: string;
}

export interface CommandRunInput {
  sessionId: string;
  turnId: string;
  workspaceRoot: string;
  command: string;
  args: string[];
  permissionDecision: PermissionDecision;
  signal?: AbortSignal;
}

export interface CreateConsoleInput {
  sessionId: string;
  workspaceRoot: string;
  cwd: string;
  cols: number;
  rows: number;
}

interface RunningConsole {
  terminalId: string;
  sessionId: string;
  child: ChildProcess;
  cwd: string;
  cols: number;
  rows: number;
}

/** `deny` must never reach `spawn`. Only these three values permit execution. */
export function isAllowDecision(decision: unknown): boolean {
  return decision === 'allow_once' || decision === 'allow_session' || decision === 'allow_workspace';
}

export class CommandRunner {
  private readonly logger: Logger;
  private readonly permissions: PermissionEngine;
  private readonly onEvent: CommandEventSink | null;
  private readonly onConsoleData: ((event: ConsoleDataEvent) => void) | null;
  private readonly shell: string | undefined;
  private readonly consoles = new Map<string, RunningConsole>();

  constructor(opts: CommandRunnerOptions) {
    this.logger = opts.logger.child('terminal');
    this.permissions = opts.permissions;
    this.onEvent = opts.onEvent ?? null;
    this.onConsoleData = opts.onConsoleData ?? null;
    this.shell = opts.shell;
  }

  // -------------------------------------------------------------------------
  // agent shell (§9 run)
  // -------------------------------------------------------------------------

  /**
   * Runs one command and streams its output. The permission gate is evaluated
   * EAGERLY (this is not an async generator, so calling `run()` itself throws
   * on a denial) — `deny` must never spawn anything.
   */
  run(input: CommandRunInput): AsyncIterable<CommandOutputChunk> {
    if (!isAllowDecision(input.permissionDecision)) {
      this.logger.warn('command refused by policy', {
        command: input.command,
        decision: input.permissionDecision,
        sessionId: input.sessionId,
      });
      throw fail('PERMISSION_DENIED', '该命令未获授权，已拒绝执行', {
        command: input.command,
        decision: input.permissionDecision,
      });
    }
    if (typeof input.command !== 'string' || input.command.trim().length === 0) {
      throw fail('UNKNOWN', '命令不能为空');
    }
    const args = Array.isArray(input.args) ? input.args.map(String) : [];
    if (input.signal?.aborted === true) {
      throw fail('UNKNOWN', '命令已被取消');
    }

    const cwd = this.resolveCwd(input.workspaceRoot);
    return this.stream({ ...input, args }, cwd);
  }

  private async *stream(
    input: CommandRunInput & { args: string[] },
    cwd: string,
  ): AsyncGenerator<CommandOutputChunk, void, undefined> {
    const commandId = ulid('cmd_');
    const started = Date.now();
    const queue = new OutputQueue<CommandOutputChunk>();
    let finished = false;
    let aborted = input.signal?.aborted === true;

    const emit = (
      type: CommandEventProposal['type'],
      payload: CommandEventProposal['payload'],
    ): void => {
      this.onEvent?.({
        sessionId: input.sessionId,
        turnId: input.turnId,
        type,
        payload,
        ts: new Date().toISOString(),
      });
    };

    const complete = (exitCode: number | null): void => {
      if (finished) {
        return;
      }
      finished = true;
      emit('command.completed', { commandId, exitCode, durationMs: Date.now() - started });
    };

    const emitted: Record<'stdout' | 'stderr', number> = { stdout: 0, stderr: 0 };
    const onData = (stream: 'stdout' | 'stderr', data: Buffer): void => {
      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
      for (let offset = 0; offset < buffer.length; offset += MAX_CHUNK_BYTES) {
        const slice = buffer.subarray(offset, Math.min(offset + MAX_CHUNK_BYTES, buffer.length));
        // every slice but the last is a cut out of a larger read
        let truncated = offset + MAX_CHUNK_BYTES < buffer.length;

        const used = emitted[stream];
        const remaining = Math.max(0, MAX_STREAM_OUTPUT_BYTES - used);
        let payload = slice;
        if (slice.length > remaining) {
          payload = slice.subarray(0, remaining);
          truncated = true;
        }
        if (payload.length === 0) {
          // already over budget: drop silently, the last chunk carries the flag
          continue;
        }
        emitted[stream] = used + payload.length;
        // The chunk that completes the budget is the last one the consumer
        // gets, so it carries the flag.
        if (emitted[stream] >= MAX_STREAM_OUTPUT_BYTES) {
          truncated = true;
        }

        const chunk = payload.toString('utf8');
        queue.push({ commandId, stream, chunk, truncated });
        emit('command.output', { commandId, stream, chunk, truncated });
      }
    };

    let child: ChildProcess;
    try {
      child = spawn(input.command, input.args, {
        cwd,
        // §11.1: the argv array is the contract. `shell: false` is the default,
        // it is pinned so a future option merge cannot change it.
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
      });
    } catch (err) {
      complete(null);
      throw this.spawnFailure(err, input.command);
    }

    const onAbort = (): void => {
      aborted = true;
      this.logger.info('command aborted, killing tree', { commandId, pid: child.pid ?? null });
      // NFR-05: the iteration must END even if the child ignores the kill.
      void killProcessTree(child, this.logger, 'abort');
      complete(null);
      queue.end();
    };
    input.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      child.on('spawn', () => {
        const payload: CommandStartedPayload = {
          commandId,
          command: [input.command, ...input.args].join(' '),
          cwd,
          // Honesty: nothing here is a shell, so we do not name one.
          shell: EXECUTION_MODE,
        };
        emit('command.started', payload);
        this.logger.info('command started', {
          commandId,
          command: input.command,
          cwd,
          exitCode: null,
          aborted,
        });
      });

      child.stdout?.on('data', (data: Buffer) => onData('stdout', data));
      child.stderr?.on('data', (data: Buffer) => onData('stderr', data));

      child.on('error', (err) => {
        this.logger.warn('command process error', {
          commandId,
          errno: errnoOf(err) ?? 'unknown',
        });
        // `fail` before `complete`: the puller must see the error, not a clean
        // end-of-stream.
        queue.fail(this.spawnFailure(err, input.command));
        complete(null);
      });

      child.on('close', (code) => {
        complete(typeof code === 'number' ? code : null);
        queue.end();
      });

      for await (const chunk of queue) {
        yield chunk;
      }
    } finally {
      input.signal?.removeEventListener('abort', onAbort);
      if (!finished) {
        // The consumer broke out of the loop: do not orphan the process.
        await killProcessTree(child, this.logger, 'consumer-abandoned');
        finished = true;
        emit('command.completed', { commandId, exitCode: null, durationMs: Date.now() - started });
      }
    }
  }

  // -------------------------------------------------------------------------
  // command console (IPC `terminal.create` / `write` / `kill`)
  // -------------------------------------------------------------------------

  /**
   * Non-interactive command console: the platform shell is started inside the
   * workspace with piped stdio, so `write()` feeds it commands and their output
   * comes back as `command.output` events. No PTY, therefore no echo, cursor
   * addressing or full-screen programs (see the file header).
   */
  async create(input: CreateConsoleInput): Promise<{ terminalId: string }> {
    // Real-path containment: a junction inside the workspace must not walk the
    // shell out of it (see contain-cwd.ts).
    const cwd = containCwdToRoot(input.workspaceRoot, input.cwd);

    const terminalId = ulid('term_');
    const shell = this.shell ?? defaultShell();
    const args = process.platform === 'win32' ? ['/Q'] : [];
    const child = spawn(shell, args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    this.consoles.set(terminalId, {
      terminalId,
      sessionId: input.sessionId,
      child,
      cwd,
      cols: input.cols,
      rows: input.rows,
    });

    this.logger.info('console created', { terminalId, sessionId: input.sessionId, cwd });

    const forward = (stream: 'stdout' | 'stderr') => (data: Buffer) => {
      this.onConsoleData?.({ terminalId, stream, chunk: data.toString('utf8') });
    };
    child.stdout?.on('data', forward('stdout'));
    child.stderr?.on('data', forward('stderr'));
    child.on('close', (code) => {
      this.consoles.delete(terminalId);
      this.logger.info('console exited', { terminalId, exitCode: code });
    });

    return { terminalId };
  }

  /** Feeds the console's stdin. Not a shell string — raw bytes into a pipe. */
  write(terminalId: string, data: string): void {
    const console_ = this.mustGet(terminalId);
    const stdin = console_.child.stdin;
    if (stdin === null || stdin.destroyed) {
      throw fail('UNKNOWN', '该终端已结束');
    }
    stdin.write(data, 'utf8');
  }

  /** Kills the console and everything it started (§11.1). */
  async kill(terminalId: string): Promise<void> {
    const console_ = this.mustGet(terminalId);
    this.consoles.delete(terminalId);
    await killProcessTree(console_.child, this.logger, 'console-kill');
    this.logger.info('console killed', { terminalId });
  }

  /** Shutdown hook: no console may outlive the app. */
  async killAll(): Promise<void> {
    for (const terminalId of [...this.consoles.keys()]) {
      await this.kill(terminalId).catch(() => undefined);
    }
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  private mustGet(terminalId: string): RunningConsole {
    const found = this.consoles.get(terminalId);
    if (found === undefined) {
      throw fail('UNKNOWN', '该终端不存在');
    }
    return found;
  }

  private resolveCwd(workspaceRoot: unknown): string {
    if (typeof workspaceRoot !== 'string' || workspaceRoot.trim().length === 0) {
      throw fail('UNKNOWN', '工作区路径无效');
    }
    return path.resolve(workspaceRoot);
  }

  private spawnFailure(err: unknown, command: string): AppErrorThrow {
    const errno = errnoOf(err);
    if (errno === 'ENOENT') {
      return fail('ADAPTER_NOT_AVAILABLE', `找不到可执行文件：${command}`, { command });
    }
    if (errno === 'EACCES') {
      return fail('PERMISSION_DENIED', `没有执行权限：${command}`, { command });
    }
    this.logger.warn('command spawn failed', { command, errno: errno ?? 'unknown' });
    return fail('UNKNOWN', `命令启动失败：${command}`);
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function defaultShell(): string {
  if (process.platform === 'win32') {
    return process.env.ComSpec ?? 'cmd.exe';
  }
  return process.env.SHELL ?? '/bin/sh';
}

type QueueItem<T> = { kind: 'item'; value: T };

interface Waiter<T> {
  resolve: (result: IteratorResult<T>) => void;
  reject: (error: unknown) => void;
}

/**
 * Minimal async queue: turns child-process events into a pull-based stream.
 * A `waiter` only exists while the buffer is empty, so `fail` can reject every
 * pending puller without dropping buffered data.
 */
class OutputQueue<T> implements AsyncIterable<T> {
  private readonly items: Array<QueueItem<T>> = [];
  private readonly waiting: Array<Waiter<T>> = [];
  private closed = false;
  private failure: unknown = undefined;

  push(value: T): void {
    if (this.closed) {
      return;
    }
    const next = this.waiting.shift();
    if (next !== undefined) {
      next.resolve({ value, done: false });
      return;
    }
    this.items.push({ kind: 'item', value });
  }

  fail(error: unknown): void {
    if (this.closed) {
      return;
    }
    this.failure = error;
    this.closed = true;
    while (this.waiting.length > 0) {
      this.waiting.shift()?.reject(error);
    }
  }

  end(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    while (this.waiting.length > 0) {
      this.waiting.shift()?.resolve({ value: undefined as unknown as T, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.items.length > 0) {
          const head = this.items.shift();
          if (head === undefined) {
            return Promise.resolve({ value: undefined as unknown as T, done: true });
          }
          return Promise.resolve({ value: head.value, done: false });
        }
        if (this.closed) {
          if (this.failure !== undefined) {
            const error = this.failure;
            this.failure = undefined;
            return Promise.reject(error);
          }
          return Promise.resolve({ value: undefined as unknown as T, done: true });
        }
        return new Promise<IteratorResult<T>>((resolve, reject) => {
          this.waiting.push({ resolve, reject });
        });
      },
      return: (): Promise<IteratorResult<T>> => {
        this.end();
        return Promise.resolve({ value: undefined as unknown as T, done: true });
      },
    };
  }
}
