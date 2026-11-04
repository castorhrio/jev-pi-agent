/**
 * `--preflight`: the question a token-holder asks before they press anything.
 *
 * ## Why this file exists
 *
 * `docs/release/REPLACE-FEED.md` hands a person with `contents: write` a page
 * they can follow top to bottom, and `scripts/publish-feed.mjs --dry-run` prints
 * the plan. Neither of them answers the question that person actually has when
 * they sit down: **is the published feed still the broken one?** `--dry-run`
 * never reads the published feed — it promises not to fetch anything — so the
 * answer used to be "compare these two documents by eye", which is how the
 * defect got into the release in the first place.
 *
 * `--preflight` reads the published document once and judges it with the same
 * `judgeFeedDocument()` call, the same rules and the same expected version that
 * `--apply` uses on the document it is about to upload. That "same" is the whole
 * value of the command, so it is what this file pins:
 *
 *  - the two judgements are the same function on the same question, so the diff
 *    compares two documents rather than two opinions — asserted by driving the
 *    published document with a different `version` and watching the *same*
 *    `version-mismatch` finding the local judgement would produce appear;
 *  - the lines it prints are `findingLine()`'s lines, not a summary of them, so
 *    its output can be read next to `verify-release-feed.mjs`'s;
 *  - it writes nothing — no asset, no file, no log — and makes exactly one
 *    request, a `GET`. This command's sibling deletes a release asset, so "does
 *    not write" is measured against the file and the request log rather than
 *    promised in a comment;
 *  - its exit code is the answer to the one question, in the direction the
 *    verdict line spells out: `0` = still broken (run `--apply`), `1` = nothing
 *    to replace;
 *  - a host that does not answer is not a verdict: nothing was compared, and the
 *    run says so instead of reporting a green or a red feed.
 *
 * `fetch` is injected, so every branch runs offline. Nothing here contacts
 * GitHub; the real replacement of the v1.0.0 asset is still blocked on write
 * access, and this file is how the step before it is proven until it is not.
 */

import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ASSET_NAME,
  KNOWN_FLAGS,
  PREFLIGHT_VERDICT,
  defaultFeedPath,
  diffFindings,
  fieldDiffLines,
  preflightLines,
  publishFeed,
  publishedFeedUrl,
} from '../../scripts/publish-feed.mjs';
import { findingLine, judgeFeedDocument, loadAppRules } from '../../scripts/verify-release-feed.mjs';

/** The committed corrected document, exactly as it would be uploaded. */
const FEED_FILE = defaultFeedPath();
const FEED_BYTES = readFileSync(FEED_FILE, 'utf8');
const FEED_DOCUMENT = JSON.parse(FEED_BYTES) as {
  version: string;
  url: string;
  sha256: string;
  size: number;
};

const SCRIPT_FEED_FILE = 'docs/release/update-feed-v1.0.0.json';
const REPO = 'castorhrio/jev-pi-agent';
const TAG = 'v1.0.0';

/**
 * The document that is actually published on the v1.0.0 release.
 *
 * Reproduced from `docs/dod-status.md`'s description of it — `version`, `notes`
 * and `url`, no `sha256`, no `size`, and a `releases/latest` installer URL. It
 * is the "before" side of every diff below, so it is written out rather than
 * fetched: the point of the command is that this shape is judged, not that this
 * machine can reach GitHub.
 */
const PUBLISHED_BROKEN = {
  version: '1.0.0',
  notes: '首个公开版本。',
  url: 'https://github.com/castorhrio/jev-pi-agent/releases/latest/download/UCAD-Setup-1.0.0.exe',
};

const TOKEN_VALUE = 'ghp_thisIsNotARealTokenItOnlyExistsInThisTest';

/** One request the injected fetch saw. */
interface Call {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
}

/**
 * A host that serves one document at the published asset URL and nothing else.
 *
 * `body` is what the asset contains; `status` is what the host answers. Anything
 * other than a `GET` on that URL is recorded and answered with a 500, so a
 * preflight that tried to delete or upload would fail loudly instead of quietly
 * passing this file.
 */
function fakeHost({
  body = JSON.stringify(PUBLISHED_BROKEN),
  status = 200,
  throws = false,
}: { body?: string; status?: number; throws?: boolean } = {}) {
  const calls: Call[] = [];
  const fetchImpl = async (url: string, init: Record<string, unknown> = {}) => {
    const method = String(init.method ?? 'GET');
    calls.push({
      url: String(url),
      method,
      headers: (init.headers ?? {}) as Record<string, string>,
    });
    if (throws) throw new Error('getaddrinfo ENOTFOUND github.com');
    const ok = status >= 200 && status < 300;
    return {
      ok,
      status,
      headers: { get: () => null },
      text: async () => body,
      json: async () => JSON.parse(body),
    };
  };
  return { calls, fetchImpl };
}

/** Runs the command in-process, capturing both streams. */
async function run(
  argv: string[],
  { env = {}, host = fakeHost() }: { env?: Record<string, string>; host?: ReturnType<typeof fakeHost> } = {},
) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await publishFeed({
    argv,
    env,
    fetchImpl: host.fetchImpl,
    out: (line: string) => out.push(line),
    err: (line: string) => err.push(line),
  });
  return { code, out: out.join('\n'), err: err.join('\n'), calls: host.calls };
}

/** A temporary feed document, for the documents that must be refused. */
function tempFeed(document: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'ucad-preflight-'));
  const path = join(dir, 'update-feed.json');
  writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  return path;
}

describe('the address the preflight reads', () => {
  it('is the asset URL the upload replaces, derived from the same two facts', () => {
    // One expression for "where the published feed is" and "which asset is
    // overwritten": two spellings of that address is how a preflight ends up
    // reading a document the upload does not touch.
    expect(publishedFeedUrl(REPO, TAG)).toBe(
      `https://github.com/${REPO}/releases/download/${TAG}/${ASSET_NAME}`,
    );
    // And it sits under the release the feed's own installer URL names, which is
    // the release `--apply` addresses.
    expect(publishedFeedUrl(REPO, TAG)).toContain(`/releases/download/${TAG}/`);
    expect(FEED_DOCUMENT.url).toContain(`/releases/download/${TAG}/`);
  });
});

describe('a preflight run', () => {
  it('reads the published document once, and writes nothing at all', async () => {
    // The sibling flag deletes a release asset, so "does not write" is measured:
    // the file's bytes and timestamp, and the request log.
    const before = statSync(FEED_FILE);
    const { code, calls } = await run(['--preflight']);
    const after = statSync(FEED_FILE);

    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('GET');
    expect(calls[0]!.url).toBe(publishedFeedUrl(REPO, TAG));
    expect(readFileSync(FEED_FILE, 'utf8')).toBe(FEED_BYTES);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it('says out loud that it wrote nothing, so the reader does not have to infer it', async () => {
    const { out } = await run(['--preflight']);
    expect(out).toContain('[preflight] writes: none — this run only read the published document');
    expect(out).toContain(`[preflight] overwrites: ${publishedFeedUrl(REPO, TAG)}`);
  });

  it('judges the published document with the same rules and the same expected version', async () => {
    // The claim the whole command rests on. The published document is driven
    // with a version that is not the local one, and the finding that appears is
    // the one `judgeFeedDocument()` produces for that question — so the two
    // sides of the diff are one judgement applied twice, not two opinions.
    const rules = await loadAppRules();
    const published = { ...PUBLISHED_BROKEN, version: '0.9.0' };
    const expected = judgeFeedDocument(published, {
      expectedVersion: FEED_DOCUMENT.version,
      rules,
    });
    const { out } = await run(['--preflight'], { host: fakeHost({ body: JSON.stringify(published) }) });

    expect(expected.map((entry: { code: string }) => entry.code)).toContain('version-mismatch');
    for (const entry of expected) {
      expect(out).toContain(findingLine(entry));
    }
  });

  it('prints both judgements in full, with the lines the verifier prints', async () => {
    // Not a summary: the reader compares this output with
    // `verify-release-feed.mjs`'s, and a "2 problems" line would be a second,
    // lossier printer of the same facts.
    const rules = await loadAppRules();
    const before = judgeFeedDocument(PUBLISHED_BROKEN, {
      expectedVersion: FEED_DOCUMENT.version,
      rules,
    });
    const { out } = await run(['--preflight']);

    expect(out).toContain(`[preflight] before: ${before.length} finding(s) on the published document`);
    for (const entry of before) {
      expect(out).toContain(findingLine(entry));
    }
    expect(out).toContain('[FAIL] no-sha256');
    expect(out).toContain('[FAIL] installer-latest-url');
    expect(out).toContain(`[preflight] after: 0 finding(s) on ${SCRIPT_FEED_FILE}`);
  });

  it('names the findings the upload fixes, and the ones it does not', async () => {
    const { out } = await run(['--preflight']);
    expect(out).toContain('[preflight] fixed by this upload: no-sha256, no-size, installer-latest-url');
    expect(out).toContain('[preflight] still there after the upload: (none)');
    expect(out).toContain('[preflight] introduced by this upload: (none)');
  });

  it('lists the fields that change, and says which ones do not', async () => {
    const { out } = await run(['--preflight']);
    expect(out).toContain('[preflight] field version: 1.0.0 (unchanged)');
    expect(out).toContain(`[preflight] field sha256: (absent) → ${FEED_DOCUMENT.sha256}`);
    expect(out).toContain(`[preflight] field size: (absent) → ${FEED_DOCUMENT.size}`);
    expect(out).toContain('[preflight] field url: https://github.com/castorhrio/jev-pi-agent/releases/latest/download/');
    expect(out).toContain(`→ ${FEED_DOCUMENT.url}`);
  });

  it('exits 0 while the published feed is still the broken one, and says which way round that is', async () => {
    // The exit code is the answer to one question, and the verdict line spells
    // it out: a code with no sentence next to it is a code the reader has to
    // look up, and this one is inverted from every other command here.
    const { code, out } = await run(['--preflight']);
    expect(code).toBe(0);
    expect(out).toContain(PREFLIGHT_VERDICT.broken);
    expect(PREFLIGHT_VERDICT.broken).toContain('exit 0 means "still broken');
  });

  it('exits 1 when the published feed is already the corrected one', async () => {
    // The other direction: running `--apply` here would be a change nobody
    // needed, so "nothing to replace" is a non-zero answer rather than a green
    // run that invites the next command.
    const { code, out } = await run(['--preflight'], { host: fakeHost({ body: FEED_BYTES }) });
    expect(code).toBe(1);
    expect(out).toContain(PREFLIGHT_VERDICT.fixed);
    expect(out).toContain('[preflight] before: 0 finding(s) on the published document');
    expect(out).toContain('[preflight] fixed by this upload: (none)');
  });

  it('treats a published document that is not JSON as a finding, not a crash', async () => {
    const { code, out } = await run(['--preflight'], { host: fakeHost({ body: '<html>404</html>' }) });
    expect(code).toBe(0);
    expect(out).toContain('[FAIL] feed-not-json');
    expect(out).toContain('bytes that do not parse');
  });

  it('does not turn a host that never answered into a verdict', async () => {
    // "The feed is fine" and "the feed was never read" must not look alike: a
    // timeout is a host result, and the reader's next move is to retry, not to
    // re-upload a feed that was fine.
    const { code, err, out } = await run(['--preflight'], { host: fakeHost({ throws: true }) });
    expect(code).toBe(1);
    expect(err).toContain('[preflight] unreachable');
    expect(err).toContain('nothing was compared and nothing was written');
    expect(out).not.toContain(PREFLIGHT_VERDICT.broken);
    expect(out).not.toContain(PREFLIGHT_VERDICT.fixed);
  });

  it('says the same thing about a host that answered with an error', async () => {
    const { code, err } = await run(['--preflight'], { host: fakeHost({ status: 404 }) });
    expect(code).toBe(1);
    expect(err).toContain('answered 404');
    expect(err).toContain('nothing was compared');
  });

  it('never prints the token it was given', async () => {
    // A private repository's asset is not anonymous, so the token is used when
    // it is there — and it is the one thing this command handles that must not
    // be copy-pasteable into a transcript.
    const { out, err, calls } = await run(['--preflight'], { env: { GITHUB_TOKEN: TOKEN_VALUE } });
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${TOKEN_VALUE}`);
    expect(out).not.toContain(TOKEN_VALUE);
    expect(err).not.toContain(TOKEN_VALUE);
    expect(out).toContain('with GITHUB_TOKEN');
  });

  it('reads anonymously when there is no token, because the read needs none', async () => {
    const { code, calls } = await run(['--preflight']);
    expect(code).toBe(0);
    expect(calls[0]!.headers.authorization).toBeUndefined();
  });

  it('refuses a document the app would reject before it reads anything', async () => {
    // The same gate `--apply` has, in the same place: a bad local document is
    // refused before the token is looked for and before any request, so a
    // preflight cannot report on a plan that would never run.
    const broken = tempFeed({ version: '1.0.0', url: 'https://example.com/UCAD-Setup-1.0.0.exe' });
    const { code, err, calls } = await run(['--preflight', '--feed-file', broken]);
    expect(code).toBe(1);
    expect(calls).toEqual([]);
    expect(err).toContain('the app’s own feed check rejects this document');
  });

  it('refuses to be combined with --apply or --dry-run', async () => {
    // Three modes with three different promises — reads the host, fetches
    // nothing, deletes an asset — and picking one for the caller is how a
    // release step runs while the person who typed it believes it only looked.
    for (const other of ['--apply', '--dry-run']) {
      const { code, err, calls } = await run(['--preflight', other], {
        env: { GITHUB_TOKEN: TOKEN_VALUE },
      });
      expect(code, other).toBe(1);
      expect(calls, other).toEqual([]);
      expect(err, other).toContain('--preflight is its own run');
    }
  });

  it('is a flag the command knows, so a document may name it', async () => {
    // `manual-check-docs.test.ts` compares every `--flag` in the release
    // documents with the script that has to accept it; this is the half that
    // makes `--preflight` legal to write down.
    expect(KNOWN_FLAGS).toContain('preflight');
  });
});

describe('the diff, as a pure function', () => {
  it('separates what the upload fixes from what it does not', () => {
    const before = [{ code: 'no-sha256' }, { code: 'no-size' }, { code: 'installer-latest-url' }];
    const after = [{ code: 'no-size' }];
    expect(diffFindings(before, after)).toEqual({
      fixed: ['no-sha256', 'installer-latest-url'],
      remaining: ['no-size'],
      introduced: [],
    });
  });

  it('names a finding the upload would introduce, instead of hiding it', () => {
    // The direction nobody expects: a document that brings a finding the
    // published one did not have makes the feed worse, and that has to be
    // visible before the upload rather than after it.
    expect(diffFindings([{ code: 'no-size' }], [{ code: 'no-size' }, { code: 'bad-sha256' }])).toEqual({
      fixed: [],
      remaining: ['no-size'],
      introduced: ['bad-sha256'],
    });
  });

  it('prints an unchanged field as unchanged rather than omitting it', () => {
    // An omitted line reads as "not checked"; `(unchanged)` reads as "checked,
    // and the upload does not touch it".
    const lines = fieldDiffLines({ version: '1.0.0', notes: 'a' }, { version: '1.0.0', notes: 'b' });
    expect(lines).toEqual([
      '[preflight] field version: 1.0.0 (unchanged)',
      '[preflight] field notes: a → b',
    ]);
  });

  it('shortens the free-text field, and nothing else', () => {
    // `notes` is the one field where a long value would push the rest of the
    // report off the screen. Every other field is compared byte for byte by the
    // reader — a truncated `url` would hide the `latest` → `download/v1.0.0`
    // change the whole command exists to show.
    const long = 'x'.repeat(200);
    const [notes] = fieldDiffLines({}, { notes: long });
    expect(notes).toContain('…');
    expect(notes!.length).toBeLessThan(140);

    const url = `https://example.com/${long}`;
    const [urlLine] = fieldDiffLines({}, { url });
    expect(urlLine).toContain(url);
  });

  it('reports a field that only one side has as absent on the other', () => {
    const lines = fieldDiffLines({ version: '1.0.0' }, { version: '1.0.0', sha256: 'ab' });
    expect(lines).toContain('[preflight] field sha256: (absent) → ab');
  });
});

describe('the report, as a pure function', () => {
  it('prints the two judgements before the diff that summarises them', () => {
    // Order matters for a reader: the findings are the evidence, the diff is the
    // conclusion. A conclusion printed first is one the reader has to take on
    // trust.
    const lines = preflightLines({
      feedFile: SCRIPT_FEED_FILE,
      publishedUrl: publishedFeedUrl(REPO, TAG),
      before: [{ code: 'no-sha256', detail: 'null' }],
      after: [],
      diff: { fixed: ['no-sha256'], remaining: [], introduced: [] },
      fields: ['[preflight] field version: 1.0.0 (unchanged)'],
    });
    const at = (needle: string) => lines.findIndex((line) => line.includes(needle));
    expect(at('[preflight] before:')).toBeLessThan(at('[preflight] fixed by this upload:'));
    expect(at('[FAIL] no-sha256')).toBeLessThan(at('[preflight] fixed by this upload:'));
    expect(at('[preflight] field version')).toBeLessThan(at('[preflight] overwrites:'));
    expect(at('[preflight] overwrites:')).toBeLessThan(at('[preflight] writes: none'));
  });
});
