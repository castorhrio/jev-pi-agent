/**
 * 中英混排间距，在**文档页**上也是会红的。
 *
 * ## 为什么这个文件存在
 *
 * 屏幕侧的中英空隙有两半，都已经进门禁：`tests/contract/typography.test.ts` 管
 * `apps/desktop/src/shared/i18n.ts` 里的句子（写字面的地方），
 * `tests/contract/layout.test.ts` 管真 Chromium 里 `text-autospace` 补出来的 1/8 em
 * （引擎那一半）。两半合起来说的是「屏幕上读起来有空气」。
 *
 * 但答辩那天评委读的不是屏幕，是 `docs/defense-checklist.md`、`docs/dod-status.md`、
 * `docs/manual-verification/README.md` 这三页——它们是照着念的口语稿。这三页**不走**
 * `text-autospace`：markdown 渲染器不会替它们补那 1/8 em，GitHub 上也不会。所以这三页的
 * 空隙只能靠**写的时候真的敲了那个空格**，而在此之前没有任何东西核对过它。
 *
 * 这不是假想的缺口。`README.md` 的「当前局限」自己写着「中英之间的空隙只存在于屏幕上」——
 * 那句话对屏幕成立，对文档页不成立，而文档页正是被念出来的那一份。
 *
 * ## 判据与屏幕侧是同一份，不是第二份
 *
 * 汉字集合从 `scripts/layout-page-scripts.mjs` 的 `HAN_CLASS` 读回（与
 * `typography.test.ts` 同一个来源），拉丁一侧取**字母**（`A-Za-z`），不含数字。
 * 数字被排除不是这里新做的决定：`typography.test.ts` 的 `LATIN_LETTER` 旁边写着理由，
 * 而 `docs/dod-status.md` 记着那一轮的结论——「第1步」「3条改动」是中文的正常写法，
 * 一条会拒绝它们的规则是把风格偏好伪装成排版错误。文档页沿用同一个判断，
 * 否则同一句话在词典里合法、在文档里非法，两处各自看着都对。
 *
 * ## 扫哪些页
 *
 * `markdownDocuments()`（`scripts/screenshot-sources.mjs`）——README、CONTRIBUTING 与
 * `docs/**\/*.md`，与截图引用门禁读的是同一份清单，所以「哪些文件算文档」只有一处定义。
 * 唯一的例外是 `docs/PRODUCT-DOD.md`：它是控制面锁定稿的逐字副本（`docs/dod-status.md`
 * 记着 `diff` 为空），本仓不许改它。把它扫进来，一旦它出现一处紧贴，门禁就会要求改一个
 * 明令不许改的文件——那不是门禁，是一个死结。所以它被排除，理由写在这里而不是留在
 * 一个 `filter` 里。
 *
 * ## 它证明不了什么
 *
 * 它只看**源码里有没有那个空格**。它看不出空格是不是一个（两个也行）、看不出
 * 全角标点用得对不对、也看不出这三页读起来顺不顺。它挡的是最便宜也最常见的那一种：
 * 一句话里 `显示Agent` 这样把标识符硬贴上去，读者要重跑一遍这一行才知道中文在哪结束。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { markdownDocuments } from '../../scripts/screenshot-sources.mjs';

const REPO_ROOT = join(import.meta.dirname, '..', '..');

/** The page script that owns the character sets, read as source. */
const PAGE_SCRIPTS = readFileSync(join(REPO_ROOT, 'scripts/layout-page-scripts.mjs'), 'utf8');

/**
 * The Han range, read back out of the page script rather than spelled again.
 *
 * Same reason `typography.test.ts` reads it: the engine half and the prose half
 * have to judge one set of characters, and a second spelling of the range is how
 * the two drift — narrower here, greener there, invisible in a diff.
 */
function charClass(name: 'HAN_CLASS'): string {
  const match = new RegExp(`export const ${name} = '([^']+)';`).exec(PAGE_SCRIPTS);
  expect(match, `layout-page-scripts.mjs no longer exports ${name}`).not.toBeNull();
  return match![1]!;
}

const HAN = charClass('HAN_CLASS');

/**
 * The Latin side: letters only.
 *
 * Digits are exempt on purpose and the exemption is not this file's to invent —
 * see the header. `typography.test.ts` states the same split for the dictionary,
 * and `docs/dod-status.md` records the round that decided it.
 */
const LATIN_LETTER = 'A-Za-z';

/** A Han character set directly against a Latin letter, either order. */
const HAN_AGAINST_LETTER = new RegExp(
  `(?:[${HAN}][${LATIN_LETTER}]|[${LATIN_LETTER}][${HAN}])`,
  'u',
);

/** One character, as the census classifies it. */
const IS_HAN = new RegExp(`^[${HAN}]$`, 'u');
const IS_LETTER = new RegExp(`^[${LATIN_LETTER}]$`, 'u');

/**
 * The documents this gate reads, minus the locked draft.
 *
 * `docs/PRODUCT-DOD.md` is a verbatim copy of the control-plane draft and this
 * repository is not allowed to edit it; a gate that could only be satisfied by
 * editing it would be a deadlock, not a check.
 */
export const LOCKED_DRAFT = 'docs/PRODUCT-DOD.md';

/** The three pages a presenter reads out loud, which is why this gate exists. */
export const DEFENCE_PAGES = [
  'docs/defense-checklist.md',
  'docs/dod-status.md',
  'docs/manual-verification/README.md',
] as const;

/** One document, as the gate sees it. */
export interface Document {
  /** Repository-relative path. */
  readonly path: string;
  /** The file's text. */
  readonly text: string;
}

/** A boundary found in a document. */
export interface Boundary {
  /** Repository-relative path. */
  readonly path: string;
  /** 1-based line number. */
  readonly line: number;
  /** The two characters, as they are written. */
  readonly pair: string;
}

/**
 * The prose of a markdown document, with code taken out.
 *
 * Fenced blocks are dropped whole and inline spans are blanked, because a code
 * span is where a reader is *told* to type `--judge` or `sha256` and the space
 * rule does not apply inside it. Blanking rather than deleting keeps the line
 * numbers honest: a failure has to name the line a reader can open.
 */
export function proseLines(markdown: string): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  let fenced = false;
  markdown.split('\n').forEach((raw, index) => {
    if (/^\s*(?:```|~~~)/u.test(raw)) {
      fenced = !fenced;
      return;
    }
    if (fenced) return;
    out.push({ line: index + 1, text: raw.replace(/`[^`]*`/gu, '') });
  });
  return out;
}

/** Every tight Han/letter boundary in one document, in reading order. */
export function tightBoundaries(document: Document): Boundary[] {
  const found: Boundary[] = [];
  for (const { line, text } of proseLines(document.text)) {
    for (const match of text.matchAll(new RegExp(HAN_AGAINST_LETTER.source, 'gu'))) {
      found.push({ path: document.path, line, pair: match[0] });
    }
  }
  return found;
}

/**
 * How many spaced boundaries a document writes — the half that is paid for.
 *
 * Walked character by character rather than matched with a regex, so a boundary
 * is counted **once**. A pattern with a Han side and a Latin side matches the
 * same junction twice (once from each end), which would double every number this
 * gate quotes and make the floor below a floor over a doubled count.
 */
export function spacedBoundaries(document: Document): number {
  let count = 0;
  for (const { text } of proseLines(document.text)) {
    let previous: string | null = null;
    let gap = false;
    for (const char of text) {
      if (/^\s$/u.test(char)) {
        gap = true;
        continue;
      }
      if (previous !== null && gap) {
        const hanFirst = IS_HAN.test(previous) && IS_LETTER.test(char);
        const latinFirst = IS_LETTER.test(previous) && IS_HAN.test(char);
        if (hanFirst || latinFirst) count += 1;
      }
      previous = char;
      gap = false;
    }
  }
  return count;
}

/**
 * Every way the documents break the rule, as sentences a reader can act on.
 *
 * Pure in its input so the red direction is driven on fixtures rather than
 * argued about: a check whose failure path has never executed is a check that
 * might be returning `[]` whatever it is handed.
 */
export function boundaryProblems(documents: readonly Document[]): string[] {
  const problems: string[] = [];
  for (const document of documents) {
    for (const { path, line, pair } of tightBoundaries(document)) {
      problems.push(
        `${path}:${line}: sets '${pair}' with no space at the junction — 中英混排 wants one, ` +
          'and a markdown page gets no help from the engine: the eighth of an em ' +
          '`text-autospace` paints on screen does not exist here, so the space has to be ' +
          'written in the source',
      );
    }
  }
  return problems;
}

/** The documents this gate reads, read off disk. */
function documents(): Document[] {
  return markdownDocuments(REPO_ROOT)
    .filter((path: string) => path !== LOCKED_DRAFT)
    .map((path: string) => ({ path, text: readFileSync(join(REPO_ROOT, path), 'utf8') }));
}

const DOCUMENTS = documents();

describe('the documents a reader is sent to keep their 中英混排 spaces', () => {
  it('sets no Han character against a Latin letter', () => {
    const problems = boundaryProblems(DOCUMENTS);
    expect(
      problems,
      `the documents set a boundary with no space in it:\n  ${problems.join('\n  ')}`,
    ).toEqual([]);
  });

  it('is not vacuous: the pages really do write the spaced shape', () => {
    // "0 tight boundaries" is only a fact about the prose if the same scan also
    // finds the shape it is looking for. A regex that stopped matching — a
    // changed Han range, a `proseLines()` that returned nothing — would report
    // zero problems for every document in the repository.
    const total = DOCUMENTS.reduce((sum, document) => sum + spacedBoundaries(document), 0);
    expect(
      total,
      `the scan found ${total} spaced Han/letter boundary(ies) across ${DOCUMENTS.length} ` +
        'document(s) — too few for "no tight boundaries" to be a fact about the prose rather ' +
        'than about the scan having stopped finding boundaries at all',
    ).toBeGreaterThan(1000);
  });

  it('reads the three pages a presenter reads out loud', () => {
    // The gate is only worth its name if the pages it was written for are in the
    // set. A `markdownDocuments()` that stopped walking `docs/` would leave the
    // two cases above green over README alone.
    const paths = DOCUMENTS.map((document) => document.path);
    for (const page of DEFENCE_PAGES) {
      expect(paths, `${page} is not among the documents this gate reads`).toContain(page);
    }
  });

  it('leaves the locked draft alone', () => {
    // Stated as a case rather than left in a `filter`: if the exclusion is ever
    // removed, this says why it was there instead of the gate demanding an edit
    // to a file the repository is not allowed to change.
    expect(DOCUMENTS.map((document) => document.path)).not.toContain(LOCKED_DRAFT);
  });

  it('goes red on a tight boundary, and names the line', () => {
    const problems = boundaryProblems([
      { path: 'docs/example.md', text: '# 标题\n\n这一屏显示Agent 的引擎链。\n' },
    ]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('docs/example.md:3');
    expect(problems[0]).toContain("'示A'");
  });

  it('goes red in the other direction too', () => {
    // Latin first, Han second: the same defect read the other way round, and the
    // shape a sentence takes when an identifier ends it ('… 见 README 的说明' vs
    // '… 见README的说明').
    const problems = boundaryProblems([
      { path: 'docs/example.md', text: '详见README的说明。\n' },
    ]);
    // Two boundaries, because the identifier is a word: '见R' where it starts and
    // 'E的' where it ends. Both are the same defect and both are named.
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain("'见R'");
    expect(problems[1]).toContain("'E的'");
  });

  it('does not read code as prose', () => {
    // A fenced block and an inline span are where a reader is told to type
    // something; the space rule does not apply inside them, and a gate that
    // counted them would force spaces into commands.
    const problems = boundaryProblems([
      {
        path: 'docs/example.md',
        text: '```bash\nnode scripts/verify-main-chain.mjs --judge报告.json\n```\n\n' +
          '跑 `--judge报告` 这一条。\n',
      },
    ]);
    expect(problems).toEqual([]);
  });

  it('does not read a digit as a Latin letter', () => {
    // The exemption the header explains, asserted rather than described: '第1步'
    // is ordinary Chinese, and a gate that rejected it would be a style
    // preference wearing a layout error's clothes.
    const problems = boundaryProblems([
      { path: 'docs/example.md', text: '第1步与 3 条改动。\n' },
    ]);
    expect(problems).toEqual([]);
  });

  it('counts the spaced shape it is looking for', () => {
    // The census case's own red direction: if `spacedBoundaries()` returned 0 for
    // everything, the floor above would be the only thing that noticed, and it
    // would report a number rather than a broken counter.
    const document = { path: 'docs/example.md', text: '显示 Agent 的引擎链，见 README 一节。\n' };
    expect(spacedBoundaries(document)).toBe(4);
    expect(tightBoundaries(document)).toEqual([]);
  });
});
