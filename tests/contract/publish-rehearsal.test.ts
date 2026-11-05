/**
 * `--rehearse`: the runbook, read before the day it is used.
 *
 * ## Why this file exists
 *
 * Closing 第 1 节 is four commands, and they are written in three documents
 * (`docs/dod-status.md` `### 有令牌时`, `docs/release/REPLACE-FEED.md`,
 * `docs/blockers.md` 第 1 节). `tests/contract/dod-status.test.ts` already pins
 * that the three agree on *which* commands. None of them could be run here: the
 * first needs the host, the third needs a token. So "what will these print?"
 * was a question answered by reading three pages and reconciling them — and the
 * feed that is broken today was published by exactly that method.
 *
 * `--rehearse` prints the four commands and their expected output, offline. The
 * value of the command is that its output is not a fourth copy of the runbook:
 *
 *  - the `--dry-run` block is **computed** through the same `planLines()` the
 *    real run uses, so it is compared here line for line against a real
 *    `--dry-run` — reword one and the other goes red;
 *  - the three verdict lines are **quoted** from the constants the real runs
 *    print (`PREFLIGHT_VERDICT`, `uploadPassLine()`, `summaryLine()`), so a
 *    reworded message cannot leave the rehearsal promising the old one;
 *  - it touches nothing: no request, no token read, no file written. That is
 *    measured here rather than promised in a comment, because the sibling
 *    command deletes a release asset;
 *  - it exits 0 when it printed the whole runbook and 1 when the committed
 *    document is one the app would refuse — the same judgement, before the same
 *    token lookup, as every other run.
 *
 * What it does not prove is written into its own output: the two `PASS —` lines
 * are labelled `a promise, not a measurement`. A rehearsal that read like a
 * measurement would be the defect this repository has named four times.
 */

import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DRY_RUN_TAIL,
  PREFLIGHT_VERDICT,
  REHEARSAL_COMMANDS,
  defaultFeedPath,
  publishFeed,
  rehearsalLines,
  uploadPassLine,
} from '../../scripts/publish-feed.mjs';
import { summaryLine } from '../../scripts/verify-release-feed.mjs';

const REPO_ROOT = join(import.meta.dirname, '..', '..');

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

/** The two documents the sequence is written in, and the one that summarises it. */
const STATUS_PATH = 'docs/dod-status.md';
const REPLACE_FEED_PATH = 'docs/release/REPLACE-FEED.md';
const BLOCKERS_PATH = 'docs/blockers.md';

/** A run of `publishFeed`, captured instead of printed. */
async function run(argv: string[], env: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const requests: string[] = [];
  const code = await publishFeed({
    argv,
    env,
    out: (line: string) => out.push(line),
    err: (line: string) => err.push(line),
    fetchImpl: (url: string) => {
      requests.push(String(url));
      throw new Error('the rehearsal must not touch the network');
    },
  });
  return { code, out, err, requests };
}

/**
 * The output lines of one numbered block in the rehearsal, prefix stripped.
 *
 * The block starts at `after` rather than at the numbered heading: the two lines
 * between them say what the block is (`exit 0 = …`, `expected output, computed
 * here …`), and they are the rehearsal's own prose, not the command's output.
 */
function block(lines: readonly string[], marker: string, after: string): string[] {
  const heading = lines.findIndex((line) => line.includes(marker));
  if (heading === -1) return [];
  const start = lines.findIndex((line, index) => index > heading && line.includes(after));
  if (start === -1) return [];
  const body: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line === '[rehearse]') break;
    body.push(line.replace(/^\[rehearse\] {3}/u, ''));
  }
  return body;
}

/** The command lines inside a document's fenced blocks, comments stripped. */
function fencedCommands(markdown: string): string[] {
  const found: string[] = [];
  let fenced = false;
  for (const line of markdown.split('\n')) {
    if (/^\s*```/u.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (!fenced) continue;
    const text = line.replace(/\s+#.*$/u, '').trim();
    if (!/^(?:node |GITHUB_TOKEN=)/u.test(text)) continue;
    found.push(text);
  }
  return found;
}

/** The `### 有令牌时` subsection of `docs/dod-status.md`; empty when it is gone. */
function closingSubsection(markdown: string): string {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => line.trim().startsWith('### 有令牌时'));
  if (start === -1) return '';
  const body: string[] = [lines[start]!];
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^#{2,3} /.test(lines[index]!)) break;
    body.push(lines[index]!);
  }
  return body.join('\n');
}

describe('the rehearsal prints the runbook without running it', () => {
  it('exits 0 and prints the four commands, in the order they are typed', async () => {
    const { code, out, err } = await run(['--rehearse']);
    expect(err, 'the rehearsal wrote to stderr').toEqual([]);
    expect(code).toBe(0);
    for (const [index, command] of REHEARSAL_COMMANDS.entries()) {
      const line = out.find((entry) => entry.includes(`${index + 1}/4 ${command}`));
      expect(line, `the rehearsal does not print command ${index + 1}: ${command}`).toBeDefined();
    }
    expect(out.at(-1), 'the rehearsal does not end with a verdict').toContain(
      'verdict: the runbook is complete',
    );
  });

  it('touches nothing: no request, no token read, no file written', async () => {
    const before = statSync(FEED_FILE);
    const { code, out, requests } = await run(['--rehearse'], {
      GITHUB_TOKEN: 'ghp_this_token_must_not_be_read',
    });
    expect(code).toBe(0);
    expect(requests, 'the rehearsal made a request').toEqual([]);
    // A token in the environment is not read: the plan line still says `none`,
    // because the rehearsal is the one run that has to work without one.
    expect(out.join('\n')).toContain('[plan] token: none');
    expect(out.join('\n'), 'the rehearsal printed a token').not.toContain('ghp_this_token');
    const after = statSync(FEED_FILE);
    expect(after.mtimeMs, 'the rehearsal wrote the feed document').toBe(before.mtimeMs);
    expect(readFileSync(FEED_FILE, 'utf8')).toBe(FEED_BYTES);
  });

  it('prints the dry run block the real --dry-run prints, line for line', async () => {
    const rehearsal = await run(['--rehearse']);
    const dryRun = await run(['--dry-run']);
    expect(dryRun.code).toBe(0);
    const printed = block(
      rehearsal.out,
      '2/4',
      'expected output, computed here from the committed document:',
    );
    expect(printed.length, 'the rehearsal has no dry run block').toBeGreaterThan(0);
    // The real run separates the plan from its last line with a blank line; the
    // rehearsal keeps the block contiguous, so the blank is the only difference.
    expect(printed).toEqual(dryRun.out.filter((line) => line !== ''));
    expect(printed.at(-1)).toBe(DRY_RUN_TAIL);
  });

  it('quotes the three verdict lines from the constants the real runs print', async () => {
    const { out } = await run(['--rehearse']);
    const text = out.join('\n');
    expect(text).toContain(`last line: ${PREFLIGHT_VERDICT.broken}`);
    expect(text).toContain(
      `the line that decides it: ${uploadPassLine({
        repo: REPO,
        tag: TAG,
        sha256: FEED_DOCUMENT.sha256,
      })}`,
    );
    expect(text).toContain(`the line that decides it: ${summaryLine([], [])}`);
  });

  it('says out loud which lines are promises rather than measurements', async () => {
    const { out } = await run(['--rehearse']);
    const text = out.join('\n');
    expect(text).toContain('this run touches nothing');
    expect(text).toContain('that line is a promise, not a measurement');
    expect(text).toContain('that line is a promise too');
    // The preflight block is the one that cannot be printed here at all, and it
    // says so instead of leaving a gap that reads as "nothing to see".
    expect(text).toContain('the finding lines above it come from the host');
  });

  it('is not vacuous: the blocks are the ones the documents carry', async () => {
    const { out } = await run(['--rehearse']);
    const status = closingSubsection(readFileSync(join(REPO_ROOT, STATUS_PATH), 'utf8'));
    const replaceFeed = readFileSync(join(REPO_ROOT, REPLACE_FEED_PATH), 'utf8');
    const blockers = readFileSync(join(REPO_ROOT, BLOCKERS_PATH), 'utf8');
    expect(status.length, `\`### 有令牌时\` is gone from ${STATUS_PATH}`).toBeGreaterThan(0);
    const sequence = fencedCommands(status);
    for (const command of REHEARSAL_COMMANDS) {
      expect(sequence, `${command} is not in the ${STATUS_PATH} sequence`).toContain(command);
      expect(replaceFeed, `${command} is not in ${REPLACE_FEED_PATH}`).toContain(command);
    }
    // The rehearsal is the first thing a token holder is told to type, so it is
    // the first command in the sequence and the one the blockers page names —
    // and the four it rehearses follow it, in the order it prints them.
    expect(sequence[0]).toBe('node scripts/publish-feed.mjs --rehearse');
    expect(sequence.slice(1)).toEqual([...REHEARSAL_COMMANDS]);
    expect(blockers, `${BLOCKERS_PATH} does not name the rehearsal`).toContain(
      'node scripts/publish-feed.mjs --rehearse',
    );
    // And the page that explains it carries the output, not a summary of it.
    expect(replaceFeed).toContain(out[0]!);
    expect(replaceFeed).toContain(out.at(-1)!);
  });

  it('refuses to be combined with a run that fetches, writes or uploads', async () => {
    for (const other of ['--apply', '--dry-run', '--preflight']) {
      const { code, err } = await run(['--rehearse', other]);
      expect(code, `--rehearse ${other} was accepted`).toBe(1);
      expect(err.join('\n')).toContain('--rehearse is its own run');
    }
  });

  it('exits 1 on a document the app would refuse, and prints no runbook', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ucad-rehearse-'));
    const broken = join(dir, 'update-feed.json');
    writeFileSync(
      broken,
      JSON.stringify({
        version: '1.0.0',
        url: 'https://github.com/castorhrio/jev-pi-agent/releases/latest/download/UCAD-Setup-1.0.0.exe',
        notes: 'the shape v1.0.0 was published with',
      }),
    );
    const { code, out, err } = await run(['--rehearse', '--feed-file', broken]);
    expect(code, 'a document the app refuses was rehearsed anyway').toBe(1);
    expect(out.join('\n'), 'the rehearsal printed a runbook for a refused document').not.toContain(
      '[rehearse]',
    );
    expect(err.join('\n')).toContain('the app’s own feed check rejects this document');
  });
});

describe('the rehearsal lines are one function of the document', () => {
  it('names the document it judged, and the release it belongs to', () => {
    const lines = rehearsalLines({
      feedFile: SCRIPT_FEED_FILE,
      bytes: Buffer.byteLength(FEED_BYTES, 'utf8'),
      document: FEED_DOCUMENT,
      tag: TAG,
      repo: REPO,
      plan: ['feed: x'],
    });
    expect(lines[0]).toContain(SCRIPT_FEED_FILE);
    expect(lines[0]).toContain('judged clean by the app’s own rules');
    expect(lines.join('\n')).toContain(`${REPO} ${TAG}`);
    // The plan is passed in, not rebuilt: the rehearsal shows the plan of the
    // command it is describing, and a second `planLines()` call here would be a
    // second answer to the same question.
    expect(lines).toContain('[rehearse]   feed: x');
  });
});
