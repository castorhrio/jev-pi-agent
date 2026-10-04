/** §4.5 Context System + §4.6 Injection Contract + §4.7 Tool Contract. */

import { z } from 'zod';

import type { AgentManifest, ModelDescriptor } from './agent';
import type { IntelligenceStatus, CodeIntelligenceCapabilities } from './intelligence';
import type { PermissionCategory } from './permission';
import type { AppErrorCode } from './error';
import type { JsonSchema } from './common';

// ---------------------------------------------------------------------------
// 4.5.1 basic types
// ---------------------------------------------------------------------------

export type ContextItemKind =
  | 'instruction'
  | 'file'
  | 'symbol'
  | 'relation'
  | 'trace'
  | 'impact'
  | 'git_diff'
  | 'diagnostic'
  | 'handoff'
  | 'summary'
  | 'test_output';

export type ContextStrategy = 'text_first' | 'graph_first' | 'hybrid';

export interface FreshnessState {
  indexedAt?: string;
  /** git SHA or an equivalent abstraction */
  workspaceRevision?: string;
  stale: boolean;
  stalenessReason?:
    | 'dirty_worktree'
    | 'head_moved'
    | 'provider_stale'
    | 'unknown_revision';
}

export interface ContextItemSource {
  providerId: string;
  reference?: string;
  providerVersion?: string;
}

export interface ContextItem {
  id: string;
  kind: ContextItemKind;
  source: ContextItemSource;
  reason: string;
  freshness: FreshnessState;
  /** NFR-10: required, not optional. */
  estimatedTokens: number;
  /** share of this turn's budget, 0..1 */
  budgetShare: number;
  truncated: boolean;
  /** large payloads go to blob storage */
  payloadRef?: string;
  payload: unknown;
}

export type TokenEstimateSource =
  | 'provider_tokenizer'
  | 'heuristic_chars_div_4'
  | 'unknown';

export interface ContextBudget {
  maxInputTokens: number;
  reservedOutputTokens: number;
  estimateSource: TokenEstimateSource;
}

export interface ContextBudgetState {
  packId: string;
  revision: number;
  limitTokens: number;
  usedTokens: number;
  remainingTokens: number;
  estimateSource: TokenEstimateSource;
  truncated: boolean;
}

export type ContextOmitReason = 'budget' | 'dedup' | 'stale' | 'irrelevant';

export interface ContextPack {
  id: string;
  /** build = 1; every extend +1 */
  revision: number;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  strategy: ContextStrategy;
  strategyReason: string;
  items: ContextItem[];
  omitted: Array<{ itemId: string; why: ContextOmitReason }>;
  budget: ContextBudgetState;
  injection?: ContextInjectionPlan;
  createdAt: string;
  /** B3 */
  objective: string;
}

export interface ContextPackDelta {
  packId: string;
  baseRevision: number;
  revision: number;
  addedItems: ContextItem[];
  removedItemIds: string[];
  budget: ContextBudgetState;
  dropped: Array<{ itemId: string; why: ExtendDropReason }>;
  createdAt: string;
}

export type ExtendDropReason = 'budget' | 'no_match' | 'provider_unavailable';

// ---------------------------------------------------------------------------
// 4.5.2 Broker
// ---------------------------------------------------------------------------

export interface ContextBroker {
  build(input: BuildContextInput, signal?: AbortSignal): Promise<ContextPack>;
  extend(input: ExtendContextInput, signal?: AbortSignal): Promise<ContextPackDelta>;
  /** release the turn budget ledger; Main must call this at turn end. */
  release(input: { turnId: string }): Promise<void>;
}

export interface BuildContextInput {
  workspaceId: string;
  sessionId: string;
  /** allocated by Main at the session.send entry point (§5.1) */
  turnId: string;
  objective: string;
  agent: AgentManifest;
  model?: ModelDescriptor;
  budget: ContextBudget;
  strategy?: ContextStrategy | 'auto';
  openFiles?: string[];
  handoff?: ContextHandoff;
  signal?: AbortSignal;
}

export interface ExtendContextInput {
  packId: string;
  sessionId: string;
  turnId: string;
  /** 'agent_tool' = via ucad.context.extend; 'user_action' = Context Drawer */
  trigger: 'agent_tool' | 'user_action';
  request: string;
  kinds?: ContextItemKind[];
  maxItems?: number;
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// 4.5.3 TokenEstimator
// ---------------------------------------------------------------------------

export interface TokenEstimator {
  readonly source: TokenEstimateSource;
  /** MUST be monotonic: the same text always yields the same value. */
  estimate(
    text: string,
    ctx: { modelId?: string; providerId?: string },
  ): number;
}

/**
 * T-5 truncation order, step 4: drop by `kind` priority.
 * Lower index = higher priority = dropped later.
 */
export const CONTEXT_KIND_DROP_PRIORITY: ReadonlyArray<ContextItemKind> = [
  'instruction',
  'git_diff',
  'symbol',
  'relation',
  'impact',
  'trace',
  'file',
  'diagnostic',
  'test_output',
  'summary',
  'handoff',
];

// ---------------------------------------------------------------------------
// 4.6 Injection Contract
// ---------------------------------------------------------------------------

export type InjectionMode = 'prompt_prefix' | 'ucad_tools';

export type InjectionRendezvous =
  | 'system_prompt'
  | 'first_user_message'
  | 'developer_message';

export interface InjectionProfile {
  agentId: string;
  mode: InjectionMode;
  rendezvous: InjectionRendezvous;
  /** recommended true: lets the Agent cite items and request extension */
  includeItemIds: boolean;
  /** recommended true: stale must be visible (NFR-11) */
  includeFreshness: boolean;
  /** stops the index itself from eating the budget */
  maxIndexEntries: number;
  /** recommended false when mode === 'ucad_tools' */
  includeFullSlices: boolean;
}

export interface ContextInjectionPlan {
  turnId: string;
  packId: string;
  packRevision: number;
  profile: InjectionProfile;
  /** deterministic render output (I-1) */
  rendered: string;
  /** sha256(rendered) — reproducibility and audit */
  renderedHash: string;
  index: Array<{
    itemId: string;
    kind: ContextItemKind;
    ref?: string;
    stale: boolean;
    tokens: number;
  }>;
  omitted: Array<{ itemId: string; why: 'budget' | 'dedup' | 'stale' }>;
  estTokens: number;
  estimateSource: TokenEstimateSource;
}

// ---------------------------------------------------------------------------
// 4.7 Tool Contract
// ---------------------------------------------------------------------------

export interface UcadToolDefinition {
  /** namespace is always ucad.* */
  name: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  /** when false the tool must not appear in the Agent's tool list */
  available(ctx: ToolAvailabilityContext): boolean;
  /** null = no permission needed. non-null must go through the Permission Engine. */
  permissionCategory: PermissionCategory | null;
  handler(input: unknown, ctx: ToolInvocationContext): Promise<UcadToolResult>;
}

export interface ToolAvailabilityContext {
  agent: AgentManifest;
  intelligence: {
    providerId: string;
    capabilities: CodeIntelligenceCapabilities;
    status: IntelligenceStatus;
  };
  workspace: { trusted: boolean };
}

export interface ToolInvocationContext {
  sessionId: string;
  turnId: string;
  toolCallId: string;
  /** NFR-05 */
  signal: AbortSignal;
}

export interface UcadToolResult {
  toolCallId: string;
  status: 'ok' | 'error' | 'denied' | 'unsupported';
  output?: unknown;
  error?: { code: AppErrorCode; message: string };
  meta: {
    durationMs: number;
    providerId?: string;
    freshness?: FreshnessState;
  };
}

export type ToolContractBinding =
  | {
      kind: 'mcp';
      serverId: string;
      endpoint: { transport: 'stdio' | 'http'; detail: string };
    }
  | { kind: 'native_bridge'; adapterId: string; handleRef: string }
  | { kind: 'none' };

/** V1 tool set (§4.7.2). Fixed; adapters may not add or remove members. */
export const UCAD_TOOL_NAMES = [
  'ucad.context.extend',
  'ucad.context.list',
  'ucad.intelligence.search',
  'ucad.intelligence.locate',
  'ucad.intelligence.callers',
  'ucad.intelligence.impact',
  'ucad.session.handoff.get',
  'ucad.permission.request',
] as const;

export type UcadToolName = (typeof UCAD_TOOL_NAMES)[number];

/**
 * Anti shadow-privilege guard (§4.7.2): file writes, command execution and git
 * operations are explicitly NOT provided through this channel. Exported so the
 * contract test can assert it.
 */
export const UCAD_TOOL_FORBIDDEN_PATTERNS: ReadonlyArray<RegExp> = [
  /write/i,
  /edit/i,
  /delete/i,
  /remove/i,
  /exec/i,
  /shell/i,
  /command/i,
  /\brun\b/i,
  /git/i,
  /commit/i,
  /stage/i,
];

// ---------------------------------------------------------------------------
// 4.12.1 ContextHandoff
// ---------------------------------------------------------------------------

export interface ContextHandoff {
  schemaVersion: 2;
  objective: string;
  currentState: string;
  relevantFiles: Array<{ path: string; reason: string }>;
  decisions: string[];
  changes: Array<{ path: string; summary: string }>;
  commandsRun: Array<{ command: string; result: string }>;
  pendingWork: string[];
  cautions: string[];
  producedBy: { sessionId: string; turnId: string; agentId: string; at: string };
  contextRef?: { packId: string; revision: number };
  intelligenceFreshness?: FreshnessState;
}

/**
 * The runtime shape of `ContextHandoff`, for records that cross a storage
 * boundary. The interface above is compile-time only: a handoff read back from
 * SQLite was written by whatever Main version stored it, and
 * `JSON.parse(body) as ContextHandoff` proves nothing.
 *
 * `intelligenceFreshness` is deliberately `unknown`: it is optional, purely
 * informational, and the renderer already degrades field-by-field. Requiring
 * its exact shape here would make a merely-freshness-less record look corrupt.
 */
const contextHandoffSchema = z.object({
  schemaVersion: z.literal(2),
  objective: z.string(),
  currentState: z.string(),
  relevantFiles: z.array(z.object({ path: z.string(), reason: z.string() })),
  decisions: z.array(z.string()),
  changes: z.array(z.object({ path: z.string(), summary: z.string() })),
  commandsRun: z.array(z.object({ command: z.string(), result: z.string() })),
  pendingWork: z.array(z.string()),
  cautions: z.array(z.string()),
  producedBy: z.object({
    sessionId: z.string(),
    turnId: z.string(),
    agentId: z.string(),
    at: z.string(),
  }),
  contextRef: z.object({ packId: z.string(), revision: z.number() }).optional(),
  intelligenceFreshness: z.unknown().optional(),
});

/**
 * Whether `value` really is a `ContextHandoff` of the current schema version.
 *
 * Records that fail this check must not masquerade as handoffs: a v1-shaped
 * object that merely parses would otherwise flow through every consumer
 * (renderer fallbacks, `toMarkdown`, the carry-into-new-session builder)
 * rendering confident holes — sections silently missing from a document that
 * claims to be complete.
 */
export function isContextHandoff(value: unknown): value is ContextHandoff {
  return contextHandoffSchema.safeParse(value).success;
}

/**
 * Who owns a handoff right now.
 *
 * The point of the state machine (RESEARCH §2) is that "where did we leave
 * off" cannot be a convention. Without an explicit claim, two agents resuming
 * the same session each assume the work is theirs and both proceed.
 *
 *  - `open`    — produced, nobody has taken responsibility yet
 *  - `claimed` — an agent has taken it and is working from it
 *  - `done`    — the work it described is finished
 *
 * Transitions only ever move forward. Nothing moves back to `open`, because
 * "un-claiming" is indistinguishable from never having claimed and would hide
 * who actually did the work.
 */
export type HandoffState = 'open' | 'claimed' | 'done';

/**
 * One entry in a session's handoff chain: the deterministic `ContextHandoff`
 * plus the identity and lifecycle the store owns.
 *
 * These are deliberately **two types, not one**. `buildContextHandoff` is a
 * pure function of the event stream — it reads no clock and no random source,
 * and that determinism is what lets a handoff be regenerated and compared. An
 * id, a sequence number and a claim timestamp are facts about *storage*, not
 * about the replay, so they live here where they cannot contaminate it.
 */
export interface HandoffRecord {
  id: string;
  sessionId: string;
  /** 1-based, gapless, unique per session — the chain's total order. */
  sequence: number;
  state: HandoffState;
  /** The handoff this one replaces, or null for the first in the chain. */
  supersedes: string | null;
  /**
   * The handoff that replaced this one, or null while this is the latest.
   *
   * Derived by asking which row points here, never stored: a persisted
   * back-pointer can silently disagree with the chain and nothing would notice.
   */
  supersededBy: string | null;
  createdAt: string;
  claimedBy: string | null;
  claimedAt: string | null;
  completedAt: string | null;
  handoff: ContextHandoff;
}
