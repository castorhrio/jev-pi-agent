/**
 * Which renderer sources the committed screenshots are a picture of.
 *
 * Why this file exists
 * --------------------
 * `tests/contract/screenshots.test.ts` already fails when a screenshot the
 * README shows is missing, is not a PNG, or is not the size of the window the
 * product opens at. All three are claims about the *file*. None of them is a
 * claim about the *picture*: a screenshot says "this is what the app looks
 * like", and that sentence goes stale the moment the renderer changes and
 * nobody retakes the image. Nothing compared the two, so `styles.css` could be
 * rewritten and the README would keep advertising the old window — the same
 * shape as a README citing a test that was renamed.
 *
 * What it records
 * ---------------
 * A manifest (`docs/screenshots/sources.json`) holding the sha256 of every
 * renderer source and of every committed screenshot. The gate recomputes both
 * and names the file that moved. Retaking the screenshots and re-running
 * `node scripts/screenshot-sources.mjs --write` is the acknowledgement; until
 * then the gate is red.
 *
 * Why not the two obvious alternatives
 * ------------------------------------
 * **mtime.** The cheap version of this gate compares the PNG's mtime with the
 * component's mtime. It is wrong in the one environment that matters: `git
 * clone` and `git checkout` stamp every file with the checkout time, so in CI
 * every screenshot is exactly as old as every source and the comparison is
 * green no matter what changed. A gate that cannot go red is worse than no
 * gate — this repository has said so about `--steps` and about `skipIf`.
 *
 * **Pixel diffing.** Re-rendering in Chromium and comparing pixels catches
 * everything, including the innocent changes: font hinting differs per machine,
 * a scrollbar appears, an antialiased edge moves by a subpixel. `layout-probe.mjs`
 * and `layout.test.ts` both say why this repository does not do it — it breaks
 * on the first innocent change and gets switched off, and then it catches
 * nothing at all.
 *
 * What it cannot do
 * -----------------
 * It cannot tell whether the screenshots were actually retaken. `--write`
 * records "the sources are now these bytes" and a person can run it without
 * looking at a single pixel. That is a limit of every non-pixel gate, and it is
 * written down here rather than papered over: the gate's job is to make the
 * omission *deliberate* instead of silent.
 *
 * Usage
 * -----
 *   node scripts/screenshot-sources.mjs           # report drift, exit 1 if any
 *   node scripts/screenshot-sources.mjs --write   # record the current state
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** The repository root, so every path below is anchored and not cwd-relative. */
export const REPO_ROOT = path.resolve(here, '..');

/**
 * The renderer, which is what a screenshot is a picture of.
 *
 * The whole directory rather than a hand-written list of "the files that matter
 * visually": a list is a second fact that drifts, and the first component
 * somebody adds would be outside it. `dev/` is included on purpose — the five
 * interface states are rendered by `dev/fixture-bridge.ts` and named by
 * `dev/scenarios.ts`, so a change there changes what `?scenario=empty` looks
 * like just as surely as a CSS rule does.
 */
export const RENDERER_DIR = 'apps/desktop/src/renderer/src';

/**
 * The visible text lives outside the renderer directory.
 *
 * Every string on screen comes from here, so a copy change is a screenshot
 * change. It is the only file outside `RENDERER_DIR` that is tracked, and it is
 * named rather than globbed so that widening the set stays a decision.
 */
export const SHARED_I18N = 'apps/desktop/src/shared/i18n.ts';

/** The directory the committed screenshots live in. */
export const SHOTS_DIR = 'docs/screenshots';

/** The manifest this script writes and the gate reads. */
export const MANIFEST_PATH = 'docs/screenshots/sources.json';

/** Extensions that can change what the renderer draws. */
const RENDERER_EXT = /\.(ts|tsx|css)$/;

/** Every file under `dir`, recursively, as repo-relative posix paths. */
function walk(repoRoot, dir) {
  const absolute = path.join(repoRoot, dir);
  if (!fs.existsSync(absolute)) return [];
  const files = [];
  for (const entry of fs.readdirSync(absolute, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    // `parentPath` is Node 20.12+; `path` is the older spelling of the same
    // field. Both are read so the script does not depend on which one the
    // runtime in use provides.
    const full = path.join(entry.parentPath ?? entry.path, entry.name);
    files.push(path.posix.join(dir, path.relative(absolute, full).split(path.sep).join('/')));
  }
  return files.sort();
}

/**
 * The renderer sources a screenshot is a picture of, sorted.
 *
 * Sorted because the manifest is committed and read by humans: an unsorted map
 * would produce a diff on every run and hide the one line that changed.
 */
export function rendererSources(repoRoot = REPO_ROOT) {
  const files = walk(repoRoot, RENDERER_DIR).filter((file) => RENDERER_EXT.test(file));
  if (fs.existsSync(path.join(repoRoot, SHARED_I18N))) files.push(SHARED_I18N);
  return files.sort();
}

/** Every committed screenshot, sorted. */
export function screenshotFiles(repoRoot = REPO_ROOT) {
  return walk(repoRoot, SHOTS_DIR).filter((file) => file.toLowerCase().endsWith('.png'));
}

/** The sha256 of a file, as `sha256:<hex>`. */
export function fileDigest(absolutePath) {
  return `sha256:${createHash('sha256').update(fs.readFileSync(absolutePath)).digest('hex')}`;
}

/** The manifest for the tree as it is right now. */
export function buildManifest(repoRoot = REPO_ROOT) {
  const renderer = {};
  for (const file of rendererSources(repoRoot)) {
    renderer[file] = fileDigest(path.join(repoRoot, file));
  }
  const screenshots = {};
  for (const file of screenshotFiles(repoRoot)) {
    screenshots[file] = fileDigest(path.join(repoRoot, file));
  }
  return {
    note:
      'Written by scripts/screenshot-sources.mjs. The screenshots in this directory were taken ' +
      'while the renderer sources below were at these hashes. Retake the images, then run ' +
      '`node scripts/screenshot-sources.mjs --write`.',
    renderer,
    screenshots,
  };
}

/**
 * Everything that moved since the manifest was written.
 *
 * Six separate lists rather than one boolean, because the message a red gate
 * prints has to name the file: "the screenshots are stale" sends a reader
 * looking through thirty files, and `styles.css changed` does not.
 */
export function drift(manifest, repoRoot = REPO_ROOT) {
  const recordedSources = manifest?.renderer ?? {};
  const recordedShots = manifest?.screenshots ?? {};
  const currentSources = buildManifest(repoRoot);

  const sourcesChanged = [];
  const sourcesAdded = [];
  for (const [file, digest] of Object.entries(currentSources.renderer)) {
    if (!(file in recordedSources)) sourcesAdded.push(file);
    else if (recordedSources[file] !== digest) sourcesChanged.push(file);
  }
  const sourcesRemoved = Object.keys(recordedSources).filter(
    (file) => !(file in currentSources.renderer),
  );

  const screenshotsChanged = [];
  const screenshotsMissing = [];
  for (const [file, digest] of Object.entries(recordedShots)) {
    if (!(file in currentSources.screenshots)) screenshotsMissing.push(file);
    else if (currentSources.screenshots[file] !== digest) screenshotsChanged.push(file);
  }
  const screenshotsUnlisted = Object.keys(currentSources.screenshots).filter(
    (file) => !(file in recordedShots),
  );

  return {
    sourcesChanged: sourcesChanged.sort(),
    sourcesAdded: sourcesAdded.sort(),
    sourcesRemoved: sourcesRemoved.sort(),
    screenshotsChanged: screenshotsChanged.sort(),
    screenshotsMissing: screenshotsMissing.sort(),
    screenshotsUnlisted: screenshotsUnlisted.sort(),
  };
}

/** True when nothing moved. */
export function isClean(report) {
  return Object.values(report).every((list) => list.length === 0);
}

/** The drift as lines a human can act on, one per file. */
export function driftLines(report) {
  const lines = [];
  for (const file of report.sourcesChanged) {
    lines.push(`changed since the screenshots were taken: ${file}`);
  }
  for (const file of report.sourcesAdded) {
    lines.push(`new renderer source, never photographed: ${file}`);
  }
  for (const file of report.sourcesRemoved) {
    lines.push(`recorded renderer source is gone: ${file}`);
  }
  for (const file of report.screenshotsChanged) {
    lines.push(`screenshot replaced without recording it: ${file}`);
  }
  for (const file of report.screenshotsMissing) {
    lines.push(`recorded screenshot is gone: ${file}`);
  }
  for (const file of report.screenshotsUnlisted) {
    lines.push(`screenshot nobody recorded: ${file}`);
  }
  return lines;
}

/** Read the committed manifest, or `null` when there is none. */
export function readManifest(repoRoot = REPO_ROOT) {
  const absolute = path.join(repoRoot, MANIFEST_PATH);
  if (!fs.existsSync(absolute)) return null;
  return JSON.parse(fs.readFileSync(absolute, 'utf8'));
}

function main(argv) {
  const write = argv.includes('--write');
  const unknown = argv.filter((arg) => arg !== '--write');
  if (unknown.length > 0) {
    // An unrecognised flag is an error, not a default: `--wirte` silently
    // reporting drift is the same class of defect as `--steps 6` passing.
    console.error(`unknown option(s): ${unknown.join(', ')}`);
    console.error('usage: node scripts/screenshot-sources.mjs [--write]');
    return 1;
  }

  if (write) {
    const manifest = buildManifest();
    fs.writeFileSync(
      path.join(REPO_ROOT, MANIFEST_PATH),
      `${JSON.stringify(manifest, null, 2)}\n`,
      'utf8',
    );
    console.log(
      `recorded ${Object.keys(manifest.renderer).length} renderer source(s) and ` +
        `${Object.keys(manifest.screenshots).length} screenshot(s) in ${MANIFEST_PATH}`,
    );
    return 0;
  }

  const manifest = readManifest();
  if (!manifest) {
    console.error(`${MANIFEST_PATH} is missing — run with --write to record the current state`);
    return 1;
  }
  const report = drift(manifest);
  if (isClean(report)) {
    console.log(`PASS — the screenshots match the renderer recorded in ${MANIFEST_PATH}`);
    return 0;
  }
  for (const line of driftLines(report)) console.error(`[drift] ${line}`);
  console.error(
    'FAIL — retake the screenshots in docs/screenshots/, then run ' +
      '`node scripts/screenshot-sources.mjs --write`',
  );
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
