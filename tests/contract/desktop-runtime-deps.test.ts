/**
 * Every package the desktop shell's Node half requires is one it declares.
 *
 * ## The broken artifact this exists to catch
 *
 * A real-machine run launched the app `npm run package` had just written, and it
 * died before a window: `Cannot find module '@ucad/contracts'`, thrown from
 * `app.asar/apps/desktop/dist/main/bootstrap.js`. The import was real, the
 * package was in the workspace, and `tsc` was happy — because TypeScript reads
 * the symlinks npm workspaces leaves in the repository root. `electron-builder`
 * is not reading those symlinks: it walks the **declared** dependency graph of
 * the app and copies what it finds into the archive. A package required by the
 * main process but missing from `apps/desktop/package.json` is therefore absent
 * from the artifact, and the failure only exists after packaging — which is why
 * every type check, unit run and e2e run stayed green while the shipped build
 * could not start.
 *
 * ## Why the scan is the only shape that works here
 *
 * The proper check is "boot the artifact", which is `scripts/verify-main-chain.mjs`
 * and `scripts/verify-packaged-adapters.mjs` — manual, per platform, and not in
 * CI on purpose (packaging flakes there would take those claims down with it).
 * This file covers the half that *is* decidable from the repository: the set of
 * specifiers the Node-side source asks for, against the set the manifest offers.
 *
 * Only `main`, `preload` and `shared` are scanned. The renderer's imports are
 * bundled by Vite and never resolved from `node_modules` at run time, so
 * declaring them would be noise — and scanning them would make the gate fail on
 * a layout that ships fine.
 *
 * ## The scan proves it read something
 *
 * A manifest with no dependencies and a walk that found no files both read as
 * empty sets, so the counts are asserted before the comparison: the gate that
 * cannot see an import is exactly as dangerous as the missing declaration.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const DESKTOP_DIR = join(REPO_ROOT, 'apps', 'desktop');

/** The directories whose imports survive into the packaged app as `require`s. */
const RUNTIME_SOURCE_DIRS = ['main', 'preload', 'shared'] as const;

/** `@ucad/…`, plus any other package a runtime source file can require. */
const RUNTIME_SPECIFIER = /from\s+'((?:@[a-z0-9-]+\/)?[a-z0-9-][a-z0-9._-]*)'/g;

/** Recursively list `.ts` files under one directory of the desktop shell. */
function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(full));
    else if (entry.isFile() && /\.ts$/.test(entry.name)) found.push(full);
  }
  return found;
}

interface RuntimeImport {
  readonly specifier: string;
  readonly file: string;
  readonly line: number;
}

/** Every external module specifier the shell's Node half asks for. */
function runtimeImports(): RuntimeImport[] {
  const imports: RuntimeImport[] = [];
  for (const subdir of RUNTIME_SOURCE_DIRS) {
    for (const file of sourceFiles(join(DESKTOP_DIR, 'src', subdir))) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(RUNTIME_SPECIFIER)) {
        const specifier = match[1]!;
        if (specifier.startsWith('.')) continue;
        imports.push({
          specifier,
          file: file.slice(REPO_ROOT.length + 1),
          line: text.slice(0, match.index).split('\n').length,
        });
      }
    }
  }
  return imports;
}

const manifest = JSON.parse(readFileSync(join(DESKTOP_DIR, 'package.json'), 'utf8')) as {
  dependencies?: Record<string, string>;
};
const declared = new Set(Object.keys(manifest.dependencies ?? {}));

/** Workspace packages are the ones copied into the archive by name. */
const ucadSpecifiers = runtimeImports().filter((entry) => entry.specifier.startsWith('@ucad/'));

describe('the packaged app can require what its own source requires', () => {
  it('reads the runtime source tree', () => {
    // Before the comparison: a walk that saw nothing would make the gate below
    // pass on every future breakage.
    expect(ucadSpecifiers.length, 'no @ucad import found in main/preload/shared').toBeGreaterThan(
      5,
    );
    expect(
      new Set(ucadSpecifiers.map((entry) => entry.specifier)).has('@ucad/contracts'),
      'the scan lost bootstrap.ts, which requires @ucad/contracts',
    ).toBe(true);
  });

  it('declares every @ucad package the Node half requires', () => {
    const missing = ucadSpecifiers.filter((entry) => !declared.has(entry.specifier));
    expect(
      missing.map((entry) => `${entry.file}:${entry.line} → ${entry.specifier}`),
      'electron-builder copies declared dependencies into app.asar; an undeclared one is not in the artifact, and the packaged app dies at the first require',
    ).toEqual([]);
  });

  it('keeps the workspace version pins uniform', () => {
    // Every `@ucad/*` package is this repository, at this version. A pin that
    // says anything else resolves to something that is not the tree being
    // packaged, and the archive then ships two copies of the same code.
    const mismatches = Object.entries(manifest.dependencies ?? {})
      .filter(([name, version]) => name.startsWith('@ucad/') && version !== manifest.version)
      .map(([name, version]) => `${name}: ${version}`);
    expect(mismatches, 'workspace dependencies must be pinned to the app version').toEqual([]);
  });
});

/**
 * The root manifest is the one `electron-builder` reads, and knip's ignore list
 * is a claim about the artifact.
 *
 * ## The regression this pins
 *
 * `db9b379` fixed a real artifact failure — the packaged app died on
 * `Cannot find module '@ucad/usage'` — by adding three packages to the **root**
 * `package.json`. That is the manifest `electron-builder` reads (the root one is
 * the app manifest; `apps/desktop/package.json` is a workspace member), so the
 * three had to be there. The fix was right and it left the gate red: `npm run
 * knip` exits 1 on that commit, because no root-level script or test imports
 * those three — they are imported by `apps/desktop/src/main`, which declares
 * them in its own manifest. CI runs `npm run knip`, so the tree was red for a
 * reason nobody had written down.
 *
 * ## Why the fix is a declaration and not a deletion
 *
 * Deleting the three from the root manifest would turn knip green and put the
 * artifact failure back. So the three are declared to knip as what they are:
 * dependencies the **packaged app** resolves at runtime, which no root-level
 * static import names. `knip.json` already carried two entries of exactly that
 * shape (`@ucad/adapter-mock`, `@ucad/adapter-universal` — required by name from
 * `adapter-candidates.ts`, so no `from` clause names them either).
 *
 * ## What keeps the list from becoming a dumping ground
 *
 * An ignore list is the easiest place in a repository to hide a dependency
 * nobody uses. So the list is checked rather than trusted: every entry must be
 * declared in the root manifest **and** its specifier must appear in the shell's
 * Node-side source. A package that is neither is a dependency the artifact does
 * not resolve, and ignoring it would be silencing a real finding.
 *
 * `ignoreProblems()` is pure in its three inputs, so the red direction is driven
 * with mutated copies instead of argued about.
 */

const ROOT_MANIFEST = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
  dependencies?: Record<string, string>;
};
const KNIP_CONFIG = JSON.parse(readFileSync(join(REPO_ROOT, 'knip.json'), 'utf8')) as {
  ignoreDependencies?: string[];
};

/** Every byte of the shell's Node half, for specifiers no `from` clause names. */
function runtimeSourceText(): string {
  const parts: string[] = [];
  for (const subdir of RUNTIME_SOURCE_DIRS) {
    for (const file of sourceFiles(join(DESKTOP_DIR, 'src', subdir))) {
      parts.push(readFileSync(file, 'utf8'));
    }
  }
  return parts.join('\n');
}

/**
 * Every way knip's ignore list stops describing the artifact.
 *
 * Pure in `(ignores, rootDependencies, sourceText)` so the red direction is
 * driven with mutated inputs.
 */
function ignoreProblems(
  ignores: readonly string[],
  rootDependencies: ReadonlySet<string>,
  sourceText: string,
): string[] {
  const problems: string[] = [];
  for (const name of ignores) {
    if (!rootDependencies.has(name)) {
      problems.push(
        `knip.json: \`${name}\` is ignored but not declared in the root manifest — the ` +
          'packaged app cannot resolve a package the manifest does not declare, so this ' +
          'entry silences a finding about a dependency nothing uses',
      );
      continue;
    }
    if (!sourceText.includes(`'${name}'`)) {
      problems.push(
        `knip.json: \`${name}\` is ignored but the shell's Node-side source never names it — ` +
          'an ignore entry is a claim that the artifact resolves it at runtime, and this one ' +
          'is not backed by a specifier in main/preload/shared',
      );
    }
  }
  return problems;
}

describe('the root manifest and knip’s ignore list describe the same artifact', () => {
  it('declares every @ucad package the Node half requires in the root manifest too', () => {
    // `electron-builder` reads the root manifest, so a package declared only in
    // `apps/desktop/package.json` is not in the archive — the failure `db9b379`
    // fixed, and the one this case would have caught before it shipped.
    const rootDeclared = new Set(Object.keys(ROOT_MANIFEST.dependencies ?? {}));
    const missing = ucadSpecifiers.filter((entry) => !rootDeclared.has(entry.specifier));
    expect(
      missing.map((entry) => `${entry.file}:${entry.line} → ${entry.specifier}`),
      'the root manifest is the one electron-builder reads; a runtime package missing from it is missing from app.asar',
    ).toEqual([]);
  });

  it('only tells knip to ignore packages the packaged app resolves at runtime', () => {
    const ignores = KNIP_CONFIG.ignoreDependencies ?? [];
    // Before the comparison: an empty list would make the check below pass on
    // every future entry, and the list is not empty today.
    expect(ignores.length, 'knip.json carries no ignoreDependencies').toBeGreaterThan(0);
    const problems = ignoreProblems(
      ignores,
      new Set(Object.keys(ROOT_MANIFEST.dependencies ?? {})),
      runtimeSourceText(),
    );
    expect(problems, `knip.json and the artifact disagree:\n  ${problems.join('\n  ')}`).toEqual(
      [],
    );
  });

  it('goes red when an ignored package is not in the root manifest', () => {
    const problems = ignoreProblems(
      ['@ucad/not-declared'],
      new Set(Object.keys(ROOT_MANIFEST.dependencies ?? {})),
      runtimeSourceText(),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('not declared in the root manifest');
  });

  it('goes red when an ignored package is declared but never named by the shell', () => {
    const problems = ignoreProblems(
      ['@ucad/context'],
      new Set(Object.keys(ROOT_MANIFEST.dependencies ?? {})),
      runtimeSourceText().replaceAll("'@ucad/context'", "'@ucad/elsewhere'"),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('never names it');
  });
});
