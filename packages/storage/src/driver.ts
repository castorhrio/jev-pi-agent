/**
 * §8.1 — the only place that talks to `node-sqlite3-wasm`.
 *
 * The WASM VDBE has no implicit transaction helper, so transactions are manual.
 * Nesting is supported through SAVEPOINTs and the authoritative "am I inside a
 * transaction" answer comes from the driver itself (`db.inTransaction`), never
 * from a locally maintained boolean.
 */

import { Database as WasmDatabase } from 'node-sqlite3-wasm';

export interface RunResult {
  changes: number;
  lastInsertRowid: number;
}

export interface SqlDriver {
  runBatch(sql: string): void;
  run(sql: string, params?: unknown[]): RunResult;
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[];
  get<T = Record<string, unknown>>(sql: string, params?: unknown[]): T | undefined;
  /**
   * §8.2 — a synchronous transaction. Re-entrant: a nested call becomes a
   * SAVEPOINT so an inner failure can only undo its own work.
   */
  transaction<T>(fn: () => T): T;
  close(): void;
}

/** Bindable scalar. Anything unusable is mapped to SQL NULL rather than throwing. */
type Bindable = string | number | null | Buffer;

function toBindable(value: unknown): Bindable {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === 'bigint') return Number(value);
  return JSON.stringify(value);
}

function toParams(params: unknown[] | undefined): Bindable[] | undefined {
  return params === undefined ? undefined : params.map(toBindable);
}

class WasmSqlDriver implements SqlDriver {
  /** Nesting depth for SAVEPOINT naming; `0` means "no UCAD transaction open". */
  private depth = 0;

  constructor(private readonly db: WasmDatabase) {}

  runBatch(sql: string): void {
    this.db.exec(sql);
  }

  run(sql: string, params?: unknown[]): RunResult {
    const res = this.db.run(sql, toParams(params));
    return {
      changes: Number(res.changes),
      lastInsertRowid: Number(res.lastInsertRowid),
    };
  }

  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[] {
    return this.db.all(sql, toParams(params)) as unknown as T[];
  }

  get<T = Record<string, unknown>>(sql: string, params?: unknown[]): T | undefined {
    const row = this.db.get(sql, toParams(params));
    return row === null ? undefined : (row as unknown as T);
  }

  transaction<T>(fn: () => T): T {
    // The driver is the source of truth: a caller may have opened a BEGIN by
    // hand, so depth alone is not enough to decide the strategy.
    const nested = this.depth > 0 || this.db.inTransaction;
    const point = `ucad_sp_${this.depth + 1}`;

    this.db.exec(nested ? `SAVEPOINT ${point}` : 'BEGIN IMMEDIATE');
    this.depth += 1;
    try {
      const out = fn();
      this.db.exec(nested ? `RELEASE ${point}` : 'COMMIT');
      this.depth -= 1;
      return out;
    } catch (err) {
      try {
        this.db.exec(
          nested ? `ROLLBACK TO ${point}; RELEASE ${point}` : 'ROLLBACK',
        );
      } catch {
        // the transaction was already unwound by SQLite; surface the original error
      }
      this.depth -= 1;
      throw err;
    }
  }

  close(): void {
    if (!this.db.isOpen) return;
    if (this.db.inTransaction) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* closing must not throw */
      }
    }
    this.db.close();
  }
}

/**
 * Opens (creating if needed) the SQLite file and returns the storage driver.
 *
 * `foreign_keys` is the only pragma that is guaranteed to take effect on the
 * WASM VFS: `journal_mode = WAL` needs shared memory, which the node build of
 * node-sqlite3-wasm does not expose, so the request is still issued (it is
 * harmless and correct on any build that does support it) and the effective mode
 * is left for `Database` to report.
 */
export function openDatabase(dbPath: string): SqlDriver {
  const db = new WasmDatabase(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA synchronous = NORMAL');
  return new WasmSqlDriver(db);
}
