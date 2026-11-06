/**
 * The three manifests that describe the packaged app are one fact, not three.
 *
 * ## The defect this closes
 *
 * `db9b379` fixed a shipped build that died on `Cannot find module '@ucad/usage'`
 * by adding three packages to the **root** `package.json` — the manifest
 * `electron-builder` reads. That left `npm run knip` red, and `a1ad2cd` fixed
 * that by adding the same three to `knip.json`'s `ignoreDependencies`. Both
 * commits were right, and both were repairs: the same fact lived in three files
 * (`apps/desktop/package.json`, the root `package.json`, `knip.json`), and each
 * round edited the two files the previous round had not touched.
 *
 * `desktop-runtime-deps.test.ts` and `package-manifest.test.ts` compare pairs of
 * those files, so a missing entry is caught — but only after someone has already
 * written the wrong pair, and neither of them says *which* value is the right
 * one. `scripts/package-manifests.mjs` does: the root `@ucad/*` section and
 * knip's ignore list are **derived** from `apps/desktop/package.json` plus the
 * two source trees, and this file asserts the files on disk are what the
 * derivation produces.
 *
 * ## What "single source" is asserted to mean
 *
 *  - the derivation reproduces the tree as it stands (so the gate is not a
 *    description of a tree that does not exist);
 *  - `--write` is a **no-op** on that tree, byte for byte — the files are
 *    generated, not hand-maintained, and a hand edit that happens to be
 *    semantically equal but formatted differently is still a red gate telling
 *    its reader to run the generator;
 *  - every way the three can disagree is driven from a **mutated copy** of the
 *    real snapshot, so each failure is shown rather than argued about;
 *  - the one edit the brief for this round names — *change one manifest, the
 *    other two go red* — is the case `a new @ucad dependency in the shell’s
 *    manifest alone`.
 *
 * ## What it deliberately does not check
 *
 * That the archive boots. A consistent manifest can still be missing a package
 * the source requires in a way no `from` clause shows; that half is the scan in
 * `desktop-runtime-deps.test.ts`, and the half after it is
 * `scripts/verify-packaged-adapters.mjs`, which needs a packaged build and a
 * Windows machine. This file is about the three files agreeing, and it says so
 * here rather than in a commit message.
 */

import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  DESKTOP_MANIFEST_PATH,
  KNIP_CONFIG_PATH,
  REPO_ROOT,
  ROOT_MANIFEST_PATH,
  UCAD_SCOPE,
  deriveKnipIgnores,
  deriveRootUcadSection,
  derivedFiles,
  manifestDrift,
  readSnapshot,
} from '../../scripts/package-manifests.mjs';

const SNAPSHOT = readSnapshot(REPO_ROOT);

/** The real snapshot with one part replaced, so a red direction needs no edit. */
function mutate(overrides: Record<string, unknown>) {
  return { ...SNAPSHOT, ...overrides };
}

/** The root manifest with its `@ucad/*` dependencies replaced by `dependencies`. */
function withRootDependencies(dependencies: Record<string, string>) {
  return mutate({ root: { ...SNAPSHOT.root, dependencies } });
}

/** The shell's manifest with one extra `@ucad/*` dependency. */
function withDesktopDependency(name: string, version = SNAPSHOT.root.version) {
  return mutate({
    desktop: {
      ...SNAPSHOT.desktop,
      dependencies: { ...SNAPSHOT.desktop.dependencies, [name]: version },
    },
  });
}

/** `knip.json` with its ignore list replaced. */
function withKnipIgnores(ignoreDependencies: string[]) {
  return mutate({ knip: { ...SNAPSHOT.knip, ignoreDependencies } });
}

const DERIVED_SECTION = deriveRootUcadSection({
  desktop: SNAPSHOT.desktop,
  version: SNAPSHOT.root.version,
});
const DERIVED_IGNORES = deriveKnipIgnores({
  desktop: SNAPSHOT.desktop,
  rootSourceText: SNAPSHOT.rootSourceText,
  desktopSourceText: SNAPSHOT.desktopSourceText,
});

describe('the derivation reads the tree it claims to read', () => {
  it('finds the shell’s runtime graph, both source trees and the package directories', () => {
    // Before any comparison: a derivation over an empty manifest and an empty
    // source tree produces two empty sets, and every case below would pass over
    // them. The counts are the proof that it looked.
    expect(Object.keys(DERIVED_SECTION).length, 'no @ucad dependency derived').toBeGreaterThan(5);
    expect(DERIVED_IGNORES.length, 'no knip ignore derived').toBeGreaterThan(0);
    expect(SNAPSHOT.rootSourceText.length, 'the root source tree read as empty').toBeGreaterThan(
      10_000,
    );
    expect(
      SNAPSHOT.desktopSourceText.length,
      'the shell’s source tree read as empty',
    ).toBeGreaterThan(10_000);
    expect(SNAPSHOT.packageDirs.size, 'no package directory found').toBeGreaterThan(5);
  });

  it('derives the package the shipped build died on', () => {
    // `db9b379` is the reason this file exists; a derivation that does not
    // produce `@ucad/usage` would be measuring a different question.
    expect(DERIVED_SECTION).toHaveProperty(['@ucad/usage']);
    expect(DERIVED_IGNORES).toContain('@ucad/usage');
  });

  it('derives the two adapters knip cannot see because they are required by name', () => {
    // `adapter-candidates.ts` requires them by name, so no `from` clause names
    // them and knip reports them as unused in `apps/desktop`. If this ever
    // stops being true, the ignore list should shrink — and this case says so.
    expect(DERIVED_IGNORES).toContain('@ucad/adapter-mock');
    expect(DERIVED_IGNORES).toContain('@ucad/adapter-universal');
  });
});

describe('the three manifests on disk are what the derivation produces', () => {
  it('finds no disagreement', () => {
    expect(manifestDrift(SNAPSHOT)).toEqual([]);
  });

  it('is already what `--write` would write, byte for byte', () => {
    // The files are generated. A hand edit that is semantically equal but
    // formatted differently is still a red gate: it means the next person to
    // run the generator gets a diff they did not ask for.
    const drifted = derivedFiles(SNAPSHOT)
      .filter((file) => readFileSync(join(REPO_ROOT, file.path), 'utf8') !== file.text)
      .map((file) => file.path);
    expect(drifted, 'run `npm run manifests:write`').toEqual([]);
  });

  it('keeps the root section pinned to the app version', () => {
    const pins = Object.entries(SNAPSHOT.root.dependencies ?? {}).filter(([name]) =>
      name.startsWith(UCAD_SCOPE),
    );
    expect(pins.length).toBeGreaterThan(5);
    for (const [name, version] of pins) expect(`${name}@${version}`).toBe(`${name}@${SNAPSHOT.root.version}`);
  });
});

describe('every way the three can disagree is a named failure', () => {
  it('names a package the shell declares and the root manifest does not', () => {
    // The `db9b379` shape, driven from a copy: the packaged app cannot require
    // a package the root manifest does not declare.
    const dependencies = Object.fromEntries(
      Object.entries(SNAPSHOT.root.dependencies ?? {}).filter(([name]) => name !== '@ucad/usage'),
    );
    const problems = manifestDrift(withRootDependencies(dependencies));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('@ucad/usage');
    expect(problems[0]).toContain('missing from the root manifest');
  });

  it('names a root entry the shell does not declare', () => {
    const problems = manifestDrift(
      withRootDependencies({ ...SNAPSHOT.root.dependencies, '@ucad/ghost': SNAPSHOT.root.version }),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('@ucad/ghost');
    expect(problems[0]).toContain('does not declare it');
  });

  it('names a pin that is not the app version', () => {
    const problems = manifestDrift(
      withRootDependencies({ ...SNAPSHOT.root.dependencies, '@ucad/usage': '0.9.0' }),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('pinned to `0.9.0`');
  });

  it('names a dependency that has no directory under packages/', () => {
    const problems = manifestDrift(withDesktopDependency('@ucad/nowhere'));
    expect(problems.map((problem) => problem).join('\n')).toContain('names no directory');
  });

  it('names an ignore entry the derivation does not produce', () => {
    const problems = manifestDrift(withKnipIgnores([...DERIVED_IGNORES, '@ucad/context']));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('@ucad/context');
    expect(problems[0]).toContain('is ignored but the derivation does not produce it');
  });

  it('names an ignore entry that went missing', () => {
    const problems = manifestDrift(
      withKnipIgnores(DERIVED_IGNORES.filter((name) => name !== '@ucad/files')),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('@ucad/files');
    expect(problems[0]).toContain('missing from `ignoreDependencies`');
  });

  it('goes red in two places when only the shell’s manifest is edited', () => {
    // The edit the brief for this round names: add a runtime dependency to
    // `apps/desktop/package.json` and touch nothing else. Before this file, the
    // tree stayed green until someone packaged the app and it died at the first
    // `require` — which is exactly how `db9b379` was found.
    // `@ucad/bench` is a real package directory that the shell does not declare
    // today, so this is the shape of "the shell grew a runtime dependency".
    const problems = manifestDrift(withDesktopDependency('@ucad/bench'));
    expect(problems.length, problems.join('\n')).toBeGreaterThanOrEqual(2);
    expect(problems.join('\n')).toContain('missing from the root manifest');
    expect(problems.join('\n')).toContain('missing from `ignoreDependencies`');
  });
});

describe('the derivation is wired into the gate', () => {
  const scripts = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).scripts as Record<
    string,
    string
  >;

  it('reads the three files the artifact is described by', () => {
    // The paths are exported so a reader can find them, and asserted so a
    // rename cannot leave the derivation reading a file nobody ships.
    expect(derivedFiles(SNAPSHOT).map((file) => file.path)).toEqual([
      ROOT_MANIFEST_PATH,
      KNIP_CONFIG_PATH,
    ]);
    expect(existsSync(join(REPO_ROOT, DESKTOP_MANIFEST_PATH))).toBe(true);
  });

  it('is a script a person can run', () => {
    expect(scripts['manifests:check']).toBe('node scripts/package-manifests.mjs --check');
    expect(scripts['manifests:write']).toBe('node scripts/package-manifests.mjs --write');
  });

  it('runs as its own CI step, before the suite that would also catch it', () => {
    // A named step fails in seconds and says which file to regenerate; the same
    // assertion inside a 1200-case suite fails after the build. Both are gates,
    // and the fast one is the one a reader will actually act on.
    const workflow = readFileSync(join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
    expect(workflow).toContain('run: npm run manifests:check');
  });
});

/**
 * The two flags that must not write, and the one that must refuse.
 *
 * The header of `scripts/package-manifests.mjs` promises three things about its
 * command line: `--print` "writes nothing", `--write` is the only mode that
 * touches the tree, and "an unrecognised flag is an error rather than a
 * default". The first and the third were promises with no assertion behind
 * them — the contract above drives `manifestDrift()` and `derivedFiles()`
 * directly, so it never runs the script's own argument handling at all.
 *
 * That is the shape this repository keeps naming: `--steps 6` used to start the
 * app, drive nothing and exit 0; `--no-installers` used to be silently ignored.
 * A flag that is misspelled and silently runs the *check* is the mild version
 * of that defect; a flag that is misspelled and silently runs `--write` is the
 * one that edits two manifests because someone typed `--writ`.
 *
 * Both cases are measured the same way: fingerprint the two derived files
 * (content, size, mtime) before and after, so "wrote nothing" is a measurement
 * rather than a reading of the script's own PASS line.
 */
describe('the flags that must not write, and the one that must refuse', () => {
  const SCRIPT = join(REPO_ROOT, 'scripts', 'package-manifests.mjs');

  function run(args: string[]) {
    return spawnSync(process.execPath, [SCRIPT, ...args], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 60_000,
    });
  }

  /** The two derived files as they are on disk right now. */
  function fingerprint() {
    return derivedFiles(SNAPSHOT).map((file) => {
      const full = join(REPO_ROOT, file.path);
      const stat = statSync(full);
      return {
        path: file.path,
        text: readFileSync(full, 'utf8'),
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      };
    });
  }

  it('`--print` prints the derivation and writes nothing', () => {
    const before = fingerprint();
    const result = run(['--print']);

    expect(result.status, result.stderr).toBe(0);

    // The output is the derivation itself, in both directions: every derived
    // entry is printed, and nothing that is not derived is. A listing that
    // printed a stale copy of the files would satisfy "contains" but not this.
    const lines = (result.stdout ?? '').split('\n');
    const printedSection = lines
      .filter((line) => /^ {2}@ucad\/\S+: \S+$/.test(line))
      .map((line) => line.trim());
    const printedIgnores = lines
      .filter((line) => /^ {2}@ucad\/\S+$/.test(line))
      .map((line) => line.trim());
    expect(printedSection).toEqual(
      Object.entries(DERIVED_SECTION).map(([name, version]) => `${name}: ${version}`),
    );
    expect(printedIgnores).toEqual(DERIVED_IGNORES);
    expect(result.stdout).toContain('PASS — printed the derivation; nothing was written');

    // And the claim in that PASS line, measured: same bytes, same size, same
    // mtime. A `--print` that rewrote a file with identical content would pass
    // a content-only check and still be a write.
    expect(fingerprint()).toEqual(before);
  });

  it('refuses a flag it does not know, and names it', () => {
    const before = fingerprint();
    // One character short of `--check`: the typo that would otherwise run the
    // check and print PASS, which reads as "the manifests are fine".
    const result = run(['--chek']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--chek');
    expect(result.stderr).toContain('usage: node scripts/package-manifests.mjs');
    // No verdict at all: a refusal that also printed PASS would be read as one.
    expect(result.stdout).not.toContain('PASS');
    expect(fingerprint()).toEqual(before);
  });

  it('refuses a misspelled `--write` instead of writing', () => {
    // The expensive version of the same defect: `--writ` silently regenerating
    // two manifests is an edit nobody asked for, in files the gate then calls
    // consistent.
    const before = fingerprint();
    const result = run(['--writ']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--writ');
    expect(fingerprint()).toEqual(before);
  });
});
