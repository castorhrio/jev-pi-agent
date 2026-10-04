/**
 * @ucad/providers — multi-provider model access.
 *
 * The landing point for ADR-017's `ucad_managed` binding: when an Agent
 * declares `providerBinding: 'ucad_managed'`, UCAD — not the Agent CLI —
 * decides the provider and model, which means this package is the thing that
 * actually makes the call.
 *
 * Four pieces, each with one job:
 *  - `descriptors.ts`     what a provider is, and an honest capability list
 *  - `client.ts`          the only code that speaks a vendor wire protocol
 *  - `registry.ts`        which models this workspace may address
 *  - `token-accounting.ts` turn usage → §4.12.2 `UsageRecord`, provenance intact
 *
 * Two invariants run through all of them: a capability is claimed only where
 * this code can deliver it, and an unknown number is reported as unknown.
 */

export {
  BUILTIN_PROVIDERS,
  getProvider,
  listProviders,
} from './descriptors';
export type {
  ProviderCapabilities,
  ProviderDescriptor,
  ProviderTokenizer,
  ProviderTransport,
} from './descriptors';

export { ProviderClient } from './client';
export type {
  ChatChunk,
  ChatMessage,
  ChatRequest,
  ChatResult,
  ProbeResult,
  ProviderClientOptions,
  SecretLike,
  TokenUsage,
} from './client';

export { ModelRegistry } from './registry';
export type { ModelRef, ModelRegistryOptions } from './registry';

export { TokenAccounting, heuristicTokenEstimate } from './token-accounting';
export type { TokenAccountingOptions, TurnUsageInput } from './token-accounting';
