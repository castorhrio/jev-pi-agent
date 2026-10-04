/**
 * `@ucad/agent-core` — §8, the Agent Runtime plane.
 *
 * Exports:
 *  - {@link AgentRuntimeManager} — the §5.1 turn lifecycle, the three-boundary
 *    Stop (NFR-05), host-crash recovery (S-5) and the permission bridge (§4.9).
 *  - {@link EventAdmissionPipeline} — the single admission door
 *    (SEQ-1..SEQ-6 / E-1 / E-4).
 *  - {@link DeltaCoalescer} — the §8.2 debounce window for `text.delta` and
 *    `reasoning.delta`; every other event type is written through.
 *  - the option and structural-dependency types the Desktop assembles.
 */

export { AgentRuntimeManager } from './agent-runtime-manager';
export { EventAdmissionPipeline } from './admission';
export type { AdmissionPipelineOptions, AdmitResult } from './admission';
export { DeltaCoalescer, isDurableEvent } from './delta-coalescer';
export type {
  CoalescedDeltaWindow,
  DeltaCandidate,
  DeltaCoalescerOptions,
  NumberedDeltaCandidate,
} from './delta-coalescer';
export { TurnRuntimeError, asAppError, fail, runtimeError } from './error';
export type { AgentErrorLike } from './error';
export { MAX_INLINE_PAYLOAD_BYTES } from './types';
export type {
  AdmitInput,
  AdmittingComponent,
  AgentHostExitInfo,
  AgentHostLike,
  AgentRuntimeManagerOptions,
  ContextBrokerLike,
  ContextPlaneOptions,
  DecisionRunnerLike,
  HostRegistration,
  HostStatus,
  IntelligenceManagerLike,
  InjectionRendererLike,
  PendingPermission,
  SendTurnRequest,
  SessionCreatedFrame,
  ToolContractHostLike,
  TurnInterruptedReason,
  TurnOutcome,
} from './types';
