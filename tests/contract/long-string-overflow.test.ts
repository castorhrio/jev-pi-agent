/**
 * A string whose length this repository does not decide must not widen the window.
 *
 * ## Why this is a gate and not two CSS rules
 *
 * `d3cbff9` fixed a real defect: at 768×700 a failure reason of 200 characters
 * with no break opportunity (a Windows path) took `.notice.error` to a
 * `scrollWidth` of 1562px inside a 429px box, and the whole window grew a
 * horizontal scrollbar. The fix was two `overflow-wrap: anywhere` declarations
 * — on `.notice` and on `.pane-head p` — and two declarations is a sample.
 *
 * The strings that reach the screen are not written here: they are IPC errors,
 * stores that could not be opened, paths that do not exist. Chinese wraps
 * anywhere, so the fixture's own reasons never showed the problem; the next one
 * will not be Chinese either. And the boxes that draw them are not two: the
 * scan below finds **46** render sites across the renderer.
 *
 * So the question is asked of the source, at every site, and the answer is a
 * red gate rather than a review someone has to remember.
 *
 * ## What the scan asserts
 *
 *  - every downstream string drawn into a JSX text node has a box on the way up
 *    that either wraps it (`overflow-wrap: anywhere` / `word-break: break-word`)
 *    or clips it (`overflow: hidden` + `white-space: nowrap`, i.e. `.truncate`);
 *  - no site is protected only by a rule on the window itself (`.app`), because
 *    a blanket rule protects every site and therefore asserts nothing;
 *  - no site is unreadable — a dynamic `className` this scan cannot resolve is
 *    a failure, not a silent pass;
 *  - no wrapping declaration lives in a selector this scan cannot match, so the
 *    matcher's limits are a red gate rather than a blind spot;
 *  - the sites the previous round fixed by hand are still in the scanned set,
 *    so the gate cannot go green by scanning nothing.
 *
 * ## The red direction
 *
 * Every check is a pure function of `(sources, stylesheet)`, so each failure
 * path is driven with a mutated copy below rather than argued about: the
 * `.notice` rule deleted, a new render site added in an unprotected box, and a
 * blanket rule on `.app`.
 *
 * ## What it deliberately does not do
 *
 * It does not measure. Whether `anywhere` is enough at 768px is the layout
 * gate's question, answered in a real Chromium with a real 200-character
 * reason (`state-<state>-tight-long-reason`). This file answers the other half:
 * that the rule is *there* at every site, including the ones nobody has
 * measured yet.
 */

import { readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  declaresWrapping,
  describeSite,
  parseCss,
  scanTree,
  type CssRule,
  type TreeScan,
} from './long-string-overflow';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(here, '../..');
const RENDERER_ROOT = path.join(REPO_ROOT, 'apps/desktop/src/renderer/src');
const STYLES = path.join(RENDERER_ROOT, 'styles.css');

/** Every `.tsx` under the renderer, keyed by its path relative to the repo. */
function rendererSources(): Map<string, string> {
  const files = new Map<string, string>();
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.name.endsWith('.tsx')) {
        files.set(path.relative(REPO_ROOT, full).split(path.sep).join('/'), readFileSync(full, 'utf8'));
      }
    }
  };
  visit(RENDERER_ROOT);
  return files;
}

const SOURCES = rendererSources();
const CSS = readFileSync(STYLES, 'utf8');
const RULES = parseCss(CSS);

/** The scan of the real tree, run once. */
const TREE: TreeScan = scanTree(SOURCES, RULES);

/** A copy of the tree with one file replaced, for the red direction. */
function withSource(file: string, source: string): Map<string, string> {
  const copy = new Map(SOURCES);
  copy.set(file, source);
  return copy;
}

/** A copy of the stylesheet with one rule's declarations removed. */
function withoutRule(selector: string): CssRule[] {
  return RULES.filter((rule) => rule.selector !== selector);
}

describe('the stylesheet is readable by this scan', () => {
  it('has no wrapping declaration in a selector the matcher cannot read', () => {
    const unreadable = RULES.filter((rule) => rule.parts === null && declaresWrapping(rule.declarations));
    expect(
      unreadable.map((rule) => rule.selector),
      'a wrapping rule this scan cannot match would protect a box it then reports as unprotected',
    ).toEqual([]);
  });

  it('reads the two rules the previous round added by hand', () => {
    const notice = RULES.find((rule) => rule.selector === '.notice');
    expect(notice, '.notice is the box a failure reason is drawn in').toBeDefined();
    expect(declaresWrapping(notice!.declarations), '.notice must wrap a long token').toBe(true);

    const head = RULES.find((rule) => rule.selector === '.pane-head p');
    expect(head, '.pane-head p is the fatal pane’s paragraph').toBeDefined();
    expect(declaresWrapping(head!.declarations), '.pane-head p must wrap a long token').toBe(true);
  });
});

describe('every downstream string is drawn in a box that cannot widen the window', () => {
  it('finds the render sites at all', () => {
    // A scan that finds nothing passes every assertion below. The count is not
    // the point; the floor is, so a broken walk is loud.
    expect(TREE.sites.length).toBeGreaterThanOrEqual(40);
  });

  it('reports no site whose box this scan could not read', () => {
    expect(TREE.unreadable).toEqual([]);
  });

  it('reports no unprotected site', () => {
    expect(TREE.unprotected.map(describeSite)).toEqual([]);
  });

  it('reports no site protected only by a rule on the window itself', () => {
    expect(
      TREE.blanket.map(describeSite),
      'a blanket rule on .app protects every site, which is the same as protecting none',
    ).toEqual([]);
  });
});

describe('the sites the previous round fixed by hand are still scanned', () => {
  /** The file and box each of them is drawn in. */
  const REQUIRED: readonly { file: string; element: string }[] = [
    // The fatal pane: `App.tsx`'s `if (fatal)` branch, drawn verbatim.
    { file: 'apps/desktop/src/renderer/src/App.tsx', element: '<p>' },
    // The one component every failed read goes through.
    { file: 'apps/desktop/src/renderer/src/components/ReadFailure.tsx', element: '<div className="notice error">' },
    // The panel crash fallback, which draws `err.message` inline.
    { file: 'apps/desktop/src/renderer/src/components/PanelBoundary.tsx', element: '<div>' },
    // A failed session list, which used to read as "no sessions yet".
    { file: 'apps/desktop/src/renderer/src/components/LeftRail.tsx', element: '<div className="faint rail-note reason">' },
    // A notice whose message is a log line from the agent.
    { file: 'apps/desktop/src/renderer/src/components/ChatLog.tsx', element: '<span className="muted">' },
  ];

  for (const required of REQUIRED) {
    it(`scans ${required.file} — ${required.element}`, () => {
      const found = TREE.sites.filter(
        (site) => site.file === required.file && site.element === required.element,
      );
      expect(found.map(describeSite), `${required.element} is no longer in the scanned set`).not.toEqual([]);
    });
  }
});

describe('the red direction', () => {
  it('names the file and the box when `.notice` stops wrapping', () => {
    const scan = scanTree(SOURCES, withoutRule('.notice'));
    const named = scan.unprotected.map(describeSite);
    expect(named.some((line) => line.includes('ReadFailure.tsx'))).toBe(true);
    expect(named.some((line) => line.includes('<div className="notice error">'))).toBe(true);
  });

  it('names a new render site added in an unprotected box', () => {
    const file = 'apps/desktop/src/renderer/src/components/LeftRail.tsx';
    const source = SOURCES.get(file)!;
    const mutated = source.replace(
      '<div className="faint rail-note reason">{error}</div>',
      '<div className="card">{error}</div>',
    );
    expect(mutated, 'the fixture no longer matches LeftRail.tsx').not.toBe(source);

    const scan = scanTree(withSource(file, mutated), RULES);
    const named = scan.unprotected.map(describeSite);
    expect(named.some((line) => line.includes('LeftRail.tsx') && line.includes('<div className="card">'))).toBe(
      true,
    );
  });

  it('rejects a blanket rule on the window', () => {
    const blanket = parseCss(`${CSS}\n.app { overflow-wrap: anywhere; }\n`);
    const scan = scanTree(SOURCES, blanket);
    expect(scan.blanket.length).toBeGreaterThan(0);
    expect(scan.blanket.map(describeSite).some((line) => line.includes('App.tsx'))).toBe(true);
  });

  it('rejects a dynamic className it cannot resolve', () => {
    const file = 'apps/desktop/src/renderer/src/components/ReadFailure.tsx';
    const source = SOURCES.get(file)!;
    const mutated = source.replace('className="notice error"', 'className={kind}');
    expect(mutated).not.toBe(source);

    const scan = scanTree(withSource(file, mutated), RULES);
    expect(scan.unreadable.some((line) => line.includes('ReadFailure.tsx'))).toBe(true);
  });
});
