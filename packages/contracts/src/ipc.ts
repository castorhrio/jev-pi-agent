/** §7 IPC design: DTOs + channel names. The Renderer only ever sees these. */

import type { Unsubscribe } from './common';
import type { SessionState, TrustState } from './session-state';
import type {
  AgentManifest,
  ModelDescriptor,
  PermissionMode,
} from './agent';
import type { TurnEvent } from './events';
import type {
  ContextPack,
  ContextPackDelta,
  ContextInjectionPlan,
  ContextStrategy,
  ContextBudget,
} from './context';
import type { DecisionEngineManifest, DecisionKind, DecisionResult } from './decision';
import type {
  CodeIntelligenceManifest,
  IntelligenceOperationHandle,
  IntelligenceQueryKind,
  IntelligenceStatus,
} from './intelligence';
import type {
  PermissionDecision,
  PermissionRule,
} from './permission';
import type { SecretRef, SecretDescriptor } from './secret';
import type { UsageRecord, UsageSummaryDto } from './usage';
import type { ContextHandoff, HandoffRecord } from './context';
import type { CodeIntelligenceCapabilities } from './intelligence';
import type { AppErrorCode } from './error';

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

/**
 * The result of `providers.probe`.
 *
 * `code` is the part the UI localises; `reason` is an English, user-safe
 * sentence for logs and diagnostics. Both exist because the main process has
 * no business choosing the interface language, and a sentence alone cannot be
 * translated: before `code` was added, a Chinese provider card rendered
 * "Anthropic rejected the credential (HTTP 401). Check the API key in Settings
 * → Providers." verbatim.
 *
 * `code` is absent on success. A failure without a code means the probe failed
 * for a reason nobody classified — callers must render their own fallback
 * rather than assume one of the known states.
 */
export interface ProviderProbeResult {
  ok: boolean;
  /** English, user-safe, never contains the credential. */
  reason?: string;
  /** Stable machine-readable reason; the Renderer maps this to an i18n key. */
  code?: AppErrorCode;
  latencyMs: number;
}

export interface WorkspaceDto {
  id: string;
  path: string;
  name: string;
  trustState: TrustState;
  lastOpenedAt?: string;
}

export interface SessionDto {
  id: string;
  workspaceId: string;
  title: string;
  agentId: string;
  providerId?: string;
  modelId?: string;
  status: SessionState;
  nativeSessionId?: string;
  createdAt: string;
  updatedAt: string;
  /** lets the UI decide whether it needs events.since */
  lastSeq: number;
}

export interface CreateSessionInput {
  workspaceId: string;
  agentId: string;
  providerId?: string;
  modelId?: string;
  title?: string;
  permissionMode: PermissionMode;
}

export interface SendTurnInput {
  sessionId: string;
  objective: string;
  attachments?: Array<{ path: string; kind: 'image' | 'file' }>;
  /** explicit selection wins over a DecisionEngine route result (D-4) */
  override?: { agentId?: string; modelId?: string };
}

export interface BuildContextInputPreview {
  workspaceId: string;
  sessionId: string;
  objective: string;
  agentId: string;
  modelId?: string;
  budget?: Partial<ContextBudget>;
  strategy?: ContextStrategy | 'auto';
}

export interface GitStatusDto {
  branch: string;
  head: string;
  dirty: boolean;
  staged: Array<{ path: string; status: string }>;
  unstaged: Array<{ path: string; status: string }>;
  untracked: string[];
}

/** §8.4 — exactly one of the two; a dismissed dialog is not a failure. */
export type ExportSessionResult = { path: string; canceled?: false } | { canceled: true };

export interface GitDiffDto {
  path?: string;
  staged: boolean;
  patch: string;
  truncated: boolean;
  binary: boolean;
}

/**
 * NFR-01 — what every stored MCP environment value is replaced with on its way
 * to the Renderer. A masked value is visibly a value: an empty input next to it
 * would be indistinguishable from "set to the empty string".
 */
export const MCP_ENV_MASK = '••••••';

export interface McpServerDto {
  id: string;
  scope: 'global' | 'workspace';
  name: string;
  /** §10.1 */
  exposure: 'agent_facing' | 'ucad_internal';
  transport: 'stdio' | 'http';
  enabled: boolean;
  health: 'unknown' | 'ok' | 'error';
  toolCount?: number;
  /** the last connection test, verbatim — never a guess */
  lastError?: string;
  lastCheckedAt?: string;
  /**
   * NFR-01 — the environment variables set for this server as
   * `NAME -> MCP_ENV_MASK`, sorted by name. The values are write-only: they live
   * in `mcp_servers.env_json` and only `McpManager.resolveEnv()` (Main, when it
   * launches a stdio server) can read them back. The Renderer has no read path
   * for them and is not given one here.
   *
   * Absent means "no environment is stored", which is deliberately different
   * from an empty map: a panel must not render a stored value as a blank field
   * that looks like an empty value.
   */
  envMasked?: Record<string, string>;
}

/** §10.1 — a server as the user configures it. `secrets` are refs, never values. */
export interface UpsertMcpServerRequest {
  id?: string;
  scope: 'global' | 'workspace';
  name: string;
  exposure: 'agent_facing' | 'ucad_internal';
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  url?: string;
  /**
   * Written, never read back (NFR-01). Main stores the values and answers with
   * `envMasked`; a save that omits `env` keeps whatever is already stored
   * rather than blanking it.
   */
  env?: Record<string, string>;
  /** name of a stored secret, never the secret itself (NFR-01) */
  secretRef?: { providerId: string; key: string };
}

/** §12.1 "连接测试" — a real attempt, with a real reason when it fails. */
export interface McpTestResult {
  id: string;
  ok: boolean;
  toolCount: number;
  latencyMs: number;
  /** present exactly when `ok` is false */
  reason?: string;
  /**
   * `ok: true` is reserved for a completed `tools/list` round trip. A transport
   * that answered without confirming the protocol is `unverified` with
   * `ok: false` — we do not know the server works, and saying otherwise would
   * be a guess presented as a test result.
   */
  outcome?: 'handshake' | 'unverified' | 'unreachable';
  /** the checks that actually ran, shown verbatim so the result is auditable */
  checks?: string[];
  /** what this test did NOT establish, stated rather than left implied */
  notVerified?: string;
}

/** §8.4 — what is actually on disk right now, so a cleanup can be previewed. */
export interface StorageUsageDto {
  dbBytes: number;
  blobBytes: number;
  /**
   * Whole-database totals, not "what a purge would remove". The window's effect
   * is `expiredSessions` alone; the per-table counts describe the whole store so
   * the Storage pane can answer "how much of this is conversation".
   */
  sessions: number;
  turns: number;
  events: number;
  messages: number;
  blobFiles: number;
  /** §8.4 defaults to 90 days; `null` means "keep forever" */
  retentionDays: number | null;
  /**
   * Sessions past the window, i.e. what `scope: 'expired'` would remove right
   * now. `0` when `retentionDays` is `null` — under "keep forever" nothing is
   * expired, and reporting otherwise would be a lie.
   */
  expiredSessions: number;
  encryptionEnabled: boolean;
}

export type StoragePurgeScope = 'expired' | 'workspace' | 'all';

/**
 * §8.4 — a purge is irreversible, so the UI previews it and the user confirms.
 * `scope: 'workspace'` requires `workspaceId`; the other two ignore it.
 */
export interface StoragePurgeRequest {
  scope: StoragePurgeScope;
  workspaceId?: string;
  /** must match the preview the user saw, so a confirm cannot be stale */
  confirm: boolean;
}

export interface StoragePurgeResult {
  scope: StoragePurgeScope;
  sessionsRemoved: number;
  eventsRemoved: number;
  blobFilesRemoved: number;
  bytesReclaimed: number;
}

export interface AgentCatalogEntry {
  manifest: AgentManifest;
  /** adapter loaded and initialize() succeeded */
  available: boolean;
  unavailableReason?: string;
  /** PE-1: cannot intercept before execution => the UI must mark it restricted */
  restricted: boolean;
  models: ModelDescriptor[];
}

export interface SettingsSnapshot {
  version: number;
  /** UI language; `zh-CN` and `en-US` are the supported values */
  locale: 'zh-CN' | 'en-US';
  agent: { defaultAgentId: string; permissionMode: PermissionMode };
  /**
   * Which vendor new turns use unless the composer overrides it.
   *
   * An empty id means "no preference" — the agent or the session decides — and
   * is never a fabricated vendor id (NFR-04), exactly like `defaultAgentId`.
   * It is remembered across restarts so a user does not re-pick every launch,
   * but it is an *initial value*, not a forced one: the composer's
   * "follow agent / session" option still overrides it.
   */
  provider: { defaultProviderId: string };
  decision: {
    chain: string[];
    autoRoute: boolean;
    allowNetworkEngines: boolean;
    timeoutMs: number;
  };
  context: {
    strategy: ContextStrategy | 'auto';
    budget: ContextBudget;
    maxItemsPerPack: number;
  };
  intelligence: { defaultProviderId: string; allowAdvanced: boolean };
  storage: { retentionDays: number | null; encryptionEnabled: boolean };
  mcp: { servers: McpServerDto[] };
}

export interface FileReadResult {
  content: string;
  truncated: boolean;
  /** content hash, used for optimistic concurrency */
  revision: string;
}

export interface FileWriteResult {
  revision: string;
}

export interface FileEntry {
  name: string;
  path: string;
  kind: 'file' | 'dir';
}

export interface FileChangeNotice {
  path: string;
  operation: string;
}

export interface TerminalDataEvent {
  terminalId: string;
  chunk: string;
}

/**
 * §11.2 — whether the optional `node-pty` native module could actually be
 * loaded. `reason` is a user-safe sentence, never an empty string, so the
 * Renderer can say plainly why there is no interactive terminal instead of
 * showing an empty pane that reads as "the command produced no output".
 */
export interface PtyAvailabilityDto {
  available: boolean;
  reason: string | null;
  platform: string;
}

/** §11.2 push payload. Chunked and rate-bounded in Main (NFR-06). */
export interface PtyDataEvent {
  terminalId: string;
  chunk: string;
}

/** §11.2 push payload. A PTY reports an exit status; a pipe does not. */
export interface PtyExitEvent {
  terminalId: string;
  exitCode: number;
  signal?: number;
}

export interface ToolDescriptorDto {
  name: string;
  description: string;
  inputSchema: unknown;
  available: boolean;
  unavailableReason?: string;
  permissionCategory: string | null;
}

/**
 * One line of the log, as the Diagnostics page shows it.
 *
 * `meta` is deliberately **not** included. The logger already redacts every
 * write before it reaches a sink (NFR-08), so even the metadata is scrubbed —
 * but a diagnostics view has no use for it, and a red line is cheaper to keep
 * than to re-audit. Four fields is the whole claim: when, how bad, from where,
 * what happened. That is what someone reading this page during a bug report
 * needs, and it is why the Renderer never has to open a file on disk.
 */
export interface LogEntryDto {
  ts: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  scope: string;
  msg: string;
}

export interface DiagnosticsInfo {
  version: string;
  schemaVersion: number;
  dbPath: string;
  logDir: string;
  /** root of everything UCAD owns; the UI opens this folder for support */
  userDataDir: string;
  platform: string;
  encryptionEnabled: boolean;
  /** the active UI language, so the renderer does not have to guess */
  locale: string;
  electron: string;
  node: string;
  /** NFR-15 honesty: WASM SQLite cannot do WAL, and the UI shows the real mode */
  journalMode: string;
  /**
   * The most recent log lines, newest first.
   *
   * This is the difference between a diagnostics page and a directory listing.
   * A renderer crash - a panel throwing, a preload that failed to load - is
   * written to the log by Main and previously reachable *only* by opening a
   * file and finding it, which is exactly the step a user reporting a bug will
   * not do.
   */
  recentLog: LogEntryDto[];
}

/**
 * A provider as the Renderer sees it. The `models` list is the built-in
 * catalogue; `ModelDescriptor`s for the live catalogue arrive separately
 * through `providers.models()` so opening Settings never waits on a network
 * round trip.
 */
export interface ProviderDescriptorDto {
  id: string;
  displayName: string;
  baseUrl: string;
  transport: 'openai_compatible' | 'anthropic_messages' | 'unsupported';
  requiresApiKey: boolean;
  /** key name inside the vault, so the UI knows what to label the input */
  secretKey: string;
  /** built-in catalogue, so Settings renders without waiting on a round trip */
  models: ModelDescriptor[];
  capabilities: {
    streaming: boolean;
    toolCalls: boolean;
    jsonMode: boolean;
    vision: boolean;
    tokenizer: 'provider_tokenizer' | 'heuristic_chars_div_4' | 'unknown';
  };
  /** documented quirks, shown verbatim rather than paraphrased */
  notes?: string;
  docsUrl?: string;
  verifiedAt: string;
  /** false when the transport is not implemented; the UI must say so plainly */
  supported: boolean;
}

export type UpdateState =  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'error'
  | 'unsupported';

export interface UpdateStatus {
  state: UpdateState;
  currentVersion: string;
  latestVersion?: string;
  notes?: string;
  /** 0..1, meaningful while `downloading` */
  progress?: number;
  downloadedPath?: string;
  message?: string;
  checkedAt?: string;
  /** false => no release feed is configured, and the UI says so plainly */
  feedConfigured: boolean;
}

/** The `window.ucad` surface (§7.1). */
export interface UcadApi {
  workspace: {
    open(): Promise<WorkspaceDto | null>;
    listRecent(): Promise<WorkspaceDto[]>;
    /** §12.1 Recent projects: go back to one without re-browsing the disk. */
    activate(workspaceId: string): Promise<WorkspaceDto>;
    setTrust(state: TrustState): Promise<WorkspaceDto>;
  };

  sessions: {
    create(input: CreateSessionInput): Promise<SessionDto>;
    resume(sessionId: string): Promise<SessionDto>;
    /**
     * Sessions of ONE project. Omitting the workspace returns `[]` rather than
     * every session on the machine: a sidebar that mixes projects is a sidebar
     * that can put the user in a chat for a project they did not open.
     */
    list(workspaceId?: string): Promise<SessionDto[]>;
    rename(sessionId: string, title: string): Promise<void>;
    remove(sessionId: string): Promise<void>;
    /**
     * §8.4: the file contains plaintext conversation and quoted source, so the
     * user is warned before it is written. A dismissal returns
     * `{ canceled: true }` — it is a choice, not a failure, and the Renderer
     * must be able to tell the two apart.
     */
    export(sessionId: string, format: 'json' | 'markdown'): Promise<ExportSessionResult>;
    createHandoff(sessionId: string): Promise<ContextHandoff>;
    /**
     * The session's handoff chain, newest first.
     *
     * A handoff is append-only (RESEARCH §2, supersede-not-delete), so this is
     * the only way to reach the state of the work at an earlier point. An
     * empty array is the normal answer for a session nobody handed off yet —
     * not an error.
     */
    listHandoffs(sessionId: string): Promise<HandoffRecord[]>;
    /**
     * Take responsibility for a handoff (`open` → `claimed`).
     *
     * Idempotent for the same agent; refused for a different one, which is the
     * whole point — two agents must not both believe the work is theirs.
     */
    claimHandoff(sessionId: string, handoffId: string, agentId: string): Promise<HandoffRecord>;
    /** `claimed` → `done`. Refused unless the handoff was claimed. */
    completeHandoff(sessionId: string, handoffId: string): Promise<HandoffRecord>;
    send(input: SendTurnInput): Promise<{ turnId: string }>;
    cancel(sessionId: string): Promise<void>;
    onEvent(cb: (e: TurnEvent) => void): Unsubscribe;
  };

  /** NFR-03 replay channel */
  events: {
    since(input: {
      sessionId: string;
      afterSeq: number;
      limit?: number;
    }): Promise<TurnEvent[]>;
    latestSeq(sessionId: string): Promise<number>;
  };

  agents: {
    list(): Promise<AgentCatalogEntry[]>;
    setSecret?(ref: SecretRef, value: string): Promise<void>;
  };

  permissions: {
    respond(requestId: string, decision: PermissionDecision): Promise<void>;
    listRules(scope?: 'session' | 'workspace' | 'global'): Promise<PermissionRule[]>;
    revokeRule(ruleId: string): Promise<void>;
  };

  /** one-way only — there is no read channel (NFR-01) */
  secrets: {
    set(ref: SecretRef, value: string): Promise<void>;
    remove(ref: SecretRef): Promise<void>;
    describe(ref: SecretRef): Promise<SecretDescriptor>;
  };

  files: {
    read(
      path: string,
      opts?: { maxBytes?: number },
    ): Promise<FileReadResult>;
    write(
      path: string,
      content: string,
      opts: { expectedRevision?: string },
    ): Promise<FileWriteResult>;
    list(dir: string): Promise<FileEntry[]>;
  };

  git: {
    status(workspaceId: string): Promise<GitStatusDto>;
    diff(input: { path?: string; staged?: boolean }): Promise<GitDiffDto>;
    stage(paths: string[]): Promise<void>;
    unstage(paths: string[]): Promise<void>;
    discard(paths: string[]): Promise<void>;
    commit(message: string): Promise<{ sha: string }>;
  };

  terminal: {
    create(input: {
      cwd: string;
      cols: number;
      rows: number;
    }): Promise<{ terminalId: string }>;
    write(terminalId: string, data: string): Promise<void>;
    kill(terminalId: string): Promise<void>;
    onData(cb: (e: TerminalDataEvent) => void): Unsubscribe;

    /**
     * §11.2 — the interactive PTY. Separate from the piped console above and
     * from the agent shell: this is the user's own terminal, spawned in Main
     * (NFR-01). The Renderer never loads `node-pty`.
     */
    ptyStatus(): Promise<PtyAvailabilityDto>;
    ptyCreate(input: {
      cwd: string;
      cols: number;
      rows: number;
    }): Promise<{ terminalId: string }>;
    ptyWrite(terminalId: string, data: string): Promise<void>;
    ptyResize(terminalId: string, cols: number, rows: number): Promise<void>;
    ptyKill(terminalId: string): Promise<void>;
    onPtyData(cb: (e: PtyDataEvent) => void): Unsubscribe;
    onPtyExit(cb: (e: PtyExitEvent) => void): Unsubscribe;
  };

  intelligence: {
    listProviders(): Promise<CodeIntelligenceManifest[]>;
    status(workspaceId: string, providerId?: string): Promise<IntelligenceStatus>;
    index(workspaceId: string, providerId: string): Promise<IntelligenceOperationHandle>;
    refresh(workspaceId: string, providerId: string): Promise<IntelligenceOperationHandle>;
    query(input: {
      workspaceId: string;
      kind: IntelligenceQueryKind;
      input: unknown;
    }): Promise<{ operationId: string }>;
    cancel(operationId: string): Promise<{ cancelled: boolean }>;
    onEvent(cb: (e: TurnEvent) => void): Unsubscribe;
  };

  context: {
    preview(input: BuildContextInputPreview): Promise<ContextPack>;
    getPack(contextPackId: string): Promise<ContextPack>;
    extend(input: {
      packId: string;
      request: string;
      maxItems?: number;
    }): Promise<ContextPackDelta>;
    getInjection(turnId: string): Promise<ContextInjectionPlan | null>;
  };

  decision: {
    listEngines(): Promise<DecisionEngineManifest[]>;
    setChain(engineIds: string[]): Promise<void>;
    preview(input: {
      sessionId: string;
      objective: string;
      kind: DecisionKind;
    }): Promise<DecisionResult>;
    onEvent(cb: (e: TurnEvent) => void): Unsubscribe;
  };

  usage: {
    query(filter: {
      sessionId?: string;
      from?: string;
      to?: string;
    }): Promise<UsageRecord[]>;
    summary(filter: {
      workspaceId?: string;
      from?: string;
      to?: string;
    }): Promise<UsageSummaryDto>;
    onEvent(cb: (e: TurnEvent) => void): Unsubscribe;
  };

  tools: {
    list(): Promise<ToolDescriptorDto[]>;
  };

  settings: {
    get(): Promise<SettingsSnapshot>;
    patch(patch: DeepPartial<SettingsSnapshot>): Promise<SettingsSnapshot>;
  };

  diagnostics: {
    info(): Promise<DiagnosticsInfo>;
  };

  /**
   * §8.4 存储保护与保留. The user must be able to see what is on disk, choose
   * how long to keep it, and delete it — a transcript the user cannot delete is
   * a transcript the product is keeping without consent.
   */
  storage: {
    usage(): Promise<StorageUsageDto>;
    setRetention(days: number | null): Promise<SettingsSnapshot>;
    /** dry run: reports exactly what a purge would remove, removes nothing */
    previewPurge(scope: StoragePurgeScope, workspaceId?: string): Promise<StorageUsageDto>;
    purge(input: StoragePurgeRequest): Promise<StoragePurgeResult>;
    /** §8.4 blob 目录与派生数据必须一起清理 */
    collectOrphanBlobs(): Promise<{ removed: number; bytes: number }>;
  };

  /** §10 / §12.1 Settings / MCP */
  mcp: {
    list(scope?: 'global' | 'workspace' | 'workspace-scoped'): Promise<McpServerDto[]>;
    upsert(input: UpsertMcpServerRequest): Promise<McpServerDto>;
    remove(id: string): Promise<void>;
    setEnabled(id: string, enabled: boolean): Promise<McpServerDto>;
    setExposure(id: string, exposure: McpServerDto['exposure']): Promise<McpServerDto>;
    /** a real connection attempt; a failure carries the reason, never a guess */
    test(id: string): Promise<McpTestResult>;
  };

  /**
   * The native menu dispatches these commands into the UI. A desktop app that
   * cannot be driven from its own menu is not navigable for anyone who does not
   * already know the shortcuts.
   */
  menu: {
    onCommand(cb: (cmd: { command: string; payload?: unknown }) => void): Unsubscribe;
  };

  /**
   * Provider / model selection.
   *
   * A model is identified by `providerId + modelId`, never by a bare string:
   * `deepseek:deepseek-chat` and an OpenRouter route to the same model name are
   * different models with different prices and context windows.
   */
  providers: {
    list(): Promise<ProviderDescriptorDto[]>;
    /** live catalogue from the vendor, falling back to the built-in one */
    models(providerId: string): Promise<ModelDescriptor[]>;
    /** reachability check that spends no tokens and sends no prompt */
    probe(providerId: string): Promise<ProviderProbeResult>;
    /** provider ids that currently have a stored credential */
    configured(): Promise<string[]>;
  };

  app: {
    getLocale(): Promise<string>;
    setLocale(locale: 'zh-CN' | 'en-US'): Promise<string>;
    updateStatus(): Promise<UpdateStatus | null>;
    checkUpdate(): Promise<UpdateStatus>;
    downloadUpdate(): Promise<UpdateStatus>;
    installUpdate(): Promise<boolean>;
    onUpdateStatus(cb: (status: UpdateStatus) => void): Unsubscribe;
  };
}

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends Array<unknown>
    ? T[K]
    : T[K] extends object
      ? DeepPartial<T[K]>
      : T[K];
};

/** §7.2: `domain:action`. */
export const IPC_CHANNELS = {
  workspace: {
    open: 'workspace:open',
    listRecent: 'workspace:listRecent',
    activate: 'workspace:activate',
    setTrust: 'workspace:setTrust',
  },
  sessions: {
    create: 'session:create',
    resume: 'session:resume',
    list: 'session:list',
    rename: 'session:rename',
    delete: 'session:delete',
    export: 'session:export',
    createHandoff: 'session:createHandoff',
    listHandoffs: 'session:listHandoffs',
    claimHandoff: 'session:claimHandoff',
    completeHandoff: 'session:completeHandoff',
    send: 'session:send',
    cancel: 'session:cancel',
  },
  events: { since: 'events:since', latestSeq: 'events:latestSeq' },
  agents: { list: 'agents:list' },
  permissions: {
    respond: 'permissions:respond',
    listRules: 'permissions:listRules',
    revokeRule: 'permissions:revokeRule',
  },
  secrets: { set: 'secrets:set', delete: 'secrets:delete', describe: 'secrets:describe' },
  files: { read: 'files:read', write: 'files:write', list: 'files:list' },
  git: {
    status: 'git:status',
    diff: 'git:diff',
    stage: 'git:stage',
    unstage: 'git:unstage',
    discard: 'git:discard',
    commit: 'git:commit',
  },
  terminal: {
    create: 'terminal:create',
    write: 'terminal:write',
    kill: 'terminal:kill',
    /** §11.2 — the interactive PTY. Additive; the console above is untouched. */
    ptyStatus: 'terminal:ptyStatus',
    ptyCreate: 'terminal:ptyCreate',
    ptyWrite: 'terminal:ptyWrite',
    ptyResize: 'terminal:ptyResize',
    ptyKill: 'terminal:ptyKill',
  },
  intelligence: {
    listProviders: 'intelligence:listProviders',
    status: 'intelligence:status',
    index: 'intelligence:index',
    refresh: 'intelligence:refresh',
    query: 'intelligence:query',
    cancel: 'intelligence:cancel',
  },
  context: {
    preview: 'context:preview',
    getPack: 'context:getPack',
    extend: 'context:extend',
    getInjection: 'context:getInjection',
  },
  decision: {
    listEngines: 'decision:listEngines',
    setChain: 'decision:setChain',
    preview: 'decision:preview',
  },
  usage: { query: 'usage:query', summary: 'usage:summary' },
  tools: { list: 'tools:list' },
  settings: { get: 'settings:get', patch: 'settings:patch' },
  diagnostics: { info: 'diagnostics:info' },
  /** §8.4 保留策略与清理. */
  storage: {
    usage: 'storage:usage',
    setRetention: 'storage:setRetention',
    previewPurge: 'storage:previewPurge',
    purge: 'storage:purge',
    collectOrphanBlobs: 'storage:collectOrphanBlobs',
  },
  /** §10 / §12.1 Settings / MCP. */
  mcp: {
    list: 'mcp:list',
    upsert: 'mcp:upsert',
    remove: 'mcp:remove',
    setEnabled: 'mcp:setEnabled',
    setExposure: 'mcp:setExposure',
    /** the §12.1 "连接测试": actually reach the server, do not report a guess */
    test: 'mcp:test',
  },
  app: {
    locale: 'app:locale',
    setLocale: 'app:setLocale',
    updateStatus: 'app:updateStatus',
    checkUpdate: 'app:checkUpdate',
    downloadUpdate: 'app:downloadUpdate',
    installUpdate: 'app:installUpdate',
  },
  providers: {
    list: 'providers:list',
    models: 'providers:models',
    probe: 'providers:probe',
    configured: 'providers:configured',
  },
} as const;

/** Push channels: Main -> Renderer. */
export const IPC_PUSH = {
  turnEvent: 'push:turnEvent',
  terminalData: 'push:terminalData',
  /** §11.2 — the PTY's output and its exit status, distinct from the pipe. */
  ptyData: 'push:ptyData',
  ptyExit: 'push:ptyExit',
  appNotice: 'push:appNotice',
  updateStatus: 'push:updateStatus',
} as const;

export type { CodeIntelligenceCapabilities };
