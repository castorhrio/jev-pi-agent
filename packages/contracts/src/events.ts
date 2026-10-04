/**
 * §4.2 TurnEvent contract (B5/B6).
 *
 * Adapters and hosts produce `InboundEventProposal` (no `seq`). Main's
 * `SessionSequencer` is the ONLY allocator of `seq` (rule E-1 / SEQ-1), and
 * admission Zod-validates the payload per `type` (SEQ-6).
 */

import { z } from 'zod';
import type { ContextItemKind, ContextStrategy, TokenEstimateSource, FreshnessState, ExtendDropReason } from './context';
import type { DecisionKind, DecisionOutcome, DecisionFallbackReason } from './decision';
import type { IntelligenceQueryKind, IntelligenceQueryStatus, OptionalIntelligenceMethod } from './intelligence';
import type { PermissionRequest, PermissionDecision, RiskLevel, PermissionCategory } from './permission';
import type { UsageRecord } from './usage';
import type { AppErrorCode, ErrorComponent } from './error';

// ---------------------------------------------------------------------------
// 4.2.2 stable event type union
// ---------------------------------------------------------------------------

export type TurnEventType =
  // session & turn
  | 'session.started'
  | 'turn.started'
  | 'turn.completed'
  | 'turn.interrupted'
  // text & reasoning
  | 'text.delta'
  | 'reasoning.delta'
  // tools
  | 'tool.started'
  | 'tool.updated'
  | 'tool.completed'
  // files & commands
  | 'file.changed'
  | 'command.started'
  | 'command.output'
  | 'command.completed'
  // permissions
  | 'permission.requested'
  | 'permission.resolved'
  // decision (B1)
  | 'decision.made'
  // context (B3 / B8)
  | 'context.pack.built'
  | 'context.pack.extended'
  // code intelligence
  | 'intelligence.query.started'
  | 'intelligence.query.completed'
  | 'intelligence.index.progress'
  | 'intelligence.index.completed'
  // usage & diagnostics
  | 'usage'
  | 'warning'
  | 'error';

export const TURN_EVENT_TYPES: ReadonlyArray<TurnEventType> = [
  'session.started',
  'turn.started',
  'turn.completed',
  'turn.interrupted',
  'text.delta',
  'reasoning.delta',
  'tool.started',
  'tool.updated',
  'tool.completed',
  'file.changed',
  'command.started',
  'command.output',
  'command.completed',
  'permission.requested',
  'permission.resolved',
  'decision.made',
  'context.pack.built',
  'context.pack.extended',
  'intelligence.query.started',
  'intelligence.query.completed',
  'intelligence.index.progress',
  'intelligence.index.completed',
  'usage',
  'warning',
  'error',
];

export const TURN_EVENT_TYPE_SET: ReadonlySet<string> = new Set(TURN_EVENT_TYPES);

export interface EventSource {
  kind: 'agent' | 'context' | 'intelligence' | 'decision' | 'ucad';
  agentId?: string;
  providerId?: string;
  engineId?: string;
  /** vendor's original event name, for diagnostics only */
  nativeType?: string;
}

export interface TurnEventBase {
  eventId: string;
  /** allocated by Main's SessionSequencer */
  seq: number;
  sessionId: string;
  turnId: string;
  /** ISO-8601 UTC */
  ts: string;
  type: TurnEventType;
  source: EventSource;
}

// ---------------------------------------------------------------------------
// payloads (all 25 defined — B5)
// ---------------------------------------------------------------------------

export interface SessionStartedPayload {
  agentId: string;
  nativeSessionId?: string;
  adapterVersion?: string;
  /** false = a new native session was created */
  resumed: boolean;
}

export interface TurnStartedPayload {
  objective: string;
  queuedAfter?: string;
}

export interface TurnCompletedPayload {
  status: 'completed' | 'failed' | 'cancelled';
  durationMs: number;
  messageId?: string;
}

export interface TurnInterruptedPayload {
  reason: 'host_exited' | 'host_unresponsive' | 'app_crash_recovery' | 'user_stop_timeout';
  lastSeq: number;
  recoverable: boolean;
}

export interface TextDeltaPayload {
  text: string;
  messageId: string;
}

export interface ReasoningDeltaPayload {
  text: string;
  redacted: boolean;
}

export interface ToolStartedPayload {
  toolCallId: string;
  name: string;
  input: unknown;
  /** 'ucad' = invoked through the Tool Contract */
  origin: 'vendor' | 'ucad';
}

export interface ToolUpdatedPayload {
  toolCallId: string;
  progress?: string;
  partialOutput?: string;
}

export interface ToolCompletedPayload {
  toolCallId: string;
  status: 'ok' | 'error' | 'denied';
  /** large output goes to blob storage */
  outputRef?: string;
  outputPreview?: string;
  durationMs: number;
}

export interface FileChangedPayload {
  path: string;
  operation: 'create' | 'modify' | 'delete' | 'rename';
  diffRef?: string;
  previousPath?: string;
  detectedBy: 'vendor_event' | 'watcher';
}

export interface CommandStartedPayload {
  commandId: string;
  command: string;
  cwd: string;
  shell: string;
}

export interface CommandOutputPayload {
  commandId: string;
  stream: 'stdout' | 'stderr';
  chunk: string;
  truncated: boolean;
}

export interface CommandCompletedPayload {
  commandId: string;
  exitCode: number | null;
  durationMs: number;
}

export interface PermissionRequestedPayload {
  requestId: string;
  request: PermissionRequest;
}

export interface PermissionResolvedPayload {
  requestId: string;
  decision: PermissionDecision;
  decider: 'user' | 'policy';
}

export interface DecisionMadePayload {
  requestId: string;
  kind: DecisionKind;
  outcome: DecisionOutcome;
  confidence: number;
  rationale: string;
  engineId: string;
  fallback?: { used: true; reason: DecisionFallbackReason };
}

export interface ContextPackBuiltPayload {
  packId: string;
  revision: number;
  strategy: ContextStrategy;
  strategyReason: string;
  itemCount: number;
  omittedCount: number;
  estimatedTokens: number;
  estimateSource: TokenEstimateSource;
  renderedHash: string;
  injectionMode: 'prompt_prefix' | 'ucad_tools';
}

export interface ContextPackExtendedPayload {
  packId: string;
  revision: number;
  trigger: 'agent_tool' | 'user_action';
  addedItemIds: string[];
  addedTokens: number;
  remainingTokens: number;
  dropped: Array<{ itemId: string; why: ExtendDropReason }>;
}

export interface IntelligenceQueryStartedPayload {
  operationId: string;
  providerId: string;
  queryKind: IntelligenceQueryKind;
}

export interface IntelligenceQueryCompletedPayload {
  operationId: string;
  providerId: string;
  queryKind: IntelligenceQueryKind;
  resultCount: number;
  freshness: FreshnessState;
  durationMs: number;
  status: IntelligenceQueryStatus;
}

export interface IntelligenceIndexProgressPayload {
  operationId: string;
  providerId: string;
  staged: string;
  completed: number;
  total?: number;
  percent?: number;
}

export interface IntelligenceIndexCompletedPayload {
  operationId: string;
  providerId: string;
  status: 'ok' | 'cancelled' | 'error';
  indexedRevision?: string;
  durationMs: number;
  errorCode?: AppErrorCode;
}

export interface UsagePayload {
  record: UsageRecord;
}

export interface WarningPayload {
  code: string;
  message: string;
  detail?: unknown;
}

export interface ErrorPayload {
  code: AppErrorCode;
  message: string;
  retryable: boolean;
  component: ErrorComponent;
  vendor?: { name: string; code?: string; nativeType?: string };
  detail?: unknown;
}

export interface TurnEventOf<T extends TurnEventType, P> extends TurnEventBase {
  type: T;
  payload: P;
}

export type TurnEvent =
  | TurnEventOf<'session.started', SessionStartedPayload>
  | TurnEventOf<'turn.started', TurnStartedPayload>
  | TurnEventOf<'turn.completed', TurnCompletedPayload>
  | TurnEventOf<'turn.interrupted', TurnInterruptedPayload>
  | TurnEventOf<'text.delta', TextDeltaPayload>
  | TurnEventOf<'reasoning.delta', ReasoningDeltaPayload>
  | TurnEventOf<'tool.started', ToolStartedPayload>
  | TurnEventOf<'tool.updated', ToolUpdatedPayload>
  | TurnEventOf<'tool.completed', ToolCompletedPayload>
  | TurnEventOf<'file.changed', FileChangedPayload>
  | TurnEventOf<'command.started', CommandStartedPayload>
  | TurnEventOf<'command.output', CommandOutputPayload>
  | TurnEventOf<'command.completed', CommandCompletedPayload>
  | TurnEventOf<'permission.requested', PermissionRequestedPayload>
  | TurnEventOf<'permission.resolved', PermissionResolvedPayload>
  | TurnEventOf<'decision.made', DecisionMadePayload>
  | TurnEventOf<'context.pack.built', ContextPackBuiltPayload>
  | TurnEventOf<'context.pack.extended', ContextPackExtendedPayload>
  | TurnEventOf<'intelligence.query.started', IntelligenceQueryStartedPayload>
  | TurnEventOf<'intelligence.query.completed', IntelligenceQueryCompletedPayload>
  | TurnEventOf<'intelligence.index.progress', IntelligenceIndexProgressPayload>
  | TurnEventOf<'intelligence.index.completed', IntelligenceIndexCompletedPayload>
  | TurnEventOf<'usage', UsagePayload>
  | TurnEventOf<'warning', WarningPayload>
  | TurnEventOf<'error', ErrorPayload>;

/** Distributive so it resolves correctly for an unresolved generic T. */
export type TurnEventPayloadOf<T extends TurnEventType> = T extends TurnEventType
  ? Extract<TurnEvent, { type: T }>['payload']
  : never;

export type TurnEventOfType<T extends TurnEventType> = Extract<TurnEvent, { type: T }>;

/**
 * Host-side product. No `seq`, no `sessionId` beyond the turn. Becomes a
 * `TurnEvent` only after Main admission.
 */
export interface InboundEventProposal {
  /** host-local ordering, diagnostics only — never persisted, never compared across hosts (E-2) */
  hostSeq: number;
  turnId: string;
  type: TurnEventType;
  source: EventSource;
  /** validated by Main with Zod, per type */
  payload: unknown;
  ts: string;
}

// ---------------------------------------------------------------------------
// Zod payload schemas (admission validation, SEQ-6)
// ---------------------------------------------------------------------------

const iso = z.string().min(1);
const unknownRecord = z.unknown();

export const freshNessSchema = z.object({
  indexedAt: z.string().optional(),
  workspaceRevision: z.string().optional(),
  stale: z.boolean(),
  stalenessReason: z
    .enum(['dirty_worktree', 'head_moved', 'provider_stale', 'unknown_revision'])
    .optional(),
});

export const payloadSchemas = {
  'session.started': z.object({
    agentId: z.string().min(1),
    nativeSessionId: z.string().optional(),
    adapterVersion: z.string().optional(),
    resumed: z.boolean(),
  }),
  'turn.started': z.object({
    objective: z.string(),
    queuedAfter: z.string().optional(),
  }),
  'turn.completed': z.object({
    status: z.enum(['completed', 'failed', 'cancelled']),
    durationMs: z.number().nonnegative(),
    messageId: z.string().optional(),
  }),
  'turn.interrupted': z.object({
    reason: z.enum([
      'host_exited',
      'host_unresponsive',
      'app_crash_recovery',
      'user_stop_timeout',
    ]),
    lastSeq: z.number().int().nonnegative(),
    recoverable: z.boolean(),
  }),
  'text.delta': z.object({
    text: z.string(),
    messageId: z.string().min(1),
  }),
  'reasoning.delta': z.object({
    text: z.string(),
    redacted: z.boolean(),
  }),
  'tool.started': z.object({
    toolCallId: z.string().min(1),
    name: z.string().min(1),
    input: unknownRecord,
    origin: z.enum(['vendor', 'ucad']),
  }),
  'tool.updated': z.object({
    toolCallId: z.string().min(1),
    progress: z.string().optional(),
    partialOutput: z.string().optional(),
  }),
  'tool.completed': z.object({
    toolCallId: z.string().min(1),
    status: z.enum(['ok', 'error', 'denied']),
    outputRef: z.string().optional(),
    outputPreview: z.string().optional(),
    durationMs: z.number().nonnegative(),
  }),
  'file.changed': z.object({
    path: z.string().min(1),
    operation: z.enum(['create', 'modify', 'delete', 'rename']),
    diffRef: z.string().optional(),
    previousPath: z.string().optional(),
    detectedBy: z.enum(['vendor_event', 'watcher']),
  }),
  'command.started': z.object({
    commandId: z.string().min(1),
    command: z.string(),
    cwd: z.string(),
    shell: z.string(),
  }),
  'command.output': z.object({
    commandId: z.string().min(1),
    stream: z.enum(['stdout', 'stderr']),
    chunk: z.string(),
    truncated: z.boolean(),
  }),
  'command.completed': z.object({
    commandId: z.string().min(1),
    exitCode: z.number().int().nullable(),
    durationMs: z.number().nonnegative(),
  }),
  'permission.requested': z.object({
    requestId: z.string().min(1),
    request: z.object({
      id: z.string().min(1),
      sessionId: z.string().min(1),
      turnId: z.string().min(1),
      agentId: z.string().min(1),
      category: z.enum([
        'FILE_WRITE',
        'FILE_DELETE',
        'SHELL',
        'NETWORK',
        'GIT_WRITE',
        'MCP_TOOL',
        'EXTERNAL_PATH',
        'EXTERNAL_TOOL',
      ]),
      risk: z.enum(['low', 'medium', 'high']),
      resource: z.string().optional(),
      command: z.string().optional(),
      mcpServerId: z.string().optional(),
      mcpToolName: z.string().optional(),
      reason: z.string().optional(),
      decisionEngineSignal: z
        .object({
          risk: z.enum(['low', 'medium', 'high']),
          confidence: z.number().min(0).max(1),
          rationale: z.string(),
        })
        .optional(),
    }),
  }),
  'permission.resolved': z.object({
    requestId: z.string().min(1),
    decision: z.enum(['allow_once', 'allow_session', 'allow_workspace', 'deny']),
    decider: z.enum(['user', 'policy']),
  }),
  'decision.made': z.object({
    requestId: z.string().min(1),
    kind: z.enum([
      'route',
      'risk',
      'continue_or_stop',
      'context_relevance',
      'clarify',
      'option_select',
    ]),
    outcome: z.object({
      kind: z.enum([
        'route',
        'risk',
        'continue_or_stop',
        'context_relevance',
        'clarify',
        'option_select',
      ]),
    }).passthrough(),
    confidence: z.number().min(0).max(1),
    rationale: z.string().min(1),
    engineId: z.string().min(1),
    fallback: z
      .object({
        used: z.literal(true),
        reason: z.enum(['timeout', 'error', 'unavailable', 'unsupported_kind']),
      })
      .optional(),
  }),
  'context.pack.built': z.object({
    packId: z.string().min(1),
    revision: z.number().int().positive(),
    strategy: z.enum(['text_first', 'graph_first', 'hybrid']),
    strategyReason: z.string(),
    itemCount: z.number().int().nonnegative(),
    omittedCount: z.number().int().nonnegative(),
    estimatedTokens: z.number().nonnegative(),
    estimateSource: z.enum([
      'provider_tokenizer',
      'heuristic_chars_div_4',
      'unknown',
    ]),
    renderedHash: z.string().min(1),
    injectionMode: z.enum(['prompt_prefix', 'ucad_tools']),
  }),
  'context.pack.extended': z.object({
    packId: z.string().min(1),
    revision: z.number().int().positive(),
    trigger: z.enum(['agent_tool', 'user_action']),
    addedItemIds: z.array(z.string()),
    addedTokens: z.number().nonnegative(),
    remainingTokens: z.number().nonnegative(),
    dropped: z.array(
      z.object({
        itemId: z.string(),
        why: z.enum(['budget', 'no_match', 'provider_unavailable']),
      }),
    ),
  }),
  'intelligence.query.started': z.object({
    operationId: z.string().min(1),
    providerId: z.string().min(1),
    queryKind: z.enum([
      'search',
      'locate',
      'overview',
      'callers',
      'callees',
      'trace',
      'impact',
    ]),
  }),
  'intelligence.query.completed': z.object({
    operationId: z.string().min(1),
    providerId: z.string().min(1),
    queryKind: z.enum([
      'search',
      'locate',
      'overview',
      'callers',
      'callees',
      'trace',
      'impact',
    ]),
    resultCount: z.number().int().nonnegative(),
    freshness: freshNessSchema,
    durationMs: z.number().nonnegative(),
    status: z.enum(['ok', 'cancelled', 'error', 'unsupported']),
  }),
  'intelligence.index.progress': z.object({
    operationId: z.string().min(1),
    providerId: z.string().min(1),
    staged: z.string(),
    completed: z.number().int().nonnegative(),
    total: z.number().int().nonnegative().optional(),
    percent: z.number().min(0).max(100).optional(),
  }),
  'intelligence.index.completed': z.object({
    operationId: z.string().min(1),
    providerId: z.string().min(1),
    status: z.enum(['ok', 'cancelled', 'error']),
    indexedRevision: z.string().optional(),
    durationMs: z.number().nonnegative(),
    errorCode: z.string().optional(),
  }),
  usage: z.object({ record: z.object({
    sessionId: z.string().min(1),
    turnId: z.string().min(1),
    agentId: z.string().min(1),
    providerId: z.string().optional(),
    modelId: z.string().optional(),
    inputTokens: z.number().optional(),
    outputTokens: z.number().optional(),
    cacheReadTokens: z.number().optional(),
    cacheWriteTokens: z.number().optional(),
    costUsd: z.number().optional(),
    durationMs: z.number().nonnegative(),
    source: z.enum(['vendor', 'computed', 'unknown']),
  }) }),
  warning: z.object({
    code: z.string().min(1),
    message: z.string(),
    detail: unknownRecord.optional(),
  }),
  error: z.object({
    code: z.string().min(1),
    message: z.string(),
    retryable: z.boolean(),
    component: z.enum([
      'agent',
      'context',
      'intelligence',
      'decision',
      'storage',
      'ipc',
    ]),
    vendor: z
      .object({
        name: z.string(),
        code: z.string().optional(),
        nativeType: z.string().optional(),
      })
      .optional(),
    detail: unknownRecord.optional(),
  }),
} satisfies Record<TurnEventType, z.ZodTypeAny>;

export type PayloadSchemaOf<T extends TurnEventType> = (typeof payloadSchemas)[T];

/** Full-event schema, used when reloading persisted events (NFR-03). */
export const eventSourceSchema = z.object({
  kind: z.enum(['agent', 'context', 'intelligence', 'decision', 'ucad']),
  agentId: z.string().optional(),
  providerId: z.string().optional(),
  engineId: z.string().optional(),
  nativeType: z.string().optional(),
});

export const inboundEventProposalSchema = z.object({
  hostSeq: z.number().int().nonnegative(),
  turnId: z.string().min(1),
  type: z.enum(TURN_EVENT_TYPES as unknown as [TurnEventType, ...TurnEventType[]]),
  source: eventSourceSchema,
  payload: unknownRecord,
  ts: iso,
});

/**
 * Validate a proposal's payload against its declared type.
 * Returns the typed payload, or null when admission must fail (SEQ-6).
 */
export function validatePayload<T extends TurnEventType>(
  type: T,
  payload: unknown,
): TurnEventPayloadOf<T> | null {
  const schema = payloadSchemas[type] as unknown as z.ZodTypeAny | undefined;
  // An unrecognised type is an admission failure, not a crash (SEQ-6).
  if (!schema) return null;
  const result = schema.safeParse(payload) as
    | { success: true; data: TurnEventPayloadOf<T> }
    | { success: false };
  return result.success ? result.data : null;
}

export type {
  ContextItemKind,
  RiskLevel,
  PermissionCategory,
  OptionalIntelligenceMethod,
};
