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
 * ## Usage
 *
 * ```bash
 * npm run build:main -w @ucad/desktop
 * node scripts/verify-release-feed.mjs
 * ```
 *
 * Optional flags: `--feed <url>` (judge this feed instead of the shipped one),
 * `--expect-version <v>` (default: `package.json`'s version), `--timeout <ms>`
 * (default 20000), `--no-installer` (skip the network check of the installer
 * URL), `--json` (print the findings as JSON).
 *
 * Exit code 0 when nothing failed; 1 when a finding is a failure. Warnings
 * (`no-size`) are printed and do not fail the run: the app installs a feed
 * without a size, it just loses the cheap truncation check.
 */

import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
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

function printFindings(findings) {
  for (const entry of findings) {
    const severity = FEED_FINDING_SEVERITY[entry.code] === 'warn' ? 'warn' : 'FAIL';
    console.log(`[${severity}] ${entry.code}: ${FEED_FINDING_MESSAGE[entry.code]} — ${entry.detail}`);
  }
}

async function main(argv) {
  const args = parseArgs(argv);
  const rules = await loadAppRules();

  const feedUrl = typeof args.feed === 'string' ? args.feed : shippedFeedUrl();
  const expectedVersion =
    typeof args['expect-version'] === 'string' ? args['expect-version'] : packageVersion();
  const timeoutMs = Number.parseInt(String(args.timeout ?? '20000'), 10) || 20_000;

  const findings = [];
  console.log(`feed: ${feedUrl ?? '(nothing configured)'}`);
  console.log(`version: this build is ${expectedVersion}`);

  findings.push(...judgeFeedAddress(feedUrl, rules));

  let document = null;
  let raw;
  if (findings.length === 0) {
    try {
      const response = await fetchWithTimeout(feedUrl, { redirect: 'follow' }, timeoutMs);
      if (!response.ok) {
        findings.push(finding('feed-unreachable', `HTTP ${response.status}`));
      } else {
        raw = await response.text();
      }
    } catch (error) {
      findings.push(finding('feed-unreachable', error instanceof Error ? error.message : String(error)));
    }

    if (raw !== undefined) {
      try {
        document = JSON.parse(raw);
      } catch {
        findings.push(finding('feed-not-json', `${raw.length} bytes that do not parse`));
      }
    }
  }

  if (document !== null) {
    findings.push(...judgeFeedDocument(document, { expectedVersion, rules }));

    if (args['no-installer'] !== true) {
      const installer = rules.checkChannelUrl(document.url);
      if (installer.ok) {
        try {
          findings.push(...judgeInstallerHead(await headInstaller(installer.url, timeoutMs), document));
        } catch (error) {
          findings.push(
            finding('installer-unreachable', error instanceof Error ? error.message : String(error)),
          );
        }
      }
    }
  }

  if (args.json === true) {
    console.log(JSON.stringify({ feedUrl, expectedVersion, findings }, null, 2));
  } else {
    printFindings(findings);
    const failures = findings.filter((entry) => FEED_FINDING_SEVERITY[entry.code] === 'fail').length;
    const warnings = findings.length - failures;
    console.log(
      failures === 0
        ? `PASS — ${warnings} warning(s), nothing the app would refuse`
        : `FAIL — ${failures} failure(s), ${warnings} warning(s)`,
    );
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
