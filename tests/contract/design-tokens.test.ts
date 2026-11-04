/**
 * The visual tokens have a named source of record, and the stylesheet is its copy.
 *
 * ## Why this file exists
 *
 * `styles.css` has had tokens in `:root` since the first round, and the type
 * scale has been gated twice over: `typography.test.ts` pins "every
 * `font-size` is a `var(--fs-…)`" and "at most four sizes", and the layout gate
 * measures the resolved sizes in a real Chromium. What had **no** named source
 * was everything else:
 *
 *  - **radii.** Nine values are in use — `0`, `2px`, `3px`, `4px`, `6px`, `7px`,
 *    `10px`, `999px`, `50%` — and only three of them have a name
 *    (`--r-sm` / `--r` / `--r-lg`). The rest are bare numbers in rules, which
 *    means the next one needs no decision at all: `border-radius: 5px`
 *    compiles, every gate stays green, and the screen grows a radius nobody
 *    argued for. That is exactly how the type scale rotted to nine values
 *    across forty-seven rules before it was collapsed.
 *  - **edge widths.** `1px` is the hairline; `2px` is allowed in exactly two
 *    places (the `border-left` emphasis bar and the scrollbar thumb). That
 *    sentence lived in a comment at the top of the stylesheet, and a comment is
 *    not a gate.
 *  - **colour roles.** "Blue = interactive, green = success, amber = attention,
 *    red = failure, nothing else is coloured" is the rule the whole palette
 *    exists to serve, and nothing compared the palette to it.
 *
 * `docs/DESIGN.md` is now the register: one row per value, with what it is for
 * and why it is that number. `:root` is the machine copy. CSS cannot
 * `@import` a markdown file, so the link between the two is **this gate**:
 *
 *  - every `--fs-*` token in `:root` is in the type table with the same value,
 *    and the table documents no token `:root` lacks;
 *  - every `--r-*` token is in the radius register with the same value, and
 *    every radius value a rule actually uses has a row — so a new `5px` is red
 *    until somebody writes down why;
 *  - every edge width in a rule is one the hairline table documents, and `2px`
 *    appears only on `border-left` or `::-webkit-scrollbar-thumb`;
 *  - every colour token in `:root` is in the colour table with the same value,
 *    and the table documents no token `:root` lacks;
 *  - `CONTRIBUTING.md` links the register, because a document nobody is sent to
 *    is a document nobody reads.
 *
 * ## What it deliberately does not assert
 *
 * That the values are *good*. Whether 7px is the right radius for a card is a
 * design judgement, and a test that encoded it would be rewritten every time a
 * panel is restyled — the kind of gate that gets deleted. What is asserted is
 * that the judgement was made and written down, and that the two copies agree.
 *
 * It also does not assert "at most N radii". The type scale can be four sizes
 * because one role must look the same everywhere; a radius cannot, because a
 * 4px-tall meter and a 400px-wide dialog genuinely want different physical
 * corners. So the register is a list of *boxes*, not a scale, and the check is
 * set equality rather than a count.
 *
 * ## Why the red direction is driven with mutated copies
 *
 * Every check is a pure function of two strings, so the failure path is
 * exercised by handing it a mutated copy of the real documents rather than by
 * arguing that it would fail. A gate whose failure path has never run is a gate
 * that might be returning `[]` whatever it is given — this repository has said
 * that about `--steps`, about `skipIf`, and about the screenshot manifest.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const DESIGN_PATH = join(REPO_ROOT, 'docs', 'DESIGN.md');
const STYLES_PATH = join(REPO_ROOT, 'apps', 'desktop', 'src', 'renderer', 'src', 'styles.css');
const CONTRIBUTING_PATH = join(REPO_ROOT, 'CONTRIBUTING.md');

const DESIGN = readFileSync(DESIGN_PATH, 'utf8');
const STYLES = readFileSync(STYLES_PATH, 'utf8');
const CONTRIBUTING = readFileSync(CONTRIBUTING_PATH, 'utf8');

/** The stylesheet with its comments removed — prose is not a declaration. */
function codeOnly(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** A table cell without its backticks or padding. */
function bare(cell: string): string {
  return cell.trim().replace(/^`|`$/g, '').trim();
}

/**
 * The rows of the first table under a `## ` heading, header and rule rows dropped.
 *
 * The register is read as data, not as prose: a heading that lost its table, or
 * a table that lost its rows, has to be red rather than vacuously clean, which
 * is why every caller asserts the row count before comparing anything.
 */
function designTable(markdown: string, heading: string): string[][] {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start === -1) return [];
  const rows: string[][] = [];
  let seenTable = false;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    if (/^## /.test(line)) break;
    if (!line.startsWith('|')) {
      if (seenTable) break;
      continue;
    }
    seenTable = true;
    const cells = line
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((cell) => cell.trim());
    if (cells.every((cell) => /^:?-{3,}:?$/.test(cell))) continue;
    if (cells[0] === 'token' || cells[0] === '值' || cells[0] === '宽度') continue;
    rows.push(cells);
  }
  return rows;
}

/** The custom properties declared in `:root`, name (without `--`) → value. */
function rootTokens(css: string): Map<string, string> {
  const code = codeOnly(css);
  const start = code.indexOf(':root');
  const open = code.indexOf('{', start);
  const close = code.indexOf('}', open);
  const block = code.slice(open + 1, close);
  const tokens = new Map<string, string>();
  for (const match of block.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) {
    tokens.set(match[1]!, match[2]!.trim());
  }
  return tokens;
}

/**
 * Every rule in the stylesheet, with the selector that owns it.
 *
 * A character walk rather than a regex, because `@media` blocks nest: a
 * `([^{}]+)\{([^{}]*)\}` pattern reads `@media (max-width: 860px)` as a
 * selector and then loses the selector of every rule inside it, which would
 * make the "2px only on `border-left`" check pass over the narrow-window rules
 * — the ones most likely to grow a new edge.
 */
function rules(css: string): Array<{ selector: string; body: string }> {
  const code = codeOnly(css);
  const found: Array<{ selector: string; body: string }> = [];
  const stack: Array<{ selector: string; body: string }> = [];
  let pending = '';
  for (const char of code) {
    if (char === '{') {
      stack.push({ selector: pending.trim(), body: '' });
      pending = '';
    } else if (char === '}') {
      const rule = stack.pop();
      if (rule !== undefined) {
        // An at-rule is a container, not a rule: its own "body" is the rules
        // inside it, which were already collected.
        if (!rule.selector.startsWith('@')) found.push(rule);
        const parent = stack[stack.length - 1];
        if (parent !== undefined) parent.body += rule.body;
      }
      pending = '';
    } else if (stack.length > 0) {
      stack[stack.length - 1]!.body += char;
    } else {
      pending += char;
    }
  }
  return found;
}

/** A `var(--x)` reference resolved through `:root`, or the value unchanged. */
function resolveValue(value: string, tokens: Map<string, string>): string {
  const reference = /^var\(--([\w-]+)\)$/.exec(value);
  if (reference === null) return value;
  return tokens.get(reference[1]!) ?? value;
}

/** Every radius a rule actually uses, mapped to the selectors that use it. */
function radiiInUse(css: string): Map<string, string[]> {
  const tokens = rootTokens(css);
  const used = new Map<string, string[]>();
  for (const rule of rules(css)) {
    for (const match of rule.body.matchAll(/(?:^|;)\s*border-radius\s*:\s*([^;]+);/g)) {
      for (const part of match[1]!.trim().split(/\s+/)) {
        const value = resolveValue(part, tokens);
        const selectors = used.get(value) ?? [];
        if (!selectors.includes(rule.selector)) selectors.push(rule.selector);
        used.set(value, selectors);
      }
    }
  }
  return used;
}

/** Every edge width a rule declares, with the property and selector that own it. */
function edgesInUse(css: string): Array<{ selector: string; property: string; width: string }> {
  const edges: Array<{ selector: string; property: string; width: string }> = [];
  for (const rule of rules(css)) {
    for (const match of rule.body.matchAll(
      /(?:^|;)\s*(border(?:-(?:top|bottom|left|right))?)\s*:\s*([^;]+);/g,
    )) {
      edges.push({
        selector: rule.selector,
        property: match[1]!,
        width: match[2]!.trim().split(/\s+/)[0]!,
      });
    }
  }
  return edges;
}

/** The colour tokens the register is responsible for. */
const COLOUR_TOKEN =
  /^(bg|surface(-\d)?|inset|border(-soft|-strong)?|text(-\d)?|accent(-dim|-soft)?|ok(-dim)?|warn(-dim)?|err(-dim)?|info|add|del)$/;

/** The two places a 2px edge is allowed, and the reason each one is. */
const TWO_PX_EDGE = { property: 'border-left', selector: '::-webkit-scrollbar-thumb' };

/**
 * Everything wrong with the type table against `:root`.
 *
 * Both directions: a token the stylesheet declares and the register omits is a
 * value nobody named, and a token the register documents and the stylesheet
 * dropped is a row that now describes nothing.
 */
function typeProblems(design: string, styles: string): string[] {
  const rows = designTable(design, '字号档（type scale）');
  if (rows.length === 0) return ['docs/DESIGN.md: the type scale table is gone or empty'];
  const problems: string[] = [];
  const declared = rootTokens(styles);
  const documented = new Map(rows.map((row) => [bare(row[0]!), bare(row[1]!)]));

  for (const [name, value] of declared) {
    if (!name.startsWith('fs-')) continue;
    const token = `--${name}`;
    if (!documented.has(token)) {
      problems.push(`docs/DESIGN.md: ${token} (${value}) is declared in styles.css but has no row`);
    } else if (documented.get(token) !== value) {
      problems.push(
        `docs/DESIGN.md: ${token} is documented as ${documented.get(token)} but styles.css says ${value}`,
      );
    }
  }
  for (const [token, value] of documented) {
    const name = token.replace(/^--/, '');
    if (!declared.has(name)) {
      problems.push(`docs/DESIGN.md: ${token} is documented as ${value} but styles.css does not declare it`);
    }
  }
  return problems;
}

/** Everything wrong with the radius register against `:root` and the rules. */
function radiusProblems(design: string, styles: string): string[] {
  const rows = designTable(design, '圆角（radius register）');
  if (rows.length === 0) return ['docs/DESIGN.md: the radius register is gone or empty'];
  const problems: string[] = [];
  const declared = rootTokens(styles);

  const documentedValues = new Set(rows.map((row) => bare(row[0]!)));
  const documentedTokens = new Map(
    rows
      .filter((row) => bare(row[1] ?? '') !== '—' && bare(row[1] ?? '') !== '')
      .map((row) => [bare(row[1]!), bare(row[0]!)]),
  );

  for (const [name, value] of declared) {
    if (name !== 'r' && !name.startsWith('r-')) continue;
    const token = `--${name}`;
    if (!documentedTokens.has(token)) {
      problems.push(`docs/DESIGN.md: ${token} (${value}) is declared in styles.css but has no row`);
    } else if (documentedTokens.get(token) !== value) {
      problems.push(
        `docs/DESIGN.md: ${token} is documented as ${documentedTokens.get(token)} but styles.css says ${value}`,
      );
    }
  }
  for (const [token, value] of documentedTokens) {
    const name = token.replace(/^--/, '');
    if (!declared.has(name)) {
      problems.push(`docs/DESIGN.md: ${token} is documented as ${value} but styles.css does not declare it`);
    }
  }

  const used = radiiInUse(styles);
  for (const [value, selectors] of used) {
    if (!documentedValues.has(value)) {
      problems.push(
        `docs/DESIGN.md: border-radius: ${value} is used by ${selectors.join(', ')} but the register ` +
          'has no row for it — a new radius is a decision, so write it down first',
      );
    }
  }
  for (const value of documentedValues) {
    if (!used.has(value)) {
      problems.push(`docs/DESIGN.md: the register documents ${value} but no rule uses it`);
    }
  }
  return problems;
}

/** Everything wrong with the hairline table against the rules' edge widths. */
function hairlineProblems(design: string, styles: string): string[] {
  const rows = designTable(design, '发丝边（hairline）');
  if (rows.length === 0) return ['docs/DESIGN.md: the hairline table is gone or empty'];
  const documented = new Set(
    rows.flatMap((row) => bare(row[0]!).split('/').map((width) => width.trim())),
  );
  const problems: string[] = [];

  for (const edge of edgesInUse(styles)) {
    if (!documented.has(edge.width)) {
      problems.push(
        `docs/DESIGN.md: ${edge.selector} { ${edge.property}: ${edge.width} … } uses an edge width the ` +
          'hairline table does not document',
      );
    }
    if (
      edge.width === '2px' &&
      edge.property !== TWO_PX_EDGE.property &&
      edge.selector !== TWO_PX_EDGE.selector
    ) {
      problems.push(
        `docs/DESIGN.md: ${edge.selector} { ${edge.property}: 2px … } is a 2px edge outside the two the ` +
          'register allows (border-left emphasis, scrollbar thumb)',
      );
    }
  }
  return problems;
}

/** Everything wrong with the colour table against `:root`. */
function colourProblems(design: string, styles: string): string[] {
  const rows = designTable(design, '铬色与强调色（colour roles）');
  if (rows.length === 0) return ['docs/DESIGN.md: the colour table is gone or empty'];
  const problems: string[] = [];
  const declared = rootTokens(styles);
  const documented = new Map(rows.map((row) => [bare(row[0]!), bare(row[1]!)]));

  for (const [name, value] of declared) {
    if (!COLOUR_TOKEN.test(name)) continue;
    const token = `--${name}`;
    if (!documented.has(token)) {
      problems.push(`docs/DESIGN.md: ${token} (${value}) is declared in styles.css but has no row`);
    } else if (documented.get(token) !== value) {
      problems.push(
        `docs/DESIGN.md: ${token} is documented as ${documented.get(token)} but styles.css says ${value}`,
      );
    }
  }
  for (const [token, value] of documented) {
    const name = token.replace(/^--/, '');
    if (!declared.has(name)) {
      problems.push(`docs/DESIGN.md: ${token} is documented as ${value} but styles.css does not declare it`);
    }
  }
  return problems;
}

/** Whether a contributor is sent to the register at all. */
function routingProblems(contributing: string): string[] {
  return contributing.includes('docs/DESIGN.md')
    ? []
    : ['CONTRIBUTING.md: nothing links docs/DESIGN.md, so the register is a document nobody is sent to'];
}

describe('the register and the stylesheet are the same facts', () => {
  it('documents every type token with the value the stylesheet declares', () => {
    expect(typeProblems(DESIGN, STYLES)).toEqual([]);
  });

  it('documents every radius token, and every radius a rule uses', () => {
    expect(radiusProblems(DESIGN, STYLES)).toEqual([]);
  });

  it('documents every edge width, and keeps 2px to the two places it is allowed', () => {
    expect(hairlineProblems(DESIGN, STYLES)).toEqual([]);
  });

  it('documents every colour token with the value the stylesheet declares', () => {
    expect(colourProblems(DESIGN, STYLES)).toEqual([]);
  });

  it('sends a contributor to the register', () => {
    expect(routingProblems(CONTRIBUTING)).toEqual([]);
  });
});

describe('the register is read as data, not as prose', () => {
  it('found the four tables and the values in them', () => {
    // A gate that reads an empty table passes over nothing. These counts are
    // the "the subject exists" half of every check above.
    expect(designTable(DESIGN, '字号档（type scale）').length).toBeGreaterThanOrEqual(5);
    expect(designTable(DESIGN, '圆角（radius register）').length).toBeGreaterThanOrEqual(9);
    expect(designTable(DESIGN, '发丝边（hairline）').length).toBeGreaterThanOrEqual(3);
    expect(designTable(DESIGN, '铬色与强调色（colour roles）').length).toBeGreaterThanOrEqual(20);
  });

  it('resolves the radius tokens the rules actually use', () => {
    // `var(--r-sm)` must be compared as `4px`, not as the string `var(--r-sm)`:
    // otherwise the register could document `4px` and the rules could use a
    // token that resolves to something else, and both would look documented.
    const used = radiiInUse(STYLES);
    expect([...used.keys()]).toEqual(expect.arrayContaining(['4px', '7px', '10px']));
    expect([...used.keys()]).not.toContain('var(--r-sm)');
  });

  it('reads the edge widths out of the rules, including the ones inside @media', () => {
    // The character walk exists for this: a regex over `{…}` loses the selector
    // of every rule inside an at-rule, and the narrow-window rules are the ones
    // most likely to grow a new edge.
    const edges = edgesInUse(STYLES);
    expect(edges.length).toBeGreaterThan(40);
    expect(edges.some((edge) => edge.width === '2px')).toBe(true);
    expect(edges.every((edge) => edge.selector.length > 0)).toBe(true);
  });
});

describe('the gate goes red when the two copies disagree', () => {
  it('names a type token the register forgot', () => {
    const mutated = DESIGN.replace(/^\| `--fs-fine` \|.*\n/m, '');
    expect(typeProblems(mutated, STYLES)).toEqual([
      expect.stringContaining('--fs-fine (10.5px) is declared in styles.css but has no row'),
    ]);
  });

  it('names a type value that drifted', () => {
    const mutated = DESIGN.replace('| `--fs-body` | `13px` |', '| `--fs-body` | `14px` |');
    expect(typeProblems(mutated, STYLES)).toEqual([
      expect.stringContaining('--fs-body is documented as 14px but styles.css says 13px'),
    ]);
  });

  it('names a radius a rule invented', () => {
    // The failure this whole file is for: a new value typed into a rule with no
    // decision behind it.
    const mutated = STYLES.replace('.badge {', '.badge {\n  border-radius: 5px;');
    expect(radiusProblems(DESIGN, mutated)).toEqual([
      expect.stringContaining('border-radius: 5px is used by .badge'),
    ]);
  });

  it('names a radius token the register forgot', () => {
    const mutated = DESIGN.replace(/^\| `7px` \| `--r` \|.*\n/m, '');
    // Dropping the row loses two facts at once, and both are named: the token
    // has no row, and the value the rules use has no row either.
    const problems = radiusProblems(mutated, STYLES);
    expect(problems).toContainEqual(
      expect.stringContaining('--r (7px) is declared in styles.css but has no row'),
    );
    expect(problems).toContainEqual(expect.stringContaining('border-radius: 7px is used by'));
  });

  it('names a register row nothing uses any more', () => {
    const mutated = DESIGN.replace(
      '| `6px` | — | 滚动条滑块 |',
      '| `6px` | — | 滚动条滑块 |\n| `8px` | — | 一个没人用的值 |',
    );
    expect(radiusProblems(mutated, STYLES)).toEqual([
      expect.stringContaining('the register documents 8px but no rule uses it'),
    ]);
  });

  it('names a third place that grew a 2px edge', () => {
    const mutated = STYLES.replace('.badge {', '.badge {\n  border-top: 2px solid var(--accent);');
    expect(hairlineProblems(DESIGN, mutated)).toEqual([
      expect.stringContaining('.badge { border-top: 2px … } is a 2px edge outside the two'),
    ]);
  });

  it('names an edge width the hairline table does not document', () => {
    const mutated = STYLES.replace('.badge {', '.badge {\n  border: 3px solid var(--accent);');
    expect(hairlineProblems(DESIGN, mutated)).toEqual([
      expect.stringContaining('uses an edge width the hairline table does not document'),
    ]);
  });

  it('names a colour that drifted', () => {
    const mutated = DESIGN.replace('| `--accent` | `#6d7cff` |', '| `--accent` | `#6d7cfe` |');
    expect(colourProblems(mutated, STYLES)).toEqual([
      expect.stringContaining('--accent is documented as #6d7cfe but styles.css says #6d7cff'),
    ]);
  });

  it('names a colour token the register forgot', () => {
    const mutated = DESIGN.replace(/^\| `--info` \|.*\n/m, '');
    expect(colourProblems(mutated, STYLES)).toEqual([
      expect.stringContaining('--info (#58a6ff) is declared in styles.css but has no row'),
    ]);
  });

  it('is red when a table is deleted rather than vacuously clean', () => {
    // The shape every document gate in this repository is written against: a
    // check whose subject disappeared must fail, not pass over an empty list.
    const mutated = DESIGN.replace('## 圆角（radius register）', '## 圆角');
    expect(radiusProblems(mutated, STYLES)).toEqual([
      'docs/DESIGN.md: the radius register is gone or empty',
    ]);
  });

  it('is red when nothing links the register', () => {
    expect(routingProblems(CONTRIBUTING.replace(/docs\/DESIGN\.md/g, 'docs/design.md'))).toEqual([
      expect.stringContaining('nothing links docs/DESIGN.md'),
    ]);
  });
});
