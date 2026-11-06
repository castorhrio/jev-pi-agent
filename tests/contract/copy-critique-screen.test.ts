/**
 * A judgement about a screen's wording has to be attached to the wording.
 *
 * ## Why this file exists
 *
 * `docs/copy-critique.md` judged the README against five named shapes and
 * concluded that the screens were clean. That conclusion came from `grep`: five
 * keywords, zero hits, one paragraph. It was honest about being indirect, and it
 * was still the weakest evidence in the repository — the screens are what a user
 * reads every day, and nobody had read them one string at a time.
 *
 * `docs/copy-critique-screen.md` is that reading: five screens, twenty-six
 * strings, a shape considered and a reason written for each. This file is what
 * keeps it from becoming a page about a dictionary that has since changed.
 *
 * ## What is asserted
 *
 * The page is a set of `## <n>. …` sections, each holding a four-column table
 * (`键 | 屏幕上的字 | 形状 | 判定`). This gate reads it and fails when:
 *
 *  - a screen lost its section, or a section judges fewer than
 *    {@link MIN_ROWS_PER_SCREEN} strings — "judged screen by screen" is a claim
 *    about coverage, and one row per screen is not coverage;
 *  - a row names a key that is not in **both** dictionaries — a judgement about
 *    a string no screen can show;
 *  - a row's quoted Chinese value is not the dictionary's current value, which
 *    is the whole point: re-word a screen and the judgement that was made about
 *    the old wording goes red instead of quietly describing a sentence that no
 *    longer exists (the shape `docs/copy-critique.md` itself recorded once, when
 *    a doc comment kept quoting a maxim that had been deleted);
 *  - a row uses a shape that is not one of the five in `docs/copy-critique.md`,
 *    read from that page rather than copied here — a sixth shape would make the
 *    two rounds incomparable, which is how a critique stops being one;
 *  - a verdict is neither `零命中：…` nor `命中：…`, or carries no reason — the
 *    word "clean" on its own is the thing this page was written to replace;
 *  - the summary line's two counts disagree with the table, in either direction.
 *
 * ## What it deliberately cannot see
 *
 * Whether the reasons are *good*. A row can say 「零命中：这句话不像缺口句，因为它没有先命名
 * 缺口」 and be wrong about the sentence; no test reads a sentence and decides
 * whether it sounds generated. What is checkable is narrower and worth having:
 * every string was looked at, the judgement is attached to the bytes that are
 * on screen today, and the count in the summary is the count in the table.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dictionaryFor } from '../../apps/desktop/src/shared/i18n';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const SCREEN_DOC_PATH = join(REPO_ROOT, 'docs', 'copy-critique-screen.md');
const FIRST_ROUND_PATH = join(REPO_ROOT, 'docs', 'copy-critique.md');

const read = (path: string): string => (existsSync(path) ? readFileSync(path, 'utf8') : '');

const SCREEN_DOC = read(SCREEN_DOC_PATH);
const FIRST_ROUND = read(FIRST_ROUND_PATH);

const ZH = dictionaryFor('zh-CN');
const EN = dictionaryFor('en-US');

/**
 * The five screens this round judged, by the word their heading carries.
 *
 * Named here rather than read from the page: a page that dropped a screen would
 * otherwise define its own coverage, and "five screens" would mean "however many
 * sections survived".
 */
const SCREENS = ['首启', '失败', '权限', '交接', '更新'] as const;

/** How many strings a screen has to have been judged on to count as judged. */
const MIN_ROWS_PER_SCREEN = 3;

/** The shortest reason this gate will accept, in characters. */
const MIN_REASON = 20;

/** One judged string: the row of the table, read. */
interface Row {
  readonly key: string;
  readonly value: string;
  readonly shape: string;
  readonly verdict: string;
  readonly line: string;
}

/** One `## <n>. …` section of the page. */
interface Section {
  readonly heading: string;
  readonly body: string;
}

/** The page's numbered sections, in order. */
function sections(markdown: string): Section[] {
  const found: Section[] = [];
  let heading: string | null = null;
  let body: string[] = [];
  const flush = (): void => {
    if (heading !== null) found.push({ heading, body: body.join('\n') });
  };
  for (const line of markdown.split('\n')) {
    const match = /^## (\d+)\. (.+)$/u.exec(line);
    if (match !== null) {
      flush();
      heading = match[2]!.trim();
      body = [];
      continue;
    }
    if (heading !== null && line.startsWith('## ')) {
      flush();
      heading = null;
      body = [];
      continue;
    }
    if (heading !== null) body.push(line);
  }
  flush();
  return found;
}

/**
 * The judged rows of a section.
 *
 * A row is a table line whose first cell is a backticked key. The shape table
 * higher up the page starts its cells with `**`, so it is not read as a row —
 * which matters, because a page whose own criteria were counted as judgements
 * would report five strings nobody looked at.
 */
function rows(section: Section): Row[] {
  const found: Row[] = [];
  for (const line of section.body.split('\n')) {
    if (!line.startsWith('| `')) continue;
    const cells = line.split('|').map((cell) => cell.trim());
    // ['', key, value, shape, verdict, ''] — a row that lost a cell is reported
    // by the caller as a malformed row rather than silently skipped.
    const key = /^`([^`]+)`$/u.exec(cells[1] ?? '')?.[1];
    if (key === undefined) continue;
    found.push({
      key,
      value: cells[2] ?? '',
      shape: cells[3] ?? '',
      verdict: cells[4] ?? '',
      line,
    });
  }
  return found;
}

/** The five shape names, read from the first round's criteria table. */
function firstRoundShapes(markdown: string): string[] {
  const names: string[] = [];
  for (const line of markdown.split('\n')) {
    const match = /^\| \*\*([^*|]+)\*\* \|/u.exec(line);
    if (match !== null) names.push(match[1]!.trim());
  }
  return names;
}

/** The two numbers the page states about itself. */
function statedCounts(markdown: string): { hits: number; judged: number } | undefined {
  const hits = /\*\*命中\*\*：(\d+) 条/u.exec(markdown);
  const judged = /\*\*判过\*\*：(\d+) 条/u.exec(markdown);
  if (hits === null || judged === null) return undefined;
  return { hits: Number(hits[1]), judged: Number(judged[1]) };
}

/** What the page is compared against. */
interface Dictionary {
  readonly zh: Readonly<Record<string, string>>;
  readonly en: Readonly<Record<string, string>>;
}

/**
 * Every way the page has stopped being a judgement about the screens it names.
 *
 * Empty means: five screens, at least three strings each, every key in both
 * dictionaries, every quoted value the current one, every shape one of the five,
 * every verdict carrying a reason, and the summary agreeing with the table.
 */
function critiqueProblems(
  markdown: string,
  dictionary: Dictionary,
  shapes: readonly string[],
): string[] {
  const problems: string[] = [];
  const found = sections(markdown);
  if (found.length === 0) {
    return ['docs/copy-critique-screen.md: no `## <n>. …` sections, so no screen was judged'];
  }

  for (const screen of SCREENS) {
    const matching = found.filter((section) => section.heading.includes(screen));
    if (matching.length === 0) {
      problems.push(
        `docs/copy-critique-screen.md: no section for the ${screen} screen, so "judged screen by ` +
          'screen" is a claim about four screens',
      );
    } else if (matching.length > 1) {
      problems.push(
        `docs/copy-critique-screen.md: ${matching.length} sections for the ${screen} screen; one ` +
          'screen, one judgement',
      );
    }
  }

  let judged = 0;
  let hits = 0;
  for (const section of found) {
    const judgedRows = rows(section);
    if (judgedRows.length < MIN_ROWS_PER_SCREEN) {
      problems.push(
        `docs/copy-critique-screen.md: "${section.heading}" judges ${judgedRows.length} ` +
          `string(s), under the ${MIN_ROWS_PER_SCREEN} this gate requires — a screen judged on one ` +
          'sentence is a screen nobody read',
      );
    }
    for (const row of judgedRows) {
      judged += 1;
      if (!(row.key in dictionary.zh) || !(row.key in dictionary.en)) {
        problems.push(
          `docs/copy-critique-screen.md: "${section.heading}" judges \`${row.key}\`, which is not ` +
            'in both dictionaries — no screen can show it',
        );
        continue;
      }
      if (row.value !== dictionary.zh[row.key]) {
        problems.push(
          `docs/copy-critique-screen.md: "${section.heading}" quotes \`${row.key}\` as ` +
            `「${row.value}」, but the dictionary now says 「${dictionary.zh[row.key]}」 — the ` +
            'judgement was made about wording that is no longer on screen; judge it again',
        );
      }
      if (!shapes.includes(row.shape)) {
        problems.push(
          `docs/copy-critique-screen.md: "${section.heading}" judges \`${row.key}\` against ` +
            `\`${row.shape}\`, which is not one of the five shapes in docs/copy-critique.md ` +
            `(${shapes.join(' / ')}) — a sixth shape makes the two rounds incomparable`,
        );
      }
      const verdict = /^(零命中|命中)：(.+)$/u.exec(row.verdict);
      if (verdict === null) {
        problems.push(
          `docs/copy-critique-screen.md: "${section.heading}" judges \`${row.key}\` as ` +
            `\`${row.verdict}\`, which is neither \`零命中：…\` nor \`命中：…\``,
        );
        continue;
      }
      if (verdict[1] === '命中') hits += 1;
      if (verdict[2]!.trim().length < MIN_REASON) {
        problems.push(
          `docs/copy-critique-screen.md: "${section.heading}" gives \`${row.key}\` a reason of ` +
            `${verdict[2]!.trim().length} character(s), under the ${MIN_REASON} this gate requires ` +
            '— "clean" on its own is what this page was written to replace',
        );
      }
    }
  }

  const stated = statedCounts(markdown);
  if (stated === undefined) {
    problems.push(
      'docs/copy-critique-screen.md: no `**命中**：N 条 ｜ **判过**：M 条` line, so the page does ' +
        'not say how much of the screen it judged',
    );
  } else {
    if (stated.judged !== judged) {
      problems.push(
        `docs/copy-critique-screen.md: the summary says ${stated.judged} string(s) judged and the ` +
          `tables hold ${judged} — one of the two is now wrong`,
      );
    }
    if (stated.hits !== hits) {
      problems.push(
        `docs/copy-critique-screen.md: the summary says ${stated.hits} hit(s) and the tables hold ` +
          `${hits} — one of the two is now wrong`,
      );
    }
  }

  return problems;
}

describe('the screens were judged one string at a time', () => {
  it('finds the page and the criteria it is judged against, so the checks are not vacuous', () => {
    expect(existsSync(SCREEN_DOC_PATH), `docs/copy-critique-screen.md is missing`).toBe(true);
    expect(existsSync(FIRST_ROUND_PATH), `docs/copy-critique.md is missing`).toBe(true);
    expect(sections(SCREEN_DOC).length, 'the page has no numbered sections').toBeGreaterThan(0);
    expect(firstRoundShapes(FIRST_ROUND), 'the first round lost its criteria table').toHaveLength(5);
  });

  it('judges all five screens, and the summary agrees with the tables', () => {
    const problems = critiqueProblems(SCREEN_DOC, { zh: ZH, en: EN }, firstRoundShapes(FIRST_ROUND));
    expect(problems, `the page disagrees with itself:\n  ${problems.join('\n  ')}`).toEqual([]);
  });

  it('uses the same five shapes as the first round, word for word', () => {
    // The parity that keeps two rounds comparable: the criteria table on this
    // page is the first round's table, not a paraphrase of it.
    const first = firstRoundShapes(FIRST_ROUND);
    const second = firstRoundShapes(SCREEN_DOC);
    expect(second, 'the screen page restates the criteria in different words').toEqual(first);
  });

  it('reports a quoted string that no longer matches the dictionary', () => {
    // The defect this file exists for: the page keeps describing a sentence the
    // screen stopped showing. One character is enough.
    const row = rows(sections(SCREEN_DOC)[0]!).find((candidate) => candidate.key === 'empty.chat');
    expect(row, 'the first screen no longer judges `empty.chat`').toBeDefined();
    const reworded = SCREEN_DOC.replace(row!.line, row!.line.replace(row!.value, `${row!.value}。`));
    expect(reworded).not.toBe(SCREEN_DOC);

    const problems = critiqueProblems(reworded, { zh: ZH, en: EN }, firstRoundShapes(FIRST_ROUND));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('judge it again');
    expect(problems[0]).toContain('empty.chat');
  });

  it('reports a screen that lost its section, and one judged on too few strings', () => {
    const [first] = sections(SCREEN_DOC) as [Section];
    const withoutFirst = SCREEN_DOC.replace(`## 1. ${first.heading}`, '## 1. 别的屏');
    expect(withoutFirst).not.toBe(SCREEN_DOC);
    expect(critiqueProblems(withoutFirst, { zh: ZH, en: EN }, firstRoundShapes(FIRST_ROUND))).toEqual(
      [expect.stringContaining('no section for the 首启 screen')],
    );

    // One row left in a section: the section exists, the coverage does not.
    const thin = SCREEN_DOC.replace(
      rows(first)
        .slice(1)
        .map((row) => `${row.line}\n`)
        .join(''),
      '',
    );
    expect(thin).not.toBe(SCREEN_DOC);
    // Two problems, and both are wanted: the section is thin, and the summary
    // that said twenty-six is now wrong. A gate that reported only the first
    // would leave the count silently describing a table it no longer matches.
    const problems = critiqueProblems(thin, { zh: ZH, en: EN }, firstRoundShapes(FIRST_ROUND));
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain('judges 1 string(s)');
    expect(problems[1]).toContain('the summary says 26 string(s) judged and the tables hold 20');
  });

  it('reports a key no screen can show, and a shape that is not one of the five', () => {
    const row = rows(sections(SCREEN_DOC)[1]!)[0]!;
    const unknownKey = SCREEN_DOC.replace(row.line, row.line.replace(row.key, 'error.notAKey'));
    expect(critiqueProblems(unknownKey, { zh: ZH, en: EN }, firstRoundShapes(FIRST_ROUND))).toEqual(
      [expect.stringContaining('not in both dictionaries')],
    );

    const sixthShape = SCREEN_DOC.replace(row.line, row.line.replace(`| ${row.shape} |`, '| 排比句 |'));
    expect(sixthShape).not.toBe(SCREEN_DOC);
    expect(critiqueProblems(sixthShape, { zh: ZH, en: EN }, firstRoundShapes(FIRST_ROUND))).toEqual(
      [expect.stringContaining('a sixth shape makes the two rounds incomparable')],
    );
  });

  it('reports a verdict with no reason, and a summary that disagrees with the table', () => {
    const row = rows(sections(SCREEN_DOC)[2]!)[0]!;
    const bare = SCREEN_DOC.replace(row.line, row.line.replace(row.verdict, '零命中：没问题'));
    expect(bare).not.toBe(SCREEN_DOC);
    expect(critiqueProblems(bare, { zh: ZH, en: EN }, firstRoundShapes(FIRST_ROUND))).toEqual([
      expect.stringContaining('under the 20 this gate requires'),
    ]);

    // Both directions of the count: the table grew, and the summary grew.
    const counted = SCREEN_DOC.replace('**判过**：26 条', '**判过**：25 条');
    expect(counted).not.toBe(SCREEN_DOC);
    expect(critiqueProblems(counted, { zh: ZH, en: EN }, firstRoundShapes(FIRST_ROUND))).toEqual([
      expect.stringContaining('the summary says 25 string(s) judged and the tables hold 26'),
    ]);

    const claimed = SCREEN_DOC.replace('**命中**：0 条', '**命中**：1 条');
    expect(claimed).not.toBe(SCREEN_DOC);
    expect(critiqueProblems(claimed, { zh: ZH, en: EN }, firstRoundShapes(FIRST_ROUND))).toEqual([
      expect.stringContaining('the summary says 1 hit(s) and the tables hold 0'),
    ]);
  });

  it('is red when the page loses every section, not green over an empty list', () => {
    expect(critiqueProblems('# 屏幕\n\nnothing here\n', { zh: ZH, en: EN }, firstRoundShapes(FIRST_ROUND))).toEqual(
      [expect.stringContaining('no `## <n>. …` sections')],
    );
  });
});
