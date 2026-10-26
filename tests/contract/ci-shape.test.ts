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
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
 * The match is textual, and it errs in one direction on purpose.
 *
 * These cases exist because the first version of this module said "reads the
 * *commands* in the workflow files", which is a stronger claim than the code
 * makes: the patterns see `#` comments, `name:` strings and every other line of
 * the file. That was documented in a sentence and nothing else, so the next
 * reader who hit a red gate from a comment would have to work out whether they
 * were looking at a bug. Here the behaviour is asserted, which turns "comments
 * count too" from an accident into a rule with a test behind it.
 *
 * The direction matters more than the behaviour: a comment that trips the gate
 * is a false positive a contributor can fix by rephrasing, while a packaging
 * step nobody recognised is the failure the whole module exists to catch. A
 * comment matcher would be able to produce the second kind of error — a
 * `#`-stripping regex is itself a small parser with its own blind spots (block
 * scalars, a `#` inside a quoted `run:`), and each of them is a way to stop
 * seeing a real command.
 */
describe('the packaging match is textual, and errs toward a false alarm', () => {
  it('matches a comment that names a packaging command', () => {
    // The shape a careful contributor writes: a note saying the step is manual
    // *by design*. The gate still goes red, and the fix is to reword the note —
    // `ci-shape.ts` says so where the reader of a failure will look.
    expect(packagingCommands('# do not run npm run dist here\n')).toEqual(['`npm run dist`']);
    expect(packagingCommands('      # npm run package is the manual step\n')).toEqual([
      '`npm run package`',
    ]);
    // Nor does the position in the file matter: matching is over the whole text,
    // not per line or per step.
    expect(packagingCommands([CLEAN_CI, '# was: npx electron-builder --dir'].join('\n'))).toEqual([
      '`electron-builder`',
    ]);
  });

  it('does not distinguish a comment from a step, so neither may be used as a hiding place', () => {
    // The same text, once as a step and once as a comment: identical verdicts.
    // A gate that could tell them apart would be a YAML parser, and the module
    // doc says why this one is not.
    const asStep = '      - run: npm run dist\n';
    const asComment = '      # npm run dist\n';
    expect(packagingCommands(asComment)).toEqual(packagingCommands(asStep));
  });

  it('reports the file a comment tripped it in, so the reword has an address', () => {
    withWorkflowsDir(
      { 'ci.yml': CLEAN_CI, 'release.yml': '# we do not run npm run dist; see CONTRIBUTING\n' },
      (dir) => {
        expect(packagingCommandsIn(readWorkflowFiles(dir))).toEqual([
          '`npm run dist` in `release.yml`',
        ]);
      },
    );
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

  it('skips a symlinked workflow file, which is the gap the module declares', () => {
    // `isFile()` is false for a link, so a workflow installed as a symlink is
    // not read — and the consequence is not neutral: it is a gate answering
    // "nothing packages the app" about a file it never opened. The behaviour is
    // pinned here rather than left as a surprise, and `ci-shape.ts` says what to
    // do about it (`isSymbolicLink()` plus `statSync`) if a symlink ever lands in
    // `.github/workflows/`.
    const dir = mkdtempSync(join(tmpdir(), 'ucad-workflows-'));
    try {
      writeFileSync(join(dir, 'ci.yml'), CLEAN_CI);
      // The target is a real workflow body with a packaging step; the name is
      // not a workflow extension, so only the link is in question.
      writeFileSync(join(dir, 'release.yml.template'), PACKAGING_RELEASE);
      symlinkSync('release.yml.template', join(dir, 'release.yml'));

      const workflows = readWorkflowFiles(dir);
      expect(workflows.map((workflow) => workflow.name)).toEqual(['ci.yml']);
      expect(packagingCommandsIn(workflows)).toEqual([]);
      // The cost, asserted: the gate is green over a file that packages.
      expect(workflowsPackageTheApp(workflows)).toBe(false);
      // And the control, so this is a statement about links rather than about
      // the target not being read at all: the same body under a `.yml` name is
      // caught.
      writeFileSync(join(dir, 'copied.yml'), PACKAGING_RELEASE);
      expect(packagingCommandsIn(readWorkflowFiles(dir))).toEqual(['`npm run dist` in `copied.yml`']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails rather than answering "nothing packages" when the directory is gone', () => {
    // `readdirSync` throwing is the point: an empty list is the answer that
    // makes the documents' claim look verified. A moved or renamed workflows
    // directory has to be a red gate, not a silent green one.
    expect(() => readWorkflowFiles(join(REPO_ROOT, '.github', 'no-such-dir'))).toThrow();
  });
});
