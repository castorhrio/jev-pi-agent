/**
 * §5.2 SEQ-1 / SEQ-2 — the only allocator of `seq`.
 *
 * Hosts, the context broker and the decision engine never allocate: Main
 * allocates and persists inside one transaction, so a rolled back write can
 * never burn a seq (SEQ-2: monotonic, no holes).
 */

import type { SessionSequencer as SessionSequencerContract } from '@ucad/contracts';
import type { Database } from './database';

/** seq is 1-based; `0` means "nothing persisted yet". */
const FIRST_SEQ = 1;

function maxSeqRow(db: Database, sessionId: string): { max_seq: number | null } {
  return (
    db.driver.get<{ max_seq: number | null }>(
      'SELECT MAX(seq) AS max_seq FROM events WHERE session_id = ?',
      [sessionId],
    ) ?? { max_seq: null }
  );
}

function toNumber(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export class SessionSequencer implements SessionSequencerContract {
  /** sessionId -> last allocated seq. The DB is authoritative on a miss. */
  private readonly counters = new Map<string, number>();

  constructor(private readonly db: Database) {}

  /**
   * Synchronous on purpose (§2): the caller is inside its own transaction and
   * must be able to persist the event in the same one. The first call for a
   * session seeds from `MAX(seq)`, which is legal inside that transaction.
   */
  next(sessionId: string): number {
    const current = this.counters.get(sessionId);
    if (current !== undefined) {
      const next = current + 1;
      this.counters.set(sessionId, next);
      return next;
    }

    const seeded = toNumber(maxSeqRow(this.db, sessionId).max_seq);
    const next = seeded + FIRST_SEQ;
    this.counters.set(sessionId, next);
    return next;
  }

  /** The highest *persisted* seq, used by crash recovery (§5.3). */
  async latest(sessionId: string): Promise<number> {
    return toNumber(maxSeqRow(this.db, sessionId).max_seq);
  }

  /**
   * Realigns the in-memory counter with the database. Mandatory after crash
   * recovery or after any out-of-band write, otherwise the counter would keep
   * handing out seqs that already exist and hit UNIQUE(session_id, seq).
   */
  async resync(sessionId: string): Promise<void> {
    const max = toNumber(maxSeqRow(this.db, sessionId).max_seq);
    if (max === 0) {
      this.counters.delete(sessionId);
      return;
    }
    this.counters.set(sessionId, max);
  }
}
