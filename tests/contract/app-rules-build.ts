/**
 * The app's own feed rules, as a precondition of the suite instead of a coin flip.
 *
 * ## Why this file exists
 *
 * Five contract files judge a published update feed with the rules the shipped
 * app actually runs — `checkChannelUrl` / `normalizeSha256`, imported from
 * `apps/desktop/dist/main/update-feed.js` — rather than restating them. That is
 * the right design (a second copy of a security rule drifts, and each copy
 * passes the tests written for it), but it means what is under test is *build
 * output*, and whether that output exists depends on whatever the last person to
 * touch the checkout happened to run: `npm run typecheck` and `npm run build`
 * produce it, `npm test` does not (`pretest` builds the packages only), and a
 * fresh clone has never had it.
 *
 * Four files answered that question four different ways, and the weakest answer
 * was `if (!RULES_BUILT) return;` — a case that passes by doing nothing. That is
 * the shape this repository has now removed a handful of times (`--steps 6`
 * ending in PASS, the `skipIf` guards in `readme*.test.ts`, the screenshot
 * manifest whose failure path no test drove), and it is why "the contract tests
 * are green" had a meaning that varied by machine.
 *
 * ## What this file does
 *
 * {@link ensureAppRulesBuilt} runs the two declared scripts that produce the
 * module, and only when it is missing. It is called from `tests/global-setup.ts`,
 * which `vitest.config.ts` registers as `globalSetup` — once, in the parent
 * process, before any test file is loaded.
 *
 * The single owner matters as much as the build. Doing this in a test file's
 * `beforeAll` would rebuild the same output from four files at once
 * (`pool: 'forks'` starts them in parallel), so the three that only import the
 * rules would judge a `dist` while it is being written: a red that describes the
 * build order rather than the release.
 *
 * {@link appRulesMissing} is the same question asked from inside a test, and it
 * returns the sentence to fail with rather than a boolean, because the point of
 * the guard is that a suite whose precondition stopped holding says what to run.
 *
 * ## What is deliberately not here
 *
 * No freshness check. `mtime` is not evidence in this repository: `git checkout`
 * stamps every file with the checkout time, so "newer than the source" is true
 * for everything or nothing (`screenshot-sources.test.ts` makes the same
 * argument about a manifest). Whether a stale `dist` should be rebuilt stays
 * `pretest`'s and CI's business; this file guarantees only that the module the
 * suite imports exists before any of it runs.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dirname, '..', '..');

/** {@link APP_RULES_BUILD} as a reader types it, for failure messages. */
const APP_RULES_RELATIVE = join('apps', 'desktop', 'dist', 'main', 'update-feed.js');

/** The built module the feed judgements import: `apps/desktop`'s `tsc` output. */
export const APP_RULES_BUILD = join(REPO_ROOT, APP_RULES_RELATIVE);

/**
 * The command that produces it, in the words `verify-release-feed.mjs` uses when
 * it refuses for want of the same file. One sentence, two places, no drift.
 */
export const APP_RULES_BUILD_COMMAND = 'npm run build:main -w @ucad/desktop';

/** Builds every package's declarations, which is what `apps/desktop` compiles against. */
const BUILD_PACKAGES = ['run', 'build:packages', '--', '--force'];

/** Builds the app's own feed rules: the module this file is about. */
const BUILD_MAIN = ['run', 'build:main', '-w', '@ucad/desktop', '--', '--force'];

/**
 * The scripts that produce {@link APP_RULES_BUILD}, in build order.
 *
 * Named as `npm run` arguments rather than spelled out as `tsc` invocations: the
 * scripts are the fact. A copy of a build command is a second place to update,
 * and the second place is the one that gets missed. `build:packages` comes first
 * because `apps/desktop` imports `@ucad/*` from a package's `dist` directory, so
 * building main alone in a fresh clone fails on a missing module — the wrong
 * diagnosis for a missing build.
 *
 * Both run with `--force`, and that is not caution: `tsc -b` decides what to
 * write from its `.tsbuildinfo`, not from what is on disk. Measured here — with
 * `update-feed.js` removed, `npm run build:main -w @ucad/desktop` printed
 * nothing, exited 0, and left the file missing. A build that cannot notice the
 * output it was asked to produce would put the silent skip back, one level down.
 *
 * Which of the two a given checkout needs is decided by
 * {@link PACKAGE_DECLARATIONS}; what must never change is that both are declared
 * scripts of this repository, spelled the way an operator would spell them.
 */
export const APP_RULES_BUILD_SCRIPTS: readonly string[][] = [BUILD_PACKAGES, BUILD_MAIN];

/**
 * A package declaration file, as a stand-in for "the packages are built".
 *
 * `@ucad/contracts` is the leaf every package and the desktop app imports, and
 * `build:packages` is one `tsc --build` over the whole graph, so either the
 * declarations are there or the build has not run. Checking it is worth the
 * indirection because `npm test` has just run `build:packages` in `pretest`:
 * forcing it again would rebuild twenty-one projects to produce nothing new, and
 * the one thing a suite precondition must not be is slow on a warm checkout.
 */
const PACKAGE_DECLARATIONS = join(REPO_ROOT, 'packages', 'contracts', 'dist', 'index.d.ts');

/**
 * `npm` as a program. `execFileSync` does not resolve `npm.cmd`, which is the
 * spelling Windows has, and the release this repository ships is a Windows one.
 */
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

/** Both streams of a failed child process, as one readable block. */
function childOutput(error: unknown): string {
  const failure = error as { stdout?: string; stderr?: string; message?: string };
  return [failure.stdout, failure.stderr]
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    .join('\n')
    .trim();
}

/**
 * Builds the app's feed rules when they are not there, and says what failed.
 *
 * Returns without touching the disk when the module already exists, so a warm
 * checkout pays nothing. Throws otherwise: the caller is a global setup, and a
 * setup that throws ends the run with a non-zero exit — which is the whole
 * difference from the branch this replaced.
 */
export function ensureAppRulesBuilt(): void {
  if (existsSync(APP_RULES_BUILD)) return;

  const scripts = existsSync(PACKAGE_DECLARATIONS) ? [BUILD_MAIN] : [BUILD_PACKAGES, BUILD_MAIN];

  for (const args of scripts) {
    try {
      execFileSync(NPM, args, {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      const detail = childOutput(error) || (error instanceof Error ? error.message : String(error));
      throw new Error(
        `\`npm ${args.join(' ')}\` could not build the app’s feed rules, so the contract tests ` +
          `that judge a published feed have nothing to judge with.\n` +
          `Missing: ${APP_RULES_RELATIVE}\n\n${detail}`,
      );
    }
  }

  if (!existsSync(APP_RULES_BUILD)) {
    throw new Error(
      `\`npm ${BUILD_MAIN.join(' ')}\` reported success, but ` +
        `${APP_RULES_RELATIVE} is still missing: the build no longer writes the module the ` +
        'contract tests import, so the import path and the build output have diverged.',
    );
  }
}

/**
 * Why the rules cannot be imported right now, or `null` when they can.
 *
 * `rulesPath` is a parameter for the same reason the sentence is a return value:
 * the message a fresh clone sees has to be reachable by a test, and the only
 * other way to reach it is to delete build output from a running suite.
 */
export function appRulesMissing(rulesPath: string = APP_RULES_BUILD): string | null {
  if (existsSync(rulesPath)) return null;
  return (
    `the app's feed rules are not built (${APP_RULES_RELATIVE}), so a judgement below would be ` +
    `comparing nothing. \`tests/global-setup.ts\` builds them before any test file loads; if you ` +
    `reached this by running vitest with another config, run \`${APP_RULES_BUILD_COMMAND}\` first.`
  );
}
