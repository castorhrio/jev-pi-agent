/**
 * §5.2 SEQ-1..SEQ-6 / §8.2 — the **single** admission pipeline.
 *
 * ```
 * proposal
 *   -> validatePayload(type, payload)     // Zod; on failure: NO seq is allocated
 *   -> seq = sequencer.next(sessionId)    // same transaction as the write
 *   -> eventLog.append({ ..., seq })      // same transaction (SEQ-2)
 *   -> MessageProjector.apply(event)      // §8.3 derived projection
 *   -> onEvent(event)                     // fan out to the Renderer
 * ```
 *
 * Invariants this class is responsible for:
 *
 * - **E-1** only Main allocates `seq`. The broker, the decision engine and the
 *   hosts only ever submit proposals, and they all come through `admit()`.
 * - **E-4** a session has exactly one monotonic sequence across *all* planes,
 *   because there is exactly one allocator behind exactly one door. Anything
 *   Main produces itself (`context.pack.built`, `decision.made`,
 *   `permission.*`, `turn.*`, `warning`, `error`) uses the same door.
 * - **SEQ-6** a payload that fails Zod validation is never written and never
 *   burns a seq; a redacted `error` event is admitted instead.
 * - **E-3** an event type that cannot be mapped becomes a `warning`, never a
 *   silent drop.
 * - **E-5** nothing in this package ever synthesises `reasoning.delta`; a
 *   vendor that does not expose reasoning simply has none.
 *
 * §8.2 splits the stream: a `text.delta` / `reasoning.delta` is fanned out to
 * the Renderer immediately but its persistence is deferred to a coalesced
 * window (`DeltaCoalescer`); every other type — `tool.*`, `permission.*`,
 * `decision.*`, `error`, `turn.*` — is written through unchanged so the audit
 * trail keeps every durable event. A durable event flushes the open windows
 * first, so a window's row always carries the lower `seq`.
 *
 * Rollback safety: when `admit()` is called inside a caller-owned transaction
 * (the `turn.started` bootstrap of §5.1 ② is), the fan-out is deferred until
 * the outermost commit, so a rolled-back write can never reach the Renderer.
 */

import { TURN_EVENT_TYPE_SET, validatePayload } from '@ucad/contracts';
import type { ErrorComponent, EventSource, TurnEvent } from '@ucad/contracts';
import { MessageProjector } from '@ucad/storage';
import type { CoalescedDeltaMeta, Database, EventLog, SessionSequencer } from '@ucad/storage';
import type { SessionStore } from '@ucad/session';
import { ulid } from '@ucad/observability';
import type { BlobStore, Logger } from '@ucad/observability';
import { DeltaCoalescer, isDurableEvent } from './delta-coalescer';
import type { CoalescedDeltaWindow } from './delta-coalescer';
import { MAX_INLINE_PAYLOAD_BYTES } from './types';
import type { AdmitInput } from './types';

/** Outcome of one admission attempt. */
export type AdmitResult =
  | { ok: true; event: TurnEvent }
  | { ok: false; reason: string; errorEvent: TurnEvent | null };

/** Which §4.11 component a proposing plane maps to. */
const COMPONENT_BY_SOURCE: Readonly<Record<EventSource['kind'], ErrorComponent>> = {
  agent: 'agent',
  context: 'context',
  intelligence: 'intelligence',
  decision: 'decision',
  ucad: 'ipc',
};

/**
 * §8.2 — how much assistant text `MessageProjector` may hold in memory before
 * rewriting the `messages` row. Without it the row is rewritten per delta,
 * which is what made a long turn quadratic.
 */
const DEFAULT_MAX_PENDING_CHARS = 8 * 1024;

export interface AdmissionPipelineOptions {
  db: Database;
  logger: Logger;
  eventLog: EventLog;
  sequencer: SessionSequencer;
  sessionStore: SessionStore;
  /** §8.3. Defaults to `new MessageProjector(db, { maxPendingChars })`. */
  projector?: MessageProjector;
  /** §8.2. Defaults to `{ enabled: true, maxBytes: 4 KiB, maxIntervalMs: 200 }`. */
  deltaCoalescing?: { enabled?: boolean; maxBytes?: number; maxIntervalMs?: number };
  /** §8 requires it; NFR-06 offload itself is `EventLog`'s job (§2). */
  blobs?: BlobStore;
  onEvent: (e: TurnEvent) => void;
}

export class EventAdmissionPipeline {
  private readonly db: Database;
  private readonly logger: Logger;
  private readonly eventLog: EventLog;
  private readonly sequencer: SessionSequencer;
  private readonly sessionStore: SessionStore;
  private readonly projector: MessageProjector;
  private readonly blobs: BlobStore | undefined;
  private readonly onEvent: (e: TurnEvent) => void;
  /** §8.2 — the lossy stream's debounce window. */
  private readonly coalescer: DeltaCoalescer;

  /** nesting depth of caller-owned transactions, used to defer the fan-out */
  private txDepth = 0;
  private deferred: TurnEvent[] = [];
  /** live deltas: fanned out on commit, projected later with their window */
  private deferredLive: TurnEvent[] = [];
  /** §8.3 projection is serialised so `messages` cannot interleave */
  private projectChain: Promise<void> = Promise.resolve();

  constructor(opts: AdmissionPipelineOptions) {
    this.db = opts.db;
    this.logger = opts.logger.child('admission');
    this.eventLog = opts.eventLog;
    this.sequencer = opts.sequencer;
    this.sessionStore = opts.sessionStore;
    this.projector =
      opts.projector ?? new MessageProjector(opts.db, { maxPendingChars: DEFAULT_MAX_PENDING_CHARS });
    this.blobs = opts.blobs;
    this.onEvent = opts.onEvent;
    this.coalescer = new DeltaCoalescer((window) => this.persistWindow(window), {
      ...(opts.deltaCoalescing ?? {}),
    });
  }

  /** §8.2 — whether `text.delta` persistence is deferred. */
  get deltaCoalescingEnabled(): boolean {
    return this.coalescer.coalescingEnabled;
  }

  /** Logical deltas fanned out but not yet persisted. */
  get pendingDeltas(): number {
    return this.coalescer.pendingDeltas;
  }

  /**
   * The one and only way an event enters a session's stream.
   *
   * Synchronous on purpose: the sequencer and the `events` write must share a
   * transaction (SEQ-2), and `EventLog.append` is synchronous.
   */
  admit(input: AdmitInput): AdmitResult {
    // E-3: an unmappable type is a `warning`, never a silent drop.
    if (!TURN_EVENT_TYPE_SET.has(input.type)) {
      this.logUnmappable(input);
      return this.asRejection(
        this.admitWarning(
          input.sessionId,
          input.turnId,
          'VENDOR_EVENT_UNMAPPED',
          `event type "${String(input.type)}" has no UCAD mapping; dropped to a warning (E-3)`,
          { nativeType: input.source.nativeType ?? null, received: String(input.type) },
          input.source,
        ),
        `event type "${String(input.type)}" has no UCAD mapping`,
      );
    }

    // SEQ-6: validate BEFORE a seq exists. On failure nothing is written and no
    // sequence number is burned. NFR-08: the rejected payload is never logged.
    const payload = validatePayload(input.type, input.payload);
    if (payload === null) {
      this.logger.warn('proposal rejected by admission; no seq allocated (SEQ-6)', {
        sessionId: input.sessionId,
        turnId: input.turnId,
        type: input.type,
        nativeType: input.source.nativeType ?? null,
      });
      return this.asRejection(
        this.admitError(input, 'payload does not match the schema declared for its type'),
        'payload does not match the schema declared for its type',
      );
    }

    // §8.2: a durable event is never batched, and it flushes the open windows
    // of its turn first so a window's row keeps the lower `seq`.
    if (isDurableEvent(input.type)) this.coalescer.flushTurn(input.sessionId, input.turnId);

    // §8.2: a delta is fanned out now and persisted by its window.
    const live = this.bufferDelta(input, payload);
    if (live !== undefined) return { ok: true, event: live };

    return this.write(input, payload);
  }

  /**
   * §8.2 — numbers a delta and hands it to the coalescing window, returning the
   * event the Renderer must receive right now, or `undefined` when the delta is
   * not coalescable and the caller should write it through.
   *
   * The `seq` is real and final: it is the number this delta occupies in the
   * stream, it is what the Renderer orders on, and the window's row is later
   * written at the seq of its LAST delta. `wants()` is asked first so a
   * non-coalesced delta never burns a number (SEQ-2).
   */
  private bufferDelta(input: AdmitInput, payload: unknown): TurnEvent | undefined {
    const candidate = {
      sessionId: input.sessionId,
      turnId: input.turnId,
      type: input.type,
      source: input.source,
      payload,
      ts: input.ts ?? new Date().toISOString(),
      ...(input.seq !== undefined ? { callerAllocatedSeq: true } : {}),
    };
    if (!this.coalescer.wants(candidate)) return undefined;

    const seq = this.sequencer.next(input.sessionId);
    this.coalescer.add({ ...candidate, seq });

    // The live half. This event is NOT in `events` yet: it is the same logical
    // event the window will persist, carrying the `seq` it keeps in the stream,
    // which is why the Renderer's reducer folds it immediately — that is the
    // streaming UX — and why `persistWindow` never fans the window's row out
    // again. `ev_pending_` keeps a transient id from ever colliding with a
    // stored row that shares its `seq`.
    const event = {
      eventId: `ev_pending_${ulid()}`,
      seq,
      sessionId: input.sessionId,
      turnId: input.turnId,
      ts: candidate.ts,
      type: input.type,
      source: input.source,
      payload,
    } as unknown as TurnEvent;

    this.dispatchLive(event);
    return event;
  }

  private logUnmappable(input: AdmitInput): void {
    this.logger.warn('unmappable event type; admitted as a warning instead (E-3)', {
      sessionId: input.sessionId,
      turnId: input.turnId,
      received: String(input.type),
      nativeType: input.source.nativeType ?? null,
    });
  }

  /**
   * A rejection stays a rejection even though the redacted `error` event was
   * written successfully: the caller must be able to tell "admitted" from
   * "refused and reported", and must never receive the error event as if it
   * were the event it asked for.
   */
  private asRejection(written: AdmitResult, reason: string): AdmitResult {
    return {
      ok: false,
      reason,
      errorEvent: written.ok ? written.event : null,
    };
  }

  /** Convenience for Main's own events; never throws on a payload mismatch. */
  admitLocal(input: AdmitInput): TurnEvent | null {
    const result = this.admit(input);
    return result.ok ? result.event : null;
  }

  /**
   * §8.2 — writes one coalesced window as a single `events` row.
   *
   * The row's `seq` is the window's LAST delta, so `MAX(seq)` stays the true
   * high-water mark and the sequencer needs no special case. The envelope
   * carries the window's physical shape, which `EventLog` reverses on read.
   *
   * The row is PROJECTED but NOT fanned out. Its logical events — the deltas —
   * already went to the Renderer when they were admitted; re-delivering the
   * row would put a second, out-of-order `text.delta` with an already-seen seq
   * on the live stream. §8.3 still needs it projected so `messages` is complete.
   */
  private persistWindow(window: CoalescedDeltaWindow): void {
    const payload =
      window.type === 'text.delta'
        ? { text: window.text, messageId: window.messageId }
        : { text: window.text, redacted: window.redacted };
    const coalesced: CoalescedDeltaMeta = {
      deltaCount: window.count,
      firstSeq: window.firstSeq,
      lens: window.lens,
    };

    try {
      this.transaction(() => {
        const result = this.eventLog.append({
          sessionId: window.sessionId,
          turnId: window.turnId,
          seq: window.lastSeq,
          proposal: {
            type: window.type,
            source: window.source,
            payload,
            ts: window.ts,
            coalesced,
          },
        });
        if (!result.ok || result.event === undefined) {
          throw new AdmissionRejected(result.rejectedReason ?? 'event log refused the write');
        }
        this.sessionStore.setSessionLastSeq(window.sessionId, window.lastSeq);
        this.project(result.event);
      });
    } catch (err) {
      this.logger.error('coalesced delta window could not be persisted', {
        sessionId: window.sessionId,
        turnId: window.turnId,
        type: window.type,
        firstSeq: window.firstSeq,
        lastSeq: window.lastSeq,
        count: window.count,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * §8.2 — writes every open window and the transcript buffer, then stops the
   * timers. Call on shutdown: a crash may lose one window, a clean exit does not.
   */
  flush(): void {
    this.coalescer.flush();
    this.projector.flush();
  }

  /** Flush, then release the coalescing timers. */
  shutdown(): void {
    this.flush();
    this.coalescer.shutdown();
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  /** Allocate, persist, project and fan out. Caller holds no `seq` unless given. */
  private write(input: AdmitInput, payload: unknown): AdmitResult {
    this.notePayloadSize(input, payload);
    try {
      const event = this.transaction(() => {
        const seq = input.seq ?? this.sequencer.next(input.sessionId);
        const result = this.eventLog.append({
          sessionId: input.sessionId,
          turnId: input.turnId,
          seq,
          proposal: {
            type: input.type,
            source: input.source,
            payload,
            ts: input.ts ?? new Date().toISOString(),
          },
        });
        if (!result.ok || result.event === undefined) {
          // Rolling back unwinds the allocation too, so a rejected write can
          // never leave a hole in the sequence (SEQ-2).
          throw new AdmissionRejected(result.rejectedReason ?? 'event log refused the write');
        }
        this.sessionStore.setSessionLastSeq(input.sessionId, seq);
        this.defer(result.event);
        return result.event;
      });
      return { ok: true, event };
    } catch (err) {
      if (err instanceof AdmissionRejected) {
        this.logger.error('event write rejected; the allocated seq was rolled back', {
          sessionId: input.sessionId,
          turnId: input.turnId,
          type: input.type,
          reason: err.reason,
        });
        return { ok: false, reason: err.reason, errorEvent: null };
      }
      this.logger.error('event admission failed', {
        sessionId: input.sessionId,
        turnId: input.turnId,
        type: input.type,
        reason: err instanceof Error ? err.message : String(err),
      });
      return { ok: false, reason: err instanceof Error ? err.message : String(err), errorEvent: null };
    }
  }

  /**
   * Run `fn` in a transaction. Anything admitted inside is fanned out only
   * after the outermost commit, and dropped entirely if it rolls back.
   *
   * Public because §5.1 ② has to persist the `turns` row and its
   * `turn.started` event in **one** transaction (SEQ-2) while still going
   * through `SessionStore.beginTurn`.
   */
  transaction<T>(fn: () => T): T {
    const mark = this.deferred.length;
    const markLive = this.deferredLive.length;
    this.txDepth += 1;
    let out: T;
    try {
      out = this.db.transaction(fn);
    } catch (err) {
      this.txDepth -= 1;
      this.deferred.length = mark;
      this.deferredLive.length = markLive;
      throw err;
    }
    this.txDepth -= 1;
    if (this.txDepth === 0) this.flushDeferred();
    return out;
  }

  /** §8.2 blob offload happens inside `EventLog`; this only records that it will. */
  private notePayloadSize(input: AdmitInput, payload: unknown): void {
    if (this.blobs === undefined) return;
    let bytes = 0;
    try {
      bytes = Buffer.byteLength(JSON.stringify(payload) ?? '', 'utf8');
    } catch {
      return; // a non-serialisable payload is EventLog's problem to report
    }
    if (bytes > MAX_INLINE_PAYLOAD_BYTES) {
      this.logger.debug('payload over the inline ceiling; EventLog offloads it (NFR-06)', {
        sessionId: input.sessionId,
        turnId: input.turnId,
        type: input.type,
        bytes,
      });
    }
  }

  /** Queue a persisted event for projection + fan-out. */
  private defer(event: TurnEvent): void {
    this.projectChain = this.projectChain
      .then(() => this.project(event))
      .then(() => {
        this.fanOut(event);
      });
  }

  /**
   * §8.3 projection, serialised on the same chain so `messages` cannot
   * interleave, and so a projection failure is a warning rather than a loss.
   */
  private project(event: TurnEvent): Promise<void> {
    return this.projector.apply(event).catch((err: unknown) => {
      this.logger.warn('message projection failed; the event is still persisted', {
        eventId: event.eventId,
        seq: event.seq,
        reason: err instanceof Error ? err.message : String(err),
      });
    });
  }

  /**
   * §8.2 — fan out a live delta WITHOUT projecting it. Its window owns the
   * projection, so folding it here would double the text in `messages`.
   *
   * It still goes on the same ordered chain as every other event, because a
   * durable event is fanned out through the async projection chain: queuing the
   * delta synchronously would let a `tool.*` that was admitted at seq 202 be
   * delivered after the deltas at 203+, and the Renderer's reducer would then
   * see a non-monotonic stream (§5.2 E-4).
   */
  private dispatchLive(event: TurnEvent): void {
    if (this.txDepth > 0) {
      this.deferredLive.push(event);
      return;
    }
    this.projectChain = this.projectChain.then(() => {
      this.fanOut(event);
    });
  }

  private fanOut(event: TurnEvent): void {
    try {
      this.onEvent(event);
    } catch (err) {
      this.logger.error('onEvent fan-out threw; the event stays persisted', {
        eventId: event.eventId,
        seq: event.seq,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Releases both queues once the outermost caller-owned transaction commits. */
  private flushDeferred(): void {
    if (this.deferred.length > 0) {
      const batch = this.deferred;
      this.deferred = [];
      for (const event of batch) this.defer(event);
    }
    if (this.deferredLive.length > 0) {
      // Chained in admission order, ahead of anything admitted after the commit.
      const batch = this.deferredLive;
      this.deferredLive = [];
      for (const event of batch) this.dispatchLive(event);
    }
  }

  /** E-3 surface. */
  private admitWarning(
    sessionId: string,
    turnId: string,
    code: string,
    message: string,
    detail: unknown,
    source: EventSource,
  ): AdmitResult {
    return this.write(
      { sessionId, turnId, type: 'warning', source, payload: { code, message, detail } },
      { code, message, detail },
    );
  }

  /** SEQ-6 surface: the redacted `error` event a rejected proposal produces. */
  private admitError(input: AdmitInput, reason: string): AdmitResult {
    const payload = {
      code: 'UNKNOWN',
      message: `rejected ${input.type} proposal: ${reason}`,
      retryable: false,
      component: COMPONENT_BY_SOURCE[input.source.kind] ?? ('agent' as ErrorComponent),
      // NFR-08: identifiers only. The rejected payload is never echoed, because
      // it is unvalidated vendor data and may contain a prompt or a secret.
      detail: {
        eventType: input.type,
        sessionId: input.sessionId,
        turnId: input.turnId,
        nativeType: input.source.nativeType ?? null,
      },
    };
    return this.write(
      {
        sessionId: input.sessionId,
        turnId: input.turnId,
        type: 'error',
        source: input.source,
        payload,
      },
      payload,
    );
  }
}

/** Internal control-flow signal; never escapes {@link EventAdmissionPipeline}. */
class AdmissionRejected extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.name = 'AdmissionRejected';
    this.reason = reason;
  }
}
