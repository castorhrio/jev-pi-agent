/**
 * The upload step, as a command with a decision instead of a procedure.
 *
 * ## Why this file exists
 *
 * `docs/release/update-feed-v1.0.0.json` is the corrected feed for the release
 * that is already public, and `scripts/publish-feed.mjs` is the only thing that
 * can put it there. Both were written because the alternative was a hand-typed
 * `curl` in a terminal: two of this release's three defects were made that way —
 * a document written by one command and judged by another, days later, on
 * another machine. A release step that exists only in someone's shell history is
 * not a step anyone can review.
 *
 * So the decisions are pinned here, each in the state that matters:
 *
 *  - the committed document is one the app would act on (judged with the app's
 *    own rules, not a second copy of them);
 *  - a document the app would refuse is refused *before* the token is looked
 *    for, and before any request — credentials must not be able to publish a
 *    bad feed;
 *  - `--apply` without a token says which variable it wants and uploads
 *    nothing; a dry run (the default) makes no request at all, which is
 *    asserted rather than promised, because this command deletes an asset;
 *  - with a token, the host's own `digest` for the installer is compared with
 *    the feed's `sha256` *before* anything is deleted — the comparison
 *    `verify-release-feed.mjs` cannot make without downloading 120 MB — and the
 *    bytes uploaded are the bytes on disk;
 *  - the token never reaches the output. The one thing this command handles
 *    that must not be copy-pasteable into a log file is the credential.
 *
 * `fetch` is injected, so every branch runs offline. Nothing here contacts
 * GitHub; the real replacement of the v1.0.0 asset is still blocked on write
 * access, and this file is how that step will be proven when it is not.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  KNOWN_FLAGS,
  TOKEN_VARS,
  defaultFeedPath,
  findAsset,
  installerNameFromFeedUrl,
  judgeInstallerAsset,
  publishFeed,
  releaseTagFromFeedUrl,
  repoSlugFromFeedUrl,
  tokenFromEnv,
} from '../../scripts/publish-feed.mjs';
import { judgeFeedDocument, loadAppRules } from '../../scripts/verify-release-feed.mjs';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'publish-feed.mjs');

/** The committed corrected document, exactly as it would be uploaded. */
const FEED_FILE = defaultFeedPath();

/** How the default document is named in the plan, i.e. relative to the root. */
const SCRIPT_FEED_FILE = 'docs/release/update-feed-v1.0.0.json';
const FEED_BYTES = readFileSync(FEED_FILE, 'utf8');
const FEED_DOCUMENT = JSON.parse(FEED_BYTES) as {
  version: string;
  url: string;
  sha256: string;
  size: number;
};

const TOKEN_VALUE = 'ghp_thisIsNotARealTokenItOnlyExistsInThisTest';

/** One request the injected fetch saw. */
interface Call {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string | undefined;
}

/** A response shaped like the parts of `fetch`'s that this command reads. */
function reply(body: unknown, status = 200): unknown {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
  };
}

/**
 * A GitHub stand-in: the release, its assets, and a delete that succeeds.
 *
 * `release` is what `GET releases/tags/<tag>` answers, so a test can change one
 * fact — the installer's digest, the presence of an existing feed asset — and
 * watch the decision change while everything else stays put.
 */
function fakeHost({
  digest = `sha256:${FEED_DOCUMENT.sha256}`,
  assetSize = FEED_DOCUMENT.size,
  existingFeedAssetId = 42,
  deleteStatus = 204,
  uploadStatus = 201,
}: {
  digest?: string | null;
  assetSize?: number | null;
  existingFeedAssetId?: number | null;
  deleteStatus?: number;
  uploadStatus?: number;
} = {}) {
  const calls: Call[] = [];
  const assets: Record<string, unknown>[] = [
    {
      id: 7,
      name: installerNameFromFeedUrl(FEED_DOCUMENT.url),
      size: assetSize,
      ...(digest === null ? {} : { digest }),
    },
  ];
  if (existingFeedAssetId !== null) {
    assets.push({ id: existingFeedAssetId, name: 'update-feed.json', size: 330 });
  }
  const release = { id: 1234, tag_name: 'v1.0.0', assets };

  const fetchImpl = async (url: string, init: Record<string, unknown> = {}) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    calls.push({
      url: String(url),
      method: String(init.method ?? 'GET'),
      headers,
      body: typeof init.body === 'string' ? init.body : undefined,
    });
    if (String(init.method ?? 'GET') === 'GET') return reply(release);
    if (String(init.method) === 'DELETE') return reply(null, deleteStatus);
    return reply({ id: 99, name: 'update-feed.json' }, uploadStatus);
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
  const dir = mkdtempSync(join(tmpdir(), 'ucad-publish-'));
  const path = join(dir, 'update-feed.json');
  writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  return path;
}

describe('the committed v1.0.0 document', () => {
  it('is judged by the app’s own rules as something it would install from', async () => {
    const rules = await loadAppRules();
    const findings = judgeFeedDocument(FEED_DOCUMENT, { expectedVersion: '1.0.0', rules });
    expect(findings.filter((entry: { code: string }) => entry.code !== 'no-size')).toEqual([]);
  });

  it('pins the digest and size the host reported, instead of a hand-typed guess', () => {
    expect(FEED_DOCUMENT.url).toBe(
      'https://github.com/castorhrio/jev-pi-agent/releases/download/v1.0.0/UCAD-Setup-1.0.0.exe',
    );
    expect(FEED_DOCUMENT.sha256).toBe('76bbe0c612ac67575ac40a543929a7691ba9f9e185343297cbc3badda9ea5a48');
    expect(FEED_DOCUMENT.size).toBe(122806279);
  });
});

describe('which release a feed document belongs to', () => {
  it('reads the tag out of a release-pinned installer URL', () => {
    expect(releaseTagFromFeedUrl(FEED_DOCUMENT.url)).toBe('v1.0.0');
  });

  it('refuses `latest`, because it names whatever is newest and not this release', () => {
    expect(
      releaseTagFromFeedUrl(
        'https://github.com/castorhrio/jev-pi-agent/releases/latest/download/UCAD-Setup-1.0.0.exe',
      ),
    ).toBeNull();
    expect(releaseTagFromFeedUrl('https://example.com/UCAD-Setup-1.0.0.exe')).toBeNull();
    expect(releaseTagFromFeedUrl(undefined as unknown as string)).toBeNull();
  });

  it('derives owner/repo and the installer name from the same URL', () => {
    expect(repoSlugFromFeedUrl(FEED_DOCUMENT.url)).toBe('castorhrio/jev-pi-agent');
    expect(installerNameFromFeedUrl(FEED_DOCUMENT.url)).toBe('UCAD-Setup-1.0.0.exe');
    expect(repoSlugFromFeedUrl('https://example.com/x.exe')).toBeNull();
  });
});

describe('the token', () => {
  it('is read from the first variable that is set and not blank', () => {
    expect(tokenFromEnv({ GITHUB_TOKEN: TOKEN_VALUE })).toEqual({ name: 'GITHUB_TOKEN', value: TOKEN_VALUE });
    expect(tokenFromEnv({ GITHUB_TOKEN: '  ', GH_TOKEN: TOKEN_VALUE })?.name).toBe('GH_TOKEN');
    expect(tokenFromEnv({})).toBeNull();
  });
});

describe('what the host says the installer is', () => {
  const installer = { name: 'UCAD-Setup-1.0.0.exe', size: FEED_DOCUMENT.size, digest: `sha256:${FEED_DOCUMENT.sha256}` };

  it('agrees with a feed that copied the host’s digest', () => {
    expect(judgeInstallerAsset({ document: FEED_DOCUMENT, asset: installer }).problems).toEqual([]);
  });

  it('disagrees when the digest is another file’s', () => {
    const { problems } = judgeInstallerAsset({
      document: FEED_DOCUMENT,
      asset: { ...installer, digest: `sha256:${'0'.repeat(64)}` },
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('the host says the installer is sha256=');
  });

  it('disagrees when the sizes differ, even if the digest matches', () => {
    const { problems } = judgeInstallerAsset({
      document: FEED_DOCUMENT,
      asset: { ...installer, size: FEED_DOCUMENT.size + 1 },
    });
    expect(problems[0]).toContain('size=');
  });

  it('says so out loud when the host published no digest, instead of assuming the feed is right', () => {
    const { problems, skipped } = judgeInstallerAsset({
      document: FEED_DOCUMENT,
      asset: { ...installer, digest: undefined },
    });
    expect(problems).toEqual([]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toContain('no digest');
  });

  it('says so when the release does not even have the installer asset', () => {
    expect(judgeInstallerAsset({ document: FEED_DOCUMENT, asset: null }).skipped[0]).toContain(
      'no asset with the installer name',
    );
  });
});

describe('a run that changes nothing', () => {
  it('is the default: a dry run prints the plan and makes no request', async () => {
    const { code, out, calls } = await run([]);
    expect(code).toBe(0);
    expect(calls).toEqual([]);
    expect(out).toContain('dry run');
    expect(out).toContain('[plan] DELETE');
    expect(out).toContain('update-feed.json');
  });

  it('is also a flag, so the safe mode does not have to be inferred from a doc comment', async () => {
    // No arguments and `--dry-run` must be the same run: the point of the flag
    // is that a release script (or a person reading a checklist) can *say*
    // "plan only" instead of remembering that the silent mode is the safe one.
    const implicit = await run([]);
    const explicit = await run(['--dry-run']);

    expect(explicit.code).toBe(0);
    expect(explicit.calls).toEqual([]);
    expect(explicit.err).toBe('');
    expect(explicit.out).toContain('dry run');
    // Same plan, minus the one line about whether the flag was typed.
    const plan = (text: string) => text.split('\n').filter((line) => line.startsWith('[plan]'));
    expect(plan(explicit.out)).toEqual(plan(implicit.out));
  });

  it('says which judgements will decide whether the upload counted', async () => {
    // "Will delete the asset and post these bytes" is a plan; a plan that does
    // not name the judgement sends the reader to another document to find out
    // what would still be wrong afterwards.
    const { out } = await run(['--dry-run', '--verify']);
    expect(out).toContain('[plan] check 1');
    expect(out).toContain('the app’s own feed rules');
    expect(out).toContain('[plan] check 2');
    expect(out).toContain('sha256/size');
    expect(out).toContain('[plan] check 3');
    expect(out).toContain('verify-release-feed.mjs');
    // And the byte count, so "what would be uploaded" is a number and not a name.
    expect(out).toContain(`feed: ${SCRIPT_FEED_FILE} (${Buffer.byteLength(FEED_BYTES, 'utf8')} bytes)`);
  });

  it('says out loud that the published-bytes check waits for a real upload', async () => {
    // `--verify` on a dry run must not read as "the check ran": the third
    // judgement happens after the upload, and this run stops before it.
    const { out } = await run(['--dry-run', '--verify']);
    expect(out).toContain('waits for a real upload');

    const without = await run(['--dry-run']);
    expect(without.out).toContain('check 3 is not requested');
  });

  it('writes nothing at all — not the feed, not a copy, not a log', async () => {
    // The command has a sibling flag that deletes a release asset, so "does not
    // write" is asserted against the file and its timestamp rather than trusted.
    const before = statSync(FEED_FILE);
    const { code, calls } = await run(['--dry-run', '--verify']);
    const after = statSync(FEED_FILE);

    expect(code).toBe(0);
    expect(calls).toEqual([]);
    expect(readFileSync(FEED_FILE, 'utf8')).toBe(FEED_BYTES);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it('refuses --dry-run together with --apply instead of picking one', async () => {
    // Two opposite intents on one line: whoever typed it does not know what it
    // does, and choosing for them is how a release step runs for real while the
    // person who ran it believes it only planned.
    const { code, err, out, calls } = await run(['--dry-run', '--apply'], {
      env: { GITHUB_TOKEN: TOKEN_VALUE },
    });

    expect(code).toBe(1);
    expect(calls).toEqual([]);
    expect(out).toBe('');
    expect(err).toContain('opposite things');
    expect(err).toContain('--apply --verify');
  });

  it('refuses --apply without a token, naming the variable it wants', async () => {
    const { code, err, calls } = await run(['--apply']);
    expect(code).toBe(1);
    expect(calls).toEqual([]);
    expect(err).toContain(TOKEN_VARS[0]);
    expect(err).toContain('Nothing was uploaded');
  });

  it('refuses a document the app would reject before it looks for a token', async () => {
    const broken = tempFeed({ version: '1.0.0', url: 'https://example.com/UCAD-Setup-1.0.0.exe', notes: 'x' });
    const { code, err, calls } = await run(['--apply', '--feed-file', broken], { env: { GITHUB_TOKEN: TOKEN_VALUE } });
    expect(code).toBe(1);
    expect(calls).toEqual([]);
    expect(err).toContain('no-sha256');
    // Ordering, not just the outcome: credentials must not be able to publish a
    // document the app would refuse.
    expect(err).not.toContain(TOKEN_VARS[0]);
  });

  it('refuses options it does not know, and lists the ones it does', async () => {
    const { code, err } = await run(['--aply']);
    expect(code).toBe(1);
    expect(err).toContain('unknown option(s): --aply');
    expect(err).toContain(KNOWN_FLAGS.map((name) => `--${name}`).join(', '));
  });
});

describe('replacing the published asset', () => {
  it('compares the host’s digest, then deletes, then uploads the bytes on disk', async () => {
    const host = fakeHost();
    const { code, out, calls } = await run(['--apply'], { env: { GITHUB_TOKEN: TOKEN_VALUE }, host });

    expect(code).toBe(0);
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'GET https://api.github.com/repos/castorhrio/jev-pi-agent/releases/tags/v1.0.0',
      'DELETE https://api.github.com/repos/castorhrio/jev-pi-agent/releases/assets/42',
      'POST https://uploads.github.com/repos/castorhrio/jev-pi-agent/releases/1234/assets?name=update-feed.json',
    ]);
    expect(calls[2]?.body).toBe(FEED_BYTES);
    expect(out).toContain('PASS — update-feed.json on castorhrio/jev-pi-agent v1.0.0');
  });

  it('never prints the token it was given', async () => {
    const { out, err } = await run(['--apply'], { env: { GITHUB_TOKEN: TOKEN_VALUE } });
    expect(`${out}${err}`).not.toContain(TOKEN_VALUE);
  });

  it('leaves the published document alone when the host disagrees about the installer', async () => {
    const host = fakeHost({ digest: `sha256:${'0'.repeat(64)}` });
    const { code, err, calls } = await run(['--apply'], { env: { GITHUB_TOKEN: TOKEN_VALUE }, host });
    expect(code).toBe(1);
    expect(calls.map((call) => call.method)).toEqual(['GET']);
    expect(err).toContain('digest-mismatch');
    expect(err).toContain('was left alone');
  });

  it('uploads a new asset when the release has none by that name', async () => {
    const host = fakeHost({ existingFeedAssetId: null });
    const { code, out, calls } = await run(['--apply'], { env: { GITHUB_TOKEN: TOKEN_VALUE }, host });
    expect(code).toBe(0);
    expect(calls.map((call) => call.method)).toEqual(['GET', 'POST']);
    expect(out).toContain('uploading a new one');
  });

  it('stops after a failed upload, and says the asset is gone rather than claiming success', async () => {
    const host = fakeHost({ uploadStatus: 422 });
    const { code, err } = await run(['--apply'], { env: { GITHUB_TOKEN: TOKEN_VALUE }, host });
    expect(code).toBe(1);
    expect(err).toContain('asset-upload-failed');
  });

  it('finds an asset by name, and answers null when there is none', () => {
    expect(findAsset({ assets: [{ id: 1, name: 'update-feed.json' }] }, 'update-feed.json')).toEqual({
      id: 1,
      name: 'update-feed.json',
    });
    expect(findAsset({ assets: [] }, 'update-feed.json')).toBeNull();
    expect(findAsset({}, 'update-feed.json')).toBeNull();
  });
});

describe('the command line', () => {
  it('is wired: no arguments is a dry run that exits 0', () => {
    const result = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('dry run');
  });

  it('runs a dry run when asked for one by name, and never reaches the network', () => {
    const result = spawnSync(process.execPath, [SCRIPT, '--dry-run'], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('dry run');
    expect(result.stdout).toContain('[plan] check 1');
  });

  it('exits 1 on a bad flag, so a typo is not a silent dry run', () => {
    const result = spawnSync(process.execPath, [SCRIPT, '--aply'], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('unknown option(s)');
  });
});
