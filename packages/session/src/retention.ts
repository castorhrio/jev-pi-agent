/**
 * §8.4 存储保护与保留 — the retention engine.
 *
 * §8.4 promises two things that nothing in V1 implemented: a retention window
 * (default 90 days, user-configurable to "forever" or something shorter) and a
 * cleanup that removes the blob files as well as the database rows. This file
 * is the enforcement, and it is deliberately boring about one thing:
 *
 *  **every number it reports is measured.** Sizes come from `fs.stat` on the
 *  real file, row counts come from `COUNT(*)`, and the "bytes reclaimed" a purge
 *  returns is the size of the files that were actually unlinked plus whatever
 *  the database file itself shrank by. §17.1 / NFR-15: the product must not
 *  report a count it did not measure, and must not show an empty panel when the
 *  truth is "reading failed".
 *
 * Two rules that shaped the API:
 *
 *  - **A purge that matches nothing is a success reporting zeros**, never a
 *    throw. "Nothing to clean" is a normal answer, and an error dialog for it
 *    would train users to distrust the feature.
 *  - **The `blobs` rows are not the data, the files are.** Deleting a session
 *    deletes its rows; the transcript bytes for oversized tool output live in
 *    the blob directory and are only reclaimed when the file is unlinked, which
 *    is why every delete path here pairs the row cascade with `BlobStore`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { appError, describeError } from '@ucad/contracts';
import type { StoragePurgeResult, StoragePurgeScope, StorageUsageDto } from '@ucad/contracts';
import type { BlobStore, Logger } from '@ucad/observability';
import type { DatabaseLike } from './db-types';
import type { SessionStore } from './session-store';

const MS_PER_DAY = 86_400_000;

/**
 * The same guard `BlobStore.pathFor` applies. A ref is generated internally, but
 * this file builds a path from it to `stat` the file, so the name is validated
 * before it ever reaches `path.join`.
 */
const SAFE_BLOB_REF = /^[A-Za-z0-9_.-]+$/;

/**
 * Session-scoped queries are chunked well below SQLite's parameter ceiling
 * (999 by default) so a large `IN (...)` list cannot turn a cleanup into a
 * "too many SQL variables" failure — the one failure mode a user can never
 * recover from without deleting their database.
 */
const PARAM_CHUNK = 200;

/** Tables this service counts. A literal union, so no caller can inject a name. */
type CountableTable = 'sessions' | 'turns' | 'events' | 'messages' | 'blobs';

export interface RetentionServiceOptions {
  db: DatabaseLike;
  sessionStore: SessionStore;
  blobs: BlobStore;
  logger: Logger;
  /** absolute path of the SQLite file; `dbBytes` is a `fs.stat`, never a guess */
  dbPath: string;
}

interface SessionActivity {
  id: string;
  /** newest of updated_at / created_at / last event / last completed turn */
  lastActivity: string;
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

export class RetentionService {
  private readonly db: DatabaseLike;
  private readonly sessionStore: SessionStore;
  private readonly blobs: BlobStore;
  private readonly logger: Logger;
  private readonly dbPath: string;

  constructor(opts: RetentionServiceOptions) {
    this.db = opts.db;
    this.sessionStore = opts.sessionStore;
    this.blobs = opts.blobs;
    this.logger = opts.logger.child('retention');
    this.dbPath = opts.dbPath;
  }

  // =========================================================================
  // §8.4 what is on disk right now
  // =========================================================================

  /**
   * Real totals: the sizes are `fs.stat` on the database file and the blob
   * directory, the counts are `COUNT(*)`. `expiredSessions` is what the
   * retention window would remove *now*, and is 0 when the user chose to keep
   * everything forever — reporting "all sessions are expired" under a "keep
   * forever" setting would be the exact lie NFR-15 forbids.
   */
  async usage(): Promise<StorageUsageDto> {
    return this.measured(() => {
      const days = this.retentionDays();
      return {
        dbBytes: this.dbFileBytes(),
        blobBytes: this.blobs.totalBytes(),
        sessions: this.tableCount('sessions'),
        turns: this.tableCount('turns'),
        events: this.tableCount('events'),
        messages: this.tableCount('messages'),
        blobFiles: this.tableCount('blobs'),
        retentionDays: days,
        expiredSessions: this.expiredSessionIds().length,
        encryptionEnabled: this.encryptionEnabled(),
      };
    });
  }

  /**
   * Dry run for one scope. Reads only — no session is deleted, no file is
   * unlinked, no row is written.
   *
   * `blobBytes` is the measured size of the blob files the purge would unlink.
   * `dbBytes` is 0 on purpose: SQLite does not hand freed pages back to the
   * filesystem without a `VACUUM`, so a preview cannot honestly promise a
   * database file reduction, and inventing one would be a number the user could
   * check and find false.
   */
  async preview(scope: StoragePurgeScope, workspaceId?: string): Promise<StorageUsageDto> {
    return this.measured(() => {
      const ids = this.targetSessions(scope, workspaceId);
      const refs = this.blobRefsFor(ids);
      return {
        dbBytes: 0,
        blobBytes: refs.reduce((sum, ref) => sum + this.blobFileBytes(ref), 0),
        sessions: ids.length,
        turns: this.countFor('turns', ids),
        events: this.countFor('events', ids),
        messages: this.countFor('messages', ids),
        blobFiles: refs.length,
        retentionDays: this.retentionDays(),
        expiredSessions: this.expiredSessionIds().length,
        encryptionEnabled: this.encryptionEnabled(),
      };
    });
  }

  // =========================================================================
  // §8.4 清理 — delete rows and blob files together
  // =========================================================================

  /**
   * Deletes every session the scope matches, through `SessionStore.deleteSession`
   * (which owns the child-before-parent cascade and its transaction), then
   * unlinks the blob files those sessions referenced.
   *
   * An empty match returns zeros. A failure part-way through is reported with
   * how far it got: a cleanup that removed 40 of 50 sessions and then stopped
   * must not look like a cleanup that removed nothing.
   */
  async purge(scope: StoragePurgeScope, workspaceId?: string): Promise<StoragePurgeResult> {
    const ids = this.targetSessions(scope, workspaceId);
    if (ids.length === 0) {
      return {
        scope,
        sessionsRemoved: 0,
        eventsRemoved: 0,
        blobFilesRemoved: 0,
        bytesReclaimed: 0,
      };
    }

    const dbBytesBefore = this.dbFileBytes();
    const removedIds: string[] = [];
    const refs = new Set<string>();
    let eventsRemoved = 0;

    for (const id of ids) {
      try {
        const deleted = this.sessionStore.deleteSession(id);
        eventsRemoved += deleted.events;
        for (const ref of deleted.blobs) {
          refs.add(ref);
        }
        removedIds.push(id);
      } catch (error) {
        this.logger.error('retention purge stopped on a session', {
          scope,
          sessionId: id,
          removed: removedIds.length,
          planned: ids.length,
          reason: describeError(error),
        });
        throw appError(
          'STORAGE_ERROR',
          `§8.4 cleanup stopped after ${removedIds.length} of ${ids.length} sessions: ${describeError(error)}`,
          'storage',
          { details: { scope, removed: removedIds, failedSessionId: id } },
        );
      }
    }

    // Measured before the unlink, because afterwards the file is gone and its
    // size is unknowable. Only refs whose file is gone afterwards are counted.
    const sizes = new Map<string, number>();
    for (const ref of refs) {
      sizes.set(ref, this.blobFileBytes(ref));
    }
    const { removed } = this.blobs.deleteMany([...sizes.keys()]);
    let bytesReclaimed = 0;
    for (const [ref, size] of sizes) {
      if (!this.blobs.exists(ref)) bytesReclaimed += size;
    }

    // The database file rarely shrinks on its own; when it does, the real delta
    // is a real reclaim, and when it does not the honest answer is nothing.
    const dbBytesAfter = this.dbFileBytes();
    if (dbBytesAfter < dbBytesBefore) {
      bytesReclaimed += dbBytesBefore - dbBytesAfter;
    }

    const result: StoragePurgeResult = {
      scope,
      sessionsRemoved: removedIds.length,
      eventsRemoved,
      blobFilesRemoved: removed,
      bytesReclaimed,
    };
    this.logger.info('retention purge complete', { ...result });
    return result;
  }

  /**
   * §8.4 "必须同时清理 blob 目录": a file in the blob directory that no
   * `blobs` row references is bytes the product is keeping with nobody's
   * consent. They are removed, and the rows left pointing at files that no
   * longer exist are removed too — the leak runs in both directions.
   */
  async collectOrphanBlobs(): Promise<{ removed: number; bytes: number }> {
    try {
      const referenced = new Set<string>();
      for (const row of this.db.driver.all<{ ref: string }>('SELECT DISTINCT ref FROM blobs')) {
        referenced.add(row.ref);
      }

      const orphans = this.blobs.listOrphans(referenced);
      const sizes = new Map<string, number>();
      for (const ref of orphans) {
        sizes.set(ref, this.blobFileBytes(ref));
      }
      const { removed } = this.blobs.deleteMany(orphans);
      let bytes = 0;
      for (const [ref, size] of sizes) {
        if (!this.blobs.exists(ref)) bytes += size;
      }

      // Rows whose file is gone are dangling in the other direction: they make
      // a transcript look recoverable when nothing can be read back.
      const dangling = [...referenced].filter((ref) => !this.blobs.exists(ref));
      let rowsDeleted = 0;
      for (const chunk of chunks(dangling, PARAM_CHUNK)) {
        const placeholders = chunk.map(() => '?').join(', ');
        rowsDeleted += this.db.driver.run(
          `DELETE FROM blobs WHERE ref IN (${placeholders})`,
          chunk,
        ).changes;
      }

      this.logger.info('orphan blobs collected', {
        removed,
        bytes,
        rowsDeleted,
        dangling,
      });
      return { removed, bytes };
    } catch (error) {
      throw appError(
        'STORAGE_ERROR',
        `§8.4 could not collect orphan blobs: ${describeError(error)}`,
        'storage',
      );
    }
  }

  /**
   * Applies the configured window on demand (startup, or "clear expired").
   * With `retentionDays: null` this is a no-op reporting zeros, which is the
   * correct behaviour for "keep forever" and not a silent failure.
   */
  async applyRetention(): Promise<StoragePurgeResult> {
    return this.purge('expired');
  }

  // =========================================================================
  // internals
  // =========================================================================

  /** Wraps a measurement so a read failure is a readable reason, not a zero. */
  private measured(measure: () => StorageUsageDto): StorageUsageDto {
    try {
      return measure();
    } catch (error) {
      this.logger.error('retention could not read storage usage', {
        reason: describeError(error),
      });
      throw appError(
        'STORAGE_ERROR',
        `§8.4 could not read storage usage: ${describeError(error)}`,
        'storage',
      );
    }
  }

  private retentionDays(): number | null {
    return this.sessionStore.getSettings().storage.retentionDays;
  }

  private encryptionEnabled(): boolean {
    // §2 `Database.isProtected` is optional; absence is reported as "not
    // protected" rather than as an encryption guarantee.
    return this.db.isProtected?.() ?? false;
  }

  /**
   * Every session with the timestamp of its last real activity. The window is
   * measured against the newest thing the session produced, not merely against
   * `sessions.updated_at`, so a session that just wrote an event is not expired
   * by a stale row timestamp.
   */
  private sessionRows(workspaceId?: string): SessionActivity[] {
    const rows = this.db.driver.all<{ id: string; last_activity: string | null }>(
      `SELECT s.id AS id,
              MAX(
                COALESCE(s.updated_at, ''),
                COALESCE(s.created_at, ''),
                COALESCE((SELECT MAX(e.created_at) FROM events e WHERE e.session_id = s.id), ''),
                COALESCE((SELECT MAX(t.completed_at) FROM turns t WHERE t.session_id = s.id), '')
              ) AS last_activity
         FROM sessions s
         ${workspaceId === undefined ? '' : 'WHERE s.workspace_id = ?'}
         ORDER BY s.id ASC`,
      workspaceId === undefined ? [] : [workspaceId],
    );
    return rows.map((row) => ({ id: row.id, lastActivity: row.last_activity ?? '' }));
  }

  private expiredSessionIds(): string[] {
    const days = this.retentionDays();
    // §8.4 "用户可配置为永久": forever means no session is ever expired.
    if (days === null) return [];
    const cutoff = new Date(Date.now() - days * MS_PER_DAY).toISOString();
    return this.sessionRows()
      .filter((row) => row.lastActivity !== '' && row.lastActivity < cutoff)
      .map((row) => row.id);
  }

  /**
   * The sessions a scope covers. `workspace` without a `workspaceId` is a
   * caller mistake the user has to be able to read, so it fails loudly instead
   * of quietly purging everything or nothing.
   */
  private targetSessions(scope: StoragePurgeScope, workspaceId?: string): string[] {
    if (scope === 'expired') {
      return this.expiredSessionIds();
    }
    if (scope === 'workspace') {
      if (workspaceId === undefined || workspaceId === '') {
        throw appError(
          'STORAGE_ERROR',
          '§8.4 cannot clear one project: no project is open, so there is no project to clear',
          'storage',
        );
      }
      return this.sessionRows(workspaceId).map((row) => row.id);
    }
    if (scope === 'all') {
      return this.sessionRows().map((row) => row.id);
    }
    throw appError('STORAGE_ERROR', `§8.4 unknown cleanup scope: ${String(scope)}`, 'storage');
  }

  private tableCount(table: CountableTable): number {
    const row = this.db.driver.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`);
    return countOf(row);
  }

  /** Rows in `table` belonging to any of `ids`, summed over parameter chunks. */
  private countFor(table: Exclude<CountableTable, 'sessions' | 'blobs'>, ids: readonly string[]): number {
    let total = 0;
    for (const chunk of chunks(ids, PARAM_CHUNK)) {
      const placeholders = chunk.map(() => '?').join(', ');
      total += countOf(
        this.db.driver.get<{ n: number }>(
          `SELECT COUNT(*) AS n FROM ${table} WHERE session_id IN (${placeholders})`,
          chunk,
        ),
      );
    }
    return total;
  }

  /** Blob refs attached to any of `ids`, through the events that own them. */
  private blobRefsFor(ids: readonly string[]): string[] {
    const refs: string[] = [];
    for (const chunk of chunks(ids, PARAM_CHUNK)) {
      const placeholders = chunk.map(() => '?').join(', ');
      const rows = this.db.driver.all<{ ref: string }>(
        `SELECT DISTINCT b.ref AS ref FROM blobs b
           JOIN events e ON e.id = b.event_id
          WHERE e.session_id IN (${placeholders})`,
        chunk,
      );
      for (const row of rows) {
        refs.push(row.ref);
      }
    }
    return refs;
  }

  /** Measured size of one blob file, or 0 when it is not there to measure. */
  private blobFileBytes(ref: string): number {
    if (!SAFE_BLOB_REF.test(ref)) return 0;
    try {
      return fs.statSync(path.join(this.blobs.directory, `${ref}.txt`)).size;
    } catch {
      return 0;
    }
  }

  private dbFileBytes(): number {
    try {
      return fs.statSync(this.dbPath).size;
    } catch {
      return 0;
    }
  }
}

function countOf(row: { n: number } | undefined): number {
  const n = row?.n;
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
}
