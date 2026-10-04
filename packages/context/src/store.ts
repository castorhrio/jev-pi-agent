/**
 * §0 table ownership + §6 persistence for the Context plane.
 *
 * `context` owns exactly two tables, `context_packs` and `context_items`
 * (§8.1), and only ever touches those. Everything goes through
 * `Database.driver`; no raw migration is issued here, because `storage` owns
 * the schema (NFR-07).
 *
 * Shape notes that come from the schema rather than from taste:
 *  - `context_packs.id` is the primary key, so a pack keeps **one** row and
 *    `revision` moves forward as `extend()` runs.
 *  - `context_items.pack_revision` records the revision an item was *added*
 *    in, so previous revisions are preserved.
 *    flow) and the delta can be reconstructed after a restart.
 *  - Item ids are minted in insertion order (`ci_<seq>_<ulid>`), which is what
 *    makes `ORDER BY id` reproduce the original pack order — and therefore the
 *    original `renderedHash` — after a reload.
 */

import type { ContextItem, ContextItemKind, ContextStrategy, FreshnessState, TokenEstimateSource } from '@ucad/contracts';
import { ulid } from '@ucad/observability';
import type { BlobStore, Logger } from '@ucad/observability';
import type { DatabaseLike } from './types';

/** NFR-06: a payload above this is a blob reference, not an inline column. */
export const MAX_INLINE_PAYLOAD_BYTES = 8 * 1024;

export interface ContextStoreOptions {
  db: DatabaseLike;
  logger: Logger;
  blobs?: BlobStore;
}

export interface PackRow {
  id: string;
  workspace_id: string;
  session_id: string;
  turn_id: string;
  revision: number;
  strategy: string;
  strategy_reason: string;
  limit_tokens: number | null;
  used_tokens: number | null;
  estimate_source: string | null;
  truncated: number;
  injection_mode: string | null;
  rendered_hash: string | null;
  rendered_text_ref: string | null;
  created_at: string;
}

export interface ItemRow {
  id: string;
  context_pack_id: string;
  pack_revision: number;
  kind: string;
  source_provider: string;
  source_reference: string | null;
  reason: string;
  freshness_json: string | null;
  estimated_tokens: number;
  budget_share: number;
  truncated: number;
  payload_ref: string | null;
  payload_json: string | null;
}

export interface SavePackInput {
  id: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  revision: number;
  strategy: ContextStrategy;
  strategyReason: string;
  limitTokens: number;
  usedTokens: number;
  estimateSource: TokenEstimateSource;
  truncated: boolean;
  injectionMode: string;
  renderedHash: string;
  /** blob ref of the rendered envelope; the authoritative render (NFR-13) */
  renderedRef: string;
  createdAt: string;
}

function safeJson(value: unknown): string | null {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? null : text;
  } catch {
    return null;
  }
}

function parseFreshness(text: string | null): FreshnessState {
  if (!text) return { stale: true, stalenessReason: 'unknown_revision' };
  try {
    const parsed = JSON.parse(text) as FreshnessState;
    return typeof parsed?.stale === 'boolean' ? parsed : { stale: true, stalenessReason: 'unknown_revision' };
  } catch {
    return { stale: true, stalenessReason: 'unknown_revision' };
  }
}

export class ContextStore {
  private readonly db: DatabaseLike;
  private readonly logger: Logger;
  private readonly blobs: BlobStore | undefined;

  constructor(opts: ContextStoreOptions) {
    this.db = opts.db;
    this.logger = opts.logger.child('context-store');
    this.blobs = opts.blobs;
  }

  /**
   * One transaction for the pack row and its items: a half-written pack is a
   * pack the Drawer would render as if it were complete.
   */
  savePack(pack: SavePackInput, items: ContextItem[]): void {
    this.db.transaction(() => {
      this.db.driver.run(
        `INSERT OR REPLACE INTO context_packs
           (id, workspace_id, session_id, turn_id, revision, strategy, strategy_reason,
            limit_tokens, used_tokens, estimate_source, truncated, injection_mode,
            rendered_hash, rendered_text_ref, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          pack.id,
          pack.workspaceId,
          pack.sessionId,
          pack.turnId,
          pack.revision,
          pack.strategy,
          pack.strategyReason,
          pack.limitTokens,
          pack.usedTokens,
          pack.estimateSource,
          pack.truncated ? 1 : 0,
          pack.injectionMode,
          pack.renderedHash,
          pack.renderedRef,
          pack.createdAt,
        ],
      );
      this.writeItems(pack.id, pack.revision, items);
    });
  }

  /** Extends the same pack row: revision and budget move, evidence is kept. */
  updatePack(input: {
    id: string;
    revision: number;
    limitTokens: number;
    usedTokens: number;
    truncated: boolean;
    injectionMode: string;
    renderedHash: string;
    renderedRef: string;
  }): void {
    this.db.driver.run(
      `UPDATE context_packs
          SET revision = ?, limit_tokens = ?, used_tokens = ?, truncated = ?,
              injection_mode = ?, rendered_hash = ?, rendered_text_ref = ?
        WHERE id = ?`,
      [
        input.revision,
        input.limitTokens,
        input.usedTokens,
        input.truncated ? 1 : 0,
        input.injectionMode,
        input.renderedHash,
        input.renderedRef,
        input.id,
      ],
    );
  }

  /** Only the rows added in this revision (§6 extend flow). */
  writeItems(packId: string, revision: number, items: ContextItem[]): void {
    for (const item of items) {
      const serialized = safeJson(item.payload);
      const oversized = serialized !== null && serialized.length > MAX_INLINE_PAYLOAD_BYTES;
      const ref = oversized && this.blobs ? this.blobs.put(serialized, { packId, itemId: item.id, kind: item.kind }) : null;

      this.db.driver.run(
        `INSERT OR REPLACE INTO context_items
           (id, context_pack_id, pack_revision, kind, source_provider, source_reference,
            reason, freshness_json, estimated_tokens, budget_share, truncated,
            payload_ref, payload_json)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          item.id,
          packId,
          revision,
          item.kind as ContextItemKind,
          item.source.providerId,
          item.source.reference ?? null,
          item.reason,
          safeJson(item.freshness),
          Math.max(0, Math.round(item.estimatedTokens)),
          item.budgetShare,
          item.truncated ? 1 : 0,
          ref,
          ref ? null : serialized,
        ],
      );
    }
  }

  readPackRow(packId: string): PackRow | undefined {
    try {
      return this.db.driver.get<PackRow>('SELECT * FROM context_packs WHERE id = ?', [packId]);
    } catch (error) {
      this.logger.warn('context_packs read failed', { packId, error: String(error) });
      return undefined;
    }
  }

  /** The ledger row for a turn: its newest revision. */
  readPackRowForTurn(turnId: string): PackRow | undefined {
    try {
      return this.db.driver.get<PackRow>(
        'SELECT * FROM context_packs WHERE turn_id = ? ORDER BY revision DESC LIMIT 1',
        [turnId],
      );
    } catch (error) {
      this.logger.warn('context_packs turn lookup failed', { turnId, error: String(error) });
      return undefined;
    }
  }

  /**
   * `ORDER BY id` is insertion order because ids are minted as
   * `ci_<seq>_<ulid>` with a zero-padded sequence — that is what lets a
   * reloaded pack re-render to the same hash (NFR-13).
   */
  readItems(packId: string): ContextItem[] {
    let rows: ItemRow[] = [];
    try {
      rows = this.db.driver.all<ItemRow>(
        'SELECT * FROM context_items WHERE context_pack_id = ? ORDER BY id ASC',
        [packId],
      );
    } catch (error) {
      this.logger.warn('context_items read failed', { packId, error: String(error) });
      return [];
    }
    return rows.map((row) => this.toItem(row));
  }

  readItemsAddedIn(packId: string, revision: number): ContextItem[] {
    let rows: ItemRow[] = [];
    try {
      rows = this.db.driver.all<ItemRow>(
        'SELECT * FROM context_items WHERE context_pack_id = ? AND pack_revision = ? ORDER BY id ASC',
        [packId, revision],
      );
    } catch (error) {
      this.logger.warn('context_items revision read failed', { packId, revision, error: String(error) });
      return [];
    }
    return rows.map((row) => this.toItem(row));
  }

  /** NFR-06: the payload text, resolved from the blob when it was offloaded. */
  readRendered(ref: string | null): string | null {
    if (!ref) return null;
    if (!this.blobs) return null;
    try {
      return this.blobs.get(ref);
    } catch (error) {
      this.logger.warn('rendered blob could not be read', { ref, error: String(error) });
      return null;
    }
  }

  /** Writes the rendered envelope as a blob so a reload keeps the exact bytes. */
  storeRendered(rendered: string, meta: Record<string, unknown>): string {
    if (this.blobs) return this.blobs.put(rendered, meta);
    // No blob store wired: the render is still hashed and stored, it simply
    // cannot be recovered after a restart. Logged, never silent.
    this.logger.warn('no blob store; rendered text is not recoverable after restart', meta);
    return ulid('norender_');
  }

  private toItem(row: ItemRow): ContextItem {
    let payload: unknown = null;
    if (row.payload_ref) {
      const text = this.readRendered(row.payload_ref);
      payload = text === null ? null : this.parseMaybeJson(text);
    } else if (row.payload_json) {
      payload = this.parseMaybeJson(row.payload_json);
    }

    return {
      id: row.id,
      kind: row.kind as ContextItemKind,
      source: {
        providerId: row.source_provider,
        ...(row.source_reference ? { reference: row.source_reference } : {}),
      },
      reason: row.reason,
      freshness: parseFreshness(row.freshness_json),
      estimatedTokens: row.estimated_tokens,
      budgetShare: row.budget_share,
      truncated: row.truncated === 1,
      ...(row.payload_ref ? { payloadRef: row.payload_ref } : {}),
      payload,
    };
  }

  private parseMaybeJson(text: string): unknown {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }
}
