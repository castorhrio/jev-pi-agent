/**
 * §4.9 Permission policy: deterministic risk assessment and the default policy
 * matrix.
 *
 * D-3: the DecisionEngine may only *add a signal*; permission is decided by
 * deterministic rules. Therefore nothing in this module reads the clock, a
 * random source, or a model. The same (category, operation, command, mode,
 * trust) always yields the same risk level and the same outcome.
 */

import { DEFAULT_PERMISSION_POLICY } from '@ucad/contracts';
import type {
  PermissionCategory,
  PermissionMode,
  PersistablePermissionDecision,
  RiskLevel,
} from '@ucad/contracts';

export type PermissionOutcome = 'auto_allow' | 'ask_user' | 'auto_deny';

/**
 * What the request actually does. The contract's `PermissionCategory` has no
 * read member because reading inside the workspace is not permission-gated at
 * all; the operation is therefore derived from the category (see
 * {@link operationForCategory}) and kept explicit so the default policy stays
 * readable and testable for read requests too.
 */
export type PermissionOperation = 'read' | 'write' | 'execute';

/** Result of a policy decision. `reason` is mandatory so the UI can explain itself (§4.9). */
export interface PolicyOutcome {
  outcome: PermissionOutcome;
  decision?: PersistablePermissionDecision;
  reason: string;
}

/** V1 security baseline: a shell command is never auto-allowed by any path. */
export const SHELL_NEVER_AUTO_ALLOWED = true;

/**
 * §4.9 table — categories whose outcome is `ask_user` in *every* mode, before
 * the mode table is consulted. `NETWORK` 一律 ask_user, `EXTERNAL_PATH` 永远
 * ask_user, and a vendor/MCP tool is never silently allowed in V1.
 */
export const ALWAYS_ASK_CATEGORIES: ReadonlyArray<PermissionCategory> = [
  'NETWORK',
  'EXTERNAL_PATH',
  'EXTERNAL_TOOL',
  'MCP_TOOL',
];

/**
 * §4.9 — destructive commands that are `high` risk and never auto-allowed:
 * `git reset --hard`, `git clean -fd`, `git push --force`.
 */
export const DESTRUCTIVE_COMMAND_PATTERNS: ReadonlyArray<RegExp> = [
  /\bgit\s+reset\b[^\n]*(--hard\b|--merge\b)/i,
  /\bgit\s+clean\b[^\n]*(-[a-z]*f[a-z]*d|-[a-z]*d[a-z]*f)\b/i,
  /\bgit\s+push\b[^\n]*(--force\b|-f\b)/i,
];

/**
 * Additional irreversible shapes that only feed risk assessment. They are NOT
 * part of the "never auto-allow" veto: the brief's baseline is SHELL plus the
 * three git commands above.
 */
export const HIGH_RISK_COMMAND_PATTERNS: ReadonlyArray<RegExp> = [
  ...DESTRUCTIVE_COMMAND_PATTERNS,
  /\brm\s+-[a-z]*r[a-z]*f?\b/i,
  /\bdel\s+\/[a-z]\b/i,
  /\bremove-item\b[^\n]*-recurse/i,
  /\bformat\b/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  /\bshutdown\b|\breboot\b/i,
  /\bcurl\b[^\n]*\|\s*(ba)?sh\b/i,
  /\bchmod\s+(-R\s+)?777\b/i,
  /\bgit\s+(checkout\s+--\s|restore\s+)/i,
];

/** True for the three git commands that §4.9 forbids auto-allowing. */
export function isDestructiveCommand(command: string | undefined): boolean {
  if (!command) {
    return false;
  }
  return DESTRUCTIVE_COMMAND_PATTERNS.some((re) => re.test(command));
}

function isHighRiskCommand(command: string | undefined): boolean {
  if (!command) {
    return false;
  }
  return HIGH_RISK_COMMAND_PATTERNS.some((re) => re.test(command));
}

const RISK_ORDER: ReadonlyArray<RiskLevel> = ['low', 'medium', 'high'];

function bump(risk: RiskLevel, steps: number): RiskLevel {
  const index = RISK_ORDER.indexOf(risk);
  const next = Math.min(RISK_ORDER.length - 1, Math.max(0, index + steps));
  return RISK_ORDER[next] ?? risk;
}

/** Base risk from the contract's `DEFAULT_PERMISSION_POLICY` table (§4.9). */
export function baseRisk(category: PermissionCategory): RiskLevel {
  return DEFAULT_PERMISSION_POLICY.find((row) => row.category === category)?.risk ?? 'medium';
}

export interface RiskInput {
  category: PermissionCategory;
  resource?: string;
  command?: string;
  /** §4.3 workspace trust state. An untrusted workspace raises mutating risk. */
  workspaceTrusted: boolean;
  /** Defaults to the operation derived from the category. */
  operation?: PermissionOperation;
}

/**
 * Deterministic risk assessment. Order is fixed so the result is stable and
 * explainable: base table → destructive command → external target → untrusted
 * workspace.
 */
export function assessRisk(input: RiskInput): RiskLevel {
  const operation = input.operation ?? operationForCategory(input.category);
  let risk = baseRisk(input.category);

  if (isHighRiskCommand(input.command)) {
    risk = 'high';
  }
  if (input.category === 'EXTERNAL_PATH' || input.category === 'EXTERNAL_TOOL') {
    risk = 'high';
  }
  if (operation === 'read') {
    // A read is never riskier than the base table says, but a read of an
    // external path is already high through the EXTERNAL_PATH category.
    return risk === 'high' ? 'high' : 'low';
  }
  if (operation === 'write' && !input.workspaceTrusted) {
    risk = bump(risk, 1);
  }
  if (operation === 'execute' && !input.workspaceTrusted) {
    risk = bump(risk, 1);
  }
  return risk;
}

/** §4.9 — derive the operation from the requested category. */
export function operationForCategory(category: PermissionCategory): PermissionOperation {
  switch (category) {
    case 'FILE_WRITE':
    case 'FILE_DELETE':
    case 'EXTERNAL_PATH':
      return 'write';
    case 'SHELL':
    case 'NETWORK':
    case 'GIT_WRITE':
    case 'MCP_TOOL':
    case 'EXTERNAL_TOOL':
      return 'execute';
    default:
      return 'write';
  }
}

export interface DefaultPolicyInput {
  category: PermissionCategory;
  mode: PermissionMode;
  operation: PermissionOperation;
  /**
   * §7.2: the caller (FileService) canonicalizes the path and raises
   * `EXTERNAL_PATH` when it leaves the workspace, so scope is already known by
   * the time the engine sees the request. `GIT_WRITE` / `SHELL` requests carry a
   * command rather than a path and are workspace-scoped too.
   */
  insideWorkspace: boolean;
  workspaceTrusted: boolean;
  command?: string;
  resource?: string;
}

/**
 * The §4.9 default policy table.
 *
 * ```
 *                     read_only   ask         workspace_write
 * read (in ws)        auto_allow  auto_allow  auto_allow
 * FILE_WRITE (in ws)  auto_deny   ask_user    auto_allow(allow_workspace)
 * FILE_DELETE         auto_deny   ask_user    ask_user
 * GIT_WRITE           auto_deny   ask_user    ask_user
 * SHELL               ask_user    ask_user    ask_user
 * NETWORK             ask_user    ask_user    ask_user
 * MCP_TOOL            ask_user    ask_user    ask_user
 * EXTERNAL_PATH/TOOL  ask_user    ask_user    ask_user
 * ```
 *
 * `workspace_write` never auto-allows in an untrusted workspace, and the three
 * destructive git commands are `ask_user`/high in every mode.
 */
export function defaultPolicy(input: DefaultPolicyInput): PolicyOutcome {
  const { category, mode, operation, insideWorkspace, workspaceTrusted } = input;
  const subject = describeSubject(input.resource, input.command);

  // --- invariants that outrank the mode table -------------------------------
  if (category === 'EXTERNAL_PATH') {
    return {
      outcome: 'ask_user',
      reason: `EXTERNAL_PATH is outside the workspace and always requires the user (${subject})`,
    };
  }
  if (category === 'NETWORK') {
    return {
      outcome: 'ask_user',
      reason: `NETWORK access always requires the user (${subject})`,
    };
  }
  if (category === 'SHELL') {
    return {
      outcome: 'ask_user',
      reason: `SHELL is never auto-allowed (V1 security baseline) (${subject})`,
    };
  }
  if (category === 'EXTERNAL_TOOL' || category === 'MCP_TOOL') {
    return {
      outcome: 'ask_user',
      reason: `${category} is never auto-allowed in V1 (${subject})`,
    };
  }
  if (isDestructiveCommand(input.command)) {
    return {
      outcome: 'ask_user',
      reason: `destructive command requires explicit user approval (§4.9) (${subject})`,
    };
  }

  // --- reads ----------------------------------------------------------------
  if (operation === 'read') {
    if (insideWorkspace) {
      return {
        outcome: 'auto_allow',
        reason: `reading inside the workspace is allowed in every mode (${subject})`,
      };
    }
    return {
      outcome: 'ask_user',
      reason: `reading outside the workspace requires the user (${subject})`,
    };
  }

  // --- writes ---------------------------------------------------------------
  if (!insideWorkspace) {
    return {
      outcome: 'ask_user',
      reason: `writing outside the workspace requires the user (${subject})`,
    };
  }

  if (category === 'FILE_WRITE' || category === 'FILE_DELETE' || category === 'GIT_WRITE') {
    if (mode === 'read_only') {
      return {
        outcome: 'auto_deny',
        decision: 'deny',
        reason: `session permission mode is read_only, so ${category} inside the workspace is denied (${subject})`,
      };
    }
    if (mode === 'ask') {
      return {
        outcome: 'ask_user',
        reason: `session permission mode is ask, so ${category} requires the user (${subject})`,
      };
    }
    // mode === 'workspace_write'
    if (category === 'FILE_WRITE') {
      if (!workspaceTrusted) {
        return {
          outcome: 'ask_user',
          reason: `workspace is not trusted, so workspace_write does not auto-allow FILE_WRITE (${subject})`,
        };
      }
      return {
        outcome: 'auto_allow',
        decision: 'allow_workspace',
        reason: `workspace_write mode allows writing inside a trusted workspace (${subject})`,
      };
    }
    return {
      outcome: 'ask_user',
      reason: `${category} stays ask_user even in workspace_write mode (${subject})`,
    };
  }

  return {
    outcome: 'ask_user',
    reason: `category ${category} has no default policy entry, so the user is asked (${subject})`,
  };
}

function describeSubject(resource: string | undefined, command: string | undefined): string {
  if (command !== undefined && command !== '') {
    return `command: ${command}`;
  }
  if (resource !== undefined && resource !== '') {
    return `resource: ${resource}`;
  }
  return 'no resource or command';
}
