/**
 * @ucad/mcp — MCP server registry.
 *
 * The design makes one distinction that this package exists to enforce (§10.1):
 * a server marked `agent_facing` hands its raw tools straight to an Agent,
 * which means those calls bypass the Context Broker entirely — no provenance,
 * no budget, no audit. That is a legitimate advanced mode, but only if it is
 * explicit and leaves a trace, so `agentFacing()` exists separately from
 * `internal()` and records a bypass marker.
 *
 * The second rule concerns the environment a stdio server is launched with: it
 * is stored (`mcp_servers.env_json`, migration 3) but it is write-only through
 * this package's DTOs. `get` / `list` return the variable *names* behind
 * `MCP_ENV_MASK`; only `resolveEnv` — Main, when it spawns a process — reads
 * the values back (NFR-01).
 */

import type { Database } from '@ucad/storage';
import type { McpServerDto, SecretRef } from '@ucad/contracts';
import { MCP_ENV_MASK } from '@ucad/contracts';
import { ulid, nowIso } from '@ucad/observability';
import type { Logger } from '@ucad/observability';

// The connection test lives in the same package; the barrel re-exports it so
// the Desktop can reach it without a deep import, which this package's
// `exports` map blocks on purpose.
export * from './probe';

export interface McpManagerOptions {
  db: Database;
  logger: Logger;
}

export type McpScope = 'global' | 'workspace';

export interface UpsertMcpServerInput {
  id?: string;
  scope: McpScope;
  scopeRef?: string;
  name: string;
  exposure: 'agent_facing' | 'ucad_internal';
  transport: 'stdio' | 'http';
  enabled: boolean;
  /** stdio */
  command?: string;
  args?: string[];
  /** http */
  url?: string;
  /**
   * Written, never read back (NFR-01). Omitted keeps the stored values; an
   * explicit map replaces the whole set.
   */
  env?: Record<string, string>;
  secretRefs?: SecretRef[];
}

interface McpRow {
  id: string;
  scope: string;
  scope_ref: string | null;
  name: string;
  exposure: string;
  transport: string;
  endpoint_json: string | null;
  secret_ref_json: string | null;
  /** migration 3; absent on a row written before it (see `assertEnvColumn`) */
  env_json?: string | null;
  enabled: number;
  health: string;
  created_at: string;
  updated_at: string;
}

export class McpManager {
  private readonly db: Database;
  private readonly logger: Logger;
  /** cached `PRAGMA table_info` answer; the schema cannot change under a handle */
  private hasEnvColumn: boolean | undefined;

  constructor(opts: McpManagerOptions) {
    this.db = opts.db;
    this.logger = opts.logger.child('mcp');
  }

  list(scope?: McpScope | 'workspace-scoped'): McpServerDto[] {
    const rows =
      scope === undefined
        ? this.db.driver.all<McpRow>(
            'SELECT * FROM mcp_servers ORDER BY scope ASC, name ASC',
          )
        : this.db.driver.all<McpRow>(
            'SELECT * FROM mcp_servers WHERE scope = ? ORDER BY name ASC',
            [scope === 'workspace-scoped' ? 'workspace' : scope],
          );
    return rows.map((row) => this.toDto(row));
  }

  upsert(input: UpsertMcpServerInput): McpServerDto {
    const id = input.id ?? ulid('mcp_');
    this.assertEnvColumn();
    const existing = this.db.driver.get<McpRow>(
      'SELECT * FROM mcp_servers WHERE id = ?',
      [id],
    );
    const endpoint = JSON.stringify(
      input.transport === 'stdio'
        ? { command: input.command ?? '', args: input.args ?? [] }
        : { url: input.url ?? '' },
    );
    const secretRefs = JSON.stringify(input.secretRefs ?? []);
    const envJson = this.envJsonFor(input, existing);
    const now = nowIso();

    if (existing) {
      this.db.driver.run(
        `UPDATE mcp_servers
            SET scope = ?, scope_ref = ?, name = ?, exposure = ?, transport = ?,
                endpoint_json = ?, secret_ref_json = ?, env_json = ?, enabled = ?,
                updated_at = ?
          WHERE id = ?`,
        [
          input.scope,
          input.scopeRef ?? null,
          input.name,
          input.exposure,
          input.transport,
          endpoint,
          secretRefs,
          envJson,
          input.enabled ? 1 : 0,
          now,
          id,
        ],
      );
    } else {
      this.db.driver.run(
        `INSERT INTO mcp_servers
           (id, scope, scope_ref, name, exposure, transport, endpoint_json,
            secret_ref_json, env_json, enabled, health, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          id,
          input.scope,
          input.scopeRef ?? null,
          input.name,
          input.exposure,
          input.transport,
          endpoint,
          secretRefs,
          envJson,
          input.enabled ? 1 : 0,
          'unknown',
          now,
          now,
        ],
      );
    }

    this.logger.info('mcp server saved', {
      id,
      name: input.name,
      exposure: input.exposure,
    });
    return this.get(id);
  }

  get(id: string): McpServerDto {
    const row = this.db.driver.get<McpRow>('SELECT * FROM mcp_servers WHERE id = ?', [id]);
    if (!row) throw new Error(`MCP server not found: ${id}`);
    return this.toDto(row);
  }

  remove(id: string): void {
    this.db.driver.run('DELETE FROM mcp_servers WHERE id = ?', [id]);
    this.logger.info('mcp server removed', { id });
  }

  setEnabled(id: string, enabled: boolean): void {
    this.db.driver.run(
      'UPDATE mcp_servers SET enabled = ?, updated_at = ? WHERE id = ?',
      [enabled ? 1 : 0, nowIso(), id],
    );
  }

  setHealth(id: string, health: McpServerDto['health']): void {
    this.db.driver.run('UPDATE mcp_servers SET health = ?, updated_at = ? WHERE id = ?', [
      health,
      nowIso(),
      id,
    ]);
  }

  /**
   * §10.1 — flip exposure without touching anything else.
   *
   * A single-column UPDATE next to `setEnabled` / `setHealth`, and deliberately
   * not a re-upsert: the old path read the whole row back and wrote it again,
   * which is how a command or a URL could end up blanked when the endpoint
   * could not be reconstructed exactly. Exposure is one field; this writes one
   * field.
   */
  setExposure(id: string, exposure: McpServerDto['exposure']): void {
    this.db.driver.run('UPDATE mcp_servers SET exposure = ?, updated_at = ? WHERE id = ?', [
      exposure,
      nowIso(),
      id,
    ]);
  }

  /**
   * Servers whose tools go straight to an Agent.
   *
   * §10.2 M-1/M-2: this is an explicit advanced mode. The caller MUST emit a
   * `warning { code: 'MCP_PASSTHROUGH_BYPASS' }` event for the turn, because
   * these calls do not enter Context provenance or the token budget.
   */
  agentFacing(_agentId: string): McpServerDto[] {
    const servers = this.list().filter(
      (s) => s.exposure === 'agent_facing' && s.enabled,
    );
    if (servers.length > 0) {
      this.logger.warn('agent-facing MCP passthrough active', {
        servers: servers.map((s) => s.id),
        note: 'MCP_PASSTHROUGH_BYPASS — calls bypass Context Broker provenance and budget',
      });
    }
    return servers;
  }

  /**
   * Servers UCAD calls itself. §10.1: an Ix MCP server belongs here so that
   * structured code retrieval always flows through
   * `CodeIntelligenceProvider -> ContextBroker`.
   */
  internal(): McpServerDto[] {
    return this.list().filter((s) => s.exposure === 'ucad_internal' && s.enabled);
  }

  /** Resolve secret references. Only ever called from Main, never the Renderer. */
  async resolveSecret(
    id: string,
    resolver: (ref: SecretRef) => Promise<string | null>,
  ): Promise<Record<string, string>> {
    const row = this.db.driver.get<McpRow>('SELECT * FROM mcp_servers WHERE id = ?', [id]);
    if (!row?.secret_ref_json) return {};
    let refs: SecretRef[] = [];
    try {
      refs = JSON.parse(row.secret_ref_json) as SecretRef[];
    } catch {
      return {};
    }
    const out: Record<string, string> = {};
    for (const ref of refs) {
      const value = await resolver(ref);
      if (value) out[`${ref.providerId}/${ref.key}`] = value;
    }
    return out;
  }

  /**
   * The real environment values, for Main when it launches a stdio server.
   * Main only, like `resolveSecret`: the Renderer has no read path for these
   * (NFR-01) and `get` / `list` hand it `envMasked` instead.
   */
  resolveEnv(id: string): Record<string, string> {
    const row = this.db.driver.get<McpRow>('SELECT * FROM mcp_servers WHERE id = ?', [id]);
    if (!row) throw new Error(`MCP server not found: ${id}`);
    this.assertEnvColumn();
    return this.readEnv(row);
  }

  // -------------------------------------------------------------------------
  // environment
  // -------------------------------------------------------------------------

  /**
   * NFR-07 — `env_json` arrives with migration 3.
   *
   * A database without it (a failed migration, a file opened without
   * `migrate()`) must fail loudly here rather than read back as "no environment
   * configured", which the panel would render as an empty value the user never
   * entered. The check is cached because the schema cannot change under a live
   * handle.
   */
  private assertEnvColumn(): void {
    if (this.hasEnvColumn !== undefined) return;
    const columns = this.db.driver.all<{ name?: string }>('PRAGMA table_info(mcp_servers)');
    this.hasEnvColumn = columns.some((column) => column.name === 'env_json');
    if (!this.hasEnvColumn) {
      throw new Error(
        `mcp_servers 没有 env_json 列（schema v${this.db.schemaVersion} < v3）：` +
          '数据库未迁移到支持环境变量的版本，已停止操作以免静默丢弃配置（NFR-07）。',
      );
    }
  }

  /**
   * What an upsert stores in `env_json`.
   *
   * Omitted keeps the stored values — an edit that only renames a server must
   * not wipe its environment, which is the same rule the secret reference
   * follows. An explicit map replaces the whole set, and an empty map stores
   * NULL: "no environment" and "an empty environment" are one fact, and a stored
   * `{}` would read back as a variable that is set.
   */
  /**
   * NFR-15 / §8.4: an MCP environment is a credential store in all but name —
   * `API_KEY`, `GITHUB_TOKEN`, `DATABASE_URL` are exactly what a stdio server
   * expects there. §8.4 requires at-rest protection for the database, and
   * `Database.encryptIfNeeded` is idempotent, so a row written before the key
   * existed still reads back correctly.
   *
   * `endpoint_json` and `secret_ref_json` are deliberately NOT encrypted: the
   * first is a command the user typed, the second is a *reference* to a secret
   * held elsewhere, and encrypting them would make the row unreadable to
   * diagnostics for no gain.
   */
  private envJsonFor(input: UpsertMcpServerInput, existing: McpRow | undefined): string | null {
    if (input.env === undefined) return existing?.env_json ?? null;
    if (Object.keys(input.env).length === 0) return null;
    // `encryptSecret`, not `encryptIfNeeded`: an API token is a few dozen bytes,
    // well under the bulk-content floor, so the latter would have stored it in
    // plaintext — the exact failure §8.4 exists to prevent.
    return this.db.encryptSecret(JSON.stringify(input.env));
  }

  /**
   * The stored values, in full. Never reachable from a DTO (NFR-01); a row that
   * cannot be parsed is an error rather than an environment that silently reads
   * back empty.
   */
  private readEnv(row: McpRow): Record<string, string> {
    if (!row.env_json) return {};
    const plain = this.db.decryptIfNeeded(row.env_json);
    let parsed: unknown;
    try {
      parsed = JSON.parse(plain);
    } catch (err) {
      throw new Error(
        `mcp_servers.env_json for ${row.id} is not readable JSON: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(`mcp_servers.env_json for ${row.id} is not a JSON object`);
    }
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      out[key] = typeof value === 'string' ? value : String(value);
    }
    return out;
  }

  /**
   * NFR-01 — the only shape in which an environment leaves this package: the
   * names that are set, each behind {@link MCP_ENV_MASK}, sorted so the panel
   * renders the same order on every read. `undefined` when nothing is stored.
   */
  private maskEnv(row: McpRow): Record<string, string> | undefined {
    const keys = Object.keys(this.readEnv(row)).sort();
    if (keys.length === 0) return undefined;
    const masked: Record<string, string> = {};
    for (const key of keys) masked[key] = MCP_ENV_MASK;
    return masked;
  }

  private toDto(row: McpRow): McpServerDto {
    this.assertEnvColumn();
    return {
      id: row.id,
      scope: row.scope as McpServerDto['scope'],
      name: row.name,
      exposure: row.exposure as McpServerDto['exposure'],
      transport: row.transport as McpServerDto['transport'],
      enabled: row.enabled === 1,
      health: (row.health as McpServerDto['health']) ?? 'unknown',
      envMasked: this.maskEnv(row),
    };
  }
}
