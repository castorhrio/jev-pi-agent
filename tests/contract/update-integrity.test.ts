/**
 * The update channel: a released build has a feed, and an installer is only
 * ever launched if it matches the hash the feed published.
 *
 * ## Why this file exists
 *
 * Two defects sat on the same path, and neither was visible in a screenshot.
 *
 *  1. **A released build had no feed.** `readUpdateFeed()` read one
 *     environment variable and nothing else, so the update button in a
 *     published app could only ever answer "未配置更新源". The feature was
 *     unreachable for every user who had not hand-set an environment
 *     variable — the app shipped an update button that could not update.
 *
 *  2. **Nothing proved the installer was the one the feed named.** The bytes
 *     were fetched, written to disk and handed to the shell, with nothing in
 *     between. A feed that was tampered with, or a download replaced in
 *     flight, was arbitrary code execution behind one click.
 *
 * The second is fixed by making the hash mandatory: a feed without one can
 * still announce a version, but nothing is downloaded from it, and a file
 * that does not match the hash is deleted rather than launched. That is a
 * refusal rather than a warning on purpose — an installer that cannot be
 * checked is exactly the installer an attacker would send.
 *
 * The gates below are the mechanism, so the rule cannot rot: a feed without
 * a hash, a download that does not match, and a build that does not ship a
 * feed all fail here.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { Readable } from 'node:stream';
import type * as http from 'node:http';
import { Logger, MemoryLogSink, silentLogger } from '@ucad/observability';

import { blankComments as blankCommentsShared } from './source-scan';
import {
  checkChannelUrl,
  checkFeedUrl,
  checkOpenStagedInstaller,
  checkStagedFileUnchanged,
  closeStagedInstaller,
  fileIdentity,
  isUpdateChannelScheme,
  normalizeSha256,
  openStagedInstallerForLaunch,
  parseUpdateConfig,
  resolveUpdateFeed,
  verifyInstaller,
  verifyStagedInstallerForLaunch,
  type ChannelUrlCheck,
  type ChannelUrlRejection,
} from '../../apps/desktop/src/main/update-feed';
import {
  UpdateService,
  resolveDownloadRedirect,
  type DownloadGet,
} from '../../apps/desktop/src/main/update-service';
import { buildFeedDocument, installerUrlFor } from '../../scripts/make-update-feed.mjs';

const FEED_URL = 'https://example.test/update-feed.json';
const INSTALLER_URL = 'https://example.test/UCAD-Setup-9.9.9.exe';

function sha256Of(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * The script overruns recorded by the two transports below.
 *
 * See `assertNoScriptOverruns()`: the record exists because both products paths
 * catch what their transport raises, so an assertion raised inside a transport
 * is an assertion the product owns.
 */
const scriptOverruns: string[] = [];

/**
 * Records a script overrun and fails the current expectation.
 *
 * Both call sites used to be a bare `expect.fail()`, which is enough to make a
 * test that awaits the transport directly go red — and not enough for the tests
 * that await it *through* `UpdateService`: `check()` catches whatever the fetch
 * rejects with and turns it into an `error` status, and `download()` does the
 * same with the downloader's rejection. A test that scripted one answer too few
 * therefore ended with a product-shaped `error` status and passed, which is the
 * "gate that exempts itself" this file keeps finding: the gate reported the app
 * as broken rather than the fixture as under-scripted.
 *
 * So the overrun is also written down, and the guard below reads the record from
 * `afterEach`, where no product code can swallow it.
 */
function overrun(message: string): never {
  scriptOverruns.push(message);
  expect.fail(message);
}

/**
 * Fails when a test outran its script.
 *
 * Runs after every test in this file (`afterEach` at the bottom of the helpers
 * section). It is the half of the overrun that survives the product's `catch`,
 * and `the scripted helpers fail the test that outruns them` drives it on
 * purpose so the guard is not merely a function nobody has seen answer.
 */
function assertNoScriptOverruns(): void {
  // Drained before the assertion: a guard that left the record behind would
  // fail every later test in the file as well, and the reader would be sent to
  // the wrong one.
  const overruns = scriptOverruns.splice(0);
  expect(
    overruns,
    `a scripted transport was asked for an answer the test did not script (${overruns.join(
      '; ',
    )}); the product catches that assertion and reports it as its own error, so it is asserted here instead`,
  ).toEqual([]);
}

afterEach(assertNoScriptOverruns);

/** One scripted answer to a feed request. */
interface FetchStep {
  readonly status: number;
  /** the JSON body; absent for a response that carries none (an error page) */
  readonly document?: unknown;
}

/**
 * A fetch stand-in that answers requests from a script, in order, and counts
 * its calls.
 *
 * A queue rather than one answer because the feed lifecycle is the thing under
 * test: "the check said 9.9.9 is available, then a second check failed" is a
 * sequence, not a document. A test that scripted one response could only ever
 * describe the first half.
 *
 * Running out of scripted answers is a **failed expectation**, not a throw —
 * see the branch below for why the difference decides whether the test's
 * failure is readable, and `the scripted helpers fail the test that outruns
 * them` for the fixture that keeps this branch red-able.
 */
function feedFetchSteps(steps: readonly FetchStep[]): {
  readonly fetchImpl: typeof fetch;
  readonly calls: number;
} {
  const state = { calls: 0 };
  const queue = [...steps];
  const fetchImpl = (async () => {
    state.calls += 1;
    const step = queue.shift();
    if (step === undefined) {
      // `overrun()` rather than a bare throw: `check()` catches whatever the
      // fetch rejects with and turns it into an `error` status, so a `throw`
      // here arrived at the reader as "更新检查失败: the feed was fetched more
      // times…" — a product-looking failure whose cause was the test.
      overrun(
        `the feed was fetched more times than the test scripted ` +
          `(${steps.length} scripted, request ${state.calls})`,
      );
    }
    return new Response(step.document === undefined ? '' : JSON.stringify(step.document), {
      status: step.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return {
    fetchImpl,
    get calls() {
      return state.calls;
    },
  };
}

/** One scripted HTTP response, and the request that produced it. */
interface ScriptedResponse {
  readonly status: number;
  readonly location?: string;
  readonly body?: string;
}

/**
 * A `https.get` stand-in that answers requests from a script, in order.
 *
 * The redirect rules live in the downloader's response callback, not in
 * `resolveDownloadRedirect` alone. A gate that only calls the helper proves
 * what the rule says; this drives the real listener, so "a 302 to `http:`
 * writes nothing" is a statement about the download, not about a predicate.
 *
 * Like `feedFetchSteps`, an unscripted request fails an expectation instead of
 * throwing: the downloader catches everything its transport throws and reports
 * it as a download failure, which reads as a product defect.
 */
function scriptedGet(script: readonly ScriptedResponse[]): {
  getImpl: DownloadGet;
  requests: string[];
} {
  const steps = [...script];
  const requests: string[] = [];
  const getImpl: DownloadGet = (url, _options, onResponse) => {
    requests.push(url.toString());
    const step = steps.shift();
    if (step === undefined) {
      // Same rule as `feedFetchSteps`: the downloader's own `catch` turns a
      // throw into a failed download, so the overrun is reported as a failed
      // expectation *and* recorded for the after-test guard, naming the count
      // and the URL that was not scripted.
      overrun(
        `the downloader made more requests than the test scripted ` +
          `(${script.length} scripted, request ${requests.length}: ${url.toString()})`,
      );
    }
    const response = Object.assign(
      Readable.from(step.body === undefined ? [] : [Buffer.from(step.body)]),
      {
        statusCode: step.status,
        headers: {
          ...(step.location === undefined ? {} : { location: step.location }),
          'content-length': String(step.body?.length ?? 0),
        },
      },
    );
    onResponse(response as unknown as http.IncomingMessage);
    const request = {
      on: () => request,
      destroy: () => {},
    } as unknown as http.ClientRequest;
    return request;
  };
  return { getImpl, requests };
}

/**
 * The two scripted stand-ins, judged by taking one answer more than they hold.
 *
 * CONTRIBUTING's rule is "prove a gate can go red", and it applies to the test
 * doubles too: a helper whose exhaustion branch has never run is a helper
 * whose exhaustion behaviour is whatever the day's code happens to do. Both
 * fixtures below run that branch on purpose and assert what the reader sees —
 * an assertion naming the overrun, not a stack from inside a promise, and not
 * a product status that says the update check failed.
 */
describe('the scripted helpers fail the test that outruns them', () => {
  it('turns a feed fetched once too often into a failed expectation', async () => {
    const scripted = feedFetchSteps([{ status: 200, document: { version: '9.9.9' } }]);
    await scripted.fetchImpl(FEED_URL, {});

    const failure: unknown = await scripted.fetchImpl(FEED_URL, {}).then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure, 'a request beyond the script was answered instead of refused').toBeInstanceOf(
      Error,
    );
    expect((failure as Error).message).toContain('1 scripted, request 2');
    // An `AssertionError` is what makes vitest print "expected … to be …" and
    // point at the test; anything else prints as an unhandled rejection in the
    // middle of the service's own error path.
    expect((failure as Error).name).toBe('AssertionError');
    expect(scripted.calls).toBe(2);

    // And the overrun is on the record the file's `afterEach` reads, which is
    // the half that survives `check()`'s `catch` — see `assertNoScriptOverruns`.
    // Asserting it here is also what drains the record, so this deliberate
    // overrun does not fail the guard it is testing.
    expect(() => assertNoScriptOverruns()).toThrow(/1 scripted, request 2/);
  });

  it('turns a download that makes one request too many into a failed expectation', () => {
    const { getImpl, requests } = scriptedGet([{ status: 200, body: 'the genuine installer' }]);

    getImpl(new URL(INSTALLER_URL), { timeout: 1 }, () => {});
    // The transport is called synchronously from inside the downloader's
    // promise executor, so the failure surfaces as this throw; the downloader's
    // own catch is what would otherwise bury it in an `error` status.
    expect(() => getImpl(new URL(`${INSTALLER_URL}.again`), { timeout: 1 }, () => {})).toThrow(
      /1 scripted, request 2: https:\/\/example\.test\/UCAD-Setup-9\.9\.9\.exe\.again/,
    );
    // The refused request is still recorded, so "how many requests were made"
    // answers with the count the downloader actually attempted.
    expect(requests).toEqual([INSTALLER_URL, `${INSTALLER_URL}.again`]);

    // The recorded overrun is the one the after-test guard fails on, and saying
    // so here is also what drains it.
    expect(() => assertNoScriptOverruns()).toThrow(/1 scripted, request 2/);
  });
});

describe('the feed a released build ships with', () => {
  it('is configured in a file that the packaging step copies into the app', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
      build: { extraResources?: Array<{ from: string; to: string }> };
    };
    const resources = pkg.build.extraResources ?? [];
    const entry = resources.find((r) => r.to === 'update-config.json');

    expect(
      entry,
      'the packaged build has no update-config.json, so a released app has no feed ' +
        'and its update button can only say "未配置更新源"',
    ).toBeDefined();
    expect(existsSync(entry!.from), `${entry!.from} is missing`).toBe(true);
  });

  it('names an https feed', () => {
    const raw = readFileSync('apps/desktop/resources/update-config.json', 'utf8');
    const feedUrl = parseUpdateConfig(raw);

    expect(feedUrl, 'the shipped configuration names no feed').not.toBeNull();
    expect(feedUrl!.startsWith('https://')).toBe(true);
  });
});

describe('resolving the feed', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ucad-feed-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('prefers the developer override over the packaged file', () => {
    const configPath = join(dir, 'update-config.json');
    writeFileSync(configPath, JSON.stringify({ feedUrl: 'https://example.test/packaged.json' }));

    const resolved = resolveUpdateFeed({
      envValue: 'https://example.test/override.json',
      configPaths: [configPath],
    });

    expect(resolved.url).toBe('https://example.test/override.json');
    expect(resolved.source).toBe('env');
  });

  it('falls back to the packaged file', () => {
    const configPath = join(dir, 'update-config.json');
    writeFileSync(configPath, JSON.stringify({ feedUrl: 'https://example.test/packaged.json' }));

    const resolved = resolveUpdateFeed({ configPaths: [configPath] });

    expect(resolved.url).toBe('https://example.test/packaged.json');
    expect(resolved.source).toBe('config');
  });

  it('holds the developer override to the same https rule as the file', () => {
    // The override used to be returned verbatim, which made an environment
    // variable the one way to point the updater at a cleartext — or `file:`, or
    // nonsense — feed. The rule the configuration file is held to is the rule
    // for the whole channel, so it is checked here. Each refusal carries the
    // reason it was refused: "you typed a URL wrong" and "you tried to downgrade
    // the channel" are different problems with different fixes, and flattening
    // both into one value would make the log line say "invalid" about a value
    // that is perfectly well-formed.
    const refused: ReadonlyArray<readonly [string, 'invalid-url' | 'not-https']> = [
      ['http://example.test/feed.json', 'not-https'],
      ['file:///etc/passwd', 'not-https'],
      ['example.test/feed.json', 'invalid-url'],
      ['not a url', 'invalid-url'],
    ];
    for (const [envValue, reason] of refused) {
      const resolved = resolveUpdateFeed({ envValue });
      expect(resolved.url, `${envValue} produced a feed`).toBeNull();
      expect(resolved.source, `${envValue} was not reported as the override`).toBe('env');
      expect(resolved.rejected, `${envValue} was refused with the wrong reason`).toBe(reason);
    }
  });

  it('does not fall back to the packaged feed when the override is refused', () => {
    // A typo in the variable must not quietly install from the feed the operator
    // was trying to leave. Refused means refused, and the reason is reported.
    const configPath = join(dir, 'update-config.json');
    writeFileSync(configPath, JSON.stringify({ feedUrl: 'https://example.test/packaged.json' }));

    const resolved = resolveUpdateFeed({
      envValue: 'http://example.test/override.json',
      configPaths: [configPath],
    });

    expect(resolved.url).toBeNull();
    expect(resolved.rejected).toBe('not-https');
  });

  it('treats a blank override as no override, not as a refusal', () => {
    const configPath = join(dir, 'update-config.json');
    writeFileSync(configPath, JSON.stringify({ feedUrl: 'https://example.test/packaged.json' }));

    const resolved = resolveUpdateFeed({ envValue: '   ', configPaths: [configPath] });

    expect(resolved.url).toBe('https://example.test/packaged.json');
    expect(resolved.source).toBe('config');
    expect(resolved.rejected).toBeUndefined();
  });

  it('tolerates the whitespace a shell variable carries', () => {
    const resolved = resolveUpdateFeed({ envValue: '  https://example.test/override.json \n' });
    expect(resolved.url).toBe('https://example.test/override.json');
    expect(resolved.rejected).toBeUndefined();
  });

  it('reports no feed rather than a broken one', () => {
    const notJson = join(dir, 'broken.json');
    writeFileSync(notJson, 'this is not json');
    const cleartext = join(dir, 'cleartext.json');
    writeFileSync(cleartext, JSON.stringify({ feedUrl: 'http://example.test/feed.json' }));
    const empty = join(dir, 'empty.json');
    writeFileSync(empty, JSON.stringify({ somethingElse: true }));

    for (const configPath of [notJson, cleartext, empty, join(dir, 'absent.json')]) {
      const resolved = resolveUpdateFeed({ configPaths: [configPath] });
      expect(resolved.url, `${configPath} produced a feed`).toBeNull();
      expect(resolved.source).toBe('none');
    }
    // A list of unusable candidates is still "nothing configured", not a
    // refusal: `rejected` is the override's field, and these files were never
    // an override the user typed.
    expect(
      resolveUpdateFeed({ configPaths: [notJson, cleartext, empty, join(dir, 'absent.json')] }),
    ).toEqual({ url: null, source: 'none' });
  });

  it('skips a configuration file it cannot use and tries the next candidate', () => {
    // The configuration list is a search, not a single path: a build may put
    // its feed in one of several places, and an unreadable or malformed one is
    // a development build / packaging defect rather than a reason to stop.
    // Without this, a malformed first candidate would hide a usable file
    // behind it and the app would report "未配置更新源" while a feed was there.
    const broken = join(dir, 'first.json');
    writeFileSync(broken, '{ this is not json');
    const cleartext = join(dir, 'second.json');
    writeFileSync(cleartext, JSON.stringify({ feedUrl: 'http://example.test/cleartext.json' }));
    const usable = join(dir, 'third.json');
    writeFileSync(usable, JSON.stringify({ feedUrl: 'https://example.test/third.json' }));

    const resolved = resolveUpdateFeed({
      configPaths: [join(dir, 'absent.json'), broken, cleartext, usable],
    });

    expect(resolved.url).toBe('https://example.test/third.json');
    expect(resolved.source).toBe('config');
    expect(resolved.rejected, 'an unusable file is not a refused override').toBeUndefined();
  });

  it('stops at a refused override but keeps looking past a refused file', () => {
    // Deliberate asymmetry, not an accident. A refused override is one
    // decision a person made: falling through to the packaged feed would
    // silently reinstall from the channel they were trying to leave, so the
    // search ends and the reason is reported. A refused file is one candidate
    // in a list, and the next candidate may be the one the build actually
    // wrote — so it is skipped, and no `rejected` is reported.
    const cleartext = join(dir, 'cleartext.json');
    writeFileSync(cleartext, JSON.stringify({ feedUrl: 'http://example.test/feed.json' }));
    const usable = join(dir, 'usable.json');
    writeFileSync(usable, JSON.stringify({ feedUrl: 'https://example.test/usable.json' }));

    expect(
      resolveUpdateFeed({ envValue: 'http://example.test/override.json', configPaths: [usable] }),
    ).toEqual({ url: null, source: 'env', rejected: 'not-https' });
    expect(resolveUpdateFeed({ configPaths: [cleartext, usable] })).toEqual({
      url: 'https://example.test/usable.json',
      source: 'config',
    });
  });
});

/**
 * One rule, three entry points.
 *
 * A feed URL reaches the updater three ways — the `UCAD_UPDATE_FEED`
 * override, the packaged `update-config.json`, and whatever `getFeedUrl` hands
 * `UpdateService` — and the rule "it must be a URL, and it must be https" was
 * written out once per entry point. Copies of a security rule drift silently:
 * each one passes the tests written for it, so nothing is red when they start
 * disagreeing. `checkFeedUrl()` is now the single implementation; the table
 * below is what keeps it that way, by asking all three the same questions.
 */
describe('the feed rule has one implementation', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ucad-feed-rule-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Accepted or refused, and why — the whole truth about one candidate URL. */
  interface Verdict {
    readonly input: string;
    readonly accepted: boolean;
    readonly reason?: 'invalid-url' | 'not-https';
  }

  const CASES: readonly Verdict[] = [
    // Accepted: the two shapes a release writes, plus a URL written in
    // capitals, which `URL` normalises rather than refuses.
    { input: 'https://example.test/feed.json', accepted: true },
    { input: '  https://example.test/feed.json\n', accepted: true },
    { input: 'HTTPS://Example.TEST/feed.json', accepted: true },
    // Refused: cleartext, another scheme, and two not-a-URL spellings.
    { input: 'http://example.test/feed.json', accepted: false, reason: 'not-https' },
    { input: 'file:///etc/passwd', accepted: false, reason: 'not-https' },
    { input: 'ftp://example.test/feed.json', accepted: false, reason: 'not-https' },
    { input: 'example.test/feed.json', accepted: false, reason: 'invalid-url' },
    { input: 'not a url', accepted: false, reason: 'invalid-url' },
    // Nothing configured is not a refusal.
    { input: '', accepted: false },
    { input: '   ', accepted: false },
  ];

  it('accepts and refuses the same values in every entry point', async () => {
    for (const { input, accepted, reason } of CASES) {
      const label = JSON.stringify(input);

      // 1. the shared predicate itself
      const verdict = checkFeedUrl(input);
      expect(verdict.ok, `checkFeedUrl accepted ${label} it should refuse`).toBe(accepted);
      if (!verdict.ok && reason !== undefined) {
        expect(verdict.reason, `checkFeedUrl gave ${label} the wrong reason`).toBe(reason);
      }

      // 2. the override
      const fromEnv = resolveUpdateFeed({ envValue: input });
      expect(Boolean(fromEnv.url), `the override accepted ${label}`).toBe(accepted);
      if (!accepted && reason !== undefined) {
        // A blank variable is no override, so only a written-and-refused one
        // has a reason.
        expect(fromEnv.rejected, `the override gave ${label} the wrong reason`).toBe(reason);
      }

      // 3. the packaged configuration file, which must agree with the override
      //    even though it is read from disk rather than the environment.
      const configPath = join(dir, `${sha256Of(input)}.json`);
      writeFileSync(configPath, JSON.stringify({ feedUrl: input }));
      const fromConfig = resolveUpdateFeed({ configPaths: [configPath] });
      expect(Boolean(fromConfig.url), `the packaged file accepted ${label}`).toBe(accepted);
      expect(fromConfig.rejected, `the packaged file reported ${label} as refused`).toBeUndefined();

      // 4. the service, which used to carry its own copy of the protocol check
      //    and is handed a URL by a caller that may never have looked at it.
      const fetched = feedFetchSteps([{ status: 200, document: {} }]);
      const instance = new UpdateService({
        logger: silentLogger('test'),
        getFeedUrl: () => input,
        downloadDir: dir,
        currentVersion: '1.0.0',
        fetchImpl: fetched.fetchImpl,
      });
      const status = await instance.check();
      // Accepted means the request was made; refused means it was not, and the
      // app says so instead of reporting an empty update.
      expect(fetched.calls, `the service fetched ${label}`).toBe(accepted ? 1 : 0);
      expect(status.feedConfigured, `the service reported ${label} as configured`).toBe(accepted);
      if (!accepted) expect(status.state).toBe('unsupported');

      // The URL the two resolvers hand on is the same normalised string, not
      // merely "both truthy": a rule that agreed on the decision but not on
      // the value would still send the download somewhere else than the
      // override named.
      if (accepted) {
        expect(fromEnv.url, `the override normalised ${label}`).toBe(verdict.ok && verdict.url);
        expect(fromConfig.url).toBe(fromEnv.url);
      }
    }
  });
});

/**
 * Three URLs on the channel, one rule — and a gate that asks all three the same
 * questions.
 *
 * The feed address is the one this file used to be about. The other two are the
 * installer URL the feed names and every redirect hop the download follows, and
 * each of them *had* a test: "refuses an installer URL that is not https" and
 * "refuses a hop that downgrades to cleartext". Both were green against three
 * independent copies of the same comparison, which is the failure mode this
 * repository keeps finding: a test written for a copy can only ever say the
 * copy is self-consistent. What nothing did was hand the three the *same*
 * values and compare the answers.
 *
 * So the table below is shared, and each entry point is driven through it. The
 * scan at the bottom closes the remaining hole — a fourth copy that happens to
 * agree today — by counting the comparison in the source, which is the one
 * thing behaviour tests cannot see.
 */
describe('every URL on the update channel is judged by one rule', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ucad-channel-url-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * One URL, and what every entry point must answer for it.
   *
   * `absolute` marks the values that carry their own scheme. A redirect hop is
   * resolved against the URL that redirected, so a scheme-less `Location`
   * inherits the https origin and cannot downgrade anything — those values are
   * therefore only fed to the redirect site, and `resolves a relative Location
   * against the redirecting URL` pins that behaviour on its own.
   */
  interface UrlCase {
    readonly input: string;
    readonly accepted: boolean;
    readonly reason?: ChannelUrlRejection;
    readonly absolute: boolean;
  }

  const CASES: readonly UrlCase[] = [
    // Accepted: the shapes a release writes, including one in capitals, which
    // `URL` normalises rather than refuses.
    { input: 'https://example.test/UCAD-Setup-9.9.9.exe', accepted: true, absolute: true },
    { input: '  https://example.test/UCAD-Setup-9.9.9.exe\n', accepted: true, absolute: true },
    { input: 'HTTPS://Example.TEST/UCAD-Setup-9.9.9.exe', accepted: true, absolute: true },
    // Refused: cleartext, two other schemes, two relative references, and two
    // not-a-URL spellings the parser answers differently (one has a scheme the
    // parser rejects, the other has no scheme at all).
    {
      input: 'http://example.test/UCAD-Setup-9.9.9.exe',
      accepted: false,
      reason: 'not-https',
      absolute: true,
    },
    { input: 'file:///etc/passwd', accepted: false, reason: 'not-https', absolute: true },
    {
      input: 'ftp://example.test/UCAD-Setup-9.9.9.exe',
      accepted: false,
      reason: 'not-https',
      absolute: true,
    },
    {
      input: 'example.test/UCAD-Setup-9.9.9.exe',
      accepted: false,
      reason: 'invalid-url',
      absolute: false,
    },
    { input: 'not a url', accepted: false, reason: 'invalid-url', absolute: false },
    { input: 'https://[broken', accepted: false, reason: 'invalid-url', absolute: true },
  ];

  it('parses and refuses the same values in the shared predicate', () => {
    for (const { input, accepted, reason } of CASES) {
      const label = JSON.stringify(input);

      const verdict = checkChannelUrl(input);
      expect(verdict.ok, `checkChannelUrl accepted ${label} it should refuse`).toBe(accepted);
      if (!verdict.ok && reason !== undefined) {
        expect(verdict.reason, `checkChannelUrl gave ${label} the wrong reason`).toBe(reason);
      }

      // The feed wrapper adds one thing to this rule — `empty`, for "nothing was
      // configured" — and changes nothing else. A blank value is the only input
      // where the two may disagree, and it is not in this table.
      expect(
        checkFeedUrl(input),
        `checkFeedUrl and checkChannelUrl disagree about ${label}`,
      ).toEqual(verdict);
    }
  });

  /**
   * The rule asked from the outside, on a hand-written value domain.
   *
   * `checkChannelUrl()` is "parse the string, then ask `isUpdateChannelScheme()`
   * about the protocol that came out" and nothing else. Writing that sentence
   * down as code here — `schemeOnlyVerdict()` — is what makes it checkable: if
   * the predicate ever stopped parsing and started prefix-matching the raw
   * input, or grew a rule of its own, the comparison below goes red on
   * `HTTPS://x`, which is the value that tells parsing apart from prefix
   * matching. The table above covers the shapes a release writes; this one
   * covers the shapes a rule drifts into.
   */
  function schemeOnlyVerdict(input: string): ChannelUrlCheck {
    let url: URL;
    try {
      url = new URL(input.trim());
    } catch {
      return { ok: false, reason: 'invalid-url' };
    }
    if (!isUpdateChannelScheme(url.protocol)) return { ok: false, reason: 'not-https' };
    return { ok: true, url: url.toString() };
  }

  it('is exactly "parse, then ask isUpdateChannelScheme" across the value domain', () => {
    const inputs = [
      'https://x',
      'HTTPS://x',
      'https://x ',
      'http://x',
      'file:///x',
      'javascript:alert(1)',
      'data:text/html,x',
      '',
    ] as const;

    for (const input of inputs) {
      const label = JSON.stringify(input);

      // 1. the predicate, against the rule restated from its own two parts.
      expect(checkChannelUrl(input), `checkChannelUrl is not the rule for ${label}`).toEqual(
        schemeOnlyVerdict(input),
      );

      // 2. the feed wrapper: identical, except that "nothing configured" is its
      //    own answer rather than a refusal, which is the only difference the
      //    wrapper is allowed to add.
      if (input.trim() === '') {
        expect(checkFeedUrl(input), 'a blank feed is "not configured", not "refused"').toEqual({
          ok: false,
          reason: 'empty',
        });
      } else {
        expect(checkFeedUrl(input), `checkFeedUrl and checkChannelUrl disagree about ${label}`).toEqual(
          schemeOnlyVerdict(input),
        );
      }

      // 3. the redirect hop, for the values that carry a scheme of their own: a
      //    `Location` is resolved against the redirecting URL first, so only
      //    these are the same question the other two answer.
      if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(input.trim())) {
        const hop = resolveDownloadRedirect(input, new URL(INSTALLER_URL), 0);
        expect(hop.ok, `the hop ${label} disagrees with the channel rule`).toBe(
          schemeOnlyVerdict(input).ok,
        );
      }
    }

    // The two facts a prefix match on the raw string would get wrong, asserted
    // on their own so the failure names the reason instead of a table row:
    // capitals are a URL `URL` normalises rather than refuses, and a
    // non-transport scheme parses fine and is refused by the rule instead.
    expect(checkChannelUrl('HTTPS://x')).toEqual({ ok: true, url: 'https://x/' });
    expect(checkChannelUrl('https://x ')).toEqual({ ok: true, url: 'https://x/' });
    expect(schemeOnlyVerdict('javascript:alert(1)')).toEqual({ ok: false, reason: 'not-https' });
    expect(schemeOnlyVerdict('data:text/html,x')).toEqual({ ok: false, reason: 'not-https' });
  });

  it('refuses an installer URL the feed names, before making a request', async () => {
    for (const { input, accepted, reason } of CASES) {
      const label = JSON.stringify(input);

      const fetched = feedFetchSteps([
        { status: 200, document: { version: '9.9.9', url: input, sha256: sha256Of('installer') } },
      ]);
      const downloads: string[] = [];
      const instance = new UpdateService({
        logger: silentLogger('test'),
        getFeedUrl: () => FEED_URL,
        downloadDir: dir,
        currentVersion: '1.0.0',
        fetchImpl: fetched.fetchImpl,
        // The bytes are irrelevant to this question — did the gate let the
        // download start at all — so the seam records the attempt and writes
        // nothing. The accepted case still ends in an `error` afterwards (a file
        // that was never written cannot be verified), which is why the assertion
        // is on the attempt, not on the state.
        downloadImpl: async (url: URL) => {
          downloads.push(url.toString());
        },
      });

      await instance.check();
      expect(
        instance.current.state,
        `the feed's version was not reported as available for ${label}`,
      ).toBe('available');

      const status = await instance.download();

      expect(downloads.length, `the downloader was given ${label}`).toBe(accepted ? 1 : 0);
      if (!accepted) {
        expect(status.state, `${label} did not fail the download`).toBe('error');
        // The words matter: `not-https` is a downgrade attempt ("must use
        // https"), `invalid-url` is a typo ("invalid"). They send a reader to
        // different fixes, and flattening them would hide which one happened.
        expect(status.message, `${label} was refused with the wrong message`).toContain(
          reason === 'not-https' ? 'https' : '无效',
        );
      }
    }
  });

  it('refuses a redirect hop to the same values, with the same reason', () => {
    const base = new URL('https://example.test/UCAD-Setup-9.9.9.exe');
    const absolute = CASES.filter((entry) => entry.absolute);
    expect(absolute.length, 'the redirect cases are empty, so this proves nothing').toBeGreaterThan(
      0,
    );

    for (const { input, accepted, reason } of absolute) {
      const label = JSON.stringify(input);

      const hop = resolveDownloadRedirect(input, base, 0);
      expect(hop.ok, `the redirect rule accepted ${label} it should refuse`).toBe(accepted);
      if (!hop.ok && reason !== undefined) {
        // Different words, one decision: the listener reports `invalid-location`
        // where the shared rule says `invalid-url`, because for a hop the fix is
        // a header the server wrote.
        expect(hop.reason, `the redirect rule gave ${label} the wrong reason`).toBe(
          reason === 'not-https' ? 'not-https' : 'invalid-location',
        );
      }
      // An accepted hop is the parsed URL, not the raw header: the download
      // follows `hop.url`, so a rule that agreed on the decision but handed on
      // the header text would still be a second implementation of parsing.
      if (hop.ok && accepted) {
        expect(hop.url.toString(), `the redirect rule kept ${label} unparsed`).toBe(
          new URL(input.trim()).toString(),
        );
      }
    }
  });

  /**
   * The scheme written down as a string literal, in any of the spellings a
   * second implementation would use.
   *
   * `'https:'` is how the predicate says it; `'https'` and `'https://'` are how
   * a copy says it — `startsWith('https')`, `startsWith('https://')`,
   * `new Set(['https:'])`, and a template literal that compares the scheme.
   * Counting only the exact spelling the predicate uses left the other four
   * shapes invisible, which is the gap the table below closes: the fixture runs
   * every one of them through this same scan.
   *
   * The quote immediately before `https` is required on purpose. The channel's
   * own vocabulary — `reason: 'not-https'`, `'下载地址必须使用 https'` — is not a
   * comparison, and a scan that counted it would be red about the words it
   * explains itself with.
   */
  const SCHEME_LITERAL = /['"`]https:?(?:\/\/)?['"`]/g;

  /**
   * Every place the channel's sources write the scheme down, as `file:line`.
   *
   * Comments are blanked (see `blankComments`) because both files discuss https
   * at length, and a scan that counted prose would be a scan nobody could keep
   * green — the same reason the seam gate further down blanks them.
   */
  function schemeSites(files: readonly SourceFile[]): string[] {
    return files.flatMap((file) => {
      const code = blankComments(file.source);
      return [...code.matchAll(SCHEME_LITERAL)].map(
        (match) => `${file.path}:${code.slice(0, match.index).split('\n').length}`,
      );
    });
  }

  /**
   * The update channel's sources: the feed's rules, and the service that uses
   * them. Two `.ts` files under `apps/desktop/src/main`, and nothing else.
   *
   * That scope is a choice, and the choice has a blind spot: a *fourth* copy
   * written in a file this list does not name would not be counted. The scope is
   * therefore not left to memory — `scans every main-process file that uses the
   * channel rule` derives it from the code, so a new file that starts using the
   * rule has to be added here. The renderer and the shared packages are outside
   * the scan because nothing there takes part in a download: the URLs it would
   * judge never leave the main process.
   */
  const CHANNEL_SOURCES = ['update-feed.ts', 'update-service.ts'] as const;

  it('writes the scheme down once, inside the predicate that owns it', () => {
    const sites = schemeSites(
      CHANNEL_SOURCES.map((name) => ({
        path: name,
        source: readFileSync(join(MAIN_SOURCE, name), 'utf8'),
      })),
    );

    expect(
      sites.length,
      `the update channel compares the https scheme in ${sites.length} places (${sites.join(
        ', ',
      )}); call isUpdateChannelScheme() instead of writing the comparison again`,
    ).toBe(1);
    expect(
      sites[0],
      "the channel's one https comparison is not in update-feed.ts, where the rule lives",
    ).toMatch(/^update-feed\.ts:\d+$/);

    // Not merely "one literal, somewhere in the right file": it has to be the
    // predicate's own line, or the allowed copy could sit in dead code while a
    // live one hides in the service.
    const line = Number(sites[0]!.split(':')[1]);
    const lines = readFileSync(UPDATE_FEED_SOURCE, 'utf8').split('\n');
    const predicateStart = lines.findIndex((text) =>
      text.includes('function isUpdateChannelScheme('),
    );
    expect(
      predicateStart,
      'isUpdateChannelScheme() is gone, so the one allowed comparison has no home',
    ).toBeGreaterThanOrEqual(0);
    const predicateEnd = lines.findIndex((text, index) => index > predicateStart && text === '}');
    expect(
      line - 1,
      `the https comparison at update-feed.ts:${line} is outside isUpdateChannelScheme()`,
    ).toBeGreaterThan(predicateStart);
    expect(line - 1).toBeLessThan(predicateEnd);
  });

  it('counts a second copy of the comparison and ignores the prose about it', () => {
    // The fixture is the edit this gate exists for: the protocol decided again
    // at the download site, which is exactly what `download()` used to do. One
    // body per spelling, because a scan that only knows `=== 'https:'` is a scan
    // a copy can walk around in one keystroke.
    const copies: ReadonlyArray<readonly [string, string]> = [
      ['an equality test', "  if (url.protocol === 'https:') return url;"],
      ['an inequality test', "  if (url.protocol !== 'https:') return null;"],
      ['an allow-list of one', "  if (!new Set(['https:']).has(url.protocol)) return null;"],
      ['a prefix test on the scheme', "  if (!url.protocol.startsWith('https')) return null;"],
      ['a prefix test on the href', "  if (!url.href.startsWith('https://')) return null;"],
      ['a template literal', '  if (`https:` === url.protocol) return url;'],
    ];
    for (const [spelling, body] of copies) {
      const source = [
        "import { checkChannelUrl } from './update-feed';",
        '',
        'export function fetchInstaller(url: URL) {',
        body,
        '}',
      ].join('\n');
      expect(
        schemeSites([{ path: 'update-service.ts', source }]),
        `a copy written as ${spelling} was not counted`,
      ).toEqual(['update-service.ts:4']);
    }

    // The other direction, which is what keeps this gate usable: a doc comment
    // naming the scheme is not a second implementation, so it is not counted.
    const prose = [
      "/** The feed must be 'https:' and nothing else. */",
      "// A second 'https:' in prose is still prose.",
      'export const ok = true;',
    ].join('\n');
    expect(schemeSites([{ path: 'update-feed.ts', source: prose }])).toEqual([]);

    // And the channel's own vocabulary, which the real files are full of: a
    // refusal *reason* and a sentence the user reads are neither of them a
    // comparison, and counting them would make the gate red about its subject.
    const vocabulary = [
      "export const reason = 'not-https';",
      "export const sentence = '下载地址必须使用 https';",
      "export const log = 'update feed must be https; ignoring';",
    ].join('\n');
    expect(schemeSites([{ path: 'update-service.ts', source: vocabulary }])).toEqual([]);
  });

  /**
   * The main-process files that mention the channel rule, by file name.
   *
   * A pure function of its input, so the scope guard below can be shown
   * answering with a file it was given rather than only with the tree it reads.
   */
  function channelRuleUsers(files: readonly SourceFile[]): string[] {
    const rule =
      /\b(?:isUpdateChannelScheme|checkChannelUrl|checkFeedUrl|resolveDownloadRedirect)\b/;
    return files
      .filter((file) => rule.test(blankComments(file.source)))
      .map((file) => file.path.slice(file.path.lastIndexOf('/') + 1))
      .sort();
  }

  it('scans every main-process file that uses the channel rule', () => {
    // The scan above takes an explicit list, which is also its limit: a copy
    // written in a file the list does not name is invisible, and the gate keeps
    // passing while the rule grows a second home. So the scope is derived from
    // the code instead of remembered — every main-process file that mentions the
    // rule belongs in the scan — and this is the test that fails when one is
    // added without being added to `CHANNEL_SOURCES`.
    const stranger: SourceFile = {
      path: 'apps/desktop/src/main/downloader.ts',
      source: "export const ok = checkChannelUrl('https://example.test/x');",
    };
    expect(
      channelRuleUsers([...mainSources(), stranger]),
      'the scope check cannot see a new file that uses the rule, so it proves nothing',
    ).toContain('downloader.ts');

    expect(
      channelRuleUsers(mainSources()),
      'a main-process file uses the channel rule and is not in CHANNEL_SOURCES, so the scheme scan does not read it',
    ).toEqual([...CHANNEL_SOURCES].sort());
  });
});

describe('a hash is a hash', () => {
  it('accepts the shapes a release tool writes', () => {
    const digest = sha256Of('installer');
    expect(normalizeSha256(digest)).toBe(digest);
    expect(normalizeSha256(digest.toUpperCase())).toBe(digest);
    expect(normalizeSha256(`  ${digest}\n`)).toBe(digest);
  });

  it('refuses anything that is not one', () => {
    expect(normalizeSha256('')).toBeNull();
    expect(normalizeSha256('not a hash')).toBeNull();
    expect(normalizeSha256(sha256Of('installer').slice(0, 63))).toBeNull();
    expect(normalizeSha256(`${sha256Of('installer')}0`)).toBeNull();
    expect(normalizeSha256(undefined)).toBeNull();
    expect(normalizeSha256(12345)).toBeNull();
  });
});

/**
 * The four ways `verifyInstaller()` can answer "no".
 *
 * Each case asserts the *whole* answer — reason plus `expected`/`actual` — with
 * `toEqual`, and each is built so the neighbouring branch cannot be the one
 * that fired: the size case carries a correct digest, the digest case carries a
 * correct size, and the file swapped in the digest case is the same length as
 * the original. Asserting only `ok === false` (which is what this block used to
 * do) cannot tell a body was ever checked from a body that was refused for some
 * other reason — a failure that looks like a fact, which is the defect this
 * repository keeps paying for. The distinction matters to the user too: "the
 * feed published no hash", "this is not the file", "this is not the file the
 * size says" and "this file cannot be read" send a person to three different
 * places.
 */
describe('proving a downloaded file is the one the feed named', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ucad-verify-'));
    file = join(dir, 'installer.exe');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('accepts a file that matches, and reports the digest it computed', async () => {
    const bytes = 'the genuine installer';
    writeFileSync(file, bytes);
    const digest = sha256Of(bytes);

    // The feed's digest is written in the case a release tool chose, which the
    // check normalises: the answer reports the digest as it was computed, not
    // as it arrived.
    const result = await verifyInstaller(file, { sha256: digest.toUpperCase(), size: bytes.length });

    expect(result).toEqual({ ok: true, sha256: digest, bytes: bytes.length });
  });

  it('refuses a file whose digest differs, and names both digests', async () => {
    const genuine = 'the genuine installer';
    const swapped = 'the evil installer!!!';
    // Same length on purpose: the size check must not be able to take the
    // credit for this refusal. The hash is the defence, and this is the case
    // that proves the defence is the hash.
    expect(swapped.length).toBe(genuine.length);
    writeFileSync(file, swapped);

    const result = await verifyInstaller(file, { sha256: sha256Of(genuine), size: genuine.length });

    expect(result).toEqual({
      ok: false,
      reason: 'hash-mismatch',
      expected: sha256Of(genuine),
      actual: sha256Of(swapped),
      bytes: genuine.length,
    });
  });

  it('refuses a file whose size differs, even when the digest matches', async () => {
    const bytes = 'short';
    writeFileSync(file, bytes);

    const result = await verifyInstaller(file, { sha256: sha256Of(bytes), size: 999 });

    // The digest is the file's own, so a size-mismatch here cannot be the hash
    // branch in disguise. Both figures are carried: "expected 999, got 5" is
    // what tells a truncated download from a wrong file.
    expect(result).toEqual({
      ok: false,
      reason: 'size-mismatch',
      expected: '999',
      actual: String(bytes.length),
      bytes: bytes.length,
    });
  });

  it('answers a size mismatch without reading the file it refuses', async () => {
    // The order of the two checks is a promise, not an implementation detail:
    // a truncated download — what a dropped connection leaves behind — must be
    // refused from the `stat` alone, not read end to end and then refused.
    //
    // A directory is the fixture that can tell the two orders apart: `stat`
    // describes it, and a streamed read of it fails with EISDIR. So the same
    // path answers differently depending on which check ran first:
    //
    //  - expected size differs → `size-mismatch`, from the `stat`, with the
    //    file never opened;
    //  - expected size agrees  → `unreadable`, because the hash read is then
    //    the thing that runs, and it is the thing that fails.
    //
    // A verifier that hashed first would answer `unreadable` for both, and the
    // size branch would only be reachable after reading every file it refuses
    // — which is the defect these two assertions exist to keep out.
    const size = statSync(dir).size;
    const hash = sha256Of('not the installer');

    expect(await verifyInstaller(dir, { sha256: hash, size: size + 1 })).toEqual({
      ok: false,
      reason: 'size-mismatch',
      expected: String(size + 1),
      actual: String(size),
      bytes: size,
    });
    // The neighbour, and the reason the first assertion means anything: with a
    // size that agrees, the read is what runs and what fails. Without it,
    // "size-mismatch on a directory" could also be produced by a verifier that
    // never reads at all.
    expect(await verifyInstaller(dir, { sha256: hash, size })).toEqual({
      ok: false,
      reason: 'unreadable',
    });
  });

  it('says "not checked" rather than "checked" when the feed has no hash', async () => {
    writeFileSync(file, 'anything');

    // Three spellings of "the feed did not say what this file is": absent, a
    // string that is not a digest, and a truncated digest. None of them is a
    // mismatch — nothing was compared — and none of them carries an
    // `expected`/`actual` pair that could be read as a comparison result.
    for (const hash of [undefined, 'not a hash', sha256Of('anything').slice(0, 63)]) {
      expect(await verifyInstaller(file, { sha256: hash }), String(hash)).toEqual({
        ok: false,
        reason: 'no-hash',
      });
    }
    // A feed that announces a size is not a substitute: an unchecked file is
    // unchecked whatever else the document carries.
    expect(await verifyInstaller(file, { size: 8 })).toEqual({ ok: false, reason: 'no-hash' });
  });

  it('reports a file it cannot read as unreadable, whichever read fails', async () => {
    // Two reads, two ways to fail, one reason: the caller's remedy is the same
    // ("download it again"), and "cannot read" must never be reported as
    // "does not match" — that would be a failure posing as a fact.
    const absent = await verifyInstaller(join(dir, 'absent.exe'), { sha256: sha256Of('x') });
    expect(absent, 'a file that is not there').toEqual({ ok: false, reason: 'unreadable' });

    // The stat succeeds on a directory and the stream read is what fails
    // (EISDIR), so this reaches the second `unreadable` branch rather than the
    // first.
    const notAFile = await verifyInstaller(dir, { sha256: sha256Of('x') });
    expect(notAFile, 'a path that cannot be read as a file').toEqual({
      ok: false,
      reason: 'unreadable',
    });
  });
});

/**
 * "The file that was hashed" and "the file that runs" are two readings of one
 * path, and `FileIdentity` is the type that lets them be compared.
 *
 * The signature these four cases defend is the one `installAndRestart()` makes
 * its last decision on, so each case is stated with the *neighbour* it must not
 * be confused with: a rename-over at the same length (a size check cannot see
 * it, an inode can), an in-place rewrite (the inode stays, the size does not),
 * and a deletion (nothing to compare, and "replaced" would be a lie about a
 * file that is not there). The untouched case is what keeps the other three
 * from being satisfied by a check that always refuses.
 */
describe('whether the file about to run is the file that was hashed', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ucad-identity-'));
    file = join(dir, 'UCAD-setup.exe');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('says an untouched file is still that file', () => {
    writeFileSync(file, 'the genuine installer');
    const identity = fileIdentity(statSync(file));

    expect(checkStagedFileUnchanged(file, identity)).toEqual({ ok: true });
  });

  it('notices a rename over the staged name, even when the length is identical', () => {
    const genuine = 'the genuine installer';
    const swapped = 'the evil installer!!!';
    expect(swapped.length, 'the size check would be able to take the credit').toBe(genuine.length);

    writeFileSync(file, genuine);
    const identity = fileIdentity(statSync(file));

    // What a substitution actually looks like: a new file is written somewhere
    // and moved onto the staged name. The path then names a different file
    // object — the inode changes, the length does not.
    const replacement = join(dir, 'replacement.exe');
    writeFileSync(replacement, swapped);
    renameSync(replacement, file);

    expect(checkStagedFileUnchanged(file, identity)).toEqual({ ok: false, reason: 'replaced' });
  });

  it('notices an in-place rewrite, which keeps the inode', () => {
    writeFileSync(file, 'the genuine installer');
    const identity = fileIdentity(statSync(file));

    // The same file object, rewritten through the same path. `ino` cannot see
    // this one — the size and the timestamp are what do — which is why the
    // identity carries more than a pair of numbers.
    writeFileSync(file, 'the evil installer, and then some');

    expect(checkStagedFileUnchanged(file, identity)).toEqual({ ok: false, reason: 'replaced' });
  });

  it('reports a file that is gone as unreadable, not as replaced', () => {
    writeFileSync(file, 'the genuine installer');
    const identity = fileIdentity(statSync(file));
    rmSync(file);

    expect(checkStagedFileUnchanged(file, identity)).toEqual({ ok: false, reason: 'unreadable' });
  });
});

/**
 * The two verifiers answer the same refusals, and differ only in what a
 * success carries.
 *
 * `verifyInstaller()` hashes a path; `verifyStagedInstallerForLaunch()` hashes
 * an open descriptor and returns the identity of the file object it hashed.
 * The point of asking both is that the second must not have *relaxed* anything
 * on the way: the refusal vocabulary is what the user-facing message is chosen
 * from, and a copy that grew its own would be the two-copies-of-one-rule
 * problem this file already fixed for the feed URL.
 */
describe('the launch verifier refuses what the plain verifier refuses', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ucad-launch-verify-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('gives a matching file the same digest, plus the identity it hashed', async () => {
    const file = join(dir, 'installer.exe');
    const bytes = 'the genuine installer';
    writeFileSync(file, bytes);
    const expected = { sha256: sha256Of(bytes), size: bytes.length };

    const plain = await verifyInstaller(file, expected);
    const launch = await verifyStagedInstallerForLaunch(file, expected);

    expect(plain).toEqual({ ok: true, sha256: sha256Of(bytes), bytes: bytes.length });
    // The success is the same answer *plus* the file it came from — the
    // identity of the descriptor that was read, not of a later `stat` of the
    // path.
    expect(launch.ok && { ...launch, identity: undefined }).toEqual({
      ok: true,
      sha256: sha256Of(bytes),
      bytes: bytes.length,
      identity: undefined,
    });
    expect(launch.ok && launch.identity).toEqual(fileIdentity(statSync(file)));
  });

  it('answers every refusal in the same words', async () => {
    const genuine = 'the genuine installer';
    const swapped = 'the evil installer!!!';
    const file = join(dir, 'installer.exe');

    // Four fixtures, one per refusal: a file that is not the file, a file the
    // size disagrees with, a feed that published no hash, and a path that
    // cannot be read at all.
    const cases: ReadonlyArray<readonly [string, string, { sha256?: string; size?: number }]> = [
      [file, swapped, { sha256: sha256Of(genuine), size: genuine.length }],
      [file, 'short', { sha256: sha256Of('short'), size: 999 }],
      [file, genuine, {}],
      [join(dir, 'absent.exe'), genuine, { sha256: sha256Of(genuine) }],
    ];

    for (const [path, bytes, expected] of cases) {
      writeFileSync(file, bytes);
      const plain = await verifyInstaller(path, expected);
      const launch = await verifyStagedInstallerForLaunch(path, expected);
      expect(launch, `${bytes} / ${path}`).toEqual(plain);
      expect(plain.ok, 'a refusal fixture answered ok').toBe(false);
    }
  });
});

/**
 * The descriptor the launch path holds across the hook.
 *
 * `verifyStagedInstallerForLaunch()` answers a question and closes; the launch
 * path cannot do that, because closing and re-opening the path is the window
 * this work is about. These cases drive the open-handle pair directly, so both
 * halves of `checkOpenStagedInstaller()` have a failure that can be produced:
 * a rewrite of the *file object* (the descriptor sees it) and a rename over
 * the *path* (only a fresh resolution sees it).
 */
describe('the launch verifier holds the file object it checked', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ucad-open-verify-'));
    file = join(dir, 'UCAD-setup.exe');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('accepts an untouched file and refuses an in-place rewrite', async () => {
    const genuine = 'the genuine installer';
    writeFileSync(file, genuine);
    const opened = await openStagedInstallerForLaunch(file, {
      sha256: sha256Of(genuine),
      size: genuine.length,
    });
    expect(opened.ok, 'the fixture was not verified in the first place').toBe(true);
    if (!opened.ok) return;

    try {
      expect(checkOpenStagedInstaller(file, opened.handle)).toEqual({ ok: true });

      // Keeps the inode, changes the length: `ino` alone cannot see it. The
      // held descriptor can, because its fstat is the file object that was
      // hashed rather than a later resolution of the name.
      writeFileSync(file, 'the evil installer, and then some');
      expect(checkOpenStagedInstaller(file, opened.handle)).toEqual({
        ok: false,
        reason: 'replaced',
      });
    } finally {
      closeStagedInstaller(opened.handle);
    }
  });

  it('refuses a rename over the path while the descriptor is open', async () => {
    const genuine = 'the genuine installer';
    const swapped = 'the evil installer!!!';
    expect(swapped.length, 'the size check would be able to take the credit').toBe(genuine.length);
    writeFileSync(file, genuine);

    const opened = await openStagedInstallerForLaunch(file, {
      sha256: sha256Of(genuine),
      size: genuine.length,
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    try {
      // The descriptor still names the genuine file, which is exactly why the
      // descriptor alone is not enough: the launch resolves the *path*.
      const replacement = join(dir, 'replacement.exe');
      writeFileSync(replacement, swapped);
      renameSync(replacement, file);

      expect(checkOpenStagedInstaller(file, opened.handle)).toEqual({
        ok: false,
        reason: 'replaced',
      });
    } finally {
      closeStagedInstaller(opened.handle);
    }
  });

  it('reports a file that is gone as unreadable', async () => {
    const genuine = 'the genuine installer';
    writeFileSync(file, genuine);
    const opened = await openStagedInstallerForLaunch(file, {
      sha256: sha256Of(genuine),
      size: genuine.length,
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    try {
      rmSync(file);
      expect(checkOpenStagedInstaller(file, opened.handle)).toEqual({
        ok: false,
        reason: 'unreadable',
      });
    } finally {
      closeStagedInstaller(opened.handle);
    }
  });
});

describe('the updater itself', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ucad-update-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function service(options: {
    feed?: unknown;
    /** a script of feed answers, for the tests that need more than one check */
    steps?: readonly FetchStep[];
    getFeedUrl?: () => string | null;
    download?: (url: URL, target: string) => Promise<void>;
    /** drive the real downloader through a scripted transport instead */
    downloadGet?: DownloadGet;
    open?: (target: string) => Promise<string>;
    /** a sink the test can read, for asserting what was *said* was refused */
    logs?: MemoryLogSink;
    /** runs between the verification and the launch, for the window below */
    beforeLaunch?: (target: string) => void | Promise<void>;
  }) {
    const fetched = feedFetchSteps(options.steps ?? [{ status: 200, document: options.feed ?? {} }]);
    const downloads: string[] = [];
    const launched: string[] = [];
    const download = options.download;
    const logger = options.logs
      ? new Logger({ scope: 'test', sink: options.logs })
      : silentLogger('test');
    const instance = new UpdateService({
      logger,
      getFeedUrl: options.getFeedUrl ?? (() => FEED_URL),
      downloadDir: dir,
      currentVersion: '1.0.0',
      fetchImpl: fetched.fetchImpl,
      ...(download === undefined
        ? {}
        : {
            downloadImpl: async (url: URL, target: string, onProgress) => {
              downloads.push(url.toString());
              await download(url, target);
              onProgress(1, 1);
            },
          }),
      ...(options.downloadGet === undefined ? {} : { downloadGet: options.downloadGet }),
      ...(options.beforeLaunch === undefined ? {} : { beforeLaunch: options.beforeLaunch }),
      openInstaller: async (target) => {
        launched.push(target);
        return options.open ? options.open(target) : '';
      },
    });
    return { instance, downloads, launched, fetchCalls: fetched };
  }

  it('says no feed is configured instead of reporting an empty update', async () => {
    // README, both languages: "With no feed the app says so rather than failing
    // quietly" / "没有配置时应用会直说，而不是静默失败". An updater that
    // answered `up-to-date` here would tell the user there is nothing to do
    // when it never asked a question.
    const { instance, fetchCalls } = service({ feed: {}, getFeedUrl: () => null });

    const status = await instance.check();

    expect(status.state).toBe('unsupported');
    expect(status.message).toBe('未配置更新源');
    expect(status.feedConfigured).toBe(false);
    expect(fetchCalls.calls).toBe(0);
  });

  it('never fetches a cleartext feed, even if the wiring hands it one', async () => {
    // `resolveUpdateFeed` refuses a cleartext override before the service sees
    // it, and the service refuses it again. This is the second gate: a caller
    // that bypassed the resolver must not turn the download into cleartext.
    const { instance, fetchCalls } = service({
      feed: { version: '9.9.9' },
      getFeedUrl: () => 'http://example.test/feed.json',
    });

    const status = await instance.check();

    expect(status.state).toBe('unsupported');
    expect(status.feedConfigured).toBe(false);
    expect(fetchCalls.calls).toBe(0);
  });

  it('says in the log why a feed was refused, not just that it was', async () => {
    // The refusal is the security-relevant half of `resolveFeed()`, and it was
    // the half with no gate: what the user sees is "未配置更新源" in both
    // cases, and a cleartext channel refused without a line in `app.log` is a
    // refusal nobody can diagnose. Both refusal reasons are asserted, because
    // "you typed a URL wrong" and "you tried to downgrade the channel" send a
    // person to two different fixes and must not be flattened into one line.
    const refused: ReadonlyArray<readonly [string, string, 'invalid-url' | 'not-https']> = [
      ['http://example.test/feed.json', 'must be https', 'not-https'],
      ['file:///etc/passwd', 'must be https', 'not-https'],
      ['example.test/feed.json', 'not a valid URL', 'invalid-url'],
    ];

    for (const [feedUrl, message, reason] of refused) {
      const logs = new MemoryLogSink();
      const { instance, fetchCalls } = service({ logs, getFeedUrl: () => feedUrl });

      const status = await instance.check();

      expect(status.state, `${feedUrl} was not reported as unsupported`).toBe('unsupported');
      expect(status.feedConfigured).toBe(false);
      expect(fetchCalls.calls, `${feedUrl} was fetched anyway`).toBe(0);

      const warning = logs.records.find((record) => record.msg.includes(message));
      expect(warning, `${feedUrl} was refused with no log line saying why`).toBeDefined();
      expect(warning!.level).toBe('warn');
      expect(warning!.meta).toMatchObject({ reason });
    }
  });

  it('stays quiet about a feed nobody configured', async () => {
    // The other half of the same rule: "nothing is configured" is a
    // development build, not a mistake, so it must not produce the warning
    // above — a log that cries wolf on every dev start is a log people stop
    // reading.
    const logs = new MemoryLogSink();
    const { instance } = service({ logs, getFeedUrl: () => null });

    await instance.check();

    expect(logs.records.filter((record) => record.level === 'warn')).toEqual([]);
  });

  it('refuses an installer URL that is not https before fetching it', async () => {
    // The feed is https and hashed, but the file it names is not. The hash
    // proves the bytes match what the feed named; it does not make a cleartext
    // transfer acceptable, and an http URL is refused before a request is made
    // — the same rule the feed and every redirect hop are held to.
    const { instance, downloads } = service({
      feed: {
        version: '9.9.9',
        url: 'http://example.test/UCAD-Setup-9.9.9.exe',
        sha256: sha256Of('installer'),
      },
    });

    await instance.check();
    expect(instance.current.state).toBe('available');

    const status = await instance.download();

    expect(status.state).toBe('error');
    expect(status.message).toContain('https');
    expect(downloads).toEqual([]);
    expect(existsSync(join(dir, 'UCAD-setup.exe'))).toBe(false);
  });

  it('refuses a feed version that cannot be compared or displayed safely', async () => {
    // Nine-point-something outranks 1.0.0, so the version check reports
    // `available` — the comparison stops at the first non-digit. The path in
    // the string is why staging is a constant and why the version is gated
    // before download, not after.
    const { instance, downloads } = service({
      feed: {
        version: '9.9.9/../../Startup',
        url: INSTALLER_URL,
        sha256: sha256Of('installer'),
      },
    });

    await instance.check();
    expect(instance.current.state).toBe('available');

    const status = await instance.download();

    expect(status.state).toBe('error');
    expect(status.message).toContain('版本号无效');
    expect(downloads).toEqual([]);
  });

  it('refuses to download from a feed that carries no hash', async () => {
    const { instance, downloads, fetchCalls } = service({
      feed: { version: '9.9.9', url: INSTALLER_URL },
    });

    await instance.check();
    expect(instance.current.state).toBe('available');

    const status = await instance.download();

    expect(status.state).toBe('error');
    expect(status.message).toContain('SHA-256');
    // Nothing was fetched — not the installer, and not the feed a second
    // time: the document the check read is the document the download uses.
    expect(downloads).toEqual([]);
    expect(fetchCalls.calls).toBe(1);
  });

  it('deletes a package that does not match the hash and never launches it', async () => {
    const genuine = 'the genuine installer';
    // The replacement is the *same length* as the original, so the size
    // check cannot catch it. The hash is the defence, and this is the case
    // that proves the defence is the hash.
    const swapped = 'the evil installer!!!';
    expect(swapped.length).toBe(genuine.length);

    const { instance, launched } = service({
      feed: {
        version: '9.9.9',
        url: INSTALLER_URL,
        sha256: sha256Of(genuine),
        size: genuine.length,
      },
      download: async (_url, target) => {
        writeFileSync(target, swapped);
      },
    });

    await instance.check();
    const status = await instance.download();

    expect(status.state).toBe('error');
    expect(status.message).toContain('SHA-256');
    expect(status.verified).toBe(false);
    // The file is gone rather than left on disk under a name that means
    // "pending update", and nothing was launched.
    expect(existsSync(join(dir, 'UCAD-setup.exe'))).toBe(false);

    const installed = await instance.installAndRestart();
    expect(installed).toBe(false);
    expect(launched).toEqual([]);
  });

  it('installs a package that matches the hash', async () => {
    const genuine = 'the genuine installer';
    const { instance, launched } = service({
      feed: {
        version: '9.9.9',
        url: INSTALLER_URL,
        sha256: sha256Of(genuine),
        size: genuine.length,
      },
      download: async (_url, target) => {
        writeFileSync(target, genuine);
      },
    });

    await instance.check();
    const status = await instance.download();

    expect(status.state).toBe('ready');
    expect(status.verified).toBe(true);

    const installed = await instance.installAndRestart();
    expect(installed).toBe(true);
    expect(launched).toHaveLength(1);
    expect(launched[0]).toBe(join(dir, 'UCAD-setup.exe'));
  });

  /**
   * The gap between "verified" and "launched".
   *
   * `download()` proves the bytes it wrote are the bytes the feed named, and
   * that proof was a fact about one moment. The staged file then sits in the
   * user's own profile directory until they click 立即重启 — minutes, or days —
   * and the promise made at download time says nothing about the file that is
   * there now. So `installAndRestart()` verifies again, against the document
   * the update check read, and everything below is asserted because "it
   * returns false" alone would pass for an updater that refused for an
   * unrelated reason and left an executable sitting under the name that means
   * "pending update".
   */
  it('refuses a file that was replaced between the download and the click, and deletes it', async () => {
    const genuine = 'the genuine installer';
    // Same length as the genuine file, so the size check cannot be the one
    // that refuses it and the staging name is the only thing that is right.
    const swapped = 'the evil installer!!!';
    expect(swapped.length).toBe(genuine.length);

    const logs = new MemoryLogSink();
    const { instance, launched } = service({
      logs,
      feed: {
        version: '9.9.9',
        url: INSTALLER_URL,
        sha256: sha256Of(genuine),
        size: genuine.length,
      },
      download: async (_url, target) => {
        writeFileSync(target, genuine);
      },
    });

    await instance.check();
    const downloaded = await instance.download();
    expect(downloaded.state).toBe('ready');
    expect(downloaded.verified).toBe(true);

    // What a user's machine sees: the interval between the download finishing
    // and the restart button being pressed.
    writeFileSync(join(dir, 'UCAD-setup.exe'), swapped);

    const installed = await instance.installAndRestart();

    expect(installed, 'the updater reported a launch it must not have made').toBe(false);
    expect(launched, 'a file that no longer matches the feed was launched').toEqual([]);
    expect(
      existsSync(join(dir, 'UCAD-setup.exe')),
      'the tampered file was left on disk under the name that means "pending update"',
    ).toBe(false);

    const status = instance.current;
    expect(status.state).toBe('error');
    // `verified: true` would be the worst possible answer here: it is the
    // field the settings screen reads as "this file was checked".
    expect(status.verified).toBe(false);
    expect(status.message).toContain('SHA-256');
    // The status must not keep pointing at a file that is gone — the download
    // button's replacement (安装) would otherwise offer a path that cannot be
    // opened.
    expect(status.downloadedPath, 'the status still points at a deleted file').toBeUndefined();

    // And the refusal is in the log with the two figures, not just a boolean:
    // the numbers are what tells a tampered download from a feed that changed
    // its mind.
    const refusal = logs.records.find((record) => record.msg === 'refusing to install an unverified update');
    expect(refusal, 'the refusal was not logged at all').toBeDefined();
    expect(refusal!.level, 'an installation that was refused is not a debug note').toBe('error');
    expect(refusal!.meta).toMatchObject({
      reason: 'hash-mismatch',
      expected: sha256Of(genuine),
      actual: sha256Of(swapped),
    });
  });

  it('asks for a fresh download when the staged file is gone', async () => {
    // The other way the install click can find nothing to verify: the file was
    // cleaned up, or the user cleared the folder. "安装包不存在，请重新下载" is
    // a different message from a verification failure, and it is the one that
    // tells the person what to do next.
    const genuine = 'the genuine installer';
    const { instance, launched } = service({
      feed: {
        version: '9.9.9',
        url: INSTALLER_URL,
        sha256: sha256Of(genuine),
        size: genuine.length,
      },
      download: async (_url, target) => {
        writeFileSync(target, genuine);
      },
    });

    await instance.check();
    await instance.download();
    rmSync(join(dir, 'UCAD-setup.exe'), { force: true });

    const installed = await instance.installAndRestart();

    expect(installed).toBe(false);
    expect(launched).toEqual([]);
    expect(instance.current.state).toBe('error');
    expect(instance.current.message).toContain('请重新下载');
  });

  /**
   * The rest of the window, from the other side.
   *
   * The test above replaces the file *before* the click, so the re-verification
   * at the top of `installAndRestart()` is what refuses it. That leaves the
   * smaller window open, and it is the one no digest can close: the hash is a
   * fact about bytes that were read at one moment, and the launch resolves the
   * *path* at a later one. So the verification now hands back the identity of
   * the file object it hashed, and the path is asked once more immediately
   * before `openPath`. `beforeLaunch` is the seam that opens that window in a
   * test; the three cases below are what the check does when it is open.
   */
  it('refuses a file substituted after it was verified, and never launches it', async () => {
    const genuine = 'the genuine installer';
    // Same length as the genuine file: this refusal cannot be the size check's,
    // and the substitution is a `rename` over the staged name — a different
    // file object behind an identical-looking path.
    const swapped = 'the evil installer!!!';
    expect(swapped.length).toBe(genuine.length);

    const logs = new MemoryLogSink();
    const { instance, launched } = service({
      logs,
      feed: {
        version: '9.9.9',
        url: INSTALLER_URL,
        sha256: sha256Of(genuine),
        size: genuine.length,
      },
      download: async (_url, target) => {
        writeFileSync(target, genuine);
      },
      beforeLaunch: (target) => {
        const replacement = join(dir, 'replacement.exe');
        writeFileSync(replacement, swapped);
        renameSync(replacement, target);
      },
    });

    await instance.check();
    const downloaded = await instance.download();
    expect(downloaded.state).toBe('ready');

    const installed = await instance.installAndRestart();

    expect(installed, 'the updater launched a file it had not verified').toBe(false);
    expect(launched, 'the file that replaced the installer was launched').toEqual([]);
    expect(
      existsSync(join(dir, 'UCAD-setup.exe')),
      'the substitute was left on disk under the name that means "pending update"',
    ).toBe(false);

    const status = instance.current;
    expect(status.state).toBe('error');
    expect(status.verified, 'the status still claims the file was checked').toBe(false);
    expect(status.downloadedPath, 'the status still points at a deleted file').toBeUndefined();
    // Its own message: nothing was found wrong with the bytes, so a "校验失败"
    // here would send the reader looking for a broken release.
    expect(status.message).toContain('发生变化');

    const refusal = logs.records.find(
      (record) => record.msg === 'refusing to install an update that changed after it was verified',
    );
    expect(refusal, 'the refusal was not logged at all').toBeDefined();
    expect(refusal!.level).toBe('error');
    // The digest that *was* verified travels with the refusal: it is the one
    // fact that says which file the user was about to run.
    expect(refusal!.meta).toMatchObject({ reason: 'replaced', sha256: sha256Of(genuine) });
  });

  it('refuses an in-place rewrite during the launch window, and never launches it', async () => {
    // The other substitution shape: the same inode is written again through
    // the staged path. A path comparison that only looks at `ino` would call
    // this unchanged; the descriptor held across the hook sees the length.
    const genuine = 'the genuine installer';
    const logs = new MemoryLogSink();
    const { instance, launched } = service({
      logs,
      feed: {
        version: '9.9.9',
        url: INSTALLER_URL,
        sha256: sha256Of(genuine),
        size: genuine.length,
      },
      download: async (_url, target) => {
        writeFileSync(target, genuine);
      },
      beforeLaunch: (target) => {
        writeFileSync(target, 'the evil installer, and then some');
      },
    });

    await instance.check();
    expect((await instance.download()).state).toBe('ready');

    const installed = await instance.installAndRestart();

    expect(installed, 'the updater launched a file it had not verified').toBe(false);
    expect(launched, 'the rewritten installer was launched').toEqual([]);
    expect(
      existsSync(join(dir, 'UCAD-setup.exe')),
      'the rewritten file was left on disk under the name that means "pending update"',
    ).toBe(false);
    expect(instance.current.message).toContain('发生变化');
    expect(
      logs.records.find(
        (record) => record.msg === 'refusing to install an update that changed after it was verified',
      )!.meta,
    ).toMatchObject({ reason: 'replaced', sha256: sha256Of(genuine) });
  });

  it('asks for a fresh download when the file disappears before the launch', async () => {
    // The other way the path can stop naming the verified file, and it gets a
    // different reason: "replaced" would be a claim about a file that is not
    // there.
    const genuine = 'the genuine installer';
    const logs = new MemoryLogSink();
    const { instance, launched } = service({
      logs,
      feed: {
        version: '9.9.9',
        url: INSTALLER_URL,
        sha256: sha256Of(genuine),
        size: genuine.length,
      },
      download: async (_url, target) => {
        writeFileSync(target, genuine);
      },
      beforeLaunch: (target) => {
        rmSync(target, { force: true });
      },
    });

    await instance.check();
    expect((await instance.download()).state).toBe('ready');

    const installed = await instance.installAndRestart();

    expect(installed).toBe(false);
    expect(launched).toEqual([]);
    expect(instance.current.state).toBe('error');
    expect(instance.current.message).toContain('请重新下载');
    expect(
      logs.records.find(
        (record) => record.msg === 'refusing to install an update that changed after it was verified',
      )!.meta,
    ).toMatchObject({ reason: 'unreadable' });
  });

  it('launches when the file is still the file it verified', async () => {
    // The positive control. Without it, the two cases above would also pass for
    // a check that always refuses — and a launcher that never launches is a
    // worse defect than the one this window is about.
    const genuine = 'the genuine installer';
    const checked: string[] = [];
    const { instance, launched } = service({
      feed: {
        version: '9.9.9',
        url: INSTALLER_URL,
        sha256: sha256Of(genuine),
        size: genuine.length,
      },
      download: async (_url, target) => {
        writeFileSync(target, genuine);
      },
      beforeLaunch: (target) => {
        checked.push(target);
      },
    });

    await instance.check();
    expect((await instance.download()).state).toBe('ready');

    const installed = await instance.installAndRestart();

    expect(installed).toBe(true);
    // The seam ran, so the refusal above is a decision rather than a step that
    // was skipped.
    expect(checked).toEqual([join(dir, 'UCAD-setup.exe')]);
    expect(launched).toEqual([join(dir, 'UCAD-setup.exe')]);
    expect(instance.current.state, 'a launched update left an error behind').not.toBe('error');
  });

  /**
   * Forgets the document the update check read.
   *
   * The field is private because nothing outside the service may write it —
   * which is also why no public path can produce the state below: `available`
   * and the document are written in one statement block, and every path that
   * clears the document moves the status off `available` in the same block. A
   * test that wants the branch has to write the field, and reaching a branch
   * only a corrupt status can reach is the point of the assertion.
   */
  function forgetCheckedFeed(instance: UpdateService): void {
    (instance as unknown as { feed: unknown }).feed = null;
  }

  it('takes the pending download with it when a later check fails', async () => {
    // Reachable, and the reason the status and the document are read together:
    // the user clicks 检查更新 a second time while the first result is on
    // screen. That check fails — a blip, a feed that went away — so the
    // document the download would have been made against is gone with it.
    // Downloading anyway would stage a file for a version the app can no
    // longer say anything about, and the version the user was shown would be
    // a claim about a feed that was never read.
    const genuine = 'the genuine installer';
    const { instance, downloads, fetchCalls } = service({
      steps: [
        { status: 200, document: { version: '9.9.9', url: INSTALLER_URL, sha256: sha256Of(genuine) } },
        { status: 503 },
      ],
      download: async (_url, target) => {
        writeFileSync(target, genuine);
      },
    });

    expect((await instance.check()).state).toBe('available');

    const rechecked = await instance.check();
    expect(rechecked.state).toBe('error');
    expect(rechecked.message).toContain('503');

    const status = await instance.download();
    expect(status.state).toBe('error');
    expect(downloads, 'a failed re-check still downloaded the stale version').toEqual([]);
    // Two checks and no third request: the download did not rescue itself by
    // reading the feed again.
    expect(fetchCalls.calls).toBe(2);
    expect(existsSync(join(dir, 'UCAD-setup.exe'))).toBe(false);
  });

  /**
   * Makes the status say `available` with no check behind it.
   *
   * The second way into the branch below, and the one a future caller would
   * produce: the status and the document are two fields, and only `check()`
   * currently writes both. Written through the field on purpose — no public
   * path produces the state today, and a gate that could only observe the
   * reachable path would be asserting nothing about the unreachable one.
   */
  function pretendAvailable(instance: UpdateService): void {
    (instance as unknown as { status: Record<string, unknown> }).status = {
      state: 'available',
      currentVersion: '1.0.0',
      latestVersion: '9.9.9',
      feedConfigured: true,
    };
  }

  it('refuses a download whose checked document is gone, without a single request', async () => {
    // The branch `download()` keeps for a status that disagrees with itself.
    // It cannot be produced today, and what is asserted is what happens *if* it
    // ever can: the download stops, says so, and above all does not fetch
    // anything — not the feed a second time, and not the installer. An earlier
    // build re-fetched the feed here, which reopened the window the stored
    // document exists to close — a second read can name a different file than
    // the version the user was shown, and the hash that
    // `installAndRestart()` re-checks comes from that same document.
    //
    // The transport below has *no* scripted answers, so "no network request
    // was made" is a fact about this run rather than an absence nobody
    // checked: one attempt would overrun the script and be recorded.
    const genuine = 'the genuine installer';
    const { getImpl, requests } = scriptedGet([]);
    const { instance, fetchCalls } = service({
      feed: { version: '9.9.9', url: INSTALLER_URL, sha256: sha256Of(genuine) },
      downloadGet: getImpl,
    });

    await instance.check();
    expect(instance.current.state).toBe('available');

    forgetCheckedFeed(instance);
    const status = await instance.download();

    expect(status.state).toBe('error');
    // The message tells the user what to do — check again — rather than
    // reporting a download failure for a download that never started.
    expect(status.message).toContain('重新检查');
    expect(requests, 'the download reached the network with no document to check against').toEqual(
      [],
    );
    // One read of the feed — the check's. The fallback used to make this two.
    expect(fetchCalls.calls).toBe(1);
    expect(existsSync(join(dir, 'UCAD-setup.exe'))).toBe(false);
  });

  it('refuses the same download when the status was never earned by a check', async () => {
    // The same invariant from the other end: `available` without a document,
    // and without even a check having run. This is the shape a later caller
    // writing `state: 'available'` — a retry queue, a restored session —
    // would hand the download, and the refusal (plus its log line) is what
    // keeps that caller from becoming a second feed reader.
    const logs = new MemoryLogSink();
    const { getImpl, requests } = scriptedGet([]);
    const { instance, fetchCalls } = service({ logs, downloadGet: getImpl });

    pretendAvailable(instance);
    const status = await instance.download();

    expect(status.state).toBe('error');
    expect(status.message).toContain('重新检查');
    expect(requests, 'a download with no checked document made a request').toEqual([]);
    expect(fetchCalls.calls, 'the download read the feed to rescue itself').toBe(0);

    const refusal = logs.records.find(
      (record) => record.msg === 'update download without the document the update check read',
    );
    expect(refusal, 'the refusal was silent, so nobody can diagnose it').toBeDefined();
    expect(refusal!.level, 'an update that refused to download is not a debug note').toBe('error');
  });

  it('writes every byte it reports as downloaded', async () => {
    // Two consumers of one stream: the progress listener, and the pipeline
    // that writes the file. The downloader used to iterate the response a
    // second time (`Readable.from(response)`), which raced the listener — the
    // file could be written empty while `onProgress` reported the whole
    // package. A same-tick response is where that race is deterministic, and
    // it is also the shape of a fast local mirror. A ready status with an
    // empty staged file is exactly the state that would later fail its hash
    // check and look like a tampered download.
    const genuine = 'the genuine installer';
    const { getImpl } = scriptedGet([{ status: 200, body: genuine }]);
    const { instance } = service({
      feed: {
        version: '9.9.9',
        url: INSTALLER_URL,
        sha256: sha256Of(genuine),
        size: genuine.length,
      },
      downloadGet: getImpl,
    });

    await instance.check();
    const status = await instance.download();

    expect(status.state).toBe('ready');
    expect(status.progress).toBe(1);
    expect(readFileSync(join(dir, 'UCAD-setup.exe'), 'utf8')).toBe(genuine);
  });

  it('refuses a redirect to cleartext, leaving no staged file and launching nothing', async () => {
    // The feed is https, the URL it names is https, and the hash is present —
    // every check before the request passes. The installer then arrives as a
    // 302 to `http:`. That hop is the downgrade the hash cannot catch: the
    // bytes would still be checkable, but they would have travelled in the
    // clear. The download must fail before the cleartext request is made.
    const genuine = 'the genuine installer';
    const { getImpl, requests } = scriptedGet([
      { status: 302, location: 'http://example.test/UCAD-Setup-9.9.9.exe' },
    ]);
    const { instance, launched } = service({
      feed: {
        version: '9.9.9',
        url: INSTALLER_URL,
        sha256: sha256Of(genuine),
        size: genuine.length,
      },
      downloadGet: getImpl,
    });

    await instance.check();
    expect(instance.current.state).toBe('available');

    const status = await instance.download();

    expect(status.state).toBe('error');
    expect(status.message).toContain('https');
    // Only the request the feed named was made. A second request would mean
    // the cleartext Location was followed before being judged.
    expect(requests).toEqual([INSTALLER_URL]);
    expect(existsSync(join(dir, 'UCAD-setup.exe'))).toBe(false);

    const installed = await instance.installAndRestart();
    expect(installed).toBe(false);
    expect(launched).toEqual([]);
  });

  it('follows exactly five redirects and stages the bytes at the end', async () => {
    // The boundary in the safe direction: five hops are followed. Without
    // this case the limit could be tightened to four and every assertion
    // about "too many" would still pass — a limit that refuses the fifth hop
    // is not the limit the comment describes.
    const genuine = 'the genuine installer';
    const hops = Array.from({ length: 5 }, (_, index) => ({
      status: 302,
      location: `https://example.test/hop-${index + 1}`,
    }));
    const { getImpl, requests } = scriptedGet([...hops, { status: 200, body: genuine }]);
    const { instance } = service({
      feed: {
        version: '9.9.9',
        url: INSTALLER_URL,
        sha256: sha256Of(genuine),
        size: genuine.length,
      },
      downloadGet: getImpl,
    });

    await instance.check();
    const status = await instance.download();

    expect(status.state, status.message).toBe('ready');
    expect(status.verified).toBe(true);
    // The feed URL plus the five redirect targets.
    expect(requests).toHaveLength(6);
    expect(readFileSync(join(dir, 'UCAD-setup.exe'), 'utf8')).toBe(genuine);
  });

  it('refuses the sixth redirect and leaves nothing staged', async () => {
    // The comment calls the limit a safety promise; this is the case that
    // makes it fail. Six redirect responses are offered and the sixth is
    // refused, so the request count stops at six instead of following the
    // loop forever.
    const genuine = 'the genuine installer';
    const hops = Array.from({ length: 6 }, (_, index) => ({
      status: 302,
      location: `https://example.test/hop-${index + 1}`,
    }));
    const { getImpl, requests } = scriptedGet(hops);
    const { instance, launched } = service({
      feed: {
        version: '9.9.9',
        url: INSTALLER_URL,
        sha256: sha256Of(genuine),
        size: genuine.length,
      },
      downloadGet: getImpl,
    });

    await instance.check();
    const status = await instance.download();

    expect(status.state).toBe('error');
    expect(status.message).toContain('重定向次数过多');
    // Which hop was refused, not just that one was: the count is the only fact
    // in the message the *server* chose, and it is what turns "更新失败" into a
    // report a publisher can act on.
    expect(status.message).toContain('第 6 次跳转');
    // And *where*: a loop is diagnosed from the one URL that kept answering
    // 302, so the message carries the address of the request that redirected.
    // The sixth request went to the fifth hop (the first is the URL the feed
    // named), and that is the address printed — the request's own, which has
    // already passed the channel's rule, not the `Location` text the refusal
    // exists to reject.
    expect(status.message).toContain('请求地址 https://example.test/hop-5');
    expect(requests).toHaveLength(6);
    expect(requests[5]).toBe('https://example.test/hop-5');
    // Nothing staged, and nothing half-staged: a refusal that leaves a file
    // behind under the name that means "pending update" is the state the next
    // install click would find.
    expect(readdirSync(dir), 'a refused download left a file in the staging directory').toEqual(
      [],
    );

    const installed = await instance.installAndRestart();
    expect(installed).toBe(false);
    expect(launched).toEqual([]);
  });

  /**
   * The overrun, through the product path.
   *
   * The two fixtures at the top of this file outrun a script by calling the
   * transport directly, and a bare `expect.fail()` is enough there: nothing
   * catches the assertion, so the test goes red. That is *not* true one layer
   * up — `download()` and `check()` both wrap the transport call in a `catch`
   * that turns any rejection into an `error` status, so an under-scripted test
   * awaited through the service used to finish green with a product-shaped
   * status on screen. The status is asserted below (it is what the user sees),
   * and then the test's own failure is asserted, because that is the one the
   * reader needs: "1 scripted, request 2" names the fixture, while "下载失败"
   * names an app that is working correctly.
   */
  it('fails the test, not the download, when the download script runs out half way', async () => {
    const genuine = 'the genuine installer';
    // One redirect is scripted and the download needs two answers: the hop it
    // follows, and the bytes at the end of it.
    const { getImpl, requests } = scriptedGet([
      { status: 302, location: 'https://example.test/hop-1' },
    ]);
    const { instance } = service({
      feed: {
        version: '9.9.9',
        url: INSTALLER_URL,
        sha256: sha256Of(genuine),
        size: genuine.length,
      },
      downloadGet: getImpl,
    });

    await instance.check();
    const status = await instance.download();

    // What the product did with it: a failed download, no staged file, and the
    // second request attempted (and refused) rather than skipped.
    expect(status.state).toBe('error');
    expect(requests).toEqual([INSTALLER_URL, 'https://example.test/hop-1']);
    expect(existsSync(join(dir, 'UCAD-setup.exe'))).toBe(false);

    // What the test did: outran its script. `afterEach` runs this same guard,
    // so the run would be red even if this assertion were deleted — the
    // assertion is here to prove the guard answers, and to drain the record.
    expect(() => assertNoScriptOverruns()).toThrow(/1 scripted, request 2/);
  });

  it('fails the test, not the check, when the feed script is empty', async () => {
    // The feed half of the same hole: `check()` catches the assertion and
    // reports "更新检查失败: …", which is a sentence about the app. The script
    // was empty, and the guard says so.
    const { instance } = service({ steps: [] });

    const status = await instance.check();

    expect(status.state).toBe('error');
    expect(status.message, 'the assertion was masked as a product failure').toContain(
      '0 scripted, request 1',
    );
    expect(() => assertNoScriptOverruns()).toThrow(/0 scripted, request 1/);
  });
});

describe('a download redirect is a second URL the feed did not name', () => {
  const base = new URL('https://example.test/releases/update-feed.json');

  it('resolves a relative Location against the redirecting URL and counts the hop', () => {
    const redirect = resolveDownloadRedirect('UCAD-Setup-9.9.9.exe', base, 0);

    expect(redirect.ok).toBe(true);
    expect(redirect.ok === true && redirect.url.toString()).toBe(
      'https://example.test/releases/UCAD-Setup-9.9.9.exe',
    );
    expect(redirect.ok === true && redirect.depth).toBe(1);
  });

  it('refuses a hop that downgrades to cleartext', () => {
    expect(resolveDownloadRedirect('http://example.test/installer.exe', base, 0)).toEqual({
      ok: false,
      reason: 'not-https',
    });
  });

  it('refuses a Location that does not parse instead of throwing out of the listener', () => {
    // This is the defect the helper was extracted for: `new URL()` used to run
    // inside the response callback, where a throw escapes the promise executor
    // and becomes an uncaught exception in the main process. A server that
    // sends `Location: https://[` could take the updater down instead of
    // failing the download.
    expect(resolveDownloadRedirect('https://[', base, 0)).toEqual({
      ok: false,
      reason: 'invalid-location',
    });
    expect(resolveDownloadRedirect('http://', base, 0)).toEqual({
      ok: false,
      reason: 'invalid-location',
    });
  });

  it('stops after the hop limit rather than following a loop forever', () => {
    expect(resolveDownloadRedirect('https://example.test/next', base, 4)).toEqual({
      ok: true,
      url: new URL('https://example.test/next'),
      depth: 5,
    });
    expect(resolveDownloadRedirect('https://example.test/next', base, 5)).toEqual({
      ok: false,
      reason: 'too-many-redirects',
    });
  });
});

/**
 * The shapes a `Location` header can take — including the two that carry no
 * scheme of their own.
 *
 * A hop is judged *after* it is resolved against the URL that redirected, which
 * is what makes these four cases one question: a rule that read the header text
 * would refuse both relative shapes (no scheme to compare), and a rule that
 * compared the header's host would not see `//evil.test/x` at all. Resolved
 * first, all four are the same question the feed and the installer URL answer —
 * `checkChannelUrl()` on the URL that will actually be requested.
 *
 * So each case is asserted twice: against the shared rule, on the URL the header
 * resolves to, and through `download()`, which is the path the app uses. The
 * refused cases also assert that nothing was written: a refusal that leaves a
 * half-staged file behind is the state the next `installAndRestart()` would find
 * under the name that means "pending update".
 */
describe('every Location a redirect carries is judged after it is resolved', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ucad-location-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** The URL the download starts from; every case below redirects away from it. */
  const REDIRECTING = 'https://example.test/releases/UCAD-Setup-9.9.9.exe';

  interface LocationCase {
    readonly location: string;
    /** what the header resolves to, or null when it does not parse at all */
    readonly resolved: string | null;
    readonly accepted: boolean;
    /** the words in the message the user ends up reading */
    readonly message?: string;
  }

  const CASES: readonly LocationCase[] = [
    {
      // Absolute https: the shape a release mirror sends.
      location: 'https://cdn.test/UCAD-Setup-9.9.9.exe',
      resolved: 'https://cdn.test/UCAD-Setup-9.9.9.exe',
      accepted: true,
    },
    {
      // Protocol-relative: no scheme of its own, so it inherits the redirecting
      // URL's — https, which is why it is allowed to be followed. The *origin*
      // it names is not what this rule judges; a hop may point at another host,
      // and what may not happen is a hop pointing at another protocol.
      location: '//evil.test/UCAD-Setup-9.9.9.exe',
      resolved: 'https://evil.test/UCAD-Setup-9.9.9.exe',
      accepted: true,
    },
    {
      // Path-relative: inherits origin, scheme and all.
      location: '/mirror/UCAD-Setup-9.9.9.exe',
      resolved: 'https://example.test/mirror/UCAD-Setup-9.9.9.exe',
      accepted: true,
    },
    {
      // Absolute cleartext: the downgrade the rule exists for, and the one a
      // hashed feed cannot catch — the bytes would still verify, they would just
      // have travelled in the clear.
      location: 'http://evil.test/UCAD-Setup-9.9.9.exe',
      resolved: 'http://evil.test/UCAD-Setup-9.9.9.exe',
      accepted: false,
      message: '重定向必须使用 https',
    },
    {
      // A scheme that is not a transport at all. The parser accepts the string,
      // so this is not `invalid-location`: the rule is what refuses it.
      location: 'javascript:alert(1)',
      resolved: 'javascript:alert(1)',
      accepted: false,
      message: '重定向必须使用 https',
    },
    {
      // Not a URL even after resolution, and the case that used to throw out of
      // the response listener instead of failing the download.
      location: 'https://[',
      resolved: null,
      accepted: false,
      message: '重定向地址无效',
    },
    {
      // A `Location` with no scheme and no path — an origin only. Resolved onto
      // https, so it is the accepted shape that carries nothing else.
      location: '//cdn.test',
      resolved: 'https://cdn.test/',
      accepted: true,
    },
  ];

  it('answers each hop the way the shared rule answers the URL it resolved to', () => {
    const base = new URL(REDIRECTING);

    for (const { location, resolved, accepted } of CASES) {
      const label = JSON.stringify(location);
      const hop = resolveDownloadRedirect(location, base, 0);

      expect(hop.ok, `the hop ${label} was decided the wrong way`).toBe(accepted);

      if (resolved === null) {
        expect(hop, `${label} did not parse, so it is not a protocol question`).toEqual({
          ok: false,
          reason: 'invalid-location',
        });
        continue;
      }

      // The channel's one rule, asked of the URL the download would request. A
      // hop that disagreed with it here would be the second implementation this
      // whole file is arranged against.
      const verdict = checkChannelUrl(resolved);
      expect(hop.ok, `the hop ${label} and checkChannelUrl(${resolved}) disagree`).toBe(
        verdict.ok,
      );
      if (hop.ok && verdict.ok) {
        expect(hop.url.toString(), `the hop ${label} handed on a different URL`).toBe(verdict.url);
      }
      if (!hop.ok && !verdict.ok) {
        // Same decision, different vocabulary: for a hop the fix is a header a
        // server wrote, which the user cannot edit, so `invalid-location` says
        // where to look.
        expect(hop.reason, `the hop ${label} was refused for the wrong reason`).toBe(
          verdict.reason === 'not-https' ? 'not-https' : 'invalid-location',
        );
      }
    }
  });

  it('makes exactly the requests the rule allows, and stages bytes only when it does', async () => {
    const genuine = 'the genuine installer';

    for (const { location, resolved, accepted, message } of CASES) {
      const label = JSON.stringify(location);
      const fetched = feedFetchSteps([
        {
          status: 200,
          document: {
            version: '9.9.9',
            url: REDIRECTING,
            sha256: sha256Of(genuine),
            size: genuine.length,
          },
        },
      ]);
      const { getImpl, requests } = scriptedGet([
        { status: 302, location },
        { status: 200, body: genuine },
      ]);
      const instance = new UpdateService({
        logger: silentLogger('test'),
        getFeedUrl: () => FEED_URL,
        downloadDir: dir,
        currentVersion: '1.0.0',
        fetchImpl: fetched.fetchImpl,
        downloadGet: getImpl,
      });

      await instance.check();
      const status = await instance.download();

      if (accepted) {
        expect(status.state, `${label} was refused (${status.message})`).toBe('ready');
        // Two requests: the one the feed named, and the hop — at the URL the
        // header resolved to, not the header text.
        expect(requests, `${label} was not requested as the hop it resolved to`).toEqual([
          REDIRECTING,
          resolved,
        ]);
        expect(readFileSync(join(dir, 'UCAD-setup.exe'), 'utf8'), label).toBe(genuine);
      } else {
        expect(status.state, `${label} was followed to the end`).toBe('error');
        expect(status.message, `${label} was refused without saying why`).toContain(message);
        // Which hop, by number: the count the server chose. A refusal that says
        // only "更新失败" leaves a publisher with nothing to look at.
        expect(status.message, `${label} did not name the hop`).toContain('第 1 次跳转');
        // One request — the one the feed named. A second would mean the hop was
        // requested before it was judged.
        expect(requests, `${label} was requested before the rule answered`).toEqual([REDIRECTING]);
        expect(
          existsSync(join(dir, 'UCAD-setup.exe')),
          `${label} left a staged file behind under the name that means "pending update"`,
        ).toBe(false);
      }

      // Each case gets its own staging directory, so one accepted case cannot
      // leave the file that makes a later refused case look like it wrote one.
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
    }
  });
});

describe('the release feed a publisher uploads', () => {
  it('carries the hash and the size of the file it names', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ucad-release-'));
    try {
      const installer = join(dir, 'UCAD-Setup-9.9.9.exe');
      const bytes = 'the genuine installer';
      writeFileSync(installer, bytes);

      const document = await buildFeedDocument({
        version: '9.9.9',
        installerPath: installer,
      });

      expect(document.version).toBe('9.9.9');
      expect(document.sha256).toBe(sha256Of(bytes));
      expect(document.size).toBe(bytes.length);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * The feed is the root of the verification chain.
   *
   * `verifyInstaller()` compares the staged bytes against the document, so a
   * feed whose `sha256` was computed over something other than the bytes it
   * points at makes *every* download fail — and a feed whose `size` came from a
   * different file makes the size check refuse a file the hash would have
   * accepted. Both figures are therefore recomputed here from the file on disk,
   * by a deliberately naive second implementation (one `createHash` over the
   * whole buffer), and the document the script produced is then handed to the
   * verifier the app uses. A field that the script and the app disagree about
   * is what this pair of cases is for; neither is a re-run of the script.
   */
  function installerFixture(dir: string): { installer: string; bytes: Buffer } {
    // Larger than one stream chunk, so the script's streamed hash is exercised
    // as a stream rather than as a single read.
    const bytes = Buffer.alloc(200_000);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 7) % 251;
    const installer = join(dir, 'UCAD-Setup-9.9.9.exe');
    writeFileSync(installer, bytes);
    return { installer, bytes };
  }

  it('hashes and sizes the exact bytes it names, and the app verifies them', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ucad-feed-script-'));
    try {
      const { installer, bytes } = installerFixture(dir);
      const document = await buildFeedDocument({ version: '9.9.9', installerPath: installer });

      const independent = createHash('sha256').update(bytes).digest('hex');
      expect(document.sha256, 'the feed published a digest of something else').toBe(independent);
      expect(document.size, 'the feed published the wrong size').toBe(bytes.length);
      expect(statSync(installer).size, 'the file changed while it was being hashed').toBe(
        document.size,
      );
      // The digest the script writes has to be one the app's normaliser accepts;
      // an uppercase or prefixed spelling would reach the download path as
      // `no-hash` and refuse an update the publisher thought was fine.
      expect(normalizeSha256(document.sha256)).toBe(independent);

      // End to end: the document the script produced, against the file it
      // describes, through the verifier the download uses.
      expect(
        await verifyInstaller(installer, { sha256: document.sha256, size: document.size }),
      ).toEqual({ ok: true, sha256: independent, bytes: bytes.length });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('goes red when one byte of the published file changes, at the same length', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ucad-feed-tamper-'));
    try {
      const { installer, bytes } = installerFixture(dir);
      const document = await buildFeedDocument({ version: '9.9.9', installerPath: installer });

      // One flipped byte in the middle: the length is untouched, so the size
      // check cannot be the thing that notices, and the file is not replaced —
      // it is the same path the feed's digest was taken from.
      const tampered = Buffer.from(bytes);
      tampered[Math.floor(tampered.length / 2)] ^= 0xff;
      writeFileSync(installer, tampered);

      const tamperedDigest = createHash('sha256').update(tampered).digest('hex');
      expect(document.sha256, 'the feed digest of the original matches the tampered bytes').not.toBe(
        tamperedDigest,
      );
      expect(statSync(installer).size, 'the fixture changed the length, not just a byte').toBe(
        document.size,
      );

      expect(
        await verifyInstaller(installer, { sha256: document.sha256, size: document.size }),
      ).toEqual({
        ok: false,
        reason: 'hash-mismatch',
        expected: document.sha256,
        actual: tamperedDigest,
        bytes: bytes.length,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('points at the release, not at "latest"', () => {
    // A feed published as v1.0.0 pointed at `releases/latest/download/…`,
    // which resolves while 1.0.0 is the newest release and 404s the moment
    // 1.1.0 is published.
    const url = installerUrlFor('1.1.0', 'UCAD-Setup-1.1.0.exe');
    expect(url).toContain('/releases/download/v1.1.0/');
    expect(url).not.toContain('/latest/');
  });
});

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const MAIN_SOURCE = join(REPO_ROOT, 'apps', 'desktop', 'src', 'main');
const UPDATE_FEED_SOURCE = join(MAIN_SOURCE, 'update-feed.ts');

/**
 * Source text with every comment blanked, byte positions preserved.
 *
 * The scans below ask questions about *code* — is this seam passed, does this
 * call site exist — and the files they read explain themselves in long doc
 * comments that name the very identifiers being searched for. Blanking
 * comments instead of deleting them keeps every index (and therefore every
 * line number in a failure message) pointing at the original source. Strings
 * and template literals are kept: a seam hidden in a string is still a source
 * fact worth seeing, and the product code uses them for paths and log lines.
 *
 * This used to be a local walk, with a blind spot written down instead of
 * fixed: a regex literal containing `//` was read as the start of a comment,
 * and the rest of that line was blanked. Here the doc comment said the gate
 * "would then be silent — a blind spot stated here rather than discovered
 * later", and silent is exactly what a scan must not be: a
 * `new UpdateService({ beforeLaunch })` written after such a literal was a
 * construction the scan never saw, so the seam it exists to forbid was passed
 * with every test green. `app-container-started.test.ts` had a copy of the
 * same walk, and in *that* copy the loss was loud (its count disagreed). Two
 * copies, one silent: the walk now lives in `source-scan.ts`, recognises regex
 * literals, and both gates read it there. The fixtures below drive the shape
 * the local copy lost.
 */
const blankComments = blankCommentsShared;

/** One source file the production-wiring scan reads. */
interface SourceFile {
  readonly path: string;
  readonly source: string;
}

/** One constructor call, with the line it starts on and its argument text. */
interface Construction {
  readonly path: string;
  readonly line: number;
  readonly options: string;
}

/**
 * Every `new <ClassName>(…)` in a source file, with its argument text.
 *
 * The argument is sliced by matching parentheses rather than by taking the
 * rest of the line, because the option object is written across several lines
 * and a one-line rule would read only its first line. Quotes are skipped so a
 * `)` in a string does not end the call early.
 *
 * A call whose parentheses never close is reported with the rest of the file
 * as its argument — a malformed call site is a source defect the gate should
 * surface, not a reason to read nothing.
 */
function constructionsIn(file: SourceFile, className: string): Construction[] {
  const code = blankComments(file.source);
  const needle = `new ${className}(`;
  const found: Construction[] = [];
  let from = 0;
  for (;;) {
    const start = code.indexOf(needle, from);
    if (start === -1) return found;

    const open = start + needle.length - 1;
    let depth = 0;
    let quote: string | null = null;
    let end = -1;
    for (let i = open; i < code.length; i += 1) {
      const ch = code[i]!;
      if (quote !== null) {
        if (ch === '\\') i += 1;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') {
        quote = ch;
        continue;
      }
      if (ch === '(') depth += 1;
      else if (ch === ')') {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }

    found.push({
      path: file.path,
      line: code.slice(0, start).split('\n').length,
      options: code.slice(open + 1, end === -1 ? code.length : end),
    });
    from = end === -1 ? code.length : end + 1;
  }
}

/**
 * What the constructor scan found wrong with one `new UpdateService(…)`, and
 * where.
 *
 * Two reasons, because two different edits land a seam in production:
 *
 *  - `opens-the-seam` — the options pass `beforeLaunch` outright;
 *  - `unreadable-options` — the options are not an object literal, so the scan
 *    cannot tell whether the seam is inside them.
 */
interface ConstructionProblem {
  readonly path: string;
  readonly line: number;
  readonly reason: 'opens-the-seam' | 'unreadable-options';
}

/**
 * Whether the argument text is an object literal the scan can actually read.
 *
 * Two things disqualify it, and both are the shapes a refactor produces:
 *
 *  - anything that is not `{…}` at all — `new UpdateService(options)`,
 *    `new UpdateService(makeOptions())`, `new UpdateService()`. The seam can
 *    be inside a value the scan never sees, so "I cannot read this" has to be
 *    a failure rather than silence;
 *  - an object literal that spreads: `{ ...sharedOptions, logger }`. The
 *    braces are there and the seam is still invisible, which makes this the
 *    one spelling a syntax-only check would wave through.
 */
function readableOptions(options: string): boolean {
  const trimmed = options.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return false;
  return !/(?:^|[\s,{[])\s*\.\.\./.test(trimmed);
}

/**
 * Everything wrong with the main-process constructions, as `file:line` plus a
 * reason a reader can act on.
 *
 * `beforeLaunch` exists so a gate can interleave with the window between the
 * digest and `openPath`; production deliberately passes nothing (see the seam
 * in `update-service.ts`). A value reaching it in the main process would make
 * the app run code of its own between verifying and launching an installer —
 * a production backdoor that only a comment currently forbids.
 *
 * The second reason is the scan's own blind spot, turned into a failure. The
 * scan used to filter on `/\bbeforeLaunch\b/` and nothing else, which is
 * fail-open in the one direction that matters: a call site that passes
 * `makeOptions()` — or spreads a shared bag — contains no `beforeLaunch` text
 * and would have been *skipped*, so a refactor could move the seam behind a
 * helper and keep this gate green. `update-service.ts` says the scan is
 * fail-closed; this is the function that makes that true.
 */
function constructionProblems(files: readonly SourceFile[]): ConstructionProblem[] {
  return files.flatMap((file) =>
    constructionsIn(file, 'UpdateService').flatMap((construction) => {
      const problems: ConstructionProblem[] = [];
      if (!readableOptions(construction.options)) {
        problems.push({
          path: construction.path,
          line: construction.line,
          reason: 'unreadable-options',
        });
      }
      if (/\bbeforeLaunch\b/.test(construction.options)) {
        problems.push({ path: construction.path, line: construction.line, reason: 'opens-the-seam' });
      }
      return problems;
    }),
  );
}

/** The fix a reader needs for one problem, in the words a failure should use. */
function constructionFix(reason: ConstructionProblem['reason']): string {
  return reason === 'opens-the-seam'
    ? 'the seam is for tests only — remove it from the constructor call, or drive the window from update-integrity.test.ts'
    : 'write the options as an object literal at the call site (no spread, no helper): the scan cannot see a beforeLaunch inside a value it cannot read';
}

/** Every `.ts` file under `apps/desktop/src/main`, repo-relative and read. */
function mainSources(dir: string = MAIN_SOURCE): SourceFile[] {
  return readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return mainSources(full);
      if (!entry.name.endsWith('.ts')) return [];
      return [
        {
          path: relative(REPO_ROOT, full).split(sep).join('/'),
          source: readFileSync(full, 'utf8'),
        },
      ];
    });
}

describe('the production wiring never opens the launch-test seam', () => {
  it('reports a construction that passes beforeLaunch, with file and line', () => {
    // The concrete edit the gate exists for: a value reaches the seam where
    // production used to pass none. The file and line are in the failure so
    // the reader is sent to the call site, not to the seam's definition.
    const source = [
      "import { UpdateService } from './update-service';",
      '',
      'export const service = new UpdateService({',
      '  logger,',
      '  beforeLaunch: () => {},',
      '});',
    ].join('\n');

    expect(
      constructionProblems([{ path: 'apps/desktop/src/main/bootstrap.ts', source }]),
    ).toMatchObject([
      { path: 'apps/desktop/src/main/bootstrap.ts', line: 3, reason: 'opens-the-seam' },
    ]);
  });

  it('reports a call site whose options it cannot read, instead of skipping it', () => {
    // The scan's own blind spot, which the seam's comment now promises is
    // closed. `new UpdateService(makeOptions())` contains no `beforeLaunch`
    // text — a scan that only looked for the identifier would report *nothing*
    // about the one call site that could be passing anything at all, and the
    // seam could move into a helper without a single test going red.
    const source = [
      "import { makeOptions } from './update-options';",
      '',
      'export const service = new UpdateService(makeOptions());',
    ].join('\n');

    const problems = constructionProblems([{ path: 'apps/desktop/src/main/bootstrap.ts', source }]);
    expect(problems, 'a non-literal argument was skipped rather than reported').toEqual([
      { path: 'apps/desktop/src/main/bootstrap.ts', line: 3, reason: 'unreadable-options' },
    ]);
    // The failure has to name the line *and* the fix; "something is wrong in
    // bootstrap.ts" is a report the reader has to re-derive.
    expect(constructionFix(problems[0]!.reason)).toContain('object literal');

    // The other spellings of the same blind spot: no argument at all, an
    // argument that is a bare identifier, and an object literal that spreads a
    // bag the scan cannot see into. The braces are what a syntax-only check
    // would wave through, and they are not enough.
    for (const call of [
      'new UpdateService()',
      'new UpdateService(options)',
      'new UpdateService({ ...sharedOptions, logger })',
      'new UpdateService({ logger, ...sharedOptions })',
    ]) {
      expect(
        constructionProblems([{ path: 'bootstrap.ts', source: `export const s = ${call};` }]),
        `${call} was not reported as unreadable`,
      ).toEqual([{ path: 'bootstrap.ts', line: 1, reason: 'unreadable-options' }]);
    }

    // And the shape the gate has to stay quiet about, or it would be red about
    // the code it is written for: a literal with nested calls in its values.
    expect(
      constructionProblems([
        {
          path: 'bootstrap.ts',
          source: [
            'new UpdateService({',
            '  logger: ucad.logger.child(\'update\'),',
            '  getFeedUrl: () => readUpdateFeed(),',
            '})',
          ].join('\n'),
        },
      ]),
    ).toEqual([]);
  });

  it('reports a seam that follows a regex literal containing two slashes', () => {
    // The shape this scan used to lose *silently*. `/[//]/` is valid — a `/`
    // needs no escape inside a character class — and the local walk read its
    // `//` as the start of a comment and blanked the rest of the line, so a
    // construction sitting after the literal was a construction the scan never
    // saw. The old note called that "silent", which for this gate means a seam
    // could be passed with every test green; the walk now comes from
    // `source-scan.ts` and recognises the literal.
    const onOneLine = [
      "const NONCE = /[//]/; const service = new UpdateService({ logger, beforeLaunch: seam });",
    ].join('\n');
    expect(
      constructionProblems([{ path: 'apps/desktop/src/main/bootstrap.ts', source: onOneLine }]),
      'a construction after a regex literal was invisible to the scan',
    ).toEqual([
      { path: 'apps/desktop/src/main/bootstrap.ts', line: 1, reason: 'opens-the-seam' },
    ]);

    // The same literal with the options spread as a literal across lines still
    // lands on the right line, because blanking preserves every newline.
    const acrossLines = [
      'const NONCE = /a[/]b/g;',
      'const service = new UpdateService({',
      '  logger,',
      '  beforeLaunch: seam,',
      '});',
    ].join('\n');
    expect(
      constructionProblems([{ path: 'bootstrap.ts', source: acrossLines }]),
    ).toEqual([{ path: 'bootstrap.ts', line: 2, reason: 'opens-the-seam' }]);
  });

  it('does not read a comment as a seam', () => {
    // The seam is named in the comments that explain it, including one right
    // above the production construction. Counting raw text would make the gate
    // red about its own prose; blanking comments is what keeps it about code.
    const source = [
      'new UpdateService({',
      '  /* beforeLaunch is a test seam; */',
      '  // production passes nothing here',
      '  logger,',
      '});',
    ].join('\n');

    expect(constructionProblems([{ path: 'bootstrap.ts', source }])).toEqual([]);
  });

  it('finds the real construction, and reports nothing about it', () => {
    const files = mainSources();
    const constructions = files.flatMap((file) => constructionsIn(file, 'UpdateService'));
    expect(
      constructions.length,
      'no production UpdateService construction was found, so this gate proves nothing',
    ).toBeGreaterThan(0);
    expect(
      constructions.some((construction) => construction.path.endsWith('/bootstrap.ts')),
      'bootstrap.ts no longer constructs UpdateService; the scan is reading the wrong tree',
    ).toBe(true);

    const problems = constructionProblems(files);
    expect(
      problems,
      `the production constructions have ${problems.length} problem(s): ${problems
        .map((problem) => `${problem.path}:${problem.line} ${problem.reason} — ${constructionFix(problem.reason)}`)
        .join('; ')}`,
    ).toEqual([]);
  });
});

/**
 * Claims the `FileIdentity` doc comment has to keep making.
 *
 * The type cannot close the window it describes — an in-place rewrite that
 * preserves the inode, the length and the timestamp is indistinguishable from
 * the original to any `stat` — and it says so on purpose instead of implying
 * completeness. That paragraph is the only place a reader learns the claim is
 * bounded. Deleting it (or rewriting it into "fully closed") would leave every
 * behavioural test green and a future reader believing the updater cannot be
 * raced at all.
 *
 * This is a documentation gate, not a security gate: it keeps the *admission*
 * in the file. The matching is by concept, not by sentence, so editing the
 * wording is fine; removing the fact is not.
 */
const FILE_IDENTITY_CAVEATS: ReadonlyArray<{
  readonly claim: string;
  readonly pattern: RegExp;
}> = [
  {
    claim: 'an in-place rewrite that keeps the inode is a residual window',
    pattern: /in-place rewrite[\s\S]{0,160}?inode/i,
  },
  {
    claim: 'the window needs the length and the timestamp unchanged, not just the inode',
    pattern: /(?:length|size)[\s\S]{0,160}?timestamp/i,
  },
  {
    claim: 'a `stat` cannot distinguish that rewrite from the original file',
    pattern: /\bstat\b/i,
  },
  {
    claim: 're-hashing would move the window rather than close it',
    pattern: /re-?hash[\s\S]{0,240}?(?:not close|moves? the window)/i,
  },
];

/** The doc comment immediately above `export interface FileIdentity`, or `''`. */
function identityCaveat(source: string): string {
  const declaration = source.indexOf('export interface FileIdentity');
  if (declaration === -1) return '';
  const start = source.lastIndexOf('/**', declaration);
  if (start === -1) return '';
  // The comment has to *end* immediately above the declaration; otherwise this
  // would read an earlier function's doc and call it the interface's caveat.
  const candidate = source.slice(start, declaration).trimEnd();
  return candidate.endsWith('*/') ? candidate : '';
}

/** Which documented limits are no longer in the caveat, in the words to restore. */
function missingIdentityCaveats(source: string): string[] {
  const caveat = identityCaveat(source);
  if (caveat === '') {
    return ['the doc comment above `export interface FileIdentity`'];
  }
  return FILE_IDENTITY_CAVEATS.filter(({ pattern }) => !pattern.test(caveat)).map(
    ({ claim }) => claim,
  );
}

describe('the residual identity window is still written down', () => {
  const updateFeed = existsSync(UPDATE_FEED_SOURCE)
    ? readFileSync(UPDATE_FEED_SOURCE, 'utf8')
    : '';

  it('finds the FileIdentity declaration and its caveat', () => {
    // Non-vacuous: a renamed interface or a vanished doc comment would
    // otherwise make the assertions below compare two empty strings.
    expect(updateFeed, `update-feed.ts is missing (${UPDATE_FEED_SOURCE})`).not.toBe('');
    expect(
      identityCaveat(updateFeed),
      'FileIdentity no longer has a doc comment above it, so its limits are no longer stated',
    ).not.toBe('');
  });

  it('keeps every limitation the caveat admits', () => {
    const missing = missingIdentityCaveats(updateFeed);
    expect(
      missing,
      `the FileIdentity caveat no longer says: ${missing.join(
        '; ',
      )}. Restore the paragraph in update-feed.ts, or explain in this gate why the limit no longer applies`,
    ).toEqual([]);
  });

  it('is what deleting a limitation would break', () => {
    // A fixture must show the gate answering something other than `[]`, or
    // "the caveat is complete" would be indistinguishable from a reader that
    // found nothing to complain about.
    const partial = [
      '/**',
      ' * What this does not promise: an in-place rewrite that keeps the inode,',
      ' * the length and the timestamp is the same file as far as any `stat` can tell.',
      ' */',
      'export interface FileIdentity {',
      '  readonly ino: number;',
      '}',
    ].join('\n');
    expect(missingIdentityCaveats(partial)).toEqual([
      're-hashing would move the window rather than close it',
    ]);

    const complete = [
      '/**',
      ' * What this does not promise: an in-place rewrite that keeps the inode,',
      ' * the length and the timestamp is the same file as far as any `stat` can tell.',
      ' * Re-hashing would not close it; it would move the window instead.',
      ' */',
      'export interface FileIdentity {',
      '  readonly ino: number;',
      '}',
    ].join('\n');
    expect(missingIdentityCaveats(complete)).toEqual([]);

    expect(missingIdentityCaveats('export interface FileIdentity {}')).toEqual([
      'the doc comment above `export interface FileIdentity`',
    ]);
  });
});
