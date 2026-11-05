/**
 * The two `--judge` samples in the Windows pack, and the command that prints them.
 *
 * ## Why this file exists
 *
 * `docs/manual-verification/README.md` shows a reader two things they will see
 * when they judge a carried-home report: a green run and a red one. Both were
 * written by hand, and both were wrong in the way hand-written output is always
 * wrong — not in the sentences (those are pinned by `handoff-packs.test.ts`,
 * which checks each quoted fragment still exists in the script's source) but in
 * the *shape of the block*:
 *
 *  - the green sample started at `PASS —` and left out the six lines the
 *    command prints before it (`report:`, `platform:`, five `step N: pass`
 *    rows). A reader who ran the command saw six lines the page had not
 *    promised and had to decide whether that meant something was wrong.
 *  - the red sample named `docs/manual-verification/win-20261105.json`, a file
 *    that does not exist, so nobody could reproduce it. The page's own rule is
 *    that a report is carried home, not invented — and then it showed an
 *    invented one as the expected output.
 *
 * Neither is a wording bug, so `handoff-packs.test.ts` could not see either:
 * every fragment it pins was present and correct. What was missing was the
 * comparison against a *run*.
 *
 * ## What is checked
 *
 * The page names a command above each sample block:
 *
 * ```
 * node scripts/verify-main-chain.mjs --judge tests/fixtures/judge/green.json
 * ```
 *
 * and the fenced block under it must be, line for line, what that command
 * prints — the same lines, in the same order, with the same exit code. The
 * fixtures under `tests/fixtures/judge/` are the reports; they are labelled as
 * fixtures inside their own `note` field, because a hand-written report sitting
 * in the repository is exactly the thing the page forbids, and the difference
 * has to be visible in the file rather than only in this comment.
 *
 * The one normalisation is the first line: the command prints the path it was
 * given, resolved, so the page shows it relative to the repository root and the
 * check strips that prefix. Everything after the path is compared verbatim.
 *
 * ## What is deliberately not asserted
 *
 * That the fixtures describe a real Windows machine. They do not, and no gate
 * can make them: `--judge` reads what a file says. What this file keeps true is
 * narrower and still worth keeping — the page shows the output the command
 * actually produces, so a reader who runs it can tell "this is the sample" from
 * "something went wrong".
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { judgeReportCommand } from '../../scripts/verify-main-chain.mjs';

const REPO_ROOT = join(import.meta.dirname, '..', '..');

/** The page that shows the samples. */
const PACK = 'docs/manual-verification/README.md';

/** The command a sample block belongs to. */
const COMMAND = 'node scripts/verify-main-chain.mjs --judge ';

/** One sample: the report the page points at, and the exit code it promises. */
interface Sample {
  /** Repository-relative path of the report fixture. */
  readonly fixture: string;
  /** The exit code the command returns for it. */
  readonly code: number;
}

/**
 * The three samples the page shows, and what each one is for.
 *
 * Three, not two: the page has to teach "a red report is a result" (the `fail`
 * fixture) *and* "a pass with nothing behind it is a claim" (the `claim`
 * fixture), and those are different reds with different next actions. Showing
 * only the first leaves the reader unable to recognise the second, which is the
 * one a hand-written report produces.
 */
const SAMPLES: readonly Sample[] = [
  // In the order the page shows them: the red a carried-home run produces
  // (section 四), the green one (section 五), then the red a hand-written
  // report produces (section 五's last subsection).
  { fixture: 'tests/fixtures/judge/fail.json', code: 1 },
  { fixture: 'tests/fixtures/judge/green.json', code: 0 },
  { fixture: 'tests/fixtures/judge/claim.json', code: 1 },
];

/** One sample block found in the page: the command it names and the lines under it. */
interface Block {
  /** The report path the command line names. */
  readonly fixture: string;
  /** The fenced block's lines, without the fences. */
  readonly lines: readonly string[];
}

/**
 * Every sample block in the page, in the order they appear.
 *
 * The convention is the one the page already uses for its other expected
 * output: a command line, then a fenced block. Reading it this way rather than
 * by heading means a block that loses its command line is a block this check
 * stops seeing — which is why `sampleProblems()` also reports a fixture the
 * page never names.
 */
export function sampleBlocks(markdown: string): Block[] {
  const lines = markdown.split('\n');
  const blocks: Block[] = [];
  // A command line inside a fence is an instruction to the reader, not a sample
  // header: the page has several of those (`--judge docs/manual-verification/…`
  // in a `bash` block). Only a bare line — optionally wrapped in backticks so it
  // reads as code — introduces a sample, and the block under it is the output.
  let fenced = false;
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index]!.trim();
    if (raw.startsWith('```')) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const line = raw.replace(/^`+/, '').replace(/`+$/, '');
    if (!line.startsWith(COMMAND)) continue;
    const fixture = line.slice(COMMAND.length).trim();
    // The fence may be the next line or a blank line away; anything else means
    // this command line is prose rather than a sample.
    let cursor = index + 1;
    while (cursor < lines.length && lines[cursor]!.trim() === '') cursor += 1;
    if (cursor >= lines.length || !lines[cursor]!.trim().startsWith('```')) continue;
    const body: string[] = [];
    cursor += 1;
    while (cursor < lines.length && !lines[cursor]!.trim().startsWith('```')) {
      body.push(lines[cursor]!);
      cursor += 1;
    }
    blocks.push({ fixture, lines: body });
    index = cursor;
  }
  return blocks;
}

/** What a run of the command prints, as the page has to show it. */
export interface Run {
  /** The lines, in the order the command writes them. */
  readonly lines: readonly string[];
  /** The exit code. */
  readonly code: number;
}

/**
 * Every way the page's samples differ from what the command prints.
 *
 * `run` is injected so the red direction can be driven with a mutated page or a
 * mutated run rather than argued about: a comparison whose failure path has
 * never executed is a comparison that might be returning `[]` whatever it is
 * handed.
 */
export function sampleProblems(
  markdown: string,
  samples: readonly Sample[],
  run: (fixture: string) => Run,
): string[] {
  const problems: string[] = [];
  const blocks = sampleBlocks(markdown);

  for (const sample of samples) {
    const block = blocks.find((entry) => entry.fixture === sample.fixture);
    if (block === undefined) {
      problems.push(
        `${PACK}: shows no sample for ${sample.fixture}, so the reader is not told what ` +
          '`--judge` prints for it',
      );
      continue;
    }
    const actual = run(sample.fixture);
    if (actual.code !== sample.code) {
      problems.push(
        `${PACK}: says ${sample.fixture} exits ${sample.code}, and the command exits ${actual.code} — ` +
          'the page is describing a verdict the command does not give',
      );
    }
    const expected = actual.lines;
    if (block.lines.length !== expected.length) {
      problems.push(
        `${PACK}: the sample for ${sample.fixture} has ${block.lines.length} line(s) and the ` +
          `command prints ${expected.length} — a reader who runs it sees lines the page did not promise`,
      );
      continue;
    }
    for (let index = 0; index < expected.length; index += 1) {
      if (block.lines[index] === expected[index]) continue;
      problems.push(
        `${PACK}: line ${index + 1} of the sample for ${sample.fixture} is ` +
          `"${block.lines[index]}" and the command prints "${expected[index]}"`,
      );
    }
  }

  for (const block of blocks) {
    if (samples.some((sample) => sample.fixture === block.fixture)) continue;
    problems.push(
      `${PACK}: shows a sample for ${block.fixture}, which is not one of the reports this check runs`,
    );
  }

  return problems;
}

/** The command's output for a fixture, with the repository root stripped from the path line. */
function runFixture(fixture: string): Run {
  const judged = judgeReportCommand(join(REPO_ROOT, fixture));
  const lines = judged.lines.map((line, index) =>
    index === 0 ? line.replace(`${REPO_ROOT}/`, '') : line,
  );
  return { lines, code: judged.code };
}

/** The page with one sample's command line and block removed. */
function dropSample(markdown: string, fixture: string): string {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => line.includes(`--judge ${fixture}`));
  if (start === -1) return markdown;
  let end = start + 1;
  while (end < lines.length && lines[end]!.trim() === '') end += 1;
  if (end < lines.length && lines[end]!.trim().startsWith('```')) {
    end += 1;
    while (end < lines.length && !lines[end]!.trim().startsWith('```')) end += 1;
    end += 1;
  }
  return [...lines.slice(0, start), ...lines.slice(end)].join('\n');
}

/** The page with the lines of one sample's block that `drop` selects removed. */
function dropLines(
  markdown: string,
  fixture: string,
  drop: (line: string) => boolean,
): string {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => line.includes(`--judge ${fixture}`));
  if (start === -1) return markdown;
  let open = start + 1;
  while (open < lines.length && lines[open]!.trim() === '') open += 1;
  if (open >= lines.length || !lines[open]!.trim().startsWith('```')) return markdown;
  let close = open + 1;
  while (close < lines.length && !lines[close]!.trim().startsWith('```')) close += 1;
  const body = lines.slice(open + 1, close).filter((line) => !drop(line));
  return [...lines.slice(0, open + 1), ...body, ...lines.slice(close)].join('\n');
}

const PACK_TEXT = readFileSync(join(REPO_ROOT, PACK), 'utf8');

describe('the `--judge` samples in the Windows pack', () => {
  it('are what the command prints, line for line', () => {
    const problems = sampleProblems(PACK_TEXT, SAMPLES, runFixture);
    expect(problems, `the pack and the command disagree:\n  ${problems.join('\n  ')}`).toEqual([]);
  });

  it('covers all three verdicts a carried-home report can have', () => {
    // Without this, deleting two of the three samples would leave the check
    // above comparing one block and passing — the page would still be green
    // while no longer teaching the reader to tell the reds apart.
    const blocks = sampleBlocks(PACK_TEXT);
    expect(blocks.map((block) => block.fixture)).toEqual(SAMPLES.map((sample) => sample.fixture));
    expect(new Set(SAMPLES.map((sample) => sample.code))).toEqual(new Set([0, 1]));
  });

  it('says which lines go to stderr, because `>` alone loses them', () => {
    // The `[FAIL]` and `FAIL —` lines are written to stderr; the rest to stdout.
    // A reader who redirects only stdout gets a block that looks like a run
    // that said nothing, which is the failure mode the pack's own `*>` note
    // exists for. The sentence is pinned here so it cannot be dropped.
    expect(PACK_TEXT).toContain('stderr');
    const judged = runFixture('tests/fixtures/judge/fail.json');
    const onStderr = judged.lines.filter(
      (line) => line.startsWith('[FAIL]') || line.startsWith('FAIL —'),
    );
    expect(onStderr.length).toBeGreaterThan(0);
    expect(judged.lines.filter((line) => line.startsWith('[note]'))).toHaveLength(1);
  });

  it('goes red when the page drops a line the command prints', () => {
    // The defect this file was written for: the green sample started at
    // `PASS —` and left out the header and the five step rows.
    const truncated = dropLines(PACK_TEXT, 'tests/fixtures/judge/green.json', (line) =>
      line.startsWith('report:') ||
      line.startsWith('platform:') ||
      /^ {2}step \d: pass$/.test(line),
    );
    expect(truncated).not.toBe(PACK_TEXT);
    const problems = sampleProblems(truncated, SAMPLES, runFixture);
    expect(problems.join('\n')).toContain('tests/fixtures/judge/green.json');
  });

  it('goes red when the page rewords a line the command prints', () => {
    const reworded = PACK_TEXT.replace(
      'FAIL — 1 thing(s) in this report keep the row open',
      'FAIL — 1 problem(s) in this report keep the row open',
    );
    expect(reworded).not.toBe(PACK_TEXT);
    const problems = sampleProblems(reworded, SAMPLES, runFixture);
    expect(problems.join('\n')).toContain('the command prints');
  });

  it('goes red when a sample is dropped from the page', () => {
    const withoutClaim = dropSample(PACK_TEXT, 'tests/fixtures/judge/claim.json');
    expect(withoutClaim).not.toBe(PACK_TEXT);
    const problems = sampleProblems(withoutClaim, SAMPLES, runFixture);
    expect(problems.join('\n')).toContain('shows no sample for tests/fixtures/judge/claim.json');
  });

  it('goes red when the page shows a report this check does not run', () => {
    const extra = `${PACK_TEXT}\n${COMMAND}tests/fixtures/judge/nowhere.json\n\n\`\`\`text\nPASS — invented\n\`\`\`\n`;
    const problems = sampleProblems(extra, SAMPLES, runFixture);
    expect(problems.join('\n')).toContain('not one of the reports this check runs');
  });
});
