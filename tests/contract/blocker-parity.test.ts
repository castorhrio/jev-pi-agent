/**
 * One external blocker, three copies, one wording — measured instead of hoped.
 *
 * ## Why this file exists
 *
 * Each of the three external blockers is written down three times: once in
 * `README.md` (twice, in fact — the Chinese half and the English half), once in
 * `docs/blockers.md`, which is the runbook, and once in `docs/dod-status.md`,
 * which is the evidence page. Three rounds of honest work kept all three
 * *stories* aligned, and nobody kept the *wording* aligned: 「关掉它**需要写权限令牌**」
 * in the README, 「（需要写权限令牌）」 in the blockers heading, and 「本机没有
 * `contents: write` 令牌」 in the status page. Side by side that is one gap
 * described three ways, which is the defect this repository has already named
 * twice: a claim that is re-told rather than re-measured.
 *
 * The part that actually costs something is the command and the quoted output.
 * `docs/blockers.md` names the command that measures each blocker today
 * (`**重跑这一条**`) and the line that says it closed (`**屏幕上第一行**`); the
 * other two copies paraphrase them. A paraphrase is what rots — when the
 * `--judge` line changes wording, the runbook changes and the front door keeps
 * describing the old one, and no reader can tell from either page which is
 * stale.
 *
 * ## What is asserted
 *
 * Three literals are **read out of `docs/blockers.md`** for every `## N.`
 * section — it is the runbook, so it is the source — and each copy is compared
 * against them:
 *
 *  - the 「需要…」 clause of the section heading: what this machine lacks;
 *  - the `**重跑这一条**` command: how that is measured today;
 *  - the `**屏幕上第一行**` of the `### 解除时` recipe: what closing looks like.
 *
 * A failure names the copy, the blocker and the literal, because the useful
 * half of this red is knowing which of the three pages moved.
 *
 * ## What is deliberately not asserted, and where that is written down
 *
 * `README.md` carries the command and the 「需要…」 phrase in each of its two
 * languages, and is **not** asked to carry the operator's line. A pasted
 * `PASS — …` is not something a reader deciding whether to trust a release
 * needs, and the front door is not a runbook. {@link README_EXEMPTION} is that
 * decision as data, and a case below refuses a copy that exempts itself without
 * a reason — an exemption inside a loop is where silent passes live. The two
 * operator pages are not exempt.
 *
 * Also not asserted: that the English half *translates* the Chinese one. A gate
 * cannot derive a translation. It checks that each half states a gap, that the
 * Chinese half states the heading's own words, and that the English half states
 * the phrase {@link ENGLISH_NEEDS} declares for that blocker. So a rewrite of
 * one half into a different claim is red, while a genuine re-translation is an
 * edit a person makes deliberately, in both places.
 *
 * And not asserted: **where** in a copy the literal sits. Presence here is
 * textual, and this round learned that the hard way — a round's narrative
 * section quoted 「需要写权限令牌」 while explaining the drift, and the copy that
 * had stopped carrying the claim in its own voice still passed. Quoting is not
 * carrying, but telling the two apart needs a section model per document
 * (the status page's 「未关闭」 list, the README's 「当前局限」 bullets), which is a
 * second parse of prose that already has four gates reading it. What this gate
 * can therefore say is "these pages use identical wording"; what it cannot say
 * is "each page states it in its own voice". Two of the driven cases below
 * therefore strip *every* occurrence, so they measure absence rather than the
 * author's memory of where they wrote the phrase once.
 *
 * Every check is a pure function of three documents, so every red direction
 * below is driven on a mutated copy of the real text.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// The same readers the other blockers gates use. A second definition of "what a
// `## 1. …` section is", or of "the first line under this marker", would drift —
// and the drift would show up as this gate quietly comparing nothing while the
// others stayed green.
import {
  FIRST_LINE_MARKER,
  blockAfter,
  blockerChecks,
  blockerSections,
  closingRecipe,
} from './blockers-doc.ts';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const README_PATH = join(REPO_ROOT, 'README.md');
const BLOCKERS_PATH = join(REPO_ROOT, 'docs', 'blockers.md');
const STATUS_PATH = join(REPO_ROOT, 'docs', 'dod-status.md');

const read = (path: string): string => (existsSync(path) ? readFileSync(path, 'utf8') : '');

const README = read(README_PATH);
const BLOCKERS = read(BLOCKERS_PATH);
const STATUS = read(STATUS_PATH);

/**
 * Markdown line wrapping, removed.
 *
 * A sentence broken across two lines is the same sentence, and all three copies
 * wrap at different widths — the README near 78 columns, the two Chinese
 * documents at their own. Comparing raw lines would report a re-wrap as a
 * wording change, which teaches the next round to fear line breaks instead of
 * disagreeing about facts.
 */
function flattened(text: string): string {
  return text.replace(/\s+/gu, ' ');
}

/** The line the README's Chinese half begins at. */
const CHINESE_HEADING = /^## 中文$/m;

/** The README's two halves, flattened; `null` when the marker is gone. */
interface Halves {
  readonly en: string;
  readonly zh: string;
}

/**
 * Split the README into its two languages.
 *
 * Without the split every literal would be searched in the whole page, and the
 * English half could be missing its command while the Chinese half supplied it —
 * a gate that passes because one of two readers was counted for both.
 */
function readmeHalves(markdown: string): Halves | null {
  const at = markdown.search(CHINESE_HEADING);
  if (at === -1) return null;
  return { en: flattened(markdown.slice(0, at)), zh: flattened(markdown.slice(at)) };
}

/**
 * The three gaps, in the README's English half.
 *
 * A translation is not derivable, so it is declared. A blocker with no entry is
 * reported rather than skipped: adding a fourth `## N.` section to the runbook
 * would otherwise be compared in Chinese only, which is half a check wearing a
 * full badge.
 */
const ENGLISH_NEEDS: Readonly<Record<number, string>> = {
  1: 'needs a write token',
  2: 'needs a Windows machine',
  3: 'needs a person',
};

/**
 * The README's exemption from the operator's line, as a checked entry.
 *
 * If `carriesFirstLine` were simply absent for one copy, nothing would say
 * whether that was decided or forgotten. So the exemption names its scope, its
 * literal and its reason, and the case at the bottom refuses it if the reason
 * becomes a shrug — or if an operator page helps itself to it.
 */
const README_EXEMPTION = {
  scope: 'README.md',
  literal: '屏幕上第一行',
  reason:
    'README.md is the front door, not a runbook: it has to say what is missing and ' +
    'what closes it, and a pasted operator line belongs to docs/blockers.md and ' +
    'docs/dod-status.md. What the front door must not do is paraphrase one — that is ' +
    'how the wording drifted in the first place.',
} as const;

/** Which document a copy lives in, and which half of it. */
type CopySource = 'readme-en' | 'readme-zh' | 'blockers' | 'status';

/** One copy of the blockers page, and what this gate asks it to carry. */
interface CopyExpectation {
  /** The name a failure prints. */
  readonly name: string;
  readonly source: CopySource;
  /** The language this copy states the 「需要…」 gap in. */
  readonly language: 'zh' | 'en';
  /** Whether this copy has to carry the operator's first line. */
  readonly carriesFirstLine: boolean;
}

/**
 * The four copies, in the order a reader meets them.
 *
 * `docs/blockers.md` is compared against itself too: its three literals are the
 * source, so its half of every assertion is "the section, the re-check command
 * and the closing line are all on the one page readers are sent to". The failure
 * mode there is a section whose recipe or freshness line was deleted, which a
 * page cannot notice from its own text alone.
 */
const COPIES: readonly CopyExpectation[] = [
  { name: 'docs/blockers.md', source: 'blockers', language: 'zh', carriesFirstLine: true },
  { name: 'docs/dod-status.md', source: 'status', language: 'zh', carriesFirstLine: true },
  { name: 'README.md 中文半', source: 'readme-zh', language: 'zh', carriesFirstLine: false },
  { name: 'README.md English half', source: 'readme-en', language: 'en', carriesFirstLine: false },
];

/** The three documents this gate compares. */
interface Documents {
  readonly readme: string;
  readonly blockers: string;
  readonly status: string;
}

/** One blocker, as the runbook writes it. */
interface BlockerLiterals {
  /** The section number, as `第 N 节` says it. */
  readonly section: number;
  /** The heading text, for failure messages. */
  readonly heading: string;
  /** The 「需要…」 clause in the heading's parentheses, or undefined when it has none. */
  readonly needs: string | undefined;
  /** The `**重跑这一条**` command, or undefined when the line lost it. */
  readonly command: string | undefined;
  /** The `### 解除时` recipe's `**屏幕上第一行**`, or undefined when it has none. */
  readonly firstLine: string | undefined;
}

/** The three literals of one `## N. …` section, read out of the runbook. */
function literalsOf(section: { heading: string; body: string }): BlockerLiterals {
  const number = Number(/^(\d+)\./.exec(section.heading)?.[1]);
  const [check] = blockerChecks(section) as ReturnType<typeof blockerChecks>;
  const recipe = closingRecipe(section);
  return {
    section: number,
    heading: section.heading,
    needs: /（([^（）]*)）/u.exec(section.heading)?.[1],
    command: check?.command ?? undefined,
    firstLine: recipe === undefined ? undefined : blockAfter(recipe.body, FIRST_LINE_MARKER),
  };
}

/** The text of one copy, resolved out of the three documents. */
function copyText(source: CopySource, documents: Documents, halves: Halves): string {
  if (source === 'readme-en') return halves.en;
  if (source === 'readme-zh') return halves.zh;
  if (source === 'blockers') return flattened(documents.blockers);
  return flattened(documents.status);
}

/** Which literal a copy is asked to carry, in the wording the runbook uses. */
function expectedLiteral(
  copy: CopyExpectation,
  which: 'needs' | 'command' | 'firstLine',
  literals: BlockerLiterals,
): string | undefined {
  if (which === 'needs') {
    return copy.language === 'en' ? ENGLISH_NEEDS[literals.section] : literals.needs;
  }
  return which === 'command' ? literals.command : literals.firstLine;
}

/** What a literal is called in a failure message, in the sentence's own grammar. */
function whichLabel(which: 'needs' | 'command' | 'firstLine'): string {
  if (which === 'needs') return 'the gap as';
  if (which === 'command') return 'the command';
  return 'the expected first line';
}

/** The literals the copies are compared against. */
const LITERALS: readonly ('needs' | 'command' | 'firstLine')[] = ['needs', 'command', 'firstLine'];

/**
 * Every way the three copies of the blockers have stopped agreeing.
 *
 * Empty means the runbook states three literals for every blocker, and every
 * copy carries the ones it is asked to carry, in the runbook's own wording.
 */
function parityProblems(documents: Documents): string[] {
  const halves = readmeHalves(documents.readme);
  if (halves === null) {
    return [
      'README.md: no `## 中文` line, so the Chinese and English halves cannot be compared in ' +
        'their own languages — searching the whole page would find each literal once and call ' +
        'both halves covered',
    ];
  }

  const sections = blockerSections(documents.blockers);
  if (sections.length === 0) {
    return [
      'docs/blockers.md: no `## N. …` blocker sections, so there is nothing for the copies to ' +
        'agree with',
    ];
  }

  const problems: string[] = [];
  for (const raw of sections) {
    const literals = literalsOf(raw);

    // The source first: a literal that cannot be read out of the runbook cannot
    // be compared, and the authoritative page is the one at fault.
    if (!Number.isFinite(literals.section)) {
      problems.push(
        `docs/blockers.md: "${raw.heading}" does not start with a section number, so no copy ` +
          'of it can be matched to it',
      );
      continue;
    }
    if (literals.needs === undefined || !literals.needs.startsWith('需要')) {
      problems.push(
        `docs/blockers.md: 第 ${literals.section} 节 states its gap as ` +
          `"${literals.needs ?? '(no parentheses in the heading)'}" instead of a 「需要…」 ` +
          'clause, so the copies have nothing fixed to be compared against',
      );
    }
    if (literals.command === undefined) {
      problems.push(
        `docs/blockers.md: 第 ${literals.section} 节 has no **重跑这一条** command, so the ` +
        'copies cannot be asked to agree on one',
      );
    }
    if (literals.firstLine === undefined) {
      problems.push(
        `docs/blockers.md: 第 ${literals.section} 节 has no \`### 解除时\` **屏幕上第一行**, so ` +
        '"closed" is described rather than quoted',
      );
    }
    if (literals.needs !== undefined && ENGLISH_NEEDS[literals.section] === undefined) {
      problems.push(
        `tests/contract/blocker-parity.test.ts: 第 ${literals.section} 节 has no entry in ` +
          'ENGLISH_NEEDS, so the README’s English half is never asked whether it still says ' +
          'the same thing — a fourth blocker would be compared in Chinese only',
      );
    }

    for (const copy of COPIES) {
      const text = copyText(copy.source, documents, halves);
      for (const which of LITERALS) {
        if (which === 'firstLine' && !copy.carriesFirstLine) continue;
        const literal = expectedLiteral(copy, which, literals);
        if (literal === undefined) continue; // reported above: never a silent pass
        if (text.includes(flattened(literal))) continue;
        problems.push(
          `${copy.name}: 第 ${literals.section} 节 says ${whichLabel(which)} ` +
            `"${literal}" in docs/blockers.md, and that string is not in this copy — three ` +
            'copies of one blocker now describe different things, and a reader has to guess ' +
            'which page is stale',
        );
      }
    }
  }

  return problems;
}

/** How many literal-vs-copy comparisons a well-formed page should produce. */
function comparisons(sections: number): number {
  const perCopy = COPIES.map((copy) =>
    LITERALS.filter((which) => which !== 'firstLine' || copy.carriesFirstLine).length,
  );
  return perCopy.reduce((sum, count) => sum + count, 0) * sections;
}

/** The README copies, so the exemption can be asserted rather than commented. */
const README_COPIES = COPIES.filter((copy) => copy.name.startsWith(README_EXEMPTION.scope));

/** The four headings of a fourth blocker, written the way the page writes them. */
const FOURTH_BLOCKER = [
  '## 4. 一个新的外部阻塞（需要一台 macOS 机器）',
  '',
  '- **责任人**：castorhrio ｜ **截止**：2026-12-19',
  '- **最近核对**：2026-11-06 ｜ **重跑这一条**：`node scripts/screenshot-sources.mjs --check`',
  '',
  '### 解除时：一条命令、一行输出、一处要改的文档',
  '',
  '**跑这一条**：',
  '',
  '```bash',
  'node scripts/screenshot-sources.mjs --check',
  '```',
  '',
  '**屏幕上第一行**：',
  '',
  '```text',
  'PASS — 34 renderer source(s) and 14 screenshot(s) match docs/screenshots/sources.json',
  '```',
  '',
  '**解除后要改的一处**：',
  '',
  '1. `docs/dod-status.md`。',
  '',
].join('\n');

describe('the three copies of each blocker say the same three things', () => {
  it('compares every copy against the literals the runbook states', () => {
    const problems = parityProblems({ readme: README, blockers: BLOCKERS, status: STATUS });
    expect(
      problems,
      `the copies of the external blockers disagree:\n  ${problems.join('\n  ')}`,
    ).toEqual([]);
  });

  it('is not vacuous: four copies, three blockers, three literals each', () => {
    // Without this, four parsers that stopped matching would agree on nothing at
    // all and the case above would be green over an empty comparison — the shape
    // every gate in this repository has had to name.
    const sections = blockerSections(BLOCKERS);
    expect(sections.length, 'docs/blockers.md lost its numbered sections').toBe(3);
    const halves = readmeHalves(README);
    if (halves === null) {
      throw new Error('README.md has no `## 中文` line, so neither half can be read');
    }
    for (const raw of sections) {
      const literals = literalsOf(raw);
      expect(literals.needs, `"${raw.heading}" names no gap`).toMatch(/^需要/u);
      expect(literals.command, `"${raw.heading}" names no re-check command`).toBeDefined();
      expect(literals.firstLine, `"${raw.heading}" quotes no closing line`).toBeDefined();
      expect(ENGLISH_NEEDS[literals.section], `第 ${literals.section} 节 has no English entry`)
        .toBeDefined();
    }
    // And each copy really is a piece of text this gate read: an empty half would
    // match nothing and report nothing.
    const documents = { readme: README, blockers: BLOCKERS, status: STATUS };
    for (const copy of COPIES) {
      expect(
        copyText(copy.source, documents, halves).length,
        `${copy.name} resolved to nothing, so it could not disagree with anything`,
      ).toBeGreaterThan(200);
    }
  });

  it('counts the comparisons, so a narrowed loop is visible', () => {
    // 3 blockers x (2 literals on each of the four copies, plus the operator line
    // on the two that carry it) = 30. Written as a number, a `continue` that
    // started skipping a copy or a literal shows up here instead of in a green run.
    expect(comparisons(blockerSections(BLOCKERS).length)).toBe(30);
  });

  it('reports a command the README’s English half stopped carrying', () => {
    const second = blockerSections(BLOCKERS)[1]!;
    const command = literalsOf(second).command!;
    expect(command).toContain('node scripts/verify-main-chain.mjs --judge');
    const broken = README.replace(command, 'judge it with the script beside the report');
    expect(broken, 'the sentence this case rewrites is gone').not.toBe(README);
    const problems = parityProblems({ readme: broken, blockers: BLOCKERS, status: STATUS });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('README.md English half');
    expect(problems[0]).toContain(command);
    expect(problems[0]).toContain('three copies of one blocker now describe different things');
  });

  it('reports a gap the status page states in its own words instead of the runbook’s', () => {
    // The real drift this block was written for: 第 1 节 was 「需要写权限令牌」 in two
    // documents and 「本机没有 contents: write 令牌」 in the third.
    //
    // `replaceAll`, not `replace`: this very page quotes the literal in a round's
    // narrative, and a case that removes one of two occurrences is not asking
    // whether the copy carries the wording — it is asking whether the author
    // remembered where they wrote it. The mutation has to make the phrase absent.
    const status = STATUS.replaceAll(/需要写权限令牌/gu, '本机没有那个令牌');
    expect(status, 'the wording this case strips is gone').not.toBe(STATUS);
    expect(status).not.toContain('需要写权限令牌');
    const problems = parityProblems({ readme: README, blockers: BLOCKERS, status });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('docs/dod-status.md');
    expect(problems[0]).toContain('第 1 节');
    expect(problems[0]).toContain('需要写权限令牌');
  });

  it('follows the runbook when it retitles a blocker', () => {
    // The direction that keeps this honest: the heading is the source, so a new
    // wording has to be adopted by the other copies rather than defended by them.
    //
    // The sentinel says 「Solaris」 on purpose. A realistic new wording is a phrase
    // some round will eventually quote in its own narrative — that is exactly how
    // this case failed once already — and a quoted sentence would satisfy the
    // comparison while the copy still carried the old claim everywhere else.
    const renamed = BLOCKERS.replace('（需要一个人）', '（需要一台 Solaris 机器）');
    expect(renamed, '第 3 节 heading this case retitles is gone').not.toBe(BLOCKERS);
    const problems = parityProblems({ readme: README, blockers: renamed, status: STATUS });
    expect(problems).toHaveLength(2);
    for (const problem of problems) expect(problem).toContain('需要一台 Solaris 机器');
    expect(problems.map((problem) => problem.split(':')[0]).sort()).toEqual([
      'README.md 中文半',
      'docs/dod-status.md',
    ]);
  });

  it('reports an operator line only the runbook still quotes', () => {
    const drifted = BLOCKERS.replaceAll(
      'PASS — the report covers steps 1, 2, 3, 4, 5 on win32 against build 1.0.0',
      'PASS — the report covers steps 1-5 on win32, build 1.0.0',
    );
    expect(drifted, 'the closing line this case rewrites is gone').not.toBe(BLOCKERS);
    const problems = parityProblems({ readme: README, blockers: drifted, status: STATUS });
    // The command is unchanged, so only the quoted line moves — and only the two
    // operator pages are asked to keep up with it.
    const moved = problems.filter((problem) => problem.includes('expected first line'));
    expect(moved).toHaveLength(1);
    expect(moved[0]!, 'no copy was asked about the moved line').toContain('docs/dod-status.md');
    expect(problems.join('\n')).not.toContain('README.md');
  });

  it('refuses a fourth blocker nobody declared the English half for', () => {
    const anchor = '## 本机全量测试的已知环境约束（不是外部阻塞）';
    const four = BLOCKERS.replace(anchor, `${FOURTH_BLOCKER}\n${anchor}`);
    expect(four, 'the heading this case inserts before is gone').not.toBe(BLOCKERS);
    expect(blockerSections(four)).toHaveLength(4);
    const problems = parityProblems({ readme: README, blockers: four, status: STATUS });
    expect(problems.some((problem) => problem.includes('no entry in ENGLISH_NEEDS'))).toBe(true);
    for (const copy of ['README.md 中文半', 'docs/dod-status.md']) {
      expect(
        problems.some((problem) => problem.includes(copy) && problem.includes('第 4 节')),
        `${copy} was not asked about 第 4 节`,
      ).toBe(true);
    }
  });

  it('keeps the README exemption a stated decision, not a missing branch', () => {
    // The one place this gate deliberately asks less, so it is asserted as data:
    // the two operator pages carry the line, the front door does not, and the
    // reason is a sentence rather than a shrug.
    expect(README_COPIES).toHaveLength(2);
    for (const copy of README_COPIES) {
      expect(copy.carriesFirstLine, `${copy.name} quietly started carrying the operator line`)
        .toBe(false);
    }
    expect(README_EXEMPTION.literal).toBe('屏幕上第一行');
    expect(README_EXEMPTION.reason.length, 'the exemption has no reason').toBeGreaterThan(80);
    for (const copy of COPIES.filter((entry) => !README_COPIES.includes(entry))) {
      expect(copy.carriesFirstLine, `${copy.name} exempted itself from the operator line`)
        .toBe(true);
    }
  });

  it('reports a README that lost the line separating its two languages', () => {
    const broken = README.replace('## 中文', '## Chinese');
    expect(broken, 'the `## 中文` heading this case renames is gone').not.toBe(README);
    expect(parityProblems({ readme: broken, blockers: BLOCKERS, status: STATUS })).toEqual([
      expect.stringContaining('no `## 中文` line'),
    ]);
  });
});
