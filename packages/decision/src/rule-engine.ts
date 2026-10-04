/**
 * §4.4 / ADR-016 — the V1 default `DecisionEngine`.
 *
 * D-5 is enforced by architecture, and this file is the proof of it: it imports
 * ONLY types from `@ucad/contracts`. There is no `node:fs`, no
 * `node:child_process` and no `node:net` anywhere in `packages/decision`; every
 * input the heuristics need arrives as the read-only `DecisionFacts` summary
 * that Main assembles. (A DecisionEngine may not go and look things up itself —
 * ADR-016 §后果 6.)
 *
 * D-3: in V1 this engine is deterministic and produces the risk signal itself;
 * a probabilistic engine may only *add* to it.
 * NFR-16: every result carries a non-empty `rationale` and a `confidence` in
 * [0,1]. There is no code path that returns an unexplained result.
 * D-6: results are plain JSON — no functions, no class instances, no streams.
 */

import type {
  DecisionEngine,
  DecisionEngineManifest,
  DecisionEvidence,
  DecisionInitializeContext,
  DecisionKind,
  DecisionOption,
  DecisionOutcome,
  DecisionRequest,
  DecisionResult,
  PermissionCategory,
} from '@ucad/contracts';
import type { DecisionLogger } from '@ucad/contracts';

export const RULE_ENGINE_ID = 'rule';

/** All six kinds (B1) — the rule engine is the last-resort engine of the chain. */
export const RULE_ENGINE_SUPPORTED_KINDS: ReadonlyArray<DecisionKind> = [
  'route',
  'risk',
  'continue_or_stop',
  'context_relevance',
  'clarify',
  'option_select',
];

/** Tunables; the defaults encode the V1 policy and are exported so they are testable. */
export interface RuleDecisionThresholds {
  /** consecutiveFailures >= this => stop (brief: >= 2) */
  failureLimit: number;
  /** permissionDenials >= this => ask_user (brief: >= 2) */
  denialLimit: number;
  /** signals.elapsedMs > this => ask_user */
  elapsedLimitMs: number;
  /** facts.git.changedFiles >= this => broad change, no model pinning */
  broadDiffFiles: number;
  /** facts.git.changedFiles >= this => risk bump */
  mediumDiffFiles: number;
  /** facts.git.changedFiles >= this => high risk */
  highDiffFiles: number;
}

export const DEFAULT_RULE_THRESHOLDS: RuleDecisionThresholds = {
  failureLimit: 2,
  denialLimit: 2,
  elapsedLimitMs: 600_000,
  broadDiffFiles: 20,
  mediumDiffFiles: 8,
  highDiffFiles: 20,
};

const TEST_KEYWORDS: ReadonlyArray<string> = [
  'test',
  'tests',
  'spec',
  'e2e',
  'regression',
  'coverage',
  'fixture',
  'vitest',
  'jest',
  'playwright',
  'pytest',
];

const REVIEW_KEYWORDS: ReadonlyArray<string> = [
  'review',
  'refactor',
  'cleanup',
  'lint',
  'audit',
  'docs',
  'architecture',
];

const CATEGORY_KEYWORDS: Readonly<Array<{ category: PermissionCategory; keywords: ReadonlyArray<string> }>> = [
  {
    category: 'FILE_WRITE',
    keywords: ['write', 'edit', 'create', 'modify', 'refactor', 'implement', 'fix', 'patch', 'rename'],
  },
  {
    category: 'FILE_DELETE',
    keywords: ['delete', 'remove', 'drop', 'unlink', 'clean', 'purge', 'revert'],
  },
  {
    category: 'SHELL',
    keywords: ['run', 'npm', 'npx', 'pnpm', 'yarn', 'exec', 'shell', 'command', 'script', 'build', 'make'],
  },
  {
    category: 'NETWORK',
    keywords: ['http', 'https', 'api', 'fetch', 'curl', 'download', 'install', 'registry', 'webhook'],
  },
  {
    category: 'GIT_WRITE',
    keywords: ['commit', 'push', 'branch', 'merge', 'rebase', 'tag', 'cherry-pick', 'stash'],
  },
];

const VAGUE_PATTERNS: ReadonlyArray<RegExp> = [
  /fix\s*it/i,
  /\bimprove\b/i,
  /\bclean\s*up\s*(the\s*)?(code|it)?\b/i,
  /\bmake\s*it\s*(better|nice|faster)\b/i,
  /\b优化\b/,
  /\b重构一下\b/,
  /\b继续\b/,
  /\b怎么办\b/,
  /\b你看一下\b/,
];

interface RuleOutcome {
  outcome: DecisionOutcome;
  confidence: number;
  rationale: string;
  evidence?: DecisionEvidence[];
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  const bounded = n < 0 ? 0 : n > 1 ? 1 : n;
  return Math.round(bounded * 100) / 100;
}

/**
 * Deterministic keyword matcher. ASCII keywords must match a whole token so that
 * "latest" does not trigger "test"; CJK keywords have no word boundaries and are
 * matched as substrings.
 */
function keywordHits(text: string, keywords: ReadonlyArray<string>): string[] {
  const lower = text.toLowerCase();
  const tokens = new Set(
    lower
      .split(/[^a-z0-9+#._-]+/i)
      .filter((t) => t.length > 0),
  );
  return keywords.filter((k) => {
    const ascii = /^[!-~]+$/.test(k);
    return ascii ? tokens.has(k) : lower.includes(k);
  });
}

function aborted(): Error {
  const err = new Error('decision aborted by caller');
  err.name = 'AbortError';
  return err;
}

export class RuleDecisionEngine implements DecisionEngine {
  readonly manifest: DecisionEngineManifest;

  private readonly thresholds: RuleDecisionThresholds;
  private logger: DecisionLogger | null = null;

  /**
   * NFR-14: declared side effects are truthful — the rule engine only reads the
   * facts it was handed, so it has none.
   */
  constructor(thresholds: Partial<RuleDecisionThresholds> = {}) {
    this.thresholds = { ...DEFAULT_RULE_THRESHOLDS, ...thresholds };
    this.manifest = {
      id: RULE_ENGINE_ID,
      displayName: 'Deterministic Rule Engine',
      version: '1.0.0',
      sideEffects: ['none'],
      supportedKinds: [...RULE_ENGINE_SUPPORTED_KINDS],
      timeoutMs: 500,
    };
  }

  async initialize(ctx: DecisionInitializeContext): Promise<void> {
    this.logger = ctx.logger;
    this.logger?.debug('rule engine initialized', {
      workspaceId: ctx.workspaceId,
      kinds: this.manifest.supportedKinds,
    });
  }

  supports(kind: DecisionKind): boolean {
    return this.manifest.supportedKinds.includes(kind);
  }

  /**
   * `request.timeoutMs` is intentionally ignored: the hard bound is enforced by
   * `DecisionChain` (DECISION_HARD_TIMEOUT_MS) so that an engine can never widen
   * its own budget.
   */
  async decide(request: DecisionRequest, signal?: AbortSignal): Promise<DecisionResult> {
    if (signal?.aborted) throw aborted();
    const started = Date.now();

    let produced: RuleOutcome;
    switch (request.kind) {
      case 'route':
        produced = this.route(request);
        break;
      case 'risk':
        produced = this.risk(request);
        break;
      case 'continue_or_stop':
        produced = this.continueOrStop(request);
        break;
      case 'context_relevance':
        produced = this.contextRelevance(request);
        break;
      case 'clarify':
        produced = this.clarify(request);
        break;
      case 'option_select':
        produced = this.optionSelect(request);
        break;
      default: {
        // Exhaustiveness guard: an unknown kind must never yield a silent result.
        const never: never = request.kind;
        throw new Error(`rule engine received an unknown kind: ${String(never)}`);
      }
    }

    const result: DecisionResult = {
      requestId: request.requestId,
      outcome: produced.outcome,
      confidence: clamp01(produced.confidence),
      rationale: produced.rationale,
      ...(produced.evidence && produced.evidence.length > 0 ? { evidence: produced.evidence } : {}),
      producedBy: { engineId: this.manifest.id, version: this.manifest.version },
      latencyMs: Date.now() - started,
    };
    return result;
  }

  async dispose(): Promise<void> {
    this.logger = null;
  }

  // -------------------------------------------------------------------------
  // route
  // -------------------------------------------------------------------------

  /**
   * Signals, in the order they are consulted:
   *  1. `facts.availableAgents` — the `isDefaultRuntime` agent (ADR-017) is the
   *     baseline and wins whenever the objective signals are weak;
   *  2. objective keywords — a test/spec/e2e vocabulary, or a review/refactor
   *     vocabulary, promotes a non-default agent whose own id advertises that
   *     focus (weak signal, capped contribution);
   *  3. `facts.git.changedFiles` — diff size decides breadth;
   *  4. `capabilities.modelSelection` + `facts.availableModels` — a model is
   *     pinned only for a broad diff, and only when the chosen agent can select
   *     one and the run is not already failing;
   *  5. `facts.workspace.languageHints` — reported, used as a small confidence
   *     bump because a known workspace makes the default-runtime choice safer;
   *  6. `signals.consecutiveFailures` — suppresses model pinning and lowers
   *     confidence (prefer the stable default).
   */
  private route(request: DecisionRequest): RuleOutcome {
    const facts = request.facts;
    const agents = facts.availableAgents;
    const defaultAgent = agents.find((a) => a.isDefaultRuntime) ?? agents[0];
    if (!defaultAgent) {
      // A broken snapshot must not become a silent route: the chain moves on.
      throw new Error('route: DecisionFacts.availableAgents is empty; Main must supply the registered agents');
    }

    const objective = request.objective;
    const signals: string[] = [];
    const evidence: DecisionEvidence[] = [];
    let confidence = 0.3;

    const testHits = keywordHits(objective, TEST_KEYWORDS);
    const reviewHits = keywordHits(objective, REVIEW_KEYWORDS);
    const specialty = testHits.length > 0 ? 'test' : reviewHits.length > 0 ? 'review' : null;
    if (specialty === 'test') {
      signals.push(`objective mentions tests [${testHits.join(', ')}]`);
      confidence += 0.15;
    } else if (specialty === 'review') {
      signals.push(`objective mentions review/refactor work [${reviewHits.join(', ')}]`);
      confidence += 0.1;
    }

    const changedFiles = facts.git.changedFiles;
    const broad = changedFiles >= this.thresholds.broadDiffFiles;
    if (broad) signals.push(`diff is broad: ${changedFiles} changed files (>= ${this.thresholds.broadDiffFiles})`);
    else if (changedFiles > 0) signals.push(`diff is narrow: ${changedFiles} changed file(s)`);
    else signals.push('no changed files in the worktree');
    if (facts.git.dirty && changedFiles > 0) signals.push('worktree is dirty (uncommitted work in progress)');
    if (broad) confidence += 0.1;
    evidence.push({ ref: 'facts.git.changedFiles', weight: broad ? 0.7 : 0.3 });

    const languageHints = facts.workspace.languageHints.filter((h) => h.trim().length > 0);
    if (languageHints.length > 0) {
      signals.push(`workspace language hints [${languageHints.join(', ')}]`);
      confidence += 0.05;
    }
    evidence.push({ ref: 'facts.workspace.languageHints', weight: 0.3 });

    // A specialised agent is only promoted when its own id advertises the focus.
    let chosen = defaultAgent;
    if (specialty) {
      const wanted = specialty === 'test' ? TEST_KEYWORDS : REVIEW_KEYWORDS;
      const wantedTokens = new Set(wanted);
      const candidates = agents
        .filter((a) => !a.isDefaultRuntime)
        .map((a) => ({
          agent: a,
          hits: a.id
            .toLowerCase()
            .split(/[^a-z0-9]+/i)
            .filter((t) => wantedTokens.has(t)).length,
        }))
        .filter((c) => c.hits > 0)
        .sort((a, b) => b.hits - a.hits || a.agent.id.localeCompare(b.agent.id));
      const best = candidates[0];
      if (best) {
        chosen = best.agent;
        signals.push(`promoted agent '${best.agent.id}' (its id advertises a ${specialty} focus)`);
        confidence += 0.15;
        evidence.push({ ref: 'facts.availableAgents', weight: 0.5 });
      } else {
        signals.push(`no registered agent advertises a ${specialty} focus; keeping the default runtime`);
      }
    }

    const failing = facts.signals.consecutiveFailures;
    let modelId: string | undefined;
    if (failing > 0) {
      signals.push(`${failing} consecutive failure(s): no model pinning, staying on the stable runtime`);
      confidence -= 0.2;
    } else if (!chosen.capabilities.modelSelection) {
      signals.push(`agent '${chosen.id}' has modelSelection=false, so no model is pinned`);
    } else if (!broad) {
      signals.push('diff is not broad enough to justify pinning a model');
    } else if (facts.availableModels.length === 0) {
      signals.push('agent can select a model but facts.availableModels is empty');
    } else {
      const models = [...facts.availableModels].sort(
        (a, b) => (b.contextWindowTokens ?? 0) - (a.contextWindowTokens ?? 0) || a.id.localeCompare(b.id),
      );
      const picked = models[0];
      if (picked) {
        modelId = picked.id;
        signals.push(
          `pinned model '${picked.id}' (largest contextWindowTokens=${picked.contextWindowTokens ?? 'unknown'} of ${facts.availableModels.length} available)`,
        );
        confidence += 0.1;
        evidence.push({ ref: 'facts.availableModels', weight: 0.6 });
      }
    }
    if (failing > 0) evidence.push({ ref: 'facts.signals.consecutiveFailures', weight: 0.6 });

    const confidenceValue = clamp01(confidence);
    const rationale =
      `route -> '${chosen.id}' (${chosen.isDefaultRuntime ? 'isDefaultRuntime' : 'specialised focus'}). ` +
      `signals: ${signals.join('; ')}. confidence=${confidenceValue.toFixed(2)}`;

    return {
      outcome: { kind: 'route', agentId: chosen.id, ...(modelId !== undefined ? { modelId } : {}) },
      confidence: confidenceValue,
      rationale,
      evidence,
    };
  }

  // -------------------------------------------------------------------------
  // risk
  // -------------------------------------------------------------------------

  /**
   * Signals: workspace trust, `signals.permissionDenials`,
   * `signals.consecutiveFailures`, `facts.git.changedFiles` and the objective's
   * own permission vocabulary (which categories the work touches). Categories
   * with no signal are omitted rather than guessed — an invented category would
   * make the Permission Engine's job harder (§4.9).
   */
  private risk(request: DecisionRequest): RuleOutcome {
    const facts = request.facts;
    const signals: string[] = [];
    const evidence: DecisionEvidence[] = [];
    let score = 0;

    if (!facts.workspace.trusted) {
      signals.push('workspace is not trusted');
      score += 2;
      evidence.push({ ref: 'facts.workspace.trusted', weight: 0.8 });
    } else {
      signals.push('workspace is trusted');
    }

    const denials = facts.signals.permissionDenials;
    if (denials >= 2) {
      signals.push(`${denials} permission denials`);
      score += 2;
    } else if (denials === 1) {
      signals.push('1 permission denial');
      score += 1;
    } else {
      signals.push('no permission denials');
    }
    if (denials > 0) evidence.push({ ref: 'facts.signals.permissionDenials', weight: 0.7 });

    const failures = facts.signals.consecutiveFailures;
    if (failures >= 3) {
      signals.push(`${failures} consecutive failures (blast radius unknown)`);
      score += 2;
    } else if (failures > 0) {
      signals.push(`${failures} consecutive failure(s)`);
      score += 1;
    }

    const changedFiles = facts.git.changedFiles;
    if (changedFiles >= this.thresholds.highDiffFiles) {
      signals.push(`${changedFiles} changed files (>= ${this.thresholds.highDiffFiles})`);
      score += 2;
    } else if (changedFiles >= this.thresholds.mediumDiffFiles) {
      signals.push(`${changedFiles} changed files (>= ${this.thresholds.mediumDiffFiles})`);
      score += 1;
    }
    if (facts.git.dirty) signals.push('worktree is dirty');
    evidence.push({ ref: 'facts.git.changedFiles', weight: changedFiles > 0 ? 0.5 : 0.1 });

    const categories: PermissionCategory[] = [];
    for (const { category, keywords } of CATEGORY_KEYWORDS) {
      const hits = keywordHits(request.objective, keywords);
      if (hits.length > 0) {
        categories.push(category);
        signals.push(`objective touches ${category} [${hits.slice(0, 4).join(', ')}]`);
      }
    }

    const risk = score >= 3 ? 'high' : score >= 1 ? 'medium' : 'low';
    const confidence = clamp01(
      0.55 + (facts.workspace.trusted ? 0 : 0.1) + (denials > 0 ? 0.05 : 0) + (changedFiles > 0 ? 0.05 : 0),
    );
    const rationale =
      `risk=${risk} (score ${score}: ${signals.join('; ')}). ` +
      `categories=[${categories.join(', ') || 'none'}]. confidence=${confidence.toFixed(2)}`;

    return {
      outcome: { kind: 'risk', risk, categories },
      confidence,
      rationale,
      evidence,
    };
  }

  // -------------------------------------------------------------------------
  // continue_or_stop
  // -------------------------------------------------------------------------

  private continueOrStop(request: DecisionRequest): RuleOutcome {
    const { signals } = request.facts;
    let action: 'continue' | 'stop' | 'ask_user';
    let reason: string;
    let confidence: number;
    const evidence: DecisionEvidence[] = [];

    if (signals.consecutiveFailures >= this.thresholds.failureLimit) {
      action = 'stop';
      reason =
        `signals.consecutiveFailures=${signals.consecutiveFailures} >= ${this.thresholds.failureLimit}: ` +
        'the same approach keeps failing, retrying would only burn budget';
      confidence = 0.9;
      evidence.push({ ref: 'facts.signals.consecutiveFailures', weight: 0.9 });
    } else if (signals.permissionDenials >= this.thresholds.denialLimit) {
      action = 'ask_user';
      reason =
        `signals.permissionDenials=${signals.permissionDenials} >= ${this.thresholds.denialLimit}: ` +
        'repeated denials mean the plan is not authorised, the user has to re-approve or redirect';
      confidence = 0.85;
      evidence.push({ ref: 'facts.signals.permissionDenials', weight: 0.85 });
    } else if (signals.elapsedMs > this.thresholds.elapsedLimitMs) {
      action = 'ask_user';
      reason =
        `signals.elapsedMs=${signals.elapsedMs} exceeds the ${this.thresholds.elapsedLimitMs}ms turn budget: ` +
        'asking whether to keep going is cheaper than silently running long';
      confidence = 0.7;
      evidence.push({ ref: 'facts.signals.elapsedMs', weight: 0.7 });
    } else {
      action = 'continue';
      reason =
        `signals.consecutiveFailures=${signals.consecutiveFailures} (< ${this.thresholds.failureLimit}), ` +
        `signals.permissionDenials=${signals.permissionDenials} (< ${this.thresholds.denialLimit}), ` +
        `signals.elapsedMs=${signals.elapsedMs} (<= ${this.thresholds.elapsedLimitMs}), ` +
        `turnIndex=${signals.turnIndex}: nothing warrants stopping`;
      confidence = 0.75;
    }

    return {
      outcome: { kind: 'continue_or_stop', action, reason },
      confidence,
      rationale: `continue_or_stop -> ${action}. ${reason}. confidence=${clamp01(confidence).toFixed(2)}`,
      evidence,
    };
  }

  // -------------------------------------------------------------------------
  // context_relevance
  // -------------------------------------------------------------------------

  /**
   * Honest limitation (D-5): `DecisionFacts.context` is a *pack level* summary —
   * packId, itemCount, estimatedTokens, freshness. Item ids are deliberately not
   * exposed to a DecisionEngine, so item level relevance is the ContextBroker's
   * job (T-5). This decision therefore reports the pack level verdict plus
   * `evidence` entries that reference the exact fact fields it used, instead of
   * inventing item ids.
   */
  private contextRelevance(request: DecisionRequest): RuleOutcome {
    const { context } = request.facts;
    const evidence: DecisionEvidence[] = [
      { ref: 'facts.context.freshness', weight: 0.8 },
      { ref: 'facts.context.itemCount', weight: 0.5 },
      { ref: 'facts.context.estimatedTokens', weight: 0.4 },
    ];

    const signals = [
      `facts.context.freshness=${context.freshness}`,
      `facts.context.itemCount=${context.itemCount}`,
      `facts.context.estimatedTokens=${context.estimatedTokens}`,
      context.packId ? `facts.context.packId=${context.packId}` : 'facts.context.packId=<none>',
    ];

    const usable = context.freshness === 'fresh' && context.itemCount > 0;
    const rationale = usable
      ? `pack is usable: ${signals.join('; ')}. ` +
        'Item level ids are not part of DecisionFacts (D-5), so this engine reports the pack level verdict ' +
        'and leaves per item relevance to the ContextBroker (T-5). ' +
        'confidence=0.35 (pack level only)'
      : `pack is NOT usable: ${signals.join('; ')}. ` +
        'Item level ids are not part of DecisionFacts (D-5); a stale or empty pack must be re-built by the ' +
        'ContextBroker before any item is trusted (T-5 step 2). confidence=0.55';

    return {
      outcome: { kind: 'context_relevance', relevantItemIds: [] },
      confidence: usable ? 0.35 : 0.55,
      rationale,
      evidence,
    };
  }

  // -------------------------------------------------------------------------
  // clarify
  // -------------------------------------------------------------------------

  private clarify(request: DecisionRequest): RuleOutcome {
    const objective = request.objective.trim();
    const options = request.options ?? [];
    const vague = VAGUE_PATTERNS.some((p) => p.test(objective));
    const denials = request.facts.signals.permissionDenials;
    const signals: string[] = [];
    let confidence: number;
    let question: string;

    if (objective.length < 12) {
      confidence = 0.9;
      question = '目标太短，无法据此行动。请说明要改哪个文件、期望的行为是什么？';
      signals.push(`objective length ${objective.length} < 12 chars`);
    } else if (vague) {
      confidence = 0.6;
      question = `「${objective}」的范围不明确。要我直接动手，还是先列出受影响文件和一个执行计划？`;
      signals.push('objective matched a vague-phrasing pattern');
    } else if (denials > 0) {
      confidence = 0.7;
      question =
        `本回合已有 ${denials} 次权限被拒绝。请确认接下来允许我做什么` +
        '（例如：只读分析 / 允许写入 workspace 内文件 / 先给出计划再执行）？';
      signals.push(`signals.permissionDenials=${denials} > 0`);
    } else {
      confidence = 0.3;
      question = `按当前目标「${objective}」直接开始，还是先确认范围？`;
      signals.push('no clarification signal found; this is a confirmation, not a blocker');
    }

    const labels = options
      .map((o) => o.label)
      .filter((l) => typeof l === 'string' && l.trim().length > 0);
    const rationale =
      `clarify: ${signals.join('; ')}; objective length ${objective.length}; ` +
      `request.options=${options.length}. confidence=${clamp01(confidence).toFixed(2)}`;

    return {
      outcome: {
        kind: 'clarify',
        question,
        ...(labels.length > 0 ? { options: labels } : {}),
      },
      confidence,
      rationale,
      evidence: [{ ref: 'request.objective', weight: 0.6 }],
    };
  }

  // -------------------------------------------------------------------------
  // option_select
  // -------------------------------------------------------------------------

  /**
   * Deterministic scoring: distinct objective tokens found in an option's
   * `id` / `label` / `description`. Ties break on the shortest label and then on
   * the lexicographically smallest id, so the same input always yields the same
   * option.
   */
  private optionSelect(request: DecisionRequest): RuleOutcome {
    const options: DecisionOption[] = request.options ?? [];
    const tokens = new Set(
      request.objective
        .toLowerCase()
        .split(/[^a-z0-9]+/i)
        .filter((t) => t.length >= 3),
    );

    const scored = options
      .map((option) => {
        const text = `${option.id} ${option.label} ${option.description ?? ''}`.toLowerCase();
        const hits = [...tokens].filter((t) => text.includes(t));
        return { option, hits, score: hits.length };
      })
      .sort(
        (a, b) =>
          b.score - a.score ||
          a.option.label.length - b.option.label.length ||
          a.option.id.localeCompare(b.option.id),
      );

    const best = scored[0];
    if (!best || best.score === 0) {
      const rationale =
        options.length === 0
          ? 'option_select: request.options is empty, so no option can be selected; the caller must re-ask. confidence=0.00'
          : `option_select: none of the ${options.length} option(s) [${options
              .map((o) => o.id)
              .join(', ')}] shares a token with the objective, so the first option by id is returned as the deterministic default. confidence=0.20`;
      return {
        // No options at all: the empty id is the honest "nothing was selectable"
        // marker, stated in the rationale. Inventing an id would be worse.
        outcome: { kind: 'option_select', optionId: best?.option.id ?? '' },
        confidence: options.length === 0 ? 0 : 0.2,
        rationale,
        evidence: [{ ref: 'request.options', weight: 0.4 }],
      };
    }

    const confidence = clamp01(0.3 + 0.15 * best.score);
    const rationale =
      `option_select -> '${best.option.id}' (label '${best.option.label}'); ` +
      `matched objective tokens [${best.hits.join(', ')}] against ${options.length} option(s); ` +
      `confidence=${confidence.toFixed(2)}`;

    return {
      outcome: { kind: 'option_select', optionId: best.option.id },
      confidence,
      rationale,
      evidence: [{ ref: 'request.options', weight: 0.6 }],
    };
  }
}
