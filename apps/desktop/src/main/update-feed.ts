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
 * Why a configured feed URL is not usable.
 *
 * `invalid-url` and `not-https` are different values because they are
 * different fixes: a typo in a variable versus a channel somebody tried to
 * downgrade. One is a person to tell, the other is a decision to refuse.
 */
type FeedUrlRejection = 'invalid-url' | 'not-https';

/**
 * What a configured feed URL is, or why it cannot be used.
 *
 * `empty` is not a rejection: it means nothing was configured, which is a
 * development build rather than a mistake.
 */
export type FeedUrlCheck =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly reason: FeedUrlRejection | 'empty' };

/**
 * A feed URL the updater is willing to fetch, judged once for the whole
 * channel.
 *
 * Three things point at a feed and all three are held to this one rule: the
 * packaged configuration file, the `UCAD_UPDATE_FEED` override, and
 * `UpdateService` itself (which re-judged the URL it was handed, because a
 * caller can hand it anything). The override used to skip the rule entirely,
 * which made an environment variable the only way to point the updater at a
 * `http://` (or `file:`, or garbage) feed — the exact surface the
 * configuration file is not allowed to reach, reachable instead by whoever
 * can set a variable in the environment the app is launched from. Development
 * is not a reason to keep the hole: a private feed is a static JSON document
 * and can be served over https; what a developer gains from cleartext is a
 * shorter URL, and what they lose is the property that the bytes came from the
 * place they named.
 *
 * **One implementation, deliberately.** The service used to carry its own copy
 * of the protocol check. Two copies of one security rule drift — a scheme, a
 * normalisation, a whitespace rule added to one and not the other — and the
 * drift is invisible, because each copy passes the tests written for it.
 * `tests/contract/update-integrity.test.ts` asserts the three entry points
 * accept and refuse the same values, so a fourth copy would have to disagree
 * with this function on purpose to be red.
 */
export function checkFeedUrl(value: unknown): FeedUrlCheck {
  if (typeof value !== 'string') return { ok: false, reason: 'empty' };
  const trimmed = value.trim();
  if (trimmed.length === 0) return { ok: false, reason: 'empty' };

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, reason: 'invalid-url' };
  }
  // The whole channel is https-only, and this is the one place that decides it:
  // the feed, the installer URL the feed names, and every redirect hop the
  // download follows.
  if (url.protocol !== 'https:') return { ok: false, reason: 'not-https' };
  return { ok: true, url: url.toString() };
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

  const verdict = checkFeedUrl((parsed as { feedUrl?: unknown }).feedUrl);
  return verdict.ok ? verdict.url : null;
}

type UpdateFeedSource = 'env' | 'config' | 'none';

/** Why a configured feed was not used, when it was configured but refused. */
type UpdateFeedRejection = FeedUrlRejection;

export interface ResolvedUpdateFeed {
  /** the feed URL, or null when no feed is configured */
  url: string | null;
  /** where the URL came from — for the log line that says so */
  source: UpdateFeedSource;
  /**
   * Set when `source` names something that *was* configured but was refused.
   *
   * It exists so "nothing is configured" and "what you configured is not
   * usable" are not the same log line: the first is a development build, the
   * second is a typo or a downgrade attempt, and only one of them needs a
   * person.
   */
  rejected?: UpdateFeedRejection;
}

/**
 * The feed URL, in order of precedence:
 *
 *  1. `envValue` — `UCAD_UPDATE_FEED`, the developer's override, for a
 *     private or self-hosted feed. It is held to the same https rule as the
 *     configuration file.
 *  2. the first configuration file that names one — the file that ships with
 *     a released build, so a published app can check for updates without the
 *     user setting an environment variable.
 *  3. nothing, and the updater says "未配置更新源" instead of pretending to
 *     check.
 *
 * An override that is set but not usable stops here (`rejected`, with the
 * reason `checkFeedUrl()` gave) instead of falling through to the packaged
 * file. Falling through would mean a typo in the variable silently reinstalls
 * from the public feed the operator was trying to leave, which is the opposite
 * of what an override is for. A blank variable is not an override at all — it
 * is the shape a shell script leaves behind — so it falls through like an
 * unset one.
 */
export function resolveUpdateFeed(options: {
  envValue?: string | undefined;
  configPaths?: readonly string[];
}): ResolvedUpdateFeed {
  const fromEnv = checkFeedUrl(options.envValue);
  if (fromEnv.ok) return { url: fromEnv.url, source: 'env' };
  // `empty` means nothing was configured; anything else means something was
  // configured and refused. Only the second kind stops the search.
  if (fromEnv.reason !== 'empty') {
    return { url: null, source: 'env', rejected: fromEnv.reason };
  }

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
