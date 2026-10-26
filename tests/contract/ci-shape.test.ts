/**
 * CI's shape is part of the product's promises, so it is a gate.
 *
 * ## Why this file exists
 *
 * `README.md` (in both languages), `CONTRIBUTING.md` and the header of
 * `adapter-resolution.ts` all tell the reader the same thing: reading an
 * adapter from inside a real `.asar` archive is verified by hand because no CI
 * job packages the app. That sentence is only honest while the workflow stays
 * that way, and prose cannot enforce it. The previous round made the *wording*
 * match the workflow; this file makes the workflow match the wording.
 *
 * Without it, adding a packaging job is a one-file change: the job appears, CI
 * starts covering the step, and every document still says it does not. The
 * only test that could notice reads `ci.yml` through its own private regex,
 * and a `npm run dist` step could walk past a regex written for `npm run
 * package`. So both the rule and its vocabulary live in `ci-shape.ts`, and the
 * cases below show the vocabulary catching each command before using it on the
 * real workflow.
 *
 * ## What it deliberately does not check
 *
 * The job graph. It reads commands in this one file, so a packaging step moved
 * into a composite action, a reusable workflow, or a second workflow file is a
 * known blind spot; the module says so. If that refactor lands, extend the
 * readers rather than deleting the assertion — the sentence in the documents
 * would be wrong either way.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PACKAGING_COMMANDS, packagingCommands } from './ci-shape';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const CI_PATH = join(REPO_ROOT, '.github', 'workflows', 'ci.yml');

function readWorkflow(): string {
  return readFileSync(CI_PATH, 'utf8');
}

describe('the CI workflow packages nothing', () => {
  it('reads a workflow that runs the gates, so the check below is not vacuous', () => {
    // A missing or emptied workflow would satisfy "contains no packaging step"
    // for the wrong reason, and the documents would still claim CI covers
    // something. The gates named here are what the claim contrasts against.
    expect(existsSync(CI_PATH), `the CI workflow is missing (${CI_PATH})`).toBe(true);
    const workflow = readWorkflow();
    expect(workflow).toMatch(/\bnpm test\b/u);
    expect(workflow).toMatch(/\bnpm run build\b/u);
  });

  it('names no packaging step, so the manual asar check stays manual', () => {
    const found = packagingCommands(readWorkflow());
    expect(
      found,
      `\`.github/workflows/ci.yml\` now runs ${found.join(', ')}; the packaged asar check is ` +
        'no longer manual. Update README.md (both languages), CONTRIBUTING.md and ' +
        'adapter-resolution.ts to say what CI checks instead of only adding the job.',
    ).toEqual([]);
  });

  it('recognises every packaging command, so the assertion has teeth', () => {
    // Each entry is driven through the same fixture shape a workflow step has.
    for (const { command, pattern } of PACKAGING_COMMANDS) {
      expect(pattern.test(`      - run: ${command}\n`), command).toBe(true);
    }
    // The variants a bare start-of-command match would miss: they all produce a
    // package, and all of them would leave the documents lying.
    expect(packagingCommands('      - run: npm run package:dir\n')).toEqual([
      '`npm run package`',
    ]);
    expect(packagingCommands('      - run: npm run dist:win\n')).toEqual(['`npm run dist`']);
    expect(packagingCommands('      - run: npx electron-builder --dir\n')).toEqual([
      '`electron-builder`',
    ]);
  });

  it('does not mistake the gates themselves for packaging', () => {
    // `npm run build` is run by CI on purpose; calling it packaging would make
    // the assertion fail on the workflow that is supposed to pass. `npm ci`
    // and the test commands are here for the same reason.
    expect(
      packagingCommands(
        [
          '      - run: npm ci',
          '      - run: npm run build',
          '      - run: npm run build:packages',
          '      - run: npm test',
          '      - run: npm run test:e2e',
        ].join('\n'),
      ),
    ).toEqual([]);
  });
});
