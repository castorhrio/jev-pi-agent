/**
 * @ucad/permissions — §4.9 Permission Engine.
 *
 * Deterministic by construction (D-3): no clock, no randomness, no model call.
 * Persisted, scope-ordered rules are consulted first; the `permissionMode`
 * default policy table is the fallback.
 */

export { PermissionEngine } from './permission-engine';
export type {
  AssessInput,
  EvaluateInput,
  PermissionAuditRecord,
  PermissionEngineOptions,
  PermissionEvaluation,
  RecordAuditInput,
} from './permission-engine';

export {
  ALWAYS_ASK_CATEGORIES,
  DESTRUCTIVE_COMMAND_PATTERNS,
  HIGH_RISK_COMMAND_PATTERNS,
  SHELL_NEVER_AUTO_ALLOWED,
  assessRisk,
  baseRisk,
  defaultPolicy,
  isDestructiveCommand,
  operationForCategory,
} from './policy';
export type {
  DefaultPolicyInput,
  PermissionOperation,
  PermissionOutcome,
  PolicyOutcome,
  RiskInput,
} from './policy';

export { globMatch, matchPermissionTarget } from './glob';
export type { PermissionMatcher } from './glob';

export type { DatabaseLike, RunResultLike, SqlDriverLike } from './db-types';
