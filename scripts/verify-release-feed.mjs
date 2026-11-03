/**
 * The published feed, judged against the rules the app enforces — as a command.
 *
 * ## Why this file exists
 *
 * The README promises, in both languages, that an installer must carry a
 * `sha256` and that nothing is installed without one. `update-feed.ts` enforces
 * exactly that, and `tests/contract/update-integrity.test.ts` pins it. Every one
 * of those statements is about *the code*. None of them is about the document
 * that is actually published, and the document is the thing a user's app reads.
 *
 * The gap is not theoretical. The feed on the v1.0.0 release carries `version`,
 * `notes` and `url` and nothing else: no `sha256`, no `size`. The app's version
 * check reads it happily and answers "已是最新版本", so the defect is invisible
 * for as long as the published version is the installed version. The day a newer
 * release is published, every user's update check says "发现新版本", the download
 * runs, and `verifyInstaller()` refuses it with `no-hash` — the update channel
 * is broken for everyone, and it breaks at the one moment nobody is looking at
 * the feed. The same document also points at
 * `releases/latest/download/UCAD-Setup-1.0.0.exe`, which is the trap
 * `make-update-feed.mjs` was written to avoid: `latest` resolves to the newest
 * release, so the moment 1.1.0 exists that URL 404s.
 *
 * So the check is a command over the published bytes, not a sentence in a
 * document. It fetches the feed the shipped `update-config.json` names, judges
 * it with the app's own rules, and asks the release host for the installer's
 * length so "the feed describes a file that is there" is measured rather than
 * assumed.
 *
 * ## Why it imports the app's rules instead of restating them
 *
 * A second copy of "https only" and "64 hex characters" is a second rule waiting
 * to disagree with the first, and the disagreement is invisible because each
 * copy passes the tests written for it. `checkChannelUrl()` and
 * `normalizeSha256()` are therefore imported from the built main process
 * (`apps/desktop/dist/main/update-feed.js`), which is the same code the app
 * runs. The precondition is the same one `verify-packaged-adapters.mjs` has:
 * build first. The judgement functions take those rules as a parameter, so
 * `tests/contract/release-feed.test.ts` can drive them with the TypeScript
 * sources and prove the judgement without a build or a network.
 *
 * ## What it cannot see
 *
 * It does not download the installer, so it cannot prove the published `sha256`
 * is the hash of the published file — that is a 120 MB read, and the honest
 * place for it is the release step that computes the hash in the first place
 * (`make-update-feed.mjs`). What it does prove is that the feed *carries* a
 * hash, that the hash is a hash, that the size the feed publishes matches the
 * size the host serves, and that the URL names this release rather than
 * `latest`. Those are the four ways a feed is wrong while looking fine.
 *
 * ## Why it can judge a file on disk, and not only a URL
 *
 * The document a release publishes is written by another command,
 * `make-update-feed.mjs`, and that command already runs this judgement before
 * it writes. What it did not offer was a way to ask *this* command about the
 * same bytes: "the writer said yes" and "the published feed is fine" were two
 * statements made by two processes that never met, and the only run that
 * compared them needed a network, a published release, and a human to look at
 * two outputs.
 *
 * `--feed-file <path>` closes that: it judges the document on disk, through the
 * same `judgeFeedDocument()` / `judgeInstallerHead()` path, so the document half
 * of a release can be proved before anything is uploaded — on a machine with no
 * network, in CI, as part of the gate. The address rule does not apply (a file
 * has no address) and the run says so instead of quietly skipping it; the
 * installer check still runs unless `--no-installer` says otherwise.
 *
 * ## Why "not run" is printed
 *
 * `--no-installer` and `--feed-file` both leave something unchecked, and a
 * verdict that looks identical whether or not a check ran is the failure mode
 * this repository keeps closing: `PASS` would mean "the feed is fine" and
 * "half of it was never fetched" in the same words. So every check that did not
 * run is printed as `[skipped]`, and the summary line says how many there were.
 * A reader can still get a green run without a network; they cannot get one
 * without being told what it does not cover.
 *
 * ## Why a host that does not answer is not a verdict
 *
 * Every finding above is a statement about the document. A fetch that times out
 * is not: nothing was read, so nothing was judged. The command used to report
 * both with the same code — `feed-unreachable`, whose sentence is "the feed
 * could not be fetched, so every update check fails" — and the detail was
 * whatever the runtime said, which for a timeout is `This operation was
 * aborted`. On a machine whose route to the release host is blocked, that reads
 * as "the published feed is broken", and the operator's next move is to
 * re-upload a feed that was fine.
 *
 * This is the same misdiagnosis the unknown-option refusal above names ("reports
 * a host problem as a feed problem"), and it is the expensive direction to get
 * wrong. So a timeout is its own finding (`feed-timeout` / `installer-timeout`),
 * its sentence says the check did not complete, its detail carries the window
 * and the URL, and the summary line says `INCOMPLETE` rather than `FAIL`. The
 * exit code is still 1: a run that could not look must not be mistaken for a
 * green one. What changes is what the reader does next — retry the fetch, or fix
 * the feed.
 *
 * ## Usage
 *
 * ```bash
 * npm run build:main -w @ucad/desktop
 * node scripts/verify-release-feed.mjs
 * node scripts/verify-release-feed.mjs --feed-file release/update-feed.json
 * ```
 *
 * Optional flags: `--feed <url>` (judge this feed instead of the shipped one),
 * `--feed-file <path>` (judge a document on disk — the bytes about to be
 * uploaded; exclusive with `--feed`), `--expect-version <v>` (default:
 * `package.json`'s version), `--timeout <ms>` (default 20000), `--no-installer`
 * (skip the network check of the installer URL), `--json` (print the findings
 * as JSON).
 *
 * An option this command does not know is an error, not a default: a typo in
 * `--feed-file` used to fall through to fetching the shipped feed, which is the
 * wrong document judged with the right machinery — green or red for reasons the
 * operator did not ask about.
 *
 * Exit code 0 when nothing failed; 1 when a finding is a failure, or when the
 * arguments name no document this command can judge. Warnings (`no-size`) are
 * printed and do not fail the run: the app installs a feed without a size, it
 * just loses the cheap truncation check. A run whose summary says `INCOMPLETE`
 * also exits 1 — the host did not answer, so there is no verdict to report.
 */

import { readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

/**
 * Every way a published feed can be wrong, as one list.
 *
 * The array is the fact and the two tables below are keyed by it, so a code
 * added here fails `npm run typecheck`-adjacent gates (the contract test walks
 * the array and demands a severity and a sentence for each) until it has both.
 * The alternative — a code that exists only where it is pushed — is how a
 * finding ends up printed as `undefined`.
 */
export const FEED_FINDINGS = [
  'feed-invalid-url',
  'feed-not-https',
  'feed-unreachable',
  'feed-timeout',
  'feed-unreadable',
  'feed-not-json',
  'not-an-object',
  'no-version',
  'version-mismatch',
  'no-sha256',
  'bad-sha256',
  'no-size',
  'bad-size',
  'no-url',
  'installer-not-https',
  'installer-latest-url',
  'installer-not-this-release',
  'installer-name-mismatch',
  'installer-unreachable',
  'installer-timeout',
  'installer-size-mismatch',
];

/**
 * How much each finding matters.
 *
 * `warn` is reserved for the one thing the app tolerates: a feed without a
 * `size` still installs, it just cannot refuse a truncated download before
 * reading it. Everything else is a failure, because everything else is a feed
 * the app will refuse or a URL that will stop resolving.
 */
export const FEED_FINDING_SEVERITY = {
  'feed-invalid-url': 'fail',
  'feed-not-https': 'fail',
  'feed-unreachable': 'fail',
  'feed-timeout': 'fail',
  'feed-unreadable': 'fail',
  'feed-not-json': 'fail',
  'not-an-object': 'fail',
  'no-version': 'fail',
  'version-mismatch': 'fail',
  'no-sha256': 'fail',
  'bad-sha256': 'fail',
  'no-size': 'warn',
  'bad-size': 'fail',
  'no-url': 'fail',
  'installer-not-https': 'fail',
  'installer-latest-url': 'fail',
  'installer-not-this-release': 'fail',
  'installer-name-mismatch': 'fail',
  'installer-unreachable': 'fail',
  'installer-timeout': 'fail',
  'installer-size-mismatch': 'fail',
};

/**
 * What each finding means, in the words of the fix.
 *
 * A finding that only says "invalid" sends the reader back to the code. These
 * name the consequence — what the app does with this feed — because that is
 * what decides whether it is worth fixing before the release or after.
 */
export const FEED_FINDING_MESSAGE = {
  'feed-invalid-url': 'the feed address is not a URL, so the app reports 未配置更新源',
  'feed-not-https': 'the feed address is not https, so the app refuses it and logs the refusal',
  'feed-unreachable': 'the feed could not be fetched, so every update check fails',
  'feed-timeout':
    'the feed host did not answer in time, so nothing about the document was judged — a host result, not a verdict on the feed',
  'feed-unreadable': 'the document named on the command line could not be read, so nothing was judged',
  'feed-not-json': 'the feed is not JSON, so the app reports a failed check',
  'not-an-object': 'the feed is not a JSON object, so the app has no fields to read',
  'no-version': 'the feed names no version, so the app cannot tell whether it is newer',
  'version-mismatch': 'the feed announces a different version than this build',
  'no-sha256': 'the feed publishes no sha256, so the app refuses to install what it downloads',
  'bad-sha256': 'the feed publishes something that is not a SHA-256, so the app refuses to install',
  'no-size': 'the feed publishes no size, so a truncated download is only caught after hashing',
  'bad-size': 'the feed publishes a size that is not a byte count, so the app ignores it',
  'no-url': 'the feed names no installer URL, so there is nothing to download',
  'installer-not-https': 'the installer URL is not https, so the app refuses the download',
  'installer-latest-url': 'the installer URL uses releases/latest, which 404s once a newer release exists',
  'installer-not-this-release': 'the installer URL does not name this version’s release',
  'installer-name-mismatch': 'the installer file name does not carry this version',
  'installer-unreachable': 'the installer URL does not resolve, so the download fails',
  'installer-timeout':
    'the installer host did not answer in time, so "the file is there, at that size" was not proven',
  'installer-size-mismatch': 'the size the feed publishes is not the size the host serves',
};

/** The installer file name a release of `version` publishes. */
export function installerNameFor(version) {
  return `UCAD-Setup-${version}.exe`;
}

/**
 * The app's rules, as this script needs them.
 *
 * Passed in rather than imported at the top of the judgement functions so the
 * contract test can hand over the TypeScript sources and the command can hand
 * over the built ones — one implementation, two callers, no third copy.
 */
function requireRules(rules) {
  for (const name of ['checkChannelUrl', 'normalizeSha256']) {
    if (typeof rules?.[name] !== 'function') {
      throw new Error(
        `the feed judgement needs the app's \`${name}\`; pass loadAppRules() or the source functions`,
      );
    }
  }
  return rules;
}

/** A finding, with the value that produced it. */
function finding(code, detail) {
  return { code, detail: String(detail) };
}

/**
 * Whether the feed *address* is one the app will fetch.
 *
 * Separate from the document judgement because it is a different question with
 * a different fix: a feed that is not https never gets read, so nothing about
 * its contents matters yet.
 */
export function judgeFeedAddress(value, rules) {
  const { checkChannelUrl } = requireRules(rules);
  const verdict = checkChannelUrl(value);
  if (verdict.ok) return [];
  return [
    finding(
      verdict.reason === 'not-https' ? 'feed-not-https' : 'feed-invalid-url',
      value ?? '(nothing configured)',
    ),
  ];
}

/**
 * Whether the feed *document* is one the app can install from.
 *
 * The order of the checks is the order a reader would fix them: is there a
 * version, is it this version, is there a hash, is the hash a hash, is there a
 * size, does the URL name this release. Each finding is independent — a feed
 * with no hash and a `latest` URL reports both, because fixing one and
 * republishing would otherwise look like a clean run.
 */
export function judgeFeedDocument(document, options = {}) {
  const { checkChannelUrl, normalizeSha256 } = requireRules(options.rules);
  const expectedVersion =
    typeof options.expectedVersion === 'string' ? options.expectedVersion.trim() : '';
  const findings = [];

  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    findings.push(finding('not-an-object', Array.isArray(document) ? 'array' : typeof document));
    return findings;
  }

  const version = typeof document.version === 'string' ? document.version.trim() : '';
  if (version.length === 0) {
    findings.push(finding('no-version', JSON.stringify(document.version ?? null)));
  } else if (expectedVersion.length > 0 && version !== expectedVersion) {
    findings.push(finding('version-mismatch', `feed says ${version}, this build is ${expectedVersion}`));
  }

  const hash = normalizeSha256(document.sha256);
  if (hash === null) {
    const published = typeof document.sha256 === 'string' && document.sha256.trim().length > 0;
    findings.push(finding(published ? 'bad-sha256' : 'no-sha256', JSON.stringify(document.sha256 ?? null)));
  }

  if (document.size === undefined || document.size === null) {
    findings.push(finding('no-size', 'absent'));
  } else if (
    typeof document.size !== 'number' ||
    !Number.isFinite(document.size) ||
    document.size <= 0
  ) {
    findings.push(finding('bad-size', JSON.stringify(document.size)));
  }

  const installer = checkChannelUrl(document.url);
  if (!installer.ok) {
    findings.push(
      finding(
        installer.reason === 'not-https' ? 'installer-not-https' : 'no-url',
        document.url ?? '(absent)',
      ),
    );
    return findings;
  }

  const path = new URL(installer.url).pathname;
  // `latest` is checked first and the release-tag check is skipped when it
  // fires: both are true of a `latest` URL, and reporting the same mistake
  // twice makes the list look longer than the problem.
  if (/\/releases\/latest\//.test(path)) {
    findings.push(finding('installer-latest-url', installer.url));
  } else if (version.length > 0 && !path.includes(`/download/v${version}/`)) {
    findings.push(finding('installer-not-this-release', installer.url));
  }

  if (version.length > 0 && basename(path) !== installerNameFor(version)) {
    findings.push(
      finding('installer-name-mismatch', `${basename(path)} (expected ${installerNameFor(version)})`),
    );
  }

  return findings;
}

/**
 * Whether the installer the feed names is actually served, at the size it says.
 *
 * `head` is `{ status, contentLength }` from a HEAD request that followed
 * redirects — GitHub answers the release URL with a 302 to a signed asset host,
 * so a check that stopped at the first response would report every feed as
 * unreachable.
 *
 * The size comparison is the cheap half of "is this the file": the hash cannot
 * be checked without downloading 120 MB, but a host that serves a different
 * length than the feed published has already proved the feed is stale.
 */
export function judgeInstallerHead(head, document) {
  const findings = [];
  const status = typeof head?.status === 'number' ? head.status : 0;
  if (status !== 200) {
    findings.push(finding('installer-unreachable', `HTTP ${status || 'no answer'}`));
    return findings;
  }

  const published = typeof document?.size === 'number' ? document.size : null;
  const served = typeof head.contentLength === 'number' ? head.contentLength : null;
  if (published !== null && served !== null && published !== served) {
    findings.push(finding('installer-size-mismatch', `feed says ${published}, the host serves ${served}`));
  }
  return findings;
}

/** Whether a finding list contains anything that fails the run. */
export function hasFailure(findings) {
  return findings.some((entry) => FEED_FINDING_SEVERITY[entry.code] === 'fail');
}

/**
 * The findings that mean "the host did not answer", not "the feed is wrong".
 *
 * These are failures — a run that could not look at the document must not exit
 * 0 — but they are a different kind of failure, and the summary says so in a
 * different word (`INCOMPLETE`). See the header's "why a host that does not
 * answer is not a verdict".
 */
export const TIMEOUT_FINDINGS = ['feed-timeout', 'installer-timeout'];

/** Whether a fetch error is the timeout this command imposed, not the host's answer. */
export function isTimeoutError(error) {
  const name = error && typeof error === 'object' ? error.name : undefined;
  // `AbortController.abort()` surfaces as `AbortError`; `AbortSignal.timeout()`
  // as `TimeoutError`. Both mean the same thing here: no answer in the window.
  return name === 'AbortError' || name === 'TimeoutError';
}

/**
 * What a failed fetch means, as a finding.
 *
 * The distinction this function exists for: a host that never answers and a
 * feed that is wrong used to produce the same code (`feed-unreachable`), so a
 * blocked network read as "the published feed is broken, every update check
 * fails". That is the misdiagnosis this repository keeps closing elsewhere —
 * `verify-release-feed.mjs`'s own unknown-option refusal names it ("reports a
 * host problem as a feed problem") — and it is the expensive direction to get
 * wrong: it sends the operator to re-upload a feed that was fine.
 *
 * `kind` is `'feed'` or `'installer'`, because the two fetches answer different
 * questions and the fix for each is in a different place.
 */
export function judgeFetchFailure(error, { url, timeoutMs, kind }) {
  const timedOut = isTimeoutError(error);
  const code = timedOut
    ? kind === 'installer'
      ? 'installer-timeout'
      : 'feed-timeout'
    : kind === 'installer'
      ? 'installer-unreachable'
      : 'feed-unreachable';
  const detail = timedOut
    ? `no answer within ${timeoutMs}ms — ${url} (retry with --timeout <ms> if the host is slow)`
    : `${error instanceof Error ? error.message : String(error)} — ${url}`;
  return finding(code, detail);
}

/** Whether this run could not judge, because a host did not answer. */
export function isIncomplete(findings) {
  return findings.some((entry) => TIMEOUT_FINDINGS.includes(entry.code));
}

/**
 * The last line of a run.
 *
 * Three outcomes, three words. `PASS` and `FAIL` are verdicts on the document;
 * `INCOMPLETE` says the run did not get far enough to have one. The exit code
 * is 1 for both of the last two — the difference is what the reader should do
 * next: fix the feed, or retry the fetch.
 *
 * The count of checks that did not run rides on every line, so a green run
 * cannot be read as "all of it was checked" when part of it was not.
 */
export function summaryLine(findings, notChecked = []) {
  const failures = findings.filter((entry) => FEED_FINDING_SEVERITY[entry.code] === 'fail').length;
  const warnings = findings.length - failures;
  const partial = notChecked.length === 0 ? '' : `; ${notChecked.length} check(s) did not run`;
  if (failures === 0) {
    return `PASS — ${warnings} warning(s), nothing the app would refuse${partial}`;
  }
  if (isIncomplete(findings)) {
    return (
      `INCOMPLETE — the host did not answer, so this is not a verdict on the feed; ` +
      `${failures} failure(s), ${warnings} warning(s)${partial}`
    );
  }
  return `FAIL — ${failures} failure(s), ${warnings} warning(s)${partial}`;
}

/**
 * The app's own rules, from the built main process.
 *
 * `update-feed.ts` is the pure half of the update channel — its header says so,
 * and it imports nothing from Electron — which is why this can load it in a
 * plain Node process. `update-service.ts` cannot be loaded here (it imports
 * `electron` at module scope), so nothing in this script asks it anything.
 */
export const APP_RULES_MODULE = '../apps/desktop/dist/main/update-feed.js';

export async function loadAppRules() {
  let module;
  try {
    module = await import(new URL(APP_RULES_MODULE, import.meta.url).href);
  } catch (error) {
    throw new Error(
      `the app's feed rules are not built (${APP_RULES_MODULE}): run ` +
        '`npm run build:main -w @ucad/desktop` first — ' +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return { checkChannelUrl: module.checkChannelUrl, normalizeSha256: module.normalizeSha256 };
}

/** The feed the shipped configuration names, verbatim — refusals included. */
export function shippedFeedUrl() {
  const raw = readFileSync(join(root, 'apps', 'desktop', 'resources', 'update-config.json'), 'utf8');
  const parsed = JSON.parse(raw);
  return typeof parsed?.feedUrl === 'string' ? parsed.feedUrl : null;
}

/** The version this build is, i.e. what the feed is compared against. */
export function packageVersion() {
  return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
}

/** Reads `--flag value` pairs out of argv. */
export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token || !token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

/** The options this command understands. Anything else is a typo, not a default. */
export const KNOWN_FLAGS = ['feed', 'feed-file', 'expect-version', 'timeout', 'no-installer', 'json'];

/**
 * The `--options` in argv this command does not know.
 *
 * `parseArgs` skips what it does not recognise, which is the right shape for a
 * shell that may pass a stray word and the wrong shape for a flag: `--no-installer`
 * misspelled as `--no-installers` runs the network check the operator meant to
 * skip (and reports a host problem as a feed problem), and `--feed-file` with a
 * typo falls back to fetching the shipped feed — a different document, judged
 * by the right machinery, answering a question nobody asked. Both look like a
 * verdict. So an unknown option is refused, with the known ones listed.
 */
export function unknownFlags(argv) {
  const unknown = [];
  for (const token of argv) {
    if (!token || !token.startsWith('--')) continue;
    const name = token.slice(2).split('=')[0];
    if (!KNOWN_FLAGS.includes(name)) unknown.push(token);
  }
  return unknown;
}

/**
 * What this run judges: an address, or a document already on disk.
 *
 * Kept apart from `main()` so the choice — including "you named both" — is a
 * pure function the tests can drive without a network or a filesystem.
 * `--feed-file` wins nothing and overrides nothing: naming two different
 * documents is a mistake about which one the verdict is for.
 */
export function resolveSource(args) {
  const feedFile = typeof args['feed-file'] === 'string' ? args['feed-file'] : null;
  const feed = typeof args.feed === 'string' ? args.feed : null;
  if (feedFile !== null && feed !== null) {
    throw new Error(
      'both --feed and --feed-file were given: they name two different documents, ' +
        'and this command judges one per run',
    );
  }
  if (feedFile !== null) return { kind: 'file', path: feedFile };
  return { kind: 'url', url: feed ?? shippedFeedUrl() };
}

/** A fetch that gives up, so a wedged host is a finding and not a hung shell. */
async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** The installer's status and length, following the release host's redirect. */
async function headInstaller(url, timeoutMs) {
  const response = await fetchWithTimeout(url, { method: 'HEAD', redirect: 'follow' }, timeoutMs);
  const length = response.headers.get('content-length');
  return {
    status: response.status,
    contentLength: length === null ? null : Number.parseInt(length, 10),
  };
}

/**
 * One finding as one line, in the shape both callers print.
 *
 * `make-update-feed.mjs` prints the same lines when it refuses to publish a
 * feed this judgement rejects. Two printers would eventually disagree about
 * where the code goes, and the reader comparing a refusal with a red run would
 * have to work out that they are the same finding.
 */
export function findingLine(entry) {
  const severity = FEED_FINDING_SEVERITY[entry.code] === 'warn' ? 'warn' : 'FAIL';
  return `[${severity}] ${entry.code}: ${FEED_FINDING_MESSAGE[entry.code]} — ${entry.detail}`;
}

function printFindings(findings) {
  for (const entry of findings) {
    console.log(findingLine(entry));
  }
}

async function main(argv) {
  const unknown = unknownFlags(argv);
  if (unknown.length > 0) {
    throw new Error(
      `unknown option(s): ${unknown.join(', ')}\n` +
        `known options: ${KNOWN_FLAGS.map((name) => `--${name}`).join(', ')}`,
    );
  }

  const args = parseArgs(argv);
  const source = resolveSource(args);
  const rules = await loadAppRules();
  const expectedVersion =
    typeof args['expect-version'] === 'string' ? args['expect-version'] : packageVersion();
  const timeoutMs = Number.parseInt(String(args.timeout ?? '20000'), 10) || 20_000;

  const findings = [];
  /**
   * What this run did not look at, in the words of the check that did not run.
   * Printed rather than implied: see the header's "why not run is printed".
   */
  const notChecked = [];

  console.log(
    source.kind === 'file'
      ? `feed: ${resolve(root, source.path)} (a document, not an address)`
      : `feed: ${source.url ?? '(nothing configured)'}`,
  );
  console.log(`version: this build is ${expectedVersion}`);

  let raw;
  if (source.kind === 'file') {
    // A document on disk has no address, so the address rule has nothing to
    // answer. Saying that out loud is the difference between a partial run and
    // a run that looks complete.
    notChecked.push('the feed address rule: a document on disk has no address to check');
    try {
      raw = readFileSync(resolve(root, source.path), 'utf8');
    } catch (error) {
      findings.push(
        finding('feed-unreadable', `${source.path}: ${error instanceof Error ? error.message : String(error)}`),
      );
    }
  } else {
    findings.push(...judgeFeedAddress(source.url, rules));

    if (findings.length === 0) {
      try {
        const response = await fetchWithTimeout(source.url, { redirect: 'follow' }, timeoutMs);
        if (!response.ok) {
          findings.push(finding('feed-unreachable', `HTTP ${response.status}`));
        } else {
          raw = await response.text();
        }
      } catch (error) {
        findings.push(judgeFetchFailure(error, { url: source.url, timeoutMs, kind: 'feed' }));
      }
    }
  }

  let document = null;
  if (raw !== undefined) {
    try {
      document = JSON.parse(raw);
    } catch {
      findings.push(finding('feed-not-json', `${raw.length} bytes that do not parse`));
    }
  }

  if (document !== null) {
    findings.push(...judgeFeedDocument(document, { expectedVersion, rules }));

    if (args['no-installer'] === true) {
      notChecked.push(
        'the installer URL: not fetched (--no-installer), so "the file is there, at that size" is not proven',
      );
    } else {
      const installer = rules.checkChannelUrl(document.url);
      // An installer URL the document judgement already refused needs no HEAD:
      // the finding is on the list, and a fetch of an address the app will not
      // use proves nothing.
      if (installer.ok) {
        try {
          findings.push(...judgeInstallerHead(await headInstaller(installer.url, timeoutMs), document));
        } catch (error) {
          findings.push(
            judgeFetchFailure(error, { url: installer.url, timeoutMs, kind: 'installer' }),
          );
        }
      }
    }
  }

  if (args.json === true) {
    console.log(
      JSON.stringify(
        {
          feedUrl: source.kind === 'url' ? source.url : null,
          feedFile: source.kind === 'file' ? resolve(root, source.path) : null,
          expectedVersion,
          findings,
          notChecked,
          // A run that could not look is not a verdict; the JSON says which it
          // was, so a script reading this does not have to infer it from codes.
          incomplete: isIncomplete(findings),
        },
        null,
        2,
      ),
    );
  } else {
    printFindings(findings);
    for (const entry of notChecked) {
      console.log(`[skipped] ${entry}`);
    }
    // One printer for the last line, so the three outcomes cannot drift apart.
    console.log(summaryLine(findings, notChecked));
  }

  return hasFailure(findings) ? 1 : 0;
}

// Only run as a command; importing the judgement must not touch the network.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(`[FAIL] ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
}
