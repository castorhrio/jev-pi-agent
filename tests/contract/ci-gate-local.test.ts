/**
 * The local gate has to be the CI gate, and it has to be able to say no.
 *
 * ## Why this file exists
 *
 * `docs/PRODUCT-DOD.md` says the gate is
 * `npm run typecheck && lint && knip && test && test:e2e` "and the CI
 * equivalent" green. The first half is a command a person types; the second
 * half used to be a paragraph in `CONTRIBUTING.md` and a workflow file nobody
 * re-read, so the "CI equivalent run" was whatever the last reader remembered.
 * `scripts/gate-local.mjs` turns it into one command whose steps are **read out
 * of `.github/workflows/`** — same `run:` text, same `env:`, same shell flags.
 *
 * Two things can go wrong with a command like that, and neither is visible from
 * a green run:
 *
 *  - the plan can stop being the workflow (a hard-coded list drifting, a
 *    workflow directory read as `ci.yml` only, a step silently skipped), and
 *  - the command can be unable to fail (a step that always "passes", a
 *    summary that prints PASS after a breaker stopped the run early).
 *
 * So the cases below drive both halves: the plan, which costs milliseconds, and
 * the command itself, run as a subprocess against a throwaway tree — because
 * `main()` could return 0 on a failed step, or run nothing and print PASS, with
 * every plan assertion still green. That is the defect this repository has now
 * found five times (`--steps 6` passing, `skipIf` guards, the backtick that
 * killed the layout gate at import, the drift check that recorded itself, the
 * search that rewrote the manifest it was checking).
 *
 * ## What is deliberately not asserted
 *
 * That a green run here means CI is green. A local run is a different kernel,
 * a different Chromium sandbox story and a different npm; the record's own
 * `note` field says so, and the point of the command is that it is
 * *reproducible*, not that it is GitHub.
 */

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildPlan,
  gateSteps,
  parseArgv,
  planLines,
  planProblems,
  readWorkflows,
  setupSteps,
  summaryLine,
} from '../../scripts/gate-local.mjs';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'gate-local.mjs');

/** The module the gate reads the temp directory through; it travels with the script. */
const PROBE = join(REPO_ROOT, 'scripts', 'temp-dir-probe.mjs');

/** Where the script lives inside a throwaway tree, so its root is that tree. */
const SCRIPT_IN_TREE = join('scripts', 'gate-local.mjs');

/** Where a throwaway tree's workflows live. */
const WORKFLOWS = join('.github', 'workflows');

/**
 * The ids the real plan produces, in CI's order.
 *
 * Hard-coded on purpose: this is the assertion that a workflow step no longer
 * reaches the local gate. If CI grows a step, or a step is renamed, the plan
 * changes and this line has to be reconsidered instead of passing quietly.
 */
const REAL_IDS = ['typecheck', 'lint', 'knip', 'test', 'test:e2e', 'build', 'clean+build:packages'];

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

interface TreeOptions {
  /** Workflow file name and its text. Defaults to one `ci.yml` running `lint`. */
  readonly workflows?: Record<string, string>;
  /** `package.json` scripts. Defaults to a `lint` that does nothing. */
  readonly scripts?: Record<string, string>;
}

/**
 * A tree the script can be run against: itself, a `package.json` whose scripts
 * it validates against, and workflows.
 *
 * No lockfile, no dependencies, no git: the script only needs `package.json`
 * to know which `npm run …` steps exist, and each fixture script is a one-line
 * `node -e`, so a case costs an npm startup rather than an install.
 */
function tree(options: TreeOptions = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'ucad-gate-local-'));
  tempDirs.push(root);
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, WORKFLOWS), { recursive: true });
  copyFileSync(SCRIPT, join(root, SCRIPT_IN_TREE));
  // The gate reads the temp directory through a sibling module, so a tree with
  // only the runner in it would die on the import rather than get to the
  // behaviour these cases are about.
  copyFileSync(PROBE, join(root, join('scripts', 'temp-dir-probe.mjs')));
  writeFileSync(
    join(root, 'package.json'),
    `${JSON.stringify(
      {
        name: 'gate-local-fixture',
        private: true,
        scripts: options.scripts ?? { lint: 'node -e ""', test: 'node -e ""' },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  const workflows = options.workflows ?? {
    'ci.yml': [
      'name: CI',
      'jobs:',
      '  gates:',
      '    steps:',
      '      - uses: actions/checkout@v4',
      '      - name: Lint',
      '        run: npm run lint',
    ].join('\n'),
  };
  for (const [name, text] of Object.entries(workflows)) {
    writeFileSync(join(root, WORKFLOWS, name), `${text}\n`, 'utf8');
  }
  return root;
}

/** Runs the script inside `root`; never throws on a non-zero exit. */
function run(root: string, args: string[], env: Record<string, string> = {}): RunResult {
  try {
    const stdout = execFileSync(process.execPath, [join(root, SCRIPT_IN_TREE), ...args], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
    return { code: 0, stdout, stderr: '' };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { code: failure.status ?? 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}

describe('the plan is the workflow, not a copy of it', () => {
  it('reads the real workflows and classifies every step', () => {
    const plan = buildPlan(REPO_ROOT);
    expect(plan.workflows, 'CI reads the whole directory').toContain('ci.yml');
    // The order is CI's order, and the ids are what `--only` accepts.
    expect(gateSteps(plan).map((step) => step.id)).toEqual(REAL_IDS);
    // Nothing unclassifiable, and every step has its line number — a red run
    // about a step is only actionable with the line it is on.
    expect(planProblems(plan)).toEqual([]);
    for (const step of plan.steps) expect(step.line).toBeGreaterThan(0);
    // One setup step, and it is the install: printed as skipped, never dropped.
    expect(setupSteps(plan).map((step) => step.command)).toEqual([
      'npm install -g npm@11.6.2\nnpm ci',
    ]);
  });

  it('keeps CI\'s wrapper and environment on the suite step', () => {
    // This is the whole claim of the command: the local run is what CI runs.
    // If someone "simplifies" the step to `npm test` on the runner side, the
    // layout gate measures a different display, and this case has to be
    // revisited rather than passing on a plan that no longer matches.
    const test = gateSteps(buildPlan(REPO_ROOT)).find((step) => step.id === 'test');
    expect(test, 'the unit/contract suite is not in the plan').toBeDefined();
    expect(test!.command).toContain('xvfb-run --auto-servernum');
    expect(test!.command).toContain('--server-args="-screen 0 1920x1080x24"');
    expect(test!.env).toEqual({ ELECTRON_DISABLE_SANDBOX: '1' });
    // The e2e step has the wrapper but not the screen size: that is the
    // workflow's choice, and the plan carries it instead of normalising it.
    const e2e = gateSteps(buildPlan(REPO_ROOT)).find((step) => step.id === 'test:e2e');
    expect(e2e!.command).toContain('xvfb-run --auto-servernum');
    expect(e2e!.command).not.toContain('--server-args');
  });

  it('picks up every `run:` step of the workflow, including ones added later', () => {
    // The drift this catches: a new gate step in ci.yml that the local run
    // never executes, while both documents say "CI equivalent". The count is
    // taken from the workflow text, so adding a step fails here until the plan
    // covers it.
    const text = readWorkflows(join(REPO_ROOT, '.github', 'workflows'))
      .map((file) => file.text)
      .join('\n');
    const declared = (text.match(/^[ ]*(?:-[ ]+)?run:/gmu) ?? []).length;
    const plan = buildPlan(REPO_ROOT);
    expect(plan.steps.length, 'a `run:` step did not reach the plan').toBe(declared);
    expect(declared).toBeGreaterThanOrEqual(8);
  });

  it('derives the plan from the workflow it is given', () => {
    // The fixture runs `lint` only. A hard-coded list in the script would
    // still answer with typecheck/test/build here.
    const root = tree();
    expect(gateSteps(buildPlan(root)).map((step) => step.id)).toEqual(['lint']);
  });

  it('reads the workflow directory, not one path called ci.yml', () => {
    // CI is whatever GitHub runs from `.github/workflows/`. A release workflow
    // that adds a gate step is a gate step, and reading only `ci.yml` would
    // leave it outside the local run.
    const root = tree({
      workflows: {
        'ci.yml': ['jobs:', '  gates:', '    steps:', '      - run: npm run lint'].join('\n'),
        'release.yml': ['jobs:', '  ship:', '    steps:', '      - run: npm run test'].join('\n'),
      },
      scripts: { lint: 'node -e ""', test: 'node -e ""' },
    });
    const plan = buildPlan(root);
    expect(plan.workflows).toEqual(['ci.yml', 'release.yml']);
    expect(plan.steps.map((step) => `${step.workflow}:${step.id}`)).toEqual([
      'ci.yml:lint',
      'release.yml:test',
    ]);
  });

  it('refuses a step it cannot classify, naming the file, the line and the two fixes', () => {
    const root = tree({
      workflows: {
        'ci.yml': [
          'jobs:',
          '  gates:',
          '    steps:',
          '      - name: Lint',
          '        run: npm run lint',
          '      - name: Something',
          '        run: ./scripts/check.sh',
        ].join('\n'),
      },
    });
    const problems = planProblems(buildPlan(root));
    expect(problems.length, 'an unclassifiable step was skipped in silence').toBe(1);
    expect(problems[0]).toContain('ci.yml:6');
    expect(problems[0]).toContain('./scripts/check.sh');
    expect(problems[0]).toContain('classifyStep()');
    expect(problems[0]).toContain('SETUP_COMMAND');
  });

  it('refuses an `npm run` step whose script `package.json` does not declare', () => {
    // The workflow is the thing that drifts here: `npm run test:e2ee` on a
    // runner exits 1 with "missing script", but a local gate that trusted the
    // workflow's spelling would report a step id that no script backs.
    const plan = buildPlan(
      tree({
        workflows: {
          'ci.yml': ['jobs:', '  gates:', '    steps:', '      - run: npm run test:e2ee'].join('\n'),
        },
      }),
    );
    expect(planProblems(plan).join('\n')).toContain('`package.json` does not declare');
  });

  it('fails when there is no workflow to read, instead of running zero steps', () => {
    // An empty directory satisfies "no step failed" for the wrong reason.
    const root = tree();
    rmSync(join(root, WORKFLOWS), { recursive: true, force: true });
    expect(() => buildPlan(root)).toThrow(/does not exist/);
    const listed = run(root, ['--list']);
    expect(listed.code).toBe(1);
    expect(listed.stderr).toContain('could not read the workflows');
  });

  it('prints the plan with the ids `--only` accepts, and says what is skipped', () => {
    const lines = planLines(buildPlan(REPO_ROOT)).join('\n');
    expect(lines).toContain('ci.yml:52');
    expect(lines).toContain('xvfb-run --auto-servernum --server-args="-screen 0 1920x1080x24" npm test');
    expect(lines).toContain('[skip] setup');
    expect(lines).toContain('npm ci');
    expect(lines).toContain('ELECTRON_DISABLE_SANDBOX=1');
    expect(lines).toContain('7 gate step(s), 1 setup step(s)');
  });
});

describe('the command runs the plan, and can say no', () => {
  it('--list runs nothing and writes nothing but the plan', () => {
    // The reader's first question about `--list` is "does it run the suite?".
    // The marker file answers it without a stopwatch.
    const root = tree({
      scripts: { lint: 'node -e "require(\'node:fs\').writeFileSync(\'ran.txt\', \'yes\')"' },
    });
    const listed = run(root, ['--list']);
    expect(listed.code, listed.stderr).toBe(0);
    expect(listed.stdout).toContain('[run ] lint');
    expect(listed.stdout).toContain('PASS — listed 1 gate step(s); nothing was run');
    expect(existsSync(join(root, 'ran.txt')), '--list executed a step').toBe(false);

    const planPath = join(root, 'plan.json');
    expect(run(root, ['--list', '--json', planPath]).code).toBe(0);
    const plan = JSON.parse(readFileSync(planPath, 'utf8')) as {
      steps: { id: string; kind: string; command: string }[];
    };
    expect(plan.steps.map((step) => `${step.kind}:${step.id}`)).toEqual(['gate:lint']);
    expect(plan.steps[0]!.command).toBe('npm run lint');
  });

  it('runs a gate step with the `env:` the workflow attaches to it', () => {
    // The sandbox flag is what makes the suite runnable on a Linux box at all,
    // so "same env" is not decoration: it is the difference between a run and
    // a crash at Chromium startup.
    const root = tree({
      scripts: {
        lint: 'node -e "require(\'node:fs\').writeFileSync(\'mark.txt\', process.env.MARK ?? \'unset\')"',
      },
      workflows: {
        'ci.yml': [
          'jobs:',
          '  gates:',
          '    steps:',
          '      - name: Lint',
          '        env:',
          "          MARK: 'from-the-workflow'",
          '        run: npm run lint',
        ].join('\n'),
      },
    });
    const ran = run(root, []);
    expect(ran.code, ran.stderr).toBe(0);
    expect(readFileSync(join(root, 'mark.txt'), 'utf8')).toBe('from-the-workflow');
    expect(ran.stdout).toContain('[ok  ] lint');
    expect(ran.stdout).toContain('PASS — 1 gate step(s) green');
  });

  it('exits 1, names the failing step, and says which steps did not run', () => {
    // The failure mode of a "run the gates" script: print PASS anyway, or stop
    // at the breaker and let the transcript read like a complete run. Both are
    // asserted here.
    const root = tree({
      scripts: {
        lint: 'node -e "process.exit(3)"',
        test: 'node -e "require(\'node:fs\').writeFileSync(\'after.txt\', \'ran\')"',
      },
      workflows: {
        'ci.yml': [
          'jobs:',
          '  gates:',
          '    steps:',
          '      - run: npm run lint',
          '      - run: npm test',
        ].join('\n'),
      },
    });
    const ran = run(root, []);
    expect(ran.code, 'a failing step must be a red run').toBe(1);
    expect(ran.stderr).toContain('[FAIL] lint exited 3');
    expect(ran.stderr).toContain('FAIL — step(s) lint exited 3; 1 step(s) did not run after it');
    expect(ran.stderr).toContain('[skipped] test — not run: an earlier step failed');
    expect(ran.stdout, 'a red run must not print PASS').not.toContain('PASS');
    expect(existsSync(join(root, 'after.txt')), 'a step after the breaker still ran').toBe(false);
  });

  it('refuses to run any step when the temp directory cannot be written', () => {
    /*
     * The false red this exists for: `/tmp` on a quota'd tmpfs, where the
     * contract suite's `mkdtempSync(tmpdir())` fails and dozens of unrelated
     * files go red over an errno that names no directory and no fix. The gate
     * is supposed to be the DoD, so a red line about the machine has to say it
     * is about the machine — and say it before `npm test` spends a minute
     * discovering it 83 ways.
     */
    const root = tree({
      scripts: {
        lint: 'node -e "require(\'node:fs\').writeFileSync(\'ran.txt\', \'yes\')"',
      },
    });
    const refused = run(root, [], { TMPDIR: join(root, 'package.json') });
    expect(refused.code, 'an unwritable temp directory must be a red run').toBe(1);
    expect(refused.stderr).toContain('[refused]');
    expect(refused.stderr).toContain('is not usable');
    expect(refused.stderr).toContain('This is the machine, not the tree.');
    expect(refused.stderr).toContain('REFUSED —');
    // `[run ]` is the *plan* line and is printed before the probe; `[ok  ]` is
    // the outcome line, and a refused gate must not have produced one.
    expect(refused.stdout, 'a refused gate must not report a step outcome').not.toContain('[ok  ]');
    expect(refused.stdout).not.toContain('PASS');
    expect(existsSync(join(root, 'ran.txt')), 'the gate ran a step over an unusable temp dir').toBe(
      false,
    );
  });

  it('runs the plan when TMPDIR points somewhere that passed the same write', () => {
    // The control for the case above: the refusal is about the directory, not
    // about the tree, so pointing TMPDIR at a writable directory has to be
    // enough to get a green run out of the same fixture.
    const root = tree();
    const writable = join(root, 'tmp-here');
    mkdirSync(writable, { recursive: true });
    const ran = run(root, [], { TMPDIR: writable });
    expect(ran.code, ran.stderr).toBe(0);
    expect(ran.stdout).toContain('PASS — 1 gate step(s) green');
  });

  it('--list stays green over an unusable temp directory', () => {
    // Listing is the question "what would run?", and a machine with a full
    // quota still deserves an answer to it. The probe guards runs, not plans.
    const root = tree();
    const listed = run(root, ['--list'], { TMPDIR: join(root, 'package.json') });
    expect(listed.code, listed.stderr).toBe(0);
    expect(listed.stdout).toContain('PASS — listed 1 gate step(s); nothing was run');
  });

  it('--only runs one step, and an unknown id is refused with the ids it has', () => {
    const root = tree({
      scripts: {
        lint: 'node -e "require(\'node:fs\').writeFileSync(\'lint.txt\', \'yes\')"',
        test: 'node -e "require(\'node:fs\').writeFileSync(\'test.txt\', \'yes\')"',
      },
      workflows: {
        'ci.yml': ['jobs:', '  gates:', '    steps:', '      - run: npm run lint', '      - run: npm test'].join(
          '\n',
        ),
      },
    });
    const only = run(root, ['--only', 'test']);
    expect(only.code, only.stderr).toBe(0);
    expect(existsSync(join(root, 'test.txt'))).toBe(true);
    expect(existsSync(join(root, 'lint.txt')), '--only ran a step nobody asked for').toBe(false);

    const typo = run(root, ['--only', 'tset']);
    expect(typo.code).toBe(1);
    expect(typo.stderr).toContain('unknown step id(s): tset; this plan has lint, test');
  });

  it('refuses an option it does not know, instead of running everything', () => {
    const root = tree();
    const typo = run(root, ['--lst']);
    expect(typo.code).toBe(1);
    expect(typo.stderr).toContain('unknown option(s): --lst');
    expect(typo.stderr).toContain('usage: node scripts/gate-local.mjs');
    // A flag that needs a value and did not get one is the same class of
    // defect: `--json` at the end of a line would otherwise run the gate and
    // write nothing, which reads like a record was kept.
    const noValue = run(root, ['--json']);
    expect(noValue.code).toBe(1);
    expect(noValue.stderr).toContain('option(s) that need a value: --json');
  });

  it('writes a record that says what ran, and that it is not a CI run', () => {
    const root = tree();
    const out = join(root, 'run.json');
    const ran = run(root, ['--json', out]);
    expect(ran.code, ran.stderr).toBe(0);
    const record = JSON.parse(readFileSync(out, 'utf8')) as {
      note: string;
      verdict: string;
      steps: { id: string; exitCode: number; status: string; command: string }[];
      notRun: string[];
    };
    expect(record.verdict).toBe('pass');
    expect(record.steps.map((step) => `${step.id}:${step.status}:${step.exitCode}`)).toEqual([
      'lint:pass:0',
    ]);
    expect(record.steps[0]!.command).toBe('npm run lint');
    expect(record.notRun).toEqual([]);
    // The sentence that keeps a transcript from being read as a CI run.
    expect(record.note).toContain('It is not a CI run');
  });

  it('summarises a stopped run without letting it read as complete', () => {
    // Pure function, so the wording is pinned without a subprocess: a summary
    // that says "PASS" over the steps that happened to run is how a breaker in
    // step 2 gets lost.
    const passed = { id: 'lint', exitCode: 0, durationMs: 1 };
    expect(summaryLine([passed], [])).toContain('PASS — 1 gate step(s) green');
    const red = summaryLine([passed, { id: 'test', exitCode: 2, durationMs: 1 }], [{ id: 'build' }]);
    expect(red).toContain('FAIL — step(s) test exited 2; 1 step(s) did not run after it');
    expect(red, 'a failed run must not contain PASS').not.toContain('PASS');
  });

  it('parses its own flags the way the usage line says', () => {
    expect(parseArgv(['--list', '--json', 'out.json'])).toEqual({
      list: true,
      only: [],
      json: 'out.json',
      unknown: [],
      missingValue: [],
    });
    expect(parseArgv(['--only', 'lint,test']).only).toEqual(['lint', 'test']);
    expect(parseArgv(['--only']).missingValue).toEqual(['--only']);
    expect(parseArgv(['--whatever']).unknown).toEqual(['--whatever']);
  });
});
