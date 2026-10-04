/** §4.1 Agent Runtime contract. */

import type { ContextInjectionPlan, ToolContractBinding } from './context';
import type { SecretRef } from './secret';
import type { HostLogger } from './internal';
import type { InboundEventProposal } from './events';

/**
 * R-TRANSPORT: `in_process` is gone. Any adapter that starts a CLI or executes
 * user code MUST use `child_process` (NFR-02).
 */
export type AgentTransport = 'worker' | 'child_process' | 'http' | 'acp';

export interface PinnedDependency {
  package: string;
  /** exact version only — no range (V-1) */
  version: string;
  /** ISO date */
  verifiedAt: string;
  /** official type definitions / CLI --help link */
  source: string;
}

export interface AgentCapabilities {
  streaming: boolean;
  sessionResume: boolean;
  modelSelection: boolean;
  fileTools: boolean;
  shellTools: boolean;
  /** when the vendor natively asks for permission; decides whether UCAD can intercept */
  permissionCallbacks: 'pre_execution' | 'post_hoc' | 'none';
  nativeSandbox: boolean;
  mcp: boolean;
  skills: boolean;
  subagents: boolean;
  usageReporting: 'none' | 'partial' | 'full';
  /** Injection Contract modes (§4.6). Must include at least 'prompt_prefix'. */
  injectionModes: InjectionModeLike[];
  /** 'none' means this Agent cannot call back into UCAD. */
  toolContract: 'mcp' | 'native_bridge' | 'none';
  /** used for budgeting (§4.5.3) */
  contextWindowTokens?: number;
}

type InjectionModeLike = 'prompt_prefix' | 'ucad_tools';

export interface AgentManifest {
  id: string;
  displayName: string;
  /** ADR-017: Pi = 'universal' */
  kind: 'universal' | 'native' | 'mock';
  /** ADR-017: Pi = true, everything else = false */
  isDefaultRuntime: boolean;
  version?: string;
  pinned: PinnedDependency[];
  transport: AgentTransport;
  /** ADR-017 landing point: who owns Provider/Model. */
  providerBinding: 'ucad_managed' | 'agent_owned' | 'both';
  capabilities: AgentCapabilities;
}

export interface AgentAdapter {
  readonly manifest: AgentManifest;
  initialize(
    ctx: AdapterInitializeContext,
    signal?: AbortSignal,
  ): Promise<void>;
  listModels(
    ctx: ModelListContext,
    signal?: AbortSignal,
  ): Promise<ModelDescriptor[]>;
  createSession(
    input: CreateAgentSessionInput,
    signal?: AbortSignal,
  ): Promise<AgentSessionHandle>;
  resumeSession(
    input: ResumeAgentSessionInput,
    signal?: AbortSignal,
  ): Promise<AgentSessionHandle>;
  dispose(): Promise<void>;
}

export interface AdapterInitializeContext {
  agentHostId: string;
  workspaceRoot: string;
  /** .ucad/ absolute path */
  configDir: string;
  /** already redacted and allow-listed environment variables */
  env: Record<string, string>;
  secretResolver: (ref: SecretRef) => Promise<string | null>;
  logger: HostLogger;
  /** told to the host that this adapter may be asked to shut down gracefully */
  onPermissionRequest?: (
    request: unknown,
  ) => Promise<PermissionDecisionLike>;
}

type PermissionDecisionLike = 'allow_once' | 'allow_session' | 'allow_workspace' | 'deny';

export interface ModelListContext {
  workspaceId: string;
  /** true = bypass cache */
  refresh: boolean;
}

export interface ModelDescriptor {
  id: string;
  providerId: string;
  displayName: string;
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  pricingHint?: {
    inputPerMTokUsd?: number;
    outputPerMTokUsd?: number;
  };
}

export type PermissionMode = 'read_only' | 'ask' | 'workspace_write';

export interface CreateAgentSessionInput {
  ucadSessionId: string;
  workspaceId: string;
  workspaceRoot: string;
  /** ADR-017: 'ucad_managed' adapters must honour the UCAD-specified provider/model. */
  providerId?: string;
  modelId?: string;
  permissionMode: PermissionMode;
  systemInstructions?: string;
  trustState: 'untrusted' | 'trusted' | 'restricted';
  metadata?: Record<string, unknown>;
}

export interface ResumeAgentSessionInput {
  ucadSessionId: string;
  nativeSessionId: string;
  /** compared against what was recorded at create time; mismatch => reject + degrade */
  adapterVersion: string;
}

export interface AgentSessionHandle {
  readonly ucadSessionId: string;
  readonly nativeSessionId?: string;
  /**
   * NOTE (§4.1.3): yields `InboundEventProposal`, NOT `TurnEvent` (B6).
   * Adapters cannot produce `seq` — only Main can.
   */
  send(input: AgentTurnInput): AsyncIterable<InboundEventProposal>;
  cancel(reason?: string): Promise<void>;
  dispose(): Promise<void>;
}

export interface AgentTurnInput {
  turnId: string;
  objective: string;
  /**
   * B3: the render plan produced by Main. The adapter must place
   * `rendered` verbatim at `profile.rendezvous` and must not rewrite it.
   */
  injection: ContextInjectionPlan;
  /** credentials for delivering the Tool Contract (MCP server description or bridge handle) */
  toolContract?: ToolContractBinding;
  attachments?: Array<{ path: string; kind: 'image' | 'file'; contentRef?: string }>;
  /** permission mode inherited from the UCAD session */
  permissionMode: PermissionMode;
  /** incremental injection for the same turn (I-8). Adapters that cannot do this
   *  incrementally must return the delta as a tool result instead (§4.5.4). */
  extendRendered?: string;
}
