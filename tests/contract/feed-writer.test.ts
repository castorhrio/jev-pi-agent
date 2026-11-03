/**
 * The feed writer runs the feed reader's check, before the file exists.
 *
 * ## Why this file exists
 *
 * The v1.0.0 feed on GitHub Releases carries `version`, `notes` and `url` and
 * nothing else, and its URL points at `releases/latest`. Both facts were found
 * by `verify-release-feed.mjs` — on a different machine, in a later round, with
 * the release already published and counted as shipped. Two commands disagreed
 * about one document and nothing made them talk.
 *
 * `make-update-feed.mjs` was not wrong about the hash: it computes one. It was
 * wrong about being allowed to *skip*: `--url` exists so a mirror can be used,
 * and `--url` is the flag that reproduces the published document exactly —
 * `releases/latest/download/UCAD-Setup-1.0.0.exe` with no hash is one argument
 * away. There was no step between "document built" and "bytes written" that
 * asked whether the app would install from this document.
 *
 * So the writer now asks. The cases below are the two halves of that:
 *
 *  - the judgement, over documents the writer can actually produce: the one it
 *    makes by default passes, and each way `--url` (or a renamed installer) can
 *    break the release is refused **by name**, so the operator gets the same
 *    lines the verifier would have printed;
 *  - the wiring, by reading `scripts/make-update-feed.mjs`: the refusal has to
 *    happen before `writeFileSync`, because a gate that runs after the write
 *    refuses a file that is already on disk to be uploaded.
 *
 * The judgement is driven with the TypeScript sources for the app's rules, so
 * these cases need no build; the CLI case says what it asserts when the main
 * process has not been built (it asserts the precondition is diagnosable).
 * That conditional is not a `skipIf`: a gate that quietly does nothing off a
 * fresh clone is the shape this suite keeps rejecting.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildFeedDocument, feedRefusals } from '../../scripts/make-update-feed.mjs';
import { checkChannelUrl, normalizeSha256 } from '../../apps/desktop/src/main/update-feed';
import { blankComments } from './source-scan';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const WRITER = join(REPO_ROOT, 'scripts', 'make-update-feed.mjs');
const APP_RULES_BUILD = join(REPO_ROOT, 'apps', 'desktop', 'dist', 'main', 'update-feed.js');

/** The app's rules, as the command loads them — from the sources, not the build. */
const RULES = { checkChannelUrl, normalizeSha256 };

/** The codes a writer refusal produced, in order. */
function codesOf(document: unknown): string[] {
  return feedRefusals(document, RULES).map((entry) => entry.code);
}

const tempDirs: string[] = [];

/** A directory that goes away after each case. */
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ucad-feed-writer-'));
  tempDirs.push(dir);
  return dir;
}

/** An installer stand-in: the bytes do not matter, their digest does. */
function installerIn(dir: string, name = 'UCAD-Setup-9.9.9.exe', bytes = 'not really an installer'): string {
  const path = join(dir, name);
  writeFileSync(path, bytes, 'utf8');
  return path;
}

/** Runs the writer command; returns the exit code and both streams. */
function runWriter(args: string[]): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [WRITER, ...args], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '' };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { code: failure.status ?? 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('the document the writer produces by default passes the app’s own check', () => {
  it('accepts the default document, with a hash of the file and its size', async () => {
    const dir = tempDir();
    const installer = installerIn(dir);
    const document = await buildFeedDocument({ version: '9.9.9', installerPath: installer });

    expect(codesOf(document)).toEqual([]);
    // The green half has to be about the real file: the hash is of these bytes,
    // and the size is what the host will serve.
    expect(document.sha256).toBe(createHash('sha256').update('not really an installer').digest('hex'));
    expect(document.size).toBe(Buffer.byteLength('not really an installer'));
    expect(document.url).toBe(
      'https://github.com/castorhrio/jev-pi-agent/releases/download/v9.9.9/UCAD-Setup-9.9.9.exe',
    );
  });

  it('treats a `v`-prefixed version as the same release, not a second one', async () => {
    const dir = tempDir();
    const installer = installerIn(dir);
    const plain = await buildFeedDocument({ version: '9.9.9', installerPath: installer });
    const tagged = await buildFeedDocument({ version: 'v9.9.9', installerPath: installer });

    expect(tagged).toEqual(plain);
    expect(codesOf(tagged)).toEqual([]);
  });
});

describe('a document the app would refuse is never written', () => {
  it('refuses the releases/latest URL — the shape the v1.0.0 feed was published with', async () => {
    const dir = tempDir();
    const installer = installerIn(dir);
    const document = await buildFeedDocument({
      version: '9.9.9',
      installerPath: installer,
      url: 'https://github.com/castorhrio/jev-pi-agent/releases/latest/download/UCAD-Setup-9.9.9.exe',
    });

    // Named, not merely rejected: `latest` 404s the moment a newer release
    // exists, and that is the sentence the operator needs.
    expect(codesOf(document)).toEqual(['installer-latest-url']);
  });

  it('refuses a mirror that names another release', async () => {
    const dir = tempDir();
    const installer = installerIn(dir);
    const document = await buildFeedDocument({
      version: '9.9.9',
      installerPath: installer,
      url: 'https://mirror.example.test/download/v9.9.8/UCAD-Setup-9.9.9.exe',
    });

    expect(codesOf(document)).toEqual(['installer-not-this-release']);
  });

  it('refuses an installer whose file name does not carry the version', async () => {
    const dir = tempDir();
    // Precisely the mistake that survives every other check: real bytes, real
    // hash, a URL on the right release — and a file the release page will not
    // have, because electron-builder names it after the version.
    const installer = installerIn(dir, 'UCAD-Setup-copy.exe');
    const document = await buildFeedDocument({ version: '9.9.9', installerPath: installer });

    expect(codesOf(document)).toEqual(['installer-name-mismatch']);
  });

  it('refuses a cleartext mirror', async () => {
    const dir = tempDir();
    const installer = installerIn(dir);
    const document = await buildFeedDocument({
      version: '9.9.9',
      installerPath: installer,
      url: 'http://mirror.example.test/UCAD-Setup-9.9.9.exe',
    });

    expect(codesOf(document)).toEqual(['installer-not-https']);
  });

  it('refuses the feed that is actually published on v1.0.0', () => {
    // The document on the release, verbatim. This is the one case that is not
    // hypothetical: it is on GitHub, and the app installs nothing from it.
    expect(
      codesOf({
        version: '1.0.0',
        notes: 'First release published on GitHub Releases.',
        url: 'https://github.com/castorhrio/jev-pi-agent/releases/latest/download/UCAD-Setup-1.0.0.exe',
      }),
    ).toEqual(['no-sha256', 'no-size', 'installer-latest-url']);
  });
});

describe('the refusal happens before the file, and is the same rule as the verifier', () => {
  const source = readFileSync(WRITER, 'utf8');
  const code = blankComments(source);

  it('imports the judgement instead of describing it again', () => {
    expect(code, 'the writer must import the reader’s judgement').toMatch(
      /from '\.\/verify-release-feed\.mjs'/,
    );
    expect(code, 'the writer must call the judgement').toContain('judgeFeedDocument');
    // A second copy of a security rule drifts; the drift is invisible because
    // each copy passes the tests written for it.
    expect(code, 'the writer restates the SHA-256 pattern').not.toMatch(/\[0-9a-f\]\{64\}/i);
    expect(code, 'the writer restates the https rule').not.toMatch(/['"]https:['"]/);
  });

  it('checks the document before anything is written to disk', () => {
    const gate = code.indexOf('hasFailure(refusals)');
    const write = code.indexOf('writeFileSync(outPath');
    expect(gate, 'the refusal is not wired into main()').toBeGreaterThan(-1);
    expect(write, 'nothing writes the feed any more').toBeGreaterThan(-1);
    expect(gate, 'the gate runs after the write, so the bad file is already on disk').toBeLessThan(
      write,
    );
  });

  it('loads the rules the app itself runs, not a copy', () => {
    expect(code).toContain('loadAppRules()');
  });
});

describe('the command refuses out loud, and leaves no file behind', () => {
  it('exits 1 for a latest URL, writes nothing, and names the finding', async () => {
    const dir = tempDir();
    const installer = installerIn(dir);
    const out = join(dir, 'update-feed.json');

    const result = runWriter([
      '--version',
      '9.9.9',
      '--installer',
      installer,
      '--url',
      'https://github.com/castorhrio/jev-pi-agent/releases/latest/download/UCAD-Setup-9.9.9.exe',
      '--out',
      out,
    ]);

    if (!existsSync(APP_RULES_BUILD)) {
      // No built main process: the script cannot judge, and it must say so
      // rather than write an unchecked feed. Asserting the diagnosis is the
      // point — a fresh clone gets a readable instruction, not a stack trace.
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('not built');
      expect(existsSync(out)).toBe(false);
      return;
    }

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('installer-latest-url');
    expect(result.stderr).toContain('was not written');
    expect(existsSync(out)).toBe(false);
  });

  it('exits 0 for the default URL and writes a document the check accepts', async () => {
    const dir = tempDir();
    const installer = installerIn(dir);
    const out = join(dir, 'update-feed.json');

    const result = runWriter(['--version', '9.9.9', '--installer', installer, '--out', out]);
    expect(result.code, result.stderr).toBe(0);

    const written = JSON.parse(readFileSync(out, 'utf8'));
    expect(written.version).toBe('9.9.9');
    expect(written.sha256).toBe(
      createHash('sha256').update('not really an installer').digest('hex'),
    );
    expect(codesOf(written)).toEqual([]);
    // The reminder that the job is not over at "file written".
    expect(result.stdout).toContain('verify-release-feed.mjs');
  });
});
