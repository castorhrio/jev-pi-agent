/**
 * Every `outline: none` must be replaced by something visible.
 *
 * ## Why this exists
 *
 * Removing an outline is the one CSS change that can make a control unusable
 * for keyboard users, and it is easy to do by accident: a rule that is
 * correct for mouse users ("the border already shows where I am") silently
 * deletes the only focus indicator a keyboard user has.
 *
 * This app currently has exactly two `outline: none` declarations, and both
 * are deliberate and both replace the outline with something at least as
 * visible. That was **verified in a real browser**, not assumed: tabbing to
 * the permission-mode select and the rail rename input shows a clear ring, and
 * buttons elsewhere show the user-agent default. So focus visibility is
 * currently adequate and no style was changed to "fix" it.
 *
 * What is *not* adequate is having no way to notice the next person who adds a
 * third one. Hence this: it reads the stylesheet and fails when an outline is
 * removed without a replacement in the same rule.
 *
 * Deliberately narrow. It does not try to judge whether a replacement is
 * *pretty* or even whether it is visible — only that the author named one.
 * A rule that produced a wall of false positives would be switched off, and
 * then it would protect nothing.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const CSS_PATH = 'apps/desktop/src/renderer/src/styles.css';
const css = readFileSync(CSS_PATH, 'utf8');

/**
 * Splits the stylesheet into `{ selector, body }` rule pairs, ignoring
 * at-rules and comments. Good enough for a flat utility stylesheet, and it
 * fails loudly rather than silently if the shape ever changes.
 */
function rules(source: string): Array<{ selector: string; body: string; index: number }> {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: Array<{ selector: string; body: string; index: number }> = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(withoutComments)) !== null) {
    const selector = (m[1] ?? '').trim();
    // Skip the contents of @media / @supports blocks: a rule inside them is
    // still a rule, and `re` already returns the inner one, so nothing to do.
    if (selector === '' || selector.startsWith('@')) continue;
    out.push({ selector, body: m[2] ?? '', index: m.index });
  }
  return out;
}

const allRules = rules(css);
const outlineNoneRules = allRules.filter((r) => /(^|[\s;])outline\s*:\s*none\b/.test(r.body));

/** What counts as naming a replacement indicator in the same rule. */
const REPLACEMENT =
  /(box-shadow\s*:\s*(?!none)|border-color\s*:|border\s*:|outline-(offset|style|width)\s*:|background(-color)?\s*:)/i;

describe('focus indicators', () => {
  it('finds the outline suppressions in the stylesheet', () => {
    // If this ever reads 0, the regex stopped matching and every assertion
    // below would be vacuously true.
    expect(
      outlineNoneRules.length,
      'no `outline: none` was found — either the stylesheet is clean or this scan has stopped working',
    ).toBeGreaterThan(0);
  });

  it.each(outlineNoneRules.map((r) => [r.selector, r.body] as const))(
    '`outline: none` on %s names a replacement indicator',
    (selector, body) => {
      const cleaned = body.replace(/(^|[\s;])outline\s*:\s*none\b/, '');
      expect(
        REPLACEMENT.test(cleaned),
        `\`${selector}\` removes the focus outline but the same rule does not set a ` +
          'box-shadow, border or background to stand in for it, so keyboard users get no ' +
          `focus indicator. Rule body: { ${body.trim()} }`,
      ).toBe(true);
    },
  );

  it('keeps a visible indicator on form controls', () => {
    // The composer and every text input share this rule. It is the single
    // most-used control in the app, so it is pinned by name.
    const formFocus = allRules.find((r) =>
      /input:focus[^{]*textarea:focus[^{]*select:focus/.test(r.selector),
    );
    expect(formFocus, 'the shared form focus rule has disappeared').toBeDefined();
    expect(
      REPLACEMENT.test((formFocus?.body ?? '').replace(/(^|[\s;])outline\s*:\s*none\b/, '')),
      'form controls lose the outline but name no replacement',
    ).toBe(true);
  });
});
