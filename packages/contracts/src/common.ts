/**
 * Shared primitives. No vendor types, no runtime behaviour beyond schema helpers.
 */

export type JsonSchema = Record<string, unknown>;
export type Unsubscribe = () => void;

/** ISO-8601 UTC timestamp. */
export type Iso = string;

/**
 * Monotonic, lexicographically sortable identifier (ULID shape: 10 chars time +
 * 16 chars randomness). Implemented in @ucad/observability; declared here so
 * that no plane ever invents its own id format.
 */
export type EntityId = string;

/** NFR-06: any single event payload larger than this is moved to blob storage and truncated. */
export const MAX_EVENT_PAYLOAD_BYTES = 256 * 1024;
