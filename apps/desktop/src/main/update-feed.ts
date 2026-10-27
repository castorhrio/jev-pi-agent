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
import {
  closeSync,
  constants,
  createReadStream,
  fstatSync,
  openSync,
  readFileSync,
  statSync,
  type Stats,
} from 'node:fs';

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
 * Why a URL cannot be part of the update channel.
 *
 * `invalid-url` and `not-https` are different values because they are
 * different fixes: a typo in a variable versus a channel somebody tried to
 * downgrade. One is a person to tell, the other is a decision to refuse.
 *
 * **The array is the fact; the type is derived from it.** The reasons used to
 * be a union here, a `Record` in `update-feed-log.ts`, and a hand-written
 * `as const` list in every test that could not enumerate a type — three
 * spellings of one vocabulary, related to each other as subsets. Adding a
 * reason meant remembering all of them, and forgetting a list was invisible:
 * the compiler only checks the direction that has a `Record`, and a test that
 * spells the reasons out by hand keeps passing when a member is added beside
 * it.
 *
 * As an array the direction reverses. A new reason is one line here, and
 * everything keyed by `ChannelUrlRejection` — the log sentence table, the
 * Settings message table — fails `npm run typecheck` until it has an entry.
 * The gates import this array instead of writing the reasons out again, so a
 * list that disagrees with the type is no longer a thing that can be written.
 */
export const CHANNEL_URL_REJECTIONS = ['invalid-url', 'not-https'] as const;

/** One of {@link CHANNEL_URL_REJECTIONS} — the union the tables are keyed by. */
export type ChannelUrlRejection = (typeof CHANNEL_URL_REJECTIONS)[number];

/**
 * Whether a parsed URL is on the one protocol the update channel allows.
 *
 * This is the single place the channel writes the scheme down. Everything else
 * asks it: `checkChannelUrl()` below, the installer URL `UpdateService`
 * downloads, and every redirect hop that download follows. A second copy of
 * this comparison is a second rule waiting to disagree with this one, and
 * `tests/contract/update-integrity.test.ts` fails, naming file and line, when
 * one appears in the channel's two sources.
 */
export function isUpdateChannelScheme(protocol: string): boolean {
  return protocol === 'https:';
}

/** What a URL on the update channel is, or why it cannot be used. */
export type ChannelUrlCheck =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly reason: ChannelUrlRejection };

/**
 * The one rule every URL on the update channel is held to: it parses, and it
 * is https.
 *
 * Three different inputs are URLs on this channel, and each of them used to
 * carry its own copy of the rule:
 *
 *  - the feed address, reachable three ways — the packaged
 *    `update-config.json`, the `UCAD_UPDATE_FEED` override, and whatever
 *    `getFeedUrl()` hands `UpdateService` (`checkFeedUrl()`, below);
 *  - the installer URL the feed names, which `UpdateService.download()`
 *    re-judged inline;
 *  - every redirect hop the download follows, which
 *    `resolveDownloadRedirect()` re-judged inline.
 *
 * Copies of a security rule drift quietly — a scheme, a normalisation, a
 * whitespace rule added to one and not the other — and the drift is invisible,
 * because each copy passes the tests written for it. All three ask this
 * function now, and `tests/contract/update-integrity.test.ts` holds both
 * halves of that: it asks every entry point the same values, and it scans the
 * channel's two sources for a scheme comparison written out a second time.
 *
 * `value` is `unknown` because every caller is holding untrusted input: a JSON
 * field from a feed, a header from a redirect, an environment variable. A
 * value that is not a non-blank string is `invalid-url` — the same answer as a
 * string that does not parse, because the caller's next move is the same.
 */
export function checkChannelUrl(value: unknown): ChannelUrlCheck {
  if (typeof value !== 'string') return { ok: false, reason: 'invalid-url' };
  const trimmed = value.trim();
  if (trimmed.length === 0) return { ok: false, reason: 'invalid-url' };

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, reason: 'invalid-url' };
  }
  // The whole channel is https-only, and this is the one place that decides
  // it: the feed, the installer URL the feed names, and every redirect hop the
  // download follows.
  if (!isUpdateChannelScheme(url.protocol)) return { ok: false, reason: 'not-https' };
  return { ok: true, url: url.toString() };
}

/**
 * What a configured feed URL is, or why it cannot be used.
 *
 * `empty` is not a rejection: it means nothing was configured, which is a
 * development build rather than a mistake.
 */
export type FeedUrlCheck =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly reason: ChannelUrlRejection | 'empty' };

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
 * of the protocol check, and so did the download's redirect handling. Two
 * copies of one security rule drift — a scheme, a normalisation, a whitespace
 * rule added to one and not the other — and the drift is invisible, because
 * each copy passes the tests written for it. The rule now lives in
 * `checkChannelUrl()` / `isUpdateChannelScheme()`, and this function adds only
 * the distinction a *feed* needs: nothing configured (`empty`) is a development
 * build, while nothing usable is a refusal. `tests/contract/update-integrity.test.ts`
 * asserts the entry points accept and refuse the same values, so a further copy
 * would have to disagree with this file on purpose to be red.
 */
export function checkFeedUrl(value: unknown): FeedUrlCheck {
  if (typeof value !== 'string') return { ok: false, reason: 'empty' };
  // A blank variable is the shape a shell script leaves behind, not a URL
  // somebody chose — see `resolveUpdateFeed()` for why it falls through.
  if (value.trim().length === 0) return { ok: false, reason: 'empty' };
  return checkChannelUrl(value);
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
type UpdateFeedRejection = ChannelUrlRejection;

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
 *
 * A configuration file that cannot be used — absent, unparseable, or naming a
 * non-https feed — is *skipped*, and the next candidate is tried. That is the
 * opposite of the override, on purpose: the override is one decision a person
 * made, while the candidates are the places a build may have installed its
 * feed, and one bad copy must not hide the good one beside it. A skipped file
 * is not reported as `rejected` either: that field names a configured override
 * that was refused, and a packaging defect belongs to the build, not to a log
 * line about somebody's variable.
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
 * The size a feed published, or null when it published something that is not
 * one.
 *
 * A feed that carries `size: "91234567"` (a string, which JSON release tooling
 * writes more often than one would like) has said nothing about the file: the
 * comparison is against a number, and comparing against a coerced one would
 * turn a documentation bug into a failed install.
 */
function expectedSizeOf(size: unknown): number | null {
  return typeof size === 'number' && Number.isFinite(size) && size >= 0 ? size : null;
}

/**
 * Proves that a downloaded file is the one the feed named.
 *
 * A match and a mismatch are different outcomes and are returned as such.
 * A feed that carries no hash is neither a match nor a mismatch: it is
 * `no-hash`, meaning the installer was never checked — which is the one
 * state the caller must not confuse with "checked and fine".
 *
 * **The size is checked before the hash, and the difference is observable.**
 * The feed's `size` is answered from one `stat`; the hash costs a streamed
 * read of the whole file. Doing the hash first would mean a truncated
 * download — the common failure, because it is what a dropped connection
 * leaves behind — is read end to end before it is refused, so the answer
 * arrives seconds later and says nothing the size already said. The order is
 * therefore a contract, not an implementation detail: `size-mismatch` is
 * reachable *without reading the file at all*, and
 * `tests/contract/update-integrity.test.ts` pins it with a path whose read
 * fails, so the two answers can only come out in this order.
 *
 * The hash is still what decides "is this the file": the size can only say
 * "this is not", which is why a size the feed did not publish (`null`) skips
 * that branch rather than skipping the verification.
 */
export async function verifyInstaller(
  filePath: string,
  expected: { sha256?: unknown; size?: unknown },
): Promise<InstallerVerification> {
  const expectedHash = normalizeSha256(expected.sha256);
  if (expectedHash === null) return { ok: false, reason: 'no-hash' };

  const expectedSize = expectedSizeOf(expected.size);

  let bytes: number;
  try {
    bytes = statSync(filePath).size;
  } catch {
    return { ok: false, reason: 'unreadable' };
  }

  // Before the hash, deliberately (see the doc comment): a file the size
  // already says is not the one is refused without being read.
  if (expectedSize !== null && expectedSize !== bytes) {
    return {
      ok: false,
      reason: 'size-mismatch',
      expected: String(expectedSize),
      actual: String(bytes),
      bytes,
    };
  }

  let actual: string;
  try {
    actual = await sha256OfFile(filePath);
  } catch {
    return { ok: false, reason: 'unreadable' };
  }

  if (actual !== expectedHash) {
    return { ok: false, reason: 'hash-mismatch', expected: expectedHash, actual, bytes };
  }
  return { ok: true, sha256: actual, bytes };
}

/**
 * The identity of a file object, as `stat` reports it.
 *
 * It exists to answer one question: *is this still the file that was hashed?*
 * A digest is a fact about bytes that were read at one moment; the staged
 * installer is a *path*, and the launch is a later moment that the OS resolves
 * again. Between the two, the path can come to point at a different file — and
 * hashing again does not close that window, it only moves it.
 *
 * `dev` + `ino` change when the path is made to name a different file
 * (`rename` over it is what a substitution actually looks like, and it does
 * so even when the new bytes are the same length, which is the case a size
 * check cannot see). `size` + `mtimeMs` are the belt for an in-place rewrite,
 * which keeps the inode.
 *
 * **What this does not promise** is worth writing down rather than implying:
 * an in-place rewrite that keeps the inode, the length *and* the timestamp is
 * the same file as far as any `stat` can tell. That residual window is one
 * syscall wide. Re-hashing the installer immediately before the launch would
 * not close it either — it would make the window "hash → launch" instead of
 * "hash → stat", and for a 100 MB installer it would add seconds to a button
 * the user already waited on. The claim this type makes is therefore precise:
 * *the file about to be launched is the file object that was hashed*, which
 * is the strongest statement a path-based launch allows.
 *
 * `tests/contract/update-integrity.test.ts` keeps this paragraph present, so a
 * later edit cannot quietly turn the admission into a claim of completeness.
 */
export interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
}

/** The `FileIdentity` of a `stat` result — from a path or from a descriptor. */
export function fileIdentity(stats: Stats): FileIdentity {
  // `Number(...)` because the bigint stats form returns `bigint` for these
  // fields; the values still compare exactly for anything a user's disk holds.
  return {
    dev: Number(stats.dev),
    ino: Number(stats.ino),
    size: Number(stats.size),
    mtimeMs: stats.mtimeMs,
  };
}

/** Whether two identity readings describe the same file in the same state. */
function sameFileIdentity(a: FileIdentity, b: FileIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

/** What a second look at a verified file says. */
export type StagedFileCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'replaced' | 'unreadable' };

/**
 * Whether the file at `filePath` is still the one `identity` was read from.
 *
 * Asking the path, not the descriptor, is the point: the launch is going to
 * resolve the path, so the question that matters is what the path resolves to
 * *now*. A file that is gone is `unreadable` rather than `replaced` because the
 * two need different words in the UI ("download it again" either way, but one
 * of them means somebody deleted it).
 */
export function checkStagedFileUnchanged(
  filePath: string,
  identity: FileIdentity,
): StagedFileCheck {
  let now: FileIdentity;
  try {
    now = fileIdentity(statSync(filePath));
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
  return sameFileIdentity(identity, now) ? { ok: true } : { ok: false, reason: 'replaced' };
}

/**
 * The SHA-256 of an open file, read through its descriptor.
 *
 * The descriptor is the reason this exists next to `sha256OfFile`: a stream
 * opened on the *file object* cannot be redirected to another file while it is
 * being read, so the digest describes one file rather than whatever the path
 * happened to resolve to between two chunks. `autoClose: false` because the
 * caller owns the descriptor and closes it once — the identity it read before
 * hashing and the digest it read after belong to the same open file.
 */
function sha256OfDescriptor(fd: number, filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath, { fd, autoClose: false });
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * `verifyInstaller()`, plus the identity of the file object it hashed.
 *
 * The updater launches by path, so verification has to end with something the
 * launch can be compared against, and a digest is not that thing: it says the
 * bytes were the right bytes, not that the file about to run is the file they
 * came from. The identity is captured from the *open descriptor* before the
 * first chunk is read and handed back with the digest, so
 * `checkStagedFileUnchanged()` can ask the path one question afterwards: is
 * this still that file?
 *
 * Same four refusals as `verifyInstaller()`, in the same words and in the same
 * order, because the caller's message to the user is the same for both. The
 * difference is what a success carries.
 *
 * The order matters here for the same reason it does there: the size comes
 * from the descriptor's own `fstat`, so a truncated download is refused
 * before the stream is read. Keeping one order in both verifiers is also what
 * lets the shared-refusal gate compare them field for field — a verifier that
 * answered `unreadable` where the other answered `size-mismatch` would be a
 * second copy of the rule that had drifted.
 */
export async function verifyStagedInstallerForLaunch(
  filePath: string,
  expected: { sha256?: unknown; size?: unknown },
): Promise<StagedInstallerVerification> {
  const opened = await openStagedInstallerForLaunch(filePath, expected);
  if (!opened.ok) return opened;
  try {
    return {
      ok: true,
      sha256: opened.handle.sha256,
      bytes: opened.handle.bytes,
      identity: opened.handle.identity,
    };
  } finally {
    closeStagedInstaller(opened.handle);
  }
}

/** A verified installer whose descriptor is still open. */
export interface StagedInstallerHandle {
  readonly fd: number;
  readonly identity: FileIdentity;
  readonly sha256: string;
  readonly bytes: number;
}

/** What opening a staged installer for launch answers. */
export type OpenedStagedInstaller =
  | { readonly ok: true; readonly handle: StagedInstallerHandle }
  | Extract<InstallerVerification, { ok: false }>;

/** Closes a descriptor without letting a close failure become a refusal. */
function closeDescriptor(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    /* a descriptor we cannot close is a leak, not a refusal */
  }
}

/** The flags a staged installer is opened with. */
function stagedInstallerFlags(): number {
  // `O_NOFOLLOW` is POSIX-only; on Windows the constant is absent and the
  // fallback leaves the plain read open. The staged name is a constant under
  // the user's download directory either way, and a symlink there is a
  // substitution, not an installer.
  return constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
}

/**
 * `verifyStagedInstallerForLaunch()`, leaving the descriptor open.
 *
 * The caller owns the handle and must close it with `closeStagedInstaller()`.
 * That is deliberate: the launch path needs the same file object to stay open
 * across the `beforeLaunch` seam, so the identity it checked cannot be
 * replaced by a re-open of the path in between. `verifyStagedInstallerForLaunch()`
 * is the closed wrapper for callers that only need the answer.
 */
export async function openStagedInstallerForLaunch(
  filePath: string,
  expected: { sha256?: unknown; size?: unknown },
): Promise<OpenedStagedInstaller> {
  const expectedHash = normalizeSha256(expected.sha256);
  if (expectedHash === null) return { ok: false, reason: 'no-hash' };
  const expectedSize = expectedSizeOf(expected.size);

  let fd: number;
  try {
    // One `open`, and it answers "is it there", "can it be read" and "is it
    // a symlink" at once. The descriptor is held on success.
    fd = openSync(filePath, stagedInstallerFlags());
  } catch {
    return { ok: false, reason: 'unreadable' };
  }

  let keepOpen = false;
  try {
    // Before the read, not after: the identity has to describe the file the
    // digest is about to be taken from, so anything that changes later — a
    // rename over the path, an in-place rewrite that moves the size — is a
    // difference from *this* reading rather than a new baseline.
    let identity: FileIdentity;
    try {
      identity = fileIdentity(fstatSync(fd));
    } catch {
      return { ok: false, reason: 'unreadable' };
    }

    // The descriptor's size is already in hand, so the same contract as
    // `verifyInstaller()` costs nothing to keep: a size the feed disagrees
    // with is refused before the stream is read.
    const bytes = identity.size;
    if (expectedSize !== null && expectedSize !== bytes) {
      return {
        ok: false,
        reason: 'size-mismatch',
        expected: String(expectedSize),
        actual: String(bytes),
        bytes,
      };
    }

    let actual: string;
    try {
      actual = await sha256OfDescriptor(fd, filePath);
    } catch {
      return { ok: false, reason: 'unreadable' };
    }

    if (actual !== expectedHash) {
      return { ok: false, reason: 'hash-mismatch', expected: expectedHash, actual, bytes };
    }
    keepOpen = true;
    return { ok: true, handle: { fd, identity, sha256: actual, bytes } };
  } finally {
    if (!keepOpen) closeDescriptor(fd);
  }
}

/** Closes the descriptor behind a handle from `openStagedInstallerForLaunch()`. */
export function closeStagedInstaller(handle: StagedInstallerHandle): void {
  closeDescriptor(handle.fd);
}

/**
 * Whether the file about to launch is still the file the open handle verified.
 *
 * Two questions, because one descriptor cannot answer both:
 *
 *  - `fstat(handle.fd)` says whether the *verified file object* changed while
 *    it was held open. An in-place rewrite through the same path keeps the
 *    inode and is invisible to a path comparison that only looks at `ino`; the
 *    descriptor's size and mtime see it.
 *  - `checkStagedFileUnchanged()` asks the *path* what the launch will resolve.
 *    A rename over the staged name leaves the descriptor pointing at the old,
 *    untouched file, so the descriptor alone would say "fine" while `openPath`
 *    ran the substitute. Only a fresh resolution of the path can see that.
 *
 * The residual window is the gap between this check and the OS resolving the
 * same path inside the launcher: a path-based launch cannot be made atomic
 * with a path check. What this closes is every change that can happen during
 * `beforeLaunch`, which is the window the test seam exists to open.
 *
 * What the check cannot close is pinned rather than described:
 * `tests/contract/update-integrity.test.ts` substitutes the file inside the
 * launcher — after this function has answered `{ ok: true }` — and asserts the
 * launch proceeds. A change that made the launch atomic with this answer would
 * turn that test red, which is the moment this paragraph stops being true.
 */
export function checkOpenStagedInstaller(
  filePath: string,
  handle: StagedInstallerHandle,
): StagedFileCheck {
  let now: FileIdentity;
  try {
    now = fileIdentity(fstatSync(handle.fd));
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
  if (!sameFileIdentity(handle.identity, now)) {
    return { ok: false, reason: 'replaced' };
  }
  return checkStagedFileUnchanged(filePath, handle.identity);
}

/**
 * What `verifyStagedInstallerForLaunch()` answers: the same refusals as
 * `verifyInstaller()`, and a success that carries the file's identity.
 *
 * Derived from `InstallerVerification` rather than written out again, so a new
 * refusal reason cannot appear on one of them and not the other — the two
 * functions differ in what a *success* carries, not in what a refusal says.
 */
export type StagedInstallerVerification =
  | (Extract<InstallerVerification, { ok: true }> & { readonly identity: FileIdentity })
  | Extract<InstallerVerification, { ok: false }>;
