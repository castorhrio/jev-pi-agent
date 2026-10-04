/**
 * §4.4 / NFR-16 — the Decision System's entry point for Main.
 *
 * Responsibilities, and nothing else:
 *  1. build the read-only `DecisionFacts` summary (D-5: the service never reads
 *     the workspace itself, it only normalises what Main collected);
 *  2. run the chain (D-2);
 *  3. persist the result with a mandatory `rationale` and `confidence` (NFR-16);
 *  4. hand a `decision.made` *proposal* to Main, which owns `seq` and admits it
 *     to the event stream (E-1 / SEQ-1). The proposal therefore carries no `seq`.
 *
 * D-5 again: this package imports no `node:fs`, no `node:child_process` and no
 * `node:net`. Storage is reached only through the injected `Database`.
 */

import { DECISION_HARD_TIMEOUT_MS, appError, describeError } from '@ucad/contracts';
import type {
  AgentCapabilities,
  DecisionFacts,
  DecisionKind,
  DecisionMadePayload,
  DecisionOption,
  DecisionRequest,
  DecisionResult,
  EventSource,
} from '@ucad/contracts';
import { nowIso, ulid } from '@ucad/observability';
import type { Logger } from '@ucad/observability';
// Type-only: the storage plane is owned by another package, `decision` only
// touches its own rows and never its schema.
import type { Database } from '@ucad/storage';
import { DecisionChain } from './chain';
import type { ChainTrace } from './chain';

/** The `decision.made` proposal shape Main admits. Deliberately has no `seq`. */
export interface DecisionMadeInput {
  turnId: string;
  type: 'decision.made';
  source: EventSource;
  payload: DecisionMadePayload;
  ts: string;
}

/** Facts as Main collects them; every field is optional so a partial snapshot is legal. */
export interface DecisionFactsInput {
  workspace: { id: string; trusted?: boolean; languageHints?: string[] };
  availableAgents?: Array<{
    id: string;
    kind: 'universal' | 'native' | 'mock';
    isDefaultRuntime?: boolean;
    capabilities?: Partial<Pick<AgentCapabilities, 'streaming' | 'modelSelection' | 'usageReporting'>>;
  }>;
  availableModels?: Array<{ id: string; providerId: string; contextWindowTokens?: number }>;
  git?: { dirty?: boolean; changedFiles?: number; branch?: string };
  context?: { packId?: string; itemCount?: number; estimatedTokens?: number; freshness?: DecisionFacts['context']['freshness'] };
  signals?: { consecutiveFailures?: number; permissionDenials?: number; elapsedMs?: number; turnIndex?: number };
}

export interface DecideInput {
  sessionId: string;
  /**
   * The turn this decision belongs to. Optional because a *preview* runs before
   * any turn exists — a decision asked at the composer has no turn to belong to
   * yet, and inventing one (e.g. reusing the session id) would put a row in
   * `decisions` whose `turn_id` foreign key points at the wrong table.
   */
  turnId?: string;
  kind: DecisionKind;
  objective: string;
  facts: DecisionFactsInput;
  options?: DecisionOption[];
  /** defaults to `ulid('dcr_')` */
  requestId?: string;
  /** clamped to DECISION_HARD_TIMEOUT_MS by this layer (Main owns the hard bound) */
  timeoutMs?: number;
  signal?: AbortSignal;
  /**
   * Dry run. The chain still runs and still owes a `rationale` and a
   * `confidence` (NFR-16), but the result is neither written to `decisions` nor
   * emitted as `decision.made`: a preview is a question, not a record. This is
   * what `decision.preview` uses.
   */
  preview?: boolean;
}

/**
 * What `DecisionRequest.turnId` carries when there is no turn. No engine reads
 * it; only the persist and emit paths do, and both are skipped in preview mode.
 * If it ever were persisted, the `decisions.turn_id` foreign key would reject
 * it — which is the point of making the sentinel a value that can never pass.
 */
const PREVIEW_TURN_ID = 'preview';

export interface DecisionOutcomeEnvelope {
  result: DecisionResult;
  trace: ChainTrace;
  requestId: string;
}

export interface DecisionServiceOptions {
  chain: DecisionChain;
  db: Database;
  logger: Logger;
  /** Main injects this so the event can be admitted with a real `seq`. */
  onDecision: (input: DecisionMadeInput) => void;
  /**
   * NFR-16 default: a failed insert is an error, because a decision without a
   * persisted rationale is not auditable. Set false on a read-only surface.
   */
  strictPersistence?: boolean;
}

function nonNegativeInt(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return fallback;
  return Math.floor(value);
}

/**
 * Pure, D-6 safe: fills the defaults and clamps the counters so the heuristics
 * never have to defend themselves against a half-filled snapshot.
 */
export function buildDecisionFacts(input: DecisionFactsInput): DecisionFacts {
  const languageHints = (input.workspace.languageHints ?? []).filter(
    (hint) => typeof hint === 'string' && hint.trim().length > 0,
  );
  return {
    workspace: {
      id: input.workspace.id,
      trusted: input.workspace.trusted === true,
      languageHints,
    },
    availableAgents: (input.availableAgents ?? []).map((agent) => ({
      id: agent.id,
      kind: agent.kind,
      isDefaultRuntime: agent.isDefaultRuntime === true,
      capabilities: {
        streaming: agent.capabilities?.streaming === true,
        modelSelection: agent.capabilities?.modelSelection === true,
        usageReporting: agent.capabilities?.usageReporting ?? 'none',
      },
    })),
    availableModels: (input.availableModels ?? []).map((model) => ({
      id: model.id,
      providerId: model.providerId,
      ...(typeof model.contextWindowTokens === 'number' ? { contextWindowTokens: model.contextWindowTokens } : {}),
    })),
    git: {
      dirty: input.git?.dirty === true,
      changedFiles: nonNegativeInt(input.git?.changedFiles, 0),
      ...(typeof input.git?.branch === 'string' && input.git.branch.length > 0 ? { branch: input.git.branch } : {}),
    },
    context: {
      ...(typeof input.context?.packId === 'string' && input.context.packId.length > 0
        ? { packId: input.context.packId }
        : {}),
      itemCount: nonNegativeInt(input.context?.itemCount, 0),
      estimatedTokens: nonNegativeInt(input.context?.estimatedTokens, 0),
      freshness: input.context?.freshness ?? 'unknown',
    },
    signals: {
      consecutiveFailures: nonNegativeInt(input.signals?.consecutiveFailures, 0),
      permissionDenials: nonNegativeInt(input.signals?.permissionDenials, 0),
      elapsedMs: nonNegativeInt(input.signals?.elapsedMs, 0),
      turnIndex: nonNegativeInt(input.signals?.turnIndex, 0),
    },
  };
}

export class DecisionService {
  private readonly chain: DecisionChain;
  private readonly db: Database;
  private readonly logger: Logger;
  private readonly onDecision: (input: DecisionMadeInput) => void;
  private readonly strictPersistence: boolean;

  constructor(opts: DecisionServiceOptions) {
    this.chain = opts.chain;
    this.db = opts.db;
    this.logger = opts.logger;
    this.onDecision = opts.onDecision;
    this.strictPersistence = opts.strictPersistence !== false;
  }

  get engineChain(): DecisionChain {
    return this.chain;
  }

  /** Builds the request (D-5: the caller owns the facts, the service only normalises). */
  buildRequest(input: DecideInput): DecisionRequest {
    const requested = input.timeoutMs ?? DECISION_HARD_TIMEOUT_MS;
    return {
      requestId: input.requestId ?? ulid('dcr_'),
      kind: input.kind,
      sessionId: input.sessionId,
      turnId: input.turnId ?? PREVIEW_TURN_ID,
      objective: input.objective,
      facts: buildDecisionFacts(input.facts),
      ...(input.options !== undefined ? { options: input.options } : {}),
      timeoutMs: Math.max(1, Math.min(requested, DECISION_HARD_TIMEOUT_MS)),
    };
  }

  async decide(input: DecideInput): Promise<DecisionOutcomeEnvelope> {
    const request = this.buildRequest(input);
    const { result, trace } = await this.chain.decideWithTrace(request, input.signal);

    // A preview writes nothing: no `decisions` row, no `decision.made` event. It
    // is the same engine answering the same question, asked before the turn runs
    // — the answer is shown to the user, and the real turn makes its own record.
    if (input.preview === true) {
      this.logger.debug('decision preview (nothing persisted, nothing emitted)', {
        requestId: request.requestId,
        kind: request.kind,
        engineId: result.producedBy.engineId,
      });
      return { result, trace, requestId: request.requestId };
    }

    this.persist(request, result);
    this.emit(request, result);

    return { result, trace, requestId: request.requestId };
  }

  // -------------------------------------------------------------------------

  /**
   * NFR-16. Column set matches the `decisions` row described in §4.12 / §8.1:
   * rationale and confidence are always written, never defaulted.
   */
  private persist(request: DecisionRequest, result: DecisionResult): void {
    const version = result.producedBy.version;
    try {
      this.db.driver.run(
        `INSERT INTO decisions (
           id, session_id, turn_id, request_id, kind, outcome_json, confidence,
           rationale, engine_id, engine_version, fallback_json, latency_ms, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          ulid('dec_'),
          request.sessionId,
          request.turnId,
          result.requestId,
          request.kind,
          JSON.stringify(result.outcome),
          result.confidence,
          result.rationale,
          result.producedBy.engineId,
          version ?? null,
          result.fallback ? JSON.stringify(result.fallback) : null,
          result.latencyMs,
          nowIso(),
        ],
      );
    } catch (error) {
      const message = describeError(error);
      this.logger.error('failed to persist decision', {
        requestId: result.requestId,
        kind: request.kind,
        error: message.slice(0, 300),
      });
      if (this.strictPersistence) {
        throw appError('STORAGE_ERROR', `decision ${result.requestId} could not be persisted: ${message}`, 'decision', {
          details: { requestId: result.requestId, kind: request.kind },
        });
      }
    }
  }

  /** The proposal carries no `seq`: Main's SessionSequencer is the only allocator (SEQ-1). */
  private emit(request: DecisionRequest, result: DecisionResult): void {
    const version = result.producedBy.version;
    const input: DecisionMadeInput = {
      turnId: request.turnId,
      type: 'decision.made',
      source: { kind: 'decision', engineId: result.producedBy.engineId },
      payload: {
        requestId: result.requestId,
        kind: request.kind,
        outcome: result.outcome,
        confidence: result.confidence,
        rationale: result.rationale,
        engineId: result.producedBy.engineId,
        ...(result.fallback !== undefined ? { fallback: result.fallback } : {}),
      },
      ts: nowIso(),
    };
    this.logger.debug('emitting decision.made proposal', {
      requestId: result.requestId,
      kind: request.kind,
      engineVersion: version ?? null,
      fallback: result.fallback?.reason ?? null,
    });
    try {
      this.onDecision(input);
    } catch (error) {
      // Admission belongs to Main; a broken consumer must not lose the decision.
      this.logger.error('onDecision callback threw', {
        requestId: result.requestId,
        error: describeError(error).slice(0, 300),
      });
    }
  }
}
