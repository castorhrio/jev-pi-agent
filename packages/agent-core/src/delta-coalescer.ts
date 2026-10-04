/**
 * §8.2 (写入策略) — the debounce/batch half of the write strategy.
 *
 * > 事件到达 Main → 分配 seq → 同一事务内持久化 → 再分发 UI。
 * > 文本 `text.delta` **可 debounce 批量**；`tool.*` / `permission.*` /
 * > `decision.*` / `error` / `turn.*` **必须立即落库**。
 *
 * This is that split, and it is the only place it is made: the lossy,
 * high-frequency stream is buffered, everything else is written through
 * untouched so the audit trail keeps every durable event.
 *
 * ## The `seq` rule
 *
 * A window is a run of deltas for one `(sessionId, turnId, messageId)`. The
 * `seq`s are allocated **per delta, at arrival**, by the same sequencer as every
 * other event, so:
 *
 * - the live stream is monotonic and gapless, which is what the Renderer's
 *   reducer (`seq <= lastSeq` -> drop) and its gap detector rely on;
 * - a window always covers a **contiguous** seq range, because nothing else can
 *   allocate inside it — a durable event flushes the window first and then takes
 *   the next number.
 *
 * At flush the window is written as one `events` row whose `seq` column holds
 * the **last** delta's seq, with the physical window shape in the envelope
 * (`CoalescedDeltaMeta`). `MAX(seq)` therefore stays the true high-water mark,
 * the sequencer needs no special case, and `EventLog` expands the row back into
 * its N logical deltas on every read, so the persisted stream a consumer sees
 * is one event per delta and gapless. See `packages/storage/src/event-row.ts`.
 *
 * ## What this can lose
 *
 * A crash loses at most one window (200 ms / 4 KiB of text by default). §8.2
 * explicitly permits this; the alternative is a row per token.
 */

import type { EventSource, TurnEventType } from '@ucad/contracts';

/** §8.2: the two stream types that are lossy and may be batched. */
const COALESCABLE: ReadonlySet<string> = new Set<TurnEventType>([
  'text.delta',
  'reasoning.delta',
]);

/** §8.2 defaults. Both bounds apply, whichever is hit first. */
const DEFAULT_MAX_BYTES = 4 * 1024;
const DEFAULT_MAX_INTERVAL_MS = 200;

/**
 * Ceiling so a window can never reach the NFR-06 inline ceiling
 * (`MAX_EVENT_PAYLOAD_BYTES`, 256 KiB). A window that offloaded its whole
 * payload to a blob could no longer be split back into deltas on read.
 */
const HARD_MAX_BYTES = 64 * 1024;

/** A completed window handed to the pipeline for one `events` row. */
export interface CoalescedDeltaWindow {
  sessionId: string;
  turnId: string;
  type: 'text.delta' | 'reasoning.delta';
  source: EventSource;
  /** seq of the first logical delta; the row is written at {@link lastSeq} */
  firstSeq: number;
  lastSeq: number;
  /** number of logical deltas in the window */
  count: number;
  /** the deltas' texts, concatenated */
  text: string;
  /** UTF-16 length of each delta's text, in order */
  lens: number[];
  /** producer ts of the first delta in the window */
  ts: string;
  /** `text.delta` only — constant across the window */
  messageId: string;
  /** `reasoning.delta` only — constant across the window */
  redacted: boolean;
}

export interface DeltaCoalescerOptions {
  /** `false` restores the historical one-row-per-delta behaviour. */
  enabled?: boolean;
  /** characters buffered before the window is written (default 4 KiB) */
  maxBytes?: number;
  /** milliseconds a window may stay open (default 200) */
  maxIntervalMs?: number;
  /** inject a timer, for tests */
  schedule?: (fn: () => void, ms: number) => NodeJS.Timeout;
}

interface OpenWindow {
  readonly key: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly type: 'text.delta' | 'reasoning.delta';
  readonly source: EventSource;
  readonly messageId: string;
  readonly redacted: boolean;
  /** producer ts of the first delta; the row is written with this ts */
  readonly ts: string;
  firstSeq: number;
  lastSeq: number;
  text: string;
  lens: number[];
  timer: NodeJS.Timeout | null;
}

/** A delta offered to the coalescer, already validated (SEQ-6). */
export interface DeltaCandidate {
  sessionId: string;
  turnId: string;
  type: TurnEventType;
  source: EventSource;
  payload: unknown;
  ts: string;
  /**
   * a `seq` the CALLER allocated inside its own transaction (`turn.started`).
   * Such an event is written through, so the transaction that owns the number
   * is also the one that persists it.
   */
  callerAllocatedSeq?: boolean;
}

/** A {@link DeltaCandidate} that the sequencer has numbered. */
export interface NumberedDeltaCandidate extends DeltaCandidate {
  /** the seq the sequencer just allocated for this single delta */
  seq: number;
}

function windowKey(sessionId: string, turnId: string, messageId: string): string {
  return `${sessionId}\u0000${turnId}\u0000${messageId}`;
}

function turnPrefix(sessionId: string, turnId: string): string {
  return `${sessionId}\u0000${turnId}\u0000`;
}

function isCoalescable(type: TurnEventType): boolean {
  return COALESCABLE.has(type);
}

/**
 * §8.2: the durable half of the stream. Kept as an explicit list rather than
 * "everything else" so that a newly added event type is immediate until someone
 * deliberately puts it on the slow path.
 */
export function isDurableEvent(type: TurnEventType): boolean {
  return !isCoalescable(type);
}

export class DeltaCoalescer {
  private readonly open = new Map<string, OpenWindow>();
  private readonly windows = new Set<OpenWindow>();
  private readonly enabled: boolean;
  private readonly maxBytes: number;
  private readonly maxIntervalMs: number;
  private readonly schedule: (fn: () => void, ms: number) => NodeJS.Timeout;

  constructor(
    private readonly persist: (window: CoalescedDeltaWindow) => void,
    opts: DeltaCoalescerOptions = {},
  ) {
    this.enabled = opts.enabled !== false;
    this.maxBytes = Math.min(
      Math.max(1, opts.maxBytes ?? DEFAULT_MAX_BYTES),
      HARD_MAX_BYTES,
    );
    this.maxIntervalMs = Math.max(1, opts.maxIntervalMs ?? DEFAULT_MAX_INTERVAL_MS);
    this.schedule =
      opts.schedule ??
      ((fn, ms) => {
        const timer = setTimeout(fn, ms);
        // A pending window must never be the reason the process stays alive.
        timer.unref?.();
        return timer;
      });
  }

  get coalescingEnabled(): boolean {
    return this.enabled;
  }

  /** Open windows, for diagnostics and shutdown assertions. */
  get pendingWindows(): number {
    return this.open.size;
  }

  /** Logical deltas accepted but not yet persisted. */
  get pendingDeltas(): number {
    let total = 0;
    for (const window of this.windows) total += window.lens.length;
    return total;
  }

  /**
   * Whether this delta will be buffered, decided BEFORE a `seq` exists.
   *
   * Split from {@link add} on purpose: a delta that is not buffered must not
   * burn a sequence number (SEQ-2), so the caller has to know the answer before
   * it calls `sequencer.next()`.
   */
  wants(candidate: DeltaCandidate): boolean {
    if (!this.enabled) return false;
    if (candidate.callerAllocatedSeq === true) return false;
    if (!isCoalescable(candidate.type)) return false;

    const payload = candidate.payload as { text?: unknown; messageId?: unknown; redacted?: unknown };
    if (typeof payload.text !== 'string') return false;
    if (typeof payload.messageId !== 'string' || payload.messageId === '') return false;
    if (candidate.type === 'reasoning.delta' && typeof payload.redacted !== 'boolean') return false;
    return true;
  }

  /**
   * Buffers one numbered delta and returns the window it joined, or `undefined`
   * if the window closed immediately. The caller still owes the Renderer one
   * event per delta either way.
   */
  add(candidate: NumberedDeltaCandidate): void {
    const payload = candidate.payload as {
      text: string;
      messageId: string;
      redacted?: boolean;
    };
    const text = payload.text;
    const messageId = payload.messageId;
    const redacted = payload.redacted === true;
    const type = candidate.type as 'text.delta' | 'reasoning.delta';

    const key = windowKey(candidate.sessionId, candidate.turnId, messageId);
    let window = this.open.get(key);

    if (
      window !== undefined &&
      (window.redacted !== redacted || window.text.length + text.length > this.maxBytes)
    ) {
      this.writeWindow(window);
      window = undefined;
    }

    if (window === undefined) {
      // A new assistant message inside a turn must not be reordered behind the
      // previous one, so the turn's other windows go out first (§8.3 ordering).
      this.flushTurn(candidate.sessionId, candidate.turnId, key);
      window = {
        key,
        sessionId: candidate.sessionId,
        turnId: candidate.turnId,
        type,
        source: candidate.source,
        messageId,
        redacted,
        ts: candidate.ts,
        firstSeq: candidate.seq,
        lastSeq: candidate.seq,
        text: '',
        lens: [],
        timer: null,
      };
      this.open.set(key, window);
      this.windows.add(window);
    }

    window.text += text;
    window.lens.push(text.length);
    window.lastSeq = candidate.seq;

    if (window.lens.length === 1) this.arm(window);
    if (window.text.length >= this.maxBytes) this.writeWindow(window);
  }

  /**
   * Writes every window of one turn. Called before a durable event of that turn
   * is admitted, so the window's row always gets the lower `seq`.
   */
  flushTurn(sessionId: string, turnId: string, exceptKey?: string): void {
    const prefix = turnPrefix(sessionId, turnId);
    for (const window of [...this.open.values()]) {
      if (window.key === exceptKey) continue;
      if (window.key.startsWith(prefix)) this.writeWindow(window);
    }
  }

  /**
   * Writes every open window, whatever turn it belongs to.
   *
   * A window of one turn never has to be flushed by a durable event of
   * another: reads order by `seq`, and a window's row carries its own last
   * `seq`, so a late write is still read back in the right place. Flushing
   * globally here would only add writes, not correctness.
   */
  flush(): void {
    for (const window of [...this.windows]) this.writeWindow(window);
  }

  /** Stops the timers and writes everything still open. */
  shutdown(): void {
    this.flush();
    for (const window of this.windows) this.clearTimer(window);
  }

  // -------------------------------------------------------------------------

  private arm(window: OpenWindow): void {
    this.clearTimer(window);
    window.timer = this.schedule(() => {
      window.timer = null;
      this.writeWindow(window);
    }, this.maxIntervalMs);
  }

  private clearTimer(window: OpenWindow): void {
    if (window.timer === null) return;
    clearTimeout(window.timer);
    window.timer = null;
  }

  private writeWindow(window: OpenWindow): void {
    if (!this.open.delete(window.key)) return;
    this.windows.delete(window);
    this.clearTimer(window);
    if (window.lens.length === 0) return;
    this.persist({
      sessionId: window.sessionId,
      turnId: window.turnId,
      type: window.type,
      source: window.source,
      firstSeq: window.firstSeq,
      lastSeq: window.lastSeq,
      count: window.lens.length,
      text: window.text,
      lens: window.lens,
      ts: window.ts,
      messageId: window.messageId,
      redacted: window.redacted,
    });
  }
}
