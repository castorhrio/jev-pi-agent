/**
 * §5.2 seq rules + §4.3 recovery.
 *
 * `seq` is the backbone of replay, ordering and gap detection. A hole or a
 * duplicate in a session's sequence silently corrupts the Renderer state, the
 * `messages` projection and the audit trail at once, so these invariants are
 * tested directly against a real database.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Database, EventLog, SessionSequencer, MessageProjector } from '@ucad/storage';
import { BlobStore, silentLogger, ulid } from '@ucad/observability';
import { MAX_EVENT_PAYLOAD_BYTES, type EventSource, type TurnEvent } from '@ucad/contracts';

let dir: string;
let db: Database;
let log: EventLog;
let seq: SessionSequencer;
let projector: MessageProjector;
let sessionId: string;

const source: EventSource = { kind: 'ucad' };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucad-seq-'));
  db = new Database({
    dbPath: path.join(dir, 'ucad.db'),
    logger: silentLogger('test'),
  });
  db.migrate();
  const blobs = new BlobStore({ root: path.join(dir, 'blobs') });
  log = new EventLog({ db, logger: silentLogger('test'), blobs });
  seq = new SessionSequencer(db);
  projector = new MessageProjector(db);

  sessionId = ulid('ses_');
  // `sessions.workspace_id`, `events.turn_id` and `messages.turn_id` are real
  // foreign keys, so the parent rows have to exist before any event is written.
  // This test is about seq and admission, not about the FK graph.
  db.driver.run(
    `INSERT INTO workspaces (id, path, name, trust_state, created_at, last_opened_at)
     VALUES ('ws_1', ?, 'fixture', 'trusted', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    [dir.replace(/\\/g, '/')],
  );
  db.driver.run(
    `INSERT INTO sessions (id, workspace_id, title, agent_id, status, created_at, updated_at)
     VALUES (?, ?, 't', 'mock', 'READY', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    [sessionId, 'ws_1'],
  );
  db.driver.run(
    `INSERT INTO turns (id, session_id, status, started_at)
     VALUES ('turn_1', ?, 'RUNNING', '2026-01-01T00:00:00.000Z')`,
    [sessionId],
  );
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function append(
  type: string,
  payload: unknown,
  opts: { sessionId?: string; seq?: number } = {},
): { ok: boolean; event?: TurnEvent; rejectedReason?: string } {
  const target = opts.sessionId ?? sessionId;
  return log.append({
    sessionId: target,
    turnId: 'turn_1',
    seq: opts.seq ?? seq.next(target),
    proposal: { type: type as never, source, payload, ts: '2026-01-01T00:00:00.000Z' },
  });
}

describe('SessionSequencer / §5.2', () => {
  it('allocates a strictly increasing sequence with no gaps', () => {
    const a = seq.next(sessionId);
    const b = seq.next(sessionId);
    const c = seq.next(sessionId);

    expect([a, b, c]).toEqual([a, a + 1, a + 2]);
  });

  it('keeps an independent sequence per session (SEQ-3)', () => {
    const other = ulid('ses_');
    db.driver.run(
      `INSERT INTO sessions (id, workspace_id, title, agent_id, status, created_at, updated_at)
       VALUES (?, 'ws_1', 't', 'mock', 'READY', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      [other],
    );
    const a1 = seq.next(sessionId);
    const b1 = seq.next(other);
    const a2 = seq.next(sessionId);

    expect(b1).toBe(1);
    expect(a1).toBe(1);
    expect(a2).toBe(2);
  });

  it('resyncs from the persisted maximum after a simulated restart', async () => {
    // seqs are only recoverable from what was actually persisted, so write
    // three events rather than merely allocating three numbers
    for (let i = 0; i < 3; i++) {
      append('text.delta', { text: `t${i}`, messageId: 'm1' });
    }
    const last = await seq.latest(sessionId);
    expect(last).toBe(3);

    // a fresh sequencer has no in-memory state and must recover from the DB
    const revived = new SessionSequencer(db);
    await revived.resync(sessionId);
    expect(revived.next(sessionId)).toBe(4);
  });

  it('a seq allocated but never persisted does not resurrect after resync', async () => {
    seq.next(sessionId); // -> 1, allocated then dropped
    append('text.delta', { text: 'only', messageId: 'm1' }); // -> 2, persisted

    const revived = new SessionSequencer(db);
    await revived.resync(sessionId);
    // resync reads the persisted max (2), so the next seq is 3. Seq 1 stays
    // burned: reusing it would let two different events share a sequence value.
    expect(revived.next(sessionId)).toBe(3);
  });

  it('latest() reports the highest persisted seq', async () => {
    append('turn.started', { objective: 'hello' });
    append('turn.started', { objective: 'hello again' });

    expect(await seq.latest(sessionId)).toBe(2);
  });
});

describe('EventLog admission / SEQ-6', () => {
  it('rejects a payload that does not match its declared type and writes nothing', () => {
    const before = log.latestSeq(sessionId);
    const result = append('turn.started', { objective: 12345, extra: true });

    expect(result.ok).toBe(false);
    expect(result.rejectedReason).toBeTruthy();
    expect(log.latestSeq(sessionId)).toBe(before);
    expect(log.since({ sessionId, afterSeq: 0 })).toHaveLength(0);
  });

  it('accepts a valid payload and persists it', () => {
    const result = append('turn.started', { objective: 'do the thing' });

    expect(result.ok).toBe(true);
    expect(result.event?.seq).toBe(1);
    expect(result.event?.eventId).toMatch(/^ev_/);
    expect(log.since({ sessionId, afterSeq: 0 })).toHaveLength(1);
  });

  it('rejects an unknown event type', () => {
    const result = append('not.a.real.event', {});
    expect(result.ok).toBe(false);
  });

  it('since() returns events strictly after the cursor, ascending', () => {
    append('turn.started', { objective: 'a' });
    append('text.delta', { text: 'b', messageId: 'm1' });
    append('text.delta', { text: 'c', messageId: 'm1' });
    append('turn.completed', { status: 'completed', durationMs: 5 });

    const page = log.since({ sessionId, afterSeq: 1 });
    expect(page.map((e) => e.seq)).toEqual([2, 3, 4]);
    expect(page.map((e) => e.type)).toEqual([
      'text.delta',
      'text.delta',
      'turn.completed',
    ]);
  });

  it('since() honours a limit', () => {
    for (let i = 0; i < 5; i++) append('text.delta', { text: `t${i}`, messageId: 'm1' });
    expect(log.since({ sessionId, afterSeq: 0, limit: 2 })).toHaveLength(2);
  });

  it('rejects a duplicate seq rather than silently overwriting (SEQ-2 uniqueness)', () => {
    append('turn.started', { objective: 'a' }, { seq: 1 });
    let duplicate: { ok: boolean; rejectedReason?: string };
    try {
      duplicate = log.append({
        sessionId,
        turnId: 'turn_1',
        seq: 1,
        proposal: {
          type: 'text.delta' as never,
          source,
          payload: { text: 'dup', messageId: 'm1' },
          ts: '2026-01-01T00:00:00.000Z',
        },
      });
    } catch {
      // rejecting loudly is acceptable; silently succeeding is not
      duplicate = { ok: false, rejectedReason: 'UNIQUE violation' };
    }
    expect(duplicate.ok).toBe(false);
    // and the original row is untouched
    expect(log.since({ sessionId, afterSeq: 0 })).toHaveLength(1);
  });

  it('offloads an oversized payload to blob storage and keeps a preview (NFR-06)', () => {
    const huge = 'x'.repeat(300 * 1024);
    const result = append('tool.completed', {
      toolCallId: 'tc_1',
      status: 'ok',
      outputPreview: huge,
      durationMs: 1,
    });

    expect(result.ok).toBe(true);
    const stored = log.since({ sessionId, afterSeq: 0 })[0] as never as {
      payload: { outputRef?: string; outputPreview: string };
    };
    const preview = stored.payload.outputPreview;
    const ref = stored.payload.outputRef;
    if (ref) {
      // offloaded: the inline text is bounded and the body is retrievable
      expect(Buffer.byteLength(preview, 'utf8')).toBeLessThan(
        MAX_EVENT_PAYLOAD_BYTES,
      );
      expect(preview).not.toBe(huge);
    } else {
      // not offloaded, but still must not exceed the ceiling
      expect(Buffer.byteLength(preview, 'utf8')).toBeLessThanOrEqual(
        MAX_EVENT_PAYLOAD_BYTES,
      );
    }
  });
});

describe('MessageProjector / §8.3', () => {
  /** `messages` stores `content_json` (§8.1); the DTO puts it in `text`. */
  function messageRows(): Array<{ text: string; role: string }> {
    return db.driver
      .all<{ content_json: string; role: string }>(
        'SELECT content_json, role FROM messages WHERE session_id = ? ORDER BY created_at, id',
        [sessionId],
      )
      .map((row) => {
        const parsed = JSON.parse(row.content_json) as { text?: string };
        return { text: parsed.text ?? '', role: row.role };
      });
  }

  it('accumulates text deltas into one assistant message', async () => {
    append('turn.started', { objective: 'a' });
    append('text.delta', { text: 'Hello ', messageId: 'm1' });
    append('text.delta', { text: 'world', messageId: 'm1' });
    const events = log.since({ sessionId, afterSeq: 0 });
    await projector.apply(events[1]!);
    await projector.apply(events[2]!);

    const messages = messageRows();
    expect(messages).toHaveLength(1);
    expect(messages[0]?.text).toBe('Hello world');
  });

  it('rebuilds the projection from events alone', async () => {
    append('turn.started', { objective: 'a' });
    append('text.delta', { text: 'x', messageId: 'm1' });
    append('text.delta', { text: 'y', messageId: 'm1' });
    append('turn.completed', { status: 'completed', durationMs: 3 });

    await projector.rebuildSession(sessionId);

    const rows = messageRows();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.map((r) => r.text).join('')).toContain('xy');
  });

  it('is idempotent enough that a replay does not double the text', async () => {
    append('text.delta', { text: 'once', messageId: 'm1' });
    const event = log.since({ sessionId, afterSeq: 0 })[0]!;

    await projector.apply(event);
    await projector.rebuildSession(sessionId);

    const joined = messageRows()
      .map((r) => r.text)
      .join('');
    expect(joined.match(/once/g)?.length ?? 0).toBe(1);
  });
});

describe('schema_version / NFR-07', () => {
  it('reports a migrated version and is safe to re-run', () => {
    expect(db.schemaVersion).toBeGreaterThan(0);
    const again = db.migrate();
    expect(again.applied).toHaveLength(0);
    expect(again.to).toBe(db.schemaVersion);
  });

  it('refuses to open a newer schema than it understands', () => {
    db.driver.run(
      'UPDATE schema_version SET version = ? WHERE version = (SELECT MAX(version) FROM schema_version)',
      [db.schemaVersion + 99],
    );
    const reopened = new Database({
      dbPath: path.join(dir, 'ucad.db'),
      logger: silentLogger('test'),
    });
    expect(() => reopened.migrate()).toThrow();
    reopened.close();
  });
});
