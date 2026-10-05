/**
 * §4.4 / ADR-016 — `JevDecisionEngine`, the probabilistic member of the chain.
 *
 * ADR-016 is the record this file implements: Jev is *an implementation of
 * `DecisionEngine`*, not an Agent Runtime peer. It classifies, routes and
 * judges risk; it never reads code, runs a tool or maintains an agent loop
 * (ADR-016 §Jev 不负责).
 *
 * Why this file is shaped the way it is:
 *
 *  - **D-5 / NFR-14, no side effects.** It imports types only, and its entire
 *    input is the read-only `DecisionFacts` summary Main assembles. There is no
 *    `node:fs`, `node:child_process` or `node:net` — the contract test in
 *    `tests/contract/decision-contract.test.ts` proves it by scanning this
 *    tree. A `DecisionEngine` may not go and look things up itself
 *    (ADR-016 §后果 6).
 *  - **Calibration over guessing.** Every score is a logistic function of named
 *    terms, and the engine *abstains* when the winner is not separated enough
 *    from the floor. An abstention is not a failure: it is the engine declining
 *    to answer, and `DecisionChain` moves on (D-2). The point of a probabilistic
 *    engine is that "I am 41% sure" is a usable signal — a chain that only ever
 *    received confident answers would be lying about that.
 *  - **NFR-16.** `rationale` names the actual terms and their values; it is
 *    never a constant, and `confidence` is the real score (the field exists in
 *    the contract precisely for an engine like this one).
 *  - **D-6.** Every value in a result is JSON: numbers, strings, booleans and
 *    plain objects. No functions, no class instances, no streams.
 *
 * Honesty note: this is a *model of* a calibrated decision engine, not a
 * trained one. The weights below are hand-set and the default scorer is
 * deterministic and inspectable on purpose — `scorer` is the seam where a real
 * Jev model replaces the arithmetic without touching this engine.
 */

import type {
  DecisionEngine,
  DecisionEngineManifest,
  DecisionEvidence,
  DecisionFacts,
  DecisionInitializeContext,
  DecisionKind,
  DecisionOutcome,
  DecisionRequest,
  DecisionResult,
  PermissionCategory,
  RiskLevel,
} from '@ucad/contracts';
import type { DecisionLogger } from '@ucad/contracts';
import type { Logger } from '@ucad/observability';

export const JEV_ENGINE_ID = 'jev';
export const JEV_ENGINE_VERSION = '0.1.0';

/**
 * ADR-016 is a V1-capable extension point, and Jev only earns that place by
 * being *narrow*: it claims `route` and `risk` and nothing else. For every
 * other kind `supports()` is false, so the chain records
 * `unsupported_kind` and moves on instead of accepting a fabricated answer.
 */
export const JEV_ENGINE_SUPPORTED_KINDS: ReadonlyArray<DecisionKind> = ['route', 'risk'];

/** Conservative: Main clamps every call to DECISION_HARD_TIMEOUT_MS (2000). */
export const JEV_ENGINE_TIMEOUT_MS = 800;

/** Below this the engine abstains rather than naming an agent or a level. */
export const DEFAULT_JEV_MIN_CONFIDENCE = 0.55;

/**
 * For `route` the confidence is at most `MARGIN_FLOOR` of the winning
 * probability: a 0.9 probability shared equally by two agents is not a 0.9
 * confidence, it is a coin flip between them.
 */
const MARGIN_FLOOR = 0.7;

// ---------------------------------------------------------------------------
// scoring vocabulary
// ---------------------------------------------------------------------------

/** Task families the objective can be in. Deterministic, keyword driven. */
const TASK_FAMILIES: ReadonlyArray<{ family: string; keywords: ReadonlyArray<string> }> = [
  {
    family: 'test',
    keywords: ['test', 'tests', 'spec', 'e2e', 'regression', 'coverage', 'fixture', 'vitest', 'jest', 'playwright', 'pytest'],
  },
  {
    family: 'debug',
    keywords: ['bug', 'fix', 'crash', 'error', 'exception', 'traceback', 'stack', 'repro', 'flaky', 'hang', 'hangs', 'fails', 'failing', 'failure', 'debug', 'regression'],
  },
  {
    family: 'review',
    keywords: ['review', 'audit', 'lint', 'cleanup', 'smell', 'naming', 'style', 'docs'],
  },
  {
    family: 'refactor',
    keywords: ['refactor', 'architecture', 'design', 'pattern', 'structure', 'simplify', 'duplication'],
  },
  {
    family: 'build',
    keywords: ['implement', 'add', 'build', 'create', 'feature', 'wire', 'integrate', 'migrate', 'port'],
  },
  {
    family: 'perf',
    keywords: ['perf', 'performance', 'slow', 'latency', 'optimize', 'optimise', 'memory', 'throughput', 'profiling'],
  },
];

/** Permission vocabulary, used only to name the categories the work touches. */
const CATEGORY_KEYWORDS: ReadonlyArray<{ category: PermissionCategory; keywords: ReadonlyArray<string> }> = [
  { category: 'FILE_WRITE', keywords: ['write', 'edit', 'create', 'modify', 'refactor', 'implement', 'fix', 'patch', 'rename'] },
  { category: 'FILE_DELETE', keywords: ['delete', 'remove', 'drop', 'unlink', 'purge', 'revert'] },
  { category: 'SHELL', keywords: ['run', 'npm', 'npx', 'pnpm', 'yarn', 'exec', 'shell', 'command', 'script', 'build', 'make', 'test'] },
  { category: 'NETWORK', keywords: ['http', 'https', 'api', 'fetch', 'curl', 'download', 'install', 'registry', 'webhook'] },
  { category: 'GIT_WRITE', keywords: ['commit', 'push', 'branch', 'merge', 'rebase', 'tag', 'cherry-pick', 'stash'] },
];

/** Objective shapes no scorer can act on; they are named in the rationale. */
const VAGUE_PATTERNS: ReadonlyArray<RegExp> = [
  /^(fix|do|go)\b/i,
  /\b(clean|simplify|improve|make)\s+it\b/i,
  /优化/,
  /重构一下/,
  /继续/,
  /怎么办/,
  /你看一下/,
];

// ---------------------------------------------------------------------------
// options and the scorer seam
// ---------------------------------------------------------------------------

/**
 * The scoring seam. A future real Jev model implements this and the engine is
 * unchanged. "Deterministic given its input" is a *contract on the scorer*, not
 * a hope: a scorer that flipped its answer would make the chain unreplayable and
 * the Drawer's explanation a fiction.
 */
export type JevScorer = (input: { objective: string; facts: DecisionFacts; agentId: string }) => Promise<number>;

export interface JevEngineOptions {
  logger: Logger;
  /**
   * Replaces the built-in logistic scorer for `route`. Risk keeps the engine's
   * own calibration: a risk level is a property of the *situation*, not of an
   * agent, so the agent-shaped seam does not describe it honestly.
   */
  scorer?: JevScorer;
  /** reject candidates scoring below this; below the floor the engine abstains */
  minConfidence?: number;
}

// ---------------------------------------------------------------------------
// abstention
// ---------------------------------------------------------------------------

/**
 * Thrown when the engine declines to answer.
 *
 * `DecisionChain` treats a throw as "this engine could not answer" and moves to
 * the next one (D-2) — which is exactly the semantic of an abstention. A
 * *returned* result would instead be taken as the chain's answer, because the
 * chain has no concept of a low-confidence winner; returning `confidence: 0`
 * with a guessed `agentId` would be a guess dressed up as a decision. The
 * low-confidence verdict is not thrown away: it travels on this error as
 * `verdict`, so a direct caller and the chain's `detail` both see *why*.
 */
export class JevAbstainedError extends Error {
  /** D-6: the abstained verdict is plain JSON, exactly like a real result. */
  readonly verdict: DecisionResult;
  readonly bestAgentId: string | null;
  readonly score: number;
  readonly minConfidence: number;
  readonly rationale: string;

  constructor(input: {
    kind: DecisionKind;
    requestId: string;
    producedBy: DecisionResult['producedBy'];
    latencyMs: number;
    /** the outcome the engine *would* have returned; it carries the low score */
    outcome: DecisionOutcome;
    bestAgentId: string | null;
    score: number;
    minConfidence: number;
    rationale: string;
  }) {
    super(`jev abstained on '${input.kind}': ${input.rationale}`);
    this.name = 'JevAbstainedError';
    this.bestAgentId = input.bestAgentId;
    this.score = input.score;
    this.minConfidence = input.minConfidence;
    this.rationale = input.rationale;
    this.verdict = {
      requestId: input.requestId,
      outcome: input.outcome,
      confidence: clamp01(input.score),
      rationale: `ABSTAINED. ${input.rationale}`,
      producedBy: input.producedBy,
      latencyMs: input.latencyMs,
    };
  }
}

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  const bounded = n < 0 ? 0 : n > 1 ? 1 : n;
  return Math.round(bounded * 100) / 100;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function logistic(z: number): number {
  return 1 / (1 + Math.exp(-z));
}

function aborted(): Error {
  const err = new Error('decision aborted by caller');
  err.name = 'AbortError';
  return err;
}

/** ASCII keywords match a whole token so "latest" is not a "test"; CJK is a substring. */
function keywordHits(text: string, keywords: ReadonlyArray<string>): string[] {
  const lower = text.toLowerCase();
  const tokens = new Set(lower.split(/[^a-z0-9+#._-]+/i).filter((t) => t.length > 0));
  return keywords.filter((k) => (/^[!-~]+$/.test(k) ? tokens.has(k) : lower.includes(k)));
}

/** The dominant task family of an objective, or null when it declares none. */
function taskFamily(objective: string): { family: string; hits: string[] } | null {
  let best: { family: string; hits: string[] } | null = null;
  for (const entry of TASK_FAMILIES) {
    const hits = keywordHits(objective, entry.keywords);
    if (hits.length === 0) continue;
    if (best === null || hits.length > best.hits.length) best = { family: entry.family, hits };
  }
  return best;
}

/**
 * How strongly an agent advertises a family: its own id tokens (an agent called
 * `test-runner` says so out loud) plus its manifest kind. This is the only thing
 * the engine knows about an agent — D-5 forbids looking inside one.
 */
function agentAffinity(agentId: string, kind: string, family: string): number {
  const tokens = new Set(agentId.toLowerCase().split(/[^a-z0-9]+/i).filter((t) => t.length > 0));
  let score = 0;
  for (const token of tokens) {
    if (token === family || token === `${family}s` || token.startsWith(`${family}-`)) {
      score += 0.6;
    } else if (family.length > 3 && (token.includes(family) || family.includes(token))) {
      score += 0.3;
    }
  }
  if (kind.toLowerCase() === family) score += 0.4;
  return Math.min(1, score);
}

/** `0..1`, saturating: a short objective carries less routing information. */
function specificity(objective: string): number {
  return 1 - Math.exp(-objective.trim().length / 48);
}

/** `0..1` on a log scale; 50 changed files is "as broad as this model cares". */
function breadth(changedFiles: number): number {
  if (!Number.isFinite(changedFiles) || changedFiles <= 0) return 0;
  return Math.min(1, Math.log1p(changedFiles) / Math.log1p(50));
}

/** `0..1`: a flailing session (many turns, repeated failures) is less predictable. */
function instability(facts: DecisionFacts): number {
  const failures = clamp01(facts.signals.consecutiveFailures / 3);
  const turns = clamp01(facts.signals.turnIndex / 20);
  return clamp01(0.7 * failures + 0.3 * turns);
}

/** One named, individually reportable term of the route score. */
interface Term {
  name: string;
  value: number;
  weight: number;
  /** what the term actually saw — the rationale quotes this verbatim */
  observed: string;
}

interface ScoredAgent {
  agentId: string;
  isDefaultRuntime: boolean;
  probability: number;
  terms: Term[];
}

// ---------------------------------------------------------------------------
// the engine
// ---------------------------------------------------------------------------

export class JevDecisionEngine implements DecisionEngine {
  readonly manifest: DecisionEngineManifest;

  private readonly minConfidence: number;
  private readonly scorer: JevScorer | null;
  private readonly baseLogger: Logger | null;
  private logger: DecisionLogger | null = null;

  constructor(options: JevEngineOptions) {
    this.minConfidence = clamp01(options.minConfidence ?? DEFAULT_JEV_MIN_CONFIDENCE);
    this.scorer = options.scorer ?? null;
    this.baseLogger = options.logger;
    this.manifest = {
      id: JEV_ENGINE_ID,
      displayName: 'Jev Calibrated Decision Engine',
      version: JEV_ENGINE_VERSION,
      // NFR-14: truthful. The scorer is a pure function of the facts it is
      // handed; nothing here opens a socket or a process.
      sideEffects: ['none'],
      supportedKinds: [...JEV_ENGINE_SUPPORTED_KINDS],
      timeoutMs: JEV_ENGINE_TIMEOUT_MS,
    };
  }

  async initialize(ctx: DecisionInitializeContext): Promise<void> {
    this.logger = ctx.logger;
    this.logger?.debug('jev engine initialized', {
      workspaceId: ctx.workspaceId,
      kinds: this.manifest.supportedKinds,
      scorer: this.scorer === null ? 'built-in logistic' : 'injected',
      minConfidence: this.minConfidence,
    });
  }

  supports(kind: DecisionKind): boolean {
    return this.manifest.supportedKinds.includes(kind);
  }

  /**
   * `request.timeoutMs` is deliberately ignored: `DecisionChain` clamps the
   * budget to `min(manifest.timeoutMs, request.timeoutMs, 2000)`, so an engine
   * cannot widen its own deadline (D-2 / NFR-05).
   */
  async decide(request: DecisionRequest, signal?: AbortSignal): Promise<DecisionResult> {
    if (signal?.aborted) throw aborted();
    const started = Date.now();

    if (!this.supports(request.kind)) {
      // The chain checks `supports()` first, so this is a direct-call guard: an
      // unsupported kind is answered with a refusal, never with a guess.
      throw new Error(
        `jev engine does not support kind '${request.kind}' ` +
          `(supported: ${this.manifest.supportedKinds.join(', ')})`,
      );
    }
    if (request.kind === 'route') return this.route(request, started);
    if (request.kind === 'risk') return this.risk(request, started);
    throw new Error(`jev engine received an unknown kind: ${String(request.kind)}`);
  }

  async dispose(): Promise<void> {
    this.logger = null;
  }

  // -------------------------------------------------------------------------
  // route
  // -------------------------------------------------------------------------

  /**
   * The score of one candidate is a logistic blend of five named terms:
   *
   *  1. `focus`      — the objective's task family against the agent's own
   *                    advertised strength. The only routing signal.
   *  2. `breadth`    — `facts.git.changedFiles`; it *amplifies* `focus`,
   *                    because a broad diff is where picking the wrong agent
   *                    actually costs something.
   *  3. `specificity`— the objective's length; a two-word objective cannot
   *                    support a confident route whatever the arithmetic says.
   *  4. `instability`— repeated failures and a high turn index; a flailing
   *                    session is less predictable, so confidence drops.
   *  5. `default`    — a small prior for the registered default runtime
   *                    (ADR-017): when the signals are weak, the known-good
   *                    runtime is the right bet.
   *
   * The reported confidence is the winner's probability shrunk by the *margin*
   * over the runner-up. Both are named in the rationale.
   */
  private async route(request: DecisionRequest, started: number): Promise<DecisionResult> {
    const { facts, objective } = request;
    const agents = facts.availableAgents;
    if (agents.length === 0) {
      // A broken snapshot must not become a silent route: the chain moves on.
      throw new Error('route: DecisionFacts.availableAgents is empty; Main must supply the registered agents');
    }

    const family = taskFamily(objective);
    const specific = specificity(objective);
    // Absent git facts contribute no breadth: "git status did not answer" is
    // not "0 changed files", and a route that amplified focus on the strength
    // of a failed status call would be explaining a number nobody measured.
    const wide = facts.git ? breadth(facts.git.changedFiles) : 0;
    const gitObserved = facts.git
      ? `${facts.git.changedFiles} changed file(s) -> breadth ${wide.toFixed(2)}`
      : 'git facts unavailable, breadth contributes nothing';
    const unstable = instability(facts);
    const vague = VAGUE_PATTERNS.some((p) => p.test(objective));

    const scored: ScoredAgent[] = [];
    for (const agent of agents) {
      const affinity = family ? agentAffinity(agent.id, agent.kind, family.family) : 0;
      const focus = family ? affinity * 2 - 0.5 : 0;
      const defaultPrior = agent.isDefaultRuntime ? 1 : 0;

      let probability: number;
      let terms: Term[];
      if (this.scorer) {
        // An injected model owns the number; the engine still owns the
        // abstention policy and the margin, and it reports which facts it
        // showed the scorer so the explanation is not a fiction.
        probability = clamp01(await this.scorer({ objective, facts, agentId: agent.id }));
        terms = [
          { name: 'injected_scorer', value: probability, weight: 1, observed: `scorer('${agent.id}')=${probability.toFixed(2)}` },
          { name: 'specificity', value: specific, weight: 0, observed: `objective length ${objective.trim().length}` },
          { name: 'instability', value: unstable, weight: 0, observed: `${facts.signals.consecutiveFailures} failure(s), turn ${facts.signals.turnIndex}` },
        ];
      } else {
        const weighted: Term[] = [
          {
            name: 'focus',
            value: focus,
            weight: 1.5 * (0.6 + 0.4 * wide),
            observed: family
              ? `objective family '${family.family}' [${family.hits.join(', ')}] vs agent '${agent.id}' affinity ${affinity.toFixed(2)}`
              : 'objective names no task family, so no agent is preferred on focus',
          },
          { name: 'breadth', value: wide, weight: 0, observed: gitObserved },
          { name: 'specificity', value: specific, weight: 0.9 * (specific - 0.5), observed: `objective length ${objective.trim().length} -> specificity ${specific.toFixed(2)}` },
          { name: 'instability', value: unstable, weight: -0.8 * unstable, observed: `${facts.signals.consecutiveFailures} consecutive failure(s), turnIndex ${facts.signals.turnIndex} -> instability ${unstable.toFixed(2)}` },
          { name: 'default', value: defaultPrior, weight: 0.6 * defaultPrior, observed: agent.isDefaultRuntime ? 'agent is the registered default runtime' : 'agent is not the default runtime' },
        ];
        const logit = weighted.reduce((sum, term) => sum + term.value * term.weight, 0) + 0.35;
        probability = logistic(logit);
        terms = weighted;
      }

      scored.push({ agentId: agent.id, isDefaultRuntime: agent.isDefaultRuntime, probability, terms });
    }

    scored.sort((a, b) => b.probability - a.probability || a.agentId.localeCompare(b.agentId));
    const best = scored[0];
    if (!best) throw new Error('route: no candidate could be scored');
    const runnerUp = scored[1];

    // A single candidate is not a decision between agents; it is the only
    // option, so the margin is full and the objective's own quality carries it.
    const margin = runnerUp === undefined ? 1 : best.probability - runnerUp.probability;
    const margin01 = clamp01(margin / 0.5);
    const confidence = clamp01(best.probability * (MARGIN_FLOOR + (1 - MARGIN_FLOOR) * margin01));

    const signals = best.terms.map((t) => `${t.name}=${t.value.toFixed(2)} (${t.observed})`);
    if (vague) signals.push('objective matched a vague-phrasing pattern, which caps confidence');
    signals.push(
      runnerUp === undefined
        ? 'only one agent is registered, so there is no margin to measure'
        : `margin over '${runnerUp.agentId}' (${best.probability.toFixed(2)} vs ${runnerUp.probability.toFixed(2)} -> ${margin01.toFixed(2)})`,
    );

    if (confidence < this.minConfidence) {
      const rationale =
        `abstained: best candidate '${best.agentId}' scored ${confidence.toFixed(2)}, below the ` +
        `${this.minConfidence.toFixed(2)} floor. ${signals.join('; ')}`;
      this.logger?.warn('jev abstained on route', {
        requestId: request.requestId,
        bestAgentId: best.agentId,
        score: round2(confidence),
        minConfidence: this.minConfidence,
      });
      throw new JevAbstainedError({
        kind: 'route',
        requestId: request.requestId,
        producedBy: { engineId: this.manifest.id, version: this.manifest.version },
        latencyMs: Date.now() - started,
        outcome: { kind: 'route', agentId: best.agentId },
        bestAgentId: best.agentId,
        score: confidence,
        minConfidence: this.minConfidence,
        rationale,
      });
    }

    const evidence: DecisionEvidence[] = [
      { ref: 'request.objective', weight: round2(0.7 * specific + 0.3) },
      { ref: 'facts.availableAgents', weight: round2(best.probability) },
    ];
    if (facts.git && facts.git.changedFiles > 0)
      evidence.push({ ref: 'facts.git.changedFiles', weight: round2(wide) });
    if (facts.signals.consecutiveFailures > 0) evidence.push({ ref: 'facts.signals.consecutiveFailures', weight: round2(unstable) });

    return {
      requestId: request.requestId,
      outcome: { kind: 'route', agentId: best.agentId },
      confidence,
      rationale:
        `route -> '${best.agentId}'${best.isDefaultRuntime ? ' (default runtime)' : ''} at p=${best.probability.toFixed(2)}. ` +
        `terms: ${signals.join('; ')}. confidence=${confidence.toFixed(2)}`,
      evidence,
      producedBy: { engineId: this.manifest.id, version: this.manifest.version },
      latencyMs: Date.now() - started,
    };
  }

  // -------------------------------------------------------------------------
  // risk
  // -------------------------------------------------------------------------

  /**
   * Risk is a **cumulative ordinal model**, so the three level probabilities are
   * a real partition of 1: `P(>= medium)` and `P(= high)` are two logistic
   * curves whose thresholds are ordered, and each level is a difference. Three
   * independent sigmoids would sum to ~2.7 and the "probability" reported in
   * `confidence` would be a lie.
   *
   * Terms: `trust` (workspace is trusted or not), `denials`, `failures`,
   * `breadth` and `blast_radius` (the objective's own permission vocabulary).
   * Categories are named from that same vocabulary and never invented: a
   * category with no signal is omitted, because an invented one only makes the
   * Permission Engine's job harder (§4.9).
   *
   * Unlike `route`, the margin does **not** shrink the confidence here: a
   * near-tie between two risk *levels* means the situation sits between them,
   * not that the levels are peers, so naming the level with its own probability
   * is still honest. The margin is reported, and the floor still abstains.
   */
  private risk(request: DecisionRequest, started: number): DecisionResult {
    const { facts } = request;
    const denials = clamp01(facts.signals.permissionDenials / 3);
    const failures = clamp01(facts.signals.consecutiveFailures / 4);
    // Absent git facts score no breadth and say so — "status did not answer"
    // is a missing signal, not evidence of a clean tree.
    const wide = facts.git ? breadth(facts.git.changedFiles) : 0;
    const breadthSignal = facts.git
      ? `${facts.git.changedFiles} changed file(s) (${wide.toFixed(2)})`
      : 'unavailable (git status did not answer; contributes 0)';

    const categories: PermissionCategory[] = [];
    const categoryHits: string[] = [];
    for (const { category, keywords } of CATEGORY_KEYWORDS) {
      const hits = keywordHits(request.objective, keywords);
      if (hits.length > 0) {
        categories.push(category);
        categoryHits.push(`${category}[${hits.slice(0, 3).join(',')}]`);
      }
    }
    const blast = clamp01(categories.length / 3);
    const untrusted = facts.workspace.trusted ? 0 : 1;

    // The thresholds encode the product's own policy (§4.9): with no adverse
    // signal at all the level is `low`, not a coin flip between the three.
    const Z_MEDIUM = -0.6;
    const Z_HIGH = -1.8;
    const z = 1.25 * untrusted + 1.1 * denials + 0.9 * failures + 1.2 * wide + 0.8 * blast;

    const pAtLeastMedium = logistic(Z_MEDIUM + z);
    const pHigh = logistic(Z_HIGH + z);
    const probabilities: ReadonlyArray<{ level: RiskLevel; p: number }> = [
      { level: 'low', p: 1 - pAtLeastMedium },
      { level: 'medium', p: Math.max(0, pAtLeastMedium - pHigh) },
      { level: 'high', p: pHigh },
    ];
    const ranked = [...probabilities].sort((a, b) => b.p - a.p || a.level.localeCompare(b.level));
    const best = ranked[0];
    if (!best) throw new Error('risk: no risk level could be scored');
    const runnerUp = ranked[1];
    const margin = runnerUp === undefined ? 1 : best.p - runnerUp.p;
    const confidence = clamp01(best.p);

    const signals = [
      `trust=${facts.workspace.trusted ? 'trusted' : 'untrusted'} (${untrusted.toFixed(2)})`,
      `denials=${facts.signals.permissionDenials} (${denials.toFixed(2)})`,
      `failures=${facts.signals.consecutiveFailures} (${failures.toFixed(2)})`,
      `breadth=${breadthSignal}`,
      `blast_radius=[${categoryHits.join(' ') || 'no permission vocabulary'}] (${blast.toFixed(2)})`,
      `margin over '${runnerUp?.level ?? 'none'}' (${margin.toFixed(2)})`,
    ];

    if (confidence < this.minConfidence) {
      const rationale =
        `abstained: risk distribution peaked at '${best.level}' with p=${best.p.toFixed(2)}, below the ` +
        `${this.minConfidence.toFixed(2)} floor. ${signals.join('; ')}`;
      this.logger?.warn('jev abstained on risk', {
        requestId: request.requestId,
        risk: best.level,
        score: round2(confidence),
        minConfidence: this.minConfidence,
      });
      throw new JevAbstainedError({
        kind: 'risk',
        requestId: request.requestId,
        producedBy: { engineId: this.manifest.id, version: this.manifest.version },
        latencyMs: Date.now() - started,
        outcome: { kind: 'risk', risk: best.level, categories },
        bestAgentId: null,
        score: confidence,
        minConfidence: this.minConfidence,
        rationale,
      });
    }

    return {
      requestId: request.requestId,
      outcome: { kind: 'risk', risk: best.level, categories },
      confidence,
      rationale:
        `risk -> ${best.level} (p=${best.p.toFixed(2)}; low=${(probabilities[0]?.p ?? 0).toFixed(2)}, ` +
        `medium=${(probabilities[1]?.p ?? 0).toFixed(2)}, high=${(probabilities[2]?.p ?? 0).toFixed(2)}). ` +
        `terms: ${signals.join('; ')}. categories=[${categories.join(', ') || 'none'}]. confidence=${confidence.toFixed(2)}`,
      evidence: [
        { ref: 'facts.workspace.trusted', weight: untrusted },
        { ref: 'facts.signals.permissionDenials', weight: denials },
        { ref: 'facts.signals.consecutiveFailures', weight: failures },
        { ref: 'request.objective', weight: blast },
      ],
      producedBy: { engineId: this.manifest.id, version: this.manifest.version },
      latencyMs: Date.now() - started,
    };
  }
}

/** The one way to build the engine, so Main never imports the class directly. */
export function createJevEngine(options: JevEngineOptions): JevDecisionEngine {
  return new JevDecisionEngine(options);
}
