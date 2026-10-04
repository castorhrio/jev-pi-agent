/**
 * §12.1 Settings / MCP — IPC registration.
 *
 * Until now the `McpManager` was complete and unreachable: the Renderer had no
 * channel to add, scope, enable or test a single server. These six handlers are
 * that surface, and they follow the rules of `ipc.ts` (§7.2):
 *
 *  - every input is validated with Zod before it reaches a service;
 *  - every failure leaves Main as a plain, already user-safe `Error` — a
 *    vendor stack never crosses the bridge;
 *  - no response ever carries secret plaintext.
 *
 * Three rules specific to this surface:
 *
 *  1. **No raw secrets, ever.** `mcp:upsert` accepts a `secretRef` that names an
 *     already-stored credential and nothing else; the schema is `.strict()`, so
 *     a smuggled `apiKey` is a validation error rather than a stored secret
 *     (NFR-01 — the Renderer has no secret-read channel either). `env` values
 *     are the one exception the registry now stores, and they are write-only:
 *     they are persisted and the answer carries the variable names behind
 *     `MCP_ENV_MASK` (NFR-01), because a stdio wrapper that needs a token is a
 *     real configuration and dropping it silently is not an option.
 *  2. **`https://` only for remote servers.** A remote MCP server is a
 *     different trust boundary from a local process: it can hold a credential
 *     and act on the user's machine. Refusing plaintext HTTP here is a
 *     deliberate product decision, not an oversight — see `assertEndpoint`.
 *  3. **A test reports what it observed.** `mcp:test` stores the probe's real
 *     outcome, including the verbatim reason, so the panel can show a failure
 *     instead of an empty state (§12.1 honesty).
 */

import { createRequire } from 'node:module';
import * as z from 'zod';
import { IPC_CHANNELS } from '@ucad/contracts';
import type { McpServerDto, McpTestResult } from '@ucad/contracts';
import { nowIso } from '@ucad/observability';
import * as McpPackage from '@ucad/mcp';
import type { McpScope, UpsertMcpServerInput } from '@ucad/mcp';
// Type-only, so it is erased at compile time; the runtime lookup is `loadProbe`.
import type { McpProbeResult, McpProbeTarget } from '@ucad/mcp/dist/probe';
import type { BrowserWindow } from 'electron';
import type { UcadApp } from './app-container';

/** §12.1 — bounded, so a hung server cannot wedge the settings page. */
const PROBE_TIMEOUT_MS = 5_000;

export interface McpIpcDeps {
  ucad: UcadApp;
  handle: (channel: string, fn: (...args: unknown[]) => unknown) => void;
  /** parity with `registerIpc`; MCP has no dialog to parent, kept for the seam */
  getWindow: () => BrowserWindow | null;
}

/**
 * `McpTestResult` plus the evidence behind it.
 *
 * The contract types the result as `{ ok, toolCount, latencyMs, reason }`, which
 * is enough to render a verdict but not enough to explain one — and §12.1
 * requires the failure to be explainable. The extra members are how the panel
 * says *what was checked* and *what was not*, the same shape
 * `intelligence.query` already uses for its full outcome.
 */
interface McpTestResultWithEvidence extends McpTestResult {
  outcome: McpProbeResult['outcome'];
  checks: string[];
  notVerified: string;
  serverInfo?: string;
}

// ---------------------------------------------------------------------------
// schemas
// ---------------------------------------------------------------------------

const idSchema = z.string().min(1).max(128);
const exposureSchema = z.enum(['agent_facing', 'ucad_internal']);
const transportSchema = z.enum(['stdio', 'http']);
const secretRefSchema = z.object({
  providerId: z.string().min(1).max(64),
  key: z.string().min(1).max(64),
});

/**
 * `.strict()` is load-bearing: it is what makes "no raw secrets" enforceable
 * rather than aspirational. Any key outside this list is a validation error.
 */
const upsertSchema = z
  .object({
    id: idSchema.optional(),
    scope: z.enum(['global', 'workspace']),
    name: z.string().trim().min(1).max(200),
    exposure: exposureSchema,
    transport: transportSchema,
    command: z.string().trim().min(1).max(4_096).optional(),
    args: z.array(z.string().min(1).max(4_096)).max(64).optional(),
    url: z.string().trim().min(1).max(2_048).optional(),
    env: z.record(z.string().max(256), z.string().max(8_192)).optional(),
    /** name of a stored credential, never the credential (NFR-01) */
    secretRef: secretRefSchema.optional(),
  })
  .strict();

const UPSERT_KEYS = new Set(Object.keys(upsertSchema.shape));
const SECRET_LIKE_KEY = /secret|token|password|passwd|api[-_]?key|credential|authorization/i;

// ---------------------------------------------------------------------------
// row access
// ---------------------------------------------------------------------------

/**
 * The `mcp_servers` row behind one DTO.
 *
 * `McpManager.get()` returns a DTO that deliberately omits the endpoint and the
 * secret references, and the handlers that still need those fields read the row
 * back rather than reconstructing them. That is a read for one field only —
 * `setExposure` no longer re-upserts the row, so nothing can blank a command.
 */
interface McpRow {
  scope: string;
  scope_ref: string | null;
  name: string;
  exposure: string;
  transport: string;
  endpoint_json: string;
  secret_ref_json: string | null;
  enabled: number;
}

interface McpEndpoint {
  command?: string;
  args?: string[];
  url?: string;
}

function readRow(ucad: UcadApp, id: string): McpRow {
  const row = ucad.db.driver.get<McpRow>(
    'SELECT scope, scope_ref, name, exposure, transport, endpoint_json, secret_ref_json, enabled FROM mcp_servers WHERE id = ?',
    [id],
  );
  if (!row) throw new Error(`MCP 服务器不存在：${id}`);
  return row;
}

function readEndpoint(row: McpRow): McpEndpoint {
  try {
    const parsed: unknown = JSON.parse(row.endpoint_json);
    if (typeof parsed !== 'object' || parsed === null) return {};
    const record = parsed as Record<string, unknown>;
    const endpoint: McpEndpoint = {};
    if (typeof record['command'] === 'string') endpoint.command = record['command'];
    if (Array.isArray(record['args'])) {
      endpoint.args = record['args'].filter((a): a is string => typeof a === 'string');
    }
    if (typeof record['url'] === 'string') endpoint.url = record['url'];
    return endpoint;
  } catch {
    return {};
  }
}

function readSecretRefs(row: McpRow): Array<{ providerId: string; key: string }> {
  if (!row.secret_ref_json) return [];
  try {
    const parsed: unknown = JSON.parse(row.secret_ref_json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is { providerId: string; key: string } =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as { providerId?: unknown }).providerId === 'string' &&
        typeof (item as { key?: unknown }).key === 'string',
    );
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// probe resolution
// ---------------------------------------------------------------------------

type ProbeFn = (target: McpProbeTarget, options?: { timeoutMs?: number }) => Promise<McpProbeResult>;

let probeCache: ProbeFn | null | undefined;

/**
 * Resolve `probeMcpServer` from `@ucad/mcp`.
 *
 * The probe is a sibling module of the package entry point but is not yet
 * re-exported from the barrel, and the package `exports` map blocks a deep
 * runtime import. The barrel is preferred, so this becomes a no-op the moment
 * `packages/mcp/src/index.ts` re-exports it; until then the sibling of the
 * resolved entry point is used. If neither resolves, `mcp:test` reports that
 * plainly instead of returning a fabricated result.
 */
function loadProbe(): ProbeFn | null {
  if (probeCache !== undefined) return probeCache;
  const barrel = McpPackage as unknown as { probeMcpServer?: ProbeFn };
  if (typeof barrel.probeMcpServer === 'function') {
    probeCache = barrel.probeMcpServer;
    return probeCache;
  }
  try {
    const entry = require.resolve('@ucad/mcp');
    // The sibling path is resolved from the installed package at runtime: a
    // require scoped to the entry's own directory with a literal relative
    // specifier, so nothing user-controlled can enter the resolution.
    const sibling = createRequire(entry)('./probe.js') as {
      probeMcpServer?: ProbeFn;
    };
    probeCache = typeof sibling.probeMcpServer === 'function' ? sibling.probeMcpServer : null;
  } catch {
    probeCache = null;
  }
  return probeCache;
}

// ---------------------------------------------------------------------------
// persistence
// ---------------------------------------------------------------------------

/**
 * `mcp_servers` has no column for the last test, so the probe outcome lives in
 * the settings document. `normalizeSettings` keeps the entries verbatim, which
 * is what makes `lastError` survive a restart.
 */
function mergeStored(dto: McpServerDto, stored: McpServerDto | undefined): McpServerDto {
  if (!stored) return { ...dto };
  return {
    ...dto,
    toolCount: stored.toolCount,
    lastError: stored.lastError,
    lastCheckedAt: stored.lastCheckedAt,
  };
}

function listServers(ucad: UcadApp, scope?: McpScope | 'workspace-scoped'): McpServerDto[] {
  const stored = new Map(
    ucad.sessionStore.getSettings().mcp.servers.map((entry) => [entry.id, entry]),
  );
  return ucad.mcp.list(scope).map((dto) => mergeStored(dto, stored.get(dto.id)));
}

/** Every change is written straight back, so a restart does not lose it. */
function persist(ucad: UcadApp): void {
  ucad.sessionStore.patchSettings({ mcp: { servers: listServers(ucad) } });
}

// ---------------------------------------------------------------------------
// registration
// ---------------------------------------------------------------------------

export function registerMcpIpc(deps: McpIpcDeps): void {
  const { ucad, handle } = deps;

  // -------------------------------------------------------------------- list
  handle(
    IPC_CHANNELS.mcp.list,
    (rawScope: unknown) => {
      const scope = z
        .enum(['global', 'workspace', 'workspace-scoped'])
        .optional()
        .parse(rawScope);
      return listServers(ucad, scope);
    },
  );

  // ------------------------------------------------------------------ upsert
  handle(IPC_CHANNELS.mcp.upsert, (raw: unknown) => {
    // A friendly message for the mistake that matters, in front of the strict
    // schema that catches every other one.
    if (typeof raw === 'object' && raw !== null) {
      for (const key of Object.keys(raw as Record<string, unknown>)) {
        if (!UPSERT_KEYS.has(key) && SECRET_LIKE_KEY.test(key)) {
          throw new Error(
            '不接受明文凭据：请用「凭据名称」引用已经保存的凭据，凭据本身不会经过这条通道。',
          );
        }
      }
    }
    const parsed = upsertSchema.parse(raw);

    if (parsed.transport === 'http') {
      if (!parsed.url) throw new Error('http 方式必须填地址。');
      assertHttps(parsed.url);
    } else if (!parsed.command) {
      throw new Error('stdio 方式必须填可执行命令。');
    }

    const existing = parsed.id ? readRow(ucad, parsed.id) : null;

    let scopeRef: string | undefined;
    if (parsed.scope === 'workspace') {
      const workspace = ucad.sessionStore.listWorkspaces()[0];
      if (!workspace) throw new Error('请先打开一个项目，再添加本项目作用域的 MCP 服务器。');
      scopeRef = workspace.id;
    } else if (existing?.scope_ref) {
      scopeRef = existing.scope_ref;
    }

    // §10.1 / NFR-01 — the environment is stored, never read back. A non-empty
    // map replaces the stored set; an empty or absent one keeps it, so an edit
    // that only renames a server cannot wipe variables the user cannot see.
    const env = parsed.env && Object.keys(parsed.env).length > 0 ? parsed.env : undefined;

    const input: UpsertMcpServerInput = {
      id: parsed.id,
      scope: parsed.scope,
      scopeRef,
      name: parsed.name,
      exposure: parsed.exposure,
      transport: parsed.transport,
      // An edit must not silently re-enable a server the user turned off.
      enabled: existing ? existing.enabled === 1 : true,
      command: parsed.command,
      args: parsed.args,
      url: parsed.url,
      env,
      // Keep the stored reference when the user did not re-type the name.
      secretRefs: parsed.secretRef ? [parsed.secretRef] : existing ? readSecretRefs(existing) : undefined,
    };

    const saved = ucad.mcp.upsert(input);
    persist(ucad);
    return mergeStored(saved, storedEntry(ucad, saved.id));
  });

  // ------------------------------------------------------------------ remove
  handle(IPC_CHANNELS.mcp.remove, (rawId: unknown) => {
    const id = idSchema.parse(rawId);
    // Existence is checked explicitly: a DELETE against a missing id succeeds
    // silently, and a remove that reports success without removing anything is
    // the kind of quiet lie this surface must not tell.
    readRow(ucad, id);
    ucad.mcp.remove(id);
    persist(ucad);
  });

  // -------------------------------------------------------------- setEnabled
  handle(IPC_CHANNELS.mcp.setEnabled, (rawId: unknown, rawEnabled: unknown) => {
    const id = idSchema.parse(rawId);
    const enabled = z.boolean().parse(rawEnabled);
    ucad.mcp.setEnabled(id, enabled);
    persist(ucad);
    return mergeStored(ucad.mcp.get(id), storedEntry(ucad, id));
  });

  // ------------------------------------------------------------ setExposure
  handle(IPC_CHANNELS.mcp.setExposure, (rawId: unknown, rawExposure: unknown) => {
    const id = idSchema.parse(rawId);
    const exposure = exposureSchema.parse(rawExposure);
    // Existence only: an UPDATE against a missing id changes nothing and would
    // report success, and this surface must not claim a change it did not make.
    readRow(ucad, id);

    // One column. The previous path re-upserted the whole row from a value read
    // back through the driver, which is how an endpoint could end up blank.
    ucad.mcp.setExposure(id, exposure);

    ucad.logger.info('mcp exposure changed', { id, exposure, note: '§10.1' });
    persist(ucad);
    return mergeStored(ucad.mcp.get(id), storedEntry(ucad, id));
  });

  // -------------------------------------------------------------------- test
  handle(IPC_CHANNELS.mcp.test, async (rawId: unknown) => {
    const id = idSchema.parse(rawId);
    const probe = loadProbe();
    if (!probe) {
      return recordTest(ucad, id, {
        id,
        ok: false,
        toolCount: 0,
        latencyMs: 0,
        outcome: 'unreachable',
        checks: [],
        notVerified: 'nothing — the connection probe module could not be loaded',
        reason: '连接测试模块不可用，未执行任何检查。',
      });
    }

    const row = readRow(ucad, id);
    const endpoint = readEndpoint(row);
    // NFR-01: the values are read here, in Main, and go straight to the child
    // process. They never reach a DTO, the Renderer, or a log line. A stdio
    // server launched without its configured environment is a different program
    // from the one the user configured — usually one that fails to authenticate.
    const env = row.transport === 'stdio' ? ucad.mcp.resolveEnv(id) : undefined;
    const target: McpProbeTarget =
      row.transport === 'http'
        ? { id, transport: 'http', url: endpoint.url }
        : { id, transport: 'stdio', command: endpoint.command, args: endpoint.args, env };

    const result = await probe(target, { timeoutMs: PROBE_TIMEOUT_MS });
    return recordTest(ucad, id, result);
  });
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * Plaintext HTTP is refused for remote servers.
 *
 * Deliberate, not an oversight (§12.1): a remote MCP server sits on the other
 * side of a trust boundary — it holds a credential and can act on the user's
 * machine — so the transport has to be authenticated end to end. A
 * `http://127.0.0.1` MCP server is a real deployment, and supporting it is a
 * separate, explicit rule about which hosts are local; it is not a hole to
 * leave in this one.
 */
function assertHttps(url: string): void {
  if (!url.toLowerCase().startsWith('https://')) {
    throw new Error('只接受 https:// 地址（远程 MCP 服务器必须加密传输）。');
  }
}

function storedEntry(ucad: UcadApp, id: string): McpServerDto | undefined {
  return ucad.sessionStore.getSettings().mcp.servers.find((entry) => entry.id === id);
}

/**
 * Store the real outcome of one test.
 *
 * `unverified` maps to `unknown`, not to `ok` and not to `error`: the transport
 * answered but the MCP protocol was not confirmed, so we genuinely do not know
 * whether this server works. Marking it healthy would be the lie this whole
 * surface exists to avoid; marking it broken would be a different one. The
 * verbatim reason sits next to it either way.
 */
function recordTest(ucad: UcadApp, id: string, result: McpProbeResult): McpTestResultWithEvidence {
  const health: McpServerDto['health'] =
    result.outcome === 'handshake' ? 'ok' : result.outcome === 'unverified' ? 'unknown' : 'error';
  ucad.mcp.setHealth(id, health);

  const servers = listServers(ucad).map((dto) =>
    dto.id === id
      ? {
          ...dto,
          // Only a handshake may carry a count; anything else stays 0.
          toolCount: result.outcome === 'handshake' ? result.toolCount : 0,
          lastError: result.ok ? undefined : result.reason,
          lastCheckedAt: nowIso(),
        }
      : dto,
  );
  ucad.sessionStore.patchSettings({ mcp: { servers } });

  // The extra members are how the Renderer learns *what* was checked; the
  // same shape `intelligence.query` already uses for its full outcome.
  return {
    id: result.id,
    ok: result.ok,
    toolCount: result.toolCount,
    latencyMs: result.latencyMs,
    reason: result.reason,
    outcome: result.outcome,
    checks: result.checks,
    notVerified: result.notVerified,
    serverInfo: result.serverInfo,
  };
}
