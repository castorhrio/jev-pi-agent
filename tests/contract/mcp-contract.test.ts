/**
 * §12.1 "连接测试" + §10.1 MCP registry.
 *
 * The probe is the one surface in the product that can lie most easily: a
 * server that did not answer, a command that does not exist and a server that
 * is not MCP at all all look identical if the probe only reports "connected".
 * §12.1 / NFR-15 make the honesty rule a contract, so it is tested directly:
 *
 *  - `ok: false` always carries a non-empty, human-readable `reason`;
 *  - `ok: true` only ever comes back with an observed `toolCount`;
 *  - a transport that answered but never spoke MCP is `unverified`, NOT
 *    "connected" — and its `toolCount` stays 0 with an explicit `notVerified`;
 *  - the whole probe is bounded, so a hung server cannot wedge the UI.
 *
 * The second half is the manager/DTO round trip against a real database. Two
 * rules are load-bearing there and both are about not lying:
 *
 *  - `setExposure` writes the one column it owns. It used to be a re-upsert of
 *    the whole row, which is how a command or a URL could be blanked; the
 *    endpoint is compared before and after, not inferred from the DTO.
 *  - an environment is stored and read back *masked*. The names come out, the
 *    values do not, and the plaintext is proven absent from every DTO the
 *    Renderer can see (NFR-01).
 *
 * Everything here is hermetic: no network beyond a closed local port, no MCP
 * server that has to be installed, short timeouts.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Database } from '@ucad/storage';
import { McpManager } from '@ucad/mcp';
import { MCP_ENV_MASK } from '@ucad/contracts';
import { silentLogger } from '@ucad/observability';
import type { McpProbeResult } from '../../packages/mcp/src/probe';
// `packages/mcp/src/index.ts` is owned elsewhere and does not re-export the
// probe, so the module is imported from source: the test then does not depend
// on a build having happened first.
import { probeMcpServer } from '../../packages/mcp/src/probe';

/** Nothing listens here, so the connection is refused without touching a network. */
const CLOSED_PORT = 45_999;

let dir: string;
let db: Database;
let manager: McpManager;

/** A minimal MCP server, spoken to over stdio by the probe under test. */
const MCP_STUB = [
  'const out = (m) => process.stdout.write(JSON.stringify(m) + "\\n");',
  'let buf = "";',
  'process.stdin.on("data", (chunk) => {',
  '  buf += chunk;',
  '  for (let i = buf.indexOf("\\n"); i >= 0; i = buf.indexOf("\\n")) {',
  '    const line = buf.slice(0, i).trim();',
  '    buf = buf.slice(i + 1);',
  '    if (!line) continue;',
  '    const message = JSON.parse(line);',
  '    if (message.method === "initialize") {',
  '      out({ jsonrpc: "2.0", id: message.id, result: {',
  '        protocolVersion: "2025-06-18",',
  '        serverInfo: { name: "ucad-test-stub", version: "1.0" },',
  '        capabilities: { tools: {} },',
  '      } });',
  '    } else if (message.method === "tools/list") {',
  '      out({ jsonrpc: "2.0", id: message.id, result: {',
  '        tools: [{ name: "read" }, { name: "write" }, { name: "search" }],',
  '      } });',
  '    }',
  '  }',
  '});',
  'setInterval(() => {}, 1000);',
].join('\n');

/** Alive, but not MCP: it prints a banner and never answers. */
const SILENT_STUB = [
  'process.stdout.write("ucad stub, not an MCP server\\n");',
  'setInterval(() => {}, 1000);',
].join('\n');

let mcpStub: string;
let silentStub: string;

function stub(command: string, args: string[]) {
  return { id: 'srv', transport: 'stdio' as const, command, args };
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucad-mcp-'));
  mcpStub = path.join(dir, 'mcp-stub.js');
  silentStub = path.join(dir, 'silent-stub.js');
  fs.writeFileSync(mcpStub, MCP_STUB, 'utf8');
  fs.writeFileSync(silentStub, SILENT_STUB, 'utf8');
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(path.join(dir, 'ucad.db'), { force: true });
  db = new Database({ dbPath: path.join(dir, 'ucad.db'), logger: silentLogger('test') });
  db.migrate();
  manager = new McpManager({ db, logger: silentLogger('test') });
});

// ---------------------------------------------------------------------------
// probe: honesty contract
// ---------------------------------------------------------------------------

describe('probe / §12.1 honesty', () => {
  it('a command that does not exist fails with a readable reason', async () => {
    const result = await probeMcpServer(
      { id: 'srv', transport: 'stdio', command: 'ucad-no-such-binary-9f2a' },
      { timeoutMs: 3_000 },
    );
    expect(result.ok).toBe(false);
    expect(result.outcome).toBe('unreachable');
    expect(result.reason).toBeTruthy();
    expect(result.reason).toContain('ucad-no-such-binary-9f2a');
    expect(result.toolCount).toBe(0);
  });

  it('an unreachable URL fails with a readable reason, quickly', async () => {
    const started = Date.now();
    const result = await probeMcpServer(
      { id: 'srv', transport: 'http', url: `https://127.0.0.1:${CLOSED_PORT}/mcp` },
      { timeoutMs: 3_000 },
    );
    expect(result.ok).toBe(false);
    expect(result.outcome).toBe('unreachable');
    expect(result.reason).toBeTruthy();
    // The real cause has to survive, not a generic "failed".
    expect(result.reason).toMatch(/ECONNREFUSED|ECONNRESET|fetch failed|socket/i);
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it('rejects a malformed URL rather than throwing', async () => {
    const result = await probeMcpServer(
      { id: 'srv', transport: 'http', url: 'not a url' },
      { timeoutMs: 1_000 },
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  it('reports a server that starts but never speaks MCP as unverified, not connected', async () => {
    const result = await probeMcpServer(stub(process.execPath, [silentStub]), { timeoutMs: 900 });
    // The worst possible bug in this surface: a green badge on a server that
    // is not MCP at all.
    expect(result.ok).toBe(false);
    expect(result.outcome).toBe('unverified');
    expect(result.toolCount).toBe(0);
    expect(result.notVerified).toBeTruthy();
    expect(result.reason).toBeTruthy();
  });

  it('always resolves inside its timeout, even when the process never answers', async () => {
    const started = Date.now();
    const result = await probeMcpServer(
      stub(process.execPath, ['-e', 'setInterval(() => {}, 1000)']),
      { timeoutMs: 600 },
    );
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(result.ok).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  it('never returns ok: true without an observed tool count', async () => {
    const results: McpProbeResult[] = [
      await probeMcpServer({ id: 'a', transport: 'stdio', command: 'ucad-no-such-binary-9f2a' }),
      await probeMcpServer({ id: 'b', transport: 'stdio' }),
      await probeMcpServer({ id: 'c', transport: 'http' }),
      await probeMcpServer({ id: 'd', transport: 'http', url: 'not a url' }),
      await probeMcpServer(
        { id: 'e', transport: 'http', url: `https://127.0.0.1:${CLOSED_PORT}/mcp` },
        { timeoutMs: 2_000 },
      ),
      await probeMcpServer(stub(process.execPath, [silentStub]), { timeoutMs: 700 }),
      await probeMcpServer(stub(process.execPath, [mcpStub]), { timeoutMs: 5_000 }),
    ];
    for (const result of results) {
      if (result.ok) {
        expect(Number.isInteger(result.toolCount)).toBe(true);
        expect(result.outcome).toBe('handshake');
      }
    }
  });

  it('gives every failure a non-empty reason', async () => {
    const results: McpProbeResult[] = [
      await probeMcpServer({ id: 'a', transport: 'stdio', command: 'ucad-no-such-binary-9f2a' }),
      await probeMcpServer({ id: 'b', transport: 'stdio' }),
      await probeMcpServer({ id: 'c', transport: 'http' }),
      await probeMcpServer(stub(process.execPath, [silentStub]), { timeoutMs: 700 }),
    ];
    for (const result of results) {
      expect(result.ok).toBe(false);
      expect(result.reason ?? '').not.toBe('');
    }
  });

  it('counts only the tools a real tools/list actually returned', async () => {
    const result = await probeMcpServer(stub(process.execPath, [mcpStub]), { timeoutMs: 5_000 });
    expect(result.outcome).toBe('handshake');
    expect(result.ok).toBe(true);
    expect(result.toolCount).toBe(3);
    expect(result.serverInfo).toBe('ucad-test-stub@1.0');
    expect(result.reason).toBeUndefined();
    expect(result.notVerified).toBe('');
  });
});

// ---------------------------------------------------------------------------
// manager round trip
// ---------------------------------------------------------------------------

describe('McpManager / §10.1 round trip', () => {
  function seed(): string {
    return manager.upsert({
      scope: 'global',
      name: 'ix',
      exposure: 'ucad_internal',
      transport: 'stdio',
      enabled: true,
      command: 'ucad-ix',
      args: ['--stdio'],
    }).id;
  }

  it('upsert then get returns the same DTO', () => {
    const id = seed();
    const dto = manager.get(id);
    expect(dto).toMatchObject({
      id,
      scope: 'global',
      name: 'ix',
      exposure: 'ucad_internal',
      transport: 'stdio',
      enabled: true,
      health: 'unknown',
    });
  });

  it('setEnabled round-trips and moves the server out of the enabled sets', () => {
    const id = seed();
    expect(manager.internal().map((s) => s.id)).toEqual([id]);

    manager.setEnabled(id, false);
    expect(manager.get(id).enabled).toBe(false);
    expect(manager.internal()).toEqual([]);
  });

  it('setExposure changes the exposure and leaves the endpoint untouched', () => {
    // This is exactly what `mcp:setExposure` has to do. It used to read the
    // whole row back and re-upsert it, so anything the read could not
    // reconstruct — a command, an argument list, a URL — was blanked by the
    // act of changing one enum. The row is compared byte for byte instead.
    const id = seed();
    const readRow = (): {
      endpoint_json: string;
      secret_ref_json: string | null;
      env_json: string | null;
      enabled: number;
      health: string;
    } => {
      const row = db.driver.get<{
        endpoint_json: string;
        secret_ref_json: string | null;
        env_json: string | null;
        enabled: number;
        health: string;
      }>('SELECT endpoint_json, secret_ref_json, env_json, enabled, health FROM mcp_servers WHERE id = ?', [id]);
      if (!row) throw new Error(`row disappeared: ${id}`);
      return row;
    };

    const before = readRow();
    manager.setExposure(id, 'agent_facing');
    const after = readRow();

    expect(after.endpoint_json).toBe(before.endpoint_json);
    expect(after.secret_ref_json).toBe(before.secret_ref_json);
    expect(after.env_json).toBe(before.env_json);
    expect(after.enabled).toBe(before.enabled);
    expect(after.health).toBe(before.health);
    // The endpoint is asserted directly, not inferred from the DTO: the DTO
    // never carried it, which is exactly why blanking it went unnoticed.
    expect(JSON.parse(after.endpoint_json)).toEqual({
      command: 'ucad-ix',
      args: ['--stdio'],
    });

    const dto = manager.get(id);
    expect(dto.exposure).toBe('agent_facing');
    expect(dto.enabled).toBe(true);
    expect(dto.health).toBe('unknown');
    expect(manager.agentFacing('agt_1').map((s) => s.id)).toEqual([id]);
    expect(manager.internal()).toEqual([]);
  });

  it('setExposure leaves a remote URL intact', () => {
    const id = manager.upsert({
      scope: 'global',
      name: 'remote',
      exposure: 'ucad_internal',
      transport: 'http',
      enabled: true,
      url: 'https://mcp.example.test/mcp',
    }).id;

    manager.setExposure(id, 'agent_facing');

    const stored = db.driver.get<{ endpoint_json: string }>(
      'SELECT endpoint_json FROM mcp_servers WHERE id = ?',
      [id],
    )?.endpoint_json;
    expect(JSON.parse(stored ?? '{}')).toEqual({ url: 'https://mcp.example.test/mcp' });
    expect(manager.get(id).exposure).toBe('agent_facing');
  });

  it('setHealth round-trips the outcome of a real test', () => {
    const id = seed();
    manager.setHealth(id, 'error');
    expect(manager.get(id).health).toBe('error');
    manager.setHealth(id, 'ok');
    expect(manager.get(id).health).toBe('ok');
  });

  it('filters by scope and removes cleanly', () => {
    const globalId = seed();
    const workspaceId = manager.upsert({
      scope: 'workspace',
      scopeRef: 'ws_1',
      name: 'project-tools',
      exposure: 'ucad_internal',
      transport: 'http',
      enabled: true,
      url: 'https://mcp.example.test/mcp',
    }).id;

    expect(manager.list('global').map((s) => s.id)).toEqual([globalId]);
    expect(manager.list('workspace').map((s) => s.id)).toEqual([workspaceId]);
    expect(manager.list('workspace-scoped').map((s) => s.id)).toEqual([workspaceId]);
    expect(manager.list()).toHaveLength(2);

    manager.remove(workspaceId);
    expect(manager.list()).toHaveLength(1);
    expect(() => manager.get(workspaceId)).toThrow();
  });

  it('never hands a secret value back to the caller (§10.1, NFR-01)', async () => {
    const id = manager.upsert({
      scope: 'global',
      name: 'remote',
      exposure: 'ucad_internal',
      transport: 'http',
      enabled: true,
      url: 'https://mcp.example.test/mcp',
      secretRefs: [{ providerId: 'mcp', key: 'token' }],
    }).id;

    // The DTO the Renderer sees carries no endpoint and no secret at all.
    expect(JSON.stringify(manager.get(id))).not.toContain('token');
    const resolved = await manager.resolveSecret(id, async () => 'super-secret');
    expect(resolved).toEqual({ 'mcp/token': 'super-secret' });
  });

  // -------------------------------------------------------------------------
  // environment: stored, never read back (NFR-01)
  // -------------------------------------------------------------------------

  describe('environment / NFR-01', () => {
    const SECRET = 'super-secret-token';

    function withEnv(env: Record<string, string>): string {
      return manager.upsert({
        scope: 'global',
        name: 'ix',
        exposure: 'ucad_internal',
        transport: 'stdio',
        enabled: true,
        command: 'ucad-ix',
        args: ['--stdio'],
        env,
      }).id;
    }

    it('reads back the names with the values masked', () => {
      const id = withEnv({ A: '1', B: '2' });

      const dto = manager.get(id);
      expect(Object.keys(dto.envMasked ?? {})).toEqual(['A', 'B']);
      expect(dto.envMasked).toEqual({ A: MCP_ENV_MASK, B: MCP_ENV_MASK });
      // Not "1" and not "2": the mask is the whole point.
      expect(Object.values(dto.envMasked ?? {}).some((v) => v === '1' || v === '2')).toBe(false);
      // list() is the path the panel actually uses; it masks the same way.
      expect(manager.list()[0]?.envMasked).toEqual({ A: MCP_ENV_MASK, B: MCP_ENV_MASK });
    });

    it('keeps a secret out of every DTO the Renderer can see', () => {
      const id = withEnv({ TOKEN: SECRET, HTTPS_PROXY: SECRET });

      expect(JSON.stringify(manager.get(id))).not.toContain(SECRET);
      expect(JSON.stringify(manager.list())).not.toContain(SECRET);
      // Main can still read the values when it launches the process.
      expect(manager.resolveEnv(id)).toEqual({ TOKEN: SECRET, HTTPS_PROXY: SECRET });
    });

    it('sorts the names so the panel renders the same order every time', () => {
      const id = withEnv({ ZETA: '3', ALPHA: '1', MID: '2' });
      expect(Object.keys(manager.get(id).envMasked ?? {})).toEqual(['ALPHA', 'MID', 'ZETA']);
    });

    it('reports no environment as absent, not as an empty map', () => {
      const id = seed();
      // A panel cannot tell "nothing stored" from "stored and empty" if both
      // arrive as `{}`, so the absent case has to stay absent.
      expect(manager.get(id).envMasked).toBeUndefined();
    });

    it('an edit that omits env keeps the stored values', () => {
      const id = withEnv({ TOKEN: SECRET });
      // The rename case `mcp:upsert` hits when a user fixes a typo in the name:
      // the environment is write-only, so an empty editor must not blank it.
      manager.upsert({
        id,
        scope: 'global',
        name: 'ix-renamed',
        exposure: 'ucad_internal',
        transport: 'stdio',
        enabled: true,
        command: 'ucad-ix',
        args: ['--stdio'],
      });
      expect(manager.get(id).name).toBe('ix-renamed');
      expect(manager.resolveEnv(id)).toEqual({ TOKEN: SECRET });
      expect(manager.get(id).envMasked).toEqual({ TOKEN: MCP_ENV_MASK });
    });

    it('an explicit empty map clears them, and the names disappear with them', () => {
      const id = withEnv({ TOKEN: SECRET });
      manager.upsert({
        id,
        scope: 'global',
        name: 'ix',
        exposure: 'ucad_internal',
        transport: 'stdio',
        enabled: true,
        command: 'ucad-ix',
        args: ['--stdio'],
        env: {},
      });
      expect(manager.resolveEnv(id)).toEqual({});
      expect(manager.get(id).envMasked).toBeUndefined();
    });

    it('setExposure does not disturb a stored environment', () => {
      const id = withEnv({ TOKEN: SECRET });
      manager.setExposure(id, 'agent_facing');
      expect(manager.resolveEnv(id)).toEqual({ TOKEN: SECRET });
      expect(manager.get(id).envMasked).toEqual({ TOKEN: MCP_ENV_MASK });
    });

    it('encrypts the stored environment at rest when the database is protected (NFR-15)', async () => {
      // An MCP environment is a credential store in all but name — `GITHUB_TOKEN`
      // and `DATABASE_URL` are exactly what a stdio server expects there. The
      // default test database carries no protection key, where
      // `encryptIfNeeded` is the identity, so this builds a *protected* one and
      // asserts on the raw column: the DTO is masked either way and would pass
      // regardless of whether anything was encrypted.
      const { Database } = await import('@ucad/storage');
      const { McpManager: Manager } = await import('@ucad/mcp');
      const { randomBytes } = await import('node:crypto');

      const protectedDb = new Database({
        dbPath: path.join(dir, 'protected.db'),
        logger: silentLogger('mcp-env'),
        protection: { key: randomBytes(32) },
      });
      protectedDb.migrate();
      const protectedManager = new Manager({ db: protectedDb, logger: silentLogger('mcp-env') });

      protectedManager.upsert({
        scope: 'global',
        name: 'guarded',
        exposure: 'agent_facing',
        transport: 'stdio',
        command: 'run.sh',
        env: { GITHUB_TOKEN: SECRET },
      });

      const row = protectedDb.driver.get<{ id: string; env_json: string | null }>(
        'SELECT id, env_json FROM mcp_servers WHERE name = ?',
        ['guarded'],
      );
      expect(row?.env_json, 'nothing was stored at all').not.toBeNull();
      expect(row?.env_json, 'the secret is on disk in plaintext').not.toContain(SECRET);
      expect(
        row?.env_json,
        'the column is not in the encrypted envelope form',
      ).toMatch(/^[a-z]+:/);

      // ...and it still round-trips, which is the only reason to encrypt it.
      expect(protectedManager.resolveEnv(row!.id).GITHUB_TOKEN).toBe(SECRET);

      protectedDb.close();
    });
  });
});
