/**
 * The type contract: one floor for Chinese, declared in one place.
 *
 * The layout gate measures type size in a real engine
 * (`tests/contract/layout.test.ts`, target by target, five states, eight
 * widths). This file is the fast half of the same promise: it reads the two
 * source files that have to agree — `scripts/layout-page-scripts.mjs`, which
 * measures, and `styles.css`, which declares — and fails in under a second if
 * they drift. Without it the floor would be a number copied into two files,
 * which is how a floor becomes a suggestion.
 *
 * It also pins the three things about the font stack that cannot be seen in a
 * screenshot at 1440x900 with the system's default fonts installed: the order
 * of the families (Latin resolves first, then Chinese, then a generic), the
 * generic fallback being last, and the absence of fake italics — a slanted
 * Han glyph is a synthesised oblique, not a typeface.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { dictionaryFor } from '../../apps/desktop/src/shared/i18n';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, '..', '..');
const STYLES = path.join(REPO_ROOT, 'apps/desktop/src/renderer/src/styles.css');
const PAGE_SCRIPTS = path.join(REPO_ROOT, 'scripts', 'layout-page-scripts.mjs');

const styles = fs.readFileSync(STYLES, 'utf8');
const pageScripts = fs.readFileSync(PAGE_SCRIPTS, 'utf8');

/**
 * The source with its comments removed.
 *
 * Both files explain themselves in prose that quotes the numbers they declare
 * ("--fs-min-cjk is 12px" appears in the comment above the token). A regex over
 * raw source reads those sentences as declarations — the layout gate learned
 * this the hard way with `minWidth: 1080`. A comment is not a declaration.
 */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** One custom property's value, as declared in `:root`. */
function token(name: string): string {
  const match = new RegExp(`--${name}:\\s*([^;]+);`).exec(codeOnly(styles));
  expect(match, `styles.css does not declare --${name}`).not.toBeNull();
  return match![1]!.trim();
}

/** Every family in a font stack, in declared order, unquoted. */
function families(name: string): string[] {
  return token(name)
    .split(',')
    .map((family) => family.trim().replace(/^"|"$/g, ''))
    .filter((family) => family.length > 0);
}

describe('the Chinese type floor', () => {
  it('is declared once in the stylesheet and once in the measurement, and they agree', () => {
    // Read, not imported: the page script is ESM JavaScript outside the
    // TypeScript project, and the check is about the literal in the source.
    const measured = /export const CJK_FLOOR_PX = (\d+(?:\.\d+)?);/.exec(pageScripts);
    expect(measured, 'layout-page-scripts.mjs no longer exports CJK_FLOOR_PX').not.toBeNull();
    const floor = Number(measured![1]);

    expect(token('fs-min-cjk'), 'styles.css and the layout gate disagree about the floor').toBe(
      `${floor}px`,
    );
    expect(floor, 'a floor under 12px stops being a floor for Han text').toBeGreaterThanOrEqual(12);
  });

  it('is what the measurement actually uses, rather than a second copy of the number', () => {
    // `const cjkFloor = 12;` inside the page script would compile, measure and
    // pass — and silently stop tracking the stylesheet. The interpolation is
    // the link; this asserts the link exists.
    expect(pageScripts).toContain('const cjkFloor = ${CJK_FLOOR_PX};');
  });

  it('governs the note role, and leaves the identifier role below it on purpose', () => {
    // Prose roles must clear the floor; the mono role may sit under it because
    // what it sets is ASCII — paths, hashes, counts, arrows.
    expect(token('fs-note')).toBe('var(--fs-min-cjk)');
    const body = Number(/^(\d+(?:\.\d+)?)px$/.exec(token('fs-body'))?.[1]);
    expect(body, 'body prose must be at least as large as the floor').toBeGreaterThanOrEqual(12);
    const fine = Number(/^(\d+(?:\.\d+)?)px$/.exec(token('fs-fine'))?.[1]);
    expect(fine, 'the identifier role is the only role allowed under the floor').toBeLessThan(12);
  });
});

/**
 * The type scale: four sizes, and every rule has to pick one of them.
 *
 * ## Why a count is the check
 *
 * The roles above were declared and then ignored. Forty-seven rules wrote their
 * own `font-size` — 9, 10, 10.5, 11, 11.5, 12, 12.5, 13, 13.5, 14 and 18px —
 * so one screen carried a section label at 12.5px beside an identical one at
 * 12px, and a table at 12.5px above a card at 12px. None of those is wrong on
 * its own; together they are the reason the app reads as assembled rather than
 * designed. A half-pixel is not a decision, it is the residue of eleven rounds
 * each picking a number that looked right in isolation.
 *
 * ## What is asserted, and what is not
 *
 * Two things, both mechanical:
 *
 *  1. every `font-size` in the stylesheet is a `var(--fs-…)` — a raw `12.5px`
 *     is the failure mode, and it is caught by name;
 *  2. the sizes those tokens resolve to number **at most four**.
 *
 * Not asserted: which rule gets which role. That is a design judgement, and a
 * test that pinned it would have to be rewritten every time a panel is
 * restyled — the kind of gate that gets deleted. The count is the part that
 * cannot be argued with: a fifth size is a decision, and it has to be made
 * here rather than typed into a rule.
 *
 * The tokens are resolved through their `var()` aliases rather than compared
 * as strings, because `--fs-note: var(--fs-min-cjk)` is the same size as
 * `--fs-min-cjk` and counting the two spellings as two tiers would make the
 * gate lie in the safe direction — it would pass a stylesheet with five real
 * sizes as long as two of them shared a name.
 */
describe('the type scale', () => {
  /** Every `--fs-*` token in `:root`, resolved through its `var()` aliases. */
  function scale(): Map<string, string> {
    const root = /:root\s*\{([\s\S]*?)\n\}/.exec(codeOnly(styles));
    expect(root, 'styles.css has no :root block').not.toBeNull();

    const declared = new Map<string, string>();
    for (const match of root![1]!.matchAll(/--(fs-[\w-]+):\s*([^;]+);/g)) {
      declared.set(match[1]!, match[2]!.trim());
    }
    expect(declared.size, 'styles.css declares no --fs-* token at all').toBeGreaterThan(0);

    const resolve = (name: string, depth = 0): string => {
      const value = declared.get(name);
      expect(value, `--${name} is used but never declared`).toBeDefined();
      const alias = /^var\(--([\w-]+)\)$/.exec(value!);
      if (!alias) return value!;
      expect(depth, `--${name} resolves through more than four aliases`).toBeLessThan(4);
      return resolve(alias[1]!, depth + 1);
    };

    return new Map([...declared.keys()].map((name) => [name, resolve(name)]));
  }

  /** Every `font-size` declaration in the file, with the selector that wrote it. */
  function declarations(): Array<{ selector: string; value: string }> {
    const found: Array<{ selector: string; value: string }> = [];
    for (const rule of codeOnly(styles).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const size = /font-size:\s*([^;]+);/.exec(rule[2]!);
      if (size) found.push({ selector: rule[1]!.trim().replace(/\s+/g, ' '), value: size[1]!.trim() });
    }
    return found;
  }

  it('declares four roles, and they are four different sizes', () => {
    const roles = scale();
    // The floor is a token, not a role: it is the number the note role resolves
    // to, and it exists so the layout gate and the stylesheet can be compared.
    expect([...roles.keys()].sort()).toEqual([
      'fs-body',
      'fs-display',
      'fs-fine',
      'fs-min-cjk',
      'fs-note',
    ]);

    const px = (name: string): number => {
      const value = roles.get(name)!;
      const number = Number(/^(\d+(?:\.\d+)?)px$/.exec(value)?.[1]);
      expect(number, `--${name} is ${value}, which is not a length in px`).toBeGreaterThan(0);
      return number;
    };

    // Ordered, because a scale that is not ordered is a set of numbers.
    expect(px('fs-display'), 'the display role must be the largest').toBeGreaterThan(px('fs-body'));
    expect(px('fs-body'), 'body must be larger than the note role').toBeGreaterThan(px('fs-note'));
    expect(px('fs-note'), 'the note role must be larger than the identifier role').toBeGreaterThan(
      px('fs-fine'),
    );
    // And the note role *is* the floor: a note may never fall under it.
    expect(roles.get('fs-note'), 'the note role and the Chinese floor must be one number').toBe(
      roles.get('fs-min-cjk'),
    );
  });

  it('writes no raw size anywhere — every rule picks a role', () => {
    const raw = declarations().filter((decl) => !/^var\(--fs-[\w-]+\)$/.test(decl.value));
    expect(
      raw.map((decl) => `${decl.selector} { font-size: ${decl.value} }`),
      'these rules set a size of their own instead of picking a role',
    ).toEqual([]);
  });

  it('puts at most four sizes on a screen', () => {
    const roles = scale();
    const used = new Set<string>();
    for (const decl of declarations()) {
      const name = /^var\(--(fs-[\w-]+)\)$/.exec(decl.value)?.[1];
      expect(name, `${decl.selector} does not use a --fs-* token`).toBeDefined();
      used.add(roles.get(name!)!);
    }

    // Four is what a screen holds without the reader noticing the type at all.
    // A fifth size is a decision; make it here, in this number, with a reason.
    expect(
      [...used].sort(),
      `the stylesheet sets ${used.size} sizes; four is the ceiling`,
    ).toHaveLength(4);
    expect(used.size, 'the stylesheet sets fewer sizes than it declares roles').toBe(4);
  });
});

/**
 * The prose measure: how long a line may be, and where it may break.
 *
 * The layout gate measures both in a real engine (`tests/contract/layout.test.ts`,
 * every target, five states, eight widths). This is the fast half: the numbers
 * and the character sets are declared once, in the page script, and the
 * stylesheet has to set prose to a measure inside the band. Without it the
 * ceiling would be a number copied into two files — which is how a ceiling
 * becomes a suggestion.
 */
describe('the prose measure', () => {
  /** The declared ceiling, read out of the page script. */
  function ceiling(): number {
    const match = /export const MAX_PROSE_LINE_CJK = (\d+);/.exec(pageScripts);
    expect(match, 'layout-page-scripts.mjs no longer exports MAX_PROSE_LINE_CJK').not.toBeNull();
    return Number(match![1]);
  }

  it('declares a ceiling inside the band, and the measurement uses that number', () => {
    /*
     * 28–40 characters is the band Chinese and Latin reading research agree on.
     * The floor is a design choice (a narrow panel legitimately sets shorter
     * lines) and is not gated; the ceiling is a reading problem and is. A
     * ceiling above 40 stops being the rule the comment above it describes.
     */
    const declared = ceiling();
    expect(declared, 'a ceiling under 28 characters is not the band this rule is about')
      .toBeGreaterThanOrEqual(28);
    expect(declared, 'a ceiling over 40 characters is past the point the eye re-reads')
      .toBeLessThanOrEqual(40);
    // The interpolation is the link: `const MAX_LINE = 40;` inside the page
    // script would compile, measure and pass, and silently stop tracking this
    // constant.
    expect(pageScripts).toContain('const MAX_LINE = ${MAX_PROSE_LINE_CJK};');
  });

  it('names the characters that may not start or end a line, and the measurement uses them', () => {
    /*
     * 行首禁则 / 行尾禁则. The sets are asserted by content, not by length: a
     * set that lost '。' would still be non-empty and would still be
     * interpolated, and the gate would pass over the one character that
     * matters most.
     */
    const start = /export const LINE_START_FORBIDDEN = '([^']+)';/.exec(pageScripts);
    const end = /export const LINE_END_FORBIDDEN = '([^']+)';/.exec(pageScripts);
    expect(start, 'layout-page-scripts.mjs no longer exports LINE_START_FORBIDDEN').not.toBeNull();
    expect(end, 'layout-page-scripts.mjs no longer exports LINE_END_FORBIDDEN').not.toBeNull();

    for (const mark of ['。', '，', '、', '；', '：', '？', '！', '）', '」', '』', '】']) {
      expect(start![1], `a line may start with '${mark}'`).toContain(mark);
    }
    for (const mark of ['（', '「', '『', '【', '“']) {
      expect(end![1], `a line may end with '${mark}'`).toContain(mark);
    }
    // No character may be in both sets: a mark that may neither start nor end a
    // line could not be set at all.
    const both = [...start![1]].filter((ch) => end![1]!.includes(ch));
    expect(both, 'these characters are forbidden at both ends of a line').toEqual([]);

    expect(pageScripts).toContain(
      'const START_FORBIDDEN = ${JSON.stringify(LINE_START_FORBIDDEN)};',
    );
    expect(pageScripts).toContain('const END_FORBIDDEN = ${JSON.stringify(LINE_END_FORBIDDEN)};');
  });

  it('sets prose to a measure inside the band, not to the page column', () => {
    /*
     * The measured defect: the help page's paragraphs were set to the page
     * column (960px) and came out at 70.1 and 69.0 Han characters per line.
     * The fix is a measure in em — one Han character is about one em, so the
     * number in the stylesheet *is* a line length in characters — and this
     * asserts the two halves agree: the stylesheet's measure is inside the
     * band, and it is not wider than the ceiling the gate enforces.
     */
    const measure = token('measure-prose');
    const em = Number(/^(\d+(?:\.\d+)?)em$/.exec(measure)?.[1]);
    expect(em, `--measure-prose is ${measure}, which is not a length in em`).toBeGreaterThan(0);
    expect(em, 'a prose measure under 28 characters is a design choice, not this rule')
      .toBeGreaterThanOrEqual(28);
    expect(em, 'prose set wider than the ceiling the layout gate enforces').toBeLessThanOrEqual(
      ceiling(),
    );

    // And the prose rule actually uses it: a token nothing consumes is a
    // comment with a colon in it.
    expect(codeOnly(styles)).toMatch(/\.card > p \{[^}]*max-width: var\(--measure-prose\)/);
    expect(codeOnly(styles)).toMatch(/\.terminal-note \{[^}]*max-width: var\(--measure-prose\)/);
  });
});

describe('the font stacks', () => {
  it('resolves Latin first, then Chinese, then a generic family', () => {
    /*
     * The order is not cosmetic. Put a CJK family first and every Latin string
     * in the app — paths, hashes, engine ids — is drawn from a font whose Latin
     * is an afterthought, at a different x-height from the prose around it.
     * Put the generic last, or a `sans-serif` early swallows everything after
     * it on a machine that lacks the named families.
     */
    const stack = families('sans');
    const latin = stack.findIndex((f) => /Segoe UI|-apple-system|BlinkMacSystemFont|Inter/.test(f));
    const han = stack.findIndex((f) => /PingFang SC|Microsoft YaHei|Noto Sans CJK SC/.test(f));

    expect(latin, 'the sans stack names no Latin family').toBeGreaterThanOrEqual(0);
    expect(han, 'the sans stack names no Chinese family').toBeGreaterThan(latin);
    expect(stack.at(-1), 'the sans stack must end in a generic family').toBe('sans-serif');
    // `system-ui` is allowed as the last named family; nothing generic may
    // follow a generic, because everything after it is unreachable.
    expect(
      stack.filter((f) => f === 'sans-serif' || f === 'system-ui'),
      'the generic families must be the last entries, in that order',
    ).toEqual(['system-ui', 'sans-serif']);
  });

  it('keeps identifiers on a mono stack that ends in monospace', () => {
    const stack = families('mono');
    expect(stack.at(-1)).toBe('monospace');
    expect(stack.some((f) => /mono|Menlo|Consolas|Cascadia/.test(f))).toBe(true);
  });

  it('never fakes an italic', () => {
    // There is no italic cut of a Han glyph; `font-style: italic` on Chinese is
    // the engine slanting a face that has no such style, which reads as a
    // rendering bug rather than emphasis. This app has no `em`/`i` rule at all,
    // so the rule is simply: no italics anywhere.
    expect(codeOnly(styles)).not.toMatch(/font-style:\s*italic/);
  });
});

/**
 * The punctuation: half-width marks in Chinese, full-width marks in English.
 *
 * ## Why this is a separate, deliberately small check
 *
 * The type rules above are about *size*; this one is about the characters
 * between the words, and it is the half of Chinese typography that a source
 * file can be wrong about without anyone seeing it. `，` and `,` are different
 * characters with different widths, and a Chinese sentence that ends in a
 * half-width `,` sets a gap the reader reads as a typo — but only if they are
 * looking, and nobody proofreads 600 dictionary values.
 *
 * ## What is asserted, and what is not
 *
 * Two rules, both mechanical and both undisputed:
 *
 *  1. a `zh-CN` value never puts a half-width `,` `.` `;` `:` next to a Han
 *     character — neither before it nor after it;
 *  2. an `en-US` value never contains a full-width `，` `。` `；` `：` `、`.
 *
 * Not asserted: line length, spacing around Latin words, or whether a sentence
 * reads well. Those need a rendered page and a reader, and a gate that guessed
 * at them would go red on a legitimate sentence — which is how a typography
 * gate gets deleted. The two rules here cannot be right in the other direction:
 * there is no sentence in either language where the wrong-width mark is
 * correct.
 *
 * The dictionary is read through `dictionaryFor()` rather than by parsing the
 * source, so the check sees the values the app actually renders. A key that is
 * missing from one locale is `i18n.test.ts`'s problem, not this file's.
 */
describe('the punctuation', () => {
  const ZH = dictionaryFor('zh-CN');
  const EN = dictionaryFor('en-US');

  /** Han characters, the range both dictionaries write their prose in. */
  const HAN = '\u4e00-\u9fff';

  /** A half-width mark with a Han character on either side of it. */
  const HALF_WIDTH_NEAR_HAN = new RegExp(`(?:[,.;:](?=[${HAN}])|(?<=[${HAN}])[,.;:])`);

  /** A full-width mark, which English prose has no use for. */
  const FULL_WIDTH = /[，。；：、]/;

  it('never sets a half-width mark against a Han character in Chinese', () => {
    const offenders = Object.entries(ZH)
      .filter(([, value]) => HALF_WIDTH_NEAR_HAN.test(value))
      .map(([key, value]) => `zh-CN.${key}: ${value}`);
    expect(
      offenders,
      'these Chinese sentences use a half-width , . ; : next to a Han character — the ' +
        'full-width mark is the one that sets correctly in Chinese prose',
    ).toEqual([]);
  });

  it('never sets a full-width mark in English', () => {
    const offenders = Object.entries(EN)
      .filter(([, value]) => FULL_WIDTH.test(value))
      .map(([key, value]) => `en-US.${key}: ${value}`);
    expect(
      offenders,
      'these English sentences carry a full-width ，。；：、 — it is a Chinese mark, and it ' +
        'sets a gap the reader reads as a typo',
    ).toEqual([]);
  });

  it('is not vacuous: the dictionaries really are the ones being read', () => {
    // A `dictionaryFor()` that returned `{}` would make both cases above green
    // over nothing at all. The counts are the guard, and they are deliberately
    // loose — this is not a key-count gate (`i18n.test.ts` owns parity).
    expect(Object.keys(ZH).length, 'the Chinese dictionary is empty').toBeGreaterThan(100);
    expect(Object.keys(EN).length, 'the English dictionary is empty').toBeGreaterThan(100);
    // And the two rules really do fire on the shapes they describe, so a regex
    // that stopped matching cannot pass by finding nothing.
    expect(HALF_WIDTH_NEAR_HAN.test('先跑这条命令,然后看输出')).toBe(true);
    expect(HALF_WIDTH_NEAR_HAN.test('先跑这条命令，然后看输出')).toBe(false);
    expect(FULL_WIDTH.test('Run this command， then read the output')).toBe(true);
    expect(FULL_WIDTH.test('Run this command, then read the output')).toBe(false);
  });
});
