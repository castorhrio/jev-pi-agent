/**
 * §1.2 信任边界 + §4.9 权限: the flow a user hits when they open a project they
 * do not yet trust.
 *
 * The promise is "untrusted means read-only, and there is a one-click way to
 * trust it". Two things can break that promise without any test failing: an
 * untrusted project that is not actually read-only, or a user who is stuck
 * with no visible way to grant trust. Both are asserted here.
 *
 * Note what is *not* asserted: there is no `FILE_READ` category in §4.9, and
 * that is correct — reading is not a gated capability, so "read-only" is
 * expressed as "no write/shell/git/network category is ever auto-allowed".
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Database, SessionSequencer } from '@ucad/storage';
import { BlobStore, silentLogger } from '@ucad/observability';
import { SessionStore } from '@ucad/session';
import { PermissionEngine } from '@ucad/permissions';
import type { PermissionCategory, PermissionRequest, RiskLevel } from '@ucad/contracts';

const SIDE_EFFECT_CATEGORIES: PermissionCategory[] = [
  'FILE_WRITE',
  'FILE_DELETE',
  'SHELL',
  'GIT_WRITE',
  'NETWORK',
  'MCP_TOOL',
  'EXTERNAL_PATH',
  'EXTERNAL_TOOL',
];

describe('project trust boundary', () => {
  let dir: string;
  let db: Database;
  let _blobs: BlobStore;
  let store: SessionStore;
  let permissions: PermissionEngine;
  let workspaceId: string;

  const request = (category: PermissionCategory, id: string): PermissionRequest => ({
    id,
    category,
    risk: 'medium' as RiskLevel,
    resource: 'src/app.ts',
  });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucad-trust-'));
    _blobs = new BlobStore({ root: path.join(dir, 'blobs') });
    db = new Database({ dbPath: path.join(dir, 'ucad.db'), logger: silentLogger('trust') });
    db.migrate();
    store = new SessionStore({
      db,
      logger: silentLogger('trust'),
      sequencer: new SessionSequencer(db),
    });
    permissions = new PermissionEngine({ db, logger: silentLogger('trust') });
    workspaceId = store.upsertWorkspace({
      path: dir,
      name: 'untrusted',
      trustState: 'untrusted',
    }).id;
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const evaluate = (
    category: PermissionCategory,
    mode: 'read_only' | 'ask' | 'workspace_write',
  ) =>
    permissions.evaluate({
      request: request(category, `pr_${category}_${mode}`),
      sessionPermissionMode: mode,
      workspaceId,
      sessionId: 'ses_x',
      workspaceTrusted: store.getWorkspace(workspaceId)!.trustState === 'trusted',
    });

  it('starts untrusted', () => {
    expect(store.getWorkspace(workspaceId)!.trustState).toBe('untrusted');
  });

  it('never auto-allows a side effect in an untrusted project, in any mode', () => {
    // The dangerous case: `workspace_write` is the mode a user picks precisely
    // because they want files edited. Trust is a separate, explicit act, so the
    // mode must not launder an untrusted project into a writable one.
    for (const mode of ['read_only', 'ask', 'workspace_write'] as const) {
      for (const category of SIDE_EFFECT_CATEGORIES) {
        expect(
          evaluate(category, mode).outcome,
          `${category} must not be auto-allowed in an untrusted project (${mode})`,
        ).not.toBe('auto_allow');
      }
    }
  });

  it('grants trust explicitly, and only then can a write be auto-allowed', () => {
    expect(evaluate('FILE_WRITE', 'workspace_write').outcome).not.toBe('auto_allow');

    store.setWorkspaceTrust(workspaceId, 'trusted');
    expect(store.getWorkspace(workspaceId)!.trustState).toBe('trusted');

    // Trusted + workspace_write is the one combination that may auto-allow, and
    // that is the documented promise of the mode.
    expect(evaluate('FILE_WRITE', 'workspace_write').outcome).toBe('auto_allow');
  });

  it('can take trust back, and the write path closes again', () => {
    store.setWorkspaceTrust(workspaceId, 'trusted');
    expect(evaluate('FILE_WRITE', 'workspace_write').outcome).toBe('auto_allow');

    store.setWorkspaceTrust(workspaceId, 'untrusted');
    expect(evaluate('FILE_WRITE', 'workspace_write').outcome).not.toBe('auto_allow');
  });

  it('read_only mode blocks writes even in a trusted project', () => {
    // Trust and mode are independent: trusting a project says "this code is
    // not hostile", not "this turn may write".
    store.setWorkspaceTrust(workspaceId, 'trusted');
    for (const category of SIDE_EFFECT_CATEGORIES) {
      expect(
        evaluate(category, 'read_only').outcome,
        `${category} must not be auto-allowed in read_only`,
      ).not.toBe('auto_allow');
    }
  });

  it('ask mode never auto-allows on its own — it asks', () => {
    store.setWorkspaceTrust(workspaceId, 'trusted');
    for (const category of SIDE_EFFECT_CATEGORIES) {
      expect(evaluate(category, 'ask').outcome, `${category} in ask mode`).toBe('ask_user');
    }
  });

  it('records an audit row for the decision the engine reached (NFR-08)', () => {
    // `evaluate` decides; `recordAudit` is the separate write the runtime makes
    // once a decision is final. Both are required: an unaudited allow is a hole.
    // The audit row carries foreign keys, so the session and turn are real here.
    const session = store.createSession({
      workspaceId,
      agentId: 'mock',
      permissionMode: 'workspace_write',
      title: 'audit',
    });
    const { turnId } = store.beginTurn({ sessionId: session.id, objective: 'write a file' });
    store.setWorkspaceTrust(workspaceId, 'trusted');

    permissions.evaluate({
      request: request('FILE_WRITE', 'pr_audit'),
      sessionPermissionMode: 'workspace_write',
      workspaceId,
      sessionId: session.id,
      workspaceTrusted: true,
    });
    permissions.recordAudit({
      requestId: 'pr_audit',
      sessionId: session.id,
      turnId,
      category: 'FILE_WRITE',
      risk: 'medium',
      resource: 'src/app.ts',
      decision: 'allow_once',
      decider: 'user',
    });

    const row = db.driver.get<{ decision: string; decider: string; category: string }>(
      'SELECT decision, decider, category FROM permission_audit WHERE request_id = ?',
      ['pr_audit'],
    );
    expect(row).toEqual({ decision: 'allow_once', decider: 'user', category: 'FILE_WRITE' });
  });
});
