/**
 * The full suite, run with its temporary files inside this checkout.
 *
 * Why this file exists
 * --------------------
 * `npm test` is `vitest run`, and the contract tests create their scratch
 * directories with `mkdtemp(join(tmpdir(), 'ucad-…'))` — that is, under `/tmp`.
 * On the machine this repository is developed on, `/tmp` is a tmpfs with a
 * per-user quota (`mount` says `usrquota`), and the quota is exhausted by
 * leftovers from earlier runs: writes fail with `EDQUOT`, which Node reports as
 * `Unknown system error -122`, and 77 of 108 test files go red for a reason
 * that has nothing to do with the code under test. Three commit messages in a
 * row said so in a sentence ("the local run fails on /tmp, unrelated to this
 * change"), and a sentence repeated three times is a sentence nobody reads.
 *
 * So the workaround is a command instead of a disclaimer: this script points
 * `TMPDIR` / `TEMP` / `TMP` at `.tmp/` inside the repository, runs the same
 * `vitest run` the `test` script runs, and deletes the directory afterwards.
 * The constraint itself, with the measurements that produced it, is written
 * down in `docs/blockers.md` under 「本机全量测试的已知环境约束」, and
 * `tests/contract/local-test-env.test.ts` pins that the command named there is
 * this one — a documented workaround that is not in `package.json` is a
 * workaround nobody can run.
 *
 * What it does not change
 * -----------------------
 * Nothing about the suite: same config, same files, same reporter, same exit
 * code. `npm test` stays the command CI runs, because a GitHub runner's `/tmp`
 * is not this machine's `/tmp`, and a gate that only passes with a relocated
 * temp directory would be measuring the workaround rather than the product.
 * This script is for the machine that needs it, and it says which directory it
 * used on every run so a transcript cannot be mistaken for a plain `npm test`.
 *
 * Usage
 * -----
 *   npm run test:local                     # the whole suite, temp files in .tmp/
 *   npm run test:local -- tests/contract   # arguments go to vitest unchanged
 *   node scripts/test-local.mjs --keep     # leave .tmp/ behind for inspection
 *   node scripts/test-local.mjs --dry-run  # print the environment, run nothing
 *
 * `--dry-run` exists for the contract gate: it is how a test can assert where
 * the temp directory would be without paying for a full suite.
 *
 * One fact, not two
 * -----------------
 * The directory name is exported as {@link TEMP_DIR_ENTRY} and printed by
 * `--dry-run`, because the same string has to appear in `.gitignore` — a
 * scratch tree the checkout would commit is the failure this script would
 * otherwise introduce. Two copies of `.tmp/` (one here, one in the ignore file)
 * can each be right and still name different directories, and both would look
 * green. `tests/contract/local-test-env.test.ts` imports this constant and
 * compares it with the ignore file, so the two cannot drift apart quietly.
 *
 * The module therefore only runs when it is the entry point: importing it for
 * the constant must not start a test run.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, '..');

/** The scratch directory, as `.gitignore` spells it. Exported: one fact, two readers. */
export const TEMP_DIR_ENTRY = '.tmp/';

/** Where the suite's scratch files go: inside the checkout, never `/tmp`. */
const TEMP_DIR = path.join(REPO_ROOT, TEMP_DIR_ENTRY);

/** The vitest CLI this repository installs, run through the current Node. */
const VITEST_CLI = path.join(REPO_ROOT, 'node_modules', 'vitest', 'vitest.mjs');

/** The three variables Node, npm and vitest read for "where is temp". */
const TEMP_VARS = ['TMPDIR', 'TEMP', 'TMP'];

function parseArgs(argv) {
  const options = { keep: false, dryRun: false, vitestArgs: [] };
  for (const arg of argv) {
    if (arg === '--keep') options.keep = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else options.vitestArgs.push(arg);
  }
  return options;
}

/**
 * The environment the suite runs in: this process's, with the three temp
 * variables replaced.
 *
 * Replaced rather than added, because `TMPDIR` set beside an inherited `TEMP`
 * leaves the choice to whichever library reads which name first — and the
 * failure this script exists for is exactly a library picking `/tmp`.
 */
function tempEnv(base, dir) {
  const env = { ...base };
  for (const name of TEMP_VARS) env[name] = dir;
  return env;
}

/**
 * Create the temp directory and prove it accepts a write.
 *
 * The probe is the point: on the machine this script was written for, the
 * directory can be created and still refuse a write, and a run that fails 77
 * files later with `Unknown system error -122` is the failure this script is
 * supposed to end. A refusal here names the directory and the errno instead.
 */
function prepareTempDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const probe = path.join(dir, '.write-probe');
  try {
    fs.writeFileSync(probe, 'ok');
    fs.rmSync(probe, { force: true });
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : 'unknown';
    console.error(`FAIL — ${dir} does not accept a write (${code})`);
    console.error(
      'This script exists because /tmp on some machines is a quota-limited tmpfs; ' +
        'if this directory is also full, free space under the checkout and run again.',
    );
    process.exit(1);
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const env = tempEnv(process.env, TEMP_DIR);

  if (options.dryRun) {
    console.log(`temp dir: ${TEMP_DIR}`);
    console.log(`temp-dir-entry: ${TEMP_DIR_ENTRY}`);
    for (const name of TEMP_VARS) console.log(`${name}=${env[name]}`);
    console.log(`vitest: run ${options.vitestArgs.join(' ')}`.trimEnd());
    return 0;
  }

  if (!fs.existsSync(VITEST_CLI)) {
    console.error(`FAIL — ${VITEST_CLI} is missing; run \`npm ci\` first`);
    return 1;
  }

  prepareTempDir(TEMP_DIR);
  console.log(`temp dir: ${TEMP_DIR} (TMPDIR/TEMP/TMP)`);

  const result = spawnSync(process.execPath, [VITEST_CLI, 'run', ...options.vitestArgs], {
    cwd: REPO_ROOT,
    env,
    stdio: 'inherit',
  });

  if (!options.keep) fs.rmSync(TEMP_DIR, { recursive: true, force: true });
  else console.log(`kept: ${TEMP_DIR}`);

  if (result.error) {
    console.error(`FAIL — could not start vitest: ${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
}

// Only when this file is the entry point: the contract gate imports
// `TEMP_DIR_ENTRY` from here, and an import must not start a suite.
const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) process.exit(main());
