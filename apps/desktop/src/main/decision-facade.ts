/**
 * App-level wiring for the Decision plane.
 *
 * The Decision package deliberately knows nothing about settings or IPC
 * (§4.4, D-5). Turning "the user reordered the engine chain in Settings" and
 * "the user asked for a preview" into `DecisionRequest` calls is Main's job, so
 * it lives here rather than in the plane.
 */

import { DecisionService, DecisionChain, RuleDecisionEngine, RULE_ENGINE_ID, buildDecisionFacts } from '@ucad/decision';
import type { Database } from '@ucad/storage';
import type { Logger } from '@ucad/observability';
import { nowIso } from '@ucad/observability';
import type {
  AgentCatalogEntry,
  DecisionEngine,
  DecisionEngineManifest,
  DecisionFacts,
  DecisionKind,
  DecisionResult,
} from '@ucad/contracts';

interface AdmittedDecision {
  turnId: string;
  type: 'decision.made';
  source: { kind: 'decision'; engineId?: string };
  payload: Record<string, unknown>;
  ts: string;
}

export interface DecisionFacadeOptions {
  db: Database;
  logger: Logger;
  /**
   * Admits the `decision.made` proposal. Main owns `seq`, so this is the only
   * way the Decision plane reaches the event stream.
   */
  admit: (sessionId: string, proposal: AdmittedDecision) => void;
  chain: string[];
  timeoutMs: number;
  allowNetworkEngines: boolean;
  /**
   * The engines the user may put in the chain, besides the rule engine.
   *
   * Main decides which engines exist (it is the composition root); the facade
   * only orders them and refuses the ones the user did not authorise.
   */
  engines?: readonly DecisionEngine[];
}

export class DecisionFacade {
  private readonly opts: DecisionFacadeOptions;
  private service: DecisionService;
  /** the engines this build ships, by id */
  private readonly registry = new Map<string, DecisionEngine>();

  constructor(opts: DecisionFacadeOptions) {
    this.opts = opts;
    // The rule engine is always there: it is the chain's last resort (D-2) and
    // the only engine that answers every kind.
    this.register(new RuleDecisionEngine());
    for (const engine of opts.engines ?? []) this.register(engine);
    this.service = this.buildService(opts.chain);
  }

  private register(engine: DecisionEngine): void {
    this.registry.set(engine.manifest.id, engine);
  }

  /**
   * The chain the user asked for, minus what may not run.
   *
   * - An id this build does not know is dropped. A settings file written by a
   *   newer build, or a typo, must not be able to put a made-up engine into
   *   the chain.
   * - An engine that declares a side effect the user did not authorise is
   *   dropped (NFR-14). The check lives here, in Main — the Settings UI also
   *   hides the checkbox, but a UI check is not a permission.
   * - A duplicate id is dropped: calling the same engine twice in one chain
   *   would compute the same answer twice and make the trace lie.
   * - An empty result falls back to the rule engine, which is always present.
   */
  private resolveChainIds(engineIds: readonly string[]): string[] {
    const ids: string[] = [];
    for (const id of engineIds) {
      const engine = this.registry.get(id);
      if (!engine) continue;
      if (!this.isAllowed(engine)) continue;
      if (ids.includes(id)) continue;
      ids.push(id);
    }
    return ids.length > 0 ? ids : [RULE_ENGINE_ID];
  }

  /**
   * Whether this build may run the engine at all.
   *
   * 'network' is the side effect the user can authorise (Settings → 允许联网
   * 引擎). Any other declared effect has no setting behind it yet, so it is
   * refused: fail closed rather than run something nobody agreed to.
   */
  private isAllowed(engine: DecisionEngine): boolean {
    const effects = engine.manifest.sideEffects ?? [];
    if (effects.every((effect) => effect === 'none')) return true;
    if (effects.every((effect) => effect === 'network')) return this.opts.allowNetworkEngines;
    return false;
  }

  /**
   * Builds the service around the chain the user asked for.
   *
   * This used to be `void chain`: the chain the user set in Settings was
   * accepted, echoed back, saved — and never used, because the service was
   * always built around a single rule engine. The setting was a promise the
   * code did not keep.
   */
  private buildService(chain: readonly string[]): DecisionService {
    const ids = this.resolveChainIds(chain);
    const engines = ids
      .map((id) => this.registry.get(id))
      .filter((engine): engine is DecisionEngine => engine !== undefined);
    const decisionChain = new DecisionChain({
      engines,
      hardTimeoutMs: this.opts.timeoutMs,
      logger: this.opts.logger,
    });

    return new DecisionService({
      chain: decisionChain,
      db: this.opts.db,
      logger: this.opts.logger,
      onDecision: (proposal) => {
        this.opts.admit(proposal.turnId, {
          turnId: proposal.turnId,
          type: 'decision.made',
          source: { kind: 'decision', engineId: proposal.payload.engineId },
          payload: proposal.payload as unknown as Record<string, unknown>,
          ts: proposal.ts,
        });
      },
    });
  }

  listEngines(): DecisionEngineManifest[] {
    return [...this.registry.values()].map((engine) => engine.manifest);
  }

  get chain(): string[] {
    return this.service.engineChain.engineIds;
  }

  /**
   * Applies a settings change: only engines the user may run are accepted.
   *
   * The returned list is the chain that actually runs — not the list that was
   * asked for. An unknown engine is dropped, so the Settings panel must show
   * what is running, never what was requested.
   */
  setChain(engineIds: string[]): string[] {
    this.service = this.buildService(engineIds);
    return this.chain;
  }

  facts(input: {
    workspaceId: string;
    trusted: boolean;
    agents: AgentCatalogEntry[];
    /** omitted when `git status` did not answer — never zeros in its place */
    git?: { dirty: boolean; changedFiles: number; branch?: string };
    packId?: string;
    /** omitted => no pack was ever built for this session */
    itemCount?: number;
    estimatedTokens?: number;
    freshness?: DecisionFacts['context']['freshness'];
    turnIndex: number;
  }): DecisionFacts {
    return buildDecisionFacts({
      workspace: { id: input.workspaceId, trusted: input.trusted },
      availableAgents: input.agents.map((a) => ({
        id: a.manifest.id,
        kind: a.manifest.kind,
        isDefaultRuntime: a.manifest.isDefaultRuntime,
        capabilities: {
          streaming: a.manifest.capabilities.streaming,
          modelSelection: a.manifest.capabilities.modelSelection,
          usageReporting: a.manifest.capabilities.usageReporting,
        },
      })),
      git: input.git,
      context: {
        packId: input.packId,
        itemCount: input.itemCount,
        estimatedTokens: input.estimatedTokens,
        // "no pack yet" is `unknown`, not "fresh with zero tokens": a decision
        // that believes the context is fresh and empty is worse than one that
        // admits it does not know.
        freshness: input.freshness ?? (input.packId === undefined ? 'unknown' : 'fresh'),
      },
      signals: {
        consecutiveFailures: 0,
        permissionDenials: 0,
        elapsedMs: 0,
        turnIndex: input.turnIndex,
      },
    });
  }

  /**
   * Called by the runtime at the turn boundary, and by `decision.preview`.
   * Same engine, same guarantees, same mandatory `rationale` / `confidence`
   * (NFR-16) — a preview is not a weaker decision, it is the same decision
   * surfaced earlier.
   */
  async decide(input: {
    sessionId: string;
    turnId: string;
    objective: string;
    kind: DecisionKind;
    facts: DecisionFacts;
  }): Promise<DecisionResult> {
    const envelope = await this.service.decide({
      sessionId: input.sessionId,
      turnId: input.turnId,
      objective: input.objective,
      kind: input.kind,
      facts: input.facts,
      timeoutMs: this.opts.timeoutMs,
    });
    return envelope.result;
  }

  /**
   * `decision.preview` — the same engine, the same chain, the same mandatory
   * rationale/confidence, asked *before* the turn runs.
   *
   * It is a dry run: nothing lands in `decisions` and no `decision.made` is
   * emitted, so a preview can never be mistaken for a recorded decision and can
   * never collide with the `decisions.turn_id` foreign key (§8.1). There is no
   * `turnId` on purpose — a decision asked at the composer has no turn yet.
   */
  async preview(input: {
    sessionId: string;
    objective: string;
    kind: DecisionKind;
    facts: DecisionFacts;
  }): Promise<DecisionResult> {
    const envelope = await this.service.decide({
      sessionId: input.sessionId,
      objective: input.objective,
      kind: input.kind,
      facts: input.facts,
      timeoutMs: this.opts.timeoutMs,
      preview: true,
    });
    return envelope.result;
  }

  stamp(): string {
    return nowIso();
  }
}
