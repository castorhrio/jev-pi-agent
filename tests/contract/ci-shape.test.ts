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
 * ## Why the whole directory
 *
 * The first version of this gate read `.github/workflows/ci.yml` and nothing
 * else, and said so in its own doc comment — which made the blind spot honest
 * but did not close it. The claim in the documents is about **CI**, and the
 * next obvious commit is a second workflow (`release.yml`, `nightly.yaml`) with
 * a packaging step: CI would then package the app, every document would still
 * say it does not, and this file would stay green because it only ever opened
 * one path. The gate now reads every `*.yml` / `*.yaml` in the directory, and
 * a failure names the file the command was found in. The fixture below proves
 * it: a clean `ci.yml` beside a packaging `release.yaml` is reported.
 *
 * ## What it deliberately does not check
 *
 * The job graph, and packaging steps that are not in this directory: a step
 * inside a composite action (`.github/actions/**`) or a reusable workflow
 * invoked with `uses: …/workflows/x.yml@ref` is a known blind spot, and
 * `ci-shape.ts` says so where the reader lives. If that refactor lands, extend
 * the readers rather than deleting the assertion — the sentence in the
 * documents would be wrong either way. The subdirectory case is not a blind
 * spot but a rule: GitHub does not read workflows from a subdirectory, so a
 * `nested/ci.yml` is not run by anyone.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PACKAGING_COMMANDS,
  packagingCommands,
  packagingCommandsIn,
  readWorkflowFiles,
  workflowsPackageTheApp,
} from './ci-shape';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const WORKFLOWS_DIR = join(REPO_ROOT, '.github', 'workflows');
const CI_NAME = 'ci.yml';

/** The real workflow set, read once by the cases that assert on the repository. */
function realWorkflows() {
  return readWorkflowFiles(WORKFLOWS_DIR);
}

describe('the CI workflows package nothing', () => {
  it('reads a workflow directory that runs the gates, so the check below is not vacuous', () => {
    // A missing, emptied or renamed-away directory would satisfy "contains no
    // packaging step" for the wrong reason, and the documents would still claim
    // CI covers something. The gates named here are what the claim contrasts
    // against — and they are read from `ci.yml` specifically, because a
    // directory-wide "some file mentions npm test" would pass on a file that
    // does nothing of the sort.
    expect(existsSync(WORKFLOWS_DIR), `the workflows directory is missing (${WORKFLOWS_DIR})`).toBe(
      true,
    );
    const files = realWorkflows();
    expect(files.length, `no *.yml/*.yaml workflow was read from ${WORKFLOWS_DIR}`).toBeGreaterThan(
      0,
    );
    // `ci.yml` has to be one of them: the document's claim is contrasted with
    // the gates job, and a rename to `gates.yaml` must be a decision someone
    // makes here (and in CONTRIBUTING, which points at the path) rather than a
    // file that quietly drops out of the readers.
    const ci = files.find((file) => file.name === CI_NAME);
    expect(
      ci,
      `\`.github/workflows/${CI_NAME}\` was not read; the gates it runs are the other half of this claim`,
    ).toBeDefined();
    expect(ci!.text).toMatch(/\bnpm test\b/u);
    expect(ci!.text).toMatch(/\bnpm run build\b/u);
  });

  it('names no packaging step in any workflow, so the manual asar check stays manual', () => {
    const found = packagingCommandsIn(realWorkflows());
    expect(
      found,
      `a workflow under \`.github/workflows/\` now runs ${found.join(', ')}; the packaged asar ` +
        'check is no longer manual. Update README.md (both languages), CONTRIBUTING.md and ' +
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

/**
 * A throwaway workflows directory, and a helper that always cleans it up.
 *
 * The real directory is read by the cases above; these fixtures exist so the
 * reader can be shown answering something other than `[]`, and so the *second*
 * file — the shape this gate was widened for — is exercised without editing the
 * repository.
 */
function withWorkflowsDir(files: Record<string, string>, run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'ucad-workflows-'));
  try {
    for (const [name, text] of Object.entries(files)) {
      const path = join(dir, ...name.split('/'));
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, text);
    }
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const CLEAN_CI = [
  'name: CI',
  'jobs:',
  '  gates:',
  '    steps:',
  '      - run: npm ci',
  '      - run: npm test',
  '      - run: npm run build',
].join('\n');

const PACKAGING_RELEASE = [
  'name: Release',
  'jobs:',
  '  dist:',
  '    steps:',
  '      - run: npm run dist',
].join('\n');

describe('the readers cover the directory, not one file', () => {
  it('reads both extensions and reports the file a packaging step came from', () => {
    withWorkflowsDir({ 'ci.yml': CLEAN_CI, 'release.yaml': PACKAGING_RELEASE }, (dir) => {
      const workflows = readWorkflowFiles(dir);
      // Sorted, and `.yaml` is a workflow too: reading only `.yml` would have
      // let this release workflow through unseen.
      expect(workflows.map((workflow) => workflow.name)).toEqual(['ci.yml', 'release.yaml']);
      expect(workflowsPackageTheApp(workflows)).toBe(true);
      // The message names the file, not just the command: this is the whole
      // difference between "CI packages the app" and "the release workflow
      // does, leave `ci.yml` alone".
      expect(packagingCommandsIn(workflows)).toEqual(['`npm run dist` in `release.yaml`']);
    });
  });

  it('reads a clean directory as packaging nothing', () => {
    // The control for the case above: two files, neither packaging, and the
    // reader still returns them (so the green is "read two files and found
    // nothing", not "read nothing").
    withWorkflowsDir({ 'ci.yml': CLEAN_CI, 'nightly.yml': CLEAN_CI }, (dir) => {
      const workflows = readWorkflowFiles(dir);
      expect(workflows.map((workflow) => workflow.name)).toEqual(['ci.yml', 'nightly.yml']);
      expect(packagingCommandsIn(workflows)).toEqual([]);
      expect(workflowsPackageTheApp(workflows)).toBe(false);
    });
  });

  it('skips what GitHub does not run: other extensions and subdirectories', () => {
    // `notes.md` is documentation beside the workflows; `nested/ci.yml` is not
    // read by GitHub (workflows live at the top level only). Neither may turn
    // the gate red — and, more importantly, neither is a workflow whose
    // packaging step the gate could be relying on.
    withWorkflowsDir(
      {
        'ci.yml': CLEAN_CI,
        'notes.md': '# these run on push\n- npm run package\n',
        'nested/ci.yml': PACKAGING_RELEASE,
      },
      (dir) => {
        expect(readWorkflowFiles(dir).map((workflow) => workflow.name)).toEqual(['ci.yml']);
        expect(workflowsPackageTheApp(readWorkflowFiles(dir))).toBe(false);
      },
    );
  });

  it('fails rather than answering "nothing packages" when the directory is gone', () => {
    // `readdirSync` throwing is the point: an empty list is the answer that
    // makes the documents' claim look verified. A moved or renamed workflows
    // directory has to be a red gate, not a silent green one.
    expect(() => readWorkflowFiles(join(REPO_ROOT, '.github', 'no-such-dir'))).toThrow();
  });
});
