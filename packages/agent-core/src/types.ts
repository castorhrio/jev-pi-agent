/**
 * `@ucad/agent-core` — option and structural-dependency types for §8.
 *
 * The collaborators this plane drives are declared **structurally** rather than
 * imported, following the convention already used in the repository
 * (`GitLike` / `SessionStoreLike` in §6, `DatabaseLike` / `EventLogLike` /
 * `SessionSequencerLike` in §3). Two reasons:
 *
 *  1. `@ucad/context` has no built `dist` yet, so importing it would make the
 *     whole package un-typecheckable. The interfaces below are the §6 shapes
 *     verbatim, so the real `ContextBroker` / `InjectionRenderer` /
 *     `ToolContractHost` satisfy them with no change once that package builds.
 *  2. `@ucad/agent-host` exposes exactly the surface used here, so
 *     `AgentHostProcess` satisfies {@link AgentHostLike} unchanged.
 *
 * Nothing in this file has behaviour; the types are the authority.
 */

import type {
  AgentHostToMain,
  AgentManifest,
  BuildContextInput,
  ContextInjectionPlan,
  ContextPack,
  ContextPackDelta,
  DecisionFacts,
  DecisionKind,
  DecisionOption,
  DecisionResult,
  EventSource,
  ExtendContextInput,
  InjectionProfile,
  MainToAgentHost,
  ModelDescriptor,
  SendTurnInput,
  ToolAvailabilityContext,
  ToolContractBinding,
  ToolInvocationContext,
  TurnEvent,
  TurnEventType,
  UcadToolDefinition,
  UcadToolResult,
  Unsubscribe,
} from '@ucad/contracts';
import type { Database, EventLog, MessageProjector, SessionSequencer } from '@ucad/storage';
import type { SessionStore } from '@ucad/session';
import type { PermissionEngine } from '@ucad/permissions';
import type { BlobStore, Logger } from '@ucad/observability';
import type { SessionState, TurnState } from '@ucad/contracts';

/** §7.1 `AgentHostProcess.onExit` payload. */
export interface AgentHostExitInfo {
  code: number | null;
  signal?: string;
}

/**
 * §7.1 `AgentHostProcess`, narrowed to the members §8 actually drives.
 * `AgentHostProcess` satisfies this structurally.
 */
export interface AgentHostLike {
  readonly agentHostId: string;
  readonly manifest: AgentManifest;
  /** resolves with the manifest carried by the `ready` frame */
  start(): Promise<AgentManifest>;
  /** fire-and-forget; never throws */
  send(msg: MainToAgentHost): void;
  onMessage(cb: (msg: AgentHostToMain) => void): Unsubscribe;
  onExit(cb: (info: AgentHostExitInfo) => void): Unsubscribe;
  /** NFR-05 boundary 1: `'acked'` inside the grace window, `'killed'` after escalation */
  cancelTurn(turnId: string, reason?: string, graceMs?: number): Promise<'acked' | 'killed'>;
  dispose(graceMs?: number): Promise<void>;
  readonly alive: boolean;
  readonly rssBytes?: number;
}

/** §6 `ContextBroker`. Optional members are reads agent-core does not require. */
export interface ContextBrokerLike {
  build(input: BuildContextInput, signal?: AbortSignal): Promise<ContextPack>;
  extend(input: ExtendContextInput, signal?: AbortSignal): Promise<ContextPackDelta>;
  /** T-4: release the turn budget ledger; Main must call this at turn end. */
  release(input: { turnId: string }): Promise<void>;
  getPack?(packId: string): ContextPack | null;
  getInjection?(turnId: string): ContextInjectionPlan | null;
}

/** §6 `InjectionRenderer`. `resolveProfile` implements I-5 when present. */
export interface InjectionRendererLike {
  /** NFR-13 pure function: same (pack, profile) => same bytes and same hash */
  render(pack: ContextPack, profile: InjectionProfile): ContextInjectionPlan;
  /** §4.6.4 the Agent's default profile */
  defaultProfile?(manifest: AgentManifest): InjectionProfile;
  /** I-5: `mode` must be in `manifest.capabilities.injectionModes` */
  resolveProfile?(
    manifest: AgentManifest,
    preferred?: InjectionProfile,
  ): { profile: InjectionProfile; warning?: string };
}

/** §6 `ToolContractHost`. */
export interface ToolContractHostLike {
  list(ctx: ToolAvailabilityContext): UcadToolDefinition[];
  invoke(name: string, input: unknown, ctx: ToolInvocationContext): Promise<UcadToolResult>;
  bindingFor(agent: AgentManifest): ToolContractBinding;
}

/**
 * §4.4 `DecisionService.decide`, narrowed. The real `DecisionService`
 * satisfies it: `DecisionFacts` is assignable to its `DecisionFactsInput`
 * (every field of the input is optional) and it returns a superset of
 * `{ result, requestId }`.
 */
export interface DecisionRunnerLike {
  decide(input: {
    sessionId: string;
    turnId: string;
    kind: DecisionKind;
    objective: string;
    facts: DecisionFacts;
    options?: DecisionOption[];
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<{ result: DecisionResult; requestId: string }>;
}

/**
 * §5 `IntelligenceManager`, narrowed to the single operation NFR-05 boundary 2
 * needs: aborting work that is already in flight. agent-core collects the
 * `operationId`s it admits for the turn and cancels each of them on Stop.
 */
export interface IntelligenceManagerLike {
  cancel(operationId: string): Promise<{ cancelled: boolean; reason?: string }>;
}

/** §8. Context-plane collaborators, injected together. */
export interface ContextPlaneOptions {
  broker: ContextBrokerLike;
  renderer: InjectionRendererLike;
  toolHost?: ToolContractHostLike;
}

/** Input of §8 `sendTurn`. */
export interface SendTurnRequest {
  sessionId: string;
  objective: string;
  agentId: string;
  providerId?: string;
  modelId?: string;
  attachments?: SendTurnInput['attachments'];
  /** an explicit choice always beats a `route` suggestion (D-4) */
  override?: SendTurnInput['override'];
  /**
   * §8 hook: the Context Drawer's "edit before inject" gate. Returning
   * `continue: false` abandons the turn before the Host ever sees it; the turn
   * is closed as CANCELLED and a terminal event is still emitted.
   */
  beforeInject?: (
    pack: ContextPack,
    plan: ContextInjectionPlan,
  ) => Promise<{ continue: boolean; reason?: string }>;
}

/** §8 `AgentRuntimeManagerOptions`. */
export interface AgentRuntimeManagerOptions {
  db: Database;
  logger: Logger;
  eventLog: EventLog;
  sequencer: SessionSequencer;
  sessionStore: SessionStore;
  permissions: PermissionEngine;
  /**
   * §8 requires this option. NFR-06 blob offload itself lives in `EventLog`
   * (§2), so agent-core uses the handle only to know that offload is available
   * when a payload crosses {@link MAX_INLINE_PAYLOAD_BYTES}.
   */
  blobs: BlobStore;
  hostFactory: (agentId: string) => AgentHostLike;
  /** fan-out to the Renderer (IPC).
   *
   *  §8.2 exception: a coalesced `text.delta` / `reasoning.delta` is fanned out
   *  BEFORE its window is persisted, carrying the `seq` it keeps in the stream,
   *  so the UI streams in real time. Only those two lossy types can arrive
   *  unpersisted, and each is persisted within one flush window. */
  onEvent: (e: TurnEvent) => void;
  /** §8.2 delta batching. Defaults to `{ enabled: true, 4 KiB, 200 ms }`. */
  deltaCoalescing?: { enabled?: boolean; maxBytes?: number; maxIntervalMs?: number };
  /** §8.3 projection. Defaults to `new MessageProjector(db, { maxPendingChars })`. */
  projector?: MessageProjector;
  /** §6 context plane. Absent => the turn runs with an empty injection plan. */
  context?: ContextPlaneOptions;
  /** §4.4 decision plane. Absent => no `decision.made` events. */
  decision?: DecisionRunnerLike;
  /** §5 intelligence plane, for NFR-05 boundary 2. */
  intelligence?: IntelligenceManagerLike;
  /**
   * Assembles `DecisionFacts` (D-5: the Decision plane never reads the
   * workspace itself). May be async because collecting honest facts costs
   * something real — `git status` is a process spawn, not a lookup.
   * Defaults to a minimal, complete, all-zero fact set.
   */
  buildFacts?: (ctx: {
    sessionId: string;
    turnId: string;
    workspaceId: string;
    workspaceTrusted: boolean;
  }) => DecisionFacts | Promise<DecisionFacts>;
  /**
   * §4.1.1 `AgentAdapter.listModels` has **no** frame in the §6.1 protocol, so
   * the model list is injected by the Desktop (which owns the provider
   * registry). Absent => {@link AgentRuntimeManager.listModels} logs once and
   * returns `[]`.
   */
  modelCatalog?: (agentId: string) => Promise<ModelDescriptor[]>;
  /** default 120000. An unanswered request rejects rather than auto-allowing. */
  permissionTimeoutMs?: number;
  /** NFR-05: host cancel grace window. Default 2000 (§6.4). */
  cancelGraceMs?: number;
  /** How long a graceful ack is given to produce a terminal event. Default 300. */
  cancelSettleMs?: number;
  /** `create_session` / `resume_session` ack timeout. Default 10000. */
  nativeSessionTimeoutMs?: number;
  /** Default: run the `risk` decision unless the mode is `read_only`. */
  runRiskDecision?: boolean;
}

/** `hostFactory` result plus the subscriptions agent-core owns. */
export interface HostRegistration {
  agentId: string;
  host: AgentHostLike;
  unsubscribes: Unsubscribe[];
}

/** §5.1 `listHosts()` row. */
export interface HostStatus {
  agentId: string;
  alive: boolean;
  manifest: AgentManifest;
}

/** The terminal state of a turn, as reported by {@link AgentRuntimeManager.waitForTurn}. */
export interface TurnOutcome {
  turnId: string;
  sessionId: string;
  state: TurnState;
  /** mirrors `turn.completed.status` when the turn completed normally */
  status?: 'completed' | 'failed' | 'cancelled';
  /** highest seq persisted before the terminal event */
  lastSeq: number;
  reason?: TurnInterruptedReason;
  sessionState?: SessionState;
}

/** Re-exported alias so callers need not import from `@ucad/contracts`. */
export type TurnInterruptedReason =
  | 'host_exited'
  | 'host_unresponsive'
  | 'app_crash_recovery'
  | 'user_stop_timeout';

/** NFR-06 inline ceiling; `EventLog` offloads anything above it to blob storage. */
export const MAX_INLINE_PAYLOAD_BYTES = 256 * 1024;

/** Permission request awaiting a Renderer answer. */
export interface PendingPermission {
  requestId: string;
  sessionId: string;
  turnId: string;
  agentId: string;
  resolve(decision: string): void;
  reject(err: Error): void;
  timer?: NodeJS.Timeout;
}

/** Shape of the `session_created` frame (§6.1, the S-3 carrier). */
export interface SessionCreatedFrame {
  ucadSessionId: string;
  nativeSessionId?: string;
  adapterVersion?: string;
  resumed: boolean;
}

/** `error` payload component chosen from the proposing plane (§4.11). */
export type AdmittingComponent = 'agent' | 'context' | 'intelligence' | 'decision' | 'storage' | 'ipc';

/** Input of the single admission entry point. */
export interface AdmitInput {
  sessionId: string;
  turnId: string;
  type: TurnEventType;
  source: EventSource;
  payload: unknown;
  ts?: string;
  /**
   * SEQ-2: a `seq` already allocated for this event in the current transaction
   * (used by the `turn.started` bootstrap, which reuses the number
   * `SessionStore.beginTurn` allocated). Omit to allocate a fresh one.
   */
  seq?: number;
}
