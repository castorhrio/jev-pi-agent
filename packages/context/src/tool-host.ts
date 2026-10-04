/**
 * §4.7.2 — the Tool Contract host.
 *
 * This class is the boundary an Agent calls back across, which makes it the
 * most security-sensitive surface in the product: a tool here is a capability
 * UCAD hands to a model. The set is fixed at exactly the eight `ucad.*` tools
 * in `UCAD_TOOL_NAMES` — no more, no fewer, in a stable order — and **nothing
 * that writes a file, executes a command or touches git is ever exposed**
 * (anti shadow-privilege). Such a tool would let an Agent bypass the vendor's
 * own approval flow and UCAD's Permission Engine, which is exactly what §4.7.2
 * forbids.
 *
 * The second rule here is C-5: `unsupported` is a first-class answer. A
 * provider that cannot compute callers must say so, because an empty list
 * would be read as "there are no callers" — a confident, wrong answer to a
 * question the user actually asked.
 */

import type {
  AgentManifest,
  ContextInjectionPlan,
  ContextItem,
  ContextItemKind,
  ContextPackDelta,
  IntelligenceQueryKind,
  PermissionCategory,
  PermissionMode,
  PermissionRequest,
  RiskLevel,
  ToolAvailabilityContext,
  ToolContractBinding,
  ToolDescriptorDto,
  ToolInvocationContext,
  UcadToolDefinition,
  UcadToolResult,
} from '@ucad/contracts';
import { appError, UCAD_TOOL_NAMES } from '@ucad/contracts';
import { ulid } from '@ucad/observability';
import type { Logger } from '@ucad/observability';
import type {
  ContextBrokerContract,
  IntelligenceLike,
  InjectionRendererLike,
  SessionLike,
  SessionStoreLike,
  TokenEstimator,
} from './types';

/** The Permission Engine seam: one method, one decision. */
export interface PermissionEngineLike {
  evaluate(input: {
    request: PermissionRequest;
    sessionPermissionMode: PermissionMode;
    workspaceId: string;
    sessionId: string;
    workspaceTrusted: boolean;
  }): {
    outcome: 'auto_allow' | 'ask_user' | 'auto_deny';
    decision?: string;
    matchedRuleId?: string;
    risk: RiskLevel;
    reason: string;
  } | undefined;
}

export interface ToolContractHostOptions {
  broker: ContextBrokerContract;
  intelligence: IntelligenceLike;
  permissions: PermissionEngineLike;
  sessionStore: SessionStoreLike;
  logger: Logger;
  estimator: TokenEstimator;
  renderer: InjectionRendererLike;
  /** `bindingFor('mcp')`: the MCP server that carries the contract. */
  mcpServerId?: string;
  /** `bindingFor('native_bridge')`: the bridge handle the adapter can dial. */
  bridgeHandleRef?: string;
}

const CATEGORIES: ReadonlySet<PermissionCategory> = new Set<PermissionCategory>([
  'FILE_WRITE',
  'FILE_DELETE',
  'SHELL',
  'NETWORK',
  'GIT_WRITE',
  'MCP_TOOL',
  'EXTERNAL_PATH',
  'EXTERNAL_TOOL',
]);

/** `callers` / `impact` are optional provider methods (C-1/C-4). */
const OPTIONAL_METHODS: ReadonlySet<string> = new Set(['callers', 'impact']);

/** `ContextItemKind`, validated: an Agent cannot invent a kind. */
const KNOWN_KINDS: ReadonlySet<string> = new Set<ContextItemKind>([
  'instruction',
  'file',
  'symbol',
  'relation',
  'trace',
  'impact',
  'git_diff',
  'diagnostic',
  'handoff',
  'summary',
  'test_output',
]);

export class ToolContractHost {
  private readonly broker: ContextBrokerContract;
  private readonly intelligence: IntelligenceLike;
  private readonly permissions: PermissionEngineLike;
  private readonly sessionStore: SessionStoreLike;
  private readonly logger: Logger;
  private readonly renderer: InjectionRendererLike;
  private readonly mcpServerId: string;
  private readonly bridgeHandleRef: string;

  /** Built once, in `UCAD_TOOL_NAMES` order: the order is part of the contract. */
  private readonly tools: UcadToolDefinition[];

  constructor(opts: ToolContractHostOptions) {
    this.broker = opts.broker;
    this.intelligence = opts.intelligence;
    this.permissions = opts.permissions;
    this.sessionStore = opts.sessionStore;
    this.logger = opts.logger.child('tool-contract');
    this.renderer = opts.renderer;
    this.mcpServerId = opts.mcpServerId ?? 'ucad-mcp';
    this.bridgeHandleRef = opts.bridgeHandleRef ?? 'ucad-native-bridge';
    this.tools = this.buildTools();
  }

  // -------------------------------------------------------------------------
  // §4.7.2 the fixed set
  // -------------------------------------------------------------------------

  /** Available tools for this context, in a stable order. */
  list(ctx: ToolAvailabilityContext): UcadToolDefinition[] {
    return this.tools.filter((tool) => {
      try {
        return tool.available(ctx) === true;
      } catch (error) {
        this.logger.warn('tool availability check failed', { tool: tool.name, error: String(error) });
        return false;
      }
    });
  }

  /** The Drawer's view: all eight tools, with why the hidden ones are hidden. */
  describe(ctx: ToolAvailabilityContext): ToolDescriptorDto[] {
    return this.tools.map((tool) => {
      let available = false;
      let reason: string | undefined;
      try {
        available = tool.available(ctx) === true;
      } catch (error) {
        reason = `availability check failed: ${String(error)}`;
      }
      if (!available && reason === undefined) reason = this.unavailableReason(tool.name, ctx);

      return {
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        available,
        ...(reason ? { unavailableReason: reason } : {}),
        permissionCategory: tool.permissionCategory,
      };
    });
  }

  /**
   * Invokes one tool. An unknown name is `unsupported`, never a throw: a model
   * that hallucinates a tool name must get a usable answer, not a crash in the
   * middle of a turn.
   */
  async invoke(name: string, input: unknown, ctx: ToolInvocationContext): Promise<UcadToolResult> {
    const tool = this.tools.find((candidate) => candidate.name === name);
    if (!tool) {
      this.logger.warn('unknown tool requested', { name });
      return this.result(ctx, { status: 'unsupported' });
    }

    const startedAt = Date.now();
    try {
      const result = await tool.handler(input, ctx);
      // Duration is measured once, here, so every handler reports the same
      // thing and none of them has to remember a clock.
      return { ...result, meta: { ...result.meta, durationMs: Date.now() - startedAt } };
    } catch (error) {
      const elapsed = Date.now() - startedAt;
      this.logger.error('tool handler threw', { tool: name, error: String(error) });
      const failure = appError('UNKNOWN', `tool "${name}" failed`, 'context', {
        details: { reason: String(error) },
      });
      return {
        toolCallId: ctx.toolCallId,
        status: 'error',
        error: { code: failure.code, message: failure.message },
        meta: { durationMs: elapsed },
      };
    }
  }

  /** How the Agent receives the contract: MCP server, native bridge, or none. */
  bindingFor(agent: AgentManifest): ToolContractBinding {
    switch (agent.capabilities.toolContract) {
      case 'mcp':
        return { kind: 'mcp', serverId: this.mcpServerId, endpoint: { transport: 'stdio', detail: this.mcpServerId } };
      case 'native_bridge':
        return { kind: 'native_bridge', adapterId: agent.id, handleRef: this.bridgeHandleRef };
      default:
        return { kind: 'none' };
    }
  }

  // -------------------------------------------------------------------------
  // handlers
  // -------------------------------------------------------------------------

  private buildTools(): UcadToolDefinition[] {
    const byName: Record<string, UcadToolDefinition> = {
      'ucad.context.extend': {
        name: 'ucad.context.extend',
        description:
          'Request more context for the running turn. Searched with the text of `request`; the result is charged against the turn budget.',
        inputSchema: {
          type: 'object',
          properties: {
            request: { type: 'string', minLength: 1, description: 'What to look for, in plain language.' },
            packId: { type: 'string', description: 'Defaults to the current turn pack.' },
            maxItems: { type: 'integer', minimum: 1, maximum: 50 },
            kinds: { type: 'array', items: { type: 'string' } },
          },
          required: ['request'],
          additionalProperties: false,
        },
        outputSchema: this.deltaSchema(),
        // Context tools are always available: they only read what UCAD already
        // put in front of the Agent, and the budget still applies.
        available: () => true,
        permissionCategory: null,
        handler: (input, ctx) => this.contextExtend(input, ctx),
      },
      'ucad.context.list': {
        name: 'ucad.context.list',
        description: 'List the context items already attached to this turn, with kind, reference, staleness and token cost.',
        inputSchema: {
          type: 'object',
          properties: { packId: { type: 'string' } },
          additionalProperties: false,
        },
        outputSchema: this.indexSchema(),
        available: () => true,
        permissionCategory: null,
        handler: (input, ctx) => this.contextList(input, ctx),
      },
      'ucad.intelligence.search': {
        name: 'ucad.intelligence.search',
        description: 'Literal code search in the workspace. Results carry their own freshness; a stale answer is labelled, not hidden.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', minLength: 1 },
            limit: { type: 'integer', minimum: 1, maximum: 100 },
          },
          required: ['query'],
          additionalProperties: false,
        },
        outputSchema: this.querySchema(),
        available: (ctx) => ctx.intelligence.capabilities.symbolSearch,
        permissionCategory: null,
        handler: (input, ctx) => this.intelligenceQuery('search', input, ctx),
      },
      'ucad.intelligence.locate': {
        name: 'ucad.intelligence.locate',
        description: 'Locate a symbol by name: its declaration first, then its references.',
        inputSchema: {
          type: 'object',
          properties: { symbol: { type: 'string', minLength: 1 }, kind: { type: 'string' } },
          required: ['symbol'],
          additionalProperties: false,
        },
        outputSchema: this.querySchema(),
        available: (ctx) => ctx.intelligence.capabilities.definitions,
        permissionCategory: null,
        handler: (input, ctx) => this.intelligenceQuery('locate', input, ctx),
      },
      'ucad.intelligence.callers': {
        name: 'ucad.intelligence.callers',
        description: 'Callers of a location. Providers that cannot compute this answer report "unsupported" instead of an empty list.',
        inputSchema: {
          type: 'object',
          properties: {
            target: { $ref: '#/$defs/location' },
            depth: { type: 'integer', minimum: 1, maximum: 10 },
          },
          required: ['target'],
          additionalProperties: false,
          $defs: { location: { type: 'object', properties: { path: { type: 'string' }, startLine: { type: 'integer' }, endLine: { type: 'integer' } }, required: ['path', 'startLine', 'endLine'] } },
        },
        outputSchema: this.querySchema(),
        available: (ctx) => ctx.intelligence.capabilities.callers,
        permissionCategory: null,
        handler: (input, ctx) => this.intelligenceQuery('callers', input, ctx),
      },
      'ucad.intelligence.impact': {
        name: 'ucad.intelligence.impact',
        description: 'Impact of changing a location. Providers that cannot compute this answer report "unsupported" instead of an empty list.',
        inputSchema: {
          type: 'object',
          properties: {
            target: { $ref: '#/$defs/location' },
            changeKind: { type: 'string', enum: ['modify', 'delete', 'rename'] },
            depth: { type: 'integer', minimum: 1, maximum: 10 },
          },
          required: ['target'],
          additionalProperties: false,
          $defs: { location: { type: 'object', properties: { path: { type: 'string' }, startLine: { type: 'integer' }, endLine: { type: 'integer' } }, required: ['path', 'startLine', 'endLine'] } },
        },
        outputSchema: this.querySchema(),
        available: (ctx) => ctx.intelligence.capabilities.impact,
        permissionCategory: null,
        handler: (input, ctx) => this.intelligenceQuery('impact', input, ctx),
      },
      'ucad.session.handoff.get': {
        name: 'ucad.session.handoff.get',
        description: 'Read the deterministic handoff of this session: objective, decisions, changes, pending work, cautions.',
        inputSchema: {
          type: 'object',
          properties: { sessionId: { type: 'string' } },
          additionalProperties: false,
        },
        outputSchema: { type: 'object', additionalProperties: true },
        available: () => true,
        permissionCategory: null,
        handler: (input, ctx) => this.sessionHandoff(input, ctx),
      },
      'ucad.permission.request': {
        name: 'ucad.permission.request',
        description:
          'Ask UCAD to evaluate a permission request on the Agent behalf. Only available when UCAD cannot intercept the vendor natively.',
        inputSchema: {
          type: 'object',
          properties: {
            category: { type: 'string', enum: [...CATEGORIES] },
            resource: { type: 'string' },
            command: { type: 'string' },
            reason: { type: 'string' },
            sessionPermissionMode: { type: 'string', enum: ['read_only', 'ask', 'workspace_write'] },
            workspaceTrusted: { type: 'boolean' },
          },
          required: ['category'],
          additionalProperties: false,
        },
        outputSchema: {
          type: 'object',
          properties: {
            requestId: { type: 'string' },
            outcome: { type: 'string', enum: ['auto_allow', 'ask_user', 'auto_deny'] },
            risk: { type: 'string' },
            reason: { type: 'string' },
          },
          required: ['outcome', 'risk', 'reason'],
        },
        // I-5's sibling rule (§4.7.2): when the vendor already asks the user
        // before executing, UCAD does not need to — and offering it would
        // create a second, competing approval path.
        available: (ctx) => ctx.agent.capabilities.permissionCallbacks !== 'pre_execution',
        // Requiring a permission in order to ask for a permission would be
        // circular, so this tool is itself ungated by the engine.
        permissionCategory: null,
        handler: (input, ctx) => this.permissionRequest(input, ctx),
      },
    };

    // Assert the fixed set at construction: a missing or extra tool is a
    // contract violation, and failing here beats failing in an adapter.
    const built: UcadToolDefinition[] = [];
    const missing: string[] = [];
    for (const name of UCAD_TOOL_NAMES) {
      const tool = byName[name];
      if (tool) built.push(tool);
      else missing.push(name);
    }
    if (missing.length > 0 || Object.keys(byName).length !== UCAD_TOOL_NAMES.length) {
      throw appError('TOOL_CONTRACT_UNAVAILABLE', 'the ucad.* tool set is not the fixed V1 set', 'context', {
        details: { expected: [...UCAD_TOOL_NAMES], missing, built: Object.keys(byName) },
      });
    }
    return built;
  }

  private async contextExtend(input: unknown, ctx: ToolInvocationContext): Promise<UcadToolResult> {
    const args = (input ?? {}) as { request?: string; packId?: string; maxItems?: number; kinds?: string[] };
    const packId = args.packId ?? this.broker.getPackIdForTurn?.(ctx.turnId);
    if (!packId) {
      return this.result(ctx, {
        status: 'error',
        error: { code: 'STORAGE_ERROR', message: 'no context pack is attached to this turn' },
      });
    }

    const kinds = Array.isArray(args.kinds)
      ? args.kinds.filter((kind): kind is ContextItemKind => typeof kind === 'string' && KNOWN_KINDS.has(kind))
      : undefined;

    const delta: ContextPackDelta = await this.broker.extend({
      packId,
      sessionId: ctx.sessionId,
      turnId: ctx.turnId,
      trigger: 'agent_tool',
      request: typeof args.request === 'string' ? args.request : '',
      ...(kinds && kinds.length > 0 ? { kinds } : {}),
      ...(typeof args.maxItems === 'number' ? { maxItems: args.maxItems } : {}),
      signal: ctx.signal,
    });

    return this.result(ctx, {
      status: 'ok',
      output: {
        packId: delta.packId,
        revision: delta.revision,
        addedItems: delta.addedItems.map((item) => this.indexEntry(item)),
        dropped: delta.dropped,
        budget: delta.budget,
      },
    });
  }

  private async contextList(input: unknown, ctx: ToolInvocationContext): Promise<UcadToolResult> {
    const args = (input ?? {}) as { packId?: string };
    const packId = args.packId ?? this.broker.getPackIdForTurn?.(ctx.turnId);
    if (!packId) {
      return this.result(ctx, {
        status: 'error',
        error: { code: 'STORAGE_ERROR', message: 'no context pack is attached to this turn' },
      });
    }

    const pack = this.broker.getPack?.(packId) ?? null;
    if (pack) {
      return this.result(ctx, {
        status: 'ok',
        output: {
          packId: pack.id,
          revision: pack.revision,
          items: pack.items.map((item) => this.indexEntry(item)),
          budget: pack.budget,
          omitted: pack.omitted,
        },
      });
    }

    // After a restart the pack row may be all that is left; the injection plan
    // still carries the index.
    const injection: ContextInjectionPlan | null = this.broker.getInjection?.(ctx.turnId) ?? null;
    if (injection) {
      return this.result(ctx, {
        status: 'ok',
        output: { packId: injection.packId, revision: injection.packRevision, items: injection.index, budget: null, omitted: injection.omitted },
      });
    }

    return this.result(ctx, { status: 'error', error: { code: 'STORAGE_ERROR', message: `context pack "${packId}" was not found` } });
  }

  private async intelligenceQuery(
    kind: IntelligenceQueryKind,
    input: unknown,
    ctx: ToolInvocationContext,
  ): Promise<UcadToolResult> {
    const workspaceId = this.workspaceFor(ctx.sessionId);
    const providerId = this.providerIdFor(workspaceId, ctx.sessionId);
    const args = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;

    const outcome = await this.intelligence.query({
      kind,
      providerId,
      input: { workspaceId, ...args },
      signal: ctx.signal,
    });

    // C-5: `unsupported` carries NO output. An empty array here would be read
    // as "there are none", which is a different claim and a false one.
    if (outcome.status !== 'ok') {
      const unsupported = outcome.status === 'unsupported';
      this.logger.info('intelligence tool answered', {
        kind,
        status: outcome.status,
        providerId,
        reason: outcome.reason,
      });
      return this.result(ctx, {
        status: unsupported ? 'unsupported' : 'error',
        ...(unsupported
          ? {}
          : {
              error: {
                code: 'INTELLIGENCE_UNAVAILABLE' as const,
                message: outcome.reason ?? `intelligence query "${kind}" did not succeed`,
              },
            }),
        meta: { providerId, freshness: outcome.freshness },
      });
    }

    return this.result(ctx, {
      status: 'ok',
      output: outcome.result,
      meta: { providerId: outcome.providerId, freshness: outcome.freshness },
    });
  }

  private async sessionHandoff(input: unknown, ctx: ToolInvocationContext): Promise<UcadToolResult> {
    const args = (input ?? {}) as { sessionId?: string };
    const sessionId = args.sessionId ?? ctx.sessionId;
    const handoff = this.sessionStore.createHandoff(sessionId);
    return this.result(ctx, { status: 'ok', output: handoff });
  }

  private async permissionRequest(input: unknown, ctx: ToolInvocationContext): Promise<UcadToolResult> {
    const args = (input ?? {}) as {
      category?: string;
      resource?: string;
      command?: string;
      reason?: string;
      sessionPermissionMode?: PermissionMode;
      workspaceTrusted?: boolean;
    };

    if (!args.category || !CATEGORIES.has(args.category as PermissionCategory)) {
      return this.result(ctx, {
        status: 'error',
        error: { code: 'UNKNOWN', message: `unknown permission category "${String(args.category)}"` },
      });
    }

    const workspaceId = this.workspaceFor(ctx.sessionId);
    // Fail closed: an unstated trust or mode must not widen what is allowed.
    const sessionPermissionMode: PermissionMode = args.sessionPermissionMode ?? 'ask';
    const workspaceTrusted = args.workspaceTrusted === true;
    const request: PermissionRequest = {
      id: ulid('pr_'),
      sessionId: ctx.sessionId,
      turnId: ctx.turnId,
      agentId: this.agentIdFor(ctx.sessionId),
      category: args.category as PermissionCategory,
      risk: 'low',
      ...(args.resource ? { resource: args.resource } : {}),
      ...(args.command ? { command: args.command } : {}),
      ...(args.reason ? { reason: args.reason } : {}),
    };

    const evaluation = this.permissions.evaluate({
      request,
      sessionPermissionMode,
      workspaceId,
      sessionId: ctx.sessionId,
      workspaceTrusted,
    });

    if (!evaluation) {
      return this.result(ctx, {
        status: 'error',
        error: { code: 'PERMISSION_DENIED', message: 'the permission engine returned no decision' },
      });
    }

    return this.result(ctx, {
      // `ask_user` is not a denial: the request was routed to the human, and
      // the Agent is waiting on them.
      status: evaluation.outcome === 'auto_deny' ? 'denied' : 'ok',
      output: {
        requestId: request.id,
        outcome: evaluation.outcome,
        ...(evaluation.decision ? { decision: evaluation.decision } : {}),
        risk: evaluation.risk,
        reason: evaluation.reason,
      },
    });
  }

  // -------------------------------------------------------------------------
  // helpers
  // -------------------------------------------------------------------------

  private indexEntry(item: ContextItem): {
    itemId: string;
    kind: string;
    ref?: string;
    stale: boolean;
    tokens: number;
    reason: string;
  } {
    return {
      itemId: item.id,
      kind: item.kind,
      ...(item.source.reference ? { ref: item.source.reference } : {}),
      stale: item.freshness.stale === true,
      tokens: item.estimatedTokens,
      reason: item.reason,
    };
  }

  private workspaceFor(sessionId: string): string {
    try {
      const session: SessionLike | null = this.sessionStore.getSession?.(sessionId) ?? null;
      return session?.workspaceId ?? 'unknown';
    } catch {
      return 'unknown';
    }
  }

  private agentIdFor(sessionId: string): string {
    try {
      return this.sessionStore.getSession?.(sessionId)?.agentId ?? 'unknown';
    } catch {
      return 'unknown';
    }
  }

  private providerIdFor(workspaceId: string, sessionId: string): string {
    let requested: string | undefined;
    try {
      requested = this.sessionStore.getSession?.(sessionId)?.providerId;
    } catch {
      requested = undefined;
    }
    try {
      const provider = this.intelligence.resolve(requested, workspaceId);
      if (provider?.manifest?.id) return provider.manifest.id;
    } catch (error) {
      this.logger.warn('provider resolution failed; using basic', { workspaceId, error: String(error) });
    }
    return 'basic';
  }

  private result(
    ctx: ToolInvocationContext,
    parts: {
      status: UcadToolResult['status'];
      output?: unknown;
      error?: { code: NonNullable<UcadToolResult['error']>['code']; message: string };
      meta?: Partial<NonNullable<UcadToolResult['meta']>>;
    },
  ): UcadToolResult {
    return {
      toolCallId: ctx.toolCallId,
      status: parts.status,
      ...(parts.output !== undefined ? { output: parts.output } : {}),
      ...(parts.error ? { error: parts.error } : {}),
      meta: { durationMs: 0, ...(parts.meta ?? {}) },
    };
  }

  /** Why a tool is hidden, for the Drawer. Deterministic and specific. */
  private unavailableReason(name: string, ctx: ToolAvailabilityContext): string {
    if (name.startsWith('ucad.intelligence.')) {
      const method = name.slice('ucad.intelligence.'.length);
      if (OPTIONAL_METHODS.has(method) && !ctx.intelligence.capabilities[method as 'callers' | 'impact']) {
        return `provider "${ctx.intelligence.providerId}" does not implement ${method}`;
      }
      return `provider "${ctx.intelligence.providerId}" does not offer ${method}`;
    }
    if (name === 'ucad.permission.request') {
      return 'the agent already asks the user before executing (pre_execution)';
    }
    return 'not available in this context';
  }

  private deltaSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        packId: { type: 'string' },
        revision: { type: 'integer' },
        addedItems: { type: 'array', items: { type: 'object', additionalProperties: true } },
        dropped: { type: 'array', items: { type: 'object', additionalProperties: true } },
        budget: { type: 'object', additionalProperties: true },
      },
      required: ['packId', 'revision', 'addedItems', 'dropped', 'budget'],
    };
  }

  private indexSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        packId: { type: 'string' },
        revision: { type: 'integer' },
        items: { type: 'array', items: { type: 'object', additionalProperties: true } },
      },
      required: ['items'],
    };
  }

  private querySchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        freshness: { type: 'object', additionalProperties: true },
        items: { type: 'array', items: { type: 'object', additionalProperties: true } },
      },
      additionalProperties: true,
    };
  }
}

/** Exported for the contract test: the set this host will ever expose. */
export const UCAD_TOOL_CONTRACT_NAMES = UCAD_TOOL_NAMES;
