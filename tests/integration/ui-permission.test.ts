/**
 * Integration: a UI-initiated git write through the permission gate.
 *
 * The Changes surface's 提交/丢弃 buttons go through `requestHighRiskPermission`
 * while no agent turn is running. The permission trail is turn-scoped by design
 * (events and permission_audit both reference turns), so the request gets a
 * real turn of its own. This is the test that fails if that turn stops being
 * real: the prompt event then fails the events foreign key, nothing reaches the
 * renderer, the invoke hangs out the full permission timeout, and the audit
 * records nothing — a gate that is silent instead of strict.
 *
 * Real SQLite file, real PermissionEngine, real AgentRuntimeManager admission.
 * No agent host: `requestPermission` never talks to one, so the required
 * `hostFactory` gets a stub that only fails if something actually calls it.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { Database, EventLog, MessageProjector, SessionSequencer } from '@ucad/storage';
import { SessionStore } from '@ucad/session';
import { PermissionEngine } from '@ucad/permissions';
import { BlobStore, silentLogger } from '@ucad/observability';
import { AgentRuntimeManager } from '@ucad/agent-core';
import type { TurnEvent } from '@ucad/contracts';

import { requestHighRiskPermission } from '../../apps/desktop/src/main/local-permission';

const permissionTimeoutMs = 5_000;

let dir: string;
let db: Database;
let sessionStore: SessionStore;
let permissions: PermissionEngine;
let runtime: AgentRuntimeManager;
const events: TurnEvent[] = [];
let sessionId = '';
const agentId = 'universal';

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucad-uiperm-'));
  const blobs = new BlobStore({ root: path.join(dir, 'blobs') });
  db = new Database({ dbPath: path.join(dir, 'ucad.db'), logger: silentLogger('uiperm') });
  db.migrate();
  const eventLog = new EventLog({ db, logger: silentLogger('uiperm'), blobs });
  const sequencer = new SessionSequencer(db);
  const projector = new MessageProjector(db);

  sessionStore = new SessionStore({ db, logger: silentLogger('uiperm'), eventLog, sequencer });
  permissions = new PermissionEngine({ db, logger: silentLogger('uiperm') });

  runtime = new AgentRuntimeManager({
    db,
    logger: silentLogger('uiperm'),
    eventLog,
    sequencer,
    sessionStore,
    permissions,
    blobs,
    hostFactory: () => {
      throw new Error('the host must not be needed for a UI permission request');
    },
    permissionTimeoutMs,
    onEvent: (event) => events.push(event),
    projector,
  });

  const workspace = sessionStore.upsertWorkspace({
    path: path.join(dir, 'workspace'),
    name: 'fixture',
    trustState: 'trusted',
  });
  sessionId = sessionStore.createSession({
    workspaceId: workspace.id,
    agentId,
    permissionMode: 'ask',
    title: 'ui-permission',
  }).id;
}, 30_000);

afterAll(() => {
  runtime?.dispose().catch(() => undefined);
  db?.close();
  fs.rmSync(dir, { recursive: true, force: true });
}, 30_000);

describe('a UI-initiated git write through the permission gate', () => {
  it('shows the prompt, records the decision, and closes its turn', async () => {
    let settled = false;
    const pending = requestHighRiskPermission(
      { sessionStore, runtime },
      sessionId,
      'commit: test message',
      ['commit:test message'],
    ).then((allowed) => {
      settled = true;
      return allowed;
    });

    // The prompt must be admitted — persisted and fanned out — while the invoke
    // is still waiting. This is the exact step the fabricated turn id broke.
    await vi.waitFor(async () => {
      expect(events.filter((e) => e.type === 'permission.requested').length).toBe(1);
    });

    expect(settled).toBe(false);
    const prompted = events.find((e) => e.type === 'permission.requested')!;
    expect(prompted.turnId).toMatch(/^turn_/);
    const requestId = (prompted.payload as { requestId: string }).requestId;
    expect(requestId).toMatch(/^perm_/);

    await runtime.respondToPermission(requestId, 'deny');
    expect(await pending).toBe(false);

    // The trail holds both halves, against a turn that exists.
    const row = permissions
      .listAudit(sessionId)
      .find((r) => r['requestId'] === requestId);
    expect(row).toBeDefined();
    expect(row!['decision']).toBe('deny');
    expect(row!['turnId']).toBe(prompted.turnId);

    const persistedTurnIds = db
      .driver
      .all<{ turn_id: string }>('SELECT DISTINCT turn_id FROM events', [])
      .map((r) => r.turn_id);
    expect(persistedTurnIds).toContain(prompted.turnId);

    // The operation's own turn is closed, not left PENDING forever.
    const own = sessionStore.listTurns(sessionId).find((t) => t.id === prompted.turnId);
    expect(own?.status).toBe('COMPLETED');
    expect(own?.objective).toBe('commit: test message');
  }, 30_000);

  it('records the turn as FAILED when the gate rejects by timeout', async () => {
    // No response ever comes; the gate must fail closed and the turn must not
    // linger as PENDING — the exact shape the old code left behind.
    const pending = requestHighRiskPermission(
      { sessionStore, runtime },
      sessionId,
      'discard: src/auth.ts',
      ['src/auth.ts'],
    );
    await expect(pending).rejects.toThrow(/not answered within/);

    const failed = sessionStore.listTurns(sessionId).find((t) => t.objective === 'discard: src/auth.ts');
    expect(failed?.status).toBe('FAILED');
  }, 30_000);

  it('gives two overlapping requests one prompt each instead of wedging the second', async () => {
    const first = requestHighRiskPermission(
      { sessionStore, runtime },
      sessionId,
      'commit: one',
      ['commit:one'],
    );
    const second = requestHighRiskPermission(
      { sessionStore, runtime },
      sessionId,
      'commit: two',
      ['commit:two'],
    );

    await vi.waitFor(async () => {
      const two = events.filter(
        (e) =>
          e.type === 'permission.requested' &&
          (e.payload as { request: { resource: string } }).request.resource === 'commit:two',
      );
      expect(two.length).toBe(1);
    });

    // Each request has its own id and its own turn; a collision would have
    // overwritten the first gate's pending entry.
    const prompts = events.filter((e) => e.type === 'permission.requested');
    const ids = prompts.map((e) => (e.payload as { requestId: string }).requestId);
    expect(new Set(ids).size).toBe(ids.length);

    for (const id of ids) {
      runtime.respondToPermission(id, 'deny').catch(() => undefined);
    }
    const [firstResult, secondResult] = await Promise.allSettled([first, second]);
    expect(firstResult.status).toBe('fulfilled');
    expect(secondResult.status).toBe('fulfilled');
  }, 30_000);
});
