/** §4.8 Code Intelligence contract. */

import type { ContextItemKind, FreshnessState } from './context';
import type { PinnedDependency } from './agent';
import type { IntelligenceLogger } from './internal';
import type { RiskLevel } from './permission';
import type { AppErrorCode } from './error';

export type IntelligenceQueryKind =
  | 'search'
  | 'locate'
  | 'overview'
  | 'callers'
  | 'callees'
  | 'trace'
  | 'impact';

export type OptionalIntelligenceMethod =
  | 'callers'
  | 'callees'
  | 'trace'
  | 'impact';

/** Every long-running operation returns a handle so that cancel is reachable. */
export interface IntelligenceOperationHandle {
  operationId: string;
  providerId: string;
  kind: IntelligenceQueryKind | 'index' | 'refresh';
  startedAt: string;
}

export interface CodeIntelligenceProvider {
  readonly manifest: CodeIntelligenceManifest;
  initialize(ctx: IntelligenceInitializeContext, signal?: AbortSignal): Promise<void>;
  getStatus(workspaceId: string): Promise<IntelligenceStatus>;

  index(
    input: IndexWorkspaceInput,
    signal?: AbortSignal,
  ): Promise<IntelligenceOperationHandle>;
  refresh(
    input: RefreshWorkspaceInput,
    signal?: AbortSignal,
  ): Promise<IntelligenceOperationHandle>;
  cancel(input: { operationId: string }): Promise<{ cancelled: boolean; reason?: string }>;

  search(input: CodeSearchInput, signal?: AbortSignal): Promise<CodeSearchResult>;
  locate(input: LocateSymbolInput, signal?: AbortSignal): Promise<CodeLocation[]>;
  overview(input: OverviewInput, signal?: AbortSignal): Promise<CodeOverview>;

  // C-1: optional methods may be ABSENT. An empty `[]` return would be misread
  // as "there are no callers", so absence is the honest signal.
  callers?(input: RelationInput, signal?: AbortSignal): Promise<CodeRelationResult>;
  callees?(input: RelationInput, signal?: AbortSignal): Promise<CodeRelationResult>;
  trace?(input: TraceInput, signal?: AbortSignal): Promise<CodeTrace>;
  impact?(input: ImpactInput, signal?: AbortSignal): Promise<ImpactAnalysis>;

  dispose(): Promise<void>;
}

export interface CodeIntelligenceManifest {
  id: string;
  displayName: string;
  tier: 'basic' | 'advanced';
  version?: string;
  pinned: PinnedDependency[];
  transport: 'in_process' | 'child_process' | 'http' | 'mcp';
  requires: Array<'node' | 'docker' | 'external_service'>;
  capabilities: CodeIntelligenceCapabilities;
  /** single source of truth for which optional methods this provider implements */
  optionalMethods: OptionalIntelligenceMethod[];
}

export interface CodeIntelligenceCapabilities {
  symbolSearch: boolean;
  definitions: boolean;
  callers: boolean;
  callees: boolean;
  dependencyGraph: boolean;
  trace: boolean;
  impact: boolean;
  persistentIndex: boolean;
  incrementalRefresh: boolean;
  machineReadableOutput: boolean;
  /** declared token counting ability, feeds NFR-12 estimateSource */
  tokenizer: 'provider_tokenizer' | 'heuristic_chars_div_4' | 'unknown';
}

export interface IntelligenceInitializeContext {
  workspaceId: string;
  workspaceRoot: string;
  configDir: string;
  cacheDir: string;
  trustState: 'untrusted' | 'trusted' | 'restricted';
  logger: IntelligenceLogger;
}

export type IntelligenceStatusState =
  | 'unavailable'
  | 'degraded'
  | 'not_indexed'
  | 'indexing'
  | 'ready'
  | 'stale'
  | 'error';

export interface IntelligenceStatus {
  providerId: string;
  state: IntelligenceStatusState;
  reason?: string;
  providerVersion?: string;
  indexedRevision?: string;
  indexedAt?: string;
  stale: boolean;
  features: CodeIntelligenceCapabilities;
  /** NFR-09: explains the degradation and what still works */
  degradation?: {
    since: string;
    because:
      | 'dependency_missing'
      | 'backend_unreachable'
      | 'version_mismatch'
      | 'index_failed';
  };
}

export interface IndexWorkspaceInput {
  workspaceId: string;
  workspaceRoot: string;
  full: boolean;
}

export interface RefreshWorkspaceInput {
  workspaceId: string;
  changedPaths?: string[];
}

export interface IndexResult {
  operationId: string;
  status: 'started' | 'completed';
  indexedRevision?: string;
}

export interface CodeSearchInput {
  workspaceId: string;
  query: string;
  kinds?: ContextItemKind[];
  limit?: number;
}

export interface CodeSearchResult {
  items: CodeLocation[];
  truncated: boolean;
  freshness: FreshnessState;
}

export interface LocateSymbolInput {
  workspaceId: string;
  symbol: string;
  kind?: string;
}

export interface CodeLocation {
  path: string;
  startLine: number;
  endLine: number;
  symbol?: string;
  kind?: string;
  snippetRef?: string;
}

export interface OverviewInput {
  workspaceId: string;
  target?: string;
  depth?: number;
}

export interface CodeOverview {
  summary: string;
  entryPoints: CodeLocation[];
  modules?: Array<{ name: string; path: string; symbols: number }>;
  freshness: FreshnessState;
}

export interface RelationInput {
  workspaceId: string;
  target: CodeLocation;
  depth?: number;
  limit?: number;
}

export interface CodeRelationResult {
  relations: Array<{ from: CodeLocation; to: CodeLocation; kind: string }>;
  truncated: boolean;
  freshness: FreshnessState;
}

export interface TraceInput {
  workspaceId: string;
  from: CodeLocation;
  to?: CodeLocation;
  maxDepth?: number;
}

export interface CodeTrace {
  steps: Array<{ via: CodeLocation; edgeKind: string; confidence?: number }>;
  complete: boolean;
  freshness: FreshnessState;
}

export interface ImpactInput {
  workspaceId: string;
  target: CodeLocation;
  changeKind: 'modify' | 'delete' | 'rename';
  depth?: number;
}

export interface ImpactAnalysis {
  direct: CodeLocation[];
  transitive: CodeLocation[];
  tests?: CodeLocation[];
  riskLevel: RiskLevel;
  truncated: boolean;
  freshness: FreshnessState;
}

export type IntelligenceQueryStatus = 'ok' | 'cancelled' | 'error' | 'unsupported';

export type { AppErrorCode };
