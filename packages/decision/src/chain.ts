/**
 * §4.4 D-2 — the engine chain.
 *
 * D-2, verbatim behaviour: call the registered engines in order; when an engine
 * does not support the kind, throws, or exceeds its timeout, move to the next
 * one. If *all* of them fail, the last-resort `RuleDecisionEngine` produces the
 * answer and the result is stamped with `fallback: { used: true, reason }`.
 * A fallback therefore ALWAYS leaves a trace — it is never a silent degradation.
 *
 * `DECISION_HARD_TIMEOUT_MS` (2000ms) is Main's hard upper bound and is enforced
 * here for every single engine call through an `AbortController`, so a wedged
 * engine can neither block the turn nor extend its own budget.
 */

import { DECISION_HARD_TIMEOUT_MS, appError } from '@ucad/contracts';
import type {
  DecisionEngine,
  DecisionFallbackReason,
  DecisionKind,
  DecisionRequest,
  DecisionResult,
} from '@ucad/contracts';
import type { DecisionLogger } from '@ucad/contracts';
import { RULE_ENGINE_ID, RuleDecisionEngine } from './rule-engine';

export type ChainAttemptOutcome =
  | 'ok'
  | 'unsupported_kind'
  | 'unavailable'
  | 'timeout'
  | 'error';

export interface ChainAttempt {
  engineId: string;
  outcome: ChainAttemptOutcome;
  durationMs: number;
  /** short, sanitised diagnostic — never a raw vendor payload (NFR-08) */
  detail?: string;
}

/** Everything that happened for one request; kept in memory for the drawer. */
export interface ChainTrace {
  requestId: string;
  kind: DecisionKind;
  attempts: ChainAttempt[];
  usedFallback: boolean;
  fallbackReason?: DecisionFallbackReason;
  totalMs: number;
}

export interface ChainDecision {
  result: DecisionResult;
  trace: ChainTrace;
}

export interface DecisionChainOptions {
  /** ordered; the first engine that answers wins */
  engines?: DecisionEngine[];
  /** last resort; defaults to a dedicated `RuleDecisionEngine` instance */
  fallbackEngine?: DecisionEngine;
  logger?: DecisionLogger;
  /** defaults to DECISION_HARD_TIMEOUT_MS; may only be lowered, never raised */
  hardTimeoutMs?: number;
  /** how many recent traces to keep (diagnostics) */
  traceLimit?: number;
}

/**
 * When several engines failed, the trace keeps the most *informative* reason:
 * a crash or a timeout explains more than "this engine does not do that kind".
 */
const REASON_SEVERITY: Readonly<Record<DecisionFallbackReason, number>> = {
  unsupported_kind: 1,
  unavailable: 2,
  error: 3,
  timeout: 4,
};

const FALLBACK_REASON_FOR_ATTEMPT: Readonly<Record<ChainAttemptOutcome, DecisionFallbackReason | null>> = {
  ok: null,
  unsupported_kind: 'unsupported_kind',
  unavailable: 'unavailable',
  timeout: 'timeout',
  error: 'error',
};

interface EngineCall {
  status: 'ok' | 'timeout' | 'error' | 'unavailable';
  result?: DecisionResult;
  detail?: string;
}

function aborted(): Error {
  const err = new Error('decision chain aborted by caller');
  err.name = 'AbortError';
  return err;
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 300);
  return String(error).slice(0, 300);
}

/** An engine that reports itself as not ready gets the `unavailable` reason. */
function isUnavailableError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ADAPTER_NOT_AVAILABLE'
  );
}

export class DecisionChain {
  private readonly engines: DecisionEngine[];
  private readonly fallbackEngine: DecisionEngine;
  private readonly logger: DecisionLogger | null;
  private readonly hardTimeoutMs: number;
  private readonly traceLimit: number;
  private readonly traces = new Map<string, ChainTrace>();
  private readonly traceOrder: string[] = [];
  private readonly unavailable = new Set<DecisionEngine>();
  /**
   * True when the last-resort engine is *also* a member of the ordered list and
   * that list has at least one other engine. In that case it is reserved: the
   * ordered pass skips it, because calling it as a chain member and then again
   * as the fallback would be the same computation twice — and the second call is
   * the one that must carry the fallback trace. The V1 chain (`['rule']`) has no
   * other engine, so rule answers normally and is never a "fallback".
   */
  private readonly fallbackIsChainMember: boolean;
  private disposed = false;

  constructor(opts: DecisionChainOptions = {}) {
    this.engines = [...(opts.engines ?? [])];
    const inChain = this.engines.find((e) => e.manifest.id === RULE_ENGINE_ID);
    this.fallbackIsChainMember = opts.fallbackEngine === undefined && inChain !== undefined && this.engines.length > 1;
    this.fallbackEngine = opts.fallbackEngine ?? (inChain !== undefined && this.fallbackIsChainMember ? inChain : new RuleDecisionEngine());
    this.logger = opts.logger ?? null;
    this.hardTimeoutMs = Math.min(opts.hardTimeoutMs ?? DECISION_HARD_TIMEOUT_MS, DECISION_HARD_TIMEOUT_MS);
    this.traceLimit = Math.max(1, opts.traceLimit ?? 200);
  }

  /** D-1: the ordered engine ids, as registered. */
  get engineIds(): string[] {
    return this.engines.map((e) => e.manifest.id);
  }

  get fallbackEngineId(): string {
    return this.fallbackEngine.manifest.id;
  }

  supports(kind: DecisionKind): boolean {
    return this.engines.some((e) => e.supports(kind)) || this.fallbackEngine.supports(kind);
  }

  async decide(request: DecisionRequest, signal?: AbortSignal): Promise<DecisionResult> {
    const { result } = await this.decideWithTrace(request, signal);
    return result;
  }

  async decideWithTrace(request: DecisionRequest, signal?: AbortSignal): Promise<ChainDecision> {
    if (this.disposed) {
      throw appError('UNKNOWN', 'DecisionChain has been disposed', 'decision');
    }
    const started = Date.now();
    const attempts: ChainAttempt[] = [];

    for (const engine of this.engines) {
      if (signal?.aborted) throw aborted();
      if (this.fallbackIsChainMember && engine === this.fallbackEngine) continue; // reserved
      if (this.unavailable.has(engine)) {
        attempts.push({ engineId: engine.manifest.id, outcome: 'unavailable', durationMs: 0, detail: 'engine reported itself unavailable' });
        continue;
      }
      if (!engine.supports(request.kind)) {
        attempts.push({
          engineId: engine.manifest.id,
          outcome: 'unsupported_kind',
          durationMs: 0,
          detail: `manifest.supportedKinds does not include '${request.kind}'`,
        });
        continue;
      }
      const call = await this.callEngine(engine, request, signal);
      const attempt: ChainAttempt = {
        engineId: engine.manifest.id,
        outcome: call.status,
        durationMs: Math.max(0, Date.now() - started - attempts.reduce((sum, a) => sum + a.durationMs, 0)),
        ...(call.detail !== undefined ? { detail: call.detail } : {}),
      };
      attempts.push(attempt);
      if (call.status === 'ok' && call.result) {
        return this.finish(request, started, attempts, call.result, false);
      }
      if (call.status === 'unavailable') this.unavailable.add(engine);
    }

    // D-2: everything failed — the rule engine answers, and the reason is traced.
    const reason = this.pickFallbackReason(attempts);
    if (signal?.aborted) throw aborted();
    const fallbackCall = await this.callEngine(this.fallbackEngine, request, signal);
    if (fallbackCall.status !== 'ok' || !fallbackCall.result) {
      throw appError(
        fallbackCall.status === 'timeout' ? 'DECISION_TIMEOUT' : 'UNKNOWN',
        `decision chain exhausted and the fallback engine '${this.fallbackEngine.manifest.id}' ` +
          `also ${fallbackCall.status} (${describe(fallbackCall.detail ?? fallbackCall.status)})`,
        'decision',
        { details: { requestId: request.requestId, kind: request.kind, attempts } },
      );
    }
    const stamped: DecisionResult = {
      ...fallbackCall.result,
      fallback: { used: true, reason },
    };
    attempts.push({
      engineId: this.fallbackEngine.manifest.id,
      outcome: 'ok',
      durationMs: Math.max(0, Date.now() - started - attempts.reduce((sum, a) => sum + a.durationMs, 0)),
      detail: 'last-resort engine after the chain was exhausted',
    });
    return this.finish(request, started, attempts, stamped, true, reason);
  }

  getTrace(requestId: string): ChainTrace | null {
    return this.traces.get(requestId) ?? null;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const engine of [...this.engines, this.fallbackEngine]) {
      try {
        await engine.dispose();
      } catch (error) {
        this.logger?.warn('engine dispose failed', { error: describe(error) });
      }
    }
  }

  // -------------------------------------------------------------------------

  private pickFallbackReason(attempts: ReadonlyArray<ChainAttempt>): DecisionFallbackReason {
    let best: DecisionFallbackReason = 'unavailable';
    for (const attempt of attempts) {
      const reason = FALLBACK_REASON_FOR_ATTEMPT[attempt.outcome];
      if (reason && REASON_SEVERITY[reason] > REASON_SEVERITY[best]) best = reason;
    }
    return best;
  }

  private finish(
    request: DecisionRequest,
    started: number,
    attempts: ChainAttempt[],
    result: DecisionResult,
    usedFallback: boolean,
    reason?: DecisionFallbackReason,
  ): ChainDecision {
    const trace: ChainTrace = {
      requestId: request.requestId,
      kind: request.kind,
      attempts,
      usedFallback,
      ...(reason !== undefined ? { fallbackReason: reason } : {}),
      totalMs: Math.max(0, Date.now() - started),
    };
    this.rememberTrace(trace);
    this.logger?.decided(request.requestId, request.kind, result.producedBy.engineId, result.latencyMs);
    if (usedFallback && reason) {
      // D-2: the degradation is logged, not swallowed.
      this.logger?.warn('decision served by the fallback engine', {
        requestId: request.requestId,
        kind: request.kind,
        reason,
        attempts: attempts.map((a) => `${a.engineId}:${a.outcome}`),
      });
    }
    return { result, trace };
  }

  private rememberTrace(trace: ChainTrace): void {
    this.traces.set(trace.requestId, trace);
    this.traceOrder.push(trace.requestId);
    while (this.traceOrder.length > this.traceLimit) {
      const dropped = this.traceOrder.shift();
      if (dropped !== undefined) this.traces.delete(dropped);
    }
  }

  /**
   * One engine call under the hard bound. The AbortController is aborted both on
   * timeout and when the caller cancels, and the timer is always cleared.
   */
  private async callEngine(
    engine: DecisionEngine,
    request: DecisionRequest,
    signal?: AbortSignal,
  ): Promise<EngineCall> {
    const requested = request.timeoutMs > 0 ? request.timeoutMs : this.hardTimeoutMs;
    const budget = Math.max(1, Math.min(engine.manifest.timeoutMs, requested, this.hardTimeoutMs));
    const controller = new AbortController();
    const onOuterAbort = (): void => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', onOuterAbort, { once: true });
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve('timeout');
      }, budget);
    });

    try {
      // `.then(ok, err)` keeps a late rejection of a timed-out engine handled.
      const work = engine.decide(request, controller.signal).then(
        (result) => ({ kind: 'result' as const, result }),
        (error: unknown) => ({ kind: 'threw' as const, error }),
      );
      const outcome = await Promise.race([work, timeout]);

      if (outcome === 'timeout') {
        if (signal?.aborted) throw aborted();
        this.logger?.warn('decision engine exceeded its budget', {
          requestId: request.requestId,
          engineId: engine.manifest.id,
          budgetMs: budget,
        });
        return { status: 'timeout', detail: `exceeded ${budget}ms (hard bound ${DECISION_HARD_TIMEOUT_MS}ms)` };
      }
      if (outcome.kind === 'threw') {
        if (signal?.aborted) throw aborted();
        if (isUnavailableError(outcome.error)) {
          return { status: 'unavailable', detail: describe(outcome.error) };
        }
        this.logger?.warn('decision engine threw', {
          requestId: request.requestId,
          engineId: engine.manifest.id,
          error: describe(outcome.error),
        });
        return { status: 'error', detail: describe(outcome.error) };
      }

      const invalid = validateResult(outcome.result, request.kind, request.requestId);
      if (invalid) {
        // NFR-16 makes rationale mandatory, so a malformed result is a broken
        // engine, not a usable answer: fall through to the next one.
        this.logger?.warn('decision engine returned an unusable result', {
          requestId: request.requestId,
          engineId: engine.manifest.id,
          reason: invalid,
        });
        return { status: 'error', detail: invalid };
      }
      return { status: 'ok', result: outcome.result };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onOuterAbort);
    }
  }
}

/** Returns a human readable problem description, or null when the result is usable. */
function validateResult(result: DecisionResult | undefined, kind: DecisionKind, requestId: string): string | null {
  if (!result || typeof result !== 'object') return 'engine returned a non-object result';
  if (result.outcome?.kind !== kind) {
    return `engine returned outcome.kind='${String(result.outcome?.kind)}' for a '${kind}' request`;
  }
  if (result.requestId !== requestId) return `engine returned requestId='${result.requestId}', expected '${requestId}'`;
  if (typeof result.rationale !== 'string' || result.rationale.trim().length === 0) {
    return 'engine returned an empty rationale (NFR-16 makes it mandatory)';
  }
  if (!Number.isFinite(result.confidence) || result.confidence < 0 || result.confidence > 1) {
    return `engine returned confidence=${String(result.confidence)}, expected 0..1`;
  }
  return null;
}
