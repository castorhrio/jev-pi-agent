/**
 * §8.1 / NFR-07 — the single ordered migration set.
 *
 * `storage` owns the schema and the migration runner. Other packages own *tables*
 * only (§0 ownership table): the CREATE TABLE statements below are grouped by
 * owning package so a later migration for one package cannot silently diverge
 * from the DDL the owning package expects. One migration set, table ownership
 * enforced at the API level (`Database.driver` is scoped by convention, not by
 * SQLite).
 *
 * Versions are monotonic and never rewritten. Adding a migration means adding
 * a new entry with a higher `version`.
 */

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

/** Bootstrap only: the version table must exist before it can be read. */
export const SCHEMA_VERSION_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS schema_version(
  version    INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);`;

const MIGRATION_1_CORE = `
-- 8.1 events: the audit fact stream. The envelope stored in payload_json is
-- { "source": EventSource, "payload": <validated payload> } so that the
-- flattened source_kind column never loses information.
CREATE TABLE IF NOT EXISTS events(
  id           TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL REFERENCES sessions(id),
  turn_id      TEXT NOT NULL REFERENCES turns(id),
  seq          INTEGER NOT NULL,
  type         TEXT NOT NULL,
  source_kind  TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  UNIQUE(session_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_events_session_seq ON events(session_id, seq);
CREATE INDEX IF NOT EXISTS idx_events_turn        ON events(session_id, turn_id, seq);

-- 8.1 messages: UI projection, producer = MessageProjector (8.3). Purely
-- derived; rebuildable from events.
CREATE TABLE IF NOT EXISTS messages(
  id                TEXT PRIMARY KEY,
  session_id        TEXT NOT NULL REFERENCES sessions(id),
  turn_id           TEXT NOT NULL REFERENCES turns(id),
  role              TEXT NOT NULL,
  content_json      TEXT NOT NULL,
  produced_from_seq INTEGER,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_turn    ON messages(session_id, turn_id, created_at);

-- 8.4 / NFR-06 + NFR-15: index of offloaded payload fields. The row points at
-- the BlobStore ref that holds the full text for one (event, field) pair.
CREATE TABLE IF NOT EXISTS blobs(
  event_id   TEXT NOT NULL,
  field      TEXT NOT NULL,
  ref        TEXT NOT NULL,
  bytes      INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(event_id, field)
);
`;

const MIGRATION_2_PACKAGE_TABLES = `
-- owner: session
CREATE TABLE IF NOT EXISTS workspaces(
  id             TEXT PRIMARY KEY,
  path           TEXT NOT NULL UNIQUE,
  name           TEXT NOT NULL,
  trust_state    TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  last_opened_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions(
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  title        TEXT NOT NULL,
  agent_id     TEXT NOT NULL,
  provider_id  TEXT,
  model_id     TEXT,
  status       TEXT NOT NULL,
  handoff_json TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_workspace ON sessions(workspace_id, updated_at);

CREATE TABLE IF NOT EXISTS agent_sessions(
  id                       TEXT PRIMARY KEY,
  session_id               TEXT NOT NULL REFERENCES sessions(id),
  native_session_id        TEXT,
  adapter_id               TEXT NOT NULL,
  adapter_version          TEXT,
  resume_capability_json   TEXT,
  status                   TEXT NOT NULL,
  metadata_json            TEXT
);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_session ON agent_sessions(session_id);

CREATE TABLE IF NOT EXISTS turns(
  id                 TEXT PRIMARY KEY,
  session_id         TEXT NOT NULL REFERENCES sessions(id),
  status             TEXT NOT NULL,
  objective          TEXT,
  started_at         TEXT NOT NULL,
  completed_at       TEXT,
  interrupted_reason TEXT,
  error_code         TEXT
);
CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id, started_at);

CREATE TABLE IF NOT EXISTS decisions(
  id             TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL REFERENCES sessions(id),
  turn_id        TEXT NOT NULL REFERENCES turns(id),
  request_id     TEXT NOT NULL UNIQUE,
  kind           TEXT NOT NULL,
  outcome_json   TEXT NOT NULL,
  confidence     REAL NOT NULL,
  rationale      TEXT NOT NULL,
  engine_id      TEXT NOT NULL,
  engine_version TEXT,
  fallback_json  TEXT,
  latency_ms     INTEGER NOT NULL,
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_decisions_session ON decisions(session_id, turn_id);

CREATE TABLE IF NOT EXISTS settings(
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- owner: tool/file activity projection (8.1). No §0 owner is declared for these
-- two; they are created here because the migration set is the schema authority.
CREATE TABLE IF NOT EXISTS tool_calls(
  id             TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL REFERENCES sessions(id),
  turn_id        TEXT NOT NULL REFERENCES turns(id),
  tool_call_id   TEXT NOT NULL UNIQUE,
  name           TEXT NOT NULL,
  origin         TEXT NOT NULL,
  input_json     TEXT,
  output_ref     TEXT,
  output_preview TEXT,
  status         TEXT NOT NULL,
  duration_ms    INTEGER,
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tool_calls_turn ON tool_calls(session_id, turn_id);

CREATE TABLE IF NOT EXISTS file_changes(
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES sessions(id),
  turn_id       TEXT NOT NULL REFERENCES turns(id),
  path          TEXT NOT NULL,
  operation     TEXT NOT NULL,
  previous_path TEXT,
  diff_ref      TEXT,
  detected_by   TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_file_changes_turn ON file_changes(session_id, turn_id);

-- owner: code-intelligence
CREATE TABLE IF NOT EXISTS intelligence_providers(
  id         TEXT PRIMARY KEY,
  type       TEXT NOT NULL,
  enabled    INTEGER NOT NULL,
  config_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspace_intelligence(
  workspace_id       TEXT NOT NULL REFERENCES workspaces(id),
  provider_id        TEXT NOT NULL REFERENCES intelligence_providers(id),
  status             TEXT NOT NULL,
  degradation_json   TEXT,
  provider_version   TEXT,
  indexed_revision   TEXT,
  indexed_at         TEXT,
  metadata_json      TEXT,
  PRIMARY KEY(workspace_id, provider_id)
);

-- owner: context
CREATE TABLE IF NOT EXISTS context_packs(
  id                 TEXT PRIMARY KEY,
  workspace_id       TEXT NOT NULL REFERENCES workspaces(id),
  session_id         TEXT NOT NULL REFERENCES sessions(id),
  turn_id            TEXT NOT NULL REFERENCES turns(id),
  revision           INTEGER NOT NULL,
  strategy           TEXT NOT NULL,
  strategy_reason    TEXT NOT NULL,
  limit_tokens       INTEGER,
  used_tokens        INTEGER,
  estimate_source    TEXT,
  truncated          INTEGER NOT NULL,
  injection_mode     TEXT,
  rendered_hash      TEXT,
  rendered_text_ref  TEXT,
  created_at         TEXT NOT NULL,
  UNIQUE(id, revision)
);
CREATE INDEX IF NOT EXISTS idx_context_packs_session ON context_packs(session_id, turn_id);

CREATE TABLE IF NOT EXISTS context_items(
  id               TEXT PRIMARY KEY,
  context_pack_id  TEXT NOT NULL REFERENCES context_packs(id),
  pack_revision    INTEGER NOT NULL,
  kind             TEXT NOT NULL,
  source_provider  TEXT NOT NULL,
  source_reference TEXT,
  reason           TEXT NOT NULL,
  freshness_json   TEXT,
  estimated_tokens INTEGER NOT NULL,
  budget_share     REAL NOT NULL,
  truncated        INTEGER NOT NULL,
  payload_ref      TEXT,
  payload_json     TEXT
);
CREATE INDEX IF NOT EXISTS idx_context_items_pack ON context_items(context_pack_id, pack_revision);

-- owner: permissions
CREATE TABLE IF NOT EXISTS permission_rules(
  id           TEXT PRIMARY KEY,
  scope        TEXT NOT NULL,
  scope_ref    TEXT,
  category     TEXT NOT NULL,
  matcher_kind TEXT NOT NULL,
  matcher_value TEXT NOT NULL,
  decision     TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  created_by   TEXT
);

CREATE TABLE IF NOT EXISTS permission_audit(
  id         TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  turn_id    TEXT NOT NULL REFERENCES turns(id),
  category   TEXT NOT NULL,
  risk       TEXT NOT NULL,
  resource   TEXT,
  command    TEXT,
  decision   TEXT NOT NULL,
  decider    TEXT NOT NULL,
  decided_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_permission_audit_session ON permission_audit(session_id, turn_id);

-- owner: mcp
CREATE TABLE IF NOT EXISTS mcp_servers(
  id              TEXT PRIMARY KEY,
  scope           TEXT NOT NULL,
  scope_ref       TEXT,
  name            TEXT NOT NULL,
  exposure        TEXT NOT NULL,
  transport       TEXT NOT NULL,
  endpoint_json   TEXT NOT NULL,
  secret_ref_json TEXT,
  enabled         INTEGER NOT NULL,
  health          TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

-- owner: usage
CREATE TABLE IF NOT EXISTS usage_records(
  id                  TEXT PRIMARY KEY,
  session_id          TEXT NOT NULL REFERENCES sessions(id),
  turn_id             TEXT NOT NULL REFERENCES turns(id),
  agent_id            TEXT NOT NULL,
  provider_id         TEXT,
  model_id            TEXT,
  input_tokens        INTEGER,
  output_tokens       INTEGER,
  cache_read_tokens   INTEGER,
  cache_write_tokens  INTEGER,
  cost_usd            REAL,
  duration_ms         INTEGER NOT NULL,
  source              TEXT NOT NULL,
  created_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_records_session ON usage_records(session_id, turn_id);
`;

const MIGRATION_3_MCP_ENV = `
-- owner: mcp. A stdio MCP server is very often a wrapper that needs its own
-- environment (a token, a proxy, a PATH); without a column for it the
-- mcp:upsert handler had nowhere to put the values and refused a non-empty env.
--
-- Nullable, so an existing row keeps working and reads back as "no environment
-- stored" rather than as an empty one. The values are stored like
-- endpoint_json / secret_ref_json: plaintext inside the database file, and
-- never handed back to the Renderer (NFR-01 — see McpManager.toDto).
--
-- Plain ADD COLUMN because SQLite has no IF NOT EXISTS form. Re-running is
-- prevented by schema_version, not by idempotency: a column without its version
-- row is a damaged file, and NFR-07 wants that to fail loudly rather than be
-- papered over.
ALTER TABLE mcp_servers ADD COLUMN env_json TEXT;
`;

const MIGRATION_4_HANDOFF_HISTORY = `
-- owner: session. RESEARCH §2 (ai-memory): supersede-not-delete.
--
-- Before this, a handoff existed only as a cache in sessions.handoff_json:
-- creating a new one overwrote the old one, so the record of "where we left
-- off" at any earlier point was simply gone. The event log remained the
-- authority and nothing was destroyed *semantically*, but the artefact a user
-- or another agent would actually open was not reachable.
--
-- This table is append-only. A new handoff inserts a row that points at the
-- previous one through supersedes_id; no UPDATE ever rewrites an earlier row's
-- body, and nothing is deleted. supersededBy is deliberately NOT stored — it is
-- derived by asking which row points here, because a stored back-pointer can
-- disagree with the chain and then nothing notices.
--
-- state implements the open/claimed/done handshake, so two agents cannot both
-- believe they own the same handoff.
--
-- The UNIQUE(session_id, sequence) makes the chain order total: two handoffs
-- for one session can never claim the same position, so "the latest" is
-- unambiguous without trusting a timestamp comparison.
CREATE TABLE IF NOT EXISTS handoffs(
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES sessions(id),
  sequence      INTEGER NOT NULL,
  state         TEXT NOT NULL,
  supersedes_id TEXT REFERENCES handoffs(id),
  body_json     TEXT NOT NULL,
  claimed_by    TEXT,
  claimed_at    TEXT,
  completed_at  TEXT,
  created_at    TEXT NOT NULL,
  UNIQUE(session_id, sequence)
);
CREATE INDEX IF NOT EXISTS idx_handoffs_session ON handoffs(session_id, sequence);
CREATE INDEX IF NOT EXISTS idx_handoffs_super   ON handoffs(supersedes_id);
`;

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'storage-core', sql: MIGRATION_1_CORE },
  { version: 2, name: 'package-tables', sql: MIGRATION_2_PACKAGE_TABLES },
  { version: 3, name: 'mcp-env', sql: MIGRATION_3_MCP_ENV },
  { version: 4, name: 'handoff-history', sql: MIGRATION_4_HANDOFF_HISTORY },
];

/** Highest version the code knows how to reach. */
export const TARGET_SCHEMA_VERSION: number = MIGRATIONS.reduce(
  (max, m) => (m.version > max ? m.version : max),
  0,
);
