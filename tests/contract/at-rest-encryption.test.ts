/**
 * NFR-15 / §8.4 at-rest protection.
 *
 * The clause that matters is not "the database is encrypted" but "a secret is
 * not readable from the database file". Those came apart, and the product
 * advertised the second while implementing the first.
 *
 * `encryptIfNeeded` skips anything under 1 KiB, because for transcript-sized
 * content an envelope is larger than the value it wraps. That is the wrong
 * trade for a credential: `GITHUB_TOKEN=ghp_…` is a few dozen bytes, so it was
 * stored verbatim — the at-rest protection was not in effect for precisely the
 * data it exists to protect. `encryptSecret` exists because of that, and this
 * file is what keeps the two from being merged back together.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Database } from '@ucad/storage';
import { silentLogger } from '@ucad/observability';

describe('NFR-15 at-rest protection', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucad-atrest-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const open = (name: string, key: Buffer | null) => {
    const db = new Database({
      dbPath: path.join(dir, `${name}.db`),
      logger: silentLogger('at-rest'),
      ...(key !== null ? { protection: { key } } : {}),
    });
    db.migrate();
    return db;
  };

  it('encrypts a credential-shaped value even though it is far under 1 KiB', () => {
    const db = open('protected', randomBytes(32));
    try {
      // Shaped like a credential on purpose — that is what this test is about —
      // but obviously not one. A realistic-looking token in a test file is
      // indistinguishable from a leaked one to GitHub's push protection and to
      // anyone auditing the repository, and it buys the test nothing: the value
      // is only ever compared against itself.
      const secret = 'ghp_NOTAREALTOKENexample0000000000';
      const stored = db.encryptSecret(secret);
      expect(stored).not.toContain(secret);
      expect(stored.startsWith('ucadenc:v1:')).toBe(true);
      expect(db.decryptIfNeeded(stored)).toBe(secret);
    } finally {
      db.close();
    }
  });

  it('still leaves short bulk content alone — the envelope must not dwarf the value', () => {
    // The two methods exist because these two requirements genuinely conflict.
    // Collapsing them back into one would re-open the credential hole.
    const db = open('protected2', randomBytes(32));
    try {
      expect(db.encryptIfNeeded('a short line of prose')).toBe('a short line of prose');
      const long = 'x'.repeat(4096);
      expect(db.encryptIfNeeded(long)).not.toBe(long);
      expect(db.decryptIfNeeded(db.encryptIfNeeded(long))).toBe(long);
    } finally {
      db.close();
    }
  });

  it('is idempotent, so a second write does not double-wrap', () => {
    const db = open('protected3', randomBytes(32));
    try {
      const once = db.encryptSecret('token-value');
      expect(db.encryptSecret(once)).toBe(once);
      expect(db.encryptIfNeeded(once)).toBe(once);
    } finally {
      db.close();
    }
  });

  it('is the identity without a key, and says so rather than pretending', () => {
    const db = open('unprotected', null);
    try {
      expect(db.isProtected()).toBe(false);
      expect(db.encryptSecret('token-value')).toBe('token-value');
    } finally {
      db.close();
    }
  });

  it('refuses to read an encrypted column when the key is gone (NFR-07 spirit)', () => {
    // Losing the key must be a loud failure, not a silently empty value — the
    // same reasoning §8.4 applies to the MCP env column.
    const db = open('withkey', randomBytes(32));
    const sealed = db.encryptSecret('token-value');
    db.close();

    const reopened = open('withkey-noKey', null);
    try {
      expect(() => reopened.decryptIfNeeded(sealed)).toThrow();
    } finally {
      reopened.close();
    }
  });
});
