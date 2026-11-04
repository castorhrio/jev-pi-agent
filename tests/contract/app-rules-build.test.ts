/**
 * The suite's build precondition is wired, holds, and says so when it does not.
 *
 * ## Why this file exists
 *
 * Several contract files judge a published update feed with the rules the shipped
 * app runs — `checkChannelUrl` / `normalizeSha256`, loaded from
 * `apps/desktop/dist/main/update-feed.js` by `verify-release-feed.mjs`. Importing
 * the app's own judgement is the right design (a second copy of a security rule
 * drifts, and each copy passes the tests written for it), but it makes build
 * output part of what is under test, and then "did the suite prove anything"
 * depends on whatever the last person to touch the checkout happened to run.
 *
 * The four answers to that question were the defect: one file asserted the build
 * refusal instead of judging, two asserted the refusal *and* judged less, and
 * `release-gate-simulation.test.ts` returned before its first assertion three
 * times over — a green that proves nothing, which is the shape this repository
 * has removed from `verify-main-chain.mjs`'s `--steps`, from the `skipIf` guards
 * in `readme*.test.ts`, and from the screenshot manifest's failure path.
 *
 * Now `vitest.config.ts` names `tests/global-setup.ts`, which builds the rules
 * once before any test file loads, and the files that need them simply require
 * them. This file is what keeps that from rotting in the three ways it can:
 *
 *  - **un-wired** — the config stops naming the setup, or the setup stops calling
 *    the builder, and every consumer quietly reverts to judging nothing;
 *  - **renamed** — the app moves the module, or the build script is renamed, and
 *    the setup runs a command that does not exist or writes a file nobody reads;
 *  - **unreadable** — the failure a fresh clone sees turns into a stack trace, so
 *    the person who hit it cannot tell what to run.
 *
 * ## What it cannot assert
 *
 * That the built module is *current*. `tsc -b` decides from its own
 * `.tsbuildinfo`, and `mtime` is not evidence in a git tree — `git checkout`
 * stamps every file with the checkout time, the same reason
 * `screenshot-sources.test.ts` refuses to compare times. Freshness stays
 * `pretest`'s and CI's job; this guarantees presence, which is the half that was
 * being silently skipped.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { loadAppRules, APP_RULES_MODULE } from '../../scripts/verify-release-feed.mjs';
import {
  APP_RULES_BUILD,
  APP_RULES_BUILD_COMMAND,
  APP_RULES_BUILD_SCRIPTS,
  appRulesMissing,
} from './app-rules-build';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const VITEST_CONFIG = join(REPO_ROOT, 'vitest.config.ts');
const GLOBAL_SETUP = join(REPO_ROOT, 'tests', 'global-setup.ts');
const VERIFIER = join(REPO_ROOT, 'scripts', 'verify-release-feed.mjs');

const read = (path: string): string => readFileSync(path, 'utf8');

interface Manifest {
  name?: string;
  scripts?: Record<string, string>;
}

const ROOT_MANIFEST = JSON.parse(read(join(REPO_ROOT, 'package.json'))) as Manifest;
const DESKTOP_MANIFEST = JSON.parse(
  read(join(REPO_ROOT, 'apps', 'desktop', 'package.json')),
) as Manifest;

/**
 * The package a `npm run <script>` argument list targets, and its manifest.
 *
 * `-w <name>` is how this repository addresses one workspace from another, so
 * the split here is the one an operator already types. `null` when the argument
 * list is not an `npm run` at all, or names a workspace nobody declared — the
 * case below reports those rather than skipping them.
 */
function workspaceOf(args: readonly string[]): { label: string; manifest: Manifest } | null {
  if (args[0] !== 'run') return null;
  const at = args.indexOf('-w');
  if (at === -1) return { label: 'the root workspace', manifest: ROOT_MANIFEST };
  const name = args[at + 1];
  return name === DESKTOP_MANIFEST.name
    ? { label: `the ${name} workspace`, manifest: DESKTOP_MANIFEST }
    : null;
}

describe('the app’s feed rules are built before the suite judges anything', () => {
  it('is registered as the unit config’s global setup', () => {
    // The mechanism the four branches were replaced with. If the config stops
    // naming the setup, the judging files do not go quiet — they go red — but
    // they go red one assertion at a time, and the one file that could say "the
    // suite's precondition is missing" would say nothing.
    const config = read(VITEST_CONFIG);

    expect(config).toContain('globalSetup');
    expect(config, 'the global setup must be the file that builds the rules').toContain(
      'tests/global-setup.ts',
    );
  });

  it('is called by that setup, rather than mentioned next to it', () => {
    const setup = read(GLOBAL_SETUP);

    expect(existsSync(GLOBAL_SETUP), 'tests/global-setup.ts is missing').toBe(true);
    expect(setup).toContain('ensureAppRulesBuilt');
    // A setup that imports the builder and never calls it registers a green no-op
    // in the config — the same defect from the other side.
    expect(setup).toContain('ensureAppRulesBuilt()');
  });

  it('builds the module the verifier actually imports, not a copy of the path', () => {
    // Two spellings of one fact: `verify-release-feed.mjs` resolves its import
    // relative to itself, this file builds an absolute path. If the app moves the
    // module, the setup would keep building a file nothing reads — and every
    // consumer would keep finding the rules *missing*, which is at least honest.
    const expected = resolve(dirname(VERIFIER), APP_RULES_MODULE);

    expect(APP_RULES_BUILD).toBe(expected);
  });

  it('runs scripts this repository declares, so a rename is reported', () => {
    // `npm run <name>` succeeds noisily and fails quietly: an un-declared name
    // exits 1 with a table of suggestions, which the setup reports as a build
    // failure — true, but the wrong sentence. So the names are checked here,
    // against the manifests, rather than trusted.
    for (const args of APP_RULES_BUILD_SCRIPTS) {
      const workspace = workspaceOf(args);
      expect(workspace, `not an \`npm run\` argument list: ${args.join(' ')}`).not.toBeNull();

      const script = args[1]!;
      const declared = workspace!.manifest.scripts ?? {};
      expect(
        Object.hasOwn(declared, script),
        `\`npm ${args.join(' ')}\` names ${script}, which ${workspace!.label} does not declare`,
      ).toBe(true);
    }
  });

  it('holds: the app’s rules load, and carry the two judgements', async () => {
    // The runtime half. Everything above reads text; this asks the same question
    // the judging files ask, so if the setup stops producing the module the red
    // lands here, in one place, with the command to run.
    const missing = appRulesMissing();
    expect(missing, missing ?? '').toBeNull();

    const rules = await loadAppRules();
    expect(typeof rules.checkChannelUrl).toBe('function');
    expect(typeof rules.normalizeSha256).toBe('function');
  });

  it('names the command to run when the rules are not there', () => {
    // The sentence a fresh clone sees has to be reachable by a test, or it can
    // say anything at all. Driving it with a path that cannot exist is how, and
    // it is also the check that the wording still matches the refusal
    // `verify-release-feed.mjs` prints for the same missing file.
    const absent = join(REPO_ROOT, 'apps', 'desktop', 'dist', 'main', 'no-such-module.js');
    const message = appRulesMissing(absent);

    expect(message).not.toBeNull();
    expect(message!).toContain(APP_RULES_BUILD_COMMAND);
    expect(message!, 'the message must name the file, not just a command').toContain(
      'update-feed.js',
    );
    expect(message!).toContain('global-setup');
  });

  it('has already produced the module, which is what lets the setup skip', () => {
    // The skip branch is what keeps a warm checkout paying nothing, and it is
    // also the branch that would silently *stop* running the build if the probe
    // path ever disagreed with {@link APP_RULES_BUILD}. Asserted, not assumed.
    expect(appRulesMissing()).toBeNull();
    expect(existsSync(APP_RULES_BUILD), 'the suite’s own precondition is not holding').toBe(true);
  });
});
