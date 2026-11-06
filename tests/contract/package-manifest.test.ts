/**
 * The packaged app ships the packages the **root** manifest declares — and only those.
 *
 * ## The broken artifact this exists to catch
 *
 * `db9b379` fixed a shipped build that died before a window with
 * `Cannot find module '@ucad/usage'`. The import was real, the package was in the
 * workspace, `tsc` was happy, and `apps/desktop/package.json` declared it — the
 * one manifest that did not was the **root** one. `electron-builder` treats the
 * root `package.json` as the app's manifest and copies *its* dependency graph
 * into `app.asar`; a package reachable only through a workspace package's own
 * manifest is therefore not in the archive, and the failure exists only after
 * packaging.
 *
 * `desktop-runtime-deps.test.ts` already covers the other half of that defect:
 * the specifiers the Node-side source asks for, against
 * `apps/desktop/package.json`. It cannot see this one, because the source asks
 * for `@ucad/usage` and the desktop manifest declares it — the missing
 * declaration was one level up. Two manifests, two questions, two gates.
 *
 * ## What is asserted, and why each one is a way the artifact breaks
 *
 *  - **every `@ucad/*` a workspace manifest depends on is declared at the root** —
 *    the `db9b379` shape. The root manifest is the graph `electron-builder`
 *    walks, so a dependency that only exists in a package's own manifest is a
 *    package that is not in the archive.
 *  - **every root `@ucad/*` dependency names a directory under `packages/`** — a
 *    phantom entry is a dependency `npm ci` cannot resolve, and it makes the
 *    first check pass for the wrong reason.
 *  - **every root `@ucad/*` pin equals the root version** — a pin that says
 *    anything else resolves to something that is not the tree being packaged.
 *  - **`build.files` carries the two globs the packages need** — {@link DIST_GLOB}
 *    and {@link MANIFEST_GLOB}. Declaring a dependency and not copying its
 *    `dist` is the same failure with a different cause: the archive has a
 *    directory with no `index.js` in it.
 *  - **every root `@ucad/*` dependency is in the solution build** — a package
 *    that is declared and copied but never built has no `dist` for the glob to
 *    match, so the archive ships an empty package.
 *  - **every package's `main` points into `dist/`** — the glob above is written
 *    against `dist/`; a package whose entry point lives anywhere else is copied
 *    without the file that entry point names.
 *  - **every package directory is named after its package** — the globs are
 *    written against the directory, so a directory that disagrees with its
 *    `name` is a package the glob copies under a name nothing requires.
 *
 * ## The one package that is deliberately not shipped
 *
 * `packages/bench` is a measurement harness: nothing requires it at run time, so
 * it is not in the root manifest and not in the archive. That is a decision, and
 * a decision that is only written in prose is one nobody can check — so it is
 * asserted in both directions. If `bench` ever appears in the root manifest, the
 * gate says the archive grew a package nothing needs; if anything starts
 * depending on `bench`, the first check fires and the decision has to be made
 * again on purpose.
 *
 * ## The scan proves it read something
 *
 * A snapshot with no packages and no dependencies reads as two empty sets, and
 * every comparison below would pass over them. The counts are asserted before
 * the comparison, and every red direction is driven with a mutated copy of the
 * real snapshot rather than by editing the repository.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const PACKAGES_DIR = join(REPO_ROOT, 'packages');

/** The two globs `build.files` has to carry for the workspace packages. */
const DIST_GLOB = 'packages/*/dist/**/*';
const MANIFEST_GLOB = 'packages/*/package.json';

/** The package that is measured but never shipped. */
const NOT_SHIPPED = '@ucad/bench';

interface Manifest {
  readonly name?: string;
  readonly version?: string;
  readonly main?: string;
  readonly dependencies?: Record<string, string>;
}

interface RootManifest extends Manifest {
  readonly build?: { readonly files?: readonly string[] };
}

interface PackageEntry {
  /** The directory under `packages/`, which is what the globs are written against. */
  readonly dir: string;
  readonly manifest: Manifest;
}

/** Everything the checks below read, so a red direction can be driven from a copy. */
interface Snapshot {
  readonly root: RootManifest;
  readonly desktop: Manifest;
  readonly packages: readonly PackageEntry[];
  /** The `packages/…` paths `tsconfig.build.json` builds. */
  readonly solution: readonly string[];
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

/**
 * `tsconfig.build.json` carries an explanatory comment, and `JSON.parse` rejects
 * comments — the same reader `build-graph.test.ts` uses, for the same reason.
 */
function readTsConfig<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')) as T;
}

function readSnapshot(): Snapshot {
  const solution = readTsConfig<{ references?: readonly { path: string }[] }>(
    join(REPO_ROOT, 'tsconfig.build.json'),
  );
  return {
    root: readJson<RootManifest>(join(REPO_ROOT, 'package.json')),
    desktop: readJson<Manifest>(join(REPO_ROOT, 'apps', 'desktop', 'package.json')),
    packages: readdirSync(PACKAGES_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({
        dir: entry.name,
        manifest: readJson<Manifest>(join(PACKAGES_DIR, entry.name, 'package.json')),
      }))
      .sort((left, right) => left.dir.localeCompare(right.dir)),
    solution: (solution.references ?? []).map((reference) => reference.path.replaceAll('\\', '/')),
  };
}

/** Every way the manifests and the artifact they describe disagree. */
function manifestProblems(snapshot: Snapshot): string[] {
  const problems: string[] = [];
  const rootDependencies = snapshot.root.dependencies ?? {};
  const rootUcad = Object.entries(rootDependencies).filter(([name]) => name.startsWith('@ucad/'));
  const byName = new Map(snapshot.packages.map((entry) => [entry.manifest.name, entry]));

  // 1. The graph electron-builder walks is the root manifest's. A workspace
  //    dependency that is not in it is a package that is not in the archive.
  for (const manifest of [snapshot.desktop, ...snapshot.packages.map((entry) => entry.manifest)]) {
    for (const name of Object.keys(manifest.dependencies ?? {})) {
      if (!name.startsWith('@ucad/')) continue;
      if (name in rootDependencies) continue;
      problems.push(
        `${manifest.name} depends on ${name}, and the root package.json does not declare it — ` +
          "electron-builder copies the root manifest's dependency graph into app.asar, so the " +
          `packaged app dies at the first require of ${name}`,
      );
    }
  }

  // 2. A root dependency that names no package is a dependency `npm ci` cannot
  //    resolve, and it makes check 1 pass for the wrong reason.
  for (const [name] of rootUcad) {
    if (byName.has(name)) continue;
    problems.push(
      `the root package.json declares ${name}, and there is no packages/*/package.json with that ` +
        'name — the archive would carry a dependency that is not this repository',
    );
  }

  // 3. A pin that says anything else resolves to something that is not the tree
  //    being packaged.
  for (const [name, version] of rootUcad) {
    if (version === snapshot.root.version) continue;
    problems.push(
      `the root package.json pins ${name} at ${version} while the app is at ` +
        `${snapshot.root.version} — the archive would ship two copies of the same code`,
    );
  }

  // 4. Declaring a dependency and not copying its `dist` is the same failure
  //    with a different cause.
  const files = snapshot.root.build?.files ?? [];
  for (const glob of [DIST_GLOB, MANIFEST_GLOB]) {
    if (files.includes(glob)) continue;
    problems.push(
      `build.files does not carry \`${glob}\` — the archive would have the package directory ` +
        'and not the files its entry point names',
    );
  }

  // 5. A package that is declared and copied but never built has no `dist` for
  //    the glob to match.
  const built = new Set(snapshot.solution);
  for (const [name] of rootUcad) {
    const entry = byName.get(name);
    if (entry === undefined) continue;
    if (built.has(`packages/${entry.dir}`)) continue;
    problems.push(
      `${name} is shipped but tsconfig.build.json does not build packages/${entry.dir} — the ` +
        'archive would carry an empty package',
    );
  }

  // 6. The glob is written against `dist/`; an entry point anywhere else is
  //    copied without the file it names.
  for (const entry of snapshot.packages) {
    const main = entry.manifest.main;
    if (typeof main === 'string' && main.startsWith('dist/')) continue;
    problems.push(
      `packages/${entry.dir}/package.json has main=${JSON.stringify(main ?? null)}, which is not ` +
        `under dist/ — build.files copies \`${DIST_GLOB}\`, so the entry point would not be in ` +
        'the archive',
    );
  }

  // 7. The globs are written against the directory, so a directory that
  //    disagrees with its `name` is copied under a name nothing requires.
  for (const entry of snapshot.packages) {
    if (entry.manifest.name === `@ucad/${entry.dir}`) continue;
    problems.push(
      `packages/${entry.dir}/package.json is named ${JSON.stringify(entry.manifest.name ?? null)} — ` +
        'the build globs are written against the directory, so the archive would carry it under ' +
        'a name nothing requires',
    );
  }

  return problems;
}

const SNAPSHOT = readSnapshot();

describe('the packaged app ships the packages the root manifest declares', () => {
  it('reads the manifests it is about to compare', () => {
    // Before the comparison: an empty snapshot makes every check below pass.
    expect(SNAPSHOT.packages.length, 'no packages/*/package.json was read').toBeGreaterThan(15);
    expect(
      Object.keys(SNAPSHOT.root.dependencies ?? {}).filter((name) => name.startsWith('@ucad/'))
        .length,
      'the root manifest declares no @ucad package',
    ).toBeGreaterThan(15);
    expect(
      Object.keys(SNAPSHOT.desktop.dependencies ?? {}).length,
      'apps/desktop/package.json declares no dependencies',
    ).toBeGreaterThan(5);
    expect(SNAPSHOT.solution.length, 'tsconfig.build.json builds no package').toBeGreaterThan(15);
  });

  it('agrees with itself in every way the artifact depends on', () => {
    const problems = manifestProblems(SNAPSHOT);
    expect(
      problems,
      `the manifests and the artifact they describe disagree:\n  ${problems.join('\n  ')}`,
    ).toEqual([]);
  });

  it('ships @ucad/usage, the package db9b379 was about', () => {
    // The one package whose absence was measured on a real machine. Named here
    // rather than left to the loop, because a loop that lost its input would
    // still be green.
    expect(SNAPSHOT.root.dependencies?.['@ucad/usage']).toBe(SNAPSHOT.root.version);
  });

  it('does not ship the measurement harness, and nothing depends on it', () => {
    expect(
      SNAPSHOT.root.dependencies?.[NOT_SHIPPED],
      `${NOT_SHIPPED} is a measurement harness; shipping it grows the archive with a package ` +
        'nothing requires at run time',
    ).toBeUndefined();
    const dependents = [SNAPSHOT.desktop, ...SNAPSHOT.packages.map((entry) => entry.manifest)]
      .filter((manifest) => NOT_SHIPPED in (manifest.dependencies ?? {}))
      .map((manifest) => manifest.name);
    expect(
      dependents,
      `${NOT_SHIPPED} is now required by ${dependents.join(', ')} — it has to be declared at the ` +
        'root and shipped, or the dependency has to go',
    ).toEqual([]);
  });

  it('reports a workspace dependency the root manifest does not declare', () => {
    // The db9b379 shape, driven from a copy: drop `@ucad/usage` from the root
    // manifest and the gate has to name the package that requires it.
    const rest = Object.fromEntries(
      Object.entries(SNAPSHOT.root.dependencies ?? {}).filter(([name]) => name !== '@ucad/usage'),
    );
    const problems = manifestProblems({
      ...SNAPSHOT,
      root: { ...SNAPSHOT.root, dependencies: rest },
    });
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join('\n')).toContain('@ucad/usage');
    expect(problems.join('\n')).toContain('does not declare it');
  });

  it('reports a root dependency that names no package', () => {
    const problems = manifestProblems({
      ...SNAPSHOT,
      root: {
        ...SNAPSHOT.root,
        dependencies: { ...SNAPSHOT.root.dependencies, '@ucad/ghost': SNAPSHOT.root.version },
      },
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('@ucad/ghost');
    expect(problems[0]).toContain('no packages/*/package.json with that name');
  });

  it('reports a pin that drifted from the app version', () => {
    const problems = manifestProblems({
      ...SNAPSHOT,
      root: {
        ...SNAPSHOT.root,
        dependencies: { ...SNAPSHOT.root.dependencies, '@ucad/usage': '0.9.0' },
      },
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('@ucad/usage');
    expect(problems[0]).toContain('0.9.0');
  });

  it('reports a build.files glob that stopped covering the packages', () => {
    const problems = manifestProblems({
      ...SNAPSHOT,
      root: {
        ...SNAPSHOT.root,
        build: {
          ...SNAPSHOT.root.build,
          files: (SNAPSHOT.root.build?.files ?? []).filter((glob) => glob !== DIST_GLOB),
        },
      },
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(DIST_GLOB);
  });

  it('reports a shipped package the solution build does not build', () => {
    const problems = manifestProblems({
      ...SNAPSHOT,
      solution: SNAPSHOT.solution.filter((path) => path !== 'packages/usage'),
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('@ucad/usage');
    expect(problems[0]).toContain('tsconfig.build.json does not build packages/usage');
  });

  it('reports an entry point that is not under dist/', () => {
    const problems = manifestProblems({
      ...SNAPSHOT,
      packages: SNAPSHOT.packages.map((entry) =>
        entry.dir === 'usage' ? { ...entry, manifest: { ...entry.manifest, main: 'index.js' } } : entry,
      ),
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('packages/usage/package.json');
    expect(problems[0]).toContain('"index.js"');
  });

  it('reports a directory whose name disagrees with its package name', () => {
    const problems = manifestProblems({
      ...SNAPSHOT,
      packages: SNAPSHOT.packages.map((entry) =>
        entry.dir === 'usage'
          ? { ...entry, manifest: { ...entry.manifest, name: '@ucad/token-usage' } }
          : entry,
      ),
    });
    // Two problems, and both are real: the root manifest now declares a package
    // that no longer exists, and the directory is copied under a name nothing
    // requires. Naming both is the point — a rename is two edits.
    expect(problems).toHaveLength(2);
    expect(problems.join('\n')).toContain('@ucad/token-usage');
    expect(problems.join('\n')).toContain('@ucad/usage');
  });
});
