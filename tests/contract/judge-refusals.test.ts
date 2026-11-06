/**
 * The three bad reports `--judge` refuses, and the sentences it refuses them with.
 *
 * ## Why this file exists
 *
 * `docs/defense-checklist.md` §7.1 shows a presenter one refusal: a report from
 * another platform. That is one of the ways a carried-home report can be wrong,
 * and it is not the one a reviewer is most likely to ask about. "What happens if
 * the report is missing a step?" is a fair question on stage, and until this
 * file the honest answer was "it is refused too" — a claim, with no line on the
 * screen to point at.
 *
 * So the three refusals are written down as a table: one row per bad input, one
 * row per sentence the command prints for it. The table is not a transcription
 * anybody has to trust. Each row's sentence is compared, character for
 * character, with what `judgeReportCommand()` actually prints for that fixture,
 * and each fixture has to exist. Reword a refusal in the script and the page
 * goes red naming the report; delete a row and the page goes red naming the
 * report it no longer shows.
 *
 * ## Why three and not one
 *
 * The three next actions differ, which is the whole reason the judgement prints
 * three sentences instead of one "not green":
 *
 *  - a missing step is a run that has to go back and cover it;
 *  - another build is a run that has to happen again on the build being shipped;
 *  - another platform is a run that has to happen on a Windows machine.
 *
 * A page that showed only the platform refusal would teach a presenter that
 * "wrong" is one thing. It is three, and the sentence is what tells them apart.
 *
 * ## What is deliberately not asserted
 *
 * That the fixtures describe a real machine. They do not — they are documents,
 * and `--judge` reads what a document says. What is asserted is narrower and
 * still worth keeping: the page shows the sentence the command really prints,
 * so a presenter who runs it can tell "this is the sample" from "something went
 * wrong".
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { judgeReportCommand } from '../../scripts/verify-main-chain.mjs';

const REPO_ROOT = join(import.meta.dirname, '..', '..');

/** The page that shows the refusals. */
const CHECKLIST = 'docs/defense-checklist.md';

/** The subsection the table lives in. */
const SECTION_HEADING = '### 7.1';

/**
 * The three bad reports, in the order the page shows them.
 *
 * Written out rather than read off the directory: a fourth fixture dropped into
 * `tests/fixtures/judge/` is a fixture, not a promise to the presenter, and a
 * page that silently grew a row because somebody added a file would be a page
 * nobody decided the shape of.
 */
const EXPECTED = [
  'tests/fixtures/judge/missing-step.json',
  'tests/fixtures/judge/other-build.json',
  'tests/fixtures/judge/other-platform.json',
] as const;

/** One row of the page's table: the report, and the sentence it is refused with. */
interface RefusalRow {
  /** Repository-relative path of the bad report. */
  readonly fixture: string;
  /** The `[FAIL]` line the page says the command prints. */
  readonly line: string;
}

/** What a run of the command prints, as the page has to show it. */
interface Run {
  /** The lines, in the order the command writes them. */
  readonly lines: readonly string[];
  /** The exit code. */
  readonly code: number;
}

/**
 * The §7.1 subsection, or `''` when the page no longer has one.
 *
 * Bounded by the next level-1/2 heading rather than by the next heading of any
 * level: the table sits under a `####` of its own, and stopping at the first
 * heading would read an empty section and report "no rows" for a page that has
 * them.
 */
export function refusalSection(markdown: string): string {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => line.trim().startsWith(SECTION_HEADING));
  if (start === -1) return '';
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,2} /.test(line)) break;
    body.push(line);
  }
  return body.join('\n');
}

/** The fixture path a table cell names, or `null` when it names none. */
function fixtureIn(cell: string): string | null {
  const match = /tests\/fixtures\/judge\/[\w.-]+\.json/.exec(cell);
  return match === null ? null : match[0];
}

/** The sentence a table cell quotes, with the backticks a markdown cell wraps it in removed. */
function quotedLine(cell: string): string {
  return cell.trim().replace(/^`+/, '').replace(/`+$/, '').trim();
}

/**
 * Every refusal row in the section, in the order the page shows them.
 *
 * A row is a table line whose first cell names a report fixture. The header and
 * the `|---|` separator name none, so they are skipped by the same rule rather
 * than by counting lines — a table that gained a column would otherwise shift
 * every row by one.
 */
export function refusalRows(section: string): RefusalRow[] {
  const rows: RefusalRow[] = [];
  for (const line of section.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) continue;
    const cells = trimmed.replace(/^\|/, '').replace(/\|$/, '').split('|');
    if (cells.length < 2) continue;
    const fixture = fixtureIn(cells[0]!);
    if (fixture === null) continue;
    rows.push({ fixture, line: quotedLine(cells[1]!) });
  }
  return rows;
}

/**
 * Every way the page's table differs from what the command prints.
 *
 * `run` is injected so the red direction can be driven with a mutated page or a
 * mutated run rather than argued about: a comparison whose failure path has
 * never executed is a comparison that might be returning `[]` whatever it is
 * handed.
 */
export function refusalProblems(
  markdown: string,
  run: (fixture: string) => Run,
  expected: readonly string[] = EXPECTED,
): string[] {
  const problems: string[] = [];
  const section = refusalSection(markdown);
  if (section.trim().length === 0) {
    return [
      `${CHECKLIST}: has no \`${SECTION_HEADING}\` section, so the three refusals a reviewer ` +
        'asks about are not on the page the presenter reads',
    ];
  }
  const rows = refusalRows(section);

  for (const fixture of expected) {
    const row = rows.find((entry) => entry.fixture === fixture);
    if (row === undefined) {
      problems.push(
        `${CHECKLIST}: shows no refusal for ${fixture}, so the presenter has no line to read ` +
          'out when that report is refused',
      );
      continue;
    }
    const actual = run(fixture);
    if (actual.code !== 1) {
      problems.push(
        `${CHECKLIST}: says ${fixture} is refused, and the command exits ${actual.code} — ` +
          'the page is describing a verdict the command does not give',
      );
    }
    const failures = actual.lines.filter((line) => line.startsWith('[FAIL] '));
    if (failures.length !== 1) {
      problems.push(
        `${CHECKLIST}: the sample for ${fixture} is one sentence, and the command prints ` +
          `${failures.length} — a fixture that is wrong in two ways cannot be shown as one row`,
      );
      continue;
    }
    if (row.line !== failures[0]) {
      problems.push(
        `${CHECKLIST}: the refusal for ${fixture} is "${row.line}" and the command prints ` +
          `"${failures[0]}" — the page is quoting a sentence the command no longer says`,
      );
    }
  }

  for (const row of rows) {
    if (expected.includes(row.fixture)) continue;
    problems.push(
      `${CHECKLIST}: shows a refusal for ${row.fixture}, which is not one of the reports this ` +
        'check runs — a row nobody compares is a row that can say anything',
    );
  }

  return problems;
}

/** The command's output for a fixture. */
function runFixture(fixture: string): Run {
  const judged = judgeReportCommand(join(REPO_ROOT, fixture));
  return { lines: judged.lines, code: judged.code };
}

const CHECKLIST_TEXT = readFileSync(join(REPO_ROOT, CHECKLIST), 'utf8');

describe('the three refusals the defence page shows', () => {
  it('are what the command prints, character for character', () => {
    const problems = refusalProblems(CHECKLIST_TEXT, runFixture);
    expect(
      problems,
      `the page and the command disagree:\n  ${problems.join('\n  ')}`,
    ).toEqual([]);
  });

  it('are three different sentences, because the next action differs', () => {
    // Without this, three rows quoting the same sentence would pass the check
    // above — and the page would be teaching that "wrong" is one thing.
    const rows = refusalRows(refusalSection(CHECKLIST_TEXT));
    expect(rows.map((row) => row.fixture)).toEqual([...EXPECTED]);
    expect(new Set(rows.map((row) => row.line)).size).toBe(EXPECTED.length);
    for (const row of rows) expect(row.line.startsWith('[FAIL] ')).toBe(true);
  });

  it('point at reports that are in the repository', () => {
    // A row naming a file nobody can open is a sample nobody can reproduce —
    // the defect `judge-samples.test.ts` was written for, in its other form.
    for (const fixture of EXPECTED) {
      expect(existsSync(join(REPO_ROOT, fixture)), `${fixture} is missing`).toBe(true);
    }
  });

  it('goes red when the page rewords a refusal', () => {
    const reworded = CHECKLIST_TEXT.replace(
      '[FAIL] step 3 is not in the report',
      '[FAIL] step 3 is missing from the report',
    );
    expect(reworded).not.toBe(CHECKLIST_TEXT);
    const problems = refusalProblems(reworded, runFixture);
    expect(problems.join('\n')).toContain('tests/fixtures/judge/missing-step.json');
    expect(problems.join('\n')).toContain('no longer says');
  });

  it('goes red when a row is dropped from the page', () => {
    const withoutBuild = CHECKLIST_TEXT.split('\n')
      .filter((line) => !line.includes('tests/fixtures/judge/other-build.json'))
      .join('\n');
    expect(withoutBuild).not.toBe(CHECKLIST_TEXT);
    const problems = refusalProblems(withoutBuild, runFixture);
    expect(problems.join('\n')).toContain('shows no refusal for tests/fixtures/judge/other-build.json');
  });

  it('goes red when the page shows a report this check does not run', () => {
    const extra = CHECKLIST_TEXT.replace(
      '| `tests/fixtures/judge/other-platform.json`',
      '| `tests/fixtures/judge/nowhere.json`：一份不存在的报告 | `[FAIL] invented` |\n' +
        '| `tests/fixtures/judge/other-platform.json`',
    );
    expect(extra).not.toBe(CHECKLIST_TEXT);
    const problems = refusalProblems(extra, runFixture);
    expect(problems.join('\n')).toContain('not one of the reports this check runs');
  });

  it('goes red when a fixture is wrong in two ways at once', () => {
    // The page shows one sentence per row. A fixture that produces two is a
    // fixture the page cannot honestly describe, and the check says so instead
    // of comparing against whichever line came first.
    const problems = refusalProblems(CHECKLIST_TEXT, (fixture) => ({
      code: 1,
      lines:
        fixture === 'tests/fixtures/judge/missing-step.json'
          ? ['[FAIL] step 3 is not in the report', '[FAIL] the report measured build 0.9.0']
          : runFixture(fixture).lines,
    }));
    expect(problems.join('\n')).toContain('cannot be shown as one row');
  });

  it('goes red when the section is gone', () => {
    const problems = refusalProblems('# a page with no §7.1\n', runFixture);
    expect(problems.join('\n')).toContain('has no `### 7.1` section');
  });
});
