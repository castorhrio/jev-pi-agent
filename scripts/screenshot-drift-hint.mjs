/**
 * The build says out loud when the screenshots are older than the renderer.
 *
 * Why this file exists
 * --------------------
 * `scripts/screenshot-sources.mjs --check` is the gate: it goes red when a
 * renderer source moved and nobody retook the images. It has been red three
 * rounds running, and every one of those rounds had the same cause — the person
 * who edited `renderer/src/**` did not know the gate existed until CI told them,
 * by which time the change was already a commit and the fix was a second one.
 *
 * A gate that is only read in CI is read by the wrong person at the wrong time.
 * This file is not a second gate: it judges nothing, it writes nothing, and it
 * exits 0 whatever it finds. It runs after `npm run build` (the `postbuild` hook
 * in `package.json`, which `npm run dev` and `npm run dist` both go through) and
 * prints the same drift lines the gate would print — while the person who caused
 * them is still looking at the terminal.
 *
 * Why it must never fail the build
 * --------------------------------
 * The moment this exits non-zero it becomes a second gate with a different
 * verdict from the first, and the two would disagree the first time somebody
 * wanted to build a tree with stale screenshots on purpose (a bisect, a
 * packaging run, a branch that is about to retake them). The gate stays the one
 * thing that decides; this is a reminder that arrives earlier. So the exit code
 * is 0 on all three paths — drift, clean, and no manifest at all — and the
 * contract test asserts that rather than trusting the comment.
 *
 * Why it reuses the gate's own lines
 * ----------------------------------
 * `driftLines()` is imported from `screenshot-sources.mjs` instead of being
 * rewritten here. Two spellings of "styles.css changed" would drift, and the
 * reader would then have to work out whether the build and the gate were talking
 * about the same file. One function, two readers: the gate prefixes each line
 * with `[drift]` and exits 1, this prefixes it with `[screenshots]` and exits 0.
 *
 * What it cannot do
 * -----------------
 * It cannot tell whether the images were retaken, and it cannot make anybody
 * retake them. It moves the discovery from "CI, tomorrow" to "your terminal, now"
 * and stops there; `--write` is still the acknowledgement, and looking at the
 * pictures is still the part a person owns.
 */

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MANIFEST_PATH,
  drift,
  driftLines,
  isClean,
  readManifest,
} from './screenshot-sources.mjs';

/** The prefix every line carries, so the block is greppable and not mistaken for a failure. */
const PREFIX = '[screenshots]';

/**
 * The lines to print for a drift report.
 *
 * Pure, so the contract test can drive it without a tree: the interesting
 * question is whether the block names the file and the command, and that is a
 * question about strings.
 */
export function hintLines(report, manifestPath = MANIFEST_PATH) {
  const lines = [
    'the committed screenshots are older than the renderer sources they are a picture of:',
  ];
  for (const line of driftLines(report)) lines.push(`  ${line}`);
  lines.push(
    'this build is fine — nothing here fails. `node scripts/screenshot-sources.mjs --check` is',
    `red until you retake the images in docs/screenshots/ and run`,
    `\`node scripts/screenshot-sources.mjs --write\` to record them in ${manifestPath}.`,
  );
  return lines.map((line) => `${PREFIX} ${line}`);
}

/** The lines to print when there is no manifest to compare against. */
export function missingManifestLines(manifestPath = MANIFEST_PATH) {
  return [
    `${PREFIX} ${manifestPath} is missing, so nothing records which sources the screenshots`,
    `${PREFIX} were taken from. Run \`node scripts/screenshot-sources.mjs --write\` to record`,
    `${PREFIX} the current state — the check is red until then, and this build is not.`,
  ];
}

function main() {
  const manifest = readManifest();
  if (!manifest) {
    for (const line of missingManifestLines()) console.error(line);
    return 0;
  }
  const report = drift(manifest);
  // Silence when clean: a build that prints a paragraph about screenshots on
  // every run is a build whose output people stop reading, and the one run that
  // mattered would be in the middle of it.
  if (isClean(report)) return 0;
  for (const line of hintLines(report)) console.error(line);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
