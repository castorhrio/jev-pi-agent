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
 * The same page also shows the recipe that *produces* the Linux report, and
 * that recipe carries a flag the machine actually needs: `--home` with a
 * throwaway directory, because a profile left by an earlier run holds a vault
 * the fresh session cannot decrypt. Whether that flag still means what the
 * page says is not read off the script's source — a string that appears in a
 * file proves nothing about what a run does with it. So the pinning is a run:
 * the script refuses flags it does not read (`unknownFlags()` up front in
 * `main()`), the test executes the page's own command against a judge that
 * answers before anything launches and asserts it reaches the judge, then
 * executes a misspelled sibling and asserts the run refuses it *by name*
 * instead of falling back to the stale default profile. The page's reason
 * sentence is pinned to the vault gate it cites, and the red directions that
 * could silently undo the recipe are driven: the flag dropped from the page,
 * the reason cut, the typo silently swallowed, the cited gate weakened.
 *
 * The page also asks its two commands to stay one recipe: the first writes a
 * report with `--report`, the second reads that same file back with `--judge`.
 * Nothing couples them at runtime — the judge reads whatever path it is
 * handed — so the coupling is pinned here: the path the recipe writes and the
 * path the first judge command reads must be the same string, and the
 * `report-unreadable` refusal (what the presenter sees when they are not) is
 * quoted from what the command really prints for a missing file.
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

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { judgeReportCommand, unknownFlags } from '../../scripts/verify-main-chain.mjs';

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

/** The chain script, executed rather than read: the recipe's flag is pinned by what a run does. */
const CHAIN_SCRIPT = join(REPO_ROOT, 'scripts/verify-main-chain.mjs');

/** What one run of the chain script printed. */
interface ChainRun {
  /** The exit code. */
  readonly code: number;
  /** stdout and stderr combined, in the order a terminal would show them. */
  readonly output: string;
}

/**
 * Run the chain script the way the page's operator would.
 *
 * A subprocess, not an imported function: the thing being asserted is that a
 * *run* accepts the flag and reaches the judge, and an import would re-derive
 * that from the same source the old string-matching check read.
 */
function runChain(args: readonly string[]): ChainRun {
  const run = spawnSync(process.execPath, [CHAIN_SCRIPT, ...args], { encoding: 'utf8' });
  return { code: run.status ?? -1, output: `${run.stdout ?? ''}${run.stderr ?? ''}` };
}

/**
 * The page's recipe, run against a judge that answers before anything launches.
 *
 * `--judge` returns after reading one file, so the run proves flag acceptance
 * without a build, a display or a key store; `missing-step.json` is refused
 * with a sentence no other outcome prints, which makes "reached the judge"
 * observable.
 */
function chainRunWithFlag(flagName: string): ChainRun {
  const home = mkdtempSync(join(tmpdir(), 'ucad-flag-acceptance-'));
  try {
    return runChain([
      flagName,
      home,
      '--judge',
      join(REPO_ROOT, 'tests/fixtures/judge/missing-step.json'),
    ]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

/** The misspelled sibling the red direction runs against the same script. */
const TYPO_FLAG = '--homes';

/**
 * The path the recipe's `--report <path>` writes, or `null` when §7.1 no
 * longer names one.
 *
 * The `.json` suffix is on purpose: §7.1's prose talks *about* `--report`
 * without naming a path, and a pattern that matched any `--report` token
 * would read a sentence as a command.
 */
export function recipeReportPath(section: string): string | null {
  const match = /--report (\S*\.json)/.exec(section);
  return match === null ? null : match[1]!;
}

/** The path the section's first `--judge <path>` command reads, or `null`. */
export function firstJudgePath(section: string): string | null {
  const match = /--judge (\S*\.json)/.exec(section);
  return match === null ? null : match[1]!;
}

/**
 * How the two §7.1 commands fail to be one recipe, or `[]` when they agree.
 *
 * Nothing couples the pair at runtime: `--judge` judges whatever path it is
 * handed, so if the `--report` path is edited and the `--judge` path is not,
 * the demo reads a stale report (on a machine where one exists) or refuses
 * with `report-unreadable` (where none does) — and both look like the
 * demonstration working. The page must say what that refusal looks like and
 * what to do next, and claim the gate that pins the pair.
 */
export function couplingProblems(section: string): string[] {
  const problems: string[] = [];
  const report = recipeReportPath(section);
  if (report === null) {
    problems.push(
      `${CHECKLIST}: §7.1 no longer names the report the recipe writes with \`--report\` — ` +
        'the presenter is shown a judge command with nothing to judge',
    );
    return problems;
  }
  const judge = firstJudgePath(section);
  if (judge === null) {
    problems.push(
      `${CHECKLIST}: §7.1 has no \`--judge\` command reading a report, so the file the recipe ` +
        'writes is judged by nobody',
    );
    return problems;
  }
  if (judge !== report) {
    problems.push(
      `${CHECKLIST}: the recipe writes \`${report}\` but the first \`--judge\` reads \`${judge}\` — ` +
        'the two paths divorced, and the demo would judge a stale report (or refuse with ' +
        '`report-unreadable`) instead of the one it just wrote',
    );
  }
  if (!section.includes('report-unreadable')) {
    problems.push(
      `${CHECKLIST}: §7.1 no longer says what \`report-unreadable\` looks like — the presenter ` +
        'whose two paths divorced reads a refusal the page never told them about',
    );
  }
  if (!section.includes('重跑上一条')) {
    problems.push(
      `${CHECKLIST}: the report-unreadable paragraph has no next action — a refusal without ` +
        '"do this next" is a dead end on stage',
    );
  }
  if (!section.includes('改一条不改另一条当场红')) {
    problems.push(
      `${CHECKLIST}: the two paths are no longer pinned to their gate — a reader cannot tell ` +
        'the pair is asserted rather than conventionally spelled alike',
    );
  }
  return problems;
}

/**
 * The vault gate the page cites for its "refuses to overwrite" claim.
 *
 * Read as source so the citation cannot outlive the behaviour it cites: if the
 * vault test stops asserting the refusal, the page is quoting a gate that no
 * longer exists.
 */
const VAULT_TEST = readFileSync(join(REPO_ROOT, 'tests/contract/secret-vault.test.ts'), 'utf8');

/**
 * The recipe fragment the page must carry: `--home` with a throwaway directory.
 *
 * Why this exact shape: the profile's secrets vault is encrypted with the key
 * store of the session that created it, and a machine that has run the chain
 * before holds a default profile the fresh session cannot decrypt — the app
 * refuses to overwrite it (by design, gated in {@link VAULT_TEST}) and stops
 * before a window. Without the flag the demo's first line is a fatal startup
 * error, not the PASS the page promises.
 */
const FRESH_HOME = '--home "$(mktemp -d)"';

/** The reason sentence, quoted so its deletion cannot pass silently. */
const REFUSAL_CLAIM = '拒绝覆写解不开的凭据库';

/** What the page's Linux-report recipe is missing, or `[]` when it is complete. */
function recipeProblems(section: string, vaultTest: string): string[] {
  const problems: string[] = [];
  if (!section.includes(FRESH_HOME)) {
    problems.push(
      `${CHECKLIST}: the Linux-report recipe no longer carries \`${FRESH_HOME}\` — a profile ` +
        'left over from an earlier run holds a vault this session cannot decrypt, and the app ' +
        'stops before a window instead of overwriting it',
    );
  }
  if (!section.includes(REFUSAL_CLAIM)) {
    problems.push(
      `${CHECKLIST}: the recipe no longer says the app ${REFUSAL_CLAIM} — without that reason ` +
        'the flag reads as noise and the next edit drops it',
    );
  }
  if (!section.includes('tests/contract/secret-vault.test.ts')) {
    problems.push(
      `${CHECKLIST}: the refusal claim no longer cites its gate, so a reader cannot tell the ` +
        'behaviour is asserted rather than remembered',
    );
  }
  if (!vaultTest.includes('left untouched')) {
    problems.push(
      'tests/contract/secret-vault.test.ts: no longer asserts the vault is left untouched — ' +
        'the behaviour the page cites for its recipe has lost its gate',
    );
  }
  return problems;
}

/**
 * Whether the script still accepts the flag the recipe depends on, and refuses
 * a misspelled one by name.
 *
 * Both runs are passed in rather than executed here so the red direction can be
 * driven with the outcome a silent fallback would produce — a typo that gets
 * swallowed prints the judge's answer exactly as an accepted flag does, and a
 * comparison that has never seen that shape cannot be trusted to catch it.
 */
export function flagAcceptanceProblems(accepted: ChainRun, typo: ChainRun): string[] {
  const problems: string[] = [];
  const JUDGE_ANSWER = '[FAIL] step 3 is not in the report';
  if (!accepted.output.includes(JUDGE_ANSWER)) {
    problems.push(
      `${CHECKLIST}: the recipe's \`--home\` did not reach the judge — the run exited ` +
        `${accepted.code} without the step-3 refusal, so the flag the page tells the presenter ` +
        'to pass is no longer one the script answers to',
    );
  }
  if (accepted.output.includes('unknown flag')) {
    problems.push(
      `${CHECKLIST}: the recipe's \`--home\` is refused as an unknown flag — the recipe and the ` +
        'script name different flags now',
    );
  }
  if (!typo.output.includes('unknown flag')) {
    problems.push(
      `scripts/verify-main-chain.mjs: a misspelled flag (\`${TYPO_FLAG}\`) is silently ignored ` +
        'again — the run fell back to the default instead of refusing, and the demo would die ' +
        'on the stale profile instead of naming the typo',
    );
  }
  if (!typo.output.includes(TYPO_FLAG)) {
    problems.push(
      `scripts/verify-main-chain.mjs: the unknown-flag refusal does not name \`${TYPO_FLAG}\` — ` +
        'an operator told only "unknown flag" is left guessing which token was wrong',
    );
  }
  return problems;
}

describe('the fresh-profile recipe the same page shows', () => {
  it('gives the Linux-report run its own profile, with the reason and the gate named', () => {
    const problems = recipeProblems(refusalSection(CHECKLIST_TEXT), VAULT_TEST);
    expect(
      problems,
      `the defence recipe is not what the machine needs:\n  ${problems.join('\n  ')}`,
    ).toEqual([]);
  });

  it('goes red when the recipe reuses the default profile', () => {
    const stale = CHECKLIST_TEXT.replace(` ${FRESH_HOME}`, '');
    expect(stale).not.toBe(CHECKLIST_TEXT);
    const problems = recipeProblems(refusalSection(stale), VAULT_TEST);
    expect(problems.join('\n')).toContain('no longer carries');
    expect(problems.join('\n')).toContain('stops before a window');
  });

  it('goes red when the reason is cut and only the flag remains', () => {
    const bare = CHECKLIST_TEXT.replace(`**不能省**：档案里的凭据库是用创建它的那次会话的钥匙串加密的，本机以前跑过主链路，默认档案\n里那份旧凭据库在新会话里解不开，而应用的设计是${REFUSAL_CLAIM}——宁可启动失败也不\n保存（\`tests/contract/secret-vault.test.ts\`）。`, '');
    expect(bare).not.toBe(CHECKLIST_TEXT);
    const problems = recipeProblems(refusalSection(bare), VAULT_TEST);
    expect(problems.join('\n')).toContain('the flag reads as noise');
    expect(problems.join('\n')).toContain('cannot tell the');
  });

  it('goes red when the vault gate stops asserting', () => {
    // Driven against an injected copy of the real source: weakening the vault
    // test is an edit that leaves the page untouched, which is exactly why the
    // page alone cannot be trusted to keep the recipe honest.
    const weakened = VAULT_TEST.replaceAll('left untouched', 'handled');
    expect(weakened).not.toBe(VAULT_TEST);
    const vaultProblems = recipeProblems(refusalSection(CHECKLIST_TEXT), weakened);
    expect(vaultProblems.join('\n')).toContain('lost its gate');
  });
});

describe('the flag the recipe passes is one a run answers to', () => {
  it('reaches the judge, and a misspelled flag is refused by name', () => {
    const accepted = chainRunWithFlag('--home');
    const typo = chainRunWithFlag(TYPO_FLAG);
    const problems = flagAcceptanceProblems(accepted, typo);
    expect(
      problems,
      `the recipe's flag is not what a run does with it:\n  ${problems.join('\n  ')}`,
    ).toEqual([]);
  });

  it('reads every --token as a flag and every bare word as a value', () => {
    // The decision table the run-level refusal is built on, pinned where a
    // regression in the parser itself is red without spawning anything.
    expect(unknownFlags(['--home', '/tmp/x', '--judge', 'a.json', '--keep'])).toEqual([]);
    expect(unknownFlags(['--homes', '/tmp/x'])).toEqual(['homes']);
    expect(unknownFlags(['/tmp/x', 'a.json'])).toEqual([]);
  });

  it('goes red when a misspelled flag is silently swallowed again', () => {
    // The shape a regression would produce: the typo run prints exactly what
    // the accepted run prints, because `flag()` fell back to the default and
    // the run continued. The refusal sentences the script now prints are gone.
    const accepted = chainRunWithFlag('--home');
    const silentTypo: ChainRun = { code: accepted.code, output: accepted.output };
    const problems = flagAcceptanceProblems(accepted, silentTypo);
    expect(problems.join('\n')).toContain('silently ignored again');
    expect(problems.join('\n')).toContain('stale profile');
  });

  it('goes red when the recipe and the script name different flags', () => {
    // The page is left untouched in this direction; the run itself says no.
    const renamed = chainRunWithFlag('--profile');
    const typo = chainRunWithFlag(TYPO_FLAG);
    const problems = flagAcceptanceProblems(renamed, typo);
    expect(problems.join('\n')).toContain('refused as an unknown flag');
    expect(problems.join('\n')).toContain('name different flags');
  });
});

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

describe('the two §7.1 commands stay one recipe', () => {
  it('write and read the same report, and name the refusal a divorced pair produces', () => {
    const problems = couplingProblems(refusalSection(CHECKLIST_TEXT));
    expect(
      problems,
      `the recipe and the judge have come apart:\n  ${problems.join('\n  ')}`,
    ).toEqual([]);
  });

  it('report-unreadable is what the command prints for a file that is not there', () => {
    // The page quotes the prefix; this is the run that prefix comes from.
    const judged = judgeReportCommand(join(tmpdir(), `ucad-nowhere-${process.pid}.json`));
    expect(judged.code).toBe(1);
    expect(judged.lines[0]).toMatch(/^\[FAIL\] report-unreadable: /);
  });

  it('goes red when the recipe writes somewhere the judge does not read', () => {
    const divorced = CHECKLIST_TEXT.replace(
      ' --report /tmp/linux-report.json',
      ' --report /tmp/tonight-report.json',
    );
    expect(divorced).not.toBe(CHECKLIST_TEXT);
    const problems = couplingProblems(refusalSection(divorced));
    expect(problems.join('\n')).toContain('the two paths divorced');
    expect(problems.join('\n')).toContain('/tmp/tonight-report.json');
    expect(problems.join('\n')).toContain('/tmp/linux-report.json');
  });

  it('goes red when the judge reads a report the recipe did not write', () => {
    const divorced = CHECKLIST_TEXT.replace(
      'node scripts/verify-main-chain.mjs --judge /tmp/linux-report.json',
      'node scripts/verify-main-chain.mjs --judge /tmp/yesterday-report.json',
    );
    expect(divorced).not.toBe(CHECKLIST_TEXT);
    const problems = couplingProblems(refusalSection(divorced));
    expect(problems.join('\n')).toContain('the two paths divorced');
    expect(problems.join('\n')).toContain('/tmp/yesterday-report.json');
  });

  it('goes red when the unreadable refusal loses its sentence or its next action', () => {
    const unnamed = CHECKLIST_TEXT.replaceAll('report-unreadable', 'unreadable-report');
    expect(unnamed).not.toBe(CHECKLIST_TEXT);
    const unnamedProblems = couplingProblems(refusalSection(unnamed));
    expect(unnamedProblems.join('\n')).toContain('never told them about');

    const aimless = CHECKLIST_TEXT.replace('**重跑上一条**', '看看再说');
    expect(aimless).not.toBe(CHECKLIST_TEXT);
    const aimlessProblems = couplingProblems(refusalSection(aimless));
    expect(aimlessProblems.join('\n')).toContain('no next action');

    const unpinned = CHECKLIST_TEXT.replace('改一条不改另一条当场红', '两条命令写得一样');
    expect(unpinned).not.toBe(CHECKLIST_TEXT);
    const unpinnedProblems = couplingProblems(refusalSection(unpinned));
    expect(unpinnedProblems.join('\n')).toContain('asserted rather than conventionally spelled');
  });
});
