/**
 * T-4 — the per-turn token budget ledger.
 *
 * The ledger is **keyed by `turnId` and persisted**, not held in a map. That
 * is the whole point of T-4: after a Host restart the Context Drawer, or an
 * Agent that is still mid-turn, may call `extend()` again — and a budget kept
 * in process memory would have silently reset to the full allowance, letting
 * one turn spend the context window three times over.
 *
 * Storage: `context_packs` is the only table this package owns besides
 * `context_items` (§0), and a pack row is already 1:1 with a turn, so the
 * ledger lives in the row's `limit_tokens` / `used_tokens` / `truncated`
 * columns. A turn's ledger is the *latest* revision row for that `turn_id`.
 *
 * `release()` is deliberately **not** persisted: it drops the in-process entry
 * so nothing can charge a finished turn again, while leaving the row intact.
 * The row is evidence — the Context Drawer renders it, and §4.12.1 handoff
 * replay reads `context_packs` — and zeroing `limit_tokens` to mark a release
 * would make a completed turn report a limit of 0. Not freeing a dead turn's
 * reservation costs nothing and fails in the safe direction: a stale
 * `extend()` after a restart is still budget-constrained.
 */

import type { ContextBudgetState, TokenEstimateSource } from '@ucad/contracts';
import { nowIso } from '@ucad/observability';
import type { Logger } from '@ucad/observability';
import type { DatabaseLike, OpenLedgerInput, TurnBudgetLedgerApi } from './types';

interface LedgerRow {
  id: string;
  turn_id: string;
  revision: number;
  limit_tokens: number | null;
  used_tokens: number | null;
  estimate_source: string | null;
  truncated: number;
}

const SELECT_LATEST = `
  SELECT id, turn_id, revision, limit_tokens, used_tokens, estimate_source, truncated
    FROM context_packs
   WHERE turn_id = ?
   ORDER BY revision DESC
   LIMIT 1`;

function toState(row: LedgerRow): ContextBudgetState {
  const limit = row.limit_tokens ?? 0;
  const used = row.used_tokens ?? 0;
  return {
    packId: row.id,
    revision: row.revision,
    limitTokens: limit,
    usedTokens: used,
    remainingTokens: Math.max(0, limit - used),
    estimateSource: (row.estimate_source as TokenEstimateSource) ?? 'unknown',
    truncated: row.truncated === 1,
  };
}

export class TurnBudgetLedger implements TurnBudgetLedgerApi {
  private readonly db: DatabaseLike;
  private readonly logger: Logger;

  /**
   * Hot cache for the current process. The database remains the source of
   * truth: every read falls back to it, so a cache miss after a restart costs
   * one indexed SELECT and changes no behaviour.
   */
  private readonly cache = new Map<string, ContextBudgetState>();

  /** T-4: turns whose reservation has been handed back at turn end. */
  private readonly released = new Set<string>();

  constructor(opts: { db: DatabaseLike; logger: Logger }) {
    this.db = opts.db;
    this.logger = opts.logger.child('budget-ledger');
  }

  /**
   * Opens (or re-opens) the ledger for a turn. The broker persists the pack
   * first (§6.1 step 7), so the row exists; this call pins the limit, the
   * estimate source and the truncation flag onto it.
   *
   * A `turnId` that was already released is refused rather than silently
   * revived: turn ids are ULIDs and are never reused, so re-opening one means
   * a caller kept a stale reference.
   */
  open(input: OpenLedgerInput): ContextBudgetState {
    const limit = Math.max(0, Math.round(input.limitTokens));

    if (this.released.has(input.turnId)) {
      this.logger.warn('re-open refused for a released turn ledger', {
        turnId: input.turnId,
        packId: input.packId,
      });
      return this.closedState(input.packId);
    }

    const row = this.findRow(input.turnId);

    if (row && row.id === input.packId) {
      // Same pack, same row: re-assert the limit without losing `used_tokens`.
      this.db.driver.run(
        `UPDATE context_packs
            SET limit_tokens = ?, estimate_source = ?, truncated = ?
          WHERE id = ? AND revision = ?`,
        [limit, input.estimateSource, row.truncated, row.id, row.revision],
      );
      const state = this.readState(input.turnId) ?? {
        ...toState(row),
        limitTokens: limit,
        estimateSource: input.estimateSource,
      };
      this.cache.set(input.turnId, state);
      return state;
    }

    if (row) {
      // A different pack already owns this turn's ledger (a rebuilt pack after
      // a crash, say). Charge against the oldest live row rather than two.
      this.logger.warn('turn already has a pack ledger; reusing it', {
        turnId: input.turnId,
        existingPackId: row.id,
        requestedPackId: input.packId,
      });
      const state = this.readState(input.turnId);
      if (state) return state;
    }

    // No row: the caller did not persist the pack. Degrade to an in-process
    // ledger with a zero allowance rather than inventing one — a missing
    // ledger must never read as "unlimited".
    this.logger.warn('no context_packs row for turn; ledger is in-memory only', {
      turnId: input.turnId,
      packId: input.packId,
    });
    const state: ContextBudgetState = {
      packId: input.packId,
      revision: 0,
      limitTokens: limit,
      usedTokens: 0,
      remainingTokens: limit,
      estimateSource: input.estimateSource,
      truncated: false,
    };
    this.cache.set(input.turnId, state);
    return state;
  }

  /**
   * T-4: charges the turn. Persisted on every call, so `extend()` after a
   * Host restart is still constrained by what `build()` already spent.
   *
   * Over-spending is not an error: the caller decides what to do with the
   * returned state, and the state says `truncated: true` so the pack records
   * that something had to go.
   */
  charge(turnId: string, tokens: number): ContextBudgetState {
    const amount = Math.max(0, Math.round(tokens));

    if (this.released.has(turnId)) {
      this.logger.warn('charge refused for a released turn ledger', { turnId, tokens: amount });
      return this.closedState(this.cache.get(turnId)?.packId ?? '');
    }

    const current = this.readState(turnId);
    if (!current) {
      this.logger.warn('charge without an open ledger; ignored', { turnId, tokens: amount });
      return this.closedState('');
    }

    const used = current.usedTokens + amount;
    const truncated = current.truncated || used > current.limitTokens;
    const next: ContextBudgetState = { ...current, usedTokens: used, remainingTokens: Math.max(0, current.limitTokens - used), truncated };

    const row = this.findRow(turnId);
    if (row && row.id === next.packId) {
      this.db.driver.run(
        'UPDATE context_packs SET used_tokens = ?, truncated = ? WHERE id = ? AND revision = ?',
        [used, truncated ? 1 : 0, row.id, row.revision],
      );
    } else {
      this.logger.warn('charge could not be persisted; ledger is in-memory only', { turnId });
    }

    this.cache.set(turnId, next);
    return next;
  }

  /** Remaining allowance for a turn; 0 when closed, missing or over budget. */
  remaining(turnId: string): number {
    return this.readState(turnId)?.remainingTokens ?? 0;
  }

  /** `null` once the turn has been released — the reservation is gone. */
  state(turnId: string): ContextBudgetState | null {
    if (this.released.has(turnId)) return null;
    return this.readState(turnId);
  }

  /**
   * Turn end (§6.1). Idempotent, and safe to call for a turn that never
   * opened a ledger.
   */
  release(turnId: string): void {
    const before = this.cache.get(turnId);
    this.cache.delete(turnId);
    this.released.add(turnId);
    this.logger.debug('turn budget released', {
      turnId,
      usedTokens: before?.usedTokens ?? 0,
      at: nowIso(),
    });
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  /** Cache first, then the newest persisted row for the turn. */
  private readState(turnId: string): ContextBudgetState | null {
    if (this.released.has(turnId)) return null;
    const cached = this.cache.get(turnId);
    if (cached) return cached;
    const row = this.findRow(turnId);
    if (!row) return null;
    const state = toState(row);
    this.cache.set(turnId, state);
    return state;
  }

  private findRow(turnId: string): LedgerRow | undefined {
    try {
      return this.db.driver.get<LedgerRow>(SELECT_LATEST, [turnId]);
    } catch (error) {
      // Observability must never break a turn: an unreadable ledger degrades
      // to "no allowance", which is the safe direction.
      this.logger.warn('ledger read failed', { turnId, error: String(error) });
      return undefined;
    }
  }

  private closedState(packId: string): ContextBudgetState {
    return {
      packId,
      revision: 0,
      limitTokens: 0,
      usedTokens: 0,
      remainingTokens: 0,
      estimateSource: 'unknown',
      truncated: true,
    };
  }
}
