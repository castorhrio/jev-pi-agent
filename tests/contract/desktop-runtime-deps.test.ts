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
