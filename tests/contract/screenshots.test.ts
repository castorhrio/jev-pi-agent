/**
 * The screenshots the README shows must be the window the product opens.
 *
 * ## Why this exists
 *
 * `readme.test.ts` next door already fails when a cited image is missing, which
 * covers the loudest way a screenshot lies: a 404 in the first thing a reader
 * sees. It does not cover the quiet one. A screenshot is a claim about a
 * *particular* window — "this is what the app looks like" — and the claim goes
 * stale the moment the window it was taken at stops being the window the
 * product opens. Nothing in the build compared the two, so a 1440x900 capture
 * would keep being shown after `bootstrap.ts` moved to another size, and the
 * README would be advertising a layout no user can produce.
 *
 * The size is read out of `bootstrap.ts` rather than written down here for the
 * same reason `layout.test.ts` reads the breakpoints out of `styles.css`: a
 * number copied into a gate is a second fact that drifts from the first. Change
 * the window and this file goes red until the screenshots are retaken — which
 * is the correct amount of friction for a document that is the product's front
 * door.
 *
 * ## Why the two states are named
 *
 * The five interface states are asserted (`scenarios.e2e.test.tsx`) and
 * measured (`layout.test.ts`), and for several rounds none of them was
 * *visible*: a reader could not see what a first run or a failed load looks
 * like, because the README showed only the populated happy path. The two states
 * a reader cannot picture from the happy path are the empty one and the failed
 * one, so those two are required here by name. The other three are not
 * required: this file is a floor on what a reader can see, not a rule that
 * every state must be photographed.
 *
 * ## What it does not judge
 *
 * Whether a screenshot looks good, whether it is up to date with the last CSS
 * change, or whether the pixels show what the caption says. Image diffing is
 * deliberately not used anywhere in this repository (see the note at the top of
 * `scripts/layout-probe.mjs`): it breaks on every innocent change and gets
 * switched off. Dimensions and existence are checkable; taste is not.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const README_PATH = join(REPO_ROOT, 'README.md');
const BOOTSTRAP_PATH = join(REPO_ROOT, 'apps', 'desktop', 'src', 'main', 'bootstrap.ts');

const readme = existsSync(README_PATH) ? readFileSync(README_PATH, 'utf8') : '';

/**
 * The window the product opens at, read from the one place that decides it.
 *
 * `createWindow()` builds a `BrowserWindow` with `width`/`height` as its first
 * two options. Both are matched inside that call rather than anywhere in the
 * file, so the `minWidth`/`minHeight` pair below them — which is a different
 * fact — cannot be picked up by accident.
 */
function openingWindow(): { width: number; height: number } {
  const source = readFileSync(BOOTSTRAP_PATH, 'utf8');
  const start = source.indexOf('new BrowserWindow({');
  expect(start, 'bootstrap.ts no longer creates a BrowserWindow').toBeGreaterThan(-1);
  const options = source.slice(start, source.indexOf('});', start));
  const width = options.match(/\bwidth:\s*(\d+)/)?.[1];
  const height = options.match(/\bheight:\s*(\d+)/)?.[1];
  expect(width, 'could not read the opening window width out of bootstrap.ts').toBeDefined();
  expect(height, 'could not read the opening window height out of bootstrap.ts').toBeDefined();
  return { width: Number(width), height: Number(height) };
}

/** Every image the README shows out of `docs/screenshots/`, in document order. */
function shownScreenshots(markdown: string): string[] {
  const found = [...markdown.matchAll(/!\[[^\]]*\]\((docs\/screenshots\/[^)\s]+)\)/g)].map(
    (match) => match[1]!,
  );
  return [...new Set(found)];
}

/**
 * A PNG's pixel size, read from its IHDR chunk.
 *
 * The first eight bytes are the signature, then a four-byte length, the chunk
 * type `IHDR`, and the width and height as big-endian 32-bit integers. Reading
 * them costs no dependency, and a dependency for this would be the tail wagging
 * the dog.
 */
function pngSize(bytes: Buffer): { width: number; height: number } | null {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(signature)) return null;
  if (bytes.subarray(12, 16).toString('ascii') !== 'IHDR') return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

const shown = shownScreenshots(readme);
const window = openingWindow();

describe('the screenshots the README shows', () => {
  it('finds the README and the images it shows, so the checks below are not vacuous', () => {
    // Unconditional and first, the house rule for every document gate here: a
    // deleted README must be the first red, not a run in which every case below
    // compares an empty list with itself.
    expect(existsSync(README_PATH), `README.md is missing (${README_PATH})`).toBe(true);
    expect(shown.length, 'the README shows no screenshot at all').toBeGreaterThan(0);
  });

  it('are files that exist and decode as PNG', () => {
    for (const path of shown) {
      const full = join(REPO_ROOT, path);
      expect(existsSync(full), `${path} is shown in the README and is not on disk`).toBe(true);
      expect(pngSize(readFileSync(full)), `${path} is not a PNG`).not.toBeNull();
    }
  });

  it('are the size of the window the product opens at', () => {
    // The claim a screenshot makes is "this is the app", and the app opens at
    // one size. A capture from another size is a picture of a window no user
    // can produce — the same class of defect as a README that cites a test that
    // was renamed.
    for (const path of shown) {
      const size = pngSize(readFileSync(join(REPO_ROOT, path)));
      expect(size, `${path} is not a PNG`).not.toBeNull();
      expect(
        size,
        `${path} is ${size?.width}x${size?.height} and the app opens at ` +
          `${window.width}x${window.height} — retake it, or the README is showing a window ` +
          'the product does not open',
      ).toEqual(window);
    }
  });

  it('include the first-run and the failed-load states', () => {
    // The two states a reader cannot picture from the happy path. Named here so
    // that "the states are covered" is a claim about what a reader can see, not
    // only about what a test can assert.
    for (const state of ['empty', 'error']) {
      expect(shown, `the README shows no ${state} state`).toContain(
        `docs/screenshots/${state}.png`,
      );
    }
  });
});
