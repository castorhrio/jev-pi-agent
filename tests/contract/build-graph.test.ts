/**
 * Every workspace dependency must be a TypeScript project reference.
 *
 * ## Why this exists
 *
 * `tsc --build` only builds a dependency before its dependent if the
 * dependency is declared. Until round 45 **not one of the 19 packages declared
 * a `references` array**, so the whole build rested on the order of the
 * `references` list in `tsconfig.build.json` — and that list had
 * `packages/providers` *after* `packages/adapter-universal`, which imports it,
 * plus `packages/bench` listed twice.
 *
 * The result: `npm run clean && npm run build:packages` failed with
 * `Cannot find module '@ucad/providers'`, so the `clean` script could never be
 * followed by a build and no clean-room verification was possible. Incremental
 * builds never noticed, because a stale `dist` from an earlier build was
 * sitting there to satisfy the import.
 *
 * Measured, so the claim is not a story. With the solution list in the broken
 * order:
 *
 *  - `adapter-universal` **without** a reference to `../providers` → exit 2
 *  - `adapter-universal` **with** a reference to `../providers`    → exit 0
 *
 * Same order, so the package-level reference is what makes the build
 * order-independent. That is the property worth keeping, and it is the reason
 * this is a gate rather than a convention: a new cross-package import with no
 * reference builds fine right up until somebody runs `npm run clean`.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const PACKAGES_DIR = 'packages';

interface PackageJson {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

interface TsConfig {
  references?: Array<{ path: string }>;
}

/**
 * `JSON.parse` rejects comments, and TypeScript's config parser accepts them —
 * so a tsconfig with an explanatory comment (like this repo's `extends` blocks
 * and the note in `tsconfig.build.json`) cannot be read with `JSON.parse`.
 * Stripping them is the same approach `focus-indicator.test.ts` takes for CSS
 * comments, and it is safe here because none of these files put a `//` inside a
 * string value.
 */
function parseTsConfig(source: string): TsConfig {
  return JSON.parse(source.replace(/\/\*[\s\S]*?\*\//g, '')) as TsConfig;
}

const packages = readdirSync(PACKAGES_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .filter((name) => {
    try {
      readFileSync(join(PACKAGES_DIR, name, 'tsconfig.json'), 'utf8');
      return true;
    } catch {
      return false;
    }
  });

/** `@ucad/x` → `x`, read from the package's own manifest. */
function workspaceDeps(name: string): string[] {
  const pkg = JSON.parse(
    readFileSync(join(PACKAGES_DIR, name, 'package.json'), 'utf8'),
  ) as PackageJson;
  const all = {
    ...pkg.dependencies,
    ...pkg.devDependencies,
    ...pkg.peerDependencies,
  };
  return Object.keys(all)
    .filter((dep) => dep.startsWith('@ucad/'))
    .map((dep) => dep.slice('@ucad/'.length))
    .sort();
}

function references(name: string): string[] {
  const tsconfig = parseTsConfig(
    readFileSync(join(PACKAGES_DIR, name, 'tsconfig.json'), 'utf8'),
  );
  return (tsconfig.references ?? []).map((ref) => ref.path.replace(/^\.\.\//, '')).sort();
}

describe('the build graph matches the dependency manifests', () => {
  it('finds the packages, so this file is not vacuous', () => {
    // If the glob or the directory layout ever changes and this reads 0, every
    // assertion below passes for the wrong reason.
    expect(packages.length).toBeGreaterThan(10);
  });

  it.each(packages)('%s declares every workspace dependency as a reference', (name) => {
    const declared = workspaceDeps(name);
    const declaredRefs = references(name);
    // The comparison is on the dependency side only. An extra reference is
    // harmless (tsc just builds something already needed); a *missing* one is
    // the defect this exists to catch.
    const missing = declared.filter((dep) => !declaredRefs.includes(dep));
    expect(
      missing,
      `${name} depends on ${missing.join(', ')} but does not reference it, so ` +
        '`tsc --build` may compile it before that dependency exists — which only ' +
        'fails on a clean build, never on an incremental one',
    ).toEqual([]);
  });

  it('the solution build lists each package exactly once', () => {
    // `packages/bench` was listed twice. Harmless to tsc and impossible to
    // notice by reading, which is why it is asserted rather than eyeballed.
    const solution = parseTsConfig(readFileSync('tsconfig.build.json', 'utf8')) as {
      references?: Array<{ path: string }>;
    };
    const paths = (solution.references ?? []).map((ref) => ref.path);
    const seen = new Set<string>();
    const duplicates = paths.filter((path) => {
      if (seen.has(path)) return true;
      seen.add(path);
      return false;
    });
    expect(duplicates, `tsconfig.build.json lists these more than once: ${duplicates.join(', ')}`)
      .toEqual([]);

    const listed = paths.map((path) => path.replace(/^packages\//, ''));
    expect(
      listed.filter((name) => packages.includes(name)).sort(),
      'tsconfig.build.json does not list exactly the packages that exist',
    ).toEqual([...packages].sort());
  });
});
