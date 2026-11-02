/**
 * The start-up gate on the OS key store (NFR-15).
 *
 * ## The failure this exists to make readable
 *
 * A real-machine run on Linux recorded the app dying at start-up with
 * `Error while encrypting the text provided to safeStorage.encryptString.
 * Encryption is not available.` and a stack that ended inside the secrets
 * package. That text is true and useless: the machine did have a working
 * Secret Service, and the reason Chromium could not use it was that no desktop
 * environment had been declared, so no key store backend had been selected at
 * all. The three platforms that can produce this message have three different
 * remedies, and the stack trace names none of them.
 *
 * ## What is pinned here
 *
 *  - The gate reads the availability question rather than guessing from a
 *    failed encryption, and it refuses per platform with text a reader can act
 *    on (`XDG_CURRENT_DESKTOP` on Linux, DPAPI on Windows, the keychain on
 *    macOS).
 *  - A container whose key store is unavailable stops **before** the vault or
 *    the database exists. Half-initialised storage is the outcome the gate
 *    exists to prevent, and a file left behind would say the gate had already
 *    committed to writing a key.
 *  - The reason reaches the application log, not only the console — the log is
 *    what the manual verification step tells a reader to look at.
 *  - The gate does not fire when the key store answers, so "unavailable" cannot
 *    become the default state of the check.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The switch the mocked `electron` module answers with, hoisted so the factory
 * can read it. `vi.mock` factories run while imports are still being resolved,
 * and a plain `let` below them would be in its temporal dead zone by then.
 */
const keyring = vi.hoisted(() => ({ available: true }));

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => keyring.available,
    encryptString: (plain: string) => Buffer.from(plain, 'utf8'),
    decryptString: (cipher: Buffer) => cipher.toString('utf8'),
  },
}));

import { UcadApp } from '../../apps/desktop/src/main/app-container';
import {
  KeyringUnavailableError,
  assertKeyringUsable,
} from '../../apps/desktop/src/main/keyring-gate';
import type { AppPaths } from '../../apps/desktop/src/main/paths';

const storage = (available: boolean) => ({ isEncryptionAvailable: () => available });

describe('the key store gate', () => {
  it('says nothing when the key store can encrypt', () => {
    expect(() => assertKeyringUsable(storage(true), 'linux')).not.toThrow();
  });

  it('refuses with the remedy for the platform it was asked on', () => {
    // One assertion per platform rather than one message: the point of the gate
    // is that the reader learns what to *do*, and what to do differs per
    // platform. A single shared sentence would pass no matter which remedy it
    // happened to name.
    const cases: Array<[NodeJS.Platform, string]> = [
      ['linux', 'XDG_CURRENT_DESKTOP'],
      ['linux', 'Secret Service'],
      ['win32', 'DPAPI'],
      ['darwin', 'keychain'],
      ['freebsd', 'freebsd'],
    ];
    for (const [platform, needle] of cases) {
      let caught: unknown;
      try {
        assertKeyringUsable(storage(false), platform);
      } catch (error) {
        caught = error;
      }
      expect(caught, `${platform}: an unavailable key store must not be ignored`).toBeInstanceOf(
        KeyringUnavailableError,
      );
      const error = caught as KeyringUnavailableError;
      expect(error.platform).toBe(platform);
      expect(error.message).toContain(needle);
      expect(error.remedy).toContain(needle);
    }
  });

  it('names the key store in the message, not only in the remedy', () => {
    // `bootstrap.ts` prints `error.message` on one line, so the cause has to be
    // legible there — a message that only said "startup stopped" would send the
    // reader to the stack trace the gate replaced.
    let message = '';
    try {
      assertKeyringUsable(storage(false), 'linux');
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('OS key store cannot encrypt');
  });
});

describe('a container started without a usable key store', () => {
  let dir: string;
  let app: UcadApp | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucad-keyring-'));
    keyring.available = true;
  });

  afterEach(async () => {
    await app?.dispose();
    app = undefined;
    keyring.available = true;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function freshPaths(): AppPaths {
    return {
      userData: dir,
      dbPath: path.join(dir, 'ucad.db'),
      blobDir: path.join(dir, 'blobs'),
      logDir: path.join(dir, 'logs'),
      cacheDir: path.join(dir, 'cache'),
      downloadDir: path.join(dir, 'downloads'),
    };
  }

  it('stops before the vault or the database exists', async () => {
    keyring.available = false;
    app = new UcadApp({ paths: freshPaths() });

    await expect(app.start()).rejects.toBeInstanceOf(KeyringUnavailableError);

    expect(fs.existsSync(path.join(dir, 'secrets.vault'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'ucad.db'))).toBe(false);
  });

  it('leaves the reason in the log the app itself reports', async () => {
    keyring.available = false;
    app = new UcadApp({ paths: freshPaths() });

    await expect(app.start()).rejects.toThrow(/OS key store cannot encrypt/);

    // `memoryLog`, not `logs/app.log`: the file sink is an async write stream,
    // so *when* a line appears on disk is not a fact this test can rely on. The
    // memory sink is written synchronously and is the same record set the
    // diagnostics surface shows a user.
    const records = app.memoryLog.records.map((rec) => `${rec.msg} ${JSON.stringify(rec.meta ?? {})}`);
    expect(
      records.some(
        (line) =>
          line.includes('OS key store unavailable; UCAD will not start') &&
          line.includes('XDG_CURRENT_DESKTOP'),
      ),
      `expected the key store refusal in:\n${records.join('\n')}`,
    ).toBe(true);

    // A stopped start still has to tear down: the fields the gate left unbuilt
    // are exactly what a careless `dispose()` would dereference next.
    await expect(app.dispose()).resolves.toBeUndefined();
    app = undefined;
  });

  it('still starts when the key store answers', async () => {
    // The reverse half: without it, a gate that fired on every platform would
    // ship green, and the field it protects would be the only thing still
    // reporting the truth.
    app = new UcadApp({ paths: freshPaths() });

    await expect(app.start()).resolves.toBeUndefined();

    expect(fs.existsSync(path.join(dir, 'ucad.db'))).toBe(true);
    expect(
      app.memoryLog.records.some((rec) => rec.msg.includes('OS key store unavailable')),
    ).toBe(false);
  });
});
