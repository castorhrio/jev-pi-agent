/**
 * §8.1 — the storage format of one `events` row.
 *
 * `payload_json` holds a small envelope rather than the bare payload because
 * the §8.1 table only carries a flattened `source_kind` column, while a
 * `TurnEvent` needs the whole `EventSource` (§4.2) to be reconstructible
 * (NFR-03: a reloaded event is a valid event). Envelope:
 *
 * ```json
 * { "source": { "kind": "agent", "agentId": "..." }, "ts": "...", "payload": { ... } }
 * ```
 *
 * NFR-06: when the payload was too large to inline, the envelope instead points
 * at a blob (`{ "blobRef": "blob_...", "bytes": 1234 }`) and the per-field
 * replacements are indexed in the `blobs` table.
 *
 * ## Coalesced delta rows (§8.2)
 *
 * §8.2 allows `text.delta` to be debounced/batched on the way to disk. When a
 * window is coalesced, N logical deltas are stored as ONE row. The storage
 * format of that row is:
 *
 * - `events.seq` holds the seq of the **LAST** logical delta in the window, so
 *   `MAX(seq)` stays the true high-water mark of the stream. That keeps
 *   `SessionSequencer`'s seeding (§5.2 SEQ-1) and `EventLog.latestSeq()`
 *   correct with no special casing, and it means a batch occupies a contiguous
 *   range `[firstSeq, firstSeq + deltaCount - 1]` that no other batch overlaps.
 * - the envelope carries `coalesced` — the physical form of the window, which
 *   is deliberately NOT part of the payload: the logical payload stays exactly
 *   the contract's `{ text, messageId }`, so validation (SEQ-6) and every
 *   consumer of `TurnEvent` are unaffected.
 *
 * The raw `seq` column therefore has gaps *between* windows and never inside
 * one. `rowToTurnEvents` expands a window back into its logical events, so the
 * stream every caller actually reads (`EventLog.since/all/listByTurn`,
 * `MessageProjector.rebuildSession`) is one event per `text.delta`, gapless
 * and byte-identical to the live stream — which is what NFR-03 replay and the
 * Renderer's `seq`-ordered reducer require.
 */

import type { EventSource, TurnEvent } from '@ucad/contracts';
import type { Database } from './database';

export interface EventRow {
  id: string;
  session_id: string;
  turn_id: string;
  seq: number;
  type: string;
  source_kind: string;
  payload_json: string;
  created_at: string;
}

export interface StoredEnvelope {
  source: EventSource;
  /** the producer's timestamp; `created_at` is the persistence timestamp */
  ts: string;
  payload?: unknown;
  blobRef?: string;
  bytes?: number;
  /** present only on a row that stands for a §8.2 coalesced delta window */
  coalesced?: CoalescedDeltaMeta;
}

/**
 * §8.2 — the physical shape of a coalesced `text.delta` / `reasoning.delta`
 * window. One row, N logical events.
 */
export interface CoalescedDeltaMeta {
  /** how many logical deltas this row stands for (>= 2) */
  deltaCount: number;
  /** seq of the FIRST logical delta; `events.seq` holds the LAST one */
  firstSeq: number;
  /**
   * UTF-16 length of every logical delta's `text`, in order, so the
   * concatenation can be split back into the original deltas exactly. Kept as
   * lengths rather than the texts themselves: the text is already in `payload`.
   */
  lens: number[];
}

type FieldRestorer = (eventId: string, field: string) => string | undefined;

export interface RowToEventOptions {
  restorer?: FieldRestorer;
  blobReader?: (ref: string) => string;
  restoreBodies?: boolean;
}

/** `''` -> `$.field`, `$.a.b[2]`. Stable, so the `blobs` index can key on it. */
export function fieldPath(prefix: string, key: string | number): string {
  return typeof key === 'number' ? `${prefix}[${key}]` : `${prefix}.${key}`;
}

export function rootPath(): string {
  return '$';
}

function pathTokens(path: string): Array<string | number> {
  if (path === '$') return [];
  const tokens: Array<string | number> = [];
  for (const part of path.slice(2).split('.')) {
    const bracket = part.indexOf('[');
    if (bracket < 0) {
      tokens.push(part);
      continue;
    }
    const head = part.slice(0, bracket);
    if (head !== '') tokens.push(head);
    const index = Number(part.slice(bracket + 1, part.length - 1));
    tokens.push(Number.isInteger(index) ? index : 0);
  }
  return tokens;
}

/** Replaces the string at `path`; returns the original container untouched. */
function setStringAtPath<T>(root: T, path: string, value: string): T {
  const tokens = pathTokens(path);
  if (tokens.length === 0) return value as unknown as T;

  const clone = cloneContainer(root);
  if (clone === null || typeof clone !== 'object') return root;

  let cursor = clone as Record<string | number, unknown>;
  for (let i = 0; i < tokens.length - 1; i += 1) {
    const token = tokens[i];
    if (token === undefined) return root;
    const next = cursor[token];
    if (next === null || typeof next !== 'object') return root;
    cursor = next as Record<string | number, unknown>;
  }

  const last = tokens[tokens.length - 1];
  if (last === undefined) return root;
  cursor[last] = value;
  return clone as unknown as T;
}

function cloneContainer(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => cloneContainer(item));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = cloneContainer(item);
    }
    return out;
  }
  return value;
}

/** at-rest decrypt (§2) + optional blob restore (NFR-06) => a valid `TurnEvent`. */
function hydrateRow(
  db: Database,
  row: EventRow,
  options: RowToEventOptions,
): { base: TurnEvent; envelope: StoredEnvelope } {
  const json = db.decryptIfNeeded(row.payload_json);
  const envelope = JSON.parse(json) as StoredEnvelope;

  let payload: unknown = envelope.payload;
  if (typeof envelope.blobRef === 'string' && options.restoreBodies === true) {
    const read = options.blobReader;
    payload = read === undefined ? envelope.payload : JSON.parse(read(envelope.blobRef));
  }

  const restorer = options.restoreBodies === true ? options.restorer : undefined;
  if (restorer !== undefined) {
    const refs = db.driver.all<{ field: string }>(
      'SELECT field FROM blobs WHERE event_id = ? ORDER BY field',
      [row.id],
    );
    for (const { field } of refs) {
      const full = restorer(row.id, field);
      if (full !== undefined) payload = setStringAtPath(payload, field, full);
    }
  }

  const base = {
    eventId: row.id,
    seq: row.seq,
    sessionId: row.session_id,
    turnId: row.turn_id,
    ts: typeof envelope.ts === 'string' ? envelope.ts : row.created_at,
    type: row.type,
    source: envelope.source,
    payload,
  } as unknown as TurnEvent;

  return { base, envelope };
}

/**
 * The canonical read path. One row normally yields one event; a §8.2
 * coalesced window yields its N logical deltas, with the per-delta `seq` and
 * `text` restored, so a caller reading through here cannot tell a window from
 * N individual rows.
 *
 * A window whose text is not inline (an NFR-06 whole-payload blob read without
 * `restoreBodies`) cannot be split, and is therefore yielded as a single event
 * carrying the stored payload. `EventAdmissionPipeline` caps a window well
 * below `MAX_EVENT_PAYLOAD_BYTES` precisely so that never happens.
 */
export function rowToTurnEvents(
  db: Database,
  row: EventRow,
  options: RowToEventOptions = {},
): TurnEvent[] {
  const { base, envelope } = hydrateRow(db, row, options);
  const meta = envelope.coalesced;
  if (meta === undefined) return [base];

  const payload = base.payload as { text?: unknown } | null;
  const text = payload !== null && typeof payload === 'object' ? payload.text : undefined;
  if (typeof text !== 'string' || meta.lens.length !== meta.deltaCount) return [base];

  const out: TurnEvent[] = [];
  let offset = 0;
  for (let i = 0; i < meta.deltaCount; i += 1) {
    const length = meta.lens[i] ?? 0;
    out.push({
      ...base,
      // Derived, not stored: `#d<i>` keeps the id unique and stable so a
      // replay folds the same identity it did live (NFR-03).
      eventId: `${row.id}#d${i}`,
      seq: meta.firstSeq + i,
      payload: { ...(payload as object), text: text.slice(offset, offset + length) },
    } as unknown as TurnEvent);
    offset += length;
  }
  return out;
}
