/**
 * §11.2 — the User Terminal.
 *
 * A real PTY (`node-pty` → ConPTY on Windows), spawned in **Main**. This module
 * is the only place `node-pty` is ever touched:
 *
 *  - NFR-01 — the Renderer never loads this module and never sees the `IPty`
 *    object. It gets a chunked data channel and a write channel over the typed
 *    preload bridge, nothing more. A terminal is arbitrary code execution on the
 *    user's machine, so it stays on the Main side of the wall.
 *  - NFR-06 — a terminal stream is unbounded by nature. Output is cut into
 *    64 KiB chunks and coalesced on a 16 ms tick, with a hard flush at 256 KiB
 *    so a `yes` loop cannot grow the pending buffer without bound. Nothing here
 *    is persisted, so the 256 KiB inline-payload precedent is the ceiling.
 *
 * `node-pty` is an **optional** dependency. A native build that fails must not
 * break `npm install` or app startup, so the module is required lazily inside a
 * try/catch and its absence is reported as a first-class, explained fact rather
 * than a load-time crash of the main bundle. {@link probePty} is what the UI
 * asks before it offers a terminal at all.
 *
 * Teardown, which is not optional: calling `app.exit()` while a ConPTY worker
 * thread is still alive aborts the process with `0xC0000409` from
 * `lib/conpty_console_list_agent.js`. {@link PtyHost.killAll} therefore detaches
 * every listener, flushes, and kills each process tree, and the app must await it
 * BEFORE `app.exit()`. A half-killed host that only calls `pty.kill()` leaves
 * that worker running and takes the whole app down on quit.
 *
 * This is additive: {@link CommandRunner} remains the UCAD-managed, permission-
 * gated agent shell (§9, NFR-02). This host is the user's own shell and is
 * deliberately NOT permission-gated — the user typing into their own terminal is
 * not the agent acting on their behalf.
 */

import { ulid } from '@ucad/observability';
import type { Logger } from '@ucad/observability';
import { fail } from './errors';
import { containCwdToRoot } from './contain-cwd';
import { runTaskkill } from './process-tree';

/** NFR-06: one pushed chunk never exceeds this; larger output is cut. */
const MAX_CHUNK_BYTES = 64 * 1024;

/**
 * NFR-06: a PTY can emit far faster than a UI can paint. Output is buffered and
 * flushed on this tick, so a `yes` loop becomes ~60 pushes a second instead of
 * tens of thousands.
 */
const FLUSH_INTERVAL_MS = 16;

/**
 * NFR-06: the pending buffer is flushed early once it passes this, so the
 * coalescing window is a rate limit and not an unbounded accumulator. Matches
 * the 256 KiB inline-payload ceiling used elsewhere in the codebase.
 */
const FLUSH_HIGH_WATER_BYTES = 256 * 1024;

/** A terminal smaller than this is a layout bug, not a terminal. */
const MIN_COLS = 2;
const MIN_ROWS = 1;
const MAX_COLS = 500;
const MAX_ROWS = 300;

const IS_WINDOWS = process.platform === 'win32';

// ---------------------------------------------------------------------------
// node-pty, typed structurally
// ---------------------------------------------------------------------------

/**
 * The slice of `node-pty` this host uses, declared locally instead of imported.
 * A `import type { IPty } from 'node-pty'` would make `tsc` resolve a module the
 * build is allowed not to have — the type error would then be a compile failure,
 * which is exactly the build-time coupling the optional dependency exists to
 * avoid. The runtime require stays in one place and stays lazy.
 */
interface PtyProcess {
  readonly pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(listener: (data: string) => void): void;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): void;
}

interface NodePtyModule {
  spawn(
    file: string,
    args: string[],
    options: {
      name: string;
      cols: number;
      rows: number;
      cwd: string;
      env: Record<string, string>;
    },
  ): PtyProcess;
}

/** §11.2 / NFR-01: what the Renderer is told, and why, when the PTY is absent. */
export interface PtyAvailability {
  available: boolean;
  /** A user-safe sentence. `null` when available. Never an empty string. */
  reason: string | null;
  /** The raw load error, for the log only. Never shown in the UI. */
  detail: string | null;
}

interface LoadedPty {
  ok: true;
  module: NodePtyModule;
}
interface MissingPty {
  ok: false;
  reason: string;
  detail: string;
}

let loaded: LoadedPty | MissingPty | null = null;

/** Test seam: forget the cached load result so a broken module can be re-probed. */
export function resetPtyModuleCache(): void {
  loaded = null;
}

/**
 * Lazily loads `node-pty`. A missing or ABI-mismatched native module is a
 * caught error that becomes a sentence, not a crash of the main bundle.
 */
function loadPty(): LoadedPty | MissingPty {
  if (loaded !== null) {
    return loaded;
  }
  try {
    // Optional dependency: a literal `require` here is resolved at runtime, so a
    // machine without the native build simply takes the catch branch.
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- optional native module, resolved at runtime
    const required = require('node-pty') as Partial<NodePtyModule>;
    if (typeof required?.spawn !== 'function') {
      loaded = {
        ok: false,
        reason: 'node-pty 已安装，但它没有导出可用的 spawn，可能是安装不完整。',
        detail: 'node-pty resolved but exposes no spawn()',
      };
      return loaded;
    }
    loaded = { ok: true, module: required as NodePtyModule };
    return loaded;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    loaded = {
      ok: false,
      reason:
        'node-pty 原生模块不可用：它没有安装，或没有针对当前的 Node/Electron 版本编译。重新安装依赖（npm install）并确认本机有 C++ 构建工具后即可使用交互式终端。',
      detail,
    };
    return loaded;
  }
}

/** Whether an interactive terminal can be started, and a real reason if not. */
export function probePty(): PtyAvailability {
  const result = loadPty();
  return result.ok
    ? { available: true, reason: null, detail: null }
    : { available: false, reason: result.reason, detail: result.detail };
}

// ---------------------------------------------------------------------------
// events
// ---------------------------------------------------------------------------

/** `IPC_PUSH.ptyData` payload. */
export interface PtyDataEvent {
  terminalId: string;
  chunk: string;
}

/** `IPC_PUSH.ptyExit` payload — a PTY does report an exit code, unlike a pipe. */
export interface PtyExitEvent {
  terminalId: string;
  exitCode: number;
  signal?: number;
}

export interface PtyHostOptions {
  logger: Logger;
  /** Where PTY output goes; chunked and rate-bounded (NFR-06). */
  onData?: (event: PtyDataEvent) => void;
  onExit?: (event: PtyExitEvent) => void;
  /** Shell override; defaults to ComSpec on Windows, $SHELL elsewhere. */
  shell?: string;
}

export interface PtyCreateInput {
  sessionId?: string;
  workspaceRoot: string;
  cwd: string;
  cols: number;
  rows: number;
}

interface RunningPty {
  terminalId: string;
  pty: PtyProcess;
  cwd: string;
  cols: number;
  rows: number;
  /** NFR-06 coalescing buffer. */
  pending: string;
  timer: ReturnType<typeof setTimeout> | null;
  killed: boolean;
}

// ---------------------------------------------------------------------------
// host
// ---------------------------------------------------------------------------

export class PtyHost {
  private readonly logger: Logger;
  private readonly onData: ((event: PtyDataEvent) => void) | null;
  private readonly onExit: ((event: PtyExitEvent) => void) | null;
  private readonly shell: string | undefined;
  private readonly terminals = new Map<string, RunningPty>();

  constructor(opts: PtyHostOptions) {
    this.logger = opts.logger.child('pty');
    this.onData = opts.onData ?? null;
    this.onExit = opts.onExit ?? null;
    this.shell = opts.shell;
  }

  // -------------------------------------------------------------------------
  // lifecycle
  // -------------------------------------------------------------------------

  async create(input: PtyCreateInput): Promise<{ terminalId: string }> {
    const status = probePty();
    if (!status.available) {
      this.logger.warn('pty unavailable, refusing to create a terminal', {
        detail: status.detail,
      });
      throw fail('ADAPTER_NOT_AVAILABLE', status.reason ?? 'node-pty 不可用');
    }

    // Real-path containment: a junction planted inside the workspace must not
    // walk the shell out of it (see contain-cwd.ts). `containCwdToRoot`
    // revalidates both path shapes, so this replaces the lexical check.
    const cwd = containCwdToRoot(input.workspaceRoot, input.cwd);

    const cols = clamp(input.cols, MIN_COLS, MAX_COLS, 80);
    const rows = clamp(input.rows, MIN_ROWS, MAX_ROWS, 24);
    const terminalId = ulid('pty_');
    const { file, args } = this.shellCommand();

    // `loadPty()` already succeeded above; the assertion keeps the non-null
    // narrowing without a second require.
    const ptyModule = (loadPty() as LoadedPty).module;
    const pty = ptyModule.spawn(file, args, {
      // §7 Windows correctness: ConPTY only behaves like a terminal with this
      // name — anything else disables colour and mis-sizes the buffer.
      name: 'xterm-color',
      cols,
      rows,
      cwd,
      env: ptyEnv(),
    });

    const entry: RunningPty = {
      terminalId,
      pty,
      cwd,
      cols,
      rows,
      pending: '',
      timer: null,
      killed: false,
    };
    this.terminals.set(terminalId, entry);

    pty.onData((data) => this.enqueue(entry, data));
    pty.onExit((event) => {
      this.detach(entry);
      this.terminals.delete(terminalId);
      this.logger.info('pty exited', { terminalId, exitCode: event.exitCode });
      this.onExit?.({
        terminalId,
        exitCode: event.exitCode,
        ...(event.signal === undefined ? {} : { signal: event.signal }),
      });
    });

    this.logger.info('pty created', { terminalId, sessionId: input.sessionId, cwd, cols, rows });
    return { terminalId };
  }

  /** Feeds the PTY's stdin. Raw keystrokes, not a shell command string. */
  write(terminalId: string, data: string): void {
    this.mustGet(terminalId).pty.write(data);
  }

  /**
   * Tells the PTY its window changed. A terminal left at the wrong size wraps
   * every line and never recovers on its own.
   */
  resize(terminalId: string, cols: number, rows: number): void {
    const entry = this.mustGet(terminalId);
    const nextCols = clamp(cols, MIN_COLS, MAX_COLS, entry.cols);
    const nextRows = clamp(rows, MIN_ROWS, MAX_ROWS, entry.rows);
    if (nextCols === entry.cols && nextRows === entry.rows) {
      return;
    }
    entry.cols = nextCols;
    entry.rows = nextRows;
    try {
      entry.pty.resize(nextCols, nextRows);
    } catch (error) {
      // ConPTY rejects a resize that races its own teardown. The size will be
      // correct on the next one, so this is a debug line, not a user-facing
      // error: the terminal itself is still alive.
      this.logger.debug('pty resize ignored', {
        terminalId,
        cols: nextCols,
        rows: nextRows,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Kills the shell and everything it started (§11.1), and — this is the part
   * that matters on Windows — detaches the listeners first. See the file header:
   * a live ConPTY worker at `app.exit()` is a `0xC0000409`.
   */
  async kill(terminalId: string): Promise<void> {
    const entry = this.terminals.get(terminalId);
    if (entry === undefined) {
      throw fail('UNKNOWN', '该终端不存在');
    }
    this.terminals.delete(terminalId);
    await this.teardown(entry, 'kill');
  }

  /**
   * Shutdown hook. MUST be awaited before `app.exit()` / `app.quit()` resolves.
   * Every listener is detached, every timer cleared, every process tree killed.
   */
  async killAll(): Promise<void> {
    const entries = [...this.terminals.values()];
    this.terminals.clear();
    for (const entry of entries) {
      await this.teardown(entry, 'shutdown').catch(() => undefined);
    }
    if (entries.length > 0) {
      this.logger.info('all ptys torn down', { count: entries.length });
    }
  }

  // -------------------------------------------------------------------------
  // introspection (used by the panel's own status line and by tests)
  // -------------------------------------------------------------------------

  isRunning(terminalId: string): boolean {
    return this.terminals.has(terminalId);
  }

  /** `null` once the terminal is gone — the test asserts on this after a kill. */
  pidOf(terminalId: string): number | null {
    return this.terminals.get(terminalId)?.pty.pid ?? null;
  }

  get count(): number {
    return this.terminals.size;
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  private async teardown(entry: RunningPty, reason: string): Promise<void> {
    // Flush what the shell already produced: killing first would throw away the
    // last lines of output, which reads as the terminal truncating itself.
    this.detach(entry);
    const pid = entry.pty.pid;
    try {
      entry.pty.kill();
    } catch (error) {
      this.logger.debug('pty kill threw; falling back to the tree kill', {
        terminalId: entry.terminalId,
        reason,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    // A PTY is a shell: the interesting processes are its children, and
    // `pty.kill()` alone leaves a `npm`/`node` grandchild writing to the
    // workspace. `taskkill /T /F` walks the tree (process-tree.ts, §11.1).
    if (IS_WINDOWS && pid > 0) {
      this.logger.info('killing pty process tree', { terminalId: entry.terminalId, pid, reason });
      await runTaskkill(pid);
    }
  }

  /**
   * NFR-06: buffer, then flush on a tick. The cut at 64 KiB keeps a single push
   * inside the same size class as every other event payload in the codebase, so
   * the bridge never has to carry an arbitrarily large string.
   */
  private enqueue(entry: RunningPty, data: string): void {
    if (entry.killed || data.length === 0) {
      return;
    }
    entry.pending += data;
    if (entry.timer === null) {
      entry.timer = setTimeout(() => this.flush(entry), FLUSH_INTERVAL_MS);
      // A pending flush must never be the reason the process stays alive.
      entry.timer.unref?.();
    }
    if (entry.pending.length >= FLUSH_HIGH_WATER_BYTES) {
      this.flush(entry);
    }
  }

  private flush(entry: RunningPty): void {
    if (entry.timer !== null) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    if (entry.pending.length === 0) {
      return;
    }
    const buffered = entry.pending;
    entry.pending = '';
    for (let offset = 0; offset < buffered.length; offset += MAX_CHUNK_BYTES) {
      this.onData?.({
        terminalId: entry.terminalId,
        chunk: buffered.slice(offset, offset + MAX_CHUNK_BYTES),
      });
    }
  }

  /** Clears the timer and flushes what is already buffered. */
  private detach(entry: RunningPty): void {
    this.flush(entry);
    entry.killed = true;
  }

  private mustGet(terminalId: string): RunningPty {
    const found = this.terminals.get(terminalId);
    if (found === undefined) {
      throw fail('UNKNOWN', '该终端不存在');
    }
    return found;
  }

  private shellCommand(): { file: string; args: string[] } {
    if (this.shell !== undefined && this.shell.length > 0) {
      return { file: this.shell, args: IS_WINDOWS ? ['/Q'] : [] };
    }
    if (IS_WINDOWS) {
      // `/Q` keeps the prompt out of the transcript's way; the PTY supplies the
      // echo a user expects, so disabling cmd's own echo loses nothing.
      return { file: process.env.ComSpec ?? 'cmd.exe', args: ['/Q'] };
    }
    return { file: process.env.SHELL ?? '/bin/sh', args: [] };
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * A ConPTY session with a sparse environment produces a broken shell: `PATH`
 * decides whether `git` exists at all, and a missing `TERM` makes some tools
 * refuse to draw. Everything inherited is kept, because that is the user's
 * machine and their shell profile is not ours to second-guess.
 */
function ptyEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') {
      env[key] = value;
    }
  }
  if (env['TERM'] === undefined) {
    env['TERM'] = 'xterm-256color';
  }
  // Windows tools that colour their output key off this; ConPTY ignores it.
  env['COLORTERM'] ??= 'truecolor';
  env['UCAD_TERMINAL'] = '1';
  return env;
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.floor(numeric)));
}
