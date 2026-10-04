/** §4.9 Permission contract. */

export type PermissionCategory =
  | 'FILE_WRITE'
  | 'FILE_DELETE'
  | 'SHELL'
  | 'NETWORK'
  | 'GIT_WRITE'
  | 'MCP_TOOL'
  | 'EXTERNAL_PATH'
  | 'EXTERNAL_TOOL';

export type RiskLevel = 'low' | 'medium' | 'high';

export interface PermissionRequest {
  /** Same value as the Host-side `requestId` (M26). */
  id: string;
  sessionId: string;
  turnId: string;
  agentId: string;
  category: PermissionCategory;
  /** V1 is produced by deterministic rules; DecisionEngine only adds a signal (D-3). */
  risk: RiskLevel;
  /** canonicalized absolute path */
  resource?: string;
  command?: string;
  mcpServerId?: string;
  mcpToolName?: string;
  reason?: string;
  decisionEngineSignal?: { risk: RiskLevel; confidence: number; rationale: string };
}

/** UI label mapping is one-to-one (§4.9). */
export type PermissionDecision =
  | 'allow_once'
  | 'allow_session'
  | 'allow_workspace'
  | 'deny';

export type PersistablePermissionDecision = Exclude<PermissionDecision, 'allow_once'>;

export const PERMISSION_DECISION_LABELS: Record<PermissionDecision, string> = {
  allow_once: '允许一次',
  allow_session: '本次会话允许',
  allow_workspace: '本项目允许',
  deny: '拒绝',
};

export interface PermissionRule {
  id: string;
  scope: 'session' | 'workspace' | 'global';
  /** sessionId when scope === 'session' */
  scopeRef?: string;
  category: PermissionCategory;
  matcher: { kind: 'prefix' | 'glob' | 'exact'; value: string };
  decision: PersistablePermissionDecision;
  createdAt: string;
  createdBy: 'user';
}

/** Default policy table from §4.9. */
export const DEFAULT_PERMISSION_POLICY: ReadonlyArray<{
  category: PermissionCategory;
  readOnly: PermissionDecision;
  write: PermissionDecision;
  risk: RiskLevel;
}> = [
  { category: 'FILE_WRITE', readOnly: 'allow_once', write: 'deny', risk: 'low' },
  { category: 'FILE_DELETE', readOnly: 'allow_once', write: 'deny', risk: 'high' },
  { category: 'SHELL', readOnly: 'deny', write: 'deny', risk: 'high' },
  { category: 'NETWORK', readOnly: 'deny', write: 'deny', risk: 'medium' },
  { category: 'GIT_WRITE', readOnly: 'allow_once', write: 'deny', risk: 'high' },
  { category: 'MCP_TOOL', readOnly: 'deny', write: 'deny', risk: 'medium' },
  { category: 'EXTERNAL_PATH', readOnly: 'deny', write: 'deny', risk: 'high' },
  { category: 'EXTERNAL_TOOL', readOnly: 'deny', write: 'deny', risk: 'high' },
];
