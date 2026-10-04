/**
 * Handoff chain: supersede-not-delete, and the open/claimed/done handshake.
 *
 * RESEARCH §2 (ai-memory) makes two claims worth enforcing rather than
 * believing:
 *
 *  1. **supersede-not-delete** — "记忆丢了 = 不可逆数据损失". Before the
 *     `handoffs` table, a handoff lived only in `sessions.handoff_json`, so
 *     asking for a new one overwrote the old one. The event log remained the
 *     authority and nothing was destroyed *semantically*, but the artefact a
 *     user or a second agent would actually open was gone.
 *
 *  2. **handoff 是有类型、有归属、只被认领一次的协议** — without an explicit
 *     claim, two agents resuming one session each assume the work is theirs.
 *
 * These tests are about **storage behaviour**, so they run against a real
 * SQLite file rather than a mock: a chain that only holds in a fake store is
 * not a chain.
 */

import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { Database, EventLog, SessionSequencer } from '@ucad/storage';
import { BlobStore, silentLogger } from '@ucad/observability';
import { SessionStore } from '@ucad/session';
import { isContextHandoff } from '@ucad/contracts';

let dir: string;
let db: Database;
let store: SessionStore;
let workspaceId: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucad-handoff-'));
  db = new Database({ dbPath: path.join(dir, 'ucad.db'), logger: silentLogger('test') });
  db.migrate();
  const blobs = new BlobStore({ root: path.join(dir, 'blobs') });
  const eventLog = new EventLog({ db, logger: silentLogger('test'), blobs });
  const sequencer = new SessionSequencer(db);
  store = new SessionStore({
    db,
    eventLog,
    sequencer,
    logger: silentLogger('test'),
  });
  workspaceId = store.upsertWorkspace({ path: dir, name: 'w' }).id;
});

afterAll(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function newSession(title: string): string {
  return store.createSession({
    workspaceId,
    agentId: 'agent_a',
    permissionMode: 'ask',
    title,
  }).id;
}

describe('handoff chain / supersede-not-delete', () => {
  it('records the first handoff with nothing to supersede', () => {
    const sessionId = newSession('one');
    store.createHandoff(sessionId);

    const chain = store.listHandoffs(sessionId);
    expect(chain).toHaveLength(1);
    expect(chain[0]!.sequence).toBe(1);
    expect(chain[0]!.supersedes).toBeNull();
    // The newest entry has nothing pointing past it yet.
    expect(chain[0]!.supersededBy).toBeNull();
    expect(chain[0]!.state).toBe('open');
  });

  it('returns an empty chain, not an error, for a session with no handoff yet', () => {
    const sessionId = newSession('fresh');
    expect(store.listHandoffs(sessionId)).toEqual([]);
    expect(store.latestHandoff(sessionId)).toBeNull();
  });

  it('does not append when the replay is unchanged, so the chain records transitions', () => {
    const sessionId = newSession('idle');
    store.createHandoff(sessionId);
    store.createHandoff(sessionId);
    store.createHandoff(sessionId);

    // Three identical handoffs describe one state. Appending all three would
    // bury the single entry that actually changed in a wall of noise.
    expect(store.listHandoffs(sessionId)).toHaveLength(1);
  });

  it('keeps the earlier handoff readable after a newer one supersedes it', () => {
    const sessionId = newSession('two');
    store.createHandoff(sessionId);
    const first = store.listHandoffs(sessionId)[0]!;

    // A second handoff with the same events would be a no-op, so change the
    // session state the replay reads.
    store.renameSession(sessionId, 'renamed');
    store.createHandoff(sessionId);

    const chain = store.listHandoffs(sessionId);
    expect(chain).toHaveLength(2);

    const [newest, older] = chain;
    expect(newest!.sequence).toBe(2);
    expect(newest!.supersedes).toBe(first.id);

    // The point of the whole exercise: the superseded entry is still here,
    // still carries its own body, and knows what replaced it.
    expect(older!.id).toBe(first.id);
    expect(older!.supersededBy).toBe(newest!.id);
    expect(older!.handoff.schemaVersion).toBe(2);
    expect(older!.handoff).not.toEqual(newest!.handoff);
  });

  it('links every entry into a single chain with no gaps or forks', () => {
    const sessionId = newSession('chain');
    store.createHandoff(sessionId);
    for (let i = 0; i < 3; i += 1) {
      store.renameSession(sessionId, `rev-${i}`);
      store.createHandoff(sessionId);
    }

    const chain = store.listHandoffs(sessionId);
    expect(chain).toHaveLength(4);
    // Newest first, contiguous sequences.
    expect(chain.map((r) => r.sequence)).toEqual([4, 3, 2, 1]);
    // Each entry points at the next older one, and the root points nowhere.
    expect(chain[0]!.supersedes).toBe(chain[1]!.id);
    expect(chain[1]!.supersedes).toBe(chain[2]!.id);
    expect(chain[2]!.supersedes).toBe(chain[3]!.id);
    expect(chain[3]!.supersedes).toBeNull();
    // Only the newest is un-superseded.
    expect(chain.filter((r) => r.supersededBy === null)).toHaveLength(1);
    expect(store.latestHandoff(sessionId)!.id).toBe(chain[0]!.id);
  });

  it('never rewrites an earlier body when a newer handoff is written', () => {
    const sessionId = newSession('immutable');
    store.createHandoff(sessionId);
    const firstBody = JSON.stringify(store.listHandoffs(sessionId)[0]!.handoff);

    store.renameSession(sessionId, 'moved on');
    store.createHandoff(sessionId);
    store.renameSession(sessionId, 'moved further');
    store.createHandoff(sessionId);

    // Re-read the oldest entry from storage: its body must be byte-identical
    // to what it was. This is the "no destructive rewrite" half of the rule.
    const oldest = store.listHandoffs(sessionId).at(-1)!;
    expect(JSON.stringify(oldest.handoff)).toBe(firstBody);
  });

  it('keeps chains of different sessions independent', () => {
    const a = newSession('a');
    const b = newSession('b');
    store.createHandoff(a);
    store.createHandoff(b);
    store.renameSession(a, 'a2');
    store.createHandoff(a);

    expect(store.listHandoffs(a)).toHaveLength(2);
    expect(store.listHandoffs(b)).toHaveLength(1);
  });

  it('refuses to read a handoff through the wrong session', () => {
    const a = newSession('a');
    const b = newSession('b');
    store.createHandoff(a);
    const record = store.listHandoffs(a)[0]!;

    // Otherwise an agent holding one session's id could claim another's work.
    expect(() => store.claimHandoff(b, record.id, 'agent_x')).toThrow(/no handoff/);
  });
});

describe('handoff claim handshake (open / claimed / done)', () => {
  it('starts open and moves forward only', () => {
    const sessionId = newSession('claim');
    store.createHandoff(sessionId);
    const id = store.latestHandoff(sessionId)!.id;

    const claimed = store.claimHandoff(sessionId, id, 'agent_a');
    expect(claimed.state).toBe('claimed');
    expect(claimed.claimedBy).toBe('agent_a');
    expect(claimed.claimedAt).toBeTruthy();
    expect(claimed.completedAt).toBeNull();

    const done = store.completeHandoff(sessionId, id);
    expect(done.state).toBe('done');
    expect(done.completedAt).toBeTruthy();
    // The claim is a record of who did the work, so it survives completion.
    expect(done.claimedBy).toBe('agent_a');
  });

  it('refuses a second agent — this is the case the handshake exists for', () => {
    const sessionId = newSession('contested');
    store.createHandoff(sessionId);
    const id = store.latestHandoff(sessionId)!.id;

    store.claimHandoff(sessionId, id, 'agent_a');
    expect(() => store.claimHandoff(sessionId, id, 'agent_b')).toThrow(
      /already claimed by agent_a/,
    );

    // And the claim did not move as a side effect of the refused attempt.
    expect(store.latestHandoff(sessionId)!.claimedBy).toBe('agent_a');
  });

  it('is idempotent for the same agent, so a retry does not self-conflict', () => {
    const sessionId = newSession('retry');
    store.createHandoff(sessionId);
    const id = store.latestHandoff(sessionId)!.id;

    const first = store.claimHandoff(sessionId, id, 'agent_a');
    const again = store.claimHandoff(sessionId, id, 'agent_a');
    expect(again.state).toBe('claimed');
    expect(again.claimedAt).toBe(first.claimedAt);
  });

  it('refuses to complete a handoff nobody claimed', () => {
    const sessionId = newSession('unclaimed');
    store.createHandoff(sessionId);
    const id = store.latestHandoff(sessionId)!.id;

    // Otherwise "done" is just a claim with extra steps and no owner.
    expect(() => store.completeHandoff(sessionId, id)).toThrow(/must be claimed/);
  });

  it('refuses to claim a completed handoff', () => {
    const sessionId = newSession('finished');
    store.createHandoff(sessionId);
    const id = store.latestHandoff(sessionId)!.id;
    store.claimHandoff(sessionId, id, 'agent_a');
    store.completeHandoff(sessionId, id);

    expect(() => store.claimHandoff(sessionId, id, 'agent_b')).toThrow(/already done/);
  });

  it('completing twice is a no-op rather than an error', () => {
    const sessionId = newSession('twice');
    store.createHandoff(sessionId);
    const id = store.latestHandoff(sessionId)!.id;
    store.claimHandoff(sessionId, id, 'agent_a');

    const first = store.completeHandoff(sessionId, id);
    const second = store.completeHandoff(sessionId, id);
    expect(second.completedAt).toBe(first.completedAt);
  });

  it('does not leak claim state onto a handoff that supersedes it', () => {
    const sessionId = newSession('carry');
    store.createHandoff(sessionId);
    const first = store.latestHandoff(sessionId)!.id;
    store.claimHandoff(sessionId, first, 'agent_a');
    store.completeHandoff(sessionId, first);

    store.renameSession(sessionId, 'next round');
    store.createHandoff(sessionId);
    const second = store.latestHandoff(sessionId)!;

    // The new work starts open. Carrying the old claim forward would tell the
    // next agent the work is already owned by someone who finished it.
    expect(second.state).toBe('open');
    expect(second.claimedBy).toBeNull();
    expect(second.supersedes).toBe(first);
  });
});

describe('isContextHandoff — the read boundary', () => {
  // A handoff row was written by whatever Main version stored it. The type
  // assertion `JSON.parse(body) as ContextHandoff` proves nothing; this guard
  // is what stands between a stored body and every consumer downstream.
  it('accepts a record the store itself produced', () => {
    const sessionId = newSession('valid');
    store.createHandoff(sessionId);
    const handoff = store.listHandoffs(sessionId)[0]!.handoff;
    expect(isContextHandoff(handoff)).toBe(true);
  });

  it('rejects a v1-shaped body, a half-filled object, and non-objects', () => {
    // A plausible past: same idea, older fields.
    expect(isContextHandoff({ schemaVersion: 1, objective: 'old shape' })).toBe(false);
    // Parses fine, claims the current version, is not a handoff.
    expect(isContextHandoff({ schemaVersion: 2, objective: 'only the objective' })).toBe(false);
    expect(isContextHandoff({ schemaVersion: 2, objective: 7 })).toBe(false);
    expect(isContextHandoff(null)).toBe(false);
    expect(isContextHandoff('a handoff-shaped string')).toBe(false);
    expect(isContextHandoff([])).toBe(false);
  });
});

describe('a stored handoff body that parses but is not a ContextHandoff', () => {
  it('is surfaced as empty rather than masquerading as a handoff', () => {
    const sessionId = newSession('corrupt');
    store.createHandoff(sessionId);
    const record = store.listHandoffs(sessionId)[0]!;

    // Overwrite the stored body with valid JSON of the wrong shape — exactly
    // what an older schema version would have left behind.
    db.driver.run('UPDATE handoffs SET body_json = ? WHERE id = ?', [
      JSON.stringify({ schemaVersion: 1, objective: 'written by an older build' }),
      record.id,
    ]);

    const surfaced = store.listHandoffs(sessionId)[0]!;
    // The record itself survives (the chain, the claim state, the identity);
    // only the body is not trusted.
    expect(surfaced.id).toBe(record.id);
    expect(surfaced.handoff.schemaVersion).toBe(2);
    expect(surfaced.handoff.objective).toBe('');
    expect(surfaced.handoff.decisions).toEqual([]);
  });
});
