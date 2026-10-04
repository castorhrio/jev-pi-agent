/**
 * @ucad/secrets — DPAPI-backed secret storage.
 *
 * Two rules shape this implementation:
 *  1. The Renderer can write a credential but never read it back (NFR-01,
 *     §4.10 S-4). There is no IPC channel that returns plaintext.
 *  2. The key that encrypts the database must NOT live inside that database —
 *     otherwise at-rest protection protects nothing. So this store owns its own
 *     small vault file, encrypted with Electron `safeStorage` (DPAPI on
 *     Windows), and the DB key is only ever handed to the storage layer.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { SecretDescriptor, SecretRef, SecretStore } from '@ucad/contracts';
import { keyHint, secretKey, describeError } from '@ucad/contracts';
import type { Logger } from '@ucad/observability';
import { nowIso } from '@ucad/observability';

const VAULT_MAGIC = 'ucadv1';
const DATABASE_KEY_ID = '__ucad_db_key__';

export interface SafeStorageSecretStoreOptions {
  logger: Logger;
  /** Electron safeStorage.encryptString */
  protect: (plain: Buffer) => Buffer;
  /** Electron safeStorage.decryptString */
  unprotect: (cipher: Buffer) => Buffer;
  /** vault file location, e.g. <userData>/secrets.vault */
  vaultPath: string;
}

interface VaultEntry {
  /** DPAPI ciphertext of the secret, base64 */
  cipher: string;
  updatedAt: string;
}

type Vault = Record<string, VaultEntry>;

export class SafeStorageSecretStore implements SecretStore {
  private readonly opts: SafeStorageSecretStoreOptions;
  private readonly logger: Logger;
  private vault: Vault = {};
  private dirty = false;
  /**
   * Non-null when a vault file exists but could not be read. Distinct from
   * "the vault is empty", and the difference is the whole ballgame: see `load`.
   */
  private loadFailure: string | null = null;

  constructor(opts: SafeStorageSecretStoreOptions) {
    this.opts = opts;
    this.logger = opts.logger.child('secrets');
    this.load();
  }

  // -------------------------------------------------------------------------
  // SecretStore
  // -------------------------------------------------------------------------

  /** One-way write. The only secret-related channel the Renderer can reach. */
  async set(ref: SecretRef, value: string): Promise<void> {
    this.assertRef(ref);
    // Before the value is even encrypted: refusing here keeps the plaintext out
    // of memory entirely when the write cannot possibly succeed.
    this.assertWritable();
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error('secret value must be a non-empty string');
    }
    // Encrypt first: if the platform's DPAPI call throws, nothing has been
    // mutated yet and there is nothing to undo.
    const cipher = this.opts.protect(Buffer.from(value, 'utf8'));
    const key = secretKey(ref);
    this.commit(
      key,
      this.vault[key],
      () => {
        this.vault[key] = { cipher: cipher.toString('base64'), updatedAt: nowIso() };
      },
    );
    this.logger.info('secret stored', { providerId: ref.providerId, key: ref.key });
  }

  /** Main / Agent Host only. There is deliberately no IPC read channel. */
  async get(ref: SecretRef): Promise<string | null> {
    this.assertRef(ref);
    const entry = this.vault[secretKey(ref)];
    if (!entry) return null;
    const plain = this.opts.unprotect(Buffer.from(entry.cipher, 'base64'));
    return plain.toString('utf8');
  }

  async delete(ref: SecretRef): Promise<void> {
    this.assertRef(ref);
    // A delete is a whole-file rewrite too, and "I could not read it" is not
    // evidence that the entry is already gone.
    this.assertWritable();
    const key = secretKey(ref);
    if (!this.vault[key]) return;
    const previous = this.vault[key];
    this.commit(key, previous, () => {
      delete this.vault[key];
    });
    this.logger.info('secret deleted', { providerId: ref.providerId, key: ref.key });
  }

  async exists(ref: SecretRef): Promise<boolean> {
    this.assertRef(ref);
    return Boolean(this.vault[secretKey(ref)]);
  }

  /** Metadata for the Renderer. Never contains plaintext (§4.10 S-3). */
  async describe(ref: SecretRef): Promise<SecretDescriptor> {
    this.assertRef(ref);
    const entry = this.vault[secretKey(ref)];
    if (!entry) return { configured: false, keyHint: '----' };
    return {
      configured: true,
      keyHint: keyHint(entry.cipher),
      updatedAt: entry.updatedAt,
    };
  }

  // -------------------------------------------------------------------------
  // NFR-15: the at-rest database key
  // -------------------------------------------------------------------------

  /**
   * Returns the 32-byte key used to encrypt the database's large columns,
   * generating and persisting one on first use. Deliberately not stored in the
   * database it protects.
   */
  getOrCreateDatabaseKey(): Buffer {
    /*
     * Refuses before it can mint anything. This is the single call that turns
     * an unreadable vault into destroyed data: without the check it sees an
     * empty map, creates a fresh key, and `commit` writes it over the file that
     * still holds the old key and every stored credential.
     */
    this.assertWritable();
    const existing = this.vault[DATABASE_KEY_ID];
    if (existing) {
      return this.opts.unprotect(Buffer.from(existing.cipher, 'base64'));
    }
    const key = randomBytes(32);
    /*
     * This one throws if the write fails, and that is the whole point.
     *
     * A database key that was never persisted is not a degraded credential, it
     * is an orphaned database: the columns were encrypted with it, and the
     * next launch would generate a *different* key and be unable to read any
     * of them. Failing here sends this through the startup path that already
     * exists for a fatal error (NFR-07), which says why. Starting anyway would
     * trade a loud refusal now for silent, permanent data loss later.
     */
    this.commit(DATABASE_KEY_ID, undefined, () => {
      this.vault[DATABASE_KEY_ID] = {
        cipher: this.opts.protect(key).toString('base64'),
        updatedAt: nowIso(),
      };
    });
    this.logger.info('database encryption key created');
    return key;
  }

  hasDatabaseKey(): boolean {
    return Boolean(this.vault[DATABASE_KEY_ID]);
  }

  /**
   * Called on app shutdown to retry anything a failed write left behind.
   *
   * Every write is synchronous and reported, so in normal operation there is
   * nothing pending here. This remains as the safety net for the one case that
   * can leave the vault dirty: a write that failed and whose caller was
   * `flush` itself.
   */
  flush(): void {
    if (!this.dirty) return;
    this.write();
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  /**
   * Applies a change to the vault and puts it on disk **before** the caller is
   * told it happened.
   *
   * The old shape wrote to memory, set a dirty flag and scheduled a debounced
   * flush on a 250 ms timer. That was comfortable and it was wrong in two ways
   * that only matter together:
   *
   *  1. `set()` resolved as soon as the value was in memory, while the disk
   *     write had not been attempted yet. A failure could not be reported to
   *     anyone, because by the time the write happened there was no longer a
   *     caller waiting on it — the error had nowhere to go but the log.
   *  2. `exists()` and `describe()` read the same in-memory vault, so they
   *     confirmed a credential that was never durable. The UI showed
   *     「已配置」, the user restarted, and the key was gone.
   *
   * **The debounce is what made the error unreportable.** A write that finishes
   * inside a timer callback has no caller to return to, so removing it is what
   * restores the ability to tell the truth. Secrets are written when a person
   * pastes a key, so the coalescing was never buying anything worth this.
   *
   * On failure the change is rolled back, because an entry that is not on disk
   * must not be reported as stored — otherwise the app agrees with its own lie
   * until the next launch.
   */
  private commit(
    key: string,
    previous: VaultEntry | undefined,
    change: () => void,
  ): void {
    const wasDirty = this.dirty;
    change();
    this.dirty = true;
    const failure = this.write();
    if (failure === null) return;
    if (previous === undefined) delete this.vault[key];
    else this.vault[key] = previous;
    // Restored rather than forced true: the vault is now exactly as it was
    // before this call, so whether anything is still owed to disk is the
    // question that was already true on the way in.
    this.dirty = wasDirty;
    throw new Error(
      `the secret vault could not be written to ${this.opts.vaultPath}: ${failure}. ` +
        'The credential was not stored.',
    );
  }

  /** @returns null when the vault is on disk, or the reason it is not. */
  private write(): string | null {
    try {
      fs.mkdirSync(path.dirname(this.opts.vaultPath), { recursive: true });
      const body = JSON.stringify(this.vault);
      const bodyCipher = this.opts.protect(Buffer.from(body, 'utf8')).toString('base64');
      fs.writeFileSync(this.opts.vaultPath, `${VAULT_MAGIC}:${bodyCipher}`, {
        encoding: 'utf8',
        mode: 0o600,
      });
      this.dirty = false;
      return null;
    } catch (error) {
      const reason = describeError(error);
      this.logger.error('failed to persist secret vault', { error: reason });
      return reason;
    }
  }

  /**
   * Reads the vault, and distinguishes "there is nothing here" from "there is
   * something here and I could not read it".
   *
   * The second case is the dangerous one, and it used to be collapsed into the
   * first. A vault that fails to decrypt — DPAPI unavailable after a machine
   * restore, a file truncated by a crash during the previous write, a lock —
   * left `vault` empty, so `getOrCreateDatabaseKey` saw no key, minted a new
   * one, and wrote it **to the same path**. That single write destroyed the
   * file holding the previous database key *and* every stored vendor
   * credential, while the database columns stayed encrypted with the key that
   * had just been overwritten: permanently unreadable data, with one line in a
   * log nobody reads.
   *
   * So the failure is recorded and the file is left exactly as it was found.
   */
  private load(): void {
    try {
      if (!fs.existsSync(this.opts.vaultPath)) return;
      const raw = fs.readFileSync(this.opts.vaultPath, 'utf8');
      if (!raw.startsWith(`${VAULT_MAGIC}:`)) {
        // Not "empty" either. An unrecognised header is a file we must not
        // overwrite, for exactly the reason above.
        this.loadFailure = `the vault at ${this.opts.vaultPath} has an unrecognised format`;
        this.logger.warn('vault file has an unrecognised format; leaving it untouched');
        return;
      }
      const cipher = Buffer.from(raw.slice(VAULT_MAGIC.length + 1), 'base64');
      const body = this.opts.unprotect(cipher).toString('utf8');
      const parsed: unknown = JSON.parse(body);
      if (parsed && typeof parsed === 'object') {
        this.vault = parsed as Vault;
      }
    } catch (error) {
      this.loadFailure = describeError(error);
      this.logger.error('failed to read secret vault; leaving it untouched', {
        error: describeError(error),
      });
    }
  }

  /**
   * Refuses any change while the vault on disk is unreadable.
   *
   * Every write here rewrites the whole file, so "I could not read it" has to
   * mean "I will not overwrite it". The file is the user's only copy of those
   * credentials, and it may well be recoverable — a restored DPAPI profile, a
   * re-unlocked keychain. Overwriting it destroys the only thing that can be
   * recovered.
   */
  private assertWritable(): void {
    if (this.loadFailure === null) return;
    throw new Error(
      `the secret vault at ${this.opts.vaultPath} could not be read (${this.loadFailure}). ` +
        'It has been left untouched, because writing would overwrite whatever it still holds. ' +
        'Fix the underlying problem and restart rather than saving over it.',
    );
  }

  /**
   * A SecretRef arrives over IPC, so the key is validated before it is used as
   * part of a vault lookup or a log line.
   */
  private assertRef(ref: SecretRef): void {
    if (!ref || typeof ref.providerId !== 'string' || typeof ref.key !== 'string') {
      throw new Error('invalid SecretRef');
    }
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(ref.providerId) || !/^[A-Za-z0-9_.-]{1,64}$/.test(ref.key)) {
      throw new Error('invalid SecretRef');
    }
  }
}

/**
 * AES-256-GCM helper shared with the storage layer's column encryption.
 * Format: `ucadenc:v1:<iv b64>:<tag b64>:<ciphertext b64>`
 */
export function encryptString(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `ucadenc:v1:${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}

export function decryptString(stored: string, key: Buffer): string {
  const parts = stored.split(':');
  if (parts.length !== 5 || parts[0] !== 'ucadenc' || parts[1] !== 'v1') {
    throw new Error('not an encrypted value');
  }
  const iv = Buffer.from(parts[2] as string, 'base64');
  const tag = Buffer.from(parts[3] as string, 'base64');
  const ct = Buffer.from(parts[4] as string, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

export function isEncryptedValue(value: string): boolean {
  return value.startsWith('ucadenc:v1:');
}
