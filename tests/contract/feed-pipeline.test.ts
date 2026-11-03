/**
 * The release feed's two commands, run against the same bytes.
 *
 * ## Why this file exists
 *
 * `release-feed.test.ts` proves the *judgement* — each way a feed is wrong
 * produces the finding that names it. `feed-writer.test.ts` proves the writer
 * runs that judgement before it writes. Both are green, and both were green
 * while the two commands were still able to disagree, because neither one ran
 * the other: the writer was tested against imported functions, the verifier was
 * tested against imported functions, and the thing a release actually does —
 * write a file with one command, judge that file with another — was covered by
 * nothing.
 *
 * That is the shape of the original defect too. The v1.0.0 feed was written by
 * a tool that computed a hash and then published a document without one; the
 * mistake was made by one command and found by a different command, on a
 * different machine, days later. A unit test on each half would have passed
 * throughout.
 *
 * So these cases run the commands. `make-update-feed.mjs` writes a real
 * document into a temporary directory from a real file, and
 * `verify-release-feed.mjs --feed-file` judges that same file through its own
 * CLI. The assertion is the one a release needs: the bytes the writer produced
 * are bytes the verifier accepts, with no network and no published release
 * between them.
 *
 * ## Why the skip lines are asserted, not just the exit code
 *
 * `--no-installer` and `--feed-file` each leave something unchecked, and the
 * run has to say so: a `PASS` that reads the same whether or not the installer
 * was fetched is the "silent pass" this repository keeps closing elsewhere
 * (`verify-main-chain.mjs`'s `--steps`, round 3231f7a). The cases below
 * therefore demand the `[skipped]` lines and the count in the summary, so a
 * future version that quietly drops them fails here rather than in a release.
 *
 * ## The build precondition
 *
 * The verifier loads the app's rules from the built main process, so the
 * judging cases need `npm run typecheck` (or `build:main`) to have run. That is
 * the same precondition `verify-release-feed.mjs` states for an operator, and
 * it is asserted rather than skipped: a missing build has to be a red run with
 * a readable instruction, not a suite that quietly proves nothing.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const WRITER = join(REPO_ROOT, 'scripts', 'make-update-feed.mjs');
const VERIFIER = join(REPO_ROOT, 'scripts', 'verify-release-feed.mjs');
const APP_RULES_BUILD = join(REPO_ROOT, 'apps', 'desktop', 'dist', 'main', 'update-feed.js');

/** Whether the verifier can load the app's rules in this checkout. */
const RULES_BUILT = existsSync(APP_RULES_BUILD);

/** One command's outcome, exit code included. */
interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

const tempDirs: string[] = [];

/** A directory that goes away after each case. */
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ucad-feed-pipeline-'));
  tempDirs.push(dir);
  return dir;
}

/** An installer stand-in: the bytes do not matter, their digest does. */
function installerIn(dir: string, name = 'UCAD-Setup-9.9.9.exe'): string {
  const path = join(dir, name);
  writeFileSync(path, 'not really an installer', 'utf8');
  return path;
}

/** Runs one of the two scripts; never throws on a non-zero exit. */
function run(script: string, args: string[]): RunResult {
  try {
    const stdout = execFileSync(process.execPath, [script, ...args], {
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

/**
 * Whether this run could not judge because the app's rules are not built.
 *
 * Returns true when that is what happened, after asserting the refusal was the
 * diagnosable one — the same branch `feed-writer.test.ts` takes for the writer's
 * CLI case, and for the same reason: the alternative is a `skipIf`, which is a
 * gate that does nothing on a fresh clone.
 */
function refusedForMissingBuild(result: RunResult): boolean {
  if (RULES_BUILT) return false;
  expect(result.code, 'a missing build must be a red run, not a silent pass').toBe(1);
  expect(result.stderr).toContain('not built');
  return true;
}

const openServers: Server[] = [];
const openSockets: Socket[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
  while (openSockets.length > 0) {
    openSockets.pop()?.destroy();
  }
  while (openServers.length > 0) {
    const server = openServers.pop();
    if (server) {
      server.close();
    }
  }
});

/**
 * A host that accepts the connection and then says nothing.
 *
 * This is the shape of a blocked route: the TCP connection is made, the TLS
 * handshake never completes, and the fetch sits there until the command's own
 * timeout fires. It is deterministic and offline, which is what makes the
 * timeout branch testable at all — a real unreachable host is either slow or
 * fast depending on the network the suite happens to run on.
 */
async function silentHost(): Promise<string> {
  const server = createServer((socket) => {
    openSockets.push(socket);
    socket.on('error', () => {
      /* the client aborts; that is the point of the fixture */
    });
    // Deliberately no write: a TLS handshake needs a ServerHello to finish.
  });
  openServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return `https://127.0.0.1:${address.port}/update-feed.json`;
}

describe('the document the writer writes is the document the verifier accepts', () => {
  it('takes one command’s output as the next command’s input, with no network', () => {
    const dir = tempDir();
    const installer = installerIn(dir);
    const out = join(dir, 'update-feed.json');

    const wrote = run(WRITER, ['--version', '9.9.9', '--installer', installer, '--out', out]);
    expect(wrote.code, wrote.stderr).toBe(0);

    // The writer names the command that judges its own output, on the bytes it
    // just wrote. That sentence is what turns "two halves of one rule" into a
    // pipeline an operator can run.
    expect(wrote.stdout).toContain(`--feed-file ${out}`);

    const judged = run(VERIFIER, [
      '--feed-file',
      out,
      '--expect-version',
      '9.9.9',
      '--no-installer',
    ]);
    if (refusedForMissingBuild(judged)) return;

    // The whole point of the case: the same bytes, judged by the other command.
    expect(judged.stdout).not.toContain('[FAIL]');
    expect(judged.code, judged.stdout).toBe(0);
    expect(judged.stdout).toContain('PASS');
    // The document the writer produced is *about the real file*: its size is
    // the file's size, not a number typed into a test.
    expect(JSON.parse(readFileSync(out, 'utf8')).size).toBe(statSync(installer).size);
  });

  it('says out loud which checks it did not run', () => {
    const dir = tempDir();
    const installer = installerIn(dir);
    const out = join(dir, 'update-feed.json');
    run(WRITER, ['--version', '9.9.9', '--installer', installer, '--out', out]);

    const judged = run(VERIFIER, [
      '--feed-file',
      out,
      '--expect-version',
      '9.9.9',
      '--no-installer',
    ]);
    if (refusedForMissingBuild(judged)) return;

    // Two checks are skipped here — the address rule (a file has no address)
    // and the installer fetch (--no-installer) — and both are named. A run that
    // proves less has to read differently from one that proves everything.
    expect(judged.stdout).toContain('[skipped] the feed address rule');
    expect(judged.stdout).toContain('[skipped] the installer URL');
    expect(judged.stdout).toContain('2 check(s) did not run');
  });

  it('judges the same bytes against a different build version and turns red', () => {
    const dir = tempDir();
    const installer = installerIn(dir);
    const out = join(dir, 'update-feed.json');
    run(WRITER, ['--version', '9.9.9', '--installer', installer, '--out', out]);

    // `--expect-version` is the release question — "is this feed for the build
    // I am shipping" — so the same document must be red when the answer is no.
    const judged = run(VERIFIER, [
      '--feed-file',
      out,
      '--expect-version',
      '1.0.0',
      '--no-installer',
    ]);
    if (refusedForMissingBuild(judged)) return;

    expect(judged.code).toBe(1);
    expect(judged.stdout).toContain('version-mismatch');
  });
});

describe('a document that would break the release is red through the same command', () => {
  it('fails the feed published on v1.0.0, naming both defects', () => {
    const dir = tempDir();
    const out = join(dir, 'update-feed.json');
    // The document on the release, verbatim, written by hand because that is
    // how it was produced: no hash, no size, and a `latest` URL.
    writeFileSync(
      out,
      `${JSON.stringify(
        {
          version: '1.0.0',
          notes: 'First release published on GitHub Releases.',
          url: 'https://github.com/castorhrio/jev-pi-agent/releases/latest/download/UCAD-Setup-1.0.0.exe',
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    const judged = run(VERIFIER, [
      '--feed-file',
      out,
      '--expect-version',
      '1.0.0',
      '--no-installer',
    ]);
    if (refusedForMissingBuild(judged)) return;

    expect(judged.code).toBe(1);
    expect(judged.stdout).toContain('no-sha256');
    expect(judged.stdout).toContain('installer-latest-url');
    expect(judged.stdout).toContain('FAIL');
  });

  it('refuses a path with nothing at it instead of judging nothing', () => {
    const dir = tempDir();
    const missing = join(dir, 'update-feed.json');

    const judged = run(VERIFIER, ['--feed-file', missing, '--no-installer']);
    if (refusedForMissingBuild(judged)) return;

    // A typo in the path must not be a clean run over an empty set.
    expect(judged.code).toBe(1);
    expect(judged.stdout).toContain('feed-unreadable');
  });
});

describe('a host that does not answer is reported as such, not as a broken feed', () => {
  it('says INCOMPLETE and names the timeout, instead of blaming the feed', async () => {
    // The defect: a blocked route produced `feed-unreachable` — whose sentence
    // is "the feed could not be fetched, so every update check fails" — with
    // `This operation was aborted` as the detail. An operator reading that
    // re-uploads a feed that was fine. The run still exits 1 (it could not
    // look), but the word is `INCOMPLETE` and the finding names the window.
    const url = await silentHost();

    const judged = run(VERIFIER, ['--feed', url, '--timeout', '100']);
    if (refusedForMissingBuild(judged)) return;

    expect(judged.code, 'a run that could not look must not exit 0').toBe(1);
    expect(judged.stdout).toContain('feed-timeout');
    expect(judged.stdout).toContain('100ms');
    expect(judged.stdout).toContain('INCOMPLETE');
    // The two things that would make this the old, misleading output.
    expect(judged.stdout, 'a timeout is not a verdict on the document').not.toContain(
      'feed-unreachable',
    );
    expect(judged.stdout).not.toContain('FAIL —');
  });
});

describe('the command refuses arguments it cannot honour', () => {
  it('refuses an unknown option rather than treating it as a default', () => {
    // The misspelling of a skip flag is the dangerous one: it either runs a
    // check the operator meant to skip, or skips one they meant to run, and
    // either way reports a verdict on a question nobody asked.
    const judged = run(VERIFIER, ['--no-installers']);

    expect(judged.code).toBe(1);
    expect(judged.stderr).toContain('unknown option');
    expect(judged.stderr).toContain('--feed-file');
  });

  it('refuses two different documents named in one run', () => {
    const judged = run(VERIFIER, ['--feed', 'https://example.test/update-feed.json', '--feed-file', 'x.json']);

    expect(judged.code).toBe(1);
    expect(judged.stderr).toContain('both --feed and --feed-file');
  });
});
