/** §4.4 Decision System contract (B1 / ADR-016). */

import type { AgentCapabilities, AgentManifest } from './agent';
import type { DecisionLogger } from './internal';
import type { PermissionCategory, RiskLevel } from './permission';

export type DecisionKind =
  | 'route'
  | 'risk'
  | 'continue_or_stop'
  | 'context_relevance'
  | 'clarify'
  | 'option_select';

export interface DecisionEngineManifest {
  id: string;
  displayName: string;
  version?: string;
  /** NFR-14: side effects must be declared truthfully. 'network' is off by default. */
  sideEffects: Array<'none' | 'network' | 'process'>;
  supportedKinds: DecisionKind[];
  /** suggested; Main enforces a hard upper bound */
  timeoutMs: number;
}

export interface DecisionEngine {
  readonly manifest: DecisionEngineManifest;
  initialize(ctx: DecisionInitializeContext): Promise<void>;
  supports(kind: DecisionKind): boolean;
  decide(request: DecisionRequest, signal?: AbortSignal): Promise<DecisionResult>;
  dispose(): Promise<void>;
}

export interface DecisionInitializeContext {
  workspaceId: string;
  configDir: string;
  /** what the user authorized */
  sideEffectsAllowed: Array<'network' | 'process'>;
  logger: DecisionLogger;
}

export interface DecisionRequest {
  requestId: string;
  kind: DecisionKind;
  sessionId: string;
  turnId: string;
  objective: string;
  /** read-only state summary. A DecisionEngine may not go look things up itself. */
  facts: DecisionFacts;
  options?: DecisionOption[];
  timeoutMs: number;
}

export interface DecisionFacts {
  workspace: { id: string; trusted: boolean; languageHints: string[] };
  availableAgents: Array<{
    id: string;
    kind: AgentManifest['kind'];
    isDefaultRuntime: boolean;
    capabilities: Pick<
      AgentCapabilities,
      'streaming' | 'modelSelection' | 'usageReporting'
    >;
  }>;
  availableModels: Array<{
    id: string;
    providerId: string;
    contextWindowTokens?: number;
  }>;
  /**
   * Git facts, when they could be measured. Absent means "git status did not
   * answer" — a hung repo, a non-workspace — and engines must treat it as a
   * missing signal, never as zeros: a risk decision asked to believe
   * "clean tree, 0 changes" on the strength of a failed `git status` is a
   * confident answer from a lie.
   */
  git?: { dirty: boolean; changedFiles: number; branch?: string };
  context: {
    packId?: string;
    itemCount: number;
    estimatedTokens: number;
    freshness: 'fresh' | 'stale' | 'unknown' | 'mixed';
  };
  signals: {
    consecutiveFailures: number;
    permissionDenials: number;
    elapsedMs: number;
    turnIndex: number;
  };
}

export interface DecisionOption {
  id: string;
  label: string;
  description?: string;
  metadata?: unknown;
}

export interface DecisionEvidence {
  ref: string;
  weight?: number;
}

export type DecisionFallbackReason =
  | 'timeout'
  | 'error'
  | 'unavailable'
  | 'unsupported_kind';

export interface DecisionResult {
  requestId: string;
  outcome: DecisionOutcome;
  /** 0..1 — where a probabilistic engine's probability lands */
  confidence: number;
  /** NFR-16: mandatory */
  rationale: string;
  evidence?: DecisionEvidence[];
  producedBy: { engineId: string; version?: string };
  latencyMs: number;
  /** D-2: a fallback must leave a trace, never be silent */
  fallback?: { used: true; reason: DecisionFallbackReason };
}

export type DecisionOutcome =
  | { kind: 'route'; agentId: string; modelId?: string }
  | { kind: 'risk'; risk: RiskLevel; categories: PermissionCategory[] }
  | {
      kind: 'continue_or_stop';
      action: 'continue' | 'stop' | 'ask_user';
      reason: string;
    }
  | { kind: 'context_relevance'; relevantItemIds: string[]; irrelevantItemIds?: string[] }
  | { kind: 'clarify'; question: string; options?: string[] }
  | { kind: 'option_select'; optionId: string };

/** D-1: the V1 default chain. */
export const DEFAULT_DECISION_CHAIN: ReadonlyArray<string> = ['rule'];

/** Main's hard upper bound on any single engine call. */
export const DECISION_HARD_TIMEOUT_MS = 2000;
