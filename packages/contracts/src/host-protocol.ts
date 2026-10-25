/** §6 Host protocols. */

import type { AdapterInitializeContext, AgentManifest, AgentTurnInput, CreateAgentSessionInput, ResumeAgentSessionInput } from './agent';
import type { InboundEventProposal, IntelligenceIndexProgressPayload } from './events';
import type { PermissionRequest, PermissionDecision } from './permission';
import type { AppError } from './error';
import type { SecretRef } from './secret';
import type {
  IntelligenceInitializeContext,
  IntelligenceOperationHandle,
  IntelligenceQueryKind,
  IntelligenceStatus,
  IndexWorkspaceInput,
  RefreshWorkspaceInput,
  CodeIntelligenceManifest,
} from './intelligence';

// ---------------------------------------------------------------------------
// 6.1 Agent Host
// ---------------------------------------------------------------------------

export type MainToAgentHost =
  | { op: 'initialize'; payload: AdapterInitializeContext }
  | { op: 'create_session'; payload: CreateAgentSessionInput }
  | { op: 'resume_session'; payload: ResumeAgentSessionInput }
  | { op: 'send_turn'; payload: AgentTurnInput }
  | { op: 'cancel_turn'; payload: { turnId: string; reason?: string } }
  | { op: 'permission_response'; payload: { requestId: string; decision: PermissionDecision } }
  | { op: 'dispose_session'; payload: { ucadSessionId: string } }
  /**
   * The answer to a `secret_request`: the plaintext credential, or `null` when
   * Main holds none for that ref.
   *
   * It travels on the same channel as everything else — a forked child's IPC
   * port — and nowhere else. It is never written to a log, never put in
   * `process.env` and never returned to the Renderer (NFR-01).
   */
  | { op: 'secret_response'; payload: { requestId: string; value: string | null } }
  | { op: 'shutdown'; payload: { gracePeriodMs: number } };

export type AgentHostToMain =
  | { op: 'ready'; payload: { agentHostId: string; manifest: AgentManifest } }
  /**
   * Added by the implementation: §6.1 as written had no way to carry
   * `nativeSessionId` back to Main, which left §4.3 S-3 (UCAD session id and
   * native session id are always separate) unsatisfiable and left
   * `agent_sessions.native_session_id` unpersistable. The adapter returns a
   * `nativeSessionId` (§4.1.3) and the Host protocol has to deliver it.
   */
  | {
      op: 'session_created';
      payload: {
        ucadSessionId: string;
        nativeSessionId?: string;
        adapterVersion?: string;
        resumed: boolean;
      };
    }
  /**
   * The Host needs a credential it cannot hold: the API key the user saved in
   * Settings lives in Main's OS keychain, and the Host is a separate process.
   *
   * The Host asks for a *reference*; only Main may turn a reference into a
   * value. That is the whole point of the direction of the request — the Host
   * never receives a vault, a path or an environment variable that names a
   * secret, so a compromised Host cannot enumerate what the user has stored.
   */
  | { op: 'secret_request'; payload: { requestId: string; ref: SecretRef } }
  /** no seq — Main assigns it */
  | { op: 'event'; payload: InboundEventProposal }
  | { op: 'permission_request'; payload: PermissionRequest }
  | { op: 'health'; payload: { at: string; activeTurnId?: string; rssBytes?: number } }
  | { op: 'adapter_error'; payload: AppError }
  | { op: 'exited'; payload: { code: number | null; signal?: string } };

// ---------------------------------------------------------------------------
// 6.2 Intelligence Host
// ---------------------------------------------------------------------------

export type MainToIntelligenceHost =
  | { op: 'initialize'; payload: IntelligenceInitializeContext }
  | { op: 'index'; payload: IndexWorkspaceInput & { operationId: string } }
  | { op: 'refresh'; payload: RefreshWorkspaceInput & { operationId: string } }
  | {
      op: 'query';
      payload: { operationId: string; kind: IntelligenceQueryKind; input: unknown };
    }
  | { op: 'cancel'; payload: { operationId: string } }
  | { op: 'status'; payload: { workspaceId: string } }
  | { op: 'shutdown'; payload: { gracePeriodMs: number } };

export type IntelligenceHostToMain =
  | { op: 'ready'; payload: { manifest: CodeIntelligenceManifest } }
  | { op: 'operation_started'; payload: IntelligenceOperationHandle }
  | { op: 'progress'; payload: IntelligenceIndexProgressPayload }
  /** Zod-validated per kind */
  | { op: 'operation_completed'; payload: unknown }
  | { op: 'status'; payload: IntelligenceStatus }
  | { op: 'error'; payload: AppError }
  | { op: 'exited'; payload: { code: number | null; signal?: string } };

/** Both host protocols are newline-delimited JSON over a process message channel. */
export const HOST_PROTOCOL_VERSION = 1;

export function isAgentHostMessage(value: unknown): value is AgentHostToMain {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as { op?: unknown }).op === 'string' &&
    'payload' in (value as object)
  );
}
