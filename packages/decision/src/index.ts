/**
 * @ucad/decision — the Decision System plane (§4.4, ADR-016).
 *
 * D-5: nothing in this package imports `node:fs`, `node:child_process` or
 * `node:net`. A `DecisionEngine` only ever sees the read-only `DecisionFacts`
 * summary that Main assembles.
 */

export {
  RuleDecisionEngine,
  RULE_ENGINE_ID,
  RULE_ENGINE_SUPPORTED_KINDS,
  DEFAULT_RULE_THRESHOLDS,
} from './rule-engine';
export type { RuleDecisionThresholds } from './rule-engine';

export {
  JevDecisionEngine,
  JevAbstainedError,
  createJevEngine,
  JEV_ENGINE_ID,
  JEV_ENGINE_VERSION,
  JEV_ENGINE_SUPPORTED_KINDS,
  JEV_ENGINE_TIMEOUT_MS,
  DEFAULT_JEV_MIN_CONFIDENCE,
} from './engines/jev';
export type { JevEngineOptions, JevScorer } from './engines/jev';

export { DecisionChain } from './chain';
export type {
  ChainAttempt,
  ChainAttemptOutcome,
  ChainDecision,
  ChainTrace,
  DecisionChainOptions,
} from './chain';

export { DecisionService, buildDecisionFacts } from './service';
export type {
  DecisionFactsInput,
  DecisionMadeInput,
  DecisionOutcomeEnvelope,
  DecisionServiceOptions,
  DecideInput,
} from './service';
