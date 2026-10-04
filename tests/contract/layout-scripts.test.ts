/**
 * The page scripts must be well-formed before they are ever run in a browser.
 *
 * ## Why this file exists
 *
 * Three times in one round, a backtick inside a comment inside a page-script
 * template literal silently ended the string. The rest of the script was then
 * parsed as the host module's own code, and the failure arrived as:
 *
 *   TypeError: ".surfaces" is not a function
 *   SyntaxError: Unexpected identifier 'text'
 *   SyntaxError: Unexpected identifier 'position'
 *
 * Each one names an identifier unrelated to the actual mistake, in a stack that
 * points nowhere near it. A startup parse check in the probe caught them, but
 * only at runtime and only for whichever script ran first. The scripts now live
 * in `scripts/layout-page-scripts.mjs` with no Electron import, which makes them
 * importable — and importable is what makes them checkable.
 *
 * So: every script must parse, and no script body may contain a backtick. The
 * second rule is the specific one, because it is the mistake that keeps
 * recurring and because a comment is not a safe place to write one.
 */

import { describe, expect, it } from 'vitest';
import { Script } from 'node:vm';
import { PAGE_SCRIPTS, assertPageScriptsParse } from '../../scripts/layout-page-scripts.mjs';

const NAMES = Object.keys(PAGE_SCRIPTS);

describe('page scripts run in a real browser', () => {
  it('there is at least one script to check, so this file is not vacuous', () => {
    expect(NAMES.length).toBeGreaterThan(0);
  });

  it.each(NAMES)('%s parses as a script', (name) => {
    const source = PAGE_SCRIPTS[name] as string;
    // Compiled as a *script* — the same parse mode `executeJavaScript` uses —
    // and never executed. `new Function` would parse the body in function
    // scope instead, which is a slightly different grammar, and would leave a
    // callable around; `vm.Script` is compile-only.
    expect(() => new Script(source, { filename: `${name}.js` }), `${name} does not parse`)
      .not.toThrow();
  });

  it.each(NAMES)('%s contains no backtick of its own', (name) => {
    const source = PAGE_SCRIPTS[name] as string;
    // The scripts are written as template literals, so a backtick *anywhere* in
    // the body would already have terminated the literal before this could run
    // — unless it is an escaped one. This assertion is the belt to that braces:
    // it fails loudly on the exact construct that caused all three incidents,
    // and points at the line to fix.
    const backticks = (source.match(/`/g) ?? []).length;
    expect(
      backticks,
      `${name} contains a backtick. A backtick inside these template literals ends ` +
        `the string, and the rest of the script is then parsed as this module's ` +
        `code — which surfaces as an error naming an unrelated identifier. Write ` +
        `'quoted' instead.`,
    ).toBe(0);
  });

  it('reports the offending script by name when one is broken', () => {
    // The failure message is the whole point of the startup check: it must name
    // the script, not just say something is wrong somewhere.
    expect(() => assertPageScriptsParse()).not.toThrow();
  });
});
