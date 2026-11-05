/**
 * The CI gate, run locally, from the workflow file itself.
 *
 * Why this file exists
 * --------------------
 * The DoD says the gate is
 * `npm run typecheck && lint && knip && test && test:e2e` "and the CI
 * equivalent" green. The two halves were not the same command, and the second
 * half had no way to be run deliberately: `npm test` on this machine is not
 * what CI runs, because CI wraps it in `xvfb-run` with a specific screen size
 * and turns the Chromium sandbox off. Those details lived in
 * `.github/workflows/ci.yml` and in a sentence of `CONTRIBUTING.md`, and the
 * "CI equivalent" run was therefore whatever the last person remembered to
 * type. A remembered command is a claim; a URL in a document is a claim that
 * nobody can re-run.
 *
 * So this script reads the workflows and runs their `run:` steps. Same text,
 * same environment variables, same shell flags (`bash -eo pipefail`, which is
 * what a GitHub `run:` step is), same order, and the first failure stops the
 * run the way a CI job does. Nothing is copied into this file: a command list
 * here would be a second fact that drifts, and the drift is invisible —
 * `CONTRIBUTING.md` would keep advertising the list while CI ran something
 * else.
 *
 * What it runs, and what it does not
 * ----------------------------------
 * Every `run:` step in `.github/workflows/` is classified into exactly three
 * kinds, and the classification is printed rather than implied:
 *
 *  - **gate** — the step is this repository's own scripts (`npm run <script>`,
 *    `npm test`, optionally behind an `xvfb-run` wrapper). These are executed
 *    verbatim, wrapper included.
 *  - **setup** — `npm ci` / `npm install…`. Printed as `[skipped]` with the
 *    reason: a runner starts empty and this checkout does not, and re-running
 *    installs here would mutate the tree the run is measuring.
 *  - **unknown** — anything else (`./scripts/check.sh`, a step that calls some
 *    other tool). This is a **failure before anything runs**. A workflow step
 *    this script does not know whether to run is the one case where going on
 *    would produce a green line about a gate that was never run, which is the
 *    defect this repository has now named four times (`--steps 6` passing,
 *    `skipIf` guards, the backtick that killed the layout gate, the
 *    drift check that recorded itself).
 *
 * What a green run proves, and what it does not
 * ---------------------------------------------
 * It proves that the commands CI runs are green on *this* machine, and the
 * `--json` record says which commands, which exit codes, which HEAD. It does
 * not prove that a GitHub-hosted runner ran them: a different kernel, a
 * different Chromium sandbox story and a different npm are all outside a local
 * run. The record carries that sentence in its own `note` field so a reader
 * cannot mistake a transcript for a CI run; the value of the command is that
 * the transcript is *reproducible* — anybody can run it again and get the same
 * steps.
 *
 * Usage
 * -----
 *   node scripts/gate-local.mjs                # run every gate step
 *   node scripts/gate-local.mjs --list         # the plan, runs nothing
 *   node scripts/gate-local.mjs --only test    # one step, by the id --list shows
 *   node scripts/gate-local.mjs --json out.json    # also write the run record
 *
 * `--list` exists because "runs every gate step" is a sentence, not a list:
 * before a green/red run, a reader should be able to ask what *would* run and
 * see the exact commands, in order, without launching `npm test`. It is also
 * how this script is tested — the interesting assertions are about the plan
 * (does it read the workflow? does it notice a step it cannot classify?), and
 * they cost milliseconds instead of a full suite.
 *
 * `--only` takes the ids `--list` prints, not script names: the id for a
 * multi-command step (`npm run clean` then `npm run build:packages`) is
 * `clean+build:packages`, and printing it is how a reader learns that.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDirProblem, usableTempDir } from './temp-dir-probe.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

/** The repository root, so a copy of this script is a whole repository. */
export const REPO_ROOT = path.resolve(here, '..');

/**
 * Where CI is defined.
 *
 * The directory, not `ci.yml`: GitHub runs every workflow in here, and a
 * `release.yml` that adds a gate step is a gate step. Reading one path would
 * leave the next workflow's steps outside the local run while the documents
 * went on saying "CI equivalent".
 */
export const WORKFLOWS_DIR = '.github/workflows';

/** A file GitHub would run as a workflow. */
const WORKFLOW_FILE = /\.ya?ml$/u;

/**
 * The first line of a step list item, e.g. `      - name: Typecheck`.
 *
 * Only the keys a step is written with, so prose in a `with:` block cannot
 * start a fake step. A `# - run: …` comment does not match either: the `-` is
 * not at the start of the line's content after the space, and comments are
 * skipped anyway when the fields are read.
 */
const STEP_START = /^[ ]*-[ ]+(?=(?:name|run|uses|env|id|if|with|shell|timeout-minutes)[ ]*:)/u;

/** An `npm ci` / `npm install …` step: the runner's job, not the gate's. */
const SETUP_COMMAND = /^npm (?:ci|install)(?:\s|$)/u;

/**
 * An `xvfb-run` wrapper and its options, as CI writes it:
 *
 *     xvfb-run --auto-servernum --server-args="-screen 0 1920x1080x24" npm test
 *
 * Stripped only to *read* the command underneath (for its id). The command is
 * still run verbatim, wrapper included: running `npm test` without the display
 * would be a different measurement, and the screen size is part of what makes
 * the layout gate's numbers mean anything.
 */
const XVFB_WRAPPER = /^xvfb-run(?:\s+--[a-z][\w-]*(?:=(?:"[^"]*"|'[^']*'|\S+))?)*\s+/u;

/** Every workflow in `dir`, sorted by name, as `{ name, text }`. */
export function readWorkflows(dir) {
  if (!fs.existsSync(dir)) {
    throw new Error(
      `${dir} does not exist, so there is nothing to run: this script reads CI instead of ` +
        'carrying a copy of its commands. If the workflows moved, point WORKFLOWS_DIR at them.',
    );
  }
  const names = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && WORKFLOW_FILE.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  if (names.length === 0) {
    throw new Error(
      `no \`.yml\` / \`.yaml\` workflow in ${dir}. A local gate over an empty directory would ` +
        'report "every step green" having run none of them, which is the shape of a gate that ' +
        'stopped looking.',
    );
  }
  return names.map((name) => ({ name, text: fs.readFileSync(path.join(dir, name), 'utf8') }));
}

/** `package.json`'s scripts, i.e. what `npm run <name>` can accept here. */
export function declaredScripts(repoRoot = REPO_ROOT) {
  const manifest = path.join(repoRoot, 'package.json');
  if (!fs.existsSync(manifest)) {
    throw new Error(`${manifest} does not exist, so no \`npm run …\` step can be checked against it`);
  }
  const parsed = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  return parsed.scripts ?? {};
}

/** A YAML scalar with its quotes taken off; `'1'` is `1` for an env value. */
function unquote(value) {
  const trimmed = value.trim();
  const quoted = /^(['"])(.*)\1$/u.exec(trimmed);
  return quoted === null ? trimmed : quoted[2];
}

/** The leading spaces of a line. */
function indentOf(text) {
  return /^[ ]*/u.exec(text)[0].length;
}

/**
 * The keys of one step, each with the indented lines that belong to it.
 *
 * Not a YAML parser — it reads the two shapes a step's fields are written in:
 * an inline scalar (`name: Typecheck`, `run: npm run typecheck`) and a nested
 * block (`env:` or `run: |` followed by deeper lines). Everything else in a
 * step is ignored, because a local gate does not need `with:` or `if:` to run
 * the command.
 */
function stepFields(rawLines) {
  const fields = new Map();
  let current = null;
  for (const raw of rawLines) {
    // The list marker is replaced by its own width so the first line's keys sit
    // at the same column as the rest of the step's keys.
    const text = raw === rawLines[0] ? raw.replace(/^([ ]*)-[ ]+/u, '$1  ') : raw;
    if (text.trim() === '' || /^\s*#/u.test(text)) continue;
    const indent = indentOf(text);
    if (current !== null && indent > current.indent) {
      current.body.push(text.trim());
      continue;
    }
    const match = /^[ ]*([\w-]+):[ ]*(.*)$/u.exec(text);
    if (match === null) continue;
    current = { indent, value: unquote(match[2]), body: [] };
    fields.set(match[1], current);
  }
  return fields;
}

/** The environment a step declares, as `{ KEY: value }`. */
function stepEnv(fields) {
  const env = fields.get('env');
  if (env === undefined) return {};
  const declared = {};
  for (const line of env.body) {
    const match = /^([A-Za-z_][\w]*):[ ]*(.*)$/u.exec(line);
    if (match !== null) declared[match[1]] = unquote(match[2]);
  }
  return declared;
}

/** The command a step runs: an inline scalar, or a `|` / `>` block joined up. */
function stepCommand(fields) {
  const run = fields.get('run');
  if (run === undefined) return undefined;
  if (/^[|>][+-]?[0-9]*$/u.test(run.value)) {
    return run.body.length === 0 ? undefined : run.body.join('\n');
  }
  return run.value === '' ? undefined : run.value;
}

/**
 * Every step with a `run:` in one workflow, in file order.
 *
 * Steps without a `run:` (`uses:` actions) are absent: they are not commands,
 * and pretending otherwise would put "upload-artifact" in a list of gates. The
 * line numbers are 1-based and point at the list item, so a red run about an
 * unclassifiable step sends its reader to the step rather than to the file.
 */
export function workflowSteps(text, workflow) {
  const lines = text.split('\n');
  const blocks = [];
  let current = null;
  lines.forEach((line, index) => {
    if (STEP_START.test(line)) {
      current = { line: index + 1, lines: [line] };
      blocks.push(current);
      return;
    }
    if (current !== null) current.lines.push(line);
  });
  return blocks.flatMap((block) => {
    const fields = stepFields(block.lines);
    const command = stepCommand(fields);
    if (command === undefined) return [];
    const name = fields.get('name')?.value ?? '(unnamed step)';
    return [{ workflow, line: block.line, name, command, env: stepEnv(fields) }];
  });
}

/**
 * The script names an `npm` command runs, or `null` when it is not one of this
 * repository's own scripts.
 *
 * Two spellings: `npm run <name>` and `npm test`, the latter because that is
 * how the unit/contract suite is written in `ci.yml`. The `xvfb-run` wrapper is
 * transparent here — see {@link XVFB_WRAPPER} for why it is still executed.
 */
function scriptNames(command) {
  const bare = command.replace(XVFB_WRAPPER, '');
  if (/^npm test$/u.test(bare)) return ['test'];
  const match = /^npm run ([\w:.-]+)$/u.exec(bare);
  return match === null ? null : [match[1]];
}

/**
 * What one step is: `gate` (run it), `setup` (skip it, out loud), `unknown`
 * (refuse before running anything).
 *
 * `unknown` carries the reason as text, because the failure a reader gets has
 * to name the command and the two ways to fix it — an unclassifiable step is
 * either a new gate this script should run (one pattern) or a step that is not
 * a gate at all (a `[skipped]` entry with a reason). Silence is the third
 * answer, and it is the one that produces a green run over a gate nobody ran.
 */
export function classifyStep(step, scripts) {
  const commands = step.command
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  if (commands.length === 0) {
    return { kind: 'unknown', reason: 'the `run:` block is empty' };
  }
  if (commands.every((command) => SETUP_COMMAND.test(command))) {
    return { kind: 'setup' };
  }
  const names = commands.map(scriptNames);
  const missing = names.flatMap((entry, index) =>
    entry === null
      ? [`\`${commands[index]}\` is not an \`npm run <script>\` this script can check`]
      : entry
          .filter((name) => scripts[name] === undefined)
          .map((name) => `\`${commands[index]}\` runs \`${name}\`, which \`package.json\` does not declare`),
  );
  if (missing.length > 0) return { kind: 'unknown', reason: missing.join('; ') };
  return { kind: 'gate', id: names.flat().join('+') };
}

/**
 * The plan: every `run:` step of every workflow, classified and in CI's order.
 *
 * `workflows` is carried alongside so a failure can say which files were read —
 * a plan built from zero workflows and one where every step was recognised must
 * not look the same in a transcript.
 */
export function buildPlan(repoRoot = REPO_ROOT) {
  const workflows = readWorkflows(path.join(repoRoot, WORKFLOWS_DIR));
  const scripts = declaredScripts(repoRoot);
  const steps = workflows.flatMap((workflow) =>
    workflowSteps(workflow.text, workflow.name).map((step) => ({ ...step, ...classifyStep(step, scripts) })),
  );
  return { workflows: workflows.map((workflow) => workflow.name), steps };
}

/** The setup steps of a plan: printed as `[skipped]`, never silently dropped. */
export function setupSteps(plan) {
  return plan.steps.filter((step) => step.kind === 'setup');
}

/** The steps a run would execute, in CI's order. */
export function gateSteps(plan) {
  return plan.steps.filter((step) => step.kind === 'gate');
}

/**
 * Everything that makes a plan unrunnable, as lines.
 *
 * Returned rather than thrown so the caller can print all of them: two
 * unclassifiable steps are two fixes, and stopping at the first one makes a
 * reader run the command twice to learn the second.
 */
export function planProblems(plan) {
  return plan.steps
    .filter((step) => step.kind === 'unknown')
    .map((step) =>
      [
        `${step.workflow}:${step.line} runs a step this gate cannot classify: ${step.reason}.`,
        `  command: ${step.command.split('\n').join(' && ')}`,
        'This script runs the workflows instead of carrying a copy of their commands, so a step it ' +
          'does not recognise would either be skipped in silence or run with the wrong reading.',
        'Fix it one of two ways:',
          '  1. If it is a gate, write it as `npm run <script>` in the workflow, or teach ' +
          'classifyStep() about it and add a case to `tests/contract/ci-gate-local.test.ts`.',
          '  2. If it is setup (an install, a cache warm-up), extend SETUP_COMMAND or declare the ' +
          'step as `[skipped]` here with the reason it is not a gate.',
      ].join('\n'),
    );
}

/** The plan as lines a human reads before a run. */
export function planLines(plan) {
  const lines = [`[plan] ${plan.workflows.length} workflow(s): ${plan.workflows.join(', ')}`];
  for (const step of plan.steps) {
    if (step.kind === 'gate') {
      lines.push(
        `[run ] ${step.id.padEnd(20)} ${step.workflow}:${step.line}  ` +
          `${step.command.split('\n').join(' && ')}`,
      );
    } else if (step.kind === 'setup') {
      lines.push(
        `[skip] ${'setup'.padEnd(20)} ${step.workflow}:${step.line}  ` +
          `${step.command.split('\n').join(' && ')}`,
      );
    } else {
      lines.push(
        `[????] ${'(unclassified)'.padEnd(20)} ${step.workflow}:${step.line}  ${step.reason}`,
      );
    }
  }
  const envs = plan.steps.filter((step) => Object.keys(step.env).length > 0);
  for (const step of envs) {
    const pairs = Object.entries(step.env).map(([key, value]) => `${key}=${value}`);
    lines.push(`[env ] ${step.id ?? step.name}: ${pairs.join(' ')}`);
  }
  lines.push(
    `[plan] ${gateSteps(plan).length} gate step(s), ${setupSteps(plan).length} setup step(s) ` +
      'not re-run here',
  );
  return lines;
}

/** Seconds with one decimal, for the per-step line. */
function seconds(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * The summary a run ends with.
 *
 * Three words rather than two: `PASS`, `FAIL`, and the count of steps that did
 * not run. A transcript that prints `PASS` after a breaker stopped the run early
 * reads exactly like a full run — `verify-release-feed.mjs` had the same defect
 * and now prints `[skipped]` plus a count.
 */
export function summaryLine(results, notRun) {
  const failed = results.filter((result) => result.exitCode !== 0);
  if (failed.length > 0) {
    const notRunNote =
      notRun.length === 0 ? '' : `; ${notRun.length} step(s) did not run after it`;
    return (
      `FAIL — step(s) ${failed.map((result) => result.id).join(', ')} exited ` +
      `${failed.map((result) => result.exitCode).join(', ')}${notRunNote}`
    );
  }
  const total = `${results.length} gate step(s) green`;
  const skipped = notRun.length === 0 ? '' : `, ${notRun.length} not run`;
  return `PASS — ${total}${skipped} on ${process.platform} with node ${process.version}`;
}

/**
 * Runs one step the way a GitHub `run:` step is run: `bash -eo pipefail`, with
 * the step's own `env:` merged over this process's environment, in the
 * repository root, with the transcript going straight to the terminal.
 */
function runStep(step, cwd) {
  const startedAt = Date.now();
  const outcome = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', step.command], {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, ...step.env },
  });
  const durationMs = Date.now() - startedAt;
  if (outcome.error !== undefined) {
    console.error(`[FAIL] ${step.id}: could not start \`bash\`: ${outcome.error.message}`);
    return { exitCode: 1, durationMs };
  }
  return { exitCode: outcome.status ?? 1, durationMs };
}

/** Best-effort HEAD, so a record says which tree it is about without failing on a non-repo. */
function headSha(cwd) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

const USAGE =
  'usage: node scripts/gate-local.mjs [--list] [--only <id[,id]>] [--json <path>]';

/**
 * The flags this script understands.
 *
 * An unrecognised flag is an error, not a default: `--lst` silently running the
 * whole gate, or `--only test:e2ee` silently running everything, is the class
 * of defect this repository keeps naming (`--steps 6`, `--no-installers`,
 * `--requires`). Same reading as `verify-release-feed.mjs` and
 * `verify-packaged-adapters.mjs`.
 */
export function parseArgv(argv) {
  const parsed = { list: false, only: [], json: null, unknown: [], missingValue: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--list') {
      parsed.list = true;
    } else if (arg === '--only' || arg === '--json') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        parsed.missingValue.push(arg);
        continue;
      }
      index += 1;
      if (arg === '--json') parsed.json = value;
      else parsed.only.push(...value.split(',').map((id) => id.trim()).filter((id) => id !== ''));
    } else {
      parsed.unknown.push(arg);
    }
  }
  return parsed;
}

/** The record `--json` writes. */
function buildRecord({ plan, selected, results, notRun, startedAt, cwd }) {
  return {
    note:
      'This file records which commands this machine ran, in what order, and how they exited. ' +
      'It is not a CI run: CI is a GitHub-hosted job, and this is the same `run:` steps from ' +
      '.github/workflows/ executed locally with the same shell flags and env. A different kernel, ' +
      'sandbox story and npm are outside it. Re-running `node scripts/gate-local.mjs --json …` ' +
      'is how this file is checked.',
    head: headSha(cwd),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    startedAt,
    finishedAt: new Date().toISOString(),
    workflows: plan.workflows,
    verdict: results.some((result) => result.exitCode !== 0) ? 'fail' : 'pass',
    steps: results.map((result) => ({
      id: result.id,
      command: result.command,
      workflow: result.workflow,
      line: result.line,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      status: result.exitCode === 0 ? 'pass' : 'fail',
    })),
    notRun: notRun.map((step) => step.id),
    notRunHere: setupSteps(plan).map((step) => ({ command: step.command, why: 'setup step' })),
    unselected: gateSteps(plan)
      .filter((step) => !selected.includes(step))
      .map((step) => step.id),
  };
}

function main(argv) {
  const args = parseArgv(argv);
  if (args.unknown.length > 0) {
    console.error(`unknown option(s): ${args.unknown.join(', ')}`);
    console.error(USAGE);
    return 1;
  }
  if (args.missingValue.length > 0) {
    console.error(`option(s) that need a value: ${args.missingValue.join(', ')}`);
    console.error(USAGE);
    return 1;
  }

  let plan;
  try {
    plan = buildPlan();
  } catch (error) {
    console.error(`could not read the workflows: ${error.message}`);
    return 1;
  }

  const problems = planProblems(plan);
  if (problems.length > 0) {
    for (const problem of problems) console.error(`[refused] ${problem}`);
    console.error(
      `REFUSED — ${problems.length} workflow step(s) this gate cannot classify. Nothing was run.`,
    );
    return 1;
  }

  const gates = gateSteps(plan);
  const selected =
    args.only.length === 0 ? gates : gates.filter((step) => args.only.includes(step.id));
  if (args.only.length > 0) {
    const unknownIds = args.only.filter((id) => !gates.some((step) => step.id === id));
    if (unknownIds.length > 0) {
      console.error(
        `unknown step id(s): ${unknownIds.join(', ')}; this plan has ` +
          `${gates.map((step) => step.id).join(', ')}`,
      );
      console.error(USAGE);
      return 1;
    }
  }

  const startedAt = new Date().toISOString();
  for (const line of planLines(plan)) console.log(line);

  if (args.list) {
    if (args.json !== null) {
      fs.writeFileSync(
        args.json,
        `${JSON.stringify(
          {
            note: 'The plan `node scripts/gate-local.mjs --list` printed. Nothing in this file was run.',
            workflows: plan.workflows,
            steps: plan.steps.map((step) => ({
              id: step.id ?? null,
              kind: step.kind,
              name: step.name,
              workflow: step.workflow,
              line: step.line,
              command: step.command,
              env: step.env,
            })),
          },
          null,
          2,
        )}\n`,
        'utf8',
      );
      console.log(`[plan] written to ${args.json}`);
    }
    console.log(`PASS — listed ${gates.length} gate step(s); nothing was run`);
    return 0;
  }

  if (selected.length === 0) {
    console.error('no gate step was selected, so there is nothing to run and nothing to prove');
    return 1;
  }

  /*
   * The machine is checked before the tree is judged.
   *
   * `npm test` creates its throwaway trees under `os.tmpdir()`, so a temp
   * directory without headroom turns dozens of unrelated files red over an
   * errno that names no directory and no fix. Refusing here costs one 1 MiB
   * allocation; running anyway costs a red gate that reads like a product
   * defect, which is the failure this repository has named repeatedly — a
   * verdict about something that was never actually measured.
   */
  const tempProblem = tempDirProblem();
  if (tempProblem !== null) {
    const usable = usableTempDir();
    console.error(`[refused] ${tempProblem}`);
    console.error(
      usable === null
        ? 'REFUSED — no fallback directory took the same write either, so nothing ran and ' +
          'nothing is proven. Free space or raise the quota on the filesystem behind ' +
          'os.tmpdir(), then re-run.'
        : `REFUSED — nothing ran and nothing is proven. Re-run against a directory that ` +
          `passed the same write: TMPDIR=${usable} node scripts/gate-local.mjs`,
    );
    return 1;
  }

  const results = [];
  for (const step of selected) {
    console.log(
      `[run ] ${step.id} — ${step.command.split('\n').join(' && ')} (${step.workflow}:${step.line})`,
    );
    const outcome = runStep(step, REPO_ROOT);
    results.push({ ...step, ...outcome });
    if (outcome.exitCode === 0) {
      console.log(`[ok  ] ${step.id} (${seconds(outcome.durationMs)})`);
      continue;
    }
    console.error(`[FAIL] ${step.id} exited ${outcome.exitCode} (${seconds(outcome.durationMs)})`);
    break;
  }
  const notRun = selected.slice(results.length);
  for (const step of notRun) console.error(`[skipped] ${step.id} — not run: an earlier step failed`);

  if (args.json !== null) {
    fs.writeFileSync(
      args.json,
      `${JSON.stringify(
        buildRecord({ plan, selected, results, notRun, startedAt, cwd: REPO_ROOT }),
        null,
        2,
      )}\n`,
      'utf8',
    );
    console.log(`[record] written to ${args.json}`);
  }

  const summary = summaryLine(results, notRun);
  if (results.some((result) => result.exitCode !== 0)) {
    console.error(summary);
    return 1;
  }
  console.log(summary);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
