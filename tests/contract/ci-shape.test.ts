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
 * a failure names the file *and line* the command was found on. The fixture
 * below proves it: a clean `ci.yml` beside a packaging `release.yaml` is
 * reported, and a red run says which of the two fixes it needs.
 *
 * ## What it deliberately does not check — and how that is pinned
 *
 * The job graph, and packaging steps that are not files in this directory: a
 * step inside a composite action (`.github/actions/<name>/action.yml`) or inside a
 * reusable workflow in *another* repository (`uses: owner/repo/.github/
 * workflows/x.yml@ref`). Both used to be a paragraph in `ci-shape.ts` and a
 * paragraph in this header, which is a gap nobody can fail: moving a step into
 * an action would leave the gate green and the documents lying. The cases in
 * *what this reader deliberately does not see* now assert the gap with a
 * fixture that shows the command there and the reader answering `[]`, and
 * assert that this repository installs neither shape today — so extending the
 * readers starts as a red test naming these cases.
 *
 * The narrowing that paragraph did not mention: a reusable workflow **in this
 * repository** is a top-level file under `.github/workflows/`, so the reader
 * sees it and a packaging step inside it is caught. Only the remote case is
 * invisible, and the third case in that describe pins the half the gate does
 * cover.
 *
 * The subdirectory case is not a blind spot but a rule: GitHub does not read
 * workflows from a subdirectory, so a `nested/ci.yml` is not run by anyone.
 */

import { describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PACKAGING_COMMANDS,
  packagingCommands,
  packagingCommandsIn,
  packagingFindings,
  packagingProblem,
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
    // The failure carries its own fix (`packagingProblem`): the file and line it
    // matched, and the two readings a textual match can have — a comment to
    // reword, or a real step that makes the documents stale. That is why this
    // assertion hands the message to the reader instead of rebuilding it here:
    // a second copy of the advice would drift from the one the gate prints.
    expect(packagingProblem(realWorkflows())).toBeUndefined();
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

  it('recognises the other ways an Electron packaging step is written', () => {
    // This repository packages with electron-builder, and the first version of
    // the vocabulary named only its entry points. The other two toolchains an
    // Electron project reaches for are named too — not because this repository
    // uses them, but because the expensive mistake here is a *missed* step
    // (`ci-shape.ts` argues the asymmetry): a release job switched to
    // electron-forge would otherwise start packaging the app in CI while every
    // document went on saying CI does not.
    //
    // Each line is asserted rather than assumed, so the list is a decision with
    // a failing test behind it instead of a list nobody reads twice.
    expect(packagingCommands('      - run: npm run make\n')).toEqual(['`npm run make`']);
    expect(packagingCommands('      - run: npx electron-packager . --platform=win32\n')).toEqual([
      '`electron-packager`',
    ]);
    expect(packagingCommands('      - run: npx electron-forge make\n')).toEqual([
      '`electron-forge`',
    ]);
    // A comment naming one of them trips the gate exactly like a step does —
    // the same textual rule, and the same one-minute fix.
    expect(packagingCommands('      # electron-forge is how a fork would do it\n')).toEqual([
      '`electron-forge`',
    ]);
  });

  it('cannot see a command hidden behind a script, which is the boundary of the vocabulary', () => {
    // The boundary `ci-shape.ts` declares, pinned so it is a known edge rather
    // than a surprise: the step names a *file*, and no pattern can read what
    // that file does. `npm run build:dist` is here for the other half — a
    // command this repository does not have and the vocabulary does not claim
    // to recognise. If either of these ever becomes the way the app is
    // packaged, the fix is to make the workflow call a named command (or to
    // extend the readers), not to trust this gate.
    expect(packagingCommands('      - run: ./scripts/package.sh\n')).toEqual([]);
    expect(packagingCommands('      - run: npm run build:dist\n')).toEqual([]);
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
        // `release.yml:1` — the line the match starts on, not the file alone.
        // A comment is the reading where the fix is a reword, so the address is
        // what the reader needs from a red run.
        expect(packagingCommandsIn(readWorkflowFiles(dir))).toEqual([
          '`npm run dist` at `release.yml:1`',
        ]);
      },
    );
  });

  it('reports the file, the line and the fix, so a red run is actionable on its own', () => {
    // The failure used to name the file and the command, and leave the reader to
    // find the module doc to learn that a comment is the likely cause and that
    // rewording it is the whole fix. Both readings are now in the message, which
    // is what makes the difference between "the gate is wrong" and a one-line
    // edit. Asserted here rather than described in `ci-shape.ts`, because advice
    // that is only printed until somebody edits the string is advice that can
    // disappear silently.
    withWorkflowsDir(
      {
        'release.yml': [
          'name: Release',
          'on:',
          '  workflow_dispatch:',
          'jobs:',
          '  dist:',
          '    steps:',
          '      # we package by hand; npm run dist is the manual step',
        ].join('\n'),
      },
      (dir) => {
        const problem = packagingProblem(readWorkflowFiles(dir));
        expect(problem, 'a packaging comment did not produce a failure').toBeDefined();
        // The address: file and line, so the reword needs no search.
        expect(problem).toContain('`npm run dist` at `release.yml:7`');
        // The fix for the false-positive reading, first because it is the cheap
        // one, and the fix for the real-step reading after it.
        expect(problem).toContain('reword that line');
        expect(problem).toContain('README.md (both languages)');
        expect(problem).toContain('CONTRIBUTING.md');
        // The third document is named because it repeats the claim in prose:
        // the header of `adapter-resolution.ts` says the asar check is manual
        // too, and a real step would make it stale there as well.
        expect(problem).toContain('adapter-resolution.ts');
        // Order matters as much as presence: the cheap reading is offered
        // first, so a contributor whose comment tripped the gate is not sent to
        // rewrite three documents for nothing.
        expect(problem.indexOf('reword that line')).toBeLessThan(
          problem.indexOf('README.md (both languages)'),
        );
      },
    );

    // The clean direction, so the hint is not printed over a tree that passes:
    // a gate whose message always fires is a message nobody reads.
    expect(packagingProblem([{ name: 'ci.yml', text: CLEAN_CI }])).toBeUndefined();
  });

  it('tells the reader not to narrow the vocabulary, so a false alarm is not "fixed" by weakening the gate', () => {
    // The edit this forbids is the tempting one: the gate is red over a comment,
    // so the next reader narrows `PACKAGING_COMMANDS` or teaches the matcher to
    // skip `#` lines, the red goes away — and so does the ability to see a real
    // packaging step. `ci-shape.ts` argues that asymmetry at length; a reader
    // staring at a red run is not reading that argument, so the failure itself
    // has to say it. Asserted rather than trusted to the string staying put:
    // the sentence is one `join` edit away from silently disappearing, and the
    // only thing that would notice is a reader who already knew.
    const problem = packagingProblem([{ name: 'release.yml', text: PACKAGING_RELEASE }]);
    expect(problem, 'a packaging step did not produce a failure').toBeDefined();
    expect(problem).toContain('Do not narrow PACKAGING_COMMANDS');
    expect(problem).toContain('comment exemption');
    // …and the ban is stated as a trade, so it reads as advice rather than as
    // an unexplained rule: the cost of the edit is named in the same sentence.
    expect(problem).toContain('misses a real packaging step');
    // The ban is not the only advice: both real fixes are still in the message.
    expect(problem).toContain('reword that line');
    expect(problem).toContain('README.md (both languages)');
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
      // `PACKAGING_RELEASE` puts the step on line 5; the findings carry it as
      // a field as well, because the formatted string is one consumer of it.
      expect(packagingFindings(workflows)).toEqual([
        { command: '`npm run dist`', workflow: 'release.yaml', line: 5 },
      ]);
      expect(packagingCommandsIn(workflows)).toEqual(['`npm run dist` at `release.yaml:5`']);
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
      expect(packagingCommandsIn(readWorkflowFiles(dir))).toEqual([
        '`npm run dist` at `copied.yml:5`',
      ]);
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

/** ci.yml as a repository that keeps its packaging step in a local action. */
const CI_CALLING_A_COMPOSITE_ACTION = [
  'name: CI',
  'jobs:',
  '  gates:',
  '    steps:',
  '      - uses: actions/checkout@v4',
  '      - uses: ./.github/actions/package',
].join('\n');

/** A composite action that packages the app, living outside the workflows directory. */
const COMPOSITE_PACKAGE_ACTION = [
  'name: package',
  'description: build the installer',
  'runs:',
  '  using: composite',
  '  steps:',
  '    - run: npm run dist',
  '      shell: bash',
].join('\n');

/** The caller of a reusable workflow that lives in somebody else's repository. */
const REMOTE_REUSABLE_RELEASE = [
  'name: Release',
  'on:',
  '  workflow_dispatch:',
  'jobs:',
  '  dist:',
  '    uses: acme/tools/.github/workflows/package.yml@v1',
].join('\n');

/**
 * A throwaway repository root, for the shapes that are not in the workflows
 * directory at all.
 *
 * Same contract as `withWorkflowsDir` — the callback gets the root and the tree
 * is removed afterwards — because the composite action case has to place two
 * files in *different* directories, and a fixture rooted at `.github/workflows/`
 * could not express that.
 */
function withRepoRoot(files: Record<string, string>, run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'ucad-repo-'));
  try {
    for (const [name, text] of Object.entries(files)) {
      const path = join(root, ...name.split('/'));
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, text);
    }
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * The blind spots `ci-shape.ts` used to declare in a paragraph.
 *
 * A declared gap is honest, and it is also unfalsifiable: nothing goes red when
 * the shape appears, so the declaration ages into a false sentence. These cases
 * make each gap a thing that can fail — the command shown present where it
 * lives, the reader shown answering `[]` where it looks — and then make the
 * *repository* fail if either shape is ever installed. The last case is the one
 * that fires on the dangerous commit: moving a packaging step into
 * `.github/actions/` or invoking a remote reusable workflow turns this file red
 * with the extension the reader needs written in the message.
 */
describe('what this reader deliberately does not see', () => {
  it('does not read a composite action, so a packaging step can hide in one', () => {
    withRepoRoot(
      {
        '.github/workflows/ci.yml': CI_CALLING_A_COMPOSITE_ACTION,
        '.github/actions/package/action.yml': COMPOSITE_PACKAGE_ACTION,
      },
      (root) => {
        const actionPath = join(root, '.github', 'actions', 'package', 'action.yml');
        // First half: the command is genuinely packaging. Read where it lives,
        // the shared vocabulary catches it — without this, the case would prove
        // only that some file the reader skips says something.
        expect(packagingCommands(readFileSync(actionPath, 'utf8'))).toEqual(['`npm run dist`']);
        // Second half: read where the gate reads, the same command is invisible.
        const workflows = readWorkflowFiles(join(root, '.github', 'workflows'));
        expect(workflows.map((workflow) => workflow.name)).toEqual(['ci.yml']);
        expect(packagingCommandsIn(workflows)).toEqual([]);
        expect(workflowsPackageTheApp(workflows)).toBe(false);
      },
    );
  });

  it('does read a reusable workflow that lives in this directory', () => {
    // The half of the gap that is *not* open, and the reason the doc says
    // "in another repository" rather than "reusable workflows": a workflow in
    // this repository is a top-level file under `.github/workflows/`, so GitHub
    // runs it and this reader opens it. Stating the gap more broadly than it is
    // would send the next reader widening a reader that already covers it.
    withWorkflowsDir(
      {
        'ci.yml': [
          'name: CI',
          'jobs:',
          '  gates:',
          '    uses: ./.github/workflows/gates.yml',
        ].join('\n'),
        'gates.yml': PACKAGING_RELEASE,
      },
      (dir) => {
        expect(packagingCommandsIn(readWorkflowFiles(dir))).toEqual([
          '`npm run dist` at `gates.yml:5`',
        ]);
      },
    );
  });

  it('cannot see a reusable workflow in another repository', () => {
    withWorkflowsDir({ 'ci.yml': CLEAN_CI, 'release.yml': REMOTE_REUSABLE_RELEASE }, (dir) => {
      const workflows = readWorkflowFiles(dir);
      // The caller is read — and it names a workflow that is not here. The gate
      // is green over a job that may well package the app, which is the cost of
      // the gap, asserted rather than described.
      expect(workflows.map((workflow) => workflow.name)).toEqual(['ci.yml', 'release.yml']);
      expect(packagingCommandsIn(workflows)).toEqual([]);
      expect(workflowsPackageTheApp(workflows)).toBe(false);
      // And the absence is a decision, not an oversight: the `uses:` line is a
      // path, not a command. Matching it would produce a red gate whose only
      // fix is a lie ("this repository packages the app"), so the vocabulary
      // stays silent about it and the case says so.
      expect(
        packagingCommands('    uses: acme/tools/.github/workflows/package.yml@v1'),
      ).toEqual([]);
    });
  });

  it('finds neither blind spot installed in this repository today', () => {
    // A blind spot is only a blind spot while it is empty. These two assertions
    // are the ones that fire on the dangerous commit: they do not depend on
    // anybody reading the paragraph, and their messages name the reader to
    // extend.
    const actionsDir = join(REPO_ROOT, '.github', 'actions');
    expect(
      existsSync(actionsDir),
      `\`.github/actions/\` now exists (${actionsDir}) and readWorkflowFiles() does not read it: ` +
        'a packaging step could live there and this gate would still answer "CI packages nothing". ' +
        'Extend readWorkflowFiles() (and the cases in this describe, and the blind-spot paragraph ' +
        'in ci-shape.ts) before relying on the gate.',
    ).toBe(false);

    // A `uses:` that names a workflow file is a reusable-workflow call; the
    // ones naming an action (`actions/checkout@v4`) do not end in `.yml@ref`
    // and are not matched. A local call is read anyway (the case above); a
    // remote one is the gap, so a call to *any* workflow file is reported here
    // for the reader to classify.
    // Job-level (`    uses:`) and step-level (`      - uses:`) both, because a
    // reusable workflow is called from either position.
    const reusableCall = /^\s*(?:-\s*)?uses:\s*\S*\.ya?ml(?:@\S*)?\s*$/mu;
    const calling = realWorkflows()
      .filter((workflow) => reusableCall.test(workflow.text))
      .map((workflow) => workflow.name);
    expect(
      calling,
      `a workflow now invokes a reusable workflow (${calling.join(', ')}); if it lives in another ` +
        'repository, a packaging step inside it is invisible to readWorkflowFiles(). Extend the ' +
        'reader, or update this case and ci-shape.ts if the call is genuinely not a packaging path.',
    ).toEqual([]);
  });
});
