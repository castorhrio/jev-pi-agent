/**
 * The published feed, judged without a network.
 *
 * ## Why this file exists
 *
 * `scripts/verify-release-feed.mjs` fetches the feed a release publishes and
 * judges it with the app's own rules. That is the half a machine with a network
 * can do; this file is the half that has to be true on every run, in CI, with no
 * network at all — because the judgement is what decides whether a red run means
 * "the feed is wrong" or "the checker is wrong".
 *
 * The defect that made the script necessary is worth restating, because it is
 * the shape of every case below: the README promises an installer must carry a
 * `sha256`, `update-feed.ts` enforces it, and the feed actually published on the
 * v1.0.0 release carries none. Every gate was green. The version check reads
 * such a feed happily, so the defect stays invisible until a newer release
 * exists — and then it is invisible to *everyone at once*, at the moment nobody
 * is looking at the feed.
 *
 * ## What is pinned here
 *
 *  - the judgement, over a table of documents: each way a feed is wrong produces
 *    the finding that names it, and a correct feed produces none. The second
 *    half matters as much as the first — a checker that cannot go green is a
 *    checker that gets switched off;
 *  - the vocabulary: every code has a severity and a sentence, and `no-size` is
 *    the only warning, because it is the only thing the app tolerates;
 *  - the *one implementation* rule: the script must not restate "https only" or
 *    "64 hex characters". It imports them from the built main process, and the
 *    cases here drive the judgement with the TypeScript sources — so the two
 *    callers are the same rules by construction, and a second copy would have to
 *    be written on purpose to appear;
 *  - the shipped configuration names a feed the app will fetch, and the
 *    installer name the judgement expects is the one `electron-builder` writes
 *    for this product.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  APP_RULES_MODULE,
  FEED_FINDINGS,
  FEED_FINDING_MESSAGE,
  FEED_FINDING_SEVERITY,
  hasFailure,
  installerNameFor,
  isIncomplete,
  isTimeoutError,
  judgeFeedAddress,
  judgeFeedDocument,
  judgeFetchFailure,
  judgeInstallerHead,
  shippedFeedUrl,
  summaryLine,
  TIMEOUT_FINDINGS,
} from '../../scripts/verify-release-feed.mjs';
import { checkChannelUrl, normalizeSha256 } from '../../apps/desktop/src/main/update-feed';
import { blankComments } from './source-scan';

const REPO_ROOT = join(import.meta.dirname, '..', '..');

/** The app's rules, as the command loads them — from the sources, not the build. */
const RULES = { checkChannelUrl, normalizeSha256 };

/** A hash that is a hash. The value is irrelevant; the shape is the point. */
const HASH = 'a'.repeat(64);

/** A feed document a release should publish, i.e. one the app can install from. */
function goodFeed(overrides: Record<string, unknown> = {}) {
  return {
    version: '1.0.0',
    notes: 'notes',
    url: 'https://github.com/castorhrio/jev-pi-agent/releases/download/v1.0.0/UCAD-Setup-1.0.0.exe',
    sha256: HASH,
    size: 122_806_279,
    ...overrides,
  };
}

/** The codes a judgement produced, in order. */
function codesOf(document: unknown, expectedVersion = '1.0.0'): string[] {
  return judgeFeedDocument(document, { expectedVersion, rules: RULES }).map((entry) => entry.code);
}

describe('a feed the app can install from produces no findings', () => {
  it('accepts the document a release should publish', () => {
    // The green half. Without it, every case below could be satisfied by a
    // judgement that reports something about every feed.
    expect(codesOf(goodFeed())).toEqual([]);
    expect(hasFailure(judgeFeedDocument(goodFeed(), { rules: RULES }))).toBe(false);
  });

  it('accepts a feed with no notes, which the app reads as "no notes"', () => {
    const { notes: _notes, ...withoutNotes } = goodFeed();
    expect(codesOf(withoutNotes)).toEqual([]);
  });

  it('accepts a prerelease version, which is a version the app compares', () => {
    expect(
      codesOf(
        goodFeed({
          version: '1.1.0-beta.1',
          url: 'https://github.com/castorhrio/jev-pi-agent/releases/download/v1.1.0-beta.1/UCAD-Setup-1.1.0-beta.1.exe',
        }),
        '1.1.0-beta.1',
      ),
    ).toEqual([]);
  });
});

describe('every way a published feed is wrong is named', () => {
  it('reports a feed that publishes no sha256 — the defect the v1.0.0 release shipped', () => {
    // The exact document on the release: version, notes, url, and nothing else.
    // The app's version check reads it and answers "已是最新版本", which is why
    // this went unnoticed; the download is what refuses it.
    const published = {
      version: '1.0.0',
      notes: 'First release published on GitHub Releases.',
      url: 'https://github.com/castorhrio/jev-pi-agent/releases/latest/download/UCAD-Setup-1.0.0.exe',
    };
    expect(codesOf(published)).toEqual(['no-sha256', 'no-size', 'installer-latest-url']);
  });

  it('separates a missing hash from a hash that is not one', () => {
    expect(codesOf(goodFeed({ sha256: undefined }))).toEqual(['no-sha256']);
    expect(codesOf(goodFeed({ sha256: '' }))).toEqual(['no-sha256']);
    // A truncated digest is the shape a hand-edited feed has, and it is not a
    // missing field: the publisher thought they had published a hash.
    expect(codesOf(goodFeed({ sha256: HASH.slice(0, 40) }))).toEqual(['bad-sha256']);
    expect(codesOf(goodFeed({ sha256: `sha256:${HASH}` }))).toEqual(['bad-sha256']);
  });

  it('reports a size that is not a byte count, and warns about a missing one', () => {
    // A string is what JSON release tooling writes more often than one would
    // like; the app ignores it rather than coercing it, so the feed has said
    // nothing about the file.
    expect(codesOf(goodFeed({ size: '122806279' }))).toEqual(['bad-size']);
    expect(codesOf(goodFeed({ size: 0 }))).toEqual(['bad-size']);
    expect(codesOf(goodFeed({ size: undefined }))).toEqual(['no-size']);
    // The only warning in the vocabulary: the app installs this feed.
    expect(hasFailure(judgeFeedDocument(goodFeed({ size: undefined }), { rules: RULES }))).toBe(false);
  });

  it('reports the releases/latest trap, which 404s once a newer release exists', () => {
    // `latest` resolves to the newest release, so a feed pinned to it points at
    // a file that stops existing the moment the next version is published —
    // exactly the failure `make-update-feed.mjs` was written to avoid.
    expect(
      codesOf(
        goodFeed({
          url: 'https://github.com/castorhrio/jev-pi-agent/releases/latest/download/UCAD-Setup-1.0.0.exe',
        }),
      ),
    ).toEqual(['installer-latest-url']);
  });

  it('reports a URL that names another release, and a file name that carries another version', () => {
    expect(
      codesOf(
        goodFeed({
          url: 'https://github.com/castorhrio/jev-pi-agent/releases/download/v0.9.0/UCAD-Setup-1.0.0.exe',
        }),
      ),
    ).toEqual(['installer-not-this-release']);
    expect(
      codesOf(
        goodFeed({
          url: 'https://github.com/castorhrio/jev-pi-agent/releases/download/v1.0.0/UCAD-Setup-0.9.0.exe',
        }),
      ),
    ).toEqual(['installer-name-mismatch']);
  });

  it('reports a version that is absent, or not this build’s', () => {
    expect(codesOf(goodFeed({ version: undefined }))).toEqual(['no-version']);
    expect(codesOf(goodFeed({ version: '1.1.0' }))).toEqual([
      'version-mismatch',
      'installer-not-this-release',
      'installer-name-mismatch',
    ]);
  });

  it('reports a feed that is not an object at all', () => {
    expect(codesOf([])).toEqual(['not-an-object']);
    expect(codesOf('a string')).toEqual(['not-an-object']);
    expect(codesOf(null)).toEqual(['not-an-object']);
  });

  it('reports an installer URL that is missing or not https', () => {
    expect(codesOf(goodFeed({ url: undefined }))).toEqual(['no-url']);
    expect(codesOf(goodFeed({ url: 'http://example.test/UCAD-Setup-1.0.0.exe' }))).toEqual([
      'installer-not-https',
    ]);
  });

  it('reports every independent problem, not just the first', () => {
    // Fixing one and republishing must not look like a clean run.
    const broken = { version: '1.0.0', url: 'http://example.test/x.exe' };
    expect(codesOf(broken)).toEqual(['no-sha256', 'no-size', 'installer-not-https']);
  });
});

describe('the feed address is judged before its contents', () => {
  it('accepts the address the shipped configuration names', () => {
    // The one address this repository controls, held to the rule the app
    // applies to it. A typo here is a build whose update button says
    // 未配置更新源 forever.
    expect(judgeFeedAddress(shippedFeedUrl(), RULES)).toEqual([]);
  });

  it('refuses a cleartext or unparseable address with the reason the app logs', () => {
    expect(judgeFeedAddress('http://example.test/feed.json', RULES).map((e) => e.code)).toEqual([
      'feed-not-https',
    ]);
    expect(judgeFeedAddress('not a url', RULES).map((e) => e.code)).toEqual(['feed-invalid-url']);
    expect(judgeFeedAddress(null, RULES).map((e) => e.code)).toEqual(['feed-invalid-url']);
  });
});

describe('the installer the feed names is checked against the host', () => {
  it('accepts a host that serves the size the feed published', () => {
    expect(judgeInstallerHead({ status: 200, contentLength: 122_806_279 }, goodFeed())).toEqual([]);
  });

  it('reports a size the host does not serve', () => {
    // The cheap half of "is this the file": the hash needs the whole download,
    // a length mismatch is already proof the feed is stale.
    expect(
      judgeInstallerHead({ status: 200, contentLength: 1 }, goodFeed()).map((e) => e.code),
    ).toEqual(['installer-size-mismatch']);
  });

  it('reports a URL that does not resolve, and does not invent a size problem', () => {
    expect(judgeInstallerHead({ status: 404, contentLength: null }, goodFeed()).map((e) => e.code)).toEqual([
      'installer-unreachable',
    ]);
    expect(judgeInstallerHead(null, goodFeed()).map((e) => e.code)).toEqual(['installer-unreachable']);
  });

  it('says nothing about the size when either side did not publish one', () => {
    expect(judgeInstallerHead({ status: 200, contentLength: null }, goodFeed())).toEqual([]);
    expect(judgeInstallerHead({ status: 200, contentLength: 5 }, goodFeed({ size: undefined }))).toEqual([]);
  });
});

describe('the finding vocabulary is complete', () => {
  it('gives every code a severity and a sentence', () => {
    for (const code of FEED_FINDINGS) {
      expect(FEED_FINDING_SEVERITY[code], `${code} has no severity`).toMatch(/^(fail|warn)$/);
      expect(FEED_FINDING_MESSAGE[code], `${code} has no sentence`).toBeTruthy();
    }
    // The other direction: a table entry for a code that is not in the list is
    // a finding nothing can produce.
    expect(Object.keys(FEED_FINDING_SEVERITY).sort()).toEqual([...FEED_FINDINGS].sort());
    expect(Object.keys(FEED_FINDING_MESSAGE).sort()).toEqual([...FEED_FINDINGS].sort());
  });

  it('warns about exactly the one thing the app tolerates', () => {
    const warnings = FEED_FINDINGS.filter((code) => FEED_FINDING_SEVERITY[code] === 'warn');
    expect(warnings).toEqual(['no-size']);
  });

  it('fails the run on a failure and not on a warning', () => {
    expect(hasFailure([{ code: 'no-sha256', detail: '' }])).toBe(true);
    expect(hasFailure([{ code: 'no-size', detail: '' }])).toBe(false);
    expect(hasFailure([])).toBe(false);
  });
});

describe('a host that does not answer is not a verdict on the feed', () => {
  /** The error `AbortController.abort()` produces, without waiting for one. */
  function abortError(): Error {
    const error = new Error('This operation was aborted');
    error.name = 'AbortError';
    return error;
  }

  it('names a timeout as a timeout, for each of the two fetches', () => {
    // The defect this pins: a blocked route used to be reported as
    // `feed-unreachable` — "the feed could not be fetched, so every update check
    // fails" — with the runtime's `This operation was aborted` as the detail.
    // That sentence is a verdict on the document, and a timeout is not one.
    const feed = judgeFetchFailure(abortError(), {
      url: 'https://example.test/update-feed.json',
      timeoutMs: 20_000,
      kind: 'feed',
    });
    expect(feed.code).toBe('feed-timeout');
    expect(feed.detail).toContain('20000ms');
    expect(feed.detail).toContain('https://example.test/update-feed.json');

    const installer = judgeFetchFailure(abortError(), {
      url: 'https://example.test/UCAD-Setup-1.0.0.exe',
      timeoutMs: 5_000,
      kind: 'installer',
    });
    expect(installer.code).toBe('installer-timeout');
    expect(installer.detail).toContain('5000ms');
  });

  it('keeps a host that answered and refused as a finding about the feed', () => {
    // The other direction: a DNS failure or a refused connection *is* an answer
    // about the address, and it must not be softened into "we did not look".
    const dns = Object.assign(new Error('getaddrinfo ENOTFOUND example.test'), { name: 'TypeError' });
    const feed = judgeFetchFailure(dns, {
      url: 'https://example.test/update-feed.json',
      timeoutMs: 20_000,
      kind: 'feed',
    });
    expect(feed.code).toBe('feed-unreachable');
    expect(feed.detail).toContain('ENOTFOUND');
    expect(isTimeoutError(dns)).toBe(false);
  });

  it('recognises both shapes a timeout arrives in', () => {
    // `AbortController.abort()` throws `AbortError`; `AbortSignal.timeout()`
    // throws `TimeoutError`. A check that knew only one would classify half of
    // its own timeouts as host answers.
    expect(isTimeoutError(abortError())).toBe(true);
    expect(isTimeoutError(Object.assign(new Error('timed out'), { name: 'TimeoutError' }))).toBe(true);
    expect(isTimeoutError(new Error('boom'))).toBe(false);
    expect(isTimeoutError(undefined)).toBe(false);
  });

  it('says INCOMPLETE instead of FAIL, and still fails the run', () => {
    const timedOut = [{ code: 'feed-timeout', detail: 'no answer within 20000ms' }];
    expect(isIncomplete(timedOut)).toBe(true);
    expect(hasFailure(timedOut), 'a run that could not look must not exit 0').toBe(true);
    expect(summaryLine(timedOut)).toContain('INCOMPLETE');
    expect(summaryLine(timedOut)).not.toContain('FAIL');
    // The three outcomes are three words, so a reader can tell "fix the feed"
    // from "retry the fetch" without reading the findings.
    expect(summaryLine([{ code: 'no-sha256', detail: 'null' }])).toContain('FAIL');
    expect(summaryLine([{ code: 'no-size', detail: 'absent' }])).toContain('PASS');
    expect(isIncomplete([{ code: 'no-sha256', detail: 'null' }])).toBe(false);
  });

  it('keeps the count of checks that did not run on every outcome', () => {
    const skipped = ['the installer URL: not fetched (--no-installer)'];
    expect(summaryLine([], skipped)).toContain('1 check(s) did not run');
    expect(summaryLine([{ code: 'feed-timeout', detail: '' }], skipped)).toContain(
      '1 check(s) did not run',
    );
  });

  it('lists exactly the two timeout codes as "did not look"', () => {
    // A code added to this list without a sentence would print `undefined`; the
    // vocabulary test above catches that. This one catches the opposite: a
    // timeout code that is not in the list, so `INCOMPLETE` never fires.
    expect([...TIMEOUT_FINDINGS].sort()).toEqual(['feed-timeout', 'installer-timeout']);
    for (const code of TIMEOUT_FINDINGS) {
      expect(FEED_FINDINGS).toContain(code);
      expect(FEED_FINDING_SEVERITY[code]).toBe('fail');
    }
  });
});

describe('the judgement does not restate the app’s rules', () => {
  const source = readFileSync(join(REPO_ROOT, 'scripts', 'verify-release-feed.mjs'), 'utf8');
  const code = blankComments(source);

  it('imports the rules from the built main process', () => {
    expect(APP_RULES_MODULE).toBe('../apps/desktop/dist/main/update-feed.js');
    expect(code, 'the script must load the app’s rules').toContain('loadAppRules()');
    expect(code, 'the script must judge the shipped feed by default').toContain('shippedFeedUrl()');
  });

  it('carries no second copy of the hash or scheme rule', () => {
    // A second copy of a security rule drifts, and the drift is invisible
    // because each copy passes the tests written for it. The two shapes that
    // would be a copy are the digest pattern and a scheme comparison.
    expect(code, 'the script restates the SHA-256 pattern').not.toMatch(/\[0-9a-f\]\{64\}/i);
    expect(code, 'the script restates the https rule').not.toMatch(/['"]https:['"]/);
  });
});

describe('the installer name is the one this product publishes', () => {
  it('matches the name electron-builder writes for this product', () => {
    // `installerNameFor()` is what the judgement compares the feed's URL
    // against. If the product name or the artifact template changes, the
    // judgement would start reporting every correct feed as wrong — so the
    // expectation is read from the packaging configuration, not written here.
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
      build?: { productName?: string };
    };
    expect(pkg.build?.productName).toBe('UCAD');
    expect(installerNameFor('1.0.0')).toBe(`${pkg.build?.productName}-Setup-1.0.0.exe`);
  });
});
