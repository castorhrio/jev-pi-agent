/**
 * The secret vault must never report a write it did not make.
 *
 * ## Why this exists
 *
 * `SafeStorageSecretStore` had no test at all, and it contained the worst
 * failure shape in the app: a **false success on a credential write**.
 *
 * `set()` encrypted the value into an in-memory vault, set a dirty flag and
 * scheduled a debounced flush 250 ms later. It then resolved. So when the disk
 * write failed — disk full, unwritable userData, a DPAPI call that throws — the
 * error was logged inside a timer callback that had no caller to return to, and
 * the IPC handler told the renderer the save succeeded. Worse, `exists()` and
 * `describe()` read the *same in-memory vault*, so the app confirmed its own lie:
 * the provider showed 「已配置」, the user restarted, and the key was gone.
 *
 * The sibling failure is worse still. `getOrCreateDatabaseKey()` used the same
 * swallowed flush, so a key that was never persisted produced a **new key on
 * every launch** while the database columns stayed encrypted with the first one
 * — permanently unreadable data, with nothing in the log that points at it.
 *
 * ## The one thing worth generalising
 *
 * The debounce is not an innocent optimisation here. A write that completes
 * inside a timer callback has no caller to return an error to, so **the debounce
 * is what made the error unreportable**. Every assertion below about "rejects
 * rather than resolves" is really an assertion about that.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SafeStorageSecretStore } from '@ucad/secrets';
import { silentLogger } from '@ucad/observability';
import type { SecretRef } from '@ucad/contracts';

const REF: SecretRef = { providerId: 'acme', key: 'apiKey' };

describe('the secret vault reports a write it could not make', () => {
  let dir: string;
  let vaultPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucad-vault-'));
    vaultPath = path.join(dir, 'secrets.vault');
    // The blocker for the `unwritable` case: a regular file where a directory
    // would have to be, so `mkdirSync` fails on every platform.
    fs.writeFileSync(path.join(dir, 'not-a-directory'), 'x');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /**
   * Stands in for Electron `safeStorage`. A reversible transform is enough —
   * what these tests care about is *when the bytes reach the disk*, not the
   * strength of the cipher.
   *
   * Two different ways to fail, because they exercise different code:
   *  - `broken` makes the platform cipher itself throw. In `set` that happens
   *    *before* anything is mutated, so there is nothing to undo and the real
   *    cause is the most useful thing to report.
   *  - `unwritable` points the vault inside a regular file, so `mkdirSync`
   *    fails. This is the disk-full / bad-permissions path, and it is the one
   *    that reaches `commit`'s rollback.
   */
  const open = (opts: { broken?: boolean; unwritable?: boolean } = {}) => {
    const target = opts.unwritable
      ? path.join(dir, 'not-a-directory', 'secrets.vault')
      : vaultPath;
    return new SafeStorageSecretStore({
      logger: silentLogger('secrets-test'),
      protect: (plain) => {
        if (opts.broken) throw new Error('DPAPI is unavailable');
        return Buffer.from(plain).reverse();
      },
      unprotect: (cipher) => Buffer.from(cipher).reverse(),
      vaultPath: target,
    });
  };

  it('puts the credential on disk before set() resolves', async () => {
    const store = open();
    await store.set(REF, 'sk-live-123');

    // A *fresh* store over the same file is the only honest witness: reading
    // the same instance back would pass even if nothing was ever written.
    expect(await open().get(REF)).toBe('sk-live-123');
  });

  it('rejects instead of reporting a successful save', async () => {
    // The property under test is "it throws", not the wording of the throw.
    // Pinning the exact message would make the test a hostage to its own
    // phrasing, and the cause legitimately differs by failure point: a cipher
    // that throws in `set` happens before any mutation and should report the
    // real reason, while a write that fails has to roll back and describe the
    // vault.
    await expect(open({ broken: true }).set(REF, 'sk-live-123')).rejects.toThrow();
    await expect(open({ unwritable: true }).set(REF, 'sk-live-123')).rejects.toThrow(
      /could not be written/,
    );
  });

  it('does not claim the credential is configured after a failed write', async () => {
    // The old code left the value in the in-memory vault, so `exists` and
    // `describe` cheerfully reported a credential that was never durable. This
    // is the assertion that makes the rollback in `commit` load-bearing rather
    // than tidy: without it, nothing would notice the rollback was missing.
    const store = open({ unwritable: true });
    await expect(store.set(REF, 'sk-live-123')).rejects.toThrow();

    expect(await store.exists(REF)).toBe(false);
    expect((await store.describe(REF)).configured).toBe(false);
  });

  it('keeps an earlier credential intact when a later write fails', async () => {
    const good = open();
    await good.set(REF, 'first-key');
    await good.delete(REF);
    await good.set(REF, 'second-key');

    const broken = open({ broken: true });
    await expect(broken.set(REF, 'third-key')).rejects.toThrow();

    // The failed attempt must not have destroyed what was already saved.
    expect(await open().get(REF)).toBe('second-key');
  });

  it('rejects a delete it could not persist, and keeps the secret', async () => {
    const good = open();
    await good.set(REF, 'sk-live-123');

    const broken = open({ broken: true });
    await expect(broken.delete(REF)).rejects.toThrow();
    expect(await open().get(REF)).toBe('sk-live-123');
  });

  it('refuses to hand out a database key it could not persist', () => {
    // Throwing here is deliberate: a key that was never written encrypts
    // columns nobody will ever be able to read, and the next launch would mint
    // a different one without saying so. A loud refusal beats silent,
    // permanent data loss.
    expect(() => open({ unwritable: true }).getOrCreateDatabaseKey()).toThrow(
      /could not be written/,
    );
    // A cipher that throws fails before the entry is even built, so no key is
    // handed out and no half-written entry is left behind.
    expect(() => open({ broken: true }).getOrCreateDatabaseKey()).toThrow();
    expect(open({ broken: true }).hasDatabaseKey()).toBe(false);
  });

  it('gives the same database key to every later launch', () => {
    const first = open().getOrCreateDatabaseKey();
    const second = open().getOrCreateDatabaseKey();
    expect(second.equals(first)).toBe(true);
  });

  it('never writes a credential in the clear', async () => {
    await open().set(REF, 'sk-live-plaintext-canary');
    const raw = fs.readFileSync(vaultPath, 'utf8');
    expect(raw).not.toContain('sk-live-plaintext-canary');
    // NFR-01 / §4.10 S-4: the Renderer can write a credential but never read it
    // back. The hint is derived from the ciphertext, so it leaks nothing either.
    const hint = (await open().describe(REF)).keyHint;
    expect(raw).not.toContain(hint);
  });
});

/**
 * The data-destruction path, kept in its own block because it is the worst one
 * in the module and it is a *read* failure rather than a write one.
 *
 * `load()` used to answer "there is nothing here" for every reason the file
 * could not be read. With an empty vault, `getOrCreateDatabaseKey()` minted a
 * fresh key and wrote it to the same path — destroying the file that held the
 * previous database key and every vendor credential, while the database columns
 * stayed encrypted with the key that had just been overwritten. One line in a
 * log nobody reads, and no way back.
 */
describe('an unreadable vault is left alone rather than overwritten', () => {
  let dir: string;
  let vaultPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucad-vault-unreadable-'));
    vaultPath = path.join(dir, 'secrets.vault');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const reverse = (buf: Buffer) => Buffer.from(buf).reverse();
  const open = () =>
    new SafeStorageSecretStore({
      logger: silentLogger('secrets-test'),
      protect: reverse,
      unprotect: reverse,
      vaultPath,
    });

  /** A real, populated vault — the thing that has to survive. */
  const seed = async (): Promise<Buffer> => {
    const store = open();
    await store.set(REF, 'sk-live-survivor');
    return store.getOrCreateDatabaseKey();
  };

  it('refuses to mint a new database key over an unreadable vault', async () => {
    const originalKey = await seed();
    const before = fs.readFileSync(vaultPath, 'utf8');
    expect(originalKey.length).toBe(32);

    // Present and non-empty, but no longer decrypts — what a truncated write or
    // a lost DPAPI profile actually looks like.
    fs.writeFileSync(vaultPath, 'ucadv1:garbage');

    // Before the fix this returned a brand new key and overwrote the file.
    expect(() => open().getOrCreateDatabaseKey()).toThrow(/left untouched/);

    // The evidence that matters is the one below, not this line: the corrupt
    // file is still exactly as corrupt as we left it.
    expect(fs.readFileSync(vaultPath, 'utf8')).toBe('ucadv1:garbage');

    // And once the file is readable again, the *original* key comes back —
    // which is the entire point of not having overwritten it.
    fs.writeFileSync(vaultPath, before);
    expect(open().getOrCreateDatabaseKey().equals(originalKey)).toBe(true);
  });

  it('refuses to save a credential over an unreadable vault', async () => {
    await seed();
    const before = fs.readFileSync(vaultPath, 'utf8');
    fs.writeFileSync(vaultPath, 'ucadv1:garbage');

    await expect(open().set(REF, 'sk-live-new')).rejects.toThrow(/left untouched/);
    expect(fs.readFileSync(vaultPath, 'utf8')).toBe('ucadv1:garbage');

    fs.writeFileSync(vaultPath, before);
    expect(await open().get(REF)).toBe('sk-live-survivor');
  });

  it('refuses a delete it cannot verify, and leaves the file alone', async () => {
    await seed();
    const before = fs.readFileSync(vaultPath, 'utf8');
    fs.writeFileSync(vaultPath, 'ucadv1:garbage');

    // "I could not read it" is not evidence that the entry is already gone.
    await expect(open().delete(REF)).rejects.toThrow(/left untouched/);
    fs.writeFileSync(vaultPath, before);
    expect(await open().get(REF)).toBe('sk-live-survivor');
  });

  it('treats an unrecognised header as unreadable, not as empty', async () => {
    await seed();
    fs.writeFileSync(vaultPath, 'some-other-format:whatever');

    // Not empty either: an unknown header is still a file we must not destroy.
    expect(() => open().getOrCreateDatabaseKey()).toThrow(/left untouched/);
    expect(fs.readFileSync(vaultPath, 'utf8')).toBe('some-other-format:whatever');
  });
});
