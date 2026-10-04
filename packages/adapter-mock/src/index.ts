/**
 * `@ucad/adapter-mock` — §7.2 reference adapter.
 *
 * The mock is the executable specification of `AgentAdapter`: deterministic,
 * dependency-free, and faithful to the Injection Contract (NFR-13 / I-3) and
 * the "hosts produce proposals, never `seq`" rule (B6 / SEQ-1).
 */

export {
  MockAgentAdapter,
  createMockAdapter,
  MOCK_AGENT_VERSION,
  MOCK_PROVIDER_ID,
  DEFAULT_LATENCY_MS,
  MOCK_LATENCY_ENV,
} from './mock-adapter';
export type { MockAdapterOptions } from './mock-adapter';
