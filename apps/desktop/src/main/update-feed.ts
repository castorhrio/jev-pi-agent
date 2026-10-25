/**
 * The update feed: where a release is announced, and how the installer that
 * arrives is proved to be the one the feed named.
 *
 * ## Why this file exists
 *
 * The updater's own header calls the feed an RCE surface, and it was one.
 * The feed's `url` was fetched, the bytes were written to disk, and the file
 * was handed to the shell — with nothing in between. A feed that was tampered
 * with, or a download replaced in flight, became arbitrary code execution
 * behind one button. Two separate gaps let that happen, and both are about
 * *provenance* rather than about features:
 *
 *  1. **A released build had no feed at all.** `readUpdateFeed()` read one
 *     environment variable and nothing else. The update button in a published
 *     app could therefore only ever answer "未配置更新源" — the feature was
 *     unreachable for every user who had not hand-set an environment
 *     variable. A released build now carries its feed in a configuration file
 *     that ships with it, and the environment variable is the developer's
 *     override on top of that.
 *
 *  2. **Nothing proved the installer was the one the feed announced.** The
 *     feed may carry a `sha256`; when it does, the staged file is hashed
 *     before it is ever launched, and a mismatch means the file is deleted
 *     rather than run. When the feed carries no hash the download is refused
 *     outright: an updater that cannot check what it downloaded has no
 *     business installing it.
 *
 * The second point is a refusal, not a warning, on purpose. An installer that
 * cannot be verified is exactly the installer an attacker would send, so
 * "proceed anyway" is not a decision this program gets to make on the user's
 * behalf — the user is told what is missing and can fetch the release
 * themselves.
 *
 * Everything here is a pure function over strings and bytes, so the gates can
 * test it without a network, a disk full of installers, or an Electron.
 */

import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, statSync } from 'node:fs';

/**
 * The document a release publishes for the app to read.
 *
 * `sha256` and `size` are what turn "here is a file" into "here is *this*
 * file". A feed without them is still a valid announcement — the version
 * check reads it — but it cannot be installed, because there is nothing to
 * check the bytes against.
 */
export interface UpdateFeedDocument {
  /** dotted version, e.g. `1.1.0` */
  version?: string;
  /** release notes, shown to the user */
  notes?: string;
  /** https URL of the installer */
  url?: string;
  /** hex SHA-256 of the installer `url` points at */
  sha256?: string;
  /** size of the installer in bytes */
  size?: number;
}

/**
 * A SHA-256, or null when the value is not one.
 *
 * The comparison is case-insensitive and whitespace-tolerant because release
 * tooling writes digests in both cases, and a digest that differs only in
 * case is the same digest. Everything else — a truncated hash, a hash with a
 * prefix, an empty string — is not a hash, and a feed carrying one of those
 * has not said what the installer is.
 */
export function normalizeSha256(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(trimmed) ? trimmed : null;
}

/**
 * The feed URL inside a packaged configuration file, or null.
 *
 * The configuration file is not trusted input either: it is read from the
 * disk next to the app. A file that does not parse, is not an object, or
 * names a feed that is not https yields nothing, rather than a URL the
 * updater would later have to defend against.
 */
export function parseUpdateConfig(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const feedUrl = (parsed as { feedUrl?: unknown }).feedUrl;
  if (typeof feedUrl !== 'string') return null;
  const trimmed = feedUrl.trim();
  if (trimmed.length === 0) return null;

  try {
    const url = new URL(trimmed);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

type UpdateFeedSource = 'env' | 'config' | 'none';

export interface ResolvedUpdateFeed {
  /** the feed URL, or null when no feed is configured */
  url: string | null;
  /** where the URL came from — for the log line that says so */
  source: UpdateFeedSource;
}

/**
 * The feed URL, in order of precedence:
 *
 *  1. `envValue` — `UCAD_UPDATE_FEED`, the developer's override, for a
 *     private or self-hosted feed.
 *  2. the first configuration file that names one — the file that ships with
 *     a released build, so a published app can check for updates without the
 *     user setting an environment variable.
 *  3. nothing, and the updater says "未配置更新源" instead of pretending to
 *     check.
 */
export function resolveUpdateFeed(options: {
  envValue?: string | undefined;
  configPaths?: readonly string[];
}): ResolvedUpdateFeed {
  const fromEnv = options.envValue?.trim();
  if (fromEnv) return { url: fromEnv, source: 'env' };

  for (const configPath of options.configPaths ?? []) {
    let raw: string;
    try {
      raw = readFileSync(configPath, 'utf8');
    } catch {
      // A build without the file is a development build, not an error.
      continue;
    }
    const url = parseUpdateConfig(raw);
    if (url) return { url, source: 'config' };
  }

  return { url: null, source: 'none' };
}

export type InstallerVerification =
  | { ok: true; sha256: string; bytes: number }
  | {
      ok: false;
      reason: 'no-hash' | 'hash-mismatch' | 'size-mismatch' | 'unreadable';
      expected?: string;
      actual?: string;
      bytes?: number;
    };

/**
 * The SHA-256 of a file, streamed — a 100 MB installer is not read into
 * memory to be hashed.
 */
function sha256OfFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * Proves that a downloaded file is the one the feed named.
 *
 * A match and a mismatch are different outcomes and are returned as such.
 * A feed that carries no hash is neither a match nor a mismatch: it is
 * `no-hash`, meaning the installer was never checked — which is the one
 * state the caller must not confuse with "checked and fine".
 */
export async function verifyInstaller(
  filePath: string,
  expected: { sha256?: unknown; size?: unknown },
): Promise<InstallerVerification> {
  const expectedHash = normalizeSha256(expected.sha256);
  if (expectedHash === null) return { ok: false, reason: 'no-hash' };

  const expectedSize =
    typeof expected.size === 'number' && Number.isFinite(expected.size) && expected.size >= 0
      ? expected.size
      : null;

  let bytes: number;
  try {
    bytes = statSync(filePath).size;
  } catch {
    return { ok: false, reason: 'unreadable' };
  }

  let actual: string;
  try {
    actual = await sha256OfFile(filePath);
  } catch {
    return { ok: false, reason: 'unreadable' };
  }

  if (expectedSize !== null && expectedSize !== bytes) {
    return {
      ok: false,
      reason: 'size-mismatch',
      expected: String(expectedSize),
      actual: String(bytes),
      bytes,
    };
  }
  if (actual !== expectedHash) {
    return { ok: false, reason: 'hash-mismatch', expected: expectedHash, actual, bytes };
  }
  return { ok: true, sha256: actual, bytes };
}
