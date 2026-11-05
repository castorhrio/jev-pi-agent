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
import { dictionaryFor, type Locale } from '../../apps/desktop/src/shared/i18n';

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

/**
 * The two numbers the layout gate enforces, read out of the page script.
 *
 * They live in `scripts/layout-page-scripts.mjs` and nowhere else: the gate
 * measures with them, and every block below compares the stylesheet against
 * them. A second copy of `40` in this file would be a second fact, and the two
 * would drift the first time somebody tuned the band.
 */
function proseCeiling(): number {
  const match = /export const MAX_PROSE_LINE_CJK = (\d+);/.exec(pageScripts);
  expect(match, 'layout-page-scripts.mjs no longer exports MAX_PROSE_LINE_CJK').not.toBeNull();
  return Number(match![1]);
}

/** One of the two 禁则 sets, as the page script declares it. */
function forbiddenSet(name: 'LINE_START_FORBIDDEN' | 'LINE_END_FORBIDDEN'): string {
  const match = new RegExp(`export const ${name} = '([^']+)';`).exec(pageScripts);
  expect(match, `layout-page-scripts.mjs no longer exports ${name}`).not.toBeNull();
  return match![1]!;
}

/**
 * One of the two character sets the layout measurement defines.
 *
 * 中英混排间距 is one rule in two places: this file checks the *dictionary* (the
 * text the app writes), `scripts/layout-page-scripts.mjs` checks the *rendered
 * page* (the text it does not). A rule with two halves has to be judged over one
 * set of characters, and a second spelling of the Han range in this file is how
 * the halves drift — the Chinese half of a sentence would be checked against
 * U+4E00–U+9FFF while the engine half used the wider set, and neither would be
 * wrong-looking in a diff. The page script owns the sets; they are read back out
 * of its source rather than imported, for the same reason the two line-length
 * numbers are: the page script is ESM JavaScript outside the TypeScript project,
 * and the question is what the file declares, not what a copy resolves to.
 */
function charClass(name: 'HAN_CLASS' | 'LATIN_CLASS'): string {
  const match = new RegExp(`export const ${name} = '([^']+)';`).exec(codeOnly(pageScripts));
  expect(match, `layout-page-scripts.mjs no longer exports ${name}`).not.toBeNull();
  return match![1]!;
}

/**
 * The dictionary the app renders, read with the line each key is written on.
 *
 * ## Why the source is read at all
 *
 * The punctuation block below already reads the *values* through
 * `dictionaryFor()`, which is the right way to see what the app renders. What
 * it could not say was **where**: a failure that prints
 * `zh-CN.providers.subtitle: …` sends the reader to a 1,600-line file and a
 * search. The line number is the difference between a gate that reports a
 * defect and one that reports a place to fix it.
 *
 * The values still come from `dictionaryFor()`, not from the source text: a
 * value assembled at runtime (or a key the dictionary does not export) would be
 * read wrong by a parser, and `i18n.test.ts` owns key parity. The source is
 * read for one thing only — the line the key sits on.
 */
const I18N_PATH = path.join(REPO_ROOT, 'apps/desktop/src/shared/i18n.ts');
const I18N_RELATIVE = 'apps/desktop/src/shared/i18n.ts';
const i18nSource = fs.readFileSync(I18N_PATH, 'utf8');

/** The Chinese dictionary, read once. */
const ZH_DICTIONARY = dictionaryFor('zh-CN');

/**
 * The English dictionary, read once.
 *
 * Its prose is not this file's subject — 行首禁则, the full-width marks and the
 * gap between the two scripts are rules about Chinese — but its *shape* is: the
 * same parser reads it, so the same audit of that parser applies to it.
 */
const EN_DICTIONARY = dictionaryFor('en-US');

/** One dictionary entry, with the line it is written on. */
interface Entry {
  readonly key: string;
  readonly value: string;
  /** 1-based line in `apps/desktop/src/shared/i18n.ts`. */
  readonly line: number;
}

/**
 * Every entry of one dictionary, with its line.
 *
 * The block is delimited by `const zhCN: Dictionary = {` (or its `enUS` twin)
 * and the first `};` at column 0 after it, and a key is a line that *starts*
 * with `'key':`. That is narrower than a JavaScript parser on purpose: a value
 * may contain `//` (a URL) or a `'` (an apostrophe), and a regex that tried to
 * understand the object would be wrong in a way that silently skips entries.
 * The narrow rule is checked for coverage below — every key the dictionary
 * exports has to be found, in both locales — so a key written in another shape
 * is a red run, not a silent skip.
 *
 * `zhEntries()` is the same reader pinned to the locale this file's typesetting
 * rules are about; the two dictionaries are written in one shape, so the
 * coverage and line-number machinery below serves both.
 */
function entriesFor(locale: Locale, source: string = i18nSource): Entry[] {
  const dictionary = dictionaryFor(locale);
  const decl = DICTIONARY_DECL[locale];
  const start = source.indexOf(decl);
  expect(start, `${I18N_RELATIVE} no longer declares \`${decl}\``).toBeGreaterThanOrEqual(0);
  const end = source.indexOf('\n};', start);
  expect(end, `the ${dictionaryName(locale)} dictionary is not closed by a \`};\` at column 0`)
    .toBeGreaterThan(start);

  // The 1-based line the `const …` line sits on; index 0 of the block is it.
  const firstLine = source.slice(0, start).split('\n').length;
  const entries: Entry[] = [];
  source
    .slice(start, end)
    .split('\n')
    .forEach((text, index) => {
      const match = /^\s*'([\w.-]+)':/u.exec(text);
      if (match === null) return;
      const key = match[1]!;
      const value = dictionary[key];
      // A key the dictionary does not export is `i18n.test.ts`'s problem.
      if (value === undefined) return;
      entries.push({ key, value, line: firstLine + index });
    });
  return entries;
}

function zhEntries(source: string = i18nSource): Entry[] {
  return entriesFor('zh-CN', source);
}

/**
 * Where each dictionary is declared, as the exact text that opens its block.
 *
 * Both blocks are written `'key': 'value',` and both are closed by a `};` at
 * column 0, which is what lets one reader and one literal counter serve them.
 * The anchors are listed rather than derived from the locale names because the
 * variable names do not match the locale tags (`zhCN` for `zh-CN`): a name
 * assembled from the tag would be a second fact about a file this test only
 * reads, and it would stop finding the block the day the variable is renamed.
 */
const DICTIONARY_DECL: Record<Locale, string> = {
  'zh-CN': 'const zhCN: Dictionary = {',
  'en-US': 'const enUS: Dictionary = {',
};

/** The variable name a block is declared in, for the failure messages. */
function dictionaryName(locale: Locale): string {
  return /const (\w+)/.exec(DICTIONARY_DECL[locale])![1]!;
}

/**
 * The `const <name>: Dictionary = {` … `\n};` block of a source, comments removed.
 *
 * Comments are stripped before anything is counted: the block explains itself in
 * prose, and that prose contains apostrophes (`this turn's decision records`).
 * A counter that read them as string literals would report two more literals
 * than there are and the gate would be red for a sentence nobody renders.
 */
function dictionaryBlock(source: string, locale: Locale): string | undefined {
  const start = source.indexOf(DICTIONARY_DECL[locale]);
  if (start === -1) return undefined;
  const end = source.indexOf('\n};', start);
  if (end === -1) return undefined;
  return codeOnly(source.slice(start, end));
}

/**
 * How many string literals a block contains, in either quote style.
 *
 * A character scan rather than a regex, because a value may contain an escaped
 * apostrophe (`'don\'t'`) and a regex that stopped at the first `'` would count
 * one literal as two. `\\` is skipped so an escaped backslash before a quote
 * does not end the string early.
 *
 * Both quote styles are scanned, and the *other* quote character is treated as
 * ordinary text inside a string. The counter is proving one thing: every entry
 * contributes exactly two literals, a key and a value. Reading only `'` broke
 * that on the English block, which has a value written in double quotes because
 * the sentence contains an apostrophe (`handoff.carryPromptTitle`) — and the
 * gate reported 1,329 literals against 1,330 expected, blaming the dictionary
 * for a fact about the counter. The two styles cannot be counted by two
 * independent rules either: whichever quote *opened* the literal is the only one
 * that closes it, so an apostrophe inside a double-quoted sentence is text, not
 * the start of a second literal — which is why this is a scan with a state
 * variable rather than two regexes.
 */
function stringLiterals(block: string): number {
  let count = 0;
  let quote: string | null = null;
  for (let index = 0; index < block.length; index += 1) {
    const char = block[index]!;
    if (quote !== null) {
      if (char === '\\') {
        index += 1;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      count += 1;
    }
  }
  return count;
}

/**
 * Every way the parser reads fewer sentences than the dictionary contains.
 *
 * ## Why the key-parity assertion above is not enough
 *
 * `zhEntries()` is compared against `Object.keys(ZH_DICTIONARY)`, which catches a
 * key written in a shape the parser does not recognise (`"key":`, `key:`) — the
 * dictionary exports it and the parser skips it. What that comparison cannot see
 * is a string that is **not a top-level key at all**: a nested object, an array
 * of sentences, a value split across two literals. Those are skipped by the
 * parser *and* absent from `Object.keys()`, so both sides of the comparison
 * shrink together and the gate stays green over a sentence nobody read.
 *
 * The count closes that direction. Every entry in either dictionary is written
 * as one literal for the key and one for the value, so the number of string
 * literals in the block is exactly twice the number of entries. A nested object
 * adds literals without adding entries, and the failure names the two numbers
 * and the difference.
 *
 * ## Why it runs over both dictionaries
 *
 * The typesetting rules in this file are about Chinese, so they read `zh-CN`
 * alone — and the coverage check inherited that scope, which left the English
 * block with a parser nobody was auditing: a nested object there is skipped by
 * `entriesFor('en-US')` and absent from `Object.keys()` all the same. Coverage
 * is a claim about the reader, not about the language, so both blocks are
 * counted. The rules that are Chinese-only stay Chinese-only.
 *
 * ## What it cannot see
 *
 * A value that is not a literal at all (`'key': SOME_CONST`) adds no literal and
 * no entry, so the count stays even. That shape is caught by the key-parity
 * assertion instead, because `dictionaryFor()` still exports the key. The two
 * checks are the two halves of one claim: every key is read, and nothing else is
 * in there.
 */
function literalCoverageProblems(
  source: string,
  entries: readonly Entry[],
  locale: Locale = 'zh-CN',
): string[] {
  const block = dictionaryBlock(source, locale);
  const name = dictionaryName(locale);
  if (block === undefined) {
    return [`${I18N_RELATIVE}: has no \`${DICTIONARY_DECL[locale]}\` … \`};\` block to count`];
  }
  const literals = stringLiterals(block);
  const expected = entries.length * 2;
  if (literals === expected) return [];
  return [
    `${I18N_RELATIVE}: the ${name} block carries ${literals} string literal(s) and the parser ` +
      `read ${entries.length} entr(ies), which is ${expected} literal(s) — ${literals - expected} ` +
      'literal(s) are in the dictionary and in no sentence this gate checks. A nested object or ' +
      'an array of sentences is skipped by the parser and absent from Object.keys(), so the ' +
      'key-parity assertion shrinks with it and stays green',
  ];
}

/** The line each `zh-CN` key is written on, built once. */
let zhLineMap: Map<string, number> | undefined;
function zhLines(): Map<string, number> {
  zhLineMap ??= new Map(zhEntries().map((entry) => [entry.key, entry.line]));
  return zhLineMap;
}

/**
 * Every way a Chinese sentence would set badly *on screen*, with its line.
 *
 * ## Why this is not the same check as the punctuation block
 *
 * The punctuation block asks whether a value uses the right mark. This one asks
 * whether the sentence can be **set**: a value that begins with `，` or ends
 * with `「` is a sentence whose first or last line would carry a mark 行首禁则 /
 * 行尾禁则 forbid, and the engine will do exactly that when the column wraps it.
 * The layout gate measures the same two rules on rendered line boxes
 * (`scripts/layout-page-scripts.mjs`, rule 8); this is the fast half, and it
 * names the dictionary entry rather than a box on a page.
 *
 * ## The third rule, and why it is here rather than only in the engine
 *
 * 中英混排间距 — the air where Han text and a Latin word meet. Two rules, not one:
 * a Han character may not be set against a Latin *letter*, and it may not be set
 * against an *interpolation slot* either, because a slot is that boundary one
 * substitution away. Digits are exempt on purpose — '第1步' is ordinary Chinese —
 * and `LATIN_LETTER` says why that is the right split rather than a hole.
 *
 * The engine half belongs to the layout gate and stays there: it is the only
 * thing that can judge text this repository does not write (a file name, an
 * agent's sentence, something typed into the composer). What the engine cannot do
 * is travel — the eighth of an em it inserts exists only while the sentence is
 * being painted, and the same line pasted into a handoff prompt, an issue or a
 * log is back to no gap. So the dictionary carries its own space, and this is the
 * half that keeps the rendered boundaries the layout gate measures (509 on the
 * current build) honest without asking the engine for a favour.
 *
 * A pure function of its input, so the red direction is driven on fixtures
 * rather than argued about.
 */
function typesetProblems(entries: readonly Entry[]): string[] {
  const startForbidden = forbiddenSet('LINE_START_FORBIDDEN');
  const endForbidden = forbiddenSet('LINE_END_FORBIDDEN');
  const problems: string[] = [];

  for (const { key, value, line } of entries) {
    const where = `${I18N_RELATIVE}:${line} (zh-CN.${key})`;

    if (HALF_WIDTH_NEAR_HAN.test(value)) {
      problems.push(
        `${where}: "${value}" sets a half-width , . ; : against a Han character — the ` +
          'full-width mark is the one that sets correctly in Chinese prose',
      );
    }

    const tight = HAN_AGAINST_LATIN.exec(value);
    if (tight !== null) {
      problems.push(
        `${where}: "${value}" sets a Han character directly against a Latin one ` +
          `('${tight[0]}') — 中英混排 wants a space at that boundary. On screen the engine can ` +
          'paint an eighth of an em there; copied into a handoff prompt, an issue or a log the ' +
          'sentence loses it, and the reader has nothing marking where the identifier starts',
      );
    }

    const slot = HAN_AGAINST_SLOT.exec(value);
    if (slot !== null) {
      problems.push(
        `${where}: "${value}" sets a Han character directly against the interpolation slot ` +
          `('${slot[0]}') — once the value is substituted that is a 中英混排 boundary with no ` +
          'space in it, and the sentence is the only place the space can still be written',
      );
    }

    value.split('\n').forEach((segment, index) => {
      const first = segment[0];
      const last = segment[segment.length - 1];
      const which = index === 0 ? 'the sentence' : `line ${index + 1} of the value`;
      if (first !== undefined && startForbidden.includes(first)) {
        problems.push(
          `${where}: ${which} starts with '${first}', which 行首禁则 forbids — a wrapped ` +
            'line would begin with a closing mark',
        );
      }
      if (last !== undefined && endForbidden.includes(last)) {
        problems.push(
          `${where}: ${which} ends with '${last}', which 行尾禁则 forbids — a wrapped line ` +
            'would end with an opening mark',
        );
      }
    });
  }

  return problems;
}

/**
 * How many boundaries of each shape a set of sentences actually holds.
 *
 * `typesetProblems` answers "is any sentence bad". It cannot answer "does the
 * gap rule have anything to bite", which is the question a guard has to survive:
 * a rule over an empty set is green for the same reason a skipped test is green.
 * And `docs/dod-status.md` quotes this census — the count of spaces the
 * dictionary writes, of digits it lets through on purpose, of interpolation
 * slots it holds. A number a reader cannot re-measure is a claim, so the
 * counting lives here, next to the rule it counts for, and the case below
 * asserts the floors.
 *
 * Digits are *derived*, not declared: `LATIN` is the set the layout measurement
 * judges the page by, `LATIN_LETTER` the narrower set the dictionary judges
 * sentences by, and a digit is exactly what one counts and the other does not.
 * Writing `0-9` a third time here would be the drift this file already removed
 * from the Han range.
 *
 * A boundary is "spaced" when the source put whitespace between the two
 * characters — which is what makes the spaced count the *paid-for* half and the
 * tight count the defect. Slot adjacency is read from the `{ident}` shape
 * itself, so a brace written for another reason is not counted as a hole.
 */
function gapCensus(entries: readonly Entry[]): {
  spacedLetters: number;
  tightLetters: number;
  spacedDigits: number;
  tightDigits: number;
  slots: number;
  tightSlots: number;
} {
  const isHan = new RegExp(`^[${HAN}]$`, 'u');
  const isLatin = new RegExp(`^[${LATIN}]$`, 'u');
  const isLetter = new RegExp(`^[${LATIN_LETTER}]$`, 'u');
  const census = {
    spacedLetters: 0,
    tightLetters: 0,
    spacedDigits: 0,
    tightDigits: 0,
    slots: 0,
    tightSlots: 0,
  };

  for (const { value } of entries) {
    let previous: string | null = null;
    let gap = false;
    for (const char of value) {
      if (/^\s$/u.test(char)) {
        gap = true;
        continue;
      }
      if (previous !== null) {
        const hanFirst = isHan.test(previous) && isLatin.test(char);
        const latinFirst = isLatin.test(previous) && isHan.test(char);
        if (hanFirst || latinFirst) {
          const letter = isLetter.test(previous) || isLetter.test(char);
          if (gap) {
            if (letter) census.spacedLetters += 1;
            else census.spacedDigits += 1;
          } else if (letter) census.tightLetters += 1;
          else census.tightDigits += 1;
        }
      }
      previous = char;
      gap = false;
    }

    for (const match of value.matchAll(/\{[A-Za-z0-9_]+\}/g)) {
      census.slots += 1;
      const before = value[match.index - 1];
      const after = value[match.index + match[0].length];
      const touchesHan =
        (before !== undefined && isHan.test(before)) || (after !== undefined && isHan.test(after));
      if (touchesHan) census.tightSlots += 1;
    }
  }

  return census;
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
  const ceiling = proseCeiling;

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
    const start = forbiddenSet('LINE_START_FORBIDDEN');
    const end = forbiddenSet('LINE_END_FORBIDDEN');

    for (const mark of ['。', '，', '、', '；', '：', '？', '！', '）', '」', '』', '】']) {
      expect(start, `a line may start with '${mark}'`).toContain(mark);
    }
    for (const mark of ['（', '「', '『', '【', '“']) {
      expect(end, `a line may end with '${mark}'`).toContain(mark);
    }
    // No character may be in both sets: a mark that may neither start nor end a
    // line could not be set at all.
    const both = [...start].filter((ch) => end.includes(ch));
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

/**
 * The prose column, in the unit the engine measures.
 *
 * ## Why the em measure is not enough on its own
 *
 * The block above pins `--measure-prose` in `em`, and one Han character is
 * about one em, so the number in the stylesheet *is* a line length in
 * characters. That is the right unit to declare and the wrong unit to stop at:
 * the layout gate measures **pixels** in a real engine, and a stylesheet that
 * changed `--fs-body` without touching the measure would keep the em number and
 * move the column. So this block converts the measure into the px the engine
 * reports and checks the band there too — the same band, in both units, from
 * one declaration.
 *
 * ## And why the cap is checked by shape
 *
 * The measured defect this repository has fixed three times is a prose block
 * that carried its own `max-width` — 720px on the steps, 860px on the handoff
 * document, 640px on the empty state — so one page had two right edges. Each
 * was removed by hand. The rule that keeps them from coming back is mechanical:
 * a rule that sets prose type may cap its width with the measure, or with a
 * viewport-relative cap (a toast has to fit the window, not a reading column),
 * and with nothing else. A raw `720px` is the failure mode, and it is caught by
 * name.
 */
describe('the prose column on screen', () => {
  /** `--measure-prose` in em, and `--fs-body` in px, as numbers. */
  function column(): { em: number; bodyPx: number; px: number } {
    const em = Number(/^(\d+(?:\.\d+)?)em$/u.exec(token('measure-prose'))?.[1]);
    const bodyPx = Number(/^(\d+(?:\.\d+)?)px$/u.exec(token('fs-body'))?.[1]);
    expect(em, `--measure-prose is ${token('measure-prose')}, which is not a length in em`)
      .toBeGreaterThan(0);
    expect(bodyPx, `--fs-body is ${token('fs-body')}, which is not a length in px`)
      .toBeGreaterThan(0);
    return { em, bodyPx, px: em * bodyPx };
  }

  it('is a width the engine measures as 28–40 Han characters', () => {
    const { em, bodyPx, px } = column();
    // One Han character is about one em, so the em measure is the character
    // count; the px conversion is what the layout gate reports.
    expect(em, 'a prose column under 28 characters is a design choice, not this rule')
      .toBeGreaterThanOrEqual(28);
    expect(em, 'prose set wider than the ceiling the layout gate enforces')
      .toBeLessThanOrEqual(proseCeiling());
    // The same band, in px, so a change to --fs-body cannot move the column out
    // of the band while the em number stays put.
    expect(px, `the prose column is ${px}px at ${bodyPx}px body type, under the floor`)
      .toBeGreaterThanOrEqual(28 * bodyPx);
    expect(px, `the prose column is ${px}px at ${bodyPx}px body type, past the ceiling`)
      .toBeLessThanOrEqual(proseCeiling() * bodyPx);
  });

  it('caps prose with the measure, never with a number of its own', () => {
    const offenders: string[] = [];
    let capped = 0;
    for (const rule of codeOnly(styles).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const body = rule[2]!;
      if (!/font-size:\s*var\(--fs-(?:body|note)\)/.test(body)) continue;
      const cap = /max-(?:width|inline-size):\s*([^;]+);/.exec(body);
      if (cap === null) continue;
      capped += 1;
      const value = cap[1]!.trim();
      if (value === 'var(--measure-prose)') continue;
      // A viewport-relative cap is not a reading column: a toast has to fit the
      // window, and `min(480px, calc(100vw - 24px))` says exactly that.
      if (/100v[wh]/.test(value)) continue;
      offenders.push(`${rule[1]!.trim().replace(/\s+/g, ' ')} { max-width: ${value} }`);
    }
    expect(
      offenders,
      'these prose rules cap their width with a number of their own — the measure is ' +
        '--measure-prose, and a second cap is a second right edge on the same page',
    ).toEqual([]);
    // A rule that caps nothing is not a pass: the check above would be green
    // over a stylesheet that stopped constraining prose at all.
    expect(capped, 'no prose rule caps its width at all').toBeGreaterThan(0);
  });
});

/**
 * The screen-side typeset: the sentences the app renders, checked where they
 * are written.
 *
 * ## Why the dictionary is the right place for this
 *
 * The layout gate measures line boxes in a real engine, which is the only way
 * to know what a *rendered* paragraph looks like — and it costs a browser, a
 * display and eight window widths. The other half of the same promise can be
 * answered in a millisecond: the strings the app renders are in one file, and
 * every rule below is a property of the string itself.
 *
 *  - **全角标点**: a half-width `,` next to a Han character sets a gap the
 *    reader reads as a typo (the punctuation block below owns the rule; this
 *    block reports it with the line it is on).
 *  - **行首禁则 / 行尾禁则**: a sentence that begins with `，` or ends with `「`
 *    is a sentence whose first or last line carries a mark the rule forbids —
 *    the engine will do exactly that when the column wraps it, and no amount of
 *    CSS fixes it. The sets are read from `scripts/layout-page-scripts.mjs`,
 *    the one place they are declared, so the fast half and the measured half
 *    cannot disagree about which characters are forbidden.
 *  - **中英混排间距**: a Han character may not be set against a Latin letter or
 *    an interpolation slot without a space between them. The census the case
 *    below measures: 178 spaced Han/letter boundaries (3 more involving digits)
 *    across 90 entries, 45 interpolation slots and no boundary of either kind
 *    set tight. So this rule costs the current dictionary nothing and only ever
 *    fires on the next sentence — and it is the half that survives being copied
 *    into a handoff prompt, where the engine's own eighth of an em does not exist.
 *  - **行长**: the column is 28–40 characters, asserted above in both units.
 *
 * ## What is not asserted
 *
 * Whether a sentence reads well, or how it wraps at a particular width. Those
 * need a reader and a rendered page. What is asserted cannot be right in the
 * other direction: there is no Chinese sentence whose first line should begin
 * with `。`.
 */
describe('the screen-side typeset', () => {
  it('sets every Chinese sentence so no line starts or ends on a forbidden mark, and no two scripts meet without air', () => {
    const problems = typesetProblems(zhEntries());
    expect(
      problems,
      `these dictionary entries would set badly on screen:\n  ${problems.join('\n  ')}`,
    ).toEqual([]);
  });

  it('is not vacuous: every key the app renders is read, with the line it is on', () => {
    const entries = zhEntries();
    expect(entries.length, 'the Chinese dictionary is empty').toBeGreaterThan(600);
    // Coverage, not a count: a key written in a shape the parser does not
    // recognise would be skipped silently, and the gate would be green over a
    // sentence nobody read.
    expect(entries.map((entry) => entry.key).sort()).toEqual(Object.keys(ZH_DICTIONARY).sort());

    const lines = i18nSource.split('\n');
    for (const entry of entries) {
      expect(entry.line, `${entry.key} is on line ${entry.line}, past the end of the file`)
        .toBeLessThanOrEqual(lines.length);
      // The line really is that key's line, so a failure sends the reader to the
      // sentence and not to its neighbour.
      expect(lines[entry.line - 1], `${entry.key} is not on line ${entry.line}`).toContain(
        `'${entry.key}':`,
      );
    }
  });

  it('reads every string literal in the dictionary, not only the ones it recognises', () => {
    const problems = literalCoverageProblems(i18nSource, zhEntries());
    expect(
      problems,
      `the dictionary carries sentences this gate never reads:\n  ${problems.join('\n  ')}`,
    ).toEqual([]);
  });

  it('reads the English dictionary with the same parser, and audits that parser the same way', () => {
    /*
     * The English half of "every literal is read".
     *
     * The typesetting rules stay Chinese-only — 行首禁则 means nothing to English
     * prose — but coverage is a claim about the *reader*, and the reader is shared:
     * a nested object in the `enUS` block is skipped by `entriesFor('en-US')` and
     * absent from `Object.keys()` exactly as it would be in Chinese. Leaving the
     * second block unaudited is the two-halves-done-one pattern this repository
     * keeps being told about.
     *
     * Counting both quote styles is what made this case reachable at all: the
     * English block has one value written in double quotes because the sentence
     * carries an apostrophe, and a single-quote counter reported the block one
     * literal short — so the check could not be turned on here without fixing the
     * counter first.
     */
    const entries = entriesFor('en-US');
    expect(entries.map((entry) => entry.key).sort()).toEqual(Object.keys(EN_DICTIONARY).sort());
    const problems = literalCoverageProblems(i18nSource, entries, 'en-US');
    expect(
      problems,
      `the English dictionary carries sentences this gate never reads:\n  ${problems.join('\n  ')}`,
    ).toEqual([]);
  });

  it('reports a nested entry the English parser would skip', () => {
    /*
     * The same fixture as the Chinese case, one block over, so the `locale`
     * parameter is proven to select a block rather than to be ignored.
     *
     * The insertion is done by line number, not by `replace`, and that is the
     * shape this case was written to catch. The first entry of the English block
     * is `'app.name': 'UCAD',` — a line byte-for-byte identical to the first
     * entry of the Chinese block, so the obvious `source.replace(anchor, …)`
     * edited *the Chinese one*, left the English block counting evenly, and the
     * case would have passed by proving nothing. The line is read from the parsed
     * entry and the splice is checked to land past the `const enUS` declaration.
     */
    const entries = entriesFor('en-US');
    const lines = i18nSource.split('\n');
    lines.splice(entries[0]!.line, 0, `  'app.nested': { 'a': 'One', 'b': 'Two' },`);
    const nested = lines.join('\n');
    expect(nested, 'the case did not add a nested entry').not.toBe(i18nSource);
    expect(nested.indexOf('const enUS: Dictionary = {')).toBeLessThan(
      nested.indexOf(`'app.nested': { 'a': 'One'`),
    );
    const problems = literalCoverageProblems(nested, entriesFor('en-US', nested), 'en-US');
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('the enUS block carries');
    // Five: the nested key, its two keys and its two values.
    expect(problems[0]).toContain('5 literal(s) are in the dictionary and in no sentence');
    // And the Chinese block is still read as itself, not as the edited one.
    expect(literalCoverageProblems(nested, entriesFor('zh-CN', nested))).toEqual([]);
  });

  it('reports a nested entry the parser would skip', () => {
    // The shape the key-parity assertion cannot see: `app.nested` is not a key
    // the dictionary exports, so both sides of that comparison shrink together.
    // Only the literal count notices the two sentences that went unread.
    const nested = i18nSource.replace(
      "  'app.name': 'UCAD',",
      "  'app.name': 'UCAD',\n  'app.nested': { 'a': '甲', 'b': '乙' },",
    );
    expect(nested, 'the case did not add a nested entry').not.toBe(i18nSource);
    const problems = literalCoverageProblems(nested, zhEntries(nested));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(`${I18N_RELATIVE}: the zhCN block carries`);
    // Five: the nested key, its two keys and its two values.
    expect(problems[0]).toContain('5 literal(s) are in the dictionary and in no sentence');
  });

  it('reports a dictionary block that is not there at all', () => {
    const problems = literalCoverageProblems('const other = {};', []);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('has no `const zhCN: Dictionary = {`');
  });

  it('reports a half-width comma with the file and the line it is on', () => {
    const problems = typesetProblems([
      { key: 'demo.sentence', value: '先跑这条命令,然后看输出', line: 42 },
    ]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(`${I18N_RELATIVE}:42`);
    expect(problems[0]).toContain('zh-CN.demo.sentence');
    expect(problems[0]).toContain('half-width');
  });

  it('reports a sentence whose first line would start with a closing mark', () => {
    const problems = typesetProblems([{ key: 'demo.start', value: '，先跑这条命令', line: 7 }]);
    expect(problems.join('\n')).toContain('行首禁则');
    expect(problems.join('\n')).toContain(`${I18N_RELATIVE}:7`);
  });

  it('reports a sentence whose last line would end with an opening mark', () => {
    const problems = typesetProblems([{ key: 'demo.end', value: '先跑这条命令「', line: 8 }]);
    expect(problems.join('\n')).toContain('行尾禁则');
    expect(problems.join('\n')).toContain(`${I18N_RELATIVE}:8`);
  });

  it('reports a wrapped line that would start with a closing mark', () => {
    const problems = typesetProblems([
      { key: 'demo.wrap', value: '先跑这条命令\n，然后看输出', line: 9 },
    ]);
    expect(problems.join('\n')).toContain('line 2 of the value');
    expect(problems.join('\n')).toContain('行首禁则');
  });

  it('reports a Chinese sentence that sets a Han character against a Latin word', () => {
    const problems = typesetProblems([
      { key: 'demo.tight', value: '改base_url就能接上', line: 12 },
    ]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(`${I18N_RELATIVE}:12`);
    expect(problems[0]).toContain('zh-CN.demo.tight');
    expect(problems[0]).toContain('中英混排');
    expect(problems[0]).toContain("'改b'");
  });

  it('reports a Chinese sentence that sets a Han character against an interpolation slot', () => {
    // The missing space has not happened yet in this string — it happens when
    // `count` is substituted, which is the moment nobody is reading the
    // dictionary. The slot is where the rule has to bite.
    const problems = typesetProblems([
      { key: 'demo.slot', value: '共{count}条改动', line: 13 },
    ]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(`${I18N_RELATIVE}:13`);
    expect(problems[0]).toContain('interpolation slot');
    expect(problems[0]).toContain('共{count}');
  });

  it('accepts the spaced shape the dictionary writes at those boundaries', () => {
    // The other direction, and the one that decides whether this rule can stay.
    // A gate that went red on every sentence mixing Han and Latin would be
    // deleted inside a week; the defect is the *missing* space, not the mix.
    expect(
      typesetProblems([
        { key: 'demo.spaced', value: '改 base_url 就能接上', line: 14 },
        { key: 'demo.slotSpaced', value: '共 {count} 条改动', line: 15 },
      ]),
    ).toEqual([]);
  });

  it('counts the boundaries the gap rule guards, so the guard is not green over nothing', () => {
    /*
     * The census `docs/dod-status.md` quotes, measured rather than typed.
     *
     * The gap rule passes today because the dictionary already writes the space
     * (the spaced half) and forbids the shape that omits it (the tight half).
     * Only the second half is asserted by `typesetProblems`, and a forbidden
     * shape that never occurs is also a rule that never fires — which is how the
     * previous round ended up writing "量过，决定不做" over a number nobody could
     * re-measure. So the count is asserted here: the fixture pins what each shape
     * contributes, and the real dictionary has to hold plenty of the paid-for
     * shape for the tight shape's absence to mean anything.
     */
    expect(
      gapCensus([
        { key: 'demo.letters', value: '改 base_url 就能接上', line: 1 },
        { key: 'demo.digits', value: '第 3 条', line: 2 },
        { key: 'demo.tight', value: '改base_url就能接上', line: 3 },
        { key: 'demo.tightDigit', value: '第3条', line: 4 },
        { key: 'demo.slot', value: '共 {count} 条', line: 5 },
        { key: 'demo.tightSlot', value: '共{count}条', line: 6 },
      ]),
    ).toEqual({
      spacedLetters: 2,
      spacedDigits: 2,
      tightLetters: 2,
      tightDigits: 2,
      slots: 2,
      tightSlots: 1,
    });

    const real = gapCensus(zhEntries());
    expect(
      real.tightLetters,
      `the dictionary writes ${real.tightLetters} Han/letter boundary(ies) with no space at ` +
        "all — that is the shape typesetProblems forbids, so either a sentence was added " +
        'around the rule or the rule stopped reading it',
    ).toBe(0);
    expect(
      real.tightSlots,
      `the dictionary has ${real.tightSlots} interpolation slot(s) set hard against a Han ` +
        'character: substituting the value produces the boundary nobody wrote',
    ).toBe(0);
    expect(
      real.spacedLetters,
      `the dictionary spaced only ${real.spacedLetters} Han/letter boundary(ies), which is too ` +
        'few for "tight boundaries = 0" to be a fact about the prose rather than about the ' +
        'census having stopped finding boundaries at all',
    ).toBeGreaterThan(100);
    expect(
      real.slots,
      `the dictionary holds ${real.slots} interpolation slot(s), so the slot half of this rule ` +
        'is asserted over nothing',
    ).toBeGreaterThan(20);
    /*
     * Not asserted: `real.tightDigits`.
     *
     * The fixture above proves the counter *sees* a digit set hard against Han, and
     * the real dictionary happens to hold none today — so the decision to keep this
     * file's set narrower than the measurement's (`LATIN_LETTER`, not `LATIN`, so
     * '第1步' stays legal) is currently unexercised. It cannot be gated: a floor of
     * zero would forbid the ordinary Chinese the exemption exists to allow, which is
     * the failure mode this file's own history calls 风格偏好穿着排版错误的衣服. The
     * decision is therefore kept where it can be read — the comment on LATIN_LETTER —
     * and the census counts it so a later round can see whether it started to matter.
     */
  });

  it('judges the dictionary by the characters the measurement judges the page by', () => {
    /*
     * One definition of "Han", one of "Latin", both owned by the page script.
     *
     * The two halves of this rule are `typesetProblems` (the sentence) and
     * `scripts/layout-page-scripts.mjs` (the rendered page). If each spelled the
     * character ranges out itself, the pair would drift the way two copies of a
     * line-length number do — quietly, and with both sides looking correct in a
     * diff. Both regexes below are built from the page script's exports, and the
     * assertions are that the ranges mean what they say: an ideograph on one
     * side, a letter or a digit on the other, and no punctuation in either.
     */
    expect(new RegExp(`[${HAN}]`, 'u').test('中')).toBe(true);
    expect(new RegExp(`[${HAN}]`, 'u').test('，')).toBe(false);
    expect(new RegExp(`[${LATIN}]`).test('3')).toBe(true);
    expect(new RegExp(`[${LATIN}]`).test('_')).toBe(false);
    /*
     * And the one place the two halves part ways, said out loud instead of left
     * to look like an accident: the dictionary lets a digit touch Han ('第1步' is
     * Chinese, not a defect), the measurement does not — the engine has to leave
     * its eighth there too. See LATIN_LETTER for why this is the right split and
     * not a hole.
     */
    expect(new RegExp(`[${LATIN_LETTER}]`).test('3')).toBe(false);
    expect(HAN_AGAINST_LATIN.test('第1步')).toBe(false);
    expect(new RegExp(`(?:[${HAN}][${LATIN}]|[${LATIN}][${HAN}])`, 'u').test('第1步')).toBe(true);
    // And both rules fire on the shape they describe, so a regex that stopped
    // matching cannot pass by finding nothing.
    expect(HAN_AGAINST_LATIN.test('改base就行')).toBe(true);
    expect(HAN_AGAINST_LATIN.test('改 base 就行')).toBe(false);
    expect(HAN_AGAINST_SLOT.test('共{count}条')).toBe(true);
    expect(HAN_AGAINST_SLOT.test('共 {count} 条')).toBe(false);
  });

  it('accepts a sentence that sets the full-width marks', () => {
    expect(
      typesetProblems([{ key: 'demo.ok', value: '先跑这条命令，然后看输出。', line: 10 }]),
    ).toEqual([]);
  });
});

/**
 * The leading, the tracking and the gap between the two scripts: the three
 * numbers a reader feels before they can name anything.
 *
 * ## Why these, and why now
 *
 * The blocks above pin the size of the type and the length of the line. Neither
 * says how much air sits between two lines, or how far apart the glyphs in a
 * word are — and those are the two settings a reader notices as "cramped" or
 * "loose" without being able to point at them. They were also the two settings
 * this stylesheet answered per call site: `line-height` was written as a bare
 * `1.6` in twenty rules and as `1.55`, `1.65`, `1.68` and `1.7` in a dozen
 * more, so "how much air" had no answer, only twenty answers.
 *
 * ## What is asserted, and what is not
 *
 * Five things, all mechanical:
 *
 *  1. `--lh-prose` is declared and sits inside the 1.5–2.0 band. Under 1.5 a
 *     Chinese paragraph's lines start to touch and the reader loses the line
 *     they were on; over 2.0 the paragraph stops reading as one block.
 *  2. `--ls-cjk` is declared and is not negative. Han glyphs already sit close
 *     to their neighbours, so negative tracking on Chinese is not a style, it
 *     is strokes touching — the defect the heading rule's comment records.
 *  3. the prose roles read those tokens instead of writing a number of their
 *     own, and no rule anywhere writes a negative `letter-spacing`.
 *  4. a rule that sets prose type (`--fs-body` / `--fs-note`) never sets a
 *     leading under 1.2.
 *  5. `--text-autospace` is declared, is the value that inserts the gap, and is
 *     read by `body` rather than restated — 中英混排间距, the air between a Han
 *     character and a Latin word when the sentence did not write one.
 *
 * The fifth is a token for the same reason the first two are: "how much air
 * between the two scripts" is one decision for the whole document, and a
 * decision written at one call site is a decision a later restyle can drop in
 * silence. Its counterpart — `no-autospace` — is refused anywhere in the
 * stylesheet, because a second rule switching the gap off *is* that second
 * decision, made quietly.
 *
 * Not asserted: that *every* `line-height` is a token. The remaining bare
 * leadings are per-component — a table row, a code block, a caret glyph — and
 * folding them into a scale is a redesign that moves pixels, not a gate. What
 * is gated is the two failure modes a reader can see: prose set too tight, and
 * Chinese tracked negative. The real-engine half of the same promise is in
 * `scripts/layout-page-scripts.mjs`, which flags any box with two or more line
 * boxes whose `lineHeight / size` is under 1.45, and — for the gap — measures the
 * air the engine actually left at every Han/Latin boundary on a gated screen, in
 * both directions: none added where the sentence already wrote a space, an eighth
 * of an em where it did not. Those are `tests/contract/layout.test.ts`'s cases.
 */
describe('the leading, the tracking and the gap', () => {
  /** The declarations of one rule, found by its selector. */
  function ruleBody(selector: string): string {
    for (const rule of codeOnly(styles).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (rule[1]!.trim().replace(/\s+/g, ' ') === selector) return rule[2]!;
    }
    expect.fail(`styles.css has no \`${selector}\` rule`);
  }

  /** Every declaration of one property, with the selector that wrote it. */
  function declarationsOf(property: 'line-height' | 'letter-spacing' | 'text-autospace'): Array<{
    selector: string;
    value: string;
  }> {
    const found: Array<{ selector: string; value: string }> = [];
    /*
     * `(?<![-\w])` is load-bearing. Without it a custom property is read as the
     * property it is named after: `--text-autospace: normal` in `:root` matched
     * `text-autospace:` as a substring, so the rule that token defines was
     * reported as a second declaration *of* that property — a stylesheet that
     * declares the gap once answering that it declares it twice.
     */
    for (const rule of codeOnly(styles).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = rule[1]!.trim().replace(/\s+/g, ' ');
      for (const match of rule[2]!.matchAll(
        new RegExp(`(?<![-\\w])${property}:\\s*([^;]+);`, 'g'),
      )) {
        found.push({ selector, value: match[1]!.trim() });
      }
    }
    return found;
  }

  /** A declared length, as a number; `undefined` when it is not one. */
  function number(value: string): number | undefined {
    const match = /^(-?\d+(?:\.\d+)?)(?:em|px)?$/.exec(value);
    return match === null ? undefined : Number(match[1]);
  }

  it('declares a prose leading inside the band', () => {
    const leading = number(token('lh-prose'));
    expect(leading, `--lh-prose is ${token('lh-prose')}, which is not a number`).toBeDefined();
    expect(leading!, 'leading under 1.5 lets a Chinese paragraph\'s lines touch').toBeGreaterThanOrEqual(1.5);
    expect(leading!, 'leading over 2.0 stops the paragraph reading as one block').toBeLessThanOrEqual(2);
  });

  it('declares a Chinese tracking that is not negative', () => {
    const tracking = number(token('ls-cjk'));
    expect(tracking, `--ls-cjk is ${token('ls-cjk')}, which is not a number`).toBeDefined();
    expect(tracking!, 'negative tracking on Han glyphs makes the strokes touch').toBeGreaterThanOrEqual(0);
  });

  it('sets the prose roles to that leading, rather than to a number of their own', () => {
    // The four roles that carry a sentence: the document, the composer, a card's
    // paragraph and the terminal's note. A prose role that writes `1.6` itself
    // is the drift this token exists to stop.
    for (const selector of ['body', 'textarea', '.card > p', '.terminal-note']) {
      expect(ruleBody(selector), `${selector} does not read --lh-prose`).toMatch(
        /line-height:\s*var\(--lh-prose\)/,
      );
    }
  });

  it('sets the Chinese heading to that tracking', () => {
    // `.pane-head h1` is the rule the negative-tracking defect was found on; it
    // is the one place the token is consumed, and a token nothing consumes is a
    // comment with a colon in it.
    expect(ruleBody('.pane-head h1')).toMatch(/letter-spacing:\s*var\(--ls-cjk\)/);
  });

  it('writes no negative tracking anywhere', () => {
    const declared = declarationsOf('letter-spacing');
    expect(declared.length, 'the stylesheet sets no letter-spacing at all').toBeGreaterThan(0);
    const negative = declared.filter((decl) => {
      if (/^var\(--[\w-]+\)$/.test(decl.value)) return false; // the token is checked above
      const value = number(decl.value);
      return value !== undefined && value < 0;
    });
    expect(
      negative.map((decl) => `${decl.selector} { letter-spacing: ${decl.value} }`),
      'these rules track text negatively; on Chinese that is strokes touching, not emphasis',
    ).toEqual([]);
  });

  it('never sets prose type to a leading under 1.2', () => {
    // A caret glyph may be set solid (`line-height: 1`); a sentence may not.
    // The rule is stated over the rules that pick a prose size, so the caret and
    // the badge stay out of it without an exemption list.
    const tight: string[] = [];
    for (const rule of codeOnly(styles).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const body = rule[2]!;
      if (!/font-size:\s*var\(--fs-(?:body|note)\)/.test(body)) continue;
      const leading = /line-height:\s*([^;]+);/.exec(body);
      if (leading === null) continue;
      const value = number(leading[1]!.trim());
      if (value !== undefined && value < 1.2) {
        tight.push(`${rule[1]!.trim().replace(/\s+/g, ' ')} { line-height: ${leading[1]!.trim()} }`);
      }
    }
    expect(tight, 'prose set tighter than 1.2 is a paragraph the eye cannot track').toEqual([]);
  });

  it('declares the gap between the two scripts once, as the value that inserts it', () => {
    // `text-autospace: normal` is CSS Text 4's own answer to 中英混排间距: an
    // eighth of an em between an ideograph and a Latin letter or digit, and
    // nothing anywhere else. The other values are `auto` (the initial value,
    // which inserts nothing in Chromium and is therefore a declaration that looks
    // set and is not) and `no-autospace`, which is the gap switched off.
    expect(
      token('text-autospace'),
      '--text-autospace is not `normal`, so "how much air between the scripts" has ' +
        'stopped being one decision the stylesheet can answer',
    ).toBe('normal');
  });

  it('sets the gap on the document rather than restating it per surface', () => {
    // One inherited declaration is the whole mechanism: the gap is a property of
    // text, not of a card or a pane, and a class list carrying it would be a
    // second fact that misses the day somebody adds a note somewhere new.
    expect(
      ruleBody('body'),
      '`body` no longer reads --text-autospace; the token is then a comment with a ' +
        'colon in it, and the gap is whatever the engine feels like',
    ).toMatch(/text-autospace:\s*var\(--text-autospace\)/);
  });

  it('switches the gap off nowhere', () => {
    /*
     * The `no-autospace` half, which is the direction a stylesheet drifts in.
     *
     * Nothing in this repository asks for the gap to be removed, and yet one
     * declaration on one component — added to make a dense table row fit, most
     * likely, where the tightness is the point of the row — would take the air out
     * of Chinese prose on that surface and leave every other case green. The
     * layout gate measures the *result* on gated screens; this reads the
     * stylesheet, so it names the rule the day it is written rather than the day
     * its surface is next photographed.
     */
    const declared = declarationsOf('text-autospace');
    expect(
      declared.length,
      'the stylesheet sets text-autospace nowhere, so the gap between the two scripts ' +
        'has stopped being a decision this repository makes',
    ).toBeGreaterThan(0);
    const off = declared.filter((decl) => /^(auto|no-autospace)$/.test(decl.value));
    expect(
      off.map((decl) => `${decl.selector} { text-autospace: ${decl.value} }`),
      'these rules turn the 中英混排 gap off (or back to `auto`, which is off in this ' +
        'engine) — a second decision about the same air, made silently',
    ).toEqual([]);
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
 * Not asserted here: line length (a rendered page decides that — the layout gate
 * measures it), the gap between Han text and a Latin word (that is
 * 中英混排间距, asserted above in `typesetProblems` and measured on screen by
 * `tests/contract/layout.test.ts`, not a punctuation rule), or whether a sentence
 * reads well. That last one needs a reader, and a gate that guessed at it would
 * go red on a legitimate sentence — which is how a typography gate gets deleted.
 * The two rules here cannot be right in the other direction: there is no sentence
 * in either language where the wrong-width mark is correct.
 *
 * The dictionary is read through `dictionaryFor()` rather than by parsing the
 * source, so the check sees the values the app actually renders. A key that is
 * missing from one locale is `i18n.test.ts`'s problem, not this file's.
 */
/**
 * The two rules, declared once.
 *
 * They are module-level rather than local to the dictionary block below because
 * the README block at the end of this file applies the *same* two rules to the
 * document's two halves. Two spellings of "a half-width mark next to a Han
 * character" would drift, and the reader would then have to work out whether
 * the app and the README were being judged by the same rule.
 */

/**
 * Han characters, the range both dictionaries write their prose in.
 *
 * Not written here. The layout measurement owns the range
 * (`HAN_CLASS` in `scripts/layout-page-scripts.mjs`) because it is the half that
 * has to match what the engine actually set, and this file's dictionary rules and
 * that measurement are two halves of one promise. It used to be spelled a second
 * time here as U+4E00–U+9FFF, which is the same *shape* of mistake as two copies
 * of a line-length number: narrower, greener, and invisible in a diff.
 */
const HAN = charClass('HAN_CLASS');

/** The Latin side: letters and digits, as the measurement counts them. */
/**
 * The Latin side as the *measurement* counts it: letters and digits.
 *
 * Kept as a name so the case below can state the difference out loud rather than
 * leave two sets looking like an accident.
 */
const LATIN = charClass('LATIN_CLASS');

/**
 * The Latin side as the *dictionary* counts it: letters only.
 *
 * The measurement's set is letters **and** digits, and this one is deliberately
 * narrower. Digits next to Han are normal Chinese — '第1步', '3条改动', '20%' —
 * and a rule that rejected them would be a style preference wearing a layout
 * error's clothes. That judgement is not new and not this file's to reverse: the
 * round that first measured 中英混排间距 scanned every literal in this dictionary,
 * found 0 tight boundaries, and wrote the decision down in `docs/dod-status.md`
 * as *not a defect*, naming '第1步' as exactly the shape a gate would get wrong.
 * So this gates the shape the app really does get wrong on paper — an identifier
 * (`Agent`, `base_url`, `UCAD`, `MCP`) set hard against a Chinese sentence.
 *
 * Nothing is lost by the narrower set, only moved: what the engine owes a digit it
 * pays, and `tests/contract/layout.test.ts` measures that in the browser at every
 * boundary, letters and digits alike. The two halves are complementary instead of
 * one being a stricter copy of the other — a sentence may write '第1步' and still
 * render with its air, and may not write '显示Agent' even where a browser would
 * paper over it.
 */
const LATIN_LETTER = 'A-Za-z';

/** A half-width mark with a Han character on either side of it. */
const HALF_WIDTH_NEAR_HAN = new RegExp(`(?:[,.;:](?=[${HAN}])|(?<=[${HAN}])[,.;:])`);

/** A full-width mark, which English prose has no use for. */
const FULL_WIDTH = /[，。；：、]/;

/**
 * A Han character set directly against a Latin letter or digit, with no space
 * between them (中英混排).
 *
 * The gap is what the eye uses to tell where the Chinese ends and the identifier
 * begins; without it '改base_url就能接上' reads as one long word, and the reader
 * has to re-run the line to find the break. The check is on the *dictionary*, and
 * the reason it belongs there rather than being left to the engine is that the
 * engine's own eighth of an em (`text-autospace`, measured on the rendered page by
 * the layout gate) exists only while the text is being painted: the same sentence
 * copied out of a handoff prompt, pasted into an issue, or read in a plain-text
 * log loses it entirely. A space in the source is worth the same in all four
 * places.
 */
const HAN_AGAINST_LATIN = new RegExp(
  `(?:[${HAN}][${LATIN_LETTER}]|[${LATIN_LETTER}][${HAN}])`,
  'u',
);

/**
 * A Han character set directly against an interpolation slot.
 *
 * This is 中英混排 with the missing space still in the future: '共{count}条' is
 * clean text until `count` is substituted, at which point it *becomes* '共3条' and
 * nobody wrote the boundary. The dictionary holds 45 of these slots and not one
 * of them touches a Han character — the census case below counts them, because
 * "all 45 are clear" is a claim about a scan, not a claim worth re-typing. That
 * is why this direction is checkable here while the rendered half of it is,
 * today, an empty set on screen. The slot name is matched
 * as the translator matches it — `{ident}` — so a sentence with braces in it for
 * another reason is not read as a hole in the rule.
 */
const HAN_AGAINST_SLOT = new RegExp(
  `(?:[${HAN}]\\{[A-Za-z0-9_]+\\}|\\{[A-Za-z0-9_]+\\}[${HAN}])`,
  'u',
);

describe('the punctuation', () => {
  const ZH = dictionaryFor('zh-CN');
  const EN = dictionaryFor('en-US');

  it('never sets a half-width mark against a Han character in Chinese', () => {
    // The line number is the point: `zh-CN.providers.subtitle` is a search in a
    // 1,600-line file, and `i18n.ts:71` is the sentence.
    const offenders = Object.entries(ZH)
      .filter(([, value]) => HALF_WIDTH_NEAR_HAN.test(value))
      .map(([key, value]) => `${I18N_RELATIVE}:${zhLines().get(key) ?? '?'} (zh-CN.${key}): ${value}`);
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

/**
 * The same two rules, applied to the README's two halves.
 *
 * ## Why the document needs this and the dictionary gate does not cover it
 *
 * The block above reads the strings the app renders. `README.md` is the other
 * place this repository writes Chinese prose, and it is the one a stranger
 * reads first — but nothing compared its punctuation with anything. The two
 * halves are written by hand, in two languages, in one file, and the failure is
 * the same one the dictionary gate was built for: a Chinese sentence that ends
 * in a half-width `,` sets a gap the reader reads as a typo, and an English
 * sentence carrying `，` reads as a paste from the other half.
 *
 * ## What is asserted, and what is not
 *
 * The two rules above, unchanged, split at `## 中文`:
 *
 *  - in the Chinese half, no half-width `,` `.` `;` `:` sits next to a Han
 *    character;
 *  - in the English half, no full-width `，` `。` `；` `：` `、` appears at all.
 *
 * Fenced code blocks and inline code spans are removed first. A shell snippet
 * is not prose: `node scripts/x.mjs --a,b` is correct ASCII, and a gate that
 * read it as a Chinese sentence would be red over a command that has to be
 * typed exactly as written. That is the same reason `paragraphs()` in
 * `readme-parity.test.ts` skips fences.
 *
 * Not asserted: which half a paragraph belongs to beyond the `## 中文` split,
 * line length, or spacing around Latin words. The README's structure is
 * `readme-parity.test.ts`'s subject; this block only reads the characters
 * between the words.
 */

const README_PATH = path.join(REPO_ROOT, 'README.md');
const README = fs.readFileSync(README_PATH, 'utf8');

/** The heading that starts the Chinese half. */
const ZH_HALF_HEADING = '## 中文';

/** One line of prose, with the line number it sits on in the file. */
interface ProseLine {
  /** 1-based line number in `README.md`, so a failure sends the reader there. */
  readonly line: number;
  readonly text: string;
}

/**
 * The prose of a document, with fenced blocks and inline code spans removed.
 *
 * Line numbers are kept absolute: a failure that says "line 214" is a place to
 * look, and one that says "the Chinese half" is a search.
 */
function proseLines(markdown: string): ProseLine[] {
  const out: ProseLine[] = [];
  let fenced = false;
  markdown.split('\n').forEach((raw, index) => {
    if (/^\s*```/u.test(raw)) {
      fenced = !fenced;
      return;
    }
    if (fenced) return;
    out.push({ line: index + 1, text: raw.replace(/`[^`]*`/gu, '') });
  });
  return out;
}

/** The two halves of the README, split at `## 中文`; `null` when the split is gone. */
function readmeHalves(markdown: string): { en: ProseLine[]; zh: ProseLine[] } | null {
  const lines = markdown.split('\n');
  const at = lines.findIndex((line) => line.trim() === ZH_HALF_HEADING);
  if (at === -1) return null;
  // The English half is re-numbered from 1 and then shifted back, so the line
  // numbers a failure prints are the ones in the file.
  const en = proseLines(lines.slice(0, at).join('\n'));
  const zh = proseLines(lines.slice(at + 1).join('\n')).map((entry) => ({
    line: entry.line + at + 1,
    text: entry.text,
  }));
  return { en, zh };
}

/**
 * Every way the README's punctuation disagrees with the language it is written
 * in.
 *
 * A pure function of its input, so the red direction below is driven on a
 * fixture rather than argued about.
 */
function readmePunctuationProblems(markdown: string): string[] {
  const halves = readmeHalves(markdown);
  if (halves === null) {
    return [
      `README.md has no "${ZH_HALF_HEADING}" heading, so the two halves cannot be told apart ` +
        'and neither rule can be applied to the right one',
    ];
  }

  const problems: string[] = [];
  for (const { line, text } of halves.zh) {
    if (!HALF_WIDTH_NEAR_HAN.test(text)) continue;
    problems.push(
      `line ${line} (中文): "${text.trim()}" uses a half-width , . ; : next to a Han ` +
        'character — the full-width mark is the one that sets correctly in Chinese prose',
    );
  }
  for (const { line, text } of halves.en) {
    if (!FULL_WIDTH.test(text)) continue;
    problems.push(
      `line ${line} (English): "${text.trim()}" carries a full-width ，。；：、 — it is a ` +
        'Chinese mark, and it sets a gap the reader reads as a typo',
    );
  }
  return problems;
}

describe('the README punctuation', () => {
  it('sets full-width marks in Chinese and half-width marks in English', () => {
    const problems = readmePunctuationProblems(README);
    expect(
      problems,
      `the README's two halves disagree with their own language:\n  ${problems.join('\n  ')}`,
    ).toEqual([]);
  });

  it('is not vacuous: both halves are read, and both rules fire on a real sentence', () => {
    const halves = readmeHalves(README);
    expect(halves, `README.md has no "${ZH_HALF_HEADING}" heading`).not.toBeNull();
    // Both halves have to carry prose, or one of the two loops above is a loop
    // over nothing and the green means half of what it says.
    expect(halves!.zh.length, 'the Chinese half has no prose lines').toBeGreaterThan(50);
    expect(halves!.en.length, 'the English half has no prose lines').toBeGreaterThan(50);
    // And the rules really do fire on the shapes they describe.
    expect(HALF_WIDTH_NEAR_HAN.test('先跑这条命令,然后看输出')).toBe(true);
    expect(FULL_WIDTH.test('Run this command， then read the output')).toBe(true);
  });

  it('reports a half-width mark in the Chinese half, with the line it is on', () => {
    const broken = README.replace('## 中文', '## 中文\n\n这一句用的是半角逗号,所以它应该红。');
    expect(broken, 'the Chinese half heading this case appends to is gone').not.toBe(README);
    const problems = readmePunctuationProblems(broken);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('(中文)');
    expect(problems[0]).toContain('半角逗号,所以它应该红');
    // The line number is the one in the file, not the one in the half.
    const at = broken.split('\n').findIndex((line) => line.includes('半角逗号')) + 1;
    expect(problems[0]).toContain(`line ${at}`);
  });

  it('reports a full-width mark in the English half', () => {
    const broken = README.replace('## English', '## English\n\nThis sentence carries a Chinese comma， and it should be red.');
    expect(broken, 'the English half heading this case appends to is gone').not.toBe(README);
    const problems = readmePunctuationProblems(broken);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('(English)');
    expect(problems[0]).toContain('Chinese comma');
  });

  it('does not read a command inside a code block as a Chinese sentence', () => {
    // The false positive that would get this gate switched off: a shell snippet
    // is ASCII on purpose, and `--a,b` is not a punctuation mistake.
    const withCommand = README.replace(
      '## 中文',
      '## 中文\n\n```bash\nnode scripts/x.mjs --a,b --c:d\n```\n\n行内命令 `node scripts/x.mjs --a,b` 也是 ASCII。',
    );
    expect(withCommand).not.toBe(README);
    expect(readmePunctuationProblems(withCommand)).toEqual([]);
  });

  it('reports a README whose two halves can no longer be told apart', () => {
    const broken = README.replace(ZH_HALF_HEADING, '## 中文版');
    expect(broken).not.toBe(README);
    expect(readmePunctuationProblems(broken)).toEqual([
      expect.stringContaining(`no "${ZH_HALF_HEADING}" heading`),
    ]);
  });
});
