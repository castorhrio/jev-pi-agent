/**
 * `@ucad/context` — the Context System plane.
 *
 * This package is what turns a workspace plus an objective into the exact
 * bytes an Agent receives, and it exists to make that transformation
 * accountable:
 *
 *  - `ContextBroker.build()` runs the deterministic §6.1 pipeline, persists
 *    every item and every omission, and produces the `context.pack.built`
 *    payload Main puts on the sequencer.
 *  - `InjectionRenderer.render()` is a pure function (NFR-13): same input,
 *    same bytes, same `renderedHash`. That is what lets the user audit what
 *    the model was shown.
 *  - `TurnBudgetLedger` is keyed by turn and persisted (T-4), so `extend()`
 *    cannot be used to spend the context window several times over.
 *  - `ToolContractHost` exposes exactly eight `ucad.*` tools and never a
 *    write, exec or git capability (anti shadow-privilege, §4.7.2).
 */

export { HeuristicTokenEstimator } from './estimator';

export { TurnBudgetLedger } from './ledger';

export {
  InjectionRenderer,
  extractObjectiveFromRendered,
  escapeXml,
  itemBodyText,
  sanitizeInjectedText,
  INJECTION_FILTERED_MARKER,
  MAX_ITEM_BODY_CHARS,
} from './renderer';
export type { InjectionRendererOptions } from './renderer';

export { ContextStore, MAX_INLINE_PAYLOAD_BYTES } from './store';
export type { ContextStoreOptions, ItemRow, PackRow, SavePackInput } from './store';

export { ContextBroker, objectiveTerms, rankObjectiveTerms, resolveStrategy } from './broker';

export { ToolContractHost, UCAD_TOOL_CONTRACT_NAMES } from './tool-host';
export type { PermissionEngineLike, ToolContractHostOptions } from './tool-host';

export type {
  BuildContextInputPreview,
  ContextBrokerContract,
  ContextBrokerOptions,
  ContextBuildResult,
  ContextExtendResult,
  DatabaseLike,
  GitLike,
  IntelligenceLike,
  IntelligenceQueryOutcomeLike,
  InjectionRendererLike,
  ItemMinter,
  OpenLedgerInput,
  SessionLike,
  SessionStoreLike,
  TrimResult,
  TurnBudgetLedgerApi,
  TurnBudgetLedgerOptions,
} from './types';
