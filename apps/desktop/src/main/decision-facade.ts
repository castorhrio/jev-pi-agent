/**
 * App-level wiring for the Decision plane.
 *
 * The Decision package deliberately knows nothing about settings or IPC
 * (§4.4, D-5). Turning "the user reordered the engine chain in Settings" and
 * "the user asked for a preview" into `DecisionRequest` calls is Main's job, so
 * it lives here rather than in the plane.
 */

import { DecisionService, DecisionChain, RuleDecisionEngine, buildDecisionFacts } from '@ucad/decision';
import type { Database } from '@ucad/storage';
import type { Logger } from '@ucad/observability';
import { nowIso } from '@ucad/observability';
import type {
  AgentCatalogEntry,
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
}

export class DecisionFacade {
  private readonly opts: DecisionFacadeOptions;
  private service: DecisionService;
  private readonly registry = new Map<string, DecisionEngineManifest>();

  constructor(opts: DecisionFacadeOptions) {
    this.opts = opts;
    this.registry.set(new RuleDecisionEngine().manifest.id, new RuleDecisionEngine().manifest);
    this.service = this.buildService(opts.chain);
  }

  /**
   * V1 ships exactly one engine. ADR-016 leaves room for `jev` and `llm`; when
   * one is added it must declare its side effects honestly and, if it declares
   * `network`, the user has to have authorized it (NFR-14).
   */
  private buildService(chain: string[]): DecisionService {
    const engines = [new RuleDecisionEngine()];
    const decisionChain = new DecisionChain({
      engines,
      hardTimeoutMs: this.opts.timeoutMs,
      logger: this.opts.logger,
    });
    void chain;

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
    return [...this.registry.values()];
  }

  get chain(): string[] {
    return this.service.engineChain.engineIds;
  }

  /** Applies a settings change: only engines the user may run are accepted. */
  setChain(engineIds: string[]): string[] {
    const allowed = engineIds.filter((id) => this.registry.has(id));
    const effective = allowed.length > 0 ? allowed : ['rule'];
    this.service = this.buildService(effective);
    return effective;
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
