/**
 * §8.2 write strategy, §5.2 SEQ-6 admission, NFR-06 payload ceiling.
 *
 * `append` is synchronous and transaction-transparent: the caller wraps
 * `sequencer.next()` + `append()` in one transaction (SEQ-2), and this module
 * only ever writes the `events` table plus the `blobs` index it owns.
 *
 * §8.2 permits a `text.delta` window to be coalesced. When the caller passes
 * `coalesced`, one row physically stands for N logical deltas; every read here
 * expands it again (`rowToTurnEvents`), so the logical stream stays one event
 * per delta and gapless. See `event-row.ts` for the storage format.
 */

import { MAX_EVENT_PAYLOAD_BYTES, validatePayload } from '@ucad/contracts';
import type { EventSource, TurnEvent, TurnEventType } from '@ucad/contracts';
import { nowIso, ulid } from '@ucad/observability';
import type { BlobStore, Logger } from '@ucad/observability';
import type { Database } from './database';
import { fieldPath, rowToTurnEvents, rootPath } from './event-row';
import type { CoalescedDeltaMeta, EventRow, StoredEnvelope } from './event-row';

/** §2 — `since` is paged; callers follow up with the last seq they received. */
const DEFAULT_SINCE_LIMIT = 500;

const TOOL_OUTPUT_PREVIEW = '$.outputPreview';

export interface AppendEventInput {
  sessionId: string;
  turnId: string;
  /** allocated by `SessionSequencer` inside the caller's transaction */
  seq: number;
  proposal: {
    type: TurnEventType;
    source: EventSource;
    payload: unknown;
    ts: string;
    /**
     * §8.2 — set only when this row stands for a coalesced delta window.
     * `seq` must then be the seq of the window's LAST delta.
     */
    coalesced?: CoalescedDeltaMeta;
  };
}

export interface AppendEventResult {
  ok: boolean;
  event?: TurnEvent;
  /** present only when admission failed; no row is written in that case */
  rejectedReason?: string;
}

interface OffloadResult {
  payload?: unknown;
  blobRef?: string;
  bytes: number;
}

export class EventLog {
  private readonly db: Database;
  private readonly logger: Logger;
  private readonly blobs: BlobStore;

  constructor(opts: { db: Database; logger: Logger; blobs: BlobStore }) {
    this.db = opts.db;
    this.logger = opts.logger.child('event-log');
    this.blobs = opts.blobs;
  }

  /**
   * SEQ-6: Zod-validate the payload for its declared type *before* anything is
   * persisted. A rejected proposal returns `ok: false` and leaves no trace in
   * `events` (the caller is expected to raise an `error` event instead).
   */
  append(input: AppendEventInput): AppendEventResult {
    const { sessionId, turnId, seq, proposal } = input;

    const validated = validatePayload(proposal.type, proposal.payload);
    if (validated === null) {
      this.logger.warn('event rejected at admission', {
        type: proposal.type,
        sessionId,
        turnId,
        seq,
      });
      return { ok: false, rejectedReason: `payload validation failed: ${proposal.type}` };
    }

    const eventId = ulid('ev_');
    const createdAt = nowIso();
    const offloaded = this.offload(eventId, proposal.type, validated);

    const envelope: StoredEnvelope = { source: proposal.source, ts: proposal.ts };
    if (proposal.coalesced !== undefined) {
      envelope.coalesced = proposal.coalesced;
    }
    if (offloaded.blobRef !== undefined) {
      envelope.blobRef = offloaded.blobRef;
      envelope.bytes = offloaded.bytes;
    } else {
      envelope.payload = offloaded.payload;
    }

    this.db.driver.run(
      `INSERT INTO events(id, session_id, turn_id, seq, type, source_kind, payload_json, created_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        eventId,
        sessionId,
        turnId,
        seq,
        proposal.type,
        proposal.source.kind,
        // NFR-15: >1 KiB payload_json is encrypted at rest when a key exists
        this.db.encryptIfNeeded(JSON.stringify(envelope)),
        createdAt,
      ],
    );

    const event = {
      eventId,
      seq,
      sessionId,
      turnId,
      ts: proposal.ts,
      type: proposal.type,
      source: proposal.source,
      payload: offloaded.payload,
    } as unknown as TurnEvent;

    return { ok: true, event };
  }

  /**
   * Read options.
   *
   * `full` defaults to **false**: a normal read returns the bounded preview and
   * the `*Ref`, and the body stays retrievable through `readBlob`. §7.2 requires
   * exactly this — an IPC response over 256 KiB must not carry the body, or the
   * size ceiling that NFR-06 put in place is undone at the last hop.
   *
   * `limit` counts **logical** events (§8.2), not rows, so a page can never
   * exceed the §7.2 ceiling because of coalescing. A coalesced window is
   * returned whole or not at all: splitting one would leave the caller's
   * `afterSeq` cursor inside a window, and the next page would re-deliver it.
   */
  since(input: {
    sessionId: string;
    afterSeq: number;
    limit?: number;
    full?: boolean;
  }): TurnEvent[] {
    const limit = input.limit ?? DEFAULT_SINCE_LIMIT;
    const full = input.full === true;
    const out: TurnEvent[] = [];
    let cursor = input.afterSeq;

    for (;;) {
      const rows = this.db.driver.all<EventRow>(
        `SELECT * FROM events
          WHERE session_id = ? AND seq > ?
          ORDER BY seq ASC
          LIMIT ?`,
        [input.sessionId, cursor, limit],
      );
      if (rows.length === 0) return out;

      for (const row of rows) {
        const events = this.hydrate(row, full);
        if (out.length > 0 && out.length + events.length > limit) return out;
        out.push(...events);
        cursor = row.seq;
      }
      if (rows.length < limit) return out;
    }
  }

  /**
   * The blob channel (§7.2). Only callers that genuinely need the full body —
   * export, transcript rebuild — should use this.
   */
  readBlob(ref: string): string | null {
    return this.blobs.exists(ref) ? this.blobs.get(ref) : null;
  }

  latestSeq(sessionId: string): number {
    const row = this.db.driver.get<{ max_seq: number | null }>(
      'SELECT MAX(seq) AS max_seq FROM events WHERE session_id = ?',
      [sessionId],
    );
    return typeof row?.max_seq === 'number' ? row.max_seq : 0;
  }

  listByTurn(sessionId: string, turnId: string, opts: { full?: boolean } = {}): TurnEvent[] {
    const rows = this.db.driver.all<EventRow>(
      `SELECT * FROM events
        WHERE session_id = ? AND turn_id = ?
        ORDER BY seq ASC`,
      [sessionId, turnId],
    );
    return rows.flatMap((row) => this.hydrate(row, opts.full === true));
  }

  /** Full transcript for export / rebuild; the only read that restores bodies. */
  all(sessionId: string, opts: { full?: boolean } = {}): TurnEvent[] {
    const rows = this.db.driver.all<EventRow>(
      'SELECT * FROM events WHERE session_id = ? ORDER BY seq ASC',
      [sessionId],
    );
    return rows.flatMap((row) => this.hydrate(row, opts.full === true));
  }

  /**
   * at-rest decrypt (§2) + optional blob restore (NFR-06) + §8.2 window
   * expansion => the logical events this row accounts for.
   *
   * When `full` is false the stored preview is returned as-is, so a read can
   * never exceed the NFR-06 ceiling on its own.
   */
  private hydrate(row: EventRow, full = false): TurnEvent[] {
    return rowToTurnEvents(this.db, row, {
      restorer: (eventId, field) => {
        const index = this.db.driver.get<{ ref: string }>(
          'SELECT ref FROM blobs WHERE event_id = ? AND field = ?',
          [eventId, field],
        );
        return index === undefined ? undefined : this.blobs.get(index.ref);
      },
      blobReader: (ref) => this.blobs.get(ref),
      restoreBodies: full,
    });
  }

  /**
   * NFR-06: an inline payload may not exceed `MAX_EVENT_PAYLOAD_BYTES`.
   * Individual oversized strings move to the blob directory and keep a
   * truncated preview in the event (`tool.completed` additionally keeps
   * `outputRef`). If the payload is still too large — many medium strings — the
   * whole payload is stored as one blob and the envelope points at it.
   */
  private offload(eventId: string, type: TurnEventType, payload: unknown): OffloadResult {
    const bytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
    if (bytes <= MAX_EVENT_PAYLOAD_BYTES) return { payload, bytes };

    const moved: Array<{ field: string; ref: string; bytes: number }> = [];

    const shrink = (node: unknown, path: string): unknown => {
      if (typeof node === 'string') {
        if (Buffer.byteLength(node, 'utf8') <= MAX_EVENT_PAYLOAD_BYTES) return node;
        const stored = this.blobs.putOrPreview(node);
        if (stored.ref === undefined) return node;
        moved.push({ field: path, ref: stored.ref, bytes: stored.bytes });
        return stored.preview;
      }
      if (Array.isArray(node)) {
        return node.map((item, index) => shrink(item, fieldPath(path, index)));
      }
      if (node !== null && typeof node === 'object') {
        const out: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
          out[key] = shrink(value, fieldPath(path, key));
        }
        return out;
      }
      return node;
    };

    const shrunken: unknown = shrink(payload, rootPath());

    // §8.2: `tool.completed` keeps a ref plus a preview, not the body.
    if (type === 'tool.completed' && shrunken !== null && typeof shrunken === 'object') {
      const preview = moved.find((entry) => entry.field === TOOL_OUTPUT_PREVIEW);
      if (preview !== undefined) {
        (shrunken as Record<string, unknown>).outputRef = preview.ref;
      }
    }

    for (const entry of moved) {
      this.db.driver.run(
        'INSERT INTO blobs(event_id, field, ref, bytes, created_at) VALUES(?, ?, ?, ?, ?)',
        [eventId, entry.field, entry.ref, entry.bytes, nowIso()],
      );
    }

    const shrunkJson = JSON.stringify(shrunken);
    if (Buffer.byteLength(shrunkJson, 'utf8') > MAX_EVENT_PAYLOAD_BYTES) {
      const ref = this.blobs.put(shrunkJson, { eventId, type });
      this.logger.info('payload offloaded', { eventId, type, bytes, ref, fields: moved.length });
      return { blobRef: ref, bytes };
    }

    this.logger.info('payload fields offloaded', { eventId, type, bytes, fields: moved.length });
    return { payload: shrunken, bytes };
  }
}
