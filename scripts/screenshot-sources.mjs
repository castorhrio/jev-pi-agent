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
 *   node scripts/screenshot-sources.mjs --check   # the same, said out loud
 *   node scripts/screenshot-sources.mjs --write   # record the current state
 *   node scripts/screenshot-sources.mjs --walkthrough  # list the ten images a walkthrough needs
 *
 * `--check` exists because the default is a check and a default is not a
 * sentence. A CI step or a release checklist that reads
 * `node scripts/screenshot-sources.mjs` has to be understood before it can be
 * trusted — "does this write?" is a fair question to ask of a command whose
 * sibling flag writes. `--check` answers it in the command itself, and
 * `--check --write` is refused rather than resolved by precedence: a caller
 * that asked for both does not know what it wants, and guessing for it is how
 * a gate ends up recording the drift it was meant to report.
 *
 * `--walkthrough` is the handover half of the same idea, and it exists because
 * the five-state walkthrough (`docs/state-walkthrough.md`) is the one part of
 * the DoD that a machine cannot answer: it needs a person to look at ten PNGs
 * and say yes or no. Handing that to somebody who has not installed the app
 * means handing them the ten files, and "the ten files" was, until this flag,
 * a table in a document that a reader had to copy out by hand — the exact place
 * where a handover loses an image. So the list is read from the document (one
 * fact, not two) and printed one path per line, which is what makes
 * `tar -czf walkthrough.tar.gz $(node scripts/screenshot-sources.mjs --walkthrough)`
 * a single command. It prints paths and nothing else on stdout for that reason;
 * the verdict goes to stderr, and it exits 1 when an image it listed is not in
 * the manifest — a handover that ships a picture no gate keeps honest is worse
 * than no handover.
 *
 * The check path is the one that has to be *proved* red, not merely written:
 * `tests/contract/screenshot-sources.test.ts` runs this file as a subprocess
 * against a throwaway tree, touches a renderer source, and asserts exit 1 with
 * the file named on stderr. Driving `drift()` directly would leave `main()`
 * free to return 0 on drift with every case still green — the gate and the
 * thing it guards going quiet together, which is the defect this repository
 * keeps finding.
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

/**
 * The document that says which images a five-state walkthrough needs.
 *
 * Read rather than restated: the ten images are already listed there, in the
 * order a walker opens them, and a second list in this script would be a second
 * fact that drifts the first time somebody adds a state.
 */
export const WALKTHROUGH_PATH = 'docs/state-walkthrough.md';

/** The heading whose table is the walkthrough's image list. */
export const WALKTHROUGH_HEADING = '## 5 分钟走查脚本';

/** A committed screenshot, as the walkthrough document spells it. */
const WALKTHROUGH_SHOT = /docs\/screenshots\/[\w./-]+\.png/g;

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

/**
 * The images a five-state walkthrough needs, in the order the document lists them.
 *
 * The table under `## 5 分钟走查脚本` is the list; this reads it and nothing
 * else. Empty when the document or the heading is gone, which the caller turns
 * into a failure rather than into "no images to send".
 */
export function walkthroughScreenshots(repoRoot = REPO_ROOT) {
  const absolute = path.join(repoRoot, WALKTHROUGH_PATH);
  if (!fs.existsSync(absolute)) return [];
  const lines = fs.readFileSync(absolute, 'utf8').split('\n');
  const start = lines.findIndex((line) => line.trim() === WALKTHROUGH_HEADING);
  if (start === -1) return [];
  const shots = [];
  for (const line of lines.slice(start + 1)) {
    // A level-1/2 heading ends the section, so the criteria below it are not
    // read as part of the list.
    if (/^#{1,2} /.test(line)) break;
    for (const match of line.matchAll(WALKTHROUGH_SHOT)) {
      if (!shots.includes(match[0])) shots.push(match[0]);
    }
  }
  return shots;
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

const USAGE =
  'usage: node scripts/screenshot-sources.mjs [--check | --write | --walkthrough]';

function main(argv) {
  const write = argv.includes('--write');
  const check = argv.includes('--check');
  const walkthrough = argv.includes('--walkthrough');
  const unknown = argv.filter(
    (arg) => arg !== '--write' && arg !== '--check' && arg !== '--walkthrough',
  );
  if (unknown.length > 0) {
    // An unrecognised flag is an error, not a default: `--wirte` silently
    // reporting drift is the same class of defect as `--steps 6` passing.
    console.error(`unknown option(s): ${unknown.join(', ')}`);
    console.error(USAGE);
    return 1;
  }
  if (walkthrough && (write || check)) {
    // `--walkthrough` lists files; the other two judge or record them. Asking
    // for both is asking for two different answers, and picking one for the
    // caller is how a handover ships the wrong list.
    console.error('--walkthrough lists the walkthrough images; it does not combine with --check or --write');
    console.error(USAGE);
    return 1;
  }
  if (write && check) {
    // Refused rather than resolved by precedence. A caller that asked for both
    // does not know what it wants, and picking one for it is how a gate ends up
    // recording the drift it was meant to report.
    console.error('--check and --write ask for opposite things; pass one of them');
    console.error(USAGE);
    return 1;
  }

  if (walkthrough) {
    const shots = walkthroughScreenshots();
    if (shots.length === 0) {
      console.error(
        `no walkthrough images: ${WALKTHROUGH_PATH} has no \`${WALKTHROUGH_HEADING}\` table, ` +
          'so there is nothing to hand to a person who has not installed the app',
      );
      return 1;
    }
    // Paths on stdout and nothing else, so the output can be handed straight to
    // `tar`/`cp`; the verdict goes to stderr where it cannot be mistaken for a
    // file name.
    for (const shot of shots) console.log(shot);
    const manifest = readManifest();
    const recorded = new Set(Object.keys(manifest?.screenshots ?? {}));
    const unrecorded = shots.filter((shot) => !recorded.has(shot));
    if (unrecorded.length > 0) {
      for (const shot of unrecorded) {
        console.error(
          `[unrecorded] ${shot} is in the walkthrough and not in ${MANIFEST_PATH}, so ` +
            '`--check` cannot say it is still the current screen',
        );
      }
      return 1;
    }
    console.error(
      `walkthrough: ${shots.length} image(s), all recorded in ${MANIFEST_PATH} — ` +
        'send these to whoever answers the criteria',
    );
    return 0;
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
    console.error(
      `${MANIFEST_PATH} is missing — run with --write to record the current state. ` +
        'A missing manifest is a failure, not an empty comparison: with nothing recorded, ' +
        'every screenshot is unaccounted for and the check has no subject.',
    );
    return 1;
  }
  const report = drift(manifest);
  const counts =
    `${Object.keys(manifest.renderer ?? {}).length} renderer source(s) and ` +
    `${Object.keys(manifest.screenshots ?? {}).length} screenshot(s)`;
  if (isClean(report)) {
    // The counts are printed on the green path too: "PASS" over an empty
    // manifest and "PASS" over thirty files read the same otherwise, and the
    // first is the shape of a gate that has stopped looking.
    console.log(`PASS — ${counts} match ${MANIFEST_PATH}`);
    return 0;
  }
  for (const line of driftLines(report)) console.error(`[drift] ${line}`);
  const moved = Object.values(report).reduce((total, list) => total + list.length, 0);
  console.error(
    `FAIL — ${moved} file(s) moved since ${MANIFEST_PATH} was written. Retake the screenshots ` +
      'in docs/screenshots/, then run `node scripts/screenshot-sources.mjs --write`',
  );
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
