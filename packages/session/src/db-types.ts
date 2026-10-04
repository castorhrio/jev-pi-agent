/**
 * Structural mirror of the `@ucad/storage` surface consumed by this package
 *.
 *
 * Same reasoning as §6's `GitLike` / `SessionStoreLike`: the real `Database`,
 * `EventLog` and `SessionSequencer` are structurally assignable to the types
 * below, so `SessionStore` works with them without a hard package dependency
 * that would block the build while `storage` is still being written.
 *
 * Only the members actually used are declared, so assignability does not depend
 * on API nobody calls.
 */

import type { EventSource, TurnEvent, TurnEventType } from '@ucad/contracts';

/** §2 `RunResult`. */
export interface RunResultLike {
  changes: number;
  lastInsertRowid: number;
}

/** §2 `SqlDriver`, reduced to the members `SessionStore` uses. */
export interface SqlDriverLike {
  run(sql: string, params?: unknown[]): RunResultLike;
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[];
  get<T = Record<string, unknown>>(sql: string, params?: unknown[]): T | undefined;
  transaction<T>(fn: () => T): T;
}

/**
 * §2 `Database`. `isProtected()` is part of §2's at-rest contract ("NFR-15 不得
 * 谎报") and is optional so the Settings snapshot can report the real state
 * whenever storage exposes it.
 */
export interface DatabaseLike {
  readonly driver: SqlDriverLike;
  readonly schemaVersion: number;
  transaction<T>(fn: () => T): T;
  isProtected?(): boolean;
}

/** §2 `AppendEventInput`. */
export interface AppendEventInputLike {
  sessionId: string;
  turnId: string;
  /** allocated by the SessionSequencer inside the caller's transaction (SEQ-2). */
  seq: number;
  proposal: { type: TurnEventType; source: EventSource; payload: unknown; ts: string };
}

/** §2 `AppendEventResult`. */
export interface AppendEventResultLike {
  ok: boolean;
  event?: TurnEvent;
  rejectedReason?: string;
}

/** §2 `EventLog`, reduced to the members `SessionStore` uses. */
export interface EventLogLike {
  append(input: AppendEventInputLike): AppendEventResultLike;
  since(input: { sessionId: string; afterSeq: number; limit?: number }): TurnEvent[];
  latestSeq(sessionId: string): number;
  listByTurn(sessionId: string, turnId: string): TurnEvent[];
  all(sessionId: string): TurnEvent[];
}

/**
 * §2 `SessionSequencer` — the ONLY allocator of `seq` (§5.2 SEQ-1). It is
 * injected rather than constructed so a single instance is shared with the
 * event admission pipeline.
 */
export interface SessionSequencerLike {
  /** synchronous; must be called inside the caller's transaction */
  next(sessionId: string): number;
  latest(sessionId: string): Promise<number>;
  resync(sessionId: string): Promise<void>;
}
