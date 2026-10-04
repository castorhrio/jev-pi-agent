/**
 * §8.1 / NFR-07 / NFR-15 — the database handle every other package borrows.
 *
 * Responsibilities kept deliberately narrow: open the file, own the schema and
 * the migration runner, expose the driver, and provide the at-rest column
 * encryption helpers. Row semantics for `events` / `messages` live in
 * `EventLog` / `MessageProjector`.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { appError } from '@ucad/contracts';
import type { AppError, AppErrorCode } from '@ucad/contracts';
import { nowIso } from '@ucad/observability';
import type { Logger } from '@ucad/observability';
import { openDatabase } from './driver';
import type { SqlDriver } from './driver';
import { MIGRATIONS, SCHEMA_VERSION_TABLE_SQL, TARGET_SCHEMA_VERSION } from './migrations';

/** §2 "at-rest": `ucadenc:v1:<iv b64>:<tag b64>:<ct b64>`. */
const ENVELOPE_PREFIX = 'ucadenc:v1';
const ENVELOPE_PARTS = 5;

/** §2: only bodies above 1 KiB are worth an envelope. */
const AT_REST_MIN_BYTES = 1024;

const AES_ALGORITHM = 'aes-256-gcm';
const AES_IV_BYTES = 12;

export interface DatabaseProtection {
  /** Raw key material from `@ucad/secrets` (§4.10). Never persisted. */
  key: Buffer;
}

export interface DatabaseOptions {
  dbPath: string;
  logger: Logger;
  busyTimeoutMs?: number;
  /** NFR-15 / §8.4. Absent => no encryption; `isProtected()` reports the truth. */
  protection?: DatabaseProtection;
}

export interface MigrationResult {
  from: number;
  to: number;
  applied: number[];
}

/**
 * An `Error` that carries the canonical `AppError` shape. Constructed only
 * through `appError` (§0 error convention) so Main, IPC and the log all see the
 * same code / component.
 */
class AppErrorThrow extends Error {
  readonly appError: AppError;

  constructor(error: AppError) {
    super(error.message);
    this.name = 'AppError';
    this.appError = error;
  }
}

function storageFailure(
  code: AppErrorCode,
  message: string,
  details?: unknown,
): AppErrorThrow {
  return new AppErrorThrow(
    appError(code, message, 'storage', details === undefined ? {} : { details }),
  );
}

/** A 32 byte key is used as-is; anything else (e.g. a DPAPI blob) is hashed. */
function deriveKey(key: Buffer): Buffer {
  return key.length === 32 ? key : createHash('sha256').update(key).digest();
}

export class Database {
  readonly driver: SqlDriver;

  private readonly logger: Logger;
  private readonly key: Buffer | null;

  constructor(opts: DatabaseOptions) {
    this.logger = opts.logger.child('database');
    this.key = opts.protection ? deriveKey(opts.protection.key) : null;

    const dir = path.dirname(path.resolve(opts.dbPath));
    fs.mkdirSync(dir, { recursive: true });

    this.driver = openDatabase(opts.dbPath);

    const busy = opts.busyTimeoutMs ?? 5000;
    if (Number.isInteger(busy) && busy >= 0) {
      this.driver.runBatch(`PRAGMA busy_timeout = ${busy}`);
    }

    const mode = this.driver.get<{ journal_mode?: string }>('PRAGMA journal_mode');
    const effective = mode?.journal_mode ?? 'unknown';
    if (effective === 'wal') {
      this.logger.info('database opened', { journalMode: effective, protected: this.isProtected() });
    } else {
      // NFR-15 honesty: the WASM VFS has no shared memory, so WAL is not
      // available. The pragma is still issued (see openDatabase) and the real
      // mode is reported instead of being assumed.
      this.logger.warn('journal_mode is not WAL on this build', {
        journalMode: effective,
      });
    }
  }

  /** NFR-07: the highest applied migration, `0` on a fresh file. */
  get schemaVersion(): number {
    const row = this.driver.get<{ version?: number }>(
      'SELECT MAX(version) AS version FROM schema_version',
    );
    const value = row?.version;
    return typeof value === 'number' ? value : 0;
  }

  /** NFR-15 / §8.4: the true at-rest state, for the Settings page. */
  isProtected(): boolean {
    return this.key !== null;
  }

  /**
   * The journal mode the file is actually in.
   *
   * The WASM VFS has no shared memory, so WAL is unavailable and the pragma is
   * a no-op. The Diagnostics page shows this rather than a hard-coded 'wal',
   * because a setting that is claimed but not in effect is worse than a
   * limitation that is stated.
   */
  journalMode(): string {
    const row = this.driver.get<{ journal_mode?: string }>('PRAGMA journal_mode');
    return row?.journal_mode ?? 'unknown';
  }

  /**
   * §2 at-rest, for bulk content. Identity when no key is configured or the
   * value is small enough that an envelope would cost more than it buys;
   * already-enveloped values pass through so the call is idempotent.
   *
   * The 1 KiB floor is a transcript decision: it exists so a short string does
   * not become a longer encrypted one.
   */
  encryptIfNeeded(plain: string): string {
    if (this.key === null) return plain;
    if (plain.startsWith(`${ENVELOPE_PREFIX}:`)) return plain;
    if (Buffer.byteLength(plain, 'utf8') < AT_REST_MIN_BYTES) return plain;
    return this.seal(plain);
  }

  /**
   * §2 at-rest, for anything credential-shaped. **No size floor.**
   *
   * This exists because the floor above is the wrong tool for a secret. A
   * `GITHUB_TOKEN` or a `DATABASE_URL` is typically a few dozen bytes, so
   * `encryptIfNeeded` returned it verbatim — and the at-rest protection the
   * product advertises in Settings was, for exactly the data it exists to
   * protect, not in effect. The envelope is larger than the value; that is the
   * correct trade for a secret and the wrong one for a paragraph of prose, which
   * is why the two are separate methods rather than one flag.
   */
  encryptSecret(plain: string): string {
    if (this.key === null) return plain;
    if (plain.startsWith(`${ENVELOPE_PREFIX}:`)) return plain;
    return this.seal(plain);
  }

  private seal(plain: string): string {
    const iv = randomBytes(AES_IV_BYTES);
    const cipher = createCipheriv(AES_ALGORITHM, this.key as Buffer, iv);
    const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [
      ENVELOPE_PREFIX,
      iv.toString('base64'),
      tag.toString('base64'),
      ciphertext.toString('base64'),
    ].join(':');
  }

  /** Identity without a key or for a plaintext column. */
  decryptIfNeeded(stored: string): string {
    if (!stored.startsWith(`${ENVELOPE_PREFIX}:`)) return stored;
    if (this.key === null) {
      throw storageFailure(
        'STORAGE_ERROR',
        'encrypted column read without a protection key (NFR-15)',
      );
    }

    // 'ucadenc' | 'v1' | iv | tag | ciphertext — the prefix itself carries a
    // colon, so the parts are addressed by index, never by destructuring.
    const parts = stored.split(':');
    if (parts.length !== ENVELOPE_PARTS || parts[0] !== 'ucadenc' || parts[1] !== 'v1') {
      throw storageFailure('STORAGE_ERROR', 'malformed at-rest envelope');
    }
    const ivB64 = parts[2];
    const tagB64 = parts[3];
    const ctB64 = parts[4];
    if (ivB64 === undefined || tagB64 === undefined || ctB64 === undefined) {
      throw storageFailure('STORAGE_ERROR', 'malformed at-rest envelope');
    }

    try {
      const decipher = createDecipheriv(AES_ALGORITHM, this.key, Buffer.from(ivB64, 'base64'));
      decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
      return Buffer.concat([
        decipher.update(Buffer.from(ctB64, 'base64')),
        decipher.final(),
      ]).toString('utf8');
    } catch (err) {
      throw storageFailure('STORAGE_ERROR', 'at-rest decryption failed', {
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * NFR-07: apply every pending migration in ascending version order inside one
   * transaction. A failure rolls the whole set back and throws
   * MIGRATION_FAILED — the app must not continue on a half-upgraded schema.
   * A missing protection key is NOT a failure (§2).
   */
  migrate(): MigrationResult {
    this.driver.runBatch(SCHEMA_VERSION_TABLE_SQL);
    const from = this.schemaVersion;

    // NFR-07 guards both directions. A database written by a *newer* build must
    // not be opened by an older one: the old code cannot know what the extra
    // columns mean, and "no pending migrations" would look like success while
    // quietly writing data this build cannot read back.
    const latestKnown = TARGET_SCHEMA_VERSION;
    if (from > latestKnown) {
      throw storageFailure(
        'MIGRATION_FAILED',
        `数据库 schema 版本 v${from} 高于本版本支持的 v${latestKnown}，请升级 UCAD`,
        { found: from, supported: latestKnown },
      );
    }

    const pending = MIGRATIONS.filter((m) => m.version > from).sort(
      (a, b) => a.version - b.version,
    );
    const applied: number[] = [];

    if (pending.length > 0) {
      try {
        this.driver.transaction(() => {
          for (const migration of pending) {
            this.driver.runBatch(migration.sql);
            this.driver.run(
              'INSERT INTO schema_version(version, applied_at) VALUES(?, ?)',
              [migration.version, nowIso()],
            );
            applied.push(migration.version);
          }
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error('migration failed', { from, attempted: applied, reason: message });
        throw storageFailure(
          'MIGRATION_FAILED',
          `schema migration failed at or before version ${TARGET_SCHEMA_VERSION}`,
          { from, applied, reason: message },
        );
      }
    }

    const to = this.schemaVersion;
    this.logger.info('schema ready', { from, to, applied, protected: this.isProtected() });
    return { from, to, applied };
  }

  transaction<T>(fn: () => T): T {
    return this.driver.transaction(fn);
  }

  close(): void {
    this.driver.close();
  }
}
