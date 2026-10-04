/** §4.12.4 internal component interfaces. */

import type { TurnEvent } from './events';
import type { DecisionKind } from './decision';

export interface SessionSequencer {
  /** allocates the next seq inside the caller's transaction */
  next(sessionId: string): number;
  /** the highest persisted seq, used by the recovery flow */
  latest(sessionId: string): Promise<number>;
  /** after crash recovery the in-memory counter must be realigned with the DB */
  resync(sessionId: string): Promise<void>;
}

/** Producer of the `messages` projection (§8.3). Pure derivation, rebuildable. */
export interface MessageProjector {
  apply(event: TurnEvent): Promise<void>;
  rebuildSession(sessionId: string): Promise<void>;
}

export interface HostLogger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

export interface IntelligenceLogger extends HostLogger {
  progress(
    operationId: string,
    staged: string,
    completed: number,
    total?: number,
  ): void;
}

export interface DecisionLogger extends HostLogger {
  decided(
    requestId: string,
    kind: DecisionKind,
    engineId: string,
    latencyMs: number,
  ): void;
}
