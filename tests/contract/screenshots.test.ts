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
 * ## Whether the picture is still the picture
 *
 * "Up to date with the last CSS change" used to be listed here as unjudgeable,
 * and that was the gap that mattered: the three cases above are all claims
 * about the *file* (it exists, it is a PNG, it is 1440x900), and none of them
 * is a claim about the *picture*. `styles.css` could be rewritten and the
 * README would keep showing the old window, green.
 *
 * It is judgeable without pixels. `scripts/screenshot-sources.mjs` records the
 * sha256 of every renderer source and of every committed screenshot in
 * `docs/screenshots/sources.json`; the cases at the bottom of this file fail
 * when either side moved, and name the file that moved.
 *
 * The two obvious alternatives were rejected on purpose:
 *
 *  - **mtime.** `git clone` and `git checkout` stamp every file with the
 *    checkout time, so in CI every screenshot is exactly as old as every
 *    source and the comparison is green no matter what changed. A gate that
 *    cannot go red is worse than no gate — this repository has said so about
 *    `--steps` and about `skipIf`.
 *  - **pixel diffing.** Re-rendering and comparing pixels breaks on every
 *    innocent change (font hinting, a scrollbar, a subpixel edge) and gets
 *    switched off; see the note at the top of `scripts/layout-probe.mjs`.
 *
 * ## Whether a picture has a reader at all
 *
 * The case above compares the manifest with the tree. It says nothing about
 * whether a *person* is ever sent to a given image — and that gap is where a
 * stale screenshot lives. This round met it for real:
 * `docs/screenshots/states/empty.png` still held bytes from an older renderer,
 * while `docs/screenshots/empty.png` — the picture `README.md` and
 * `docs/state-walkthrough.md` actually name — had been retaken. Nothing was
 * red, because the manifest is the only thing that knows the first file exists,
 * and the manifest is rewritten by whoever runs `--write`. A committed image
 * that no document points at is therefore a claim nobody can be asked to stand
 * behind, so the last block below requires every screenshot in
 * `docs/screenshots/` to be named by a document, and names the orphan.
 *
 * ## What it does not judge
 *
 * Whether a screenshot looks good, or whether the pixels show what the caption
 * says. And the hash cannot tell whether the images were actually retaken:
 * `--write` records "the sources are now these bytes", and a person can run it
 * without looking at a single pixel. That is a limit of every non-pixel gate;
 * the gate's job is to make the omission deliberate instead of silent.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import {
  MANIFEST_PATH,
  buildManifest,
  drift,
  driftLines,
  isClean,
  readManifest,
  screenshotFiles,
} from '../../scripts/screenshot-sources.mjs';

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

/**
 * The screenshots must be pictures of the renderer that is in the tree.
 *
 * The cases above check the file; these check the claim. `sources.json` is the
 * acknowledgement that somebody looked at the renderer as it is now and
 * retook the images — or at least decided not to.
 */
describe('the screenshots are in sync with the renderer', () => {
  const manifest = readManifest(REPO_ROOT);

  it('has a manifest, so the checks below are not vacuous', () => {
    // First and unconditional, the house rule: a deleted manifest must be the
    // first red, not a run in which every case below compares two empty maps.
    expect(manifest, `${MANIFEST_PATH} is missing — run node scripts/screenshot-sources.mjs --write`)
      .not.toBeNull();
    expect(Object.keys(manifest!.renderer).length, 'the manifest records no renderer source')
      .toBeGreaterThan(0);
    expect(Object.keys(manifest!.screenshots).length, 'the manifest records no screenshot')
      .toBeGreaterThan(0);
  });

  it('records the renderer sources that are actually in the tree', () => {
    // Both directions: a changed file and a new file are the same defect from
    // the reader's side ("the picture is of something else now"), but they need
    // different sentences, so `drift()` keeps them apart.
    const report = drift(manifest, REPO_ROOT);
    expect(
      report.sourcesChanged,
      `these renderer sources changed after the screenshots were taken — retake them, then run ` +
        `node scripts/screenshot-sources.mjs --write:\n${report.sourcesChanged.join('\n')}`,
    ).toEqual([]);
    expect(
      report.sourcesAdded,
      `these renderer sources were added and no screenshot was taken of them:\n` +
        report.sourcesAdded.join('\n'),
    ).toEqual([]);
    expect(
      report.sourcesRemoved,
      `the manifest records renderer sources that no longer exist:\n` +
        report.sourcesRemoved.join('\n'),
    ).toEqual([]);
  });

  it('records the screenshots that are actually on disk', () => {
    const report = drift(manifest, REPO_ROOT);
    expect(
      report.screenshotsChanged,
      `these screenshots were replaced without recording it — run ` +
        `node scripts/screenshot-sources.mjs --write:\n${report.screenshotsChanged.join('\n')}`,
    ).toEqual([]);
    expect(
      report.screenshotsMissing,
      `the manifest records screenshots that are gone:\n${report.screenshotsMissing.join('\n')}`,
    ).toEqual([]);
    expect(
      report.screenshotsUnlisted,
      `these screenshots are in docs/screenshots/ and nobody recorded them:\n` +
        report.screenshotsUnlisted.join('\n'),
    ).toEqual([]);
  });

  it('covers every screenshot the README shows', () => {
    // The README is the front door, so an image it shows must be one the
    // manifest knows about — otherwise the newest picture in the document is
    // the one nothing keeps honest.
    const recorded = new Set(Object.keys(manifest?.screenshots ?? {}));
    for (const path of shown) {
      expect(recorded, `${path} is shown in the README and is not in ${MANIFEST_PATH}`).toContain(
        path,
      );
    }
  });

  it('names the file that moved, so a red run is actionable', () => {
    // The gate's value is the sentence it prints. Driven against a synthetic
    // manifest so this case proves the report can go red without touching the
    // tree — the same reason `feedRefusals()` is a pure function.
    const current = buildManifest(REPO_ROOT);
    const stale = {
      renderer: { ...current.renderer },
      screenshots: { ...current.screenshots },
    };
    const [firstSource] = Object.keys(stale.renderer);
    const [firstShot] = Object.keys(stale.screenshots);
    stale.renderer[firstSource!] = 'sha256:0000';
    stale.screenshots[firstShot!] = 'sha256:0000';
    stale.renderer['apps/desktop/src/renderer/src/components/New.tsx'] = 'sha256:1111';

    const report = drift(stale, REPO_ROOT);
    expect(isClean(report)).toBe(false);
    const lines = driftLines(report);
    expect(lines).toContain(`changed since the screenshots were taken: ${firstSource}`);
    expect(lines).toContain(`screenshot replaced without recording it: ${firstShot}`);
    expect(lines).toContain(
      'recorded renderer source is gone: apps/desktop/src/renderer/src/components/New.tsx',
    );
  });
});

/**
 * Every markdown document a reader is sent to, as repo-relative posix paths.
 *
 * `README.md` and `CONTRIBUTING.md` plus everything under `docs/`. The whole
 * tree rather than a hand-written list, for the reason `screenshot-sources.mjs`
 * gives about the renderer: a list of "the files that matter" is a second fact,
 * and the first document somebody adds would be outside it.
 */
function markdownDocuments(repoRoot = REPO_ROOT): string[] {
  const files = ['README.md', 'CONTRIBUTING.md'].filter((file) =>
    existsSync(join(repoRoot, file)),
  );
  const walk = (dir: string): string[] => {
    const found: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) found.push(...walk(full));
      else if (entry.name.endsWith('.md')) {
        found.push(relative(repoRoot, full).split(sep).join('/'));
      }
    }
    return found;
  };
  return [...files, ...walk(join(repoRoot, 'docs'))].sort();
}

/**
 * The committed screenshots that no document names.
 *
 * Compared as a literal substring, because that is what a reader follows: a
 * path that appears nowhere cannot be clicked, quoted or walked to.
 */
function orphanScreenshots(texts: Map<string, string>, shots: readonly string[]): string[] {
  return shots.filter((shot) => ![...texts.values()].some((text) => text.includes(shot)));
}

/**
 * A picture nobody points at is a claim nobody is asked to stand behind.
 *
 * The manifest keeps every screenshot honest about *bytes*, and the README keeps
 * the six it shows honest about *size*. Between them sat a file that was neither
 * shown nor measured nor named by a single document — `docs/screenshots/states/empty.png`,
 * whose bytes still described a renderer that no longer exists while the picture
 * documents actually reference had been retaken. Nothing could have reported
 * that, because nothing was looking at it.
 */
describe('every committed screenshot is pointed at by a document', () => {
  const documents = markdownDocuments();
  const texts = new Map(documents.map((doc) => [doc, readFileSync(join(REPO_ROOT, doc), 'utf8')]));
  const shots = screenshotFiles(REPO_ROOT);

  it('reads documents and screenshots, so the check below is not vacuous', () => {
    expect(documents.length, 'no markdown document was found to search').toBeGreaterThan(0);
    expect(shots.length, 'no screenshot is committed').toBeGreaterThan(0);
    // The third guard is the one that matters: a scan whose needle never appears
    // in any document would report every screenshot as an orphan, and a scan that
    // matches everything would report none. Prove the reference form is readable.
    expect(
      [...texts.values()].some((text) => text.includes('docs/screenshots/')),
      'no document names a screenshot path, so the comparison below has no subject',
    ).toBe(true);
  });

  it('has a reader for every picture in docs/screenshots/', () => {
    const orphans = orphanScreenshots(texts, shots);
    expect(
      orphans,
      `these screenshots are committed and no document points at them, so nothing keeps their ` +
        `bytes honest — name each one in a document, or delete it:\n${orphans.join('\n')}`,
    ).toEqual([]);
  });

  it('names the picture whose last reference was renamed away', () => {
    // The direction a file survives being moved out from under: the picture stays
    // on disk, the manifest still records it, and only the reference is gone.
    const needle = 'docs/screenshots/states/loading.png';
    expect(shots, `the drive assumes ${needle} is committed`).toContain(needle);

    const renamed = new Map(texts);
    let touched = 0;
    for (const [doc, text] of renamed) {
      if (!text.includes(needle)) continue;
      renamed.set(doc, text.replaceAll(needle, 'docs/screenshots/states/loading-moved.png'));
      touched += 1;
    }
    // A mutation that matched nothing would compare an untouched map with itself
    // and pass — the silent-miss shape `design-tokens.test.ts` now guards against.
    expect(touched, `no document names ${needle}, so this drive proved nothing`).toBeGreaterThan(0);

    expect(orphanScreenshots(renamed, shots)).toEqual([needle]);
  });

  it('reports a brand-new picture nobody has pointed at yet', () => {
    // The other half: adding an image is the common case, and it must not be
    // greener than renaming one away.
    expect(orphanScreenshots(texts, [...shots, 'docs/screenshots/states/newcomer.png'])).toEqual([
      'docs/screenshots/states/newcomer.png',
    ]);
  });
});
