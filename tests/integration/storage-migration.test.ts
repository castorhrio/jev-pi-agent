/**
 * NFR-07 — a schema change is a product event, not a detail.
 *
 * Adding `mcp_servers.env_json` is the first migration in this project that
 * changes an existing table rather than creating a new one, which makes it the
 * first one where "it exited 0" and "the user's configuration survived" are two
 * different claims. So the tests here assert the second one:
 *
 *  - a file written by the *previous* build is opened, migrated forward, and
 *    every row it already had is still there, field for field;
 *  - the new column arrives nullable, so a row without an environment reads
 *    back as "none stored" rather than as an empty one (NFR-15);
 *  - re-running the migration applies nothing and changes nothing;
 *  - and the code refuses to run against a schema that never got the column,
 *    with a reason, instead of quietly behaving as if no environment existed.
 *
 * The database is real: `node-sqlite3-wasm` on a file in a temp directory, the
 * same path `product-flow.test.ts` takes. A migration proved against a stub
 * proves nothing about the version guard that protects it.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Database } from '@ucad/storage';
import { McpManager } from '@ucad/mcp';
import { silentLogger, nowIso } from '@ucad/observability';
// From source, so the test does not depend on a build having happened first.
import {
  MIGRATIONS,
  SCHEMA_VERSION_TABLE_SQL,
  TARGET_SCHEMA_VERSION,
} from '../../packages/storage/src/migrations';

/** The version that shipped before `mcp_servers.env_json` existed. */
const PREVIOUS_VERSION = 2;
/** The version that adds it. */
const ENV_VERSION = 3;

const LEGACY_SERVER = {
  id: 'mcp_legacy',
  name: 'legacy-ix',
  command: 'ucad-ix',
  args: ['--stdio'],
};
const LEGACY_WORKSPACE = { id: 'ws_legacy', name: 'legacy-project' };

let dir: string;
let dbPath: string;

function open(): Database {
  return new Database({ dbPath, logger: silentLogger('migration') });
}

function columnsOf(db: Database): string[] {
  return db.driver
    .all<{ name?: string }>('PRAGMA table_info(mcp_servers)')
    .map((column) => column.name ?? '');
}

/**
 * A database exactly as the previous build left it: migrations 1..2 applied,
 * a `mcp_servers` row and a `workspaces` row in it, and no `env_json` column.
 */
function createAtPreviousVersion(): void {
  const db = open();
  db.driver.runBatch(SCHEMA_VERSION_TABLE_SQL);
  db.driver.transaction(() => {
    for (const migration of MIGRATIONS.filter((m) => m.version <= PREVIOUS_VERSION)) {
      db.driver.runBatch(migration.sql);
      db.driver.run('INSERT INTO schema_version(version, applied_at) VALUES(?, ?)', [
        migration.version,
        nowIso(),
      ]);
    }
  });

  const now = nowIso();
  db.driver.run(
    `INSERT INTO workspaces(id, path, name, trust_state, created_at, last_opened_at)
     VALUES (?,?,?,?,?,?)`,
    [
      LEGACY_WORKSPACE.id,
      path.join(dir, 'project'),
      LEGACY_WORKSPACE.name,
      'trusted',
      now,
      null,
    ],
  );
  db.driver.run(
    `INSERT INTO mcp_servers
       (id, scope, scope_ref, name, exposure, transport, endpoint_json,
        secret_ref_json, enabled, health, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      LEGACY_SERVER.id,
      'global',
      null,
      LEGACY_SERVER.name,
      'ucad_internal',
      'stdio',
      JSON.stringify({ command: LEGACY_SERVER.command, args: LEGACY_SERVER.args }),
      JSON.stringify([{ providerId: 'mcp', key: 'token' }]),
      1,
      'ok',
      now,
      now,
    ],
  );
  db.close();
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucad-migrate-'));
  dbPath = path.join(dir, 'ucad.db');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('schema migration: mcp_servers.env_json', () => {
  it('is a new, higher version rather than an edit of an applied one', () => {
    const migration = MIGRATIONS.find((m) => m.version === ENV_VERSION);
    expect(migration, `migration ${ENV_VERSION} is missing`).toBeDefined();
    expect(migration?.name).toBe('mcp-env');
    expect(migration?.sql).toMatch(/ALTER TABLE mcp_servers ADD COLUMN env_json/);
    // Applied migrations are never rewritten: every version below it is still
    // there, and nothing above it is.
    expect(MIGRATIONS.map((m) => m.version)).toEqual(
      [...MIGRATIONS.map((m) => m.version)].sort((a, b) => a - b),
    );
    expect(MIGRATIONS.filter((m) => m.version <= PREVIOUS_VERSION)).toHaveLength(PREVIOUS_VERSION);
    expect(TARGET_SCHEMA_VERSION).toBeGreaterThanOrEqual(ENV_VERSION);
  });

  it('migrates a database from the previous version forward, keeping its rows', () => {
    createAtPreviousVersion();

    // What the previous build left behind, read before anything runs.
    const before = open();
    expect(before.schemaVersion).toBe(PREVIOUS_VERSION);
    expect(columnsOf(before)).not.toContain('env_json');
    const endpointBefore = before.driver.get<{ endpoint_json: string }>(
      'SELECT endpoint_json FROM mcp_servers WHERE id = ?',
      [LEGACY_SERVER.id],
    )?.endpoint_json;
    expect(endpointBefore).toBeTruthy();
    before.close();

    const db = open();
    const result = db.migrate();
    expect(result.from).toBe(PREVIOUS_VERSION);
    expect(result.applied).toContain(ENV_VERSION);
    expect(result.to).toBe(TARGET_SCHEMA_VERSION);
    expect(db.schemaVersion).toBe(TARGET_SCHEMA_VERSION);
    expect(columnsOf(db)).toContain('env_json');

    // The server is still there, field for field — this is the assertion that
    // "it exited 0" cannot stand in for.
    const row = db.driver.get<{
      id: string;
      name: string;
      exposure: string;
      transport: string;
      endpoint_json: string;
      secret_ref_json: string | null;
      enabled: number;
      health: string;
      env_json: string | null;
    }>('SELECT * FROM mcp_servers WHERE id = ?', [LEGACY_SERVER.id]);
    expect(row).toBeDefined();
    expect(row?.name).toBe(LEGACY_SERVER.name);
    expect(row?.exposure).toBe('ucad_internal');
    expect(row?.transport).toBe('stdio');
    expect(row?.endpoint_json).toBe(endpointBefore);
    expect(row?.secret_ref_json).toBe(JSON.stringify([{ providerId: 'mcp', key: 'token' }]));
    expect(row?.enabled).toBe(1);
    expect(row?.health).toBe('ok');
    // Nullable, and honestly empty: "no environment" rather than "an empty one".
    expect(row?.env_json).toBeNull();

    // A second table is untouched by an ALTER on the first.
    expect(
      db.driver.get<{ name: string }>('SELECT name FROM workspaces WHERE id = ?', [
        LEGACY_WORKSPACE.id,
      ])?.name,
    ).toBe(LEGACY_WORKSPACE.name);

    // And the registry reads the migrated row without inventing an environment.
    const manager = new McpManager({ db, logger: silentLogger('migration') });
    const dto = manager.get(LEGACY_SERVER.id);
    expect(dto.name).toBe(LEGACY_SERVER.name);
    expect(dto.envMasked).toBeUndefined();
    db.close();
  });

  it('is safe to re-run: nothing is applied and the row is still there', () => {
    createAtPreviousVersion();
    const db = open();
    db.migrate();

    const again = db.migrate();
    expect(again.applied).toHaveLength(0);
    expect(again.from).toBe(TARGET_SCHEMA_VERSION);
    expect(again.to).toBe(TARGET_SCHEMA_VERSION);
    expect(
      db.driver.get<{ name: string }>('SELECT name FROM mcp_servers WHERE id = ?', [
        LEGACY_SERVER.id,
      ])?.name,
    ).toBe(LEGACY_SERVER.name);
    db.close();
  });

  it('refuses to run against a schema without the column, and says why', () => {
    createAtPreviousVersion();
    // Deliberately not migrated: NFR-07 says the app must not continue on a
    // half-upgraded schema, and a registry that answered "no environment" here
    // would be indistinguishable from a server that has none.
    const db = open();
    const manager = new McpManager({ db, logger: silentLogger('migration') });

    expect(() => manager.list()).toThrow(/env_json/);
    expect(() =>
      manager.upsert({
        scope: 'global',
        name: 'new',
        exposure: 'ucad_internal',
        transport: 'stdio',
        enabled: true,
        command: 'ucad-new',
        env: { TOKEN: 'super-secret-token' },
      }),
    ).toThrow(/env_json/);
    // The refusal happened before any write, so nothing was half-saved.
    expect(
      db.driver.get<{ count?: number }>('SELECT COUNT(*) AS count FROM mcp_servers')?.count,
    ).toBe(1);

    // Migrating the same file fixes it — with a manager built afterwards, since
    // the check behind the guard is answered once per instance.
    db.migrate();
    const migrated = new McpManager({ db, logger: silentLogger('migration') });
    expect(migrated.list().map((s) => s.id)).toEqual([LEGACY_SERVER.id]);
    db.close();
  });
});
