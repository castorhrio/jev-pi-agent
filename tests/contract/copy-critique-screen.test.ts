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
 * `docs/copy-critique-screen.md` is that reading: seven screens, forty-seven
 * strings, a shape considered and a reason written for each. This file is what
 * keeps it from becoming a page about a dictionary that has since changed.
 *
 * The count in that sentence is the count this file checks. It was not, for one
 * round: the third pass added the `context.*` and `decision.*` screens to the
 * page and left {@link SCREENS} at the five the second pass judged, so the page
 * said "seven screens judged" and the gate asked about five. Every row of the
 * two new screens was still read — the row loop walks every section — but the
 * one assertion that says *this screen was judged at all* did not cover them,
 * which is the shape this repository keeps finding: a document claiming X and a
 * gate checking Y. The screen list and the page's own title are now compared
 * with each other, so the two cannot drift apart again.
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
 *  - the summary line's two counts disagree with the table, in either direction;
 *  - the coverage line's two counts disagree with the table and with the
 *    dictionary — `**覆盖**：本轮判过 M 条 ｜ 字典共 N 条中文值` is the one place
 *    this page says how much of the dictionary it did **not** judge, and a
 *    denominator that is copied rather than read is a number that stops being
 *    true the next time a string is added;
 *  - any **other** place in the prose states a count that disagrees with the
 *    table. The page states its coverage four times — title, summary, coverage
 *    line, and the paragraph explaining why it states a denominator — and the
 *    fourth copy was the one that was wrong: it still said 26 after the third
 *    pass took the page to 44, so a reader met 44 in the summary and 26 three
 *    lines later. Three of the four copies were compared with the tables; this
 *    gate now compares all four.
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
 * The seven screens the page judges, by the word their heading carries.
 *
 * Named here rather than read from the page: a page that dropped a screen would
 * otherwise define its own coverage, and "seven screens" would mean "however
 * many sections survived". The last two are the third pass's — the product's
 * black core, `context.*` (provable injection) and `decision.*` (explainable
 * routing) — and they are listed here for the same reason as the first five:
 * a screen the page stops judging has to be a red run, not a shorter page.
 */
const SCREENS = ['首启', '失败', '权限', '交接', '更新', '上下文', '决策'] as const;

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

/**
 * The coverage line: how much of the dictionary this round judged.
 *
 * Two numbers, and they answer different questions. `judged` is the same count
 * the summary states, checked against the table; `total` is the size of the
 * `zh-CN` dictionary, checked against the dictionary itself. The second one is
 * the reason this line exists: "five screens judged" without a denominator reads
 * as "the screens are done", and the denominator is what turns it into 26 / 667.
 */
function statedCoverage(markdown: string): { judged: number; total: number } | undefined {
  const match = /\*\*覆盖\*\*：本轮判过 (\d+) 条 ｜ 字典共 (\d+) 条中文值/u.exec(markdown);
  if (match === null) return undefined;
  return { judged: Number(match[1]), total: Number(match[2]) };
}

/**
 * Every other place in the prose that states how many strings were judged.
 *
 * The title, the summary and the coverage line are each checked above, and each
 * was added because it was the only copy nobody compared. This is the fourth
 * copy, and it is the one that was actually wrong: the paragraph explaining why
 * the page states a denominator said `这一轮判过 26 条` and `**26 / 667**` — the
 * second pass's number, left behind when the third pass took the page to 44. A
 * reader met 44 in the summary and 26 three lines later, and nothing on the page
 * said which one the tables agreed with.
 *
 * Two shapes, because that paragraph writes the same number two ways: the
 * sentence `本轮判过 N 条` / `这一轮判过 N 条`, and the fraction `N / 667`.
 * Both are read. A gate that only knew the first shape would have left the
 * fraction standing, and the fraction is the one a reader quotes.
 *
 * ## The fifth copy, and why the shapes are read rather than matched
 *
 * The fourth copy was fixed by matching two literal shapes, and matching two
 * literal shapes is the defect one round later: the page states its coverage a
 * fifth time — 「七屏判过、44 / 667」 in the section about what this round did
 * *not* do — and that copy was stale for the same reason as the fourth, because
 * it is not bold and the fraction regex wanted `**`. A gate that knows exactly
 * the shapes that were wrong last time is a gate that is green about the shapes
 * that are wrong this time.
 *
 * So the reading is inverted. {@link COUNT_ANY} finds **every** `判…N 条` in the
 * prose and {@link FRACTION} finds **every** `N / M`; each one is then checked
 * against the tables. A count written in a shape this gate cannot read — 「本轮
 * 共判 47 条」, 「判了 47 条」 — is reported as unreadable rather than skipped,
 * because a skipped count is a count nobody compares, which is the whole defect.
 * If a future round wants a third shape, it has to teach {@link COUNT_SENTENCE}
 * that shape; the alternative is a page that quietly stops being checked.
 *
 * The summary and coverage lines are skipped: they are checked above, and
 * counting them here would report the same defect twice — which is how a gate
 * starts producing two messages for one edit and the second one gets ignored.
 */

/** The sentence shapes this gate can read a judged-count out of. */
const COUNT_SENTENCE = /(?:本轮|这一轮)共?判过 (\d+) 条/gu;

/**
 * Any `判…N 条` in the prose, readable or not.
 *
 * The `本轮` / `这一轮` prefix is part of the match so the message quotes the
 * sentence a reader would quote, not the fragment `判过 47 条`.
 */
const COUNT_ANY = /(?:本轮|这一轮)?共?判(?:过|了)?\s*(\d+)\s*条/gu;

/**
 * Any `N / M` in the prose.
 *
 * In this page a fraction is a coverage claim — `47 / 667` is "this many of the
 * dictionary's values were judged" — so both numbers are checked. A page that
 * needs a fraction that is not a coverage claim has to write it some other way;
 * a false red is cheaper than a stale number nobody reads.
 */
const FRACTION = /(\d+) \/ (\d+)/gu;

/** One count found in the prose, and whether this gate knows how to read it. */
interface BodyCount {
  readonly where: string;
  readonly judged: number;
  readonly total?: number;
  readonly unreadable?: true;
}

function bodyCounts(markdown: string): BodyCount[] {
  const found: BodyCount[] = [];
  for (const line of markdown.split('\n')) {
    if (/\*\*(?:覆盖|命中|判过)\*\*/u.test(line)) continue;
    const readable = [...line.matchAll(COUNT_SENTENCE)];
    for (const match of line.matchAll(COUNT_ANY)) {
      const start = match.index;
      const known = readable.some(
        (candidate) => start >= candidate.index && start < candidate.index + candidate[0].length,
      );
      found.push({
        where: `「${match[0]}」`,
        judged: Number(match[1]),
        ...(known ? {} : { unreadable: true as const }),
      });
    }
    for (const match of line.matchAll(FRACTION)) {
      found.push({
        where: `「${match[0]}」`,
        judged: Number(match[1]),
        total: Number(match[2]),
      });
    }
  }
  return found;
}

/**
 * The Chinese numerals the page's title uses, as numbers.
 *
 * Only the shapes a count of screens or strings can take: `七`, `四十七`, `十`,
 * `十二`. Anything else is `undefined`, which the caller reports rather than
 * guesses at — a title the gate cannot read is a title it cannot check, and
 * silently skipping it is how the count in the title stopped being compared
 * with the count in the tables in the first place.
 */
const NUMERAL_DIGITS: Readonly<Record<string, number>> = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

function chineseNumber(text: string): number | undefined {
  const tens = /^([一二三四五六七八九])?十([一二三四五六七八九])?$/u.exec(text);
  if (tens !== null) {
    const high = tens[1] === undefined ? 1 : NUMERAL_DIGITS[tens[1]]!;
    const low = tens[2] === undefined ? 0 : NUMERAL_DIGITS[tens[2]]!;
    return high * 10 + low;
  }
  if (text.length === 1 && text in NUMERAL_DIGITS) return NUMERAL_DIGITS[text];
  return undefined;
}

/**
 * The two counts the page's title states about itself.
 *
 * `# 屏幕侧逐屏判过：七屏、四十七条、五处命中` is the first sentence anyone
 * reads, and it is a claim about coverage in the same way the summary line is —
 * except that nothing compared it with the tables. That is how the page came to
 * say "seven screens" while {@link SCREENS} still listed five: the title was
 * prose, and prose about a count is coupled to the table by nothing at all.
 *
 * `undefined` when the title is gone or its numerals cannot be read, which the
 * caller reports: a page whose title stopped stating its coverage is a page
 * whose coverage is now only in the summary, and the summary is the line the
 * next edit is most likely to leave behind.
 */
function titleCounts(markdown: string): { screens: number; strings: number } | undefined {
  const match = /^# .*?：([一二三四五六七八九十]+)屏、([一二三四五六七八九十]+)条/u.exec(markdown);
  if (match === null) return undefined;
  const screens = chineseNumber(match[1]!);
  const strings = chineseNumber(match[2]!);
  if (screens === undefined || strings === undefined) return undefined;
  return { screens, strings };
}

/**
 * The block under a `## …` heading that is not one of the numbered screens.
 *
 * {@link sections} only reads `## <n>. …`, which is what the judged screens are;
 * the page's prose sections are unnumbered, and one of them states a count about
 * the gate itself.
 */
function proseBlock(markdown: string, headingIncludes: string): string | undefined {
  const lines = markdown.split('\n');
  const start = lines.findIndex(
    (line) => line.startsWith('## ') && line.includes(headingIncludes),
  );
  if (start === -1) return undefined;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('## '));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

/**
 * How many things the page says the gate pins, and how many it lists.
 *
 * `## 这一页的断言在哪` opens with 「`tests/contract/copy-critique-screen.test.ts` 钉住
 * 八件事」 and then lists them. The number was wrong: the list had grown to nine
 * and the sentence still said eight, which is the same shape as every other
 * defect on this page — a number in prose that nothing compares with the thing
 * it counts. It is cheap to compare, so it is compared.
 *
 * `undefined` when the section, the sentence or its numeral is gone, which the
 * caller reports: a page that stopped saying how many things are pinned is a
 * page whose list can grow without anyone noticing.
 */
function assertionListCounts(markdown: string): { stated: number; listed: number } | undefined {
  const block = proseBlock(markdown, '断言在哪');
  if (block === undefined) return undefined;
  const stated = /钉住([一二三四五六七八九十]+)件事/u.exec(block);
  if (stated === null) return undefined;
  const count = chineseNumber(stated[1]!);
  if (count === undefined) return undefined;
  const listed = block.split('\n').filter((line) => /^\d+\. /u.test(line)).length;
  return { stated: count, listed };
}

/** What the page is compared against. */
interface Dictionary {
  readonly zh: Readonly<Record<string, string>>;
  readonly en: Readonly<Record<string, string>>;
}

/**
 * Every way the page has stopped being a judgement about the screens it names.
 *
 * Empty means: seven screens, at least three strings each, every key in both
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

  const coverage = statedCoverage(markdown);
  if (coverage === undefined) {
    problems.push(
      'docs/copy-critique-screen.md: no `**覆盖**：本轮判过 M 条 ｜ 字典共 N 条中文值` line, so the ' +
        'page says which screens it judged but not how much of the dictionary that is — "five ' +
        'screens judged" reads as "the screens are done"',
    );
  } else {
    if (coverage.judged !== judged) {
      problems.push(
        `docs/copy-critique-screen.md: the coverage line says ${coverage.judged} string(s) judged ` +
          `and the tables hold ${judged} — the page states its own coverage twice and the two ` +
          'statements disagree',
      );
    }
    const total = Object.keys(dictionary.zh).length;
    if (coverage.total !== total) {
      problems.push(
        `docs/copy-critique-screen.md: the coverage line says the dictionary holds ` +
          `${coverage.total} Chinese value(s), and \`dictionaryFor('zh-CN')\` holds ${total} — the ` +
          'denominator was copied rather than read, so the fraction it states is no longer the ' +
          'fraction it measured',
      );
    }
  }

  // The title is the third place this page states its own coverage, and the one
  // nobody compared with the tables. It is checked last because it is the
  // cheapest to read and the most likely to be left behind: the summary and the
  // coverage line are numbers in a line of prose that an editor scrolls past,
  // and the title is the line they read first and edit last.
  const title = titleCounts(markdown);
  if (title === undefined) {
    problems.push(
      'docs/copy-critique-screen.md: the title no longer states `…：N屏、M条…`, so the first ' +
        'sentence on the page stopped saying how much of the screen it judged — the count is now ' +
        'only in the summary, which is the line the next edit leaves behind',
    );
  } else {
    if (title.screens !== SCREENS.length) {
      problems.push(
        `docs/copy-critique-screen.md: the title says ${title.screens} screen(s) were judged and ` +
          `this gate knows ${SCREENS.length} (${SCREENS.join(' / ')}) — the page claims a coverage ` +
          'the screen list does not have, which is how "seven screens judged" was once a claim ' +
          'about five',
      );
    }
    if (title.strings !== judged) {
      problems.push(
        `docs/copy-critique-screen.md: the title says ${title.strings} string(s) were judged and ` +
          `the tables hold ${judged} — the first sentence on the page describes a table that is ` +
          'no longer there',
      );
    }
  }

  // The fourth copy of the count, and the one that was wrong. Checked last for
  // the same reason the title is: it is prose about the page rather than a table
  // in it, so it is the copy an editor reads past — and it is the copy a reader
  // quotes when they want to know how much of the dictionary was judged.
  const dictionaryTotal = Object.keys(dictionary.zh).length;
  for (const count of bodyCounts(markdown)) {
    if (count.unreadable === true) {
      problems.push(
        `docs/copy-critique-screen.md: the prose says ${count.where}, which is a count this gate ` +
          'cannot read — it only knows `本轮判过 N 条` / `这一轮判过 N 条` and `N / M`. Either write ' +
          'the count in one of those shapes or teach `COUNT_SENTENCE` the new one; a count the gate ' +
          'skips is a count nobody compares',
      );
      continue;
    }
    if (count.judged !== judged) {
      problems.push(
        `docs/copy-critique-screen.md: the prose says ${count.where}, and the tables hold ` +
          `${judged} — the page states its own coverage six times and this copy was left ` +
          'behind; a reader meets two numbers and nothing says which one the tables agree with',
      );
    }
    if (count.total !== undefined && count.total !== dictionaryTotal) {
      problems.push(
        `docs/copy-critique-screen.md: the prose says ${count.where}, and ` +
          `\`dictionaryFor('zh-CN')\` holds ${dictionaryTotal} — the fraction in the prose is not the ` +
          'fraction it measured',
      );
    }
  }

  // The page's own claim about the gate: 「钉住 N 件事」 followed by N items. The
  // list had grown to nine while the sentence still said eight, which is the
  // same defect as the stale fraction — a number in prose that nothing counts.
  const assertions = assertionListCounts(markdown);
  if (assertions === undefined) {
    problems.push(
      'docs/copy-critique-screen.md: `## 这一页的断言在哪` no longer says `钉住 N 件事`, so the ' +
        'page stopped stating how many things the gate pins — the list can now grow without ' +
        'anyone noticing',
    );
  } else if (assertions.stated !== assertions.listed) {
    problems.push(
      `docs/copy-critique-screen.md: the page says the gate pins ${assertions.stated} thing(s) ` +
        `and lists ${assertions.listed} — one of the two is now wrong, and the sentence is the ` +
        'one a reader quotes',
    );
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

  it('judges all seven screens, and the summary agrees with the tables', () => {
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
    // Seven problems, and all seven are wanted: the section is thin, and the six
    // places the page states its own count — the summary, the coverage line, the
    // title, the two copies in the prose paragraph, and the copy in "what this
    // round did not do" — each still say forty-seven. A gate that reported only
    // the first would leave the count silently describing a table it no longer
    // matches; one that reported only the summary would leave the other five
    // copies of the number standing, and the title is the copy a reader sees
    // first while the prose is the copy they quote.
    const problems = critiqueProblems(thin, { zh: ZH, en: EN }, firstRoundShapes(FIRST_ROUND));
    expect(problems).toHaveLength(7);
    expect(problems[0]).toContain('judges 1 string(s)');
    expect(problems[1]).toContain('the summary says 47 string(s) judged and the tables hold 41');
    expect(problems[2]).toContain('the coverage line says 47 string(s) judged');
    expect(problems[3]).toContain('the title says 47 string(s) were judged and the tables hold 41');
    expect(problems[4]).toContain('the prose says 「这一轮判过 47 条」');
    expect(problems[5]).toContain('the prose says 「47 / 667」');
    expect(problems[6]).toContain('the prose says 「47 / 667」');
  });

  it('reports a title that claims more screens than the gate knows', () => {
    // The defect this case exists for, in the direction it actually happened:
    // the page's title said "seven screens" while `SCREENS` listed five, and
    // nothing compared the two. The rows of the two new screens were read — the
    // row loop walks every section — but the assertion that says *this screen
    // was judged at all* did not cover them.
    const fiveScreens = SCREEN_DOC.replace('：七屏、', '：五屏、');
    expect(fiveScreens).not.toBe(SCREEN_DOC);
    expect(critiqueProblems(fiveScreens, { zh: ZH, en: EN }, firstRoundShapes(FIRST_ROUND))).toEqual(
      [expect.stringContaining('the title says 5 screen(s) were judged and this gate knows 7')],
    );

    // And the other direction: a screen dropped from the list is a screen the
    // page still claims. Driven by removing the section the list names, which is
    // what a page that lost a screen looks like.
    const withoutContext = SCREEN_DOC.replace('## 6. 上下文（`context.*`）', '## 6. 别的屏');
    expect(withoutContext).not.toBe(SCREEN_DOC);
    expect(
      critiqueProblems(withoutContext, { zh: ZH, en: EN }, firstRoundShapes(FIRST_ROUND)),
    ).toEqual([expect.stringContaining('no section for the 上下文 screen')]);
  });

  it('reports a title that stopped stating its coverage', () => {
    const untitled = SCREEN_DOC.replace(
      /^# 屏幕侧逐屏判过：七屏、四十七条、五处命中（第三刀改掉五条字；补判权限四按钮）$/mu,
      '# 屏幕侧逐屏判过',
    );
    expect(untitled).not.toBe(SCREEN_DOC);
    expect(critiqueProblems(untitled, { zh: ZH, en: EN }, firstRoundShapes(FIRST_ROUND))).toEqual([
      expect.stringContaining('the title no longer states'),
    ]);
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
    const counted = SCREEN_DOC.replace('**判过**：47 条', '**判过**：46 条');
    expect(counted).not.toBe(SCREEN_DOC);
    expect(critiqueProblems(counted, { zh: ZH, en: EN }, firstRoundShapes(FIRST_ROUND))).toEqual([
      expect.stringContaining('the summary says 46 string(s) judged and the tables hold 47'),
    ]);

    const claimed = SCREEN_DOC.replace('**命中**：5 条', '**命中**：6 条');
    expect(claimed).not.toBe(SCREEN_DOC);
    expect(critiqueProblems(claimed, { zh: ZH, en: EN }, firstRoundShapes(FIRST_ROUND))).toEqual([
      expect.stringContaining('the summary says 6 hit(s) and the tables hold 5'),
    ]);
  });

  it('states its coverage as a fraction of the dictionary, and reads the denominator', () => {
    // The line this case exists for: "five screens judged" with no denominator
    // reads as "the screens are done". The denominator is the size of the
    // `zh-CN` dictionary, so it is read from the dictionary rather than trusted
    // from the page — a string added to `i18n.ts` makes the stated fraction
    // wrong, and the page has to say so.
    const coverage = statedCoverage(SCREEN_DOC);
    expect(coverage, 'the page states no coverage line').toBeDefined();
    expect(coverage!.total).toBe(Object.keys(ZH).length);
    expect(coverage!.judged).toBe(47);

    // A denominator that was copied rather than read: the page says 665 while
    // the dictionary holds more, which is exactly what happens when a string is
    // added and nobody re-reads the fraction.
    const stale = SCREEN_DOC.replace('字典共 667 条中文值', '字典共 665 条中文值');
    expect(stale).not.toBe(SCREEN_DOC);
    expect(critiqueProblems(stale, { zh: ZH, en: EN }, firstRoundShapes(FIRST_ROUND))).toEqual([
      expect.stringContaining('the denominator was copied rather than read'),
    ]);

    // And the numerator, in the other direction: the table grew, the coverage
    // line did not.
    const understated = SCREEN_DOC.replace('本轮判过 47 条', '本轮判过 46 条');
    expect(understated).not.toBe(SCREEN_DOC);
    expect(critiqueProblems(understated, { zh: ZH, en: EN }, firstRoundShapes(FIRST_ROUND))).toEqual([
      expect.stringContaining('the coverage line says 46 string(s) judged and the tables hold 47'),
    ]);

    // A page that dropped the line entirely is not silently "fully covered".
    const without = SCREEN_DOC.replace(/\*\*覆盖\*\*：本轮判过 47 条 ｜ 字典共 667 条中文值\n/u, '');
    expect(without).not.toBe(SCREEN_DOC);
    expect(critiqueProblems(without, { zh: ZH, en: EN }, firstRoundShapes(FIRST_ROUND))).toEqual([
      expect.stringContaining('no `**覆盖**'),
    ]);
  });

  it('reports a count in the prose that the tables do not agree with', () => {
    // The defect this case exists for, in the shape it actually happened: the
    // paragraph explaining why the page states a denominator still carried the
    // second pass's number. The page said 44 in the summary and 26 three lines
    // later, and the gate was green — the title, the summary and the coverage
    // line were each compared with the tables, and the prose was not.
    const stale = SCREEN_DOC.replace('这一轮判过 47 条', '这一轮判过 26 条');
    expect(stale).not.toBe(SCREEN_DOC);
    expect(critiqueProblems(stale, { zh: ZH, en: EN }, firstRoundShapes(FIRST_ROUND))).toEqual([
      expect.stringContaining('the prose says 「这一轮判过 26 条」'),
    ]);

    // The same number written the other way in the same paragraph: the fraction.
    // A gate that only knew the sentence shape would have left this one standing,
    // and the fraction is the copy a reader quotes.
    const fraction = SCREEN_DOC.replace('**47 / 667**', '**26 / 667**');
    expect(fraction).not.toBe(SCREEN_DOC);
    expect(critiqueProblems(fraction, { zh: ZH, en: EN }, firstRoundShapes(FIRST_ROUND))).toEqual([
      expect.stringContaining('the prose says 「26 / 667」'),
    ]);

    // And the denominator of that fraction, which is the dictionary's size in
    // the same way the coverage line's is.
    const denominator = SCREEN_DOC.replace('**47 / 667**', '**47 / 665**');
    expect(denominator).not.toBe(SCREEN_DOC);
    expect(critiqueProblems(denominator, { zh: ZH, en: EN }, firstRoundShapes(FIRST_ROUND))).toEqual([
      expect.stringContaining('the fraction in the prose is not the fraction it measured'),
    ]);
  });

  it('reports the fifth copy of the count, the one that was not bold', () => {
    // The defect this case exists for: the page states its coverage a fifth time
    // in "what this round did not do" — 「七屏判过、47 / 667」 — and that copy was
    // stale for a whole round. The gate was green because it only knew the bold
    // fraction `**N / 667**`, and this copy is not bold. A gate that knows the
    // shapes that were wrong last time is a gate that is green about the shapes
    // that are wrong this time, so the fraction is now read with or without the
    // emphasis.
    const stale = SCREEN_DOC.replace('七屏判过、47 / 667', '七屏判过、44 / 667');
    expect(stale).not.toBe(SCREEN_DOC);
    expect(critiqueProblems(stale, { zh: ZH, en: EN }, firstRoundShapes(FIRST_ROUND))).toEqual([
      expect.stringContaining('the prose says 「44 / 667」'),
    ]);
  });

  it('reports a count written in a shape it cannot read, instead of skipping it', () => {
    // The other half of the same defect: a gate that matches two literal shapes
    // silently skips a third. 「本轮共判 47 条」 is the same claim in a shape the
    // regex does not know, and skipping it is how a count stops being compared —
    // so an unreadable shape is a red run that names the shape, not a pass.
    const reworded = SCREEN_DOC.replace('这一轮判过 47 条', '这一轮共判 47 条');
    expect(reworded).not.toBe(SCREEN_DOC);
    expect(critiqueProblems(reworded, { zh: ZH, en: EN }, firstRoundShapes(FIRST_ROUND))).toEqual([
      expect.stringContaining('「这一轮共判 47 条」, which is a count this gate cannot read'),
    ]);

    // And the same for the other verb a future editor is likely to reach for.
    const past = SCREEN_DOC.replace('这一轮判过 47 条', '这一轮判了 47 条');
    expect(past).not.toBe(SCREEN_DOC);
    expect(critiqueProblems(past, { zh: ZH, en: EN }, firstRoundShapes(FIRST_ROUND))).toEqual([
      expect.stringContaining('「这一轮判了 47 条」, which is a count this gate cannot read'),
    ]);
  });

  it('reports a list of pinned assertions that outgrew the number above it', () => {
    // The page opens 「…钉住十件事」 and then lists them. The sentence said eight
    // while the list held nine, which is the same shape as the stale fraction: a
    // number in prose that nothing counts. It is cheap to count, so it is counted.
    const understated = SCREEN_DOC.replace('钉住十件事', '钉住九件事');
    expect(understated).not.toBe(SCREEN_DOC);
    expect(critiqueProblems(understated, { zh: ZH, en: EN }, firstRoundShapes(FIRST_ROUND))).toEqual(
      [expect.stringContaining('the page says the gate pins 9 thing(s) and lists 10')],
    );

    // A page that dropped the sentence is not silently "fully listed".
    const without = SCREEN_DOC.replace('钉住十件事', '钉住若干件事');
    expect(without).not.toBe(SCREEN_DOC);
    expect(critiqueProblems(without, { zh: ZH, en: EN }, firstRoundShapes(FIRST_ROUND))).toEqual([
      expect.stringContaining('no longer says `钉住 N 件事`'),
    ]);
  });

  it('judges all four permission buttons, not just the one the answer sheet quotes', () => {
    // The coverage defect this case exists for: `docs/defense-checklist.md` pins
    // all four button labels to the dictionary, and this page judged one of them.
    // Two documents claiming to cover the same set, covering different sets — the
    // shape this repository keeps finding. The four keys are named here so that
    // dropping one from the table is a red run rather than a shorter page.
    const permission = sections(SCREEN_DOC).find((section) => section.heading.includes('权限'));
    expect(permission, 'the page no longer has a 权限 section').toBeDefined();
    const keys = rows(permission!).map((row) => row.key);
    for (const key of [
      'permission.allow_once',
      'permission.allow_session',
      'permission.allow_workspace',
      'permission.deny',
    ]) {
      expect(keys, `the 权限 screen does not judge \`${key}\``).toContain(key);
    }
  });

  it('is red when the page loses every section, not green over an empty list', () => {
    expect(critiqueProblems('# 屏幕\n\nnothing here\n', { zh: ZH, en: EN }, firstRoundShapes(FIRST_ROUND))).toEqual(
      [expect.stringContaining('no `## <n>. …` sections')],
    );
  });
});
