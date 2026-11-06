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

/**
 * The half of the runbook that only matters on the day it goes wrong.
 *
 * `--apply` is not one write: it reads the release, deletes the old asset, then
 * uploads the new one. Every failure before the delete leaves the published
 * document untouched, and the page already said so. The failure *between* the
 * delete and the upload leaves the release with **no** `update-feed.json` at
 * all — a state worse than the broken document it replaced — and that state was
 * written nowhere a token holder would read it. The exit code is 1 either way,
 * which is exactly why the page has to say which of the two happened.
 *
 * The section is checked against the script rather than against itself: every
 * line it quotes has to still be a literal `scripts/publish-feed.mjs` prints,
 * so a reworded message cannot leave the page promising the old one — the same
 * rule `handoff-packs.test.ts` applies to the rest of this page. The recovery
 * command is checked against the sequence the status page carries, so the page
 * cannot invent a fifth command nobody documents.
 *
 * Not asserted: that the failure paths are reachable today. They need a token
 * and a release host; what is asserted is that the page describes the code that
 * is in the tree.
 */

/** The title of the failure-fallback section, as both pages spell it. */
const FAILURE_TITLE = '如果 `--apply` 中途失败';

/** The heading of the failure-fallback section. */
const FAILURE_HEADING = `## ${FAILURE_TITLE}`;

/** The sentence the section exists for: one exit code, two different states. */
const EXIT_CODE_SENTENCE = '退出码 1 不等于什么都没发生';

/** The state that is worse than the one before the run: no asset at all. */
const NO_ASSET_SENTENCE = '不存在了';

/** Lines the section quotes, each with the script that has to still print it. */
const FAILURE_QUOTES: readonly { readonly script: string; readonly text: string }[] = [
  { script: 'scripts/publish-feed.mjs', text: 'asset-delete-failed: DELETE assets/' },
  { script: 'scripts/publish-feed.mjs', text: 'the old document is still published' },
  { script: 'scripts/publish-feed.mjs', text: 'asset-upload-failed: POST assets answered' },
  { script: 'scripts/publish-feed.mjs', text: '[note] no asset named' },
  {
    // The code and the sentence are two literals in the verifier (a `finding()`
    // call and the sentence table), so the quote is the sentence: it is the half
    // a reader matches on screen.
    script: 'scripts/verify-release-feed.mjs',
    text: 'the feed could not be fetched, so every update check fails',
  },
];

/** The section, heading included; empty when it is gone. */
function failureSection(markdown: string): string {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => line.trim().startsWith(FAILURE_HEADING));
  if (start === -1) return '';
  const body: string[] = [lines[start]!];
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^#{2,3} /.test(lines[index]!)) break;
    body.push(lines[index]!);
  }
  return body.join('\n');
}

/**
 * Every way the failure-fallback section stops describing the code.
 *
 * Pure in `(documents, scriptSource)` so the red direction is driven with a
 * mutated copy: a check whose failure path has never run is a check that might
 * be reporting `[]` whatever it is handed.
 */
function failureProblems(
  documents: { replaceFeed: string; status: string },
  scriptSource: (path: string) => string,
): string[] {
  const section = failureSection(documents.replaceFeed);
  if (section.length === 0) {
    return [
      `${REPLACE_FEED_PATH}: no \`${FAILURE_HEADING}\` section — a token holder whose ` +
        '`--apply` dies between the delete and the upload has nowhere to read what the ' +
        'release is left in, and the exit code is 1 either way',
    ];
  }

  const problems: string[] = [];
  if (!section.includes(EXIT_CODE_SENTENCE)) {
    problems.push(
      `${REPLACE_FEED_PATH}: \`${FAILURE_HEADING}\` no longer says ${EXIT_CODE_SENTENCE} — ` +
        'without it the page reads as "exit 1 means nothing happened", which is false for ' +
        'the one failure that leaves the release with no feed at all',
    );
  }
  if (!section.includes(NO_ASSET_SENTENCE)) {
    problems.push(
      `${REPLACE_FEED_PATH}: \`${FAILURE_HEADING}\` does not say the published asset is gone ` +
        'after a failed upload, so the worst state the command can leave behind is the one ' +
        'state the page does not name',
    );
  }

  for (const { script, text } of FAILURE_QUOTES) {
    if (!section.includes(text)) {
      problems.push(
        `${REPLACE_FEED_PATH}: \`${FAILURE_HEADING}\` does not quote \`${text}\` — the line ` +
          `\`${script}\` prints for that failure is what the reader matches on screen`,
      );
      continue;
    }
    if (!scriptSource(script).includes(text)) {
      problems.push(
        `${REPLACE_FEED_PATH}: \`${FAILURE_HEADING}\` quotes \`${text}\`, which \`${script}\` ` +
          'no longer prints — the page and the command disagree about what the failure looks like',
      );
    }
  }

  const recovery = REHEARSAL_COMMANDS.find((command) => command.includes('--apply'));
  if (recovery === undefined) {
    problems.push('scripts/publish-feed.mjs: the sequence no longer carries an `--apply` command');
  } else if (!section.includes(recovery)) {
    problems.push(
      `${REPLACE_FEED_PATH}: \`${FAILURE_HEADING}\` does not name \`${recovery}\` as the ` +
        'recovery step — the fix for a missing asset is rerunning the command, not a rollback',
    );
  }

  const status = closingSubsection(documents.status);
  if (!status.includes(FAILURE_TITLE)) {
    problems.push(
      `${STATUS_PATH}: \`### 有令牌时\` does not point at \`${FAILURE_HEADING}\` — the page a ` +
        'token holder reads first would leave them believing every failure is a no-op',
    );
  }
  return problems;
}

describe('the runbook says what a half-finished --apply leaves behind', () => {
  const REPLACE_FEED = readFileSync(join(REPO_ROOT, REPLACE_FEED_PATH), 'utf8');
  const STATUS = readFileSync(join(REPO_ROOT, STATUS_PATH), 'utf8');
  const source = (path: string) => readFileSync(join(REPO_ROOT, path), 'utf8');

  it('describes the state the release is left in, and what to run next', () => {
    const problems = failureProblems({ replaceFeed: REPLACE_FEED, status: STATUS }, source);
    expect(
      problems,
      `the failure fallback and the code disagree:\n  ${problems.join('\n  ')}`,
    ).toEqual([]);
  });

  it('is not vacuous: the section, the quotes and the pointer are all really there', () => {
    const section = failureSection(REPLACE_FEED);
    expect(section.length, 'the failure section is gone').toBeGreaterThan(400);
    expect(section).toContain(EXIT_CODE_SENTENCE);
    for (const { text } of FAILURE_QUOTES) expect(section).toContain(text);
    expect(closingSubsection(STATUS)).toContain(FAILURE_TITLE);
  });

  it('reports a section that lost the sentence about the exit code', () => {
    const problems = failureProblems(
      { replaceFeed: REPLACE_FEED.replace(EXIT_CODE_SENTENCE, '失败时请重试'), status: STATUS },
      source,
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(REPLACE_FEED_PATH);
    expect(problems[0]).toContain(EXIT_CODE_SENTENCE);
  });

  it('reports a quote the script no longer prints', () => {
    const problems = failureProblems({ replaceFeed: REPLACE_FEED, status: STATUS }, (path) =>
      path === 'scripts/publish-feed.mjs'
        ? source(path).replace('asset-upload-failed: POST assets answered', 'upload failed')
        : source(path),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('asset-upload-failed: POST assets answered');
    expect(problems[0]).toContain('no longer prints');
  });

  it('reports a status page that stopped pointing at the section', () => {
    const problems = failureProblems(
      { replaceFeed: REPLACE_FEED, status: STATUS.replace(FAILURE_TITLE, '失败时') },
      source,
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(STATUS_PATH);
  });
});
