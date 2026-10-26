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
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type * as http from 'node:http';
import { silentLogger } from '@ucad/observability';
import {
  checkFeedUrl,
  normalizeSha256,
  parseUpdateConfig,
  resolveUpdateFeed,
  verifyInstaller,
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
 */
function feedFetchSteps(steps: readonly FetchStep[]): {
  fetchImpl: typeof fetch;
  calls: number;
} {
  const state = { calls: 0 };
  const queue = [...steps];
  const fetchImpl = (async () => {
    state.calls += 1;
    const step = queue.shift();
    if (step === undefined) {
      throw new Error('the feed was fetched more times than the test scripted');
    }
    return new Response(step.document === undefined ? '' : JSON.stringify(step.document), {
      status: step.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, get calls() { return state.calls; } } as { fetchImpl: typeof fetch; calls: number };
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
    if (step === undefined) throw new Error(`unexpected request for ${url}`);
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

  it('accepts a file that matches', async () => {
    const bytes = 'the genuine installer';
    writeFileSync(file, bytes);

    const result = await verifyInstaller(file, { sha256: sha256Of(bytes), size: bytes.length });

    expect(result.ok).toBe(true);
  });

  it('rejects a file that was swapped in flight', async () => {
    writeFileSync(file, 'the genuine installer');
    const expected = sha256Of('the genuine installer');

    // The bytes on disk are no longer the bytes the feed described.
    writeFileSync(file, 'a different installer with the same name');

    const result = await verifyInstaller(file, { sha256: expected });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe('hash-mismatch');
  });

  it('rejects a file whose size does not match', async () => {
    writeFileSync(file, 'short');
    const result = await verifyInstaller(file, { sha256: sha256Of('short'), size: 999 });
    expect(result.ok === false && result.reason).toBe('size-mismatch');
  });

  it('says "not checked" rather than "checked" when the feed has no hash', async () => {
    writeFileSync(file, 'anything');
    const result = await verifyInstaller(file, {});
    expect(result.ok === false && result.reason).toBe('no-hash');
  });

  it('reports a file it cannot read as unreadable', async () => {
    const result = await verifyInstaller(join(dir, 'absent.exe'), { sha256: sha256Of('x') });
    expect(result.ok === false && result.reason).toBe('unreadable');
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
  }) {
    const fetched = feedFetchSteps(options.steps ?? [{ status: 200, document: options.feed ?? {} }]);
    const downloads: string[] = [];
    const launched: string[] = [];
    const download = options.download;
    const instance = new UpdateService({
      logger: silentLogger('test'),
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

  it('refuses to launch a file that was replaced after the download', async () => {
    const genuine = 'the genuine installer';
    const { instance, launched } = service({
      feed: {
        version: '9.9.9',
        url: INSTALLER_URL,
        sha256: sha256Of(genuine),
      },
      download: async (_url, target) => {
        writeFileSync(target, genuine);
      },
    });

    await instance.check();
    await instance.download();

    // The staged file lives in the user's own profile directory, between the
    // download and the click that launches it.
    writeFileSync(join(dir, 'UCAD-setup.exe'), 'replaced after the check');

    const installed = await instance.installAndRestart();

    expect(installed).toBe(false);
    expect(launched).toEqual([]);
    expect(instance.current.state).toBe('error');
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

  it('refuses a download whose checked document is gone, instead of reading the feed again', async () => {
    // The branch `download()` keeps for a status that disagrees with itself.
    // It cannot be produced today, and what is asserted is what happens *if* it
    // ever can: the download stops, says so, and above all does not fetch the
    // feed a second time. An earlier build did exactly that here, which
    // reopened the window the stored document exists to close — a second read
    // can name a different file than the version the user was shown, and the
    // hash that `installAndRestart()` re-checks comes from that same document.
    const genuine = 'the genuine installer';
    const { instance, downloads, fetchCalls } = service({
      feed: { version: '9.9.9', url: INSTALLER_URL, sha256: sha256Of(genuine) },
      download: async (_url, target) => {
        writeFileSync(target, genuine);
      },
    });

    await instance.check();
    expect(instance.current.state).toBe('available');

    forgetCheckedFeed(instance);
    const status = await instance.download();

    expect(status.state).toBe('error');
    expect(status.message).toContain('重新检查');
    expect(downloads).toEqual([]);
    // One read of the feed — the check's. The fallback used to make this two.
    expect(fetchCalls.calls).toBe(1);
    expect(existsSync(join(dir, 'UCAD-setup.exe'))).toBe(false);
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
    expect(requests).toHaveLength(6);
    expect(existsSync(join(dir, 'UCAD-setup.exe'))).toBe(false);

    const installed = await instance.installAndRestart();
    expect(installed).toBe(false);
    expect(launched).toEqual([]);
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

  it('points at the release, not at "latest"', () => {
    // A feed published as v1.0.0 pointed at `releases/latest/download/…`,
    // which resolves while 1.0.0 is the newest release and 404s the moment
    // 1.1.0 is published.
    const url = installerUrlFor('1.1.0', 'UCAD-Setup-1.1.0.exe');
    expect(url).toContain('/releases/download/v1.1.0/');
    expect(url).not.toContain('/latest/');
  });
});
