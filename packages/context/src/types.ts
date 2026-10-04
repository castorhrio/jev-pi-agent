/**
 * §6 structural interfaces and the option bags of this package.
 *
 * `GitLike` / `SessionStoreLike` are declared here rather than imported from
 * `@ucad/git` / `@ucad/session`: `session` already replays `context_packs` when
 * it builds a handoff (§3, §4.12.1), so importing it back would close a
 * dependency cycle (§1.3). Structural typing keeps the seam narrow — this
 * package only needs the members listed below.
 */

import type {
  AgentManifest,
  BuildContextInput,
  CodeIntelligenceProvider,
  ContextBroker as ContractsContextBroker,
  ContextBudgetState,
  ContextHandoff,
  ContextInjectionPlan,
  ContextItem,
  ContextPack,
  ContextPackBuiltPayload,
  ContextPackDelta,
  ContextPackExtendedPayload,
  ContextStrategy,
  ExtendContextInput,
  FreshnessState,
  InjectionProfile,
  IntelligenceQueryKind,
  IntelligenceQueryStatus,
  IntelligenceStatus,
  TokenEstimateSource,
  TokenEstimator,
} from '@ucad/contracts';
import type { Database } from '@ucad/storage';
import type { BlobStore, Logger } from '@ucad/observability';

// ---------------------------------------------------------------------------
// database seam
// ---------------------------------------------------------------------------

/** Only `driver` and `transaction` are touched; `Database` satisfies it. */
export type DatabaseLike = Pick<Database, 'driver' | 'transaction'>;

// ---------------------------------------------------------------------------
// collaborators
// ---------------------------------------------------------------------------

/** The result shape of `IntelligenceManager.query()`. */
export interface IntelligenceQueryOutcomeLike {
  status: IntelligenceQueryStatus;
  result: unknown;
  freshness: FreshnessState;
  durationMs: number;
  providerId: string;
  reason?: string;
}

/**
 * The four `IntelligenceManager` members the Context plane needs. Declared
 * structurally so a manager signature change cannot silently ripple into the
 * Context plane, and so a stub can stand in for a full provider stack.
 */
export interface IntelligenceLike {
  listProviders(): Array<{ id: string }>;
  resolve(providerId?: string, workspaceId?: string): CodeIntelligenceProvider;
  status(workspaceId: string, providerId?: string): Promise<IntelligenceStatus>;
  query<K extends IntelligenceQueryKind>(input: {
    kind: K;
    providerId: string;
    input: unknown;
    signal?: AbortSignal;
  }): Promise<IntelligenceQueryOutcomeLike>;
}

/** Minimal session projection the broker reads to find the active provider. */
export interface SessionLike {
  id: string;
  agentId: string;
  workspaceId: string;
  providerId?: string;
  modelId?: string;
}

/** `@ucad/git`, structurally. Read-only: the Context plane never mutates git. */
export interface GitLike {
  status(workspaceId: string): Promise<{
    dirty: boolean;
    branch?: string;
    head: string;
    changedFiles: number;
  }>;
  diffSummary(input: {
    workspaceId: string;
    limit?: number;
  }): Promise<Array<{ path: string; patch: string; tokens: number }>>;
}

/** `@ucad/session`, structurally (§3: session lookup + §4.12.1 handoff). */
export interface SessionStoreLike {
  getSession(id: string): SessionLike | null;
  createHandoff(sessionId: string): ContextHandoff;
}

// ---------------------------------------------------------------------------
// budget ledger
// ---------------------------------------------------------------------------

/** T-4: the ledger is keyed by `turnId` and is persisted, not cached. */
export interface TurnBudgetLedgerOptions {
  db: DatabaseLike;
  logger: Logger;
}

export interface OpenLedgerInput {
  turnId: string;
  packId: string;
  limitTokens: number;
  estimateSource: TokenEstimateSource;
}

/**
 * T-4: the ledger surface. Keyed by `turnId`, persisted, and charged by both
 * `build()` and `extend()`; `release()` frees the reservation at turn end.
 */
export interface TurnBudgetLedgerApi {
  open(input: OpenLedgerInput): ContextBudgetState;
  charge(turnId: string, tokens: number): ContextBudgetState;
  remaining(turnId: string): number;
  state(turnId: string): ContextBudgetState | null;
  release(turnId: string): void;
}

// ---------------------------------------------------------------------------
// broker
// ---------------------------------------------------------------------------

export interface ContextBrokerOptions {
  db: DatabaseLike;
  logger: Logger;
  ledger: TurnBudgetLedgerApi;
  estimator: TokenEstimator;
  renderer: InjectionRendererLike;
  intelligence: IntelligenceLike;
  /** read-only git snapshot provider; optional for headless/unit runs */
  git?: GitLike;
  sessionStore?: SessionStoreLike;
  /** NFR-06: payloads above the inline ceiling are offloaded here. */
  blobs?: BlobStore;
  /**
   * §6.4 boundary 3: the collect phase returns a partial pack, marked
   * `truncated`, after this long instead of hanging. Default 1000 ms.
   */
  collectBudgetMs?: number;
  /** `context.preview` resolves an `agentId` to a manifest through this hook. */
  resolveAgent?: (agentId: string) => AgentManifest | null;
  /** `context.preview` budget used when the caller sends none. */
  defaultBudget?: { maxInputTokens: number; reservedOutputTokens: number };
  /** T-3: the tokenizer the active provider declares, if it declares one. */
  providerTokenizer?: TokenEstimateSource;
}

/**
 * What the runtime needs after a build. `builtPayload` has already been
 * validated against `payloadSchemas['context.pack.built']` (SEQ-6), so Main can
 * hand it to the sequencer without re-checking — and T-3's `estimateSource`
 * travels on it.
 */
export interface ContextBuildResult {
  pack: ContextPack;
  injection: ContextInjectionPlan;
  builtPayload: ContextPackBuiltPayload;
  /** I-5: set when the requested injection mode had to be downgraded. */
  warning?: string;
}

/** The mirror image for `extend()`; `extendRendered` is the I-8 increment. */
export interface ContextExtendResult {
  delta: ContextPackDelta;
  pack: ContextPack;
  injection: ContextInjectionPlan;
  extendedPayload: ContextPackExtendedPayload;
  /** §4.6 I-8: what the adapter appends mid-turn, verbatim. */
  extendRendered: string;
  warning?: string;
}

/** `BuildContextInputPreview` (§7.1 IPC) without the `window.ucad` coupling. */
export interface BuildContextInputPreview {
  workspaceId: string;
  sessionId: string;
  objective: string;
  agentId: string;
  modelId?: string;
  budget?: Partial<{
    maxInputTokens: number;
    reservedOutputTokens: number;
    estimateSource: TokenEstimateSource;
  }>;
  strategy?: ContextStrategy | 'auto';
  signal?: AbortSignal;
}

/** Everything the broker needs to mint a context item, in one place. */
export interface ItemMinter {
  /** Deterministic, insertion-ordered id: `ci_<seq>_<ulid>`. */
  nextId(): string;
  estimate(text: string): number;
}

/** Result of the T-5 pipeline, before persistence. */
export interface TrimResult {
  items: ContextItem[];
  omitted: ContextPack['omitted'];
  truncated: boolean;
}

/**
 * The broker surface the runtime and the Tool Contract depend on. SERVICE_
 * CONTRACTS §6 names it `ContextBrokerContract`; the base interface is the
 * `@ucad/contracts` one, so this stays assignable to the published contract.
 */
export interface ContextBrokerContract extends ContractsContextBroker {
  getPack(packId: string): ContextPack | null;
  getInjection(turnId: string): ContextInjectionPlan | null;
  getDelta(packId: string, revision: number): ContextPackDelta | null;
  getPackIdForTurn(turnId: string): string | null;
  preview(input: BuildContextInputPreview): Promise<ContextPack>;
  buildPlan(input: BuildContextInput, signal?: AbortSignal): Promise<ContextBuildResult>;
  extendPlan(input: ExtendContextInput, signal?: AbortSignal): Promise<ContextExtendResult>;
}

/** The three renderer members used outside the broker. */
export interface InjectionRendererLike {
  render(pack: ContextPack, profile: InjectionProfile): ContextInjectionPlan;
  renderDelta(pack: ContextPack, added: ContextItem[], profile: InjectionProfile): ContextInjectionPlan;
  defaultProfile(manifest: AgentManifest): InjectionProfile;
  resolveProfile(
    manifest: AgentManifest,
    preferred?: InjectionProfile,
  ): { profile: InjectionProfile; warning?: string };
}

/** Re-exported for the in-package modules that consume it via `./types`. */
export type { TokenEstimator };
