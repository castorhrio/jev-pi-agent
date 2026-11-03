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
