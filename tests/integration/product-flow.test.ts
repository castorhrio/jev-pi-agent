/**
 * The product flow, driven end to end against real storage.
 *
 * §12.1 promises a Session Sidebar with 新建 / 切换 / 重命名 / 删除 / 恢复 / 导出 /
 * 状态. Every one of those is a promise to a user who will click it. A flow test
 * that only asserts the happy path of the *agent* proves nothing about whether the
 * product is usable — this file walks the sidebar and the workspace instead.
 *
 * The rule for this file: a step that a user can perform must either succeed or
 * fail with a reason the user can read. "Silently did nothing" is a failure.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Database, EventLog, MessageProjector, SessionSequencer } from '@ucad/storage';
import { BlobStore, silentLogger } from '@ucad/observability';
import { SessionStore } from '@ucad/session';
import type { SessionDto } from '@ucad/contracts';

describe('product flow: the session sidebar promises', () => {
  let dir: string;
  let db: Database;
  let blobs: BlobStore;
  let eventLog: EventLog;
  let sequencer: SessionSequencer;
  let projector: MessageProjector;
  let store: SessionStore;
  let workspaceId: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucad-flow-'));
    blobs = new BlobStore({ root: path.join(dir, 'blobs') });
    db = new Database({ dbPath: path.join(dir, 'ucad.db'), logger: silentLogger('flow') });
    db.migrate();
    eventLog = new EventLog({ db, logger: silentLogger('flow'), blobs });
    sequencer = new SessionSequencer(db);
    projector = new MessageProjector(db);
    store = new SessionStore({ db, logger: silentLogger('flow'), eventLog, sequencer });
    workspaceId = store.upsertWorkspace({ path: dir, name: 'flow', trustState: 'trusted' }).id;
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const newSession = (title: string): SessionDto =>
    store.createSession({ workspaceId, agentId: 'mock', permissionMode: 'ask', title });

  /** A session that actually did something: a turn with admitted events. */
  const usedSession = (): SessionDto => {
    const session = newSession('used');
    const { turnId } = store.beginTurn({ sessionId: session.id, objective: 'do a thing' });
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
    // §8.3: a turn that produced no assistant text gets no assistant row, so the
    // transcript has to actually contain a reply for the rebuild test to mean
    // anything.
    admit('text.delta', { messageId: 'msg_1', text: 'here is what I found' });
    admit('turn.completed', { status: 'completed', durationMs: 12, messageId: 'msg_1' });
    store.transitionTurn(turnId, 'COMPLETED');

    // The runtime feeds the projector per event; here the events are already
    // persisted, so the honest path is the §8.3 replay.
    projector.rebuildSession(session.id);
    return store.getSession(session.id)!;
  };

  it('creates a session the sidebar can list', () => {
    const created = newSession('first');
    expect(store.listSessions(workspaceId).map((s) => s.id)).toContain(created.id);
  });

  it('lists the most recently used session first (§12.1 切换)', () => {
    const a = newSession('a');
    const b = newSession('b');
    db.driver.run('UPDATE sessions SET updated_at = ? WHERE id = ?', ['2020-01-01T00:00:00.000Z', a.id]);
    db.driver.run('UPDATE sessions SET updated_at = ? WHERE id = ?', ['2030-01-01T00:00:00.000Z', b.id]);
    expect(store.listSessions(workspaceId)[0]!.id).toBe(b.id);
  });

  it('renames a session', () => {
    const s = newSession('before');
    store.renameSession(s.id, 'after');
    expect(store.getSession(s.id)!.title).toBe('after');
  });

  it('DELETES a session that has a real turn behind it', () => {
    // The blocker: `deleteSession` removes `turns` while `events.turn_id` and
    // `messages.turn_id` still point at it, and `PRAGMA foreign_keys = ON`.
    const session = usedSession();
    expect(store.listTurns(session.id).length).toBe(1);
    expect(db.driver.get<{ n: number }>('SELECT COUNT(*) AS n FROM events WHERE session_id = ?', [session.id])!.n).toBeGreaterThan(0);

    expect(() => store.deleteSession(session.id)).not.toThrow();
    expect(store.getSession(session.id)).toBeNull();
  });

  it('leaves no transcript behind after a delete', () => {
    const session = usedSession();
    store.deleteSession(session.id);

    for (const table of ['events', 'messages', 'turns', 'decisions', 'usage_records', 'agent_sessions']) {
      const row = db.driver.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE session_id = ?`, [
        session.id,
      ]);
      expect(row?.n ?? 0, `${table} still holds rows for a deleted session`).toBe(0);
    }
  });

  it('rebuilds messages by replaying events (§8.3: messages are pure derived data)', () => {
    const session = usedSession();
    const before = store.getMessages(session.id).length;
    expect(before).toBeGreaterThan(0);

    db.driver.run('DELETE FROM messages WHERE session_id = ?', [session.id]);
    expect(store.getMessages(session.id).length).toBe(0);

    projector.rebuildSession(session.id);
    expect(store.getMessages(session.id).length).toBe(before);
  });

  it('reports a missing session instead of crashing on a stale sidebar entry', () => {
    expect(() => store.renameSession('ses_does_not_exist', 'x')).toThrow();
    expect(() => store.deleteSession('ses_does_not_exist')).toThrow();
  });

  it('reopening a workspace reuses the same row (idempotent upsert, §8.1)', () => {
    const again = store.upsertWorkspace({ path: dir, name: 'renamed', trustState: 'untrusted' });
    expect(again.id).toBe(workspaceId);
    expect(store.listWorkspaces()).toHaveLength(1);
  });

  it('leaves a session INTERRUPTED after a crash so it can be resumed (§5.3)', () => {
    // A crash leaves the turn RUNNING in the database — nothing ever gets to
    // transition it. Recovery has to find it on the next start.
    const session = newSession('crashed');
    const { turnId } = store.beginTurn({ sessionId: session.id, objective: 'interrupted work' });
    store.transitionTurn(turnId, 'RUNNING');

    const recovered = store.recoverInterruptedTurns();
    expect(recovered.some((r) => r.sessionId === session.id)).toBe(true);
    expect(store.getSession(session.id)!.status).toBe('INTERRUPTED');
  });
});
