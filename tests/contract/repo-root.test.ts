/**
 * The repository root holds source, not output.
 *
 * ## Why this file exists
 *
 * Commit `03f8135` shipped a `bootstrap.js` at the repository root: 28 KB,
 * byte-for-byte identical to `apps/desktop/dist/main/bootstrap.js`, added by a
 * build run rather than by a person. Nothing imports it — every manifest points
 * at the dist copy (`package.json#main`,
 * `apps/desktop/package.json#main`) — so what was committed is a *stale copy of
 * the entry point* sitting exactly where a reviewer goes looking for the entry
 * point. That is worse than no file: a near-miss of the build output gets read,
 * trusted, and then never changes again while the real one moves on.
 *
 * Documented output paths are already safe: `npm run build`, `package` and
 * `dist` write per-package `dist` directories (`apps/desktop/dist`, one per
 * package under `packages`), and `dist/` is in `.gitignore`, so generated files
 * cannot be committed by those commands. The root copy came from a command that
 * was not one of them — a hand-run `tsc` drops its output beside the file it
 * compiled, or a copy step someone typed.
 *
 * So the rule pinned here is about the root specifically, and it is stated twice
 * on purpose: once as "the entry point's own filename does not exist at the
 * root", which is the exact regression, and once as "no emitted JavaScript is
 * committed at the root at all", which is the class. Config files that happen to
 * be JavaScript (`.mjs`) are not emitted and stay allowed; `*.tsbuildinfo` is a
 * build cache and is already ignored.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';

const REPO_ROOT = join(import.meta.dirname, '..', '..');

interface Manifest {
  main?: string;
  scripts?: Record<string, string>;
}

const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as Manifest;

/** Emitted JavaScript, in the shapes a build can leave behind. */
const EMITTED = /\.(?:js|cjs|d\.ts|js\.map)$/u;

/**
 * Root files that are JavaScript on purpose: they are configuration, written by
 * hand, and no build writes them.
 */
const HAND_WRITTEN = new Set(['eslint.config.mjs']);

function rootFiles(): string[] {
  return readdirSync(REPO_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
}

describe('the repository root holds source, not output', () => {
  it('keeps the application entry point inside a dist directory', () => {
    // The reason a root copy is a hazard rather than a duplicate: the real entry
    // point is generated, ignored, and rewritten by `npm run build`. Anything
    // that shares its name but not its `dist/` is a copy somebody will read.
    expect(manifest.main, 'package.json#main moved; this gate must move with it').toBeTruthy();
    expect(manifest.main).toMatch(/(?:^|\/)dist\//u);
  });

  it('has no copy of the entry point at the root', () => {
    const entryName = basename(manifest.main!);

    expect(entryName.length).toBeGreaterThan(0);
    expect(
      rootFiles(),
      `${entryName} belongs in a dist directory; a copy at the root is the stale artifact this gate exists for`,
    ).not.toContain(entryName);
  });

  it('commits no emitted JavaScript at the root', () => {
    // The class, not the instance: the next stray build output may be a
    // different file, and it will look just as much like source.
    const emitted = rootFiles().filter((name) => EMITTED.test(name) && !HAND_WRITTEN.has(name));

    expect(emitted, `build output at the repository root: ${emitted.join(', ')}`).toEqual([]);
  });

  it('ignores what the documented commands generate', () => {
    // `dist/` is what `build`, `package` and `dist` write into, and it is the
    // reason those commands cannot produce the artifact above. A stray hand-run
    // compile is covered here too, so it is at least never committed.
    const ignore = readFileSync(join(REPO_ROOT, '.gitignore'), 'utf8')
      .split('\n')
      .map((line) => line.trim());

    expect(ignore).toContain('dist/');
    expect(ignore, 'a hand-run compile of the entry point lands at the root').toContain(
      `/${basename(manifest.main!)}`,
    );
    expect(existsSync(join(REPO_ROOT, 'apps', 'desktop', 'src', 'main', 'bootstrap.ts'))).toBe(true);
  });
});
