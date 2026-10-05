/**
 * Fixture bridge — runs the real Renderer in a plain browser.
 *
 * ## Why this exists
 *
 * The Renderer normally only works inside Electron, because its single door to
 * the outside world is the preload bridge (`window.ucad`). That made the UI
 * impossible to verify in a browser, which had three consequences:
 *
 *  1. every UI regression depended on someone remembering to open the app;
 *  2. loading / empty / error states could only be reached by breaking the real
 *     app on purpose;
 *  3. a whole class of defects went unnoticed — a menu item whose command the
 *     Renderer never handled shipped as "a button that does nothing"
 *     and every path below is the same code the real app runs.
 *
 * So: when `window.ucad` is missing, install a complete in-memory `UcadApi`
 * here instead. The Renderer code under test is the *real* one; only the
 * transport is faked.
 *
 * ## Safety
 *
 * This module is imported dynamically and only ever installs when
 * `window.ucad` is absent. In Electron the preload has already defined it, so
 * this code path is unreachable and the production bundle never changes
 * behaviour. `tests/contract/fixture-bridge.test.ts` asserts the fixture keeps
 * implementing every method of `UcadApi`, so it cannot silently rot.
 *
 * ## Scenarios
 *
 * Select with `?scenario=<name>`:
 *   `default`   a populated workspace with history (the happy path)
 *   `empty`     no workspace, no sessions — first run
 *   `loading`   every read delayed, to inspect loading states
 *   `error`     core reads reject, to inspect error states
 *   `partial`   some panels healthy, some broken (the realistic failure)
 *   `permission` a pending permission request, for the security loop
 */

import type {
  UcadApi,
  WorkspaceDto,
  SessionDto,
  AgentCatalogEntry,
  SettingsSnapshot,
  DeepPartial,
  DiagnosticsInfo,
  GitStatusDto,
  FileEntry,
  ToolDescriptorDto,
  McpServerDto,
  UsageSummaryDto,
  CodeIntelligenceManifest,
  IntelligenceStatus,
  DecisionEngineManifest,
  PermissionRule,
  TurnEvent,
  Unsubscribe,
  ExportSessionResult,
  StorageUsageDto,
  ContextHandoff,
  ContextPack,
  ContextInjectionPlan,
  HandoffRecord,
  ProviderDescriptorDto,
  TrustState,
  UpsertMcpServerRequest,
} from '@ucad/contracts';

export type Scenario =
  | 'default'
  | 'empty'
  | 'loading'
  | 'error'
  | 'partial'
  | 'permission';

export const SCENARIOS: Scenario[] = [
  'default',
  'empty',
  'loading',
  'error',
  'partial',
  'permission',
];

// ---------------------------------------------------------------------------
// seed data
// ---------------------------------------------------------------------------

const ISO = '2026-10-03T12:00:00.000Z';

const workspace: WorkspaceDto = {
  id: 'ws-1',
  path: 'C:/work/jev-pi-agent',
  name: 'jev-pi-agent',
  trustState: 'trusted',
  lastOpenedAt: ISO,
};

const sessions: SessionDto[] = [
  {
    id: 'sess-1',
    workspaceId: 'ws-1',
    title: '修复注入哈希不一致',
    agentId: 'universal',
    status: 'READY',
    createdAt: ISO,
    updatedAt: ISO,
    lastSeq: 4,
  },
  {
    id: 'sess-2',
    workspaceId: 'ws-1',
    title: 'Context Broker 预算账本',
    agentId: 'mock',
    status: 'INTERRUPTED',
    createdAt: '2026-10-02T09:00:00.000Z',
    updatedAt: '2026-10-02T10:00:00.000Z',
    lastSeq: 2,
  },
];

const agents: AgentCatalogEntry[] = [
  {
    manifest: {
      id: 'universal',
      displayName: 'Universal (any provider)',
      kind: 'universal',
      isDefaultRuntime: true,
      version: '0.1.0',
      pinned: [],
      transport: 'child_process',
      providerBinding: 'ucad_managed',
      capabilities: {
        streaming: true,
        sessionResume: true,
        modelSelection: true,
        fileTools: true,
        shellTools: true,
        permissionCallbacks: 'pre_execution',
        nativeSandbox: false,
        mcp: true,
        skills: true,
        subagents: false,
        usageReporting: 'partial',
        injectionModes: ['prompt_prefix', 'ucad_tools'],
        toolContract: 'mcp',
        contextWindowTokens: 200_000,
      },
    },
    available: true,
    restricted: false,
    models: [
      {
        id: 'gpt-4o',
        providerId: 'openai',
        displayName: 'GPT-4o',
        contextWindowTokens: 128_000,
      },
    ],
  },
  {
    manifest: {
      id: 'mock',
      displayName: 'Mock (offline, echoes input)',
      kind: 'mock',
      isDefaultRuntime: false,
      version: '0.1.0',
      pinned: [],
      transport: 'worker',
      providerBinding: 'agent_owned',
      capabilities: {
        streaming: true,
        sessionResume: false,
        modelSelection: false,
        fileTools: false,
        shellTools: false,
        permissionCallbacks: 'none',
        nativeSandbox: false,
        mcp: false,
        skills: false,
        subagents: false,
        usageReporting: 'none',
        injectionModes: ['prompt_prefix'],
        toolContract: 'none',
      },
    },
    available: true,
    restricted: false,
    models: [],
  },
];

const settings: SettingsSnapshot = {
  version: 3,
  locale: 'zh-CN',
  agent: { defaultAgentId: 'universal', permissionMode: 'ask' },
  // No remembered vendor: the composer's "follow agent / session" is the
  // default, which is what the picker shows on a fresh launch.
  provider: { defaultProviderId: '' },
  decision: {
    chain: ['rule', 'jev'],
    autoRoute: true,
    allowNetworkEngines: false,
    timeoutMs: 2000,
  },
  context: {
    strategy: 'auto',
    budget: {
      maxInputTokens: 8_000,
      reservedOutputTokens: 2_000,
      estimateSource: 'heuristic_chars_div_4',
    },
    maxItemsPerPack: 24,
  },
  intelligence: { defaultProviderId: 'basic', allowAdvanced: false },
  storage: { retentionDays: 30, encryptionEnabled: true },
  mcp: { servers: [] },
};

const diagnostics: DiagnosticsInfo = {
  version: '0.1.0',
  schemaVersion: 4,
  dbPath: 'C:/Users/dev/AppData/UCAD/ucad.db',
  logDir: 'C:/Users/dev/AppData/UCAD/logs',
  userDataDir: 'C:/Users/dev/AppData/UCAD',
  platform: 'win32',
  encryptionEnabled: true,
  locale: 'zh-CN',
  electron: '33.2.1',
  node: '20.18.0',
  // NFR-15: the fixture reports the real WASM limitation rather than a nicer lie.
  journalMode: 'delete',
  /*
   * A log tail that contains a failure, because a diagnostics page whose
   * sample data is all `info` never shows anyone what the page is *for*. The
   * entries are the shapes Main actually emits: newest first, one of each
   * level, `meta` absent — the DTO does not carry it.
   */
  recentLog: [
    {
      ts: '2026-02-11T09:14:02.418Z',
      level: 'warn',
      scope: 'ucad:agent-core',
      msg: 'listModels returns [] until a model catalogue is injected: §6.1 has no list_models frame',
    },
    {
      ts: '2026-02-11T09:13:58.902Z',
      level: 'error',
      scope: 'ucad:bootstrap',
      msg: 'renderer process gone (reason: crashed)',
    },
    {
      ts: '2026-02-11T09:13:57.140Z',
      level: 'info',
      scope: 'ucad',
      msg: 'adapter registry ready',
    },
    {
      ts: '2026-02-11T09:13:57.011Z',
      level: 'info',
      scope: 'ucad:agent-core',
      msg: 'host registered',
    },
  ],
};

const gitStatus: GitStatusDto = {
  branch: 'main',
  head: '29d143b',
  dirty: true,
  staged: [{ path: 'packages/contracts/src/ipc.ts', status: 'M' }],
  unstaged: [{ path: 'apps/desktop/src/renderer/src/App.tsx', status: 'M' }],
  untracked: ['apps/desktop/src/renderer/src/dev/notes.md'],
};

const files: FileEntry[] = [
  { name: 'packages', path: 'C:/work/jev-pi-agent/packages', kind: 'dir' },
  { name: 'apps', path: 'C:/work/jev-pi-agent/apps', kind: 'dir' },
  { name: 'README.md', path: 'C:/work/jev-pi-agent/README.md', kind: 'file' },
  { name: 'package.json', path: 'C:/work/jev-pi-agent/package.json', kind: 'file' },
];

const tools: ToolDescriptorDto[] = [
  {
    name: 'read_file',
    description: 'Read a file from the workspace',
    inputSchema: { type: 'object' },
    available: true,
    permissionCategory: 'FILE_WRITE',
  },
  {
    name: 'write_file',
    description: 'Write a file inside the workspace',
    inputSchema: { type: 'object' },
    available: true,
    permissionCategory: 'FILE_WRITE',
  },
];

const mcpServers: McpServerDto[] = [
  {
    id: 'mcp-1',
    scope: 'global',
    name: 'filesystem',
    exposure: 'agent_facing',
    transport: 'stdio',
    enabled: true,
    health: 'ok',
    toolCount: 6,
    lastCheckedAt: ISO,
  },
  {
    id: 'mcp-2',
    scope: 'workspace',
    name: 'web-search',
    exposure: 'ucad_internal',
    transport: 'http',
    enabled: false,
    health: 'unknown',
  },
];

const usage: UsageSummaryDto = {
  from: '2026-10-01T00:00:00.000Z',
  to: '2026-10-03T23:59:59.000Z',
  totalInputTokens: 48_210,
  totalOutputTokens: 9_004,
  totalCostUsd: 0.42,
  estimated: true,
  byAgent: [
    { agentId: 'universal', inputTokens: 48_210, outputTokens: 9_004, costUsd: 0.42 },
  ],
  byModel: [{ modelId: 'gpt-4o', inputTokens: 48_210, outputTokens: 9_004, costUsd: 0.42 }],
};

const providers: CodeIntelligenceManifest[] = [
  {
    id: 'basic',
    displayName: 'Basic (built-in)',
    tier: 'basic',
    version: '0.1.0',
    pinned: [],
    transport: 'in_process',
    requires: ['node'],
    capabilities: {
      symbolSearch: true,
      definitions: true,
      callers: false,
      callees: false,
      dependencyGraph: false,
      trace: false,
      impact: false,
      persistentIndex: false,
      incrementalRefresh: false,
      machineReadableOutput: true,
      tokenizer: 'heuristic_chars_div_4',
    },
    optionalMethods: [],
  },
];

const intelligenceStatus: IntelligenceStatus = {
  providerId: 'basic',
  state: 'not_indexed',
  stale: true,
  features: providers[0]!.capabilities,
  reason: 'No persistent index — Basic scans on demand.',
};

const decisionEngines: DecisionEngineManifest[] = [
  {
    id: 'rule',
    displayName: 'Rule',
    version: '1.0.0',
    sideEffects: ['none'],
    supportedKinds: ['route', 'risk', 'continue_or_stop', 'context_relevance', 'clarify'],
    timeoutMs: 500,
  },
  {
    id: 'jev',
    displayName: 'Jev (scored, abstains when unsure)',
    version: '0.1.0',
    sideEffects: ['none'],
    supportedKinds: ['route', 'risk'],
    timeoutMs: 1500,
  },
];

const permissionRules: PermissionRule[] = [
  {
    id: 'rule-1',
    scope: 'workspace',
    category: 'FILE_WRITE',
    matcher: { kind: 'prefix', value: 'src/' },
    decision: 'allow_workspace',
    createdAt: ISO,
    createdBy: 'user',
  },
];

const storageUsage: StorageUsageDto = {
  dbBytes: 4_194_304,
  blobBytes: 131_072,
  sessions: 2,
  turns: 5,
  events: 42,
  messages: 18,
  blobFiles: 3,
  retentionDays: 30,
  expiredSessions: 0,
  encryptionEnabled: true,
};

/**
 * A realistic pack and injection plan.
 *
 * These used to be `{}` — a truthy empty object. That is a degenerate answer
 * no real Main would return, and it made the context surface either crash
 * (`plan.profile.mode` on `{}`) or render nothing. A fixture that only ever
 * feeds the happy path's *shape* is not testing the shape; returning a real
 * record is what makes the surface's own code actually run under test.
 */
const contextPack = {
  packId: 'pack-1',
  revision: 1,
  objective: '修复注入哈希不一致',
  items: [
    {
      itemId: 'i1',
      kind: 'file_slice',
      ref: 'packages/context/src/broker.ts',
      reason: 'renderContextPack lives here',
      tokens: 1_820,
      stale: false,
    },
    {
      itemId: 'i2',
      kind: 'git_change',
      ref: 'apps/desktop/src/renderer/src/App.tsx',
      reason: 'the surface that crashed on an empty plan',
      tokens: 640,
      stale: false,
    },
  ],
  omitted: [
    { itemId: 'i9', reason: 'budget', kind: 'file_slice' },
  ],
} as unknown as ContextPack;

const contextInjection = {
  turnId: 'turn-1',
  packId: 'pack-1',
  packRevision: 1,
  profile: {
    agentId: 'universal',
    mode: 'prompt_prefix',
    rendezvous: 'mcp_tool',
    includeItemIds: true,
    includeFreshness: true,
    maxIndexEntries: 12,
    includeFullSlices: false,
  },
  rendered:
    '## Context\n\n- packages/context/src/broker.ts — renderContextPack lives here\n- apps/desktop/src/renderer/src/App.tsx — the surface that crashed\n',
  renderedHash: 'a3f19c7be2d8405f6c1a9e7d3b85f04c2a1d6e9b7f35c80d2a4e6b19f0c37',
  index: [
    { itemId: 'i1', kind: 'file_slice', ref: 'packages/context/src/broker.ts', stale: false, tokens: 1_820 },
    { itemId: 'i2', kind: 'git_change', ref: 'apps/desktop/src/renderer/src/App.tsx', stale: false, tokens: 640 },
  ],
  estimateSource: 'heuristic_chars_div_4',
  estTokens: 2_460,
} as unknown as ContextInjectionPlan;

const seedHandoff: ContextHandoff = {  schemaVersion: 2,
  objective: '修复注入哈希不一致',
  currentState:
    '已把 renderContextPack 的 profile 依赖改为纯函数，同输入的 renderedHash 已稳定。契约测试通过，但还没在真实仓库上跑过基准。',
  relevantFiles: [
    { path: 'packages/context/src/broker.ts', reason: 'renderContextPack 的实现所在' },
    { path: 'tests/contract/injection-contract.test.ts', reason: '断言同输入同哈希的契约测试' },
  ],
  decisions: [
    'profile 必须是不可变对象，否则哈希会随调用顺序漂移',
    '不再在渲染层做截断，截断交给预算账本',
  ],
  changes: [{ path: 'packages/context/src/broker.ts', summary: 'profile 改为只读快照' }],
  commandsRun: [{ command: 'npm test -- injection', result: '12 passed' }],
  pendingWork: ['用 57 文件真实工作区重跑一次 token 基准', '确认召回率没有下降'],
  cautions: ['WASM SQLite 无法启用 WAL，日志里会看到 journal_mode=delete，不是 bug'],
  producedBy: { sessionId: 'sess-1', turnId: 'turn-1', agentId: 'universal', at: ISO },
};

const seedEvents: TurnEvent[] = [
  {
    eventId: 'e1',
    seq: 1,
    sessionId: 'sess-1',
    turnId: 'turn-1',
    ts: ISO,
    type: 'turn.started',
    source: { kind: 'ucad' },
    payload: { objective: '修复注入哈希不一致' },
  } as unknown as TurnEvent,
  {
    eventId: 'e2',
    seq: 2,
    sessionId: 'sess-1',
    turnId: 'turn-1',
    ts: ISO,
    type: 'text.delta',
    source: { kind: 'agent', agentId: 'universal' },
    payload: { messageId: 'm1', text: '已定位到 `renderContextPack` 的 profile 依赖了可变对象。' },
  } as unknown as TurnEvent,
  {
    eventId: 'e3',
    seq: 3,
    sessionId: 'sess-1',
    turnId: 'turn-1',
    ts: ISO,
    type: 'text.delta',
    source: { kind: 'agent', agentId: 'universal' },
    payload: { messageId: 'm1', text: '改为纯函数后，同输入的 `renderedHash` 已稳定。' },
  } as unknown as TurnEvent,
  {
    eventId: 'e4',
    seq: 4,
    sessionId: 'sess-1',
    turnId: 'turn-1',
    ts: ISO,
    type: 'turn.completed',
    source: { kind: 'ucad' },
    payload: { status: 'completed' },
  } as unknown as TurnEvent,
];

/**
 * A pending permission request, replayed like any other event.
 *
 * This is the one flow where "the dialog is wired up" is not enough: the user
 * has to be able to see WHAT is being asked for and choose. A dialog that
 * renders without a category, risk or resource would still pass a smoke test
 * and still be a security problem, so the E2E asserts the content too.
 */
const permissionEvents: TurnEvent[] = [
  {
    eventId: 'p1',
    seq: 5,
    sessionId: 'sess-1',
    turnId: 'turn-2',
    ts: ISO,
    type: 'permission.requested',
    source: { kind: 'ucad' },
    payload: {
      requestId: 'req-1',
      request: {
        category: 'SHELL',
        risk: 'high',
        resource: 'C:/work/jev-pi-agent',
        command: 'rm -rf build',
        reason: '清理构建产物',
      },
    },
  } as unknown as TurnEvent,
];

// ---------------------------------------------------------------------------
// bridge
// ---------------------------------------------------------------------------

export interface FixtureHandle {
  api: UcadApi;
  emit: (e: TurnEvent) => void;
  menu: (m: { command: string; payload?: unknown }) => void;
  /**
   * Resolves once the harness has had nothing in flight for a short quiet
   * period. A measurement that must not photograph a loading frame waits on
   * this rather than on the existence of a DOM node.
   */
  idle: () => Promise<void>;
  /** Reads in flight right now; the counterpart to idle(). */
  pending: () => number;
}

/**
 * A real slice of the provider catalogue for the fixture bridge.
 *
 * The bridge used to answer `providers.list()` with `[]`, which meant the whole
 * provider card — the surface RESEARCH §1 says is the one to copy from CC
 * Switch — could never be looked at in a browser at all. These four rows are
 * picked to cover every state the status and quota columns can render:
 * healthy, no credential, exhausted quota, and not-wired-in-this-build.
 */
/**
 * A fresh three-entry handoff chain.
 *
 * Built per bridge instance rather than shared, so a click on 认领 or 标记完成
 * in the browser mutates that session's chain and nothing else — a module-level
 * array would leak between `createFixtureApi` calls and make the fixture lie
 * about a second window.
 */
function seedHandoffChain(): HandoffRecord[] {
  return [
    {
      id: 'hnd-3',
      sessionId: 'sess-1',
      sequence: 3,
      state: 'open',
      supersedes: 'hnd-2',
      supersededBy: null,
      createdAt: ISO,
      claimedBy: null,
      claimedAt: null,
      completedAt: null,
      handoff: seedHandoff,
    },
    {
      id: 'hnd-2',
      sessionId: 'sess-1',
      sequence: 2,
      state: 'claimed',
      supersedes: 'hnd-1',
      supersededBy: 'hnd-3',
      createdAt: ISO,
      claimedBy: 'universal',
      claimedAt: ISO,
      completedAt: null,
      handoff: seedHandoff,
    },
    {
      id: 'hnd-1',
      sessionId: 'sess-1',
      sequence: 1,
      state: 'done',
      supersedes: null,
      supersededBy: 'hnd-2',
      createdAt: ISO,
      claimedBy: 'universal',
      claimedAt: ISO,
      completedAt: ISO,
      handoff: seedHandoff,
    },
  ];
}

const FIXTURE_PROVIDERS: ProviderDescriptorDto[] = [
  {
    id: 'openai',
    displayName: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    transport: 'openai_compatible',
    requiresApiKey: true,
    secretKey: 'api-key',
    models: [
      { id: 'gpt-5', providerId: 'openai', displayName: 'gpt-5' },
      { id: 'gpt-5-mini', providerId: 'openai', displayName: 'gpt-5-mini' },
    ],
    capabilities: {
      streaming: true,
      toolCalls: true,
      jsonMode: true,
      vision: true,
      tokenizer: 'provider_tokenizer',
    },
    verifiedAt: '2026-01-01',
    supported: true,
  },
  {
    id: 'deepseek',
    displayName: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    transport: 'openai_compatible',
    requiresApiKey: true,
    secretKey: 'api-key',
    models: [{ id: 'deepseek-chat', providerId: 'deepseek', displayName: 'deepseek-chat' }],
    capabilities: {
      streaming: true,
      toolCalls: true,
      jsonMode: true,
      vision: false,
      tokenizer: 'provider_tokenizer',
    },
    notes: 'Fixture row: quota comes back as HTTP 402.',
    verifiedAt: '2026-01-01',
    supported: true,
  },
  {
    id: 'local',
    displayName: 'Local (Ollama / LM Studio)',
    baseUrl: 'http://127.0.0.1:11434/v1',
    transport: 'openai_compatible',
    requiresApiKey: false,
    secretKey: 'api-key',
    models: [],
    capabilities: {
      streaming: true,
      toolCalls: false,
      jsonMode: true,
      vision: false,
      tokenizer: 'heuristic_chars_div_4',
    },
    notes: 'Fixture row: no credential stored, so the probe never leaves the box.',
    verifiedAt: '2026-01-01',
    supported: true,
  },
  {
    id: 'anthropic',
    displayName: 'Anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    transport: 'unsupported',
    requiresApiKey: true,
    secretKey: 'api-key',
    models: [],
    capabilities: {
      streaming: false,
      toolCalls: false,
      jsonMode: false,
      vision: false,
      tokenizer: 'unknown',
    },
    notes: 'Fixture row: this build speaks no Anthropic wire protocol.',
    verifiedAt: '2026-01-01',
    supported: false,
  },
];

/** The verdict each fixture row's probe returns. */
const FIXTURE_PROBES: Record<string, { ok: boolean; code?: string; reason?: string; latencyMs: number }> =
  {
    openai: { ok: true, latencyMs: 214 },
    deepseek: {
      ok: false,
      code: 'BUDGET_EXCEEDED',
      reason:
        'DeepSeek refused the request for billing (HTTP 402). Check the account balance.',
      latencyMs: 386,
    },
    local: {
      ok: false,
      code: 'AUTH_REQUIRED',
      reason: 'No API key is stored for Local (Ollama / LM Studio). Add one in Settings → Providers.',
      latencyMs: 0,
    },
  };

/**
 * Builds the in-memory bridge. Exported so the contract test can assert
 * completeness without needing a DOM — the surface, not the installation, is
 * what must not rot.
 */
export function createFixtureApi(scenario: Scenario): FixtureHandle {
  const empty = scenario === 'empty';
  const slow = scenario === 'loading';
  /** Per-instance so a claim in one window cannot change another's history. */
  const handoffChain = seedHandoffChain();
  /** Mutable so a settings patch survives a reload, as the real store does. */
  let liveSettings: SettingsSnapshot = settings;

  /*
   * Per-instance mutable state for everything a write is supposed to change.
   *
   * The seeds above stay `const` and pristine, so every `createFixtureApi` call
   * starts from the same known-good data and a write in one window is invisible
   * to another.
   *
   * This exists because the alternative was a harness that **lies**: the
   * previous implementations of `setTrust`, `secrets.set`, `sessions.remove`,
   * the MCP toggles, `setRetention` and `setLocale` all accepted a write and
   * returned an unchanged object. In `dev:web` that meant the trust badge never
   * changed, a saved API key never turned a provider into "configured", and
   * the locale switcher appeared to save and then reverted — every one of them
   * reporting success. A harness that reports success while the write is
   * discarded makes the product look broken, which is worse than not having the
   * harness at all.
   *
   * It is still in-memory: a page reload rebuilds the bridge and these values
   * reset. That is a property of a browser fixture, and the README says so —
   * what must not happen is a write being silently dropped *within* a session.
   */
  const state = {
    workspace: { ...workspace },
    sessions: sessions.map((s) => ({ ...s })),
    mcpServers: mcpServers.map((s) => ({ ...s })),
    /** providerId -> secretKey, mirroring the real vault's shape. */
    secrets: new Map<string, string>(),
    retentionDays: settings.storage.retentionDays,
    locale: settings.locale as 'zh-CN' | 'en-US',
    decisionChain: [...settings.decision.chain],
  };
  const broken = scenario === 'error';
  // `partial` fails only the calls that must degrade gracefully, leaving the
  // workspace load intact — the realistic "one subsystem is down" case.
  const failCore = broken;
  const failSoft = broken || scenario === 'partial';
  const withPermission = scenario === 'permission';
  /** What `events.since` replays for this scenario. */
  const backfill = withPermission ? [...seedEvents, ...permissionEvents] : seedEvents;
  /**
   * The persisted event log, per session.
   *
   * The real store persists every event the moment it is emitted, and the
   * renderer's recovery flow (NFR-03) relies on that: a session view that
   * attaches *after* events flew by replays them with `since(0)`. A fixture
   * that emitted live events into the void and kept `since` pinned to the seed
   * therefore modeled a store that forgets — a turn sent before the renderer
   * finished subscribing vanished without a trace in `dev:web` and in any test
   * that hit the same window. Events are recorded here as they are emitted, so
   * a replay sees exactly what a real store would have kept.
   */
  const eventLog = new Map<string, TurnEvent[]>([['sess-1', [...backfill]]]);
  /** The next seq each session's stream will use. Gapless, per session. */
  const nextSeq = new Map<string, number>([['sess-1', (backfill[backfill.length - 1]?.seq ?? 0) + 1]]);

  const record = (event: TurnEvent) => {
    const log = eventLog.get(event.sessionId);
    if (log) log.push(event);
    else eventLog.set(event.sessionId, [event]);
  };

  const listeners = new Set<(e: TurnEvent) => void>();
  const menuListeners = new Set<(m: { command: string; payload?: unknown }) => void>();

  /**
   * In-flight call tracking, so a harness can tell "the app has finished
   * loading" from "the app has painted an empty shell and is still fetching".
   *
   * This exists because of a measurement that lied. The first layout probe
   * waited for the shell to appear, measured, and reported a clean 1440px — of
   * a first-run screen with no workspace and no sessions, because every read
   * was still in flight. A gate that measures a loading frame is worse than no
   * gate: it is green, and it is green about the wrong screen.
   *
   * `delay` and `boom` below are the only two ways a read reaches the harness,
   * so counting there counts every call, including the ones that fail.
   */
  let inFlight = 0;
  const idleWaiters: Array<() => void> = [];
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Long enough that a React render scheduled between two parallel reads does
   * not look like the end of loading, short enough that a gate does not wait
   * for nothing.
   */
  const IDLE_QUIET_MS = 150;

  const armIdleTimer = (): void => {
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleTimer = null;
      // A call that started while the quiet period was running means the app is
      // still working; the waiter is released by the next settle instead.
      if (inFlight > 0) return;
      const waiters = idleWaiters.splice(0, idleWaiters.length);
      for (const resolve of waiters) resolve();
    }, IDLE_QUIET_MS);
  };

  const markBusy = (): void => {
    inFlight += 1;
    if (idleTimer !== null) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };

  const markSettled = (): void => {
    inFlight = Math.max(0, inFlight - 1);
    armIdleTimer();
  };

  /**
   * Resolves once the harness has had nothing in flight for a short quiet
   * period. Exposed on the test seam, never on `UcadApi`: production has no
   * idea this exists.
   */
  const idle = (): Promise<void> =>
    new Promise<void>((resolve) => {
      idleWaiters.push(resolve);
      armIdleTimer();
    });

  /**
   * How many reads are in flight right now.
   *
   * The counterpart to `idle()`: a check that needs to catch the app *while* it
   * is still fetching waits for this to be greater than zero, which is the only
   * way to photograph the frame where panels are supposed to be saying
   * "loading" instead of nothing.
   */
  const pending = (): number => inFlight;

  const delay = async <T>(value: T, ms = 120): Promise<T> => {
    markBusy();
    try {
      return await new Promise<T>((resolve) =>
        setTimeout(() => resolve(value), slow ? ms * 12 : ms),
      );
    } finally {
      markSettled();
    }
  };

  // Rejects rather than throws. A synchronous throw here would escape the
  // caller's `await` and become an *unhandled exception* instead of a
  // rejection the renderer can catch and display — the precise failure mode
  // this harness exists to rule out.
  const boom = (what: string) => async (): Promise<never> => {
    markBusy();
    try {
      return await Promise.reject(new Error(`[fixture:${scenario}] ${what} failed`));
    } finally {
      markSettled();
    }
  };

  const emit = (event: TurnEvent) => {
    record(event);
    for (const listener of listeners) listener(event);
  };

  const menu = (message: { command: string; payload?: unknown }) => {
    for (const listener of menuListeners) listener(message);
  };

  const api: UcadApi = {
    workspace: {
      open: () => delay(state.workspace),
      listRecent: () =>
        failCore ? boom('workspace.listRecent')() : delay(empty ? [] : [state.workspace]),
      activate: () => delay(state.workspace),
      setTrust: (next: TrustState) => {
        // Trust lives on the workspace DTO, not in settings, so this only
        // touches the workspace.
        state.workspace = { ...state.workspace, trustState: next };
        return delay(state.workspace);
      },
    },

    sessions: {
      create: (input) => {
        const created: SessionDto = {
          id: `sess-${state.sessions.length + 1}`,
          workspaceId: input.workspaceId,
          title: input.title ?? '新会话',
          agentId: input.agentId,
          status: 'READY',
          createdAt: ISO,
          updatedAt: ISO,
          lastSeq: 0,
        } as SessionDto;
        // Kept so a session created in the harness is really there afterwards.
        state.sessions.push(created);
        return delay(created);
      },
      resume: () => delay({ ...state.sessions[0]!, status: 'READY' }),
      list: () =>
        // `partial` fails *only* the session list: the workspace still opens,
        // but the sidebar must say "could not read" rather than "no sessions".
        // That distinction is a V-3 requirement and had been swallowed.
        failSoft ? boom('sessions.list')() : delay(empty ? [] : state.sessions),

      rename: (id: string, title: string) => {
        const target = state.sessions.find((s) => s.id === id);
        if (target !== undefined) target.title = title;
        return delay(undefined);
      },
      remove: (id: string) => {
        // Actually removes. A `remove` that returns success and leaves the row
        // in place makes deletion look broken in the one surface where a user
        // is most likely to be checking it.
        const at = state.sessions.findIndex((s) => s.id === id);
        if (at >= 0) state.sessions.splice(at, 1);
        return delay(undefined);
      },
      export: (): Promise<ExportSessionResult> => delay({ path: 'C:/tmp/session.md' }),
      createHandoff: () => delay(seedHandoff),
      // A real chain, not a single entry, so the history affordance can be
      // looked at in a browser. `seq-2` is claimed by an agent that is still
      // working, which is the state the claim handshake exists to make visible.
      listHandoffs: (): Promise<HandoffRecord[]> => delay(handoffChain),
      // The same guards the real store enforces, so a click in the browser
      // demonstrates the rule rather than a fixture that always says yes.
      claimHandoff: (_sessionId: string, handoffId: string, claimingAgent: string) => {
        const record = handoffChain.find((r) => r.id === handoffId);
        if (record === undefined) return boom(`handoff ${handoffId}`)();
        if (record.state === 'done') return boom(`handoff ${handoffId} already done`)();
        if (record.state === 'claimed' && record.claimedBy !== claimingAgent) {
          return boom(`handoff ${handoffId} already claimed by ${record.claimedBy}`)();
        }
        if (record.state === 'claimed') return delay(record);
        record.state = 'claimed';
        record.claimedBy = claimingAgent;
        record.claimedAt = ISO;
        return delay(record);
      },
      completeHandoff: (_sessionId: string, handoffId: string) => {
        const record = handoffChain.find((r) => r.id === handoffId);
        if (record === undefined) return boom(`handoff ${handoffId}`)();
        if (record.state === 'done') return delay(record);
        if (record.state !== 'claimed') return boom(`handoff ${handoffId} not claimed`)();
        record.state = 'done';
        record.completedAt = ISO;
        return delay(record);
      },
      send: (input) => {
        const turnId = `turn-${Date.now()}`;
        const push = (type: string, payload: unknown, source: unknown) => {
          const seq = nextSeq.get(input.sessionId) ?? 1;
          nextSeq.set(input.sessionId, seq + 1);
          emit({
            eventId: `e${seq}`,
            seq,
            sessionId: input.sessionId,
            turnId,
            ts: new Date().toISOString(),
            type,
            source,
            payload,
          } as unknown as TurnEvent);
        };
        push('turn.started', { objective: input.objective }, { kind: 'ucad' });
        const text = '这是 fixture 回显的内容，用于验证流式渲染与状态。';
        // Chunked so the renderer's 60 ms coalescing path is actually exercised.
        for (const chunk of text.match(/.{1,6}/gu) ?? []) {
          push(
            'text.delta',
            { messageId: 'm-fixture', text: chunk },
            { kind: 'agent', agentId: input.override?.agentId ?? 'universal' },
          );
        }
        push('turn.completed', { status: 'completed' }, { kind: 'ucad' });
        return delay({ turnId });
      },
      cancel: () => delay(undefined),
      onEvent: (cb) => {
        listeners.add(cb);
        const un: Unsubscribe = () => {
          listeners.delete(cb);
        };
        return un;
      },
    },

    events: {
      since: (input: { sessionId: string; afterSeq: number }) =>
        failCore
          ? boom('events.since')()
          : delay(
              empty ? [] : (eventLog.get(input.sessionId) ?? []).filter((e) => e.seq > input.afterSeq),
            ),
      latestSeq: (sessionId: string) => {
        if (failCore) return boom('events.latestSeq')();
        const log = eventLog.get(sessionId) ?? [];
        return delay(log.length > 0 ? (log[log.length - 1]!.seq ?? 0) : 0);
      },
    },

    agents: { list: () => delay(agents) },

    permissions: {
      respond: () => delay(undefined),
      listRules: () =>
        failSoft ? boom('permissions.listRules')() : delay(permissionRules),
      revokeRule: () => delay(undefined),
    },

    secrets: {
      // The vault really remembers, so a key saved through the UI turns its
      // provider into "已配置" — which is the only way that flow can be checked
      // by hand. The real vault is write-only from the Renderer's side too, so
      // `describe` reports presence and never the value.
      set: ({ providerId }: { providerId: string }) => {
        state.secrets.set(providerId, 'fixture');
        return delay(undefined);
      },
      remove: ({ providerId }: { providerId: string }) => {
        state.secrets.delete(providerId);
        return delay(undefined);
      },
      describe: ({ providerId }: { providerId: string }) =>
        delay({ ref: `${providerId}:api-key`, configured: state.secrets.has(providerId) } as never),
    },

    files: {
      read: () => delay({ content: 'export const hello = 1;\n', truncated: false, revision: 'r1' }),
      write: () => delay({ revision: 'r2' }),
      list: () => delay(files),
    },

    git: {
      status: () => (failSoft ? boom('git.status')() : delay(gitStatus)),
      diff: () => delay({ staged: false, patch: '', truncated: false, binary: false }),
      stage: () => delay(undefined),
      unstage: () => delay(undefined),
      discard: () => delay(undefined),
      commit: () => delay({ sha: 'abc1234' }),
    },

    terminal: {
      create: () => delay({ terminalId: 't1' } as never),
      write: () => delay(undefined),
      kill: () => delay(undefined),
      onData: () => () => undefined,
      ptyStatus: () => delay({ available: false, reason: 'node-pty is not loaded' } as never),
      ptyCreate: () => delay({ terminalId: 'p1' } as never),
      ptyWrite: () => delay(undefined),
      ptyResize: () => delay(undefined),
      ptyKill: () => delay(undefined),
      onPtyData: () => () => undefined,
      onPtyExit: () => () => undefined,
    },

    intelligence: {
      listProviders: () =>
        failSoft ? boom('intelligence.listProviders')() : delay(providers),
      // A separate read from the list, and it fails separately: the settings
      // card reports the two outcomes on their own lines, so collapsing them
      // into one flag would leave the status cell untestable.
      status: () => (failSoft ? boom('intelligence.status')() : delay(intelligenceStatus)),
      index: () => delay({ started: true } as never),
      refresh: () => delay({ started: true } as never),
      query: () => delay({} as never),
      cancel: () => delay({ cancelled: true }),
      onEvent: () => () => undefined,
    },

    context: {
      preview: () => delay(contextPack),
      getPack: () => delay(contextPack),
      extend: () => delay({} as never),
      getInjection: () => delay(contextInjection),
    },

    decision: {
      listEngines: () =>
        failSoft ? boom('decision.listEngines')() : delay(decisionEngines),
      setChain: (chain: string[]) => {
        state.decisionChain = [...chain];
        liveSettings = {
          ...liveSettings,
          decision: { ...liveSettings.decision, chain: [...chain] },
        };
        return delay(undefined);
      },
      preview: () => delay({} as never),
      onEvent: () => () => undefined,
    },

    usage: {
      query: () => delay([]),
      summary: () => (failSoft ? boom('usage.summary')() : delay(usage)),
      onEvent: () => () => undefined,
    },

    tools: {
      // `partial` fails this too. It used to succeed always, which meant the
      // "could not read the tool list" state was unreachable in the harness —
      // and a state no test can produce is a state no test protects. That is
      // how the panel came to render a failed read as "no tools".
      list: () => (failSoft ? boom('tools.list')() : delay(tools)),
    },

    settings: {
      get: () => delay(liveSettings),
      // Deep-merges and keeps the result. The previous version accepted the
      // write and returned the unchanged object, so **every** setting silently
      // reverted on reload in `dev:web` - the locale switcher, the permission
      // mode, the decision chain. A fixture that accepts a write and forgets it
      // is worse than no fixture: the harness reports success and the product
      // looks broken.
      patch: (next: DeepPartial<SettingsSnapshot>) => {
        liveSettings = {
          ...liveSettings,
          ...next,
          agent: { ...liveSettings.agent, ...next.agent },
          provider: { ...liveSettings.provider, ...next.provider },
          decision: { ...liveSettings.decision, ...next.decision },
          context: {
            ...liveSettings.context,
            ...next.context,
            // `budget` is nested, so a one-level spread would replace the whole
            // object with a partial one whenever a single field is patched.
            budget: { ...liveSettings.context.budget, ...next.context?.budget },
          },
          intelligence: { ...liveSettings.intelligence, ...next.intelligence },
          storage: { ...liveSettings.storage, ...next.storage },
          mcp: { ...liveSettings.mcp, ...next.mcp },
          version: liveSettings.version + 1,
        };
        return delay(liveSettings);
      },
    },

    diagnostics: {
      // Fails under `partial` for the same reason as `tools.list` above: the
      // diagnostics page is the one surface whose entire value is telling the
      // user the truth, so "the truth could not be fetched" is the state that
      // most needed to be reachable — and it was the one state the harness
      // could not produce.
      info: () => (failSoft ? boom('diagnostics.info')() : delay(diagnostics)),
    },

    storage: {
      usage: () => delay(storageUsage),
      setRetention: (days: number | null) => {
        state.retentionDays = days;
        liveSettings = { ...liveSettings, storage: { ...liveSettings.storage, retentionDays: days } };
        return delay(liveSettings);
      },
      previewPurge: () => delay(storageUsage),
      purge: () =>
        delay({
          scope: 'expired',
          sessionsRemoved: 0,
          eventsRemoved: 0,
          blobFilesRemoved: 0,
          bytesReclaimed: 0,
        }),
      collectOrphanBlobs: () => delay({ removed: 0, bytes: 0 }),
    },

    mcp: {
      list: () => (failSoft ? boom('mcp.list')() : delay(state.mcpServers)),
      upsert: (input: UpsertMcpServerRequest) => {
        // `UpsertMcpServerRequest.id` is optional: no id means "create". The
        // request carries command/args/url rather than a stored endpoint blob,
        // and the DTO carries health and lastCheckedAt, which Main owns.
        const id = input.id ?? `mcp-${state.mcpServers.length + 1}`;
        const at = state.mcpServers.findIndex((s) => s.id === id);
        const base = at >= 0 ? state.mcpServers[at]! : undefined;
        const next: McpServerDto = {
          id,
          scope: input.scope,
          name: input.name,
          exposure: input.exposure,
          transport: input.transport,
          enabled: base?.enabled ?? true,
          health: base?.health ?? 'unknown',
          toolCount: base?.toolCount,
          lastError: base?.lastError,
          lastCheckedAt: base?.lastCheckedAt,
        };
        if (at >= 0) state.mcpServers[at] = next;
        else state.mcpServers.push(next);
        return delay(next);
      },
      remove: (id: string) => {
        const at = state.mcpServers.findIndex((s) => s.id === id);
        if (at >= 0) state.mcpServers.splice(at, 1);
        return delay(undefined);
      },
      setEnabled: (id: string, enabled: boolean) => {
        const target = state.mcpServers.find((s) => s.id === id);
        if (target !== undefined) target.enabled = enabled;
        return delay(target ?? state.mcpServers[0]!);
      },
      setExposure: (id: string, exposure: McpServerDto['exposure']) => {
        const target = state.mcpServers.find((s) => s.id === id);
        if (target !== undefined) target.exposure = exposure;
        return delay(target ?? state.mcpServers[0]!);
      },
      test: () =>
        delay({
          ok: true,
          outcome: 'handshake',
          checks: ['initialize', 'tools/list'],
        } as never),
    },

    menu: {
      onCommand: (cb) => {
        menuListeners.add(cb);
        const un: Unsubscribe = () => {
          menuListeners.delete(cb);
        };
        return un;
      },
    },

    providers: {
      list: () => delay(FIXTURE_PROVIDERS),
      models: () => delay([]),
      // One row per outcome the card can render, so the new status and quota
      // columns are actually visible in the browser instead of only in unit
      // tests. Keyed by provider id: probing a given vendor always gives the
      // same verdict, which is what makes the UI reproducible by hand.
      probe: (providerId: string) => {
        const outcome = FIXTURE_PROBES[providerId];
        if (outcome === undefined) {
          return delay({
            ok: false,
            code: 'UNKNOWN',
            reason: `No provider named '${providerId}' is registered.`,
            latencyMs: 0,
          } as never);
        }
        return delay(outcome as never);
      },
      // Derived from the vault, so saving a key really does mark its provider
      // as configured. It used to be a hardcoded list, which meant the whole
      // "save an API key, see the badge change" flow was unverifiable here.
      configured: () => delay([...state.secrets.keys()]),
    },

    app: {
      getLocale: () => delay(state.locale),
      // The switcher updated its own state, so the UI *looked* saved while the
      // stored preference stayed zh-CN and every later read came back Chinese.
      setLocale: (next: 'zh-CN' | 'en-US') => {
        state.locale = next;
        liveSettings = { ...liveSettings, locale: next };
        return delay(next);
      },
      updateStatus: () => delay({ state: 'idle' } as never),
      checkUpdate: () => delay({ state: 'idle' } as never),
      downloadUpdate: () => delay({ state: 'idle' } as never),
      installUpdate: () => delay({ state: 'idle' } as never),
      onUpdateStatus: () => () => undefined,
    },
  };

  return { api, emit, menu, idle, pending };
}

/** Reads the scenario from `?scenario=`; defaults to `default`. */
function scenarioFromLocation(search: string): Scenario {
  const raw = new URLSearchParams(search).get('scenario');
  return (SCENARIOS as string[]).includes(raw ?? '') ? (raw as Scenario) : 'default';
}

/**
 * Installs the fixture as `window.ucad`, but ONLY if the real preload bridge
 * is absent. In Electron this is a no-op, so the production path is untouched.
 *
 * Returns the scenario that was installed, or `null` when the real bridge was
 * already present (i.e. we are inside Electron).
 */
export function installFixtureBridge(): Scenario | null {
  if (typeof window === 'undefined') return null;
  // The real preload bridge wins. Production behaviour is never overridden.
  if (window.ucad) return null;

  const scenario = scenarioFromLocation(window.location.search);
  const { api, emit, menu, idle, pending } = createFixtureApi(scenario);

  window.ucad = api;
  // Makes the harness obvious on screen, so a fixture screenshot can never be
  // mistaken for a screenshot of the real app.
  document.documentElement.dataset.ucadFixture = scenario;

  // Test seam: lets an E2E run push an event or a menu command without going
  // through the UI, and lets a measurement wait for the app to stop fetching
  // rather than for a shell that merely exists. Scoped to the fixture so
  // production has no such hook.
  (window as unknown as Record<string, unknown>).__ucadFixture = {
    scenario,
    emit,
    menu,
    idle,
    pending,
  };

  return scenario;
}
