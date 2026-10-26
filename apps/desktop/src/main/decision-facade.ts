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

/**
 * Why an engine was dropped from the chain the user asked for.
 *
 * The chain is pruned for three different reasons, and a log line that does not
 * say which one left the reader guessing: "an engine was dropped" cannot tell
 * a person whether to fix a typo, to remove a duplicated entry, or to change a
 * setting they never gave. The event string already separated the branches,
 * but two of them shared a branch — a manifest that contradicts itself and a
 * manifest asking for an effect nobody authorised both arrived as "an engine
 * whose effects are not authorised", which is false of the first one: its
 * effects were not unauthorised, they were unreadable.
 *
 * So the reason is a field of its own, and every drop line carries one:
 *
 * - `unknown` — this build does not know the id at all;
 * - `duplicate` — the chain named the same engine twice;
 * - `contradiction` — the manifest says two things at once (NFR-14);
 * - `unauthorized` — it declares an effect no setting permits.
 */
export type EngineChainDropReason = 'unknown' | 'duplicate' | 'contradiction' | 'unauthorized';

/**
 * Why an engine's declared side effects may not run.
 *
 * The two refusals that are about the manifest rather than about the chain:
 * a declaration that contradicts itself, and one that asks for an effect no
 * setting permits. They need different fixes — a manifest to correct and a
 * setting to switch — so they are told apart.
 */
export type SideEffectRefusal = 'contradiction' | 'unauthorized';

/**
 * What each refusal means, in the log line.
 *
 * `EngineChainDropReason` has had this shape since the reason became a log
 * field: `satisfies Record<…>` turns "add a reason" into a `tsc` error at the
 * table. `SideEffectRefusal` did not, so a third refusal was a change `tsc`
 * had nothing to say about — `refusalReason` would return it, the log line
 * would print the bare token, and every test would still pass, because none
 * of them could enumerate the members of a type.
 *
 * So the members of the union now have a table of their own: adding one to
 * {@link SideEffectRefusal} fails `npm run typecheck` until it is explained
 * here, and the log reads the sentence from it rather than leaving a reader to
 * look the token up in this file. Exported for the runtime half of the same
 * check (`tests/contract/decision-chain.test.ts`), because the suite
 * transpiles without typechecking and a test cannot enumerate a type either.
 */
export const SIDE_EFFECT_REFUSAL_EXPLANATION: Record<SideEffectRefusal, string> = {
  contradiction: 'the manifest contradicts itself, so no setting can make it runnable',
  unauthorized: 'no setting in this build authorises an effect it declares',
};

/**
 * The reasons, as the log writes them.
 *
 * A map rather than bare literals so that `tsc` checks every one of them
 * against {@link EngineChainDropReason}: a misspelled reason in a log field is
 * the kind of drift a support report cannot see — the line looks right and the
 * reason is wrong.
 */
const DROP_REASON = {
  unknown: 'unknown',
  duplicate: 'duplicate',
  contradiction: 'contradiction',
  unauthorized: 'unauthorized',
} as const satisfies Record<EngineChainDropReason, EngineChainDropReason>;

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
   *   dropped, and so is one whose manifest contradicts itself (NFR-14). The
   *   check lives here, in Main — the Settings UI also hides the checkbox, but
   *   a UI check is not a permission.
   * - A duplicate id is dropped: calling the same engine twice in one chain
   *   would compute the same answer twice and make the trace lie.
   * - An empty result falls back to the rule engine, which is always present.
   *
   * Every drop is logged with the reason it happened, in a field of its own
   * rather than only in the event string: a report counts the reasons without
   * matching on the messages, and the two refusals that used to share one
   * line are told apart.
   */
  private resolveChainIds(engineIds: readonly string[]): string[] {
    const ids: string[] = [];
    for (const id of engineIds) {
      const engine = this.registry.get(id);
      if (!engine) {
        // A settings document written by another build, or a typo. The user's
        // chain and the running chain now differ, and this is the only trace
        // of *why* — silence here made the discrepancy unexplainable.
        this.opts.logger.warn('engine chain: dropping an unknown engine id', {
          reason: DROP_REASON.unknown,
          engineId: id,
          requested: engineIds,
        });
        continue;
      }
      const refusal = this.refusalReason(engine);
      if (refusal !== undefined) {
        // NFR-14: no setting authorises this engine's effects, or the manifest
        // contradicts itself, so it may not run whatever the settings file
        // says. Recorded, not implied — and the `reason` says which of the two
        // it was, because the two need different fixes: a manifest to correct
        // and a setting to switch.
        this.opts.logger.warn('engine chain: dropping an engine whose effects may not run', {
          reason: refusal,
          // The token is what a report counts; this is what a person reading
          // the line can act on without opening this file. Read from the table
          // so a refusal added without an explanation is a `tsc` error.
          reasonExplanation: SIDE_EFFECT_REFUSAL_EXPLANATION[refusal],
          engineId: id,
          sideEffects: engine.manifest.sideEffects ?? [],
          allowNetworkEngines: this.opts.allowNetworkEngines,
          requested: engineIds,
        });
        continue;
      }
      if (ids.includes(id)) {
        // Running an engine twice would compute the same answer twice and make
        // the decision trace claim two engines agreed.
        this.opts.logger.info('engine chain: dropping a duplicate engine id', {
          reason: DROP_REASON.duplicate,
          engineId: id,
          requested: engineIds,
        });
        continue;
      }
      ids.push(id);
    }

    if (ids.length === 0) {
      // The chain the user set is empty *after* pruning. The rule engine is the
      // documented last resort (D-2), and the fallback is said out loud so
      // "Settings shows a chain, another one runs" always has a cause on record.
      this.opts.logger.info('engine chain: nothing may run from the requested chain; using the rule engine', {
        requested: engineIds,
      });
      return [RULE_ENGINE_ID];
    }

    if (ids.length !== engineIds.length) {
      this.opts.logger.info('engine chain pruned', {
        requested: engineIds,
        running: ids,
      });
    }
    return ids;
  }

  /**
   * Whether this build may run the engine at all — and if not, why.
   *
   * The question is "is every effect this engine declares authorised?", and
   * `sideEffects` is the manifest author's answer. The cases are written out
   * one by one because the previous version asked them with two `every()`
   * calls, and `[].every(…)` is vacuously `true` — so an empty declaration and
   * a `['none']` declaration happened to be allowed for a reason nobody wrote
   * down. A manifest author reading only the code could not tell what an empty
   * array meant, and a future edit to the `every()` chain could have changed it
   * silently. So:
   *
   * - **nothing declared** (`undefined` or `[]`) — the engine says it does
   *   nothing beyond answering, so there is nothing to authorise. Allowed.
   *   (Undeclared is not "unknown": `DecisionEngineManifest.sideEffects` is
   *   required by the contract, so this is only the case for a manifest built
   *   in code without the field.)
   * - **`['none']`** — the same statement, said out loud. Allowed.
   * - **`['network']`** — the one effect the user can authorise (Settings →
   *   允许联网引擎). Allowed only when they have, and `allowNetworkEngines`
   *   is read at call time so a Settings change takes effect on the next
   *   chain rebuild.
   * - **`['none', …]` mixed with anything** — a manifest that contradicts
   *   itself. A contradiction is not a permission: refused, whatever the
   *   settings say. This includes `['none', 'none']`: a declaration has exactly
   *   one way to say "no side effects", so a manifest that repeats it is not a
   *   different statement, it is a malformed one — and it is refused rather
   *   than silently read as `['none']`.
   * - **the same effect declared twice** (`['network', 'network']`) — the same
   *   malformedness as `['none', 'none']`, and refused for the same reason. It
   *   used to be allowed whenever `allowNetworkEngines` was on, because the
   *   `every()` below asks about each element and two `network`s are two
   *   elements that each pass; the rule this case list states is about the
   *   declaration's shape, not about the effects happening to be authorised.
   * - **anything else** (`process`, or an effect a newer build added) — there
   *   is no setting behind it, so nobody can have agreed to it. Refused: fail
   *   closed rather than run something nobody authorised (NFR-14).
   *
   * The return value is the *reason*, not a boolean, because the two refusals
   * above are not the same event: a manifest that contradicts itself and one
   * that asks for an effect nobody authorised both arrive as "this engine may
   * not run", and the person who has to fix it needs to know which — a
   * manifest to correct, or a setting to switch. A boolean could not say it,
   * which is why the log line said "not authorised" about a manifest whose
   * effects nobody had ever been asked about.
   */
  private refusalReason(engine: DecisionEngine): SideEffectRefusal | undefined {
    const effects: readonly string[] = engine.manifest.sideEffects ?? [];
    // Nothing declared => nothing to authorise.
    if (effects.length === 0) return undefined;
    // `none` on its own is the out-loud way of declaring what the empty array
    // says silently. Written as an explicit enumeration of the one allowed
    // shape rather than `includes('none') && length === 1`: the previous form
    // read as "contains none, and happens to be a single element", which let a
    // future edit to the predicate or to the array handling change what the
    // rule means without changing its shape.
    if (effects.length === 1 && effects[0] === 'none') return undefined;
    // `none` alongside anything else is a self-contradicting manifest; it is
    // never allowed, not even when the other effect would have been. `none`
    // twice is refused for the same reason the case list gives: the manifest
    // must state one thing, and "no effects, declared twice" is not a second
    // kind of statement.
    if (effects.includes('none')) return DROP_REASON.contradiction;
    // A declaration says one thing, once. Repeating an effect is not a wider
    // permission, it is a manifest that does not match the shape the case list
    // describes — the same reason `['none', 'none']` is refused two lines up.
    // Checked before the `every()` below, which asks per element and so cannot
    // tell `['network']` from `['network', 'network']`.
    if (new Set(effects).size !== effects.length) return DROP_REASON.contradiction;
    // Every effect needs a setting behind it. `network` has one; `process`
    // does not yet, so it is refused whatever `allowNetworkEngines` says.
    // A declaration that asks for an effect nobody authorised is not
    // self-contradicting — it is a plain request the user never agreed to,
    // which is a different thing to fix.
    if (effects.every((effect) => effect === 'network' && this.opts.allowNetworkEngines)) {
      return undefined;
    }
    return DROP_REASON.unauthorized;
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
