/**
 * §4.9 `PermissionEngine` — scoped persisted rules first, then the default
 * policy table. Owns `permission_rules` and `permission_audit`.
 *
 * D-3: risk is a pure function of the request. The DecisionEngine may attach
 * `decisionEngineSignal` to a request, but it never changes the outcome here.
 */

import { nowIso, ulid } from '@ucad/observability';
import type { Logger } from '@ucad/observability';
import type {
  PermissionCategory,
  PermissionDecision,
  PermissionMode,
  PermissionRequest,
  PermissionRule,
  PersistablePermissionDecision,
  RiskLevel,
} from '@ucad/contracts';
import type { DatabaseLike } from './db-types';
import { matchPermissionTarget } from './glob';
import {
  assessRisk,
  defaultPolicy,
  isDestructiveCommand,
  operationForCategory,
  SHELL_NEVER_AUTO_ALLOWED,
} from './policy';
import type { PermissionOutcome } from './policy';

export interface PermissionEngineOptions {
  /** @ucad/storage `Database`; only `driver` / `schemaVersion` are used. */
  db: DatabaseLike;
  logger: Logger;
}

export interface AssessInput {
  category: PermissionCategory;
  resource?: string;
  command?: string;
  sessionPermissionMode: PermissionMode;
  workspaceTrusted: boolean;
}

export interface EvaluateInput {
  request: PermissionRequest;
  sessionPermissionMode: PermissionMode;
  workspaceId: string;
  sessionId: string;
  workspaceTrusted: boolean;
}

export interface PermissionEvaluation {
  outcome: PermissionOutcome;
  /** Persistable allow/deny implied by the outcome, when there is one. */
  decision?: PersistablePermissionDecision;
  matchedRuleId?: string;
  risk: RiskLevel;
  /** Human readable, mandatory (§4.9). */
  reason: string;
}

export interface RecordAuditInput {
  requestId: string;
  sessionId: string;
  turnId: string;
  category: PermissionCategory;
  risk: RiskLevel;
  resource?: string;
  command?: string;
  decision: PermissionDecision;
  decider: 'user' | 'policy';
}

export interface PermissionAuditRecord {
  id: string;
  requestId: string;
  sessionId: string;
  turnId: string;
  category: PermissionCategory;
  risk: RiskLevel;
  resource: string | null;
  command: string | null;
  decision: PermissionDecision;
  decider: 'user' | 'policy';
  decidedAt: string;
}

interface RuleRow {
  id: string;
  scope: string;
  scope_ref: string | null;
  category: string;
  matcher_kind: string;
  matcher_value: string;
  decision: string;
  created_at: string;
  created_by: string;
}

const RULE_COLUMNS =
  'id, scope, scope_ref, category, matcher_kind, matcher_value, decision, created_at, created_by';

/** Most specific scope first: session → workspace → global (M12). */
const SCOPE_RANK: Readonly<Record<string, number>> = { session: 0, workspace: 1, global: 2 };

export class PermissionEngine {
  private readonly db: DatabaseLike;
  private readonly logger: Logger;

  constructor(opts: PermissionEngineOptions) {
    this.db = opts.db;
    this.logger = opts.logger.child('permissions');
  }

  // -------------------------------------------------------------------------
  // risk / evaluation
  // -------------------------------------------------------------------------

  /**
   * §4.9 deterministic risk. No clock, no randomness, no LLM (D-3): the same
   * input always yields the same level.
   */
  assess(input: AssessInput): RiskLevel {
    return assessRisk({
      category: input.category,
      ...(input.resource !== undefined ? { resource: input.resource } : {}),
      ...(input.command !== undefined ? { command: input.command } : {}),
      workspaceTrusted: input.workspaceTrusted,
    });
  }

  /**
   * Rules first (session → workspace → global, oldest first inside a scope),
   * then the `permissionMode` default policy.
   *
   * §7.2 has already canonicalized `resource`, so a request whose target leaves
   * the workspace arrives as `EXTERNAL_PATH`; that is how "inside the workspace"
   * is decided here without a filesystem call.
   */
  evaluate(input: EvaluateInput): PermissionEvaluation {
    const { request, sessionPermissionMode, workspaceId, sessionId, workspaceTrusted } = input;
    const risk = this.assess({
      category: request.category,
      ...(request.resource !== undefined ? { resource: request.resource } : {}),
      ...(request.command !== undefined ? { command: request.command } : {}),
      sessionPermissionMode,
      workspaceTrusted,
    });

    const operation = operationForCategory(request.category);
    // §7.2 has already canonicalized the target and raised `EXTERNAL_PATH` when
    // it leaves the workspace, so every other category is workspace-scoped by
    // construction — a `GIT_WRITE` / `SHELL` request has a command, not a path.
    const insideWorkspace = request.category !== 'EXTERNAL_PATH';

    const rule = this.findRule({
      request,
      workspaceId,
      sessionId,
    });
    if (rule) {
      const veto = this.baselineVeto(request);
      if (rule.decision === 'deny') {
        return {
          outcome: 'auto_deny',
          decision: 'deny',
          matchedRuleId: rule.id,
          risk,
          reason: `rule ${rule.id} (scope=${rule.scope}) denies ${request.category}`,
        };
      }
      if (!veto) {
        return {
          outcome: 'auto_allow',
          decision: rule.decision,
          matchedRuleId: rule.id,
          risk,
          reason: `rule ${rule.id} (scope=${rule.scope}) allows ${request.category} with ${rule.decision}`,
        };
      }
      // A persisted allow cannot lift the V1 baseline: fall through to the
      // default policy, which asks the user (NFR-15 / §4.9 security baseline).
      this.logger.warn('permission allow-rule suppressed by the V1 baseline', {
        ruleId: rule.id,
        category: request.category,
        veto,
      });
    }

    const policy = defaultPolicy({
      category: request.category,
      mode: sessionPermissionMode,
      operation,
      insideWorkspace,
      workspaceTrusted,
      ...(request.resource !== undefined ? { resource: request.resource } : {}),
      ...(request.command !== undefined ? { command: request.command } : {}),
    });
    return {
      outcome: policy.outcome,
      ...(policy.decision !== undefined ? { decision: policy.decision } : {}),
      ...(rule !== null ? { matchedRuleId: rule.id } : {}),
      risk,
      reason: policy.reason,
    };
  }

  // -------------------------------------------------------------------------
  // rules
  // -------------------------------------------------------------------------

  addRule(rule: Omit<PermissionRule, 'id' | 'createdAt' | 'createdBy'>): PermissionRule {
    const created: PermissionRule = {
      id: ulid('rule_'),
      scope: rule.scope,
      ...(rule.scopeRef !== undefined ? { scopeRef: rule.scopeRef } : {}),
      category: rule.category,
      matcher: rule.matcher,
      decision: rule.decision,
      createdAt: nowIso(),
      createdBy: 'user',
    };
    this.db.driver.run(
      `INSERT INTO permission_rules (${RULE_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        created.id,
        created.scope,
        created.scopeRef ?? null,
        created.category,
        created.matcher.kind,
        created.matcher.value,
        created.decision,
        created.createdAt,
        created.createdBy,
      ],
    );
    this.logger.info('permission rule added', {
      ruleId: created.id,
      scope: created.scope,
      category: created.category,
      decision: created.decision,
    });
    return created;
  }

  listRules(scope?: PermissionRule['scope']): PermissionRule[] {
    const rows =
      scope === undefined
        ? this.db.driver.all<RuleRow>(`SELECT ${RULE_COLUMNS} FROM permission_rules`)
        : this.db.driver.all<RuleRow>(
            `SELECT ${RULE_COLUMNS} FROM permission_rules WHERE scope = ?`,
            [scope],
          );
    return [...rows]
      .sort((a, b) => {
        const rank = (SCOPE_RANK[a.scope] ?? 3) - (SCOPE_RANK[b.scope] ?? 3);
        if (rank !== 0) {
          return rank;
        }
        if (a.created_at !== b.created_at) {
          return a.created_at < b.created_at ? -1 : 1;
        }
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      })
      .map((row) => toRule(row));
  }

  revokeRule(ruleId: string): void {
    const result = this.db.driver.run('DELETE FROM permission_rules WHERE id = ?', [ruleId]);
    if (result.changes === 0) {
      this.logger.warn('permission rule not found', { ruleId });
      return;
    }
    this.logger.info('permission rule revoked', { ruleId });
  }

  // -------------------------------------------------------------------------
  // audit (NFR-16 style trail; §4.9)
  // -------------------------------------------------------------------------

  /**
   * `request_id` is UNIQUE (§8.1). INSERT OR REPLACE keeps a repeated
   * permission response an update instead of a constraint violation (the UI may
   * deliver the same response twice).
   */
  recordAudit(input: RecordAuditInput): void {
    this.db.driver.run(
      `INSERT OR REPLACE INTO permission_audit
         (id, request_id, session_id, turn_id, category, risk, resource, command, decision, decider, decided_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        ulid('pa_'),
        input.requestId,
        input.sessionId,
        input.turnId,
        input.category,
        input.risk,
        input.resource ?? null,
        input.command ?? null,
        input.decision,
        input.decider,
        nowIso(),
      ],
    );
  }

  listAudit(sessionId: string): Array<Record<string, unknown>> {
    const rows = this.db.driver.all<{
      id: string;
      request_id: string;
      session_id: string;
      turn_id: string;
      category: string;
      risk: string;
      resource: string | null;
      command: string | null;
      decision: string;
      decider: string;
      decided_at: string;
    }>(
      `SELECT id, request_id, session_id, turn_id, category, risk, resource, command, decision, decider, decided_at
         FROM permission_audit WHERE session_id = ?
        ORDER BY decided_at ASC, id ASC`,
      [sessionId],
    );
    return rows.map((row) => ({
      id: row.id,
      requestId: row.request_id,
      sessionId: row.session_id,
      turnId: row.turn_id,
      category: row.category,
      risk: row.risk,
      resource: row.resource,
      command: row.command,
      decision: row.decision,
      decider: row.decider,
      decidedAt: row.decided_at,
    }));
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  /**
   * V1 baseline veto: `SHELL` is never auto-allowed and neither are the three
   * destructive git commands, even when a persisted rule says otherwise.
   * Returns the explanation, or null when nothing is vetoed.
   */
  private baselineVeto(request: PermissionRequest): string | null {
    if (SHELL_NEVER_AUTO_ALLOWED && request.category === 'SHELL') {
      return 'SHELL is never auto-allowed in V1';
    }
    if (isDestructiveCommand(request.command)) {
      return 'destructive command is never auto-allowed in V1';
    }
    return null;
  }

  /**
   * Most specific matching rule wins: session → workspace → global, oldest
   * first inside a scope so the answer is stable across runs.
   */
  private findRule(input: {
    request: PermissionRequest;
    workspaceId: string;
    sessionId: string;
  }): PermissionRule | null {
    const subject = subjectOf(input.request);
    if (subject === undefined) {
      return null;
    }
    const rows = this.db.driver.all<RuleRow>(
      `SELECT ${RULE_COLUMNS} FROM permission_rules
        WHERE (scope = 'session' AND scope_ref = ?)
           OR (scope = 'workspace' AND scope_ref = ?)
           OR (scope = 'global')
        ORDER BY created_at ASC, id ASC`,
      [input.sessionId, input.workspaceId],
    );
    for (const row of rows) {
      if (row.category !== input.request.category) {
        continue;
      }
      const rule = toRule(row);
      if (matchPermissionTarget(rule.matcher, subject)) {
        return rule;
      }
    }
    return null;
  }
}

/**
 * A rule matches the command when the request has one, otherwise the canonical
 * resource path (§4.9 matcher applies to `resource` or `command`).
 */
function subjectOf(request: PermissionRequest): string | undefined {
  if (request.command !== undefined && request.command !== '') {
    return request.command;
  }
  if (request.resource !== undefined && request.resource !== '') {
    return request.resource;
  }
  return undefined;
}

function toRule(row: RuleRow): PermissionRule {
  return {
    id: row.id,
    scope: row.scope as PermissionRule['scope'],
    ...(row.scope_ref !== null ? { scopeRef: row.scope_ref } : {}),
    category: row.category as PermissionCategory,
    matcher: {
      kind: row.matcher_kind as PermissionRule['matcher']['kind'],
      value: row.matcher_value,
    },
    decision: row.decision as PersistablePermissionDecision,
    createdAt: row.created_at,
    createdBy: 'user',
  };
}
