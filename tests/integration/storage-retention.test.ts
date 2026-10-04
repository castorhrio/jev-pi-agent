/**
 * §8.4 存储保护与保留 — retention window and cleanup, against real storage.
 *
 * The rule this file exists to hold: the product must not keep data without the
 * user's consent, and it must not claim it removed something it did not.
 * Everything here runs against a real `Database`, a real `SessionStore` and a
 * real `BlobStore` in a temp directory, and every assertion about a size or a
 * count is checked against the filesystem or a `COUNT(*)`.
 *
 * These tests are load-bearing. `RetentionService` deletes through
 * `SessionStore.deleteSession`, whose cascade must run children before parents
 * with `PRAGMA foreign_keys = ON`; if that order is broken, the delete throws a
 * foreign-key error, the purge surfaces it, and the tests below fail — they are
 * not a description of the behaviour, they are the thing that notices when it
 * stops happening.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Database, EventLog, MessageProjector, SessionSequencer } from '@ucad/storage';
import { BlobStore, silentLogger } from '@ucad/observability';
import { RetentionService, SessionStore } from '@ucad/session';
import type { SessionDto } from '@ucad/contracts';

/** §8.2: above this, the payload is offloaded to the blob directory. */
const OVERSIZE_TEXT_BYTES = 400 * 1024;

const MS_PER_DAY = 86_400_000;

function daysAgo(days: number): string {
  return new Date(Date.now() - days * MS_PER_DAY).toISOString();
}

describe('§8.4 storage retention and cleanup', () => {
  let dir: string;
  let blobDir: string;
  let dbPath: string;
  let db: Database;
  let blobs: BlobStore;
  let eventLog: EventLog;
  let sequencer: SessionSequencer;
  let projector: MessageProjector;
  let store: SessionStore;
  let retention: RetentionService;
  let workspaceId: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucad-retention-'));
    blobDir = path.join(dir, 'blobs');
    dbPath = path.join(dir, 'ucad.db');
    blobs = new BlobStore({ root: blobDir });
    db = new Database({ dbPath, logger: silentLogger('retention') });
    db.migrate();
    eventLog = new EventLog({ db, logger: silentLogger('retention'), blobs });
    sequencer = new SessionSequencer(db);
    projector = new MessageProjector(db);
    store = new SessionStore({ db, logger: silentLogger('retention'), eventLog, sequencer });
    retention = new RetentionService({
      db,
      sessionStore: store,
      blobs,
      logger: silentLogger('retention'),
      dbPath,
    });
    workspaceId = store.upsertWorkspace({ path: dir, name: 'retention', trustState: 'trusted' }).id;
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const newSession = (title: string): SessionDto =>
    store.createSession({ workspaceId, agentId: 'mock', permissionMode: 'ask', title });

  /**
   * A session that actually did something: a real turn, real admitted events
   * and a real transcript. `oversize: true` additionally emits a tool result
   * past §8.2's ceiling, so the storage layer really offloads it to the blob
   * directory and writes the `blobs` row — the cleanup has to reclaim that
   * file, not just the row.
   */
  const usedSession = (title: string, oversize = false): SessionDto => {
    const session = newSession(title);
    const { turnId } = store.beginTurn({ sessionId: session.id, objective: 'do a thing' });
    // `messages.id` is the messageId itself, so it is unique across the whole
    // database — a fixed id would collide as soon as a test builds two sessions.
    const messageId = `msg_${session.id}`;
    const admit = (type: string, payload: unknown) => {
      const res = eventLog.append({
        sessionId: session.id,
        turnId,
        seq: sequencer.next(session.id),
        proposal: {
          type: type as never,
          source: { kind: 'agent' },
          payload,
          ts: new Date().toISOString(),
        },
      });
      expect(res.ok, `admission rejected ${type}`).toBe(true);
    };

    admit('turn.started', { objective: 'do a thing' });
    store.transitionTurn(turnId, 'RUNNING');
    admit('text.delta', { messageId, text: 'here is what I found' });
    if (oversize) {
      admit('tool.started', { toolCallId: 'call_1', name: 'read', input: {}, origin: 'ucad' });
      admit('tool.completed', {
        toolCallId: 'call_1',
        status: 'ok',
        outputPreview: 'x'.repeat(OVERSIZE_TEXT_BYTES),
        durationMs: 3,
      });
    }
    admit('turn.completed', { status: 'completed', durationMs: 12, messageId });
    store.transitionTurn(turnId, 'COMPLETED');

    // The runtime feeds the projector per event; the events are already
    // persisted here, so the honest path is the §8.3 replay.
    projector.rebuildSession(session.id);
    return store.getSession(session.id)!;
  };

  /**
   * Ages a whole conversation: the session row, its turns, its events and its
   * transcript. The window is measured against the newest thing a session
   * produced, so moving only `sessions.updated_at` would leave it inside the
   * window — which is the correct behaviour, not a test convenience.
   */
  const age = (sessionId: string, days: number): void => {
    const at = daysAgo(days);
    db.driver.run('UPDATE sessions SET created_at = ?, updated_at = ? WHERE id = ?', [at, at, sessionId]);
    db.driver.run('UPDATE turns SET started_at = ?, completed_at = ? WHERE session_id = ?', [at, at, sessionId]);
    db.driver.run('UPDATE events SET created_at = ? WHERE session_id = ?', [at, sessionId]);
    db.driver.run('UPDATE messages SET created_at = ? WHERE session_id = ?', [at, sessionId]);
  };

  const setRetention = (days: number | null): void => {
    store.patchSettings({ storage: { retentionDays: days } });
  };

  const rowCount = (table: string, sessionId?: string): number => {
    const row =
      sessionId === undefined
        ? db.driver.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)
        : db.driver.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE session_id = ?`, [sessionId]);
    return row?.n ?? 0;
  };

  const allRowCounts = (): Record<string, number> => ({
    sessions: rowCount('sessions'),
    turns: rowCount('turns'),
    events: rowCount('events'),
    messages: rowCount('messages'),
    blobs: rowCount('blobs'),
  });

  const filesOnDisk = (): string[] => fs.readdirSync(blobDir).sort();

  const blobFile = (ref: string): string => path.join(blobDir, `${ref}.txt`);

  // =========================================================================
  // the window
  // =========================================================================

  it('keeps a session that is still inside the retention window', async () => {
    setRetention(90);
    const fresh = usedSession('fresh');
    age(fresh.id, 1);

    const result = await retention.purge('expired');

    expect(result.sessionsRemoved).toBe(0);
    expect(result.eventsRemoved).toBe(0);
    expect(store.getSession(fresh.id)).not.toBeNull();
    expect(rowCount('events', fresh.id)).toBeGreaterThan(0);
  });

  it('removes a session whose last activity is past the window', async () => {
    setRetention(90);
    const stale = usedSession('stale');
    const events = rowCount('events', stale.id);
    expect(events).toBeGreaterThan(0);
    age(stale.id, 120);

    const result = await retention.purge('expired');

    expect(result.scope).toBe('expired');
    expect(result.sessionsRemoved).toBe(1);
    expect(result.eventsRemoved).toBe(events);
    expect(store.getSession(stale.id)).toBeNull();
  });

  it('leaves no rows behind — the cascade runs children before parents', async () => {
    setRetention(90);
    const stale = usedSession('stale');
    expect(store.listTurns(stale.id).length).toBe(1);
    expect(store.getMessages(stale.id).length).toBeGreaterThan(0);
    age(stale.id, 120);

    // A broken delete order under `PRAGMA foreign_keys = ON` throws here, and
    // the purge turns that into a readable failure instead of a half-delete.
    await expect(retention.purge('expired')).resolves.toBeTruthy();

    for (const table of ['events', 'messages', 'turns', 'decisions', 'usage_records', 'agent_sessions']) {
      expect(rowCount(table, stale.id), `${table} still holds rows for a purged session`).toBe(0);
    }
    expect(rowCount('blobs')).toBe(0);
  });

  it('purges nothing when the user chose to keep everything forever', async () => {
    setRetention(null);
    const stale = usedSession('stale');
    age(stale.id, 900);

    const usage = await retention.usage();
    // "Forever" must report zero expired sessions, not every session: the
    // other reading is a lie the user would act on.
    expect(usage.retentionDays).toBeNull();
    expect(usage.expiredSessions).toBe(0);

    const result = await retention.purge('expired');
    expect(result.sessionsRemoved).toBe(0);
    expect(store.getSession(stale.id)).not.toBeNull();
  });

  it('applies the same window on demand', async () => {
    setRetention(30);
    const stale = usedSession('stale');
    age(stale.id, 45);

    const result = await retention.applyRetention();
    expect(result.sessionsRemoved).toBe(1);
    expect(store.getSession(stale.id)).toBeNull();
  });

  it('clears one project without touching the others', async () => {
    setRetention(null);
    const mine = usedSession('mine');
    const other = store.upsertWorkspace({ path: path.join(dir, 'other'), name: 'other' });
    const theirs = store.createSession({
      workspaceId: other.id,
      agentId: 'mock',
      permissionMode: 'ask',
      title: 'theirs',
    });

    const result = await retention.purge('workspace', workspaceId);

    expect(result.sessionsRemoved).toBe(1);
    expect(store.getSession(mine.id)).toBeNull();
    expect(store.getSession(theirs.id)).not.toBeNull();
  });

  it('clears every session for "all"', async () => {
    setRetention(null);
    usedSession('a');
    usedSession('b');

    const result = await retention.purge('all');
    expect(result.sessionsRemoved).toBe(2);
    expect(rowCount('sessions')).toBe(0);
  });

  it('refuses a project-scoped purge with no project, and says why', async () => {
    await expect(retention.purge('workspace')).rejects.toThrow(/project/i);
    await expect(retention.preview('workspace')).rejects.toThrow(/project/i);
  });

  it('a parent-first delete fails, which is why the cascade order matters', () => {
    const session = usedSession('stale');
    // `PRAGMA foreign_keys = ON` is what makes the delete order load-bearing:
    // removing `turns` while `events` and `messages` still point at it is the
    // bug a wrong cascade would reintroduce, and it has to fail loudly.
    expect(() =>
      db.driver.run('DELETE FROM turns WHERE session_id = ?', [session.id]),
    ).toThrow();
    expect(store.getSession(session.id)).not.toBeNull();
  });

  // =========================================================================
  // the blob directory (§8.4 "必须同时清理 blob 目录")
  // =========================================================================

  it('unlinks the blob files a purged session owned, and reclaims their bytes', async () => {
    setRetention(90);
    const heavy = usedSession('heavy', true);
    const rows = db.driver.all<{ ref: string }>('SELECT ref FROM blobs');
    expect(rows.length).toBe(1);
    const ref = rows[0]!.ref;
    const file = blobFile(ref);
    const sizeBefore = fs.statSync(file).size;
    expect(sizeBefore).toBeGreaterThan(0);
    age(heavy.id, 120);

    const result = await retention.purge('expired');

    expect(result.blobFilesRemoved).toBe(1);
    expect(fs.existsSync(file), 'the blob file outlived the rows that named it').toBe(false);
    expect(filesOnDisk()).toEqual([]);
    expect(result.bytesReclaimed).toBeGreaterThan(0);
    // The number is measured, not a ratio of the payload size.
    expect(result.bytesReclaimed).toBeGreaterThanOrEqual(sizeBefore);
    expect(rowCount('blobs')).toBe(0);
  });

  it('collects orphan blob files and drops the rows that point at nothing', async () => {
    const orphan = blobs.put('tool output nobody references');
    const orphanFile = blobFile(orphan);
    expect(fs.existsSync(orphanFile)).toBe(true);

    // A row whose file is gone is the other half of the same leak.
    const session = usedSession('dangling');
    const eventId = db.driver.get<{ id: string }>(
      'SELECT id FROM events WHERE session_id = ? ORDER BY seq ASC LIMIT 1',
      [session.id],
    )!.id;
    db.driver.run(
      'INSERT INTO blobs(event_id, field, ref, bytes, created_at) VALUES(?, ?, ?, ?, ?)',
      [eventId, 'output', 'blob_missing_file', 12, new Date().toISOString()],
    );
    expect(rowCount('blobs')).toBe(1);

    const result = await retention.collectOrphanBlobs();

    expect(result.removed).toBe(1);
    expect(result.bytes).toBeGreaterThan(0);
    expect(fs.existsSync(orphanFile)).toBe(false);
    expect(rowCount('blobs'), 'a row survived with no file behind it').toBe(0);
  });

  it('collecting orphans twice reports zeros the second time', async () => {
    blobs.put('first leak');
    const first = await retention.collectOrphanBlobs();
    expect(first.removed).toBe(1);

    const second = await retention.collectOrphanBlobs();
    expect(second.removed).toBe(0);
    expect(second.bytes).toBe(0);
  });

  // =========================================================================
  // preview (§8.4: preview before an irreversible delete)
  // =========================================================================

  it('previews exactly what a purge would remove, and removes nothing', async () => {
    setRetention(90);
    const stale = usedSession('stale', true);
    const fresh = usedSession('fresh');
    age(stale.id, 120);

    const before = allRowCounts();
    const files = filesOnDisk();
    const expired = await retention.preview('expired');

    expect(allRowCounts()).toEqual(before);
    expect(filesOnDisk()).toEqual(files);
    expect(store.getSession(stale.id)).not.toBeNull();
    expect(store.getSession(fresh.id)).not.toBeNull();

    // The preview is a promise about the numbers, so it has to match the purge.
    expect(expired.sessions).toBe(1);
    expect(expired.events).toBe(before.events - rowCount('events', fresh.id));
    expect(expired.messages).toBe(before.messages - rowCount('messages', fresh.id));
    expect(expired.blobFiles).toBe(1);
    expect(expired.blobBytes).toBeGreaterThan(0);

    const result = await retention.purge('expired');
    expect(result.sessionsRemoved).toBe(expired.sessions);
    expect(result.eventsRemoved).toBe(expired.events);
    expect(result.blobFilesRemoved).toBe(expired.blobFiles);
  });

  it('previews the "all" scope without touching anything', async () => {
    usedSession('a');
    usedSession('b');
    const before = allRowCounts();

    const preview = await retention.preview('all');

    expect(preview.sessions).toBe(2);
    expect(allRowCounts()).toEqual(before);
  });

  // =========================================================================
  // usage
  // =========================================================================

  it('reports real on-disk sizes and row counts', async () => {
    const session = usedSession('measured', true);
    const usage = await retention.usage();

    expect(usage.dbBytes).toBe(fs.statSync(dbPath).size);
    expect(usage.dbBytes).toBeGreaterThan(0);
    expect(usage.blobBytes).toBeGreaterThan(0);
    expect(usage.blobBytes).toBe(blobs.totalBytes());
    expect(usage.sessions).toBe(1);
    expect(usage.turns).toBe(1);
    expect(usage.events).toBe(rowCount('events', session.id));
    expect(usage.messages).toBeGreaterThan(0);
    expect(usage.blobFiles).toBe(1);
    expect(usage.retentionDays).toBe(90);
    expect(usage.expiredSessions).toBe(0);
  });

  it('counts a session as expired only once it is past the window', async () => {
    setRetention(90);
    const stale = usedSession('stale');
    age(stale.id, 91);
    const fresh = usedSession('fresh');
    age(fresh.id, 89);

    const usage = await retention.usage();
    expect(usage.expiredSessions).toBe(1);

    const result = await retention.purge('expired');
    expect(result.sessionsRemoved).toBe(1);
    expect(store.getSession(stale.id)).toBeNull();
    expect(store.getSession(fresh.id)).not.toBeNull();
  });

  // =========================================================================
  // nothing to purge
  // =========================================================================

  it('a purge with nothing to purge reports zeros and does not throw', async () => {
    setRetention(90);
    const usage = await retention.usage();
    expect(usage.sessions).toBe(0);

    await expect(retention.purge('expired')).resolves.toEqual({
      scope: 'expired',
      sessionsRemoved: 0,
      eventsRemoved: 0,
      blobFilesRemoved: 0,
      bytesReclaimed: 0,
    });
    await expect(retention.purge('all')).resolves.toMatchObject({ sessionsRemoved: 0 });
    await expect(retention.purge('workspace', workspaceId)).resolves.toMatchObject({
      sessionsRemoved: 0,
    });
  });

  it('a second purge of the same scope is a no-op, not an error', async () => {
    setRetention(90);
    const stale = usedSession('stale');
    age(stale.id, 120);

    const first = await retention.purge('expired');
    expect(first.sessionsRemoved).toBe(1);

    const second = await retention.purge('expired');
    expect(second.sessionsRemoved).toBe(0);
    expect(second.bytesReclaimed).toBe(0);
  });
});
