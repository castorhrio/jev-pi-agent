/**
 * The walk every main-process source gate is built on, tested where it is
 * decided rather than where it is used.
 *
 * ## Why this file exists
 *
 * `main-sources.ts` is the one implementation behind three gates that read
 * product *code*: the update channel's construction scan, the container's
 * guard-scope scan, and the "the feed is announced once" scan. Each of those
 * gates already has fixtures, and each of those fixtures is about the question
 * the gate asks. What none of them can show is the walk itself.
 *
 * The consumer that came closest was `update-integrity.test.ts`'s
 * `countTypeScriptFiles()`, with a comment saying it exists so that
 * "`mainSources()` reads fewer files than the directory holds" is red rather
 * than invisible. That comparison was local to one consumer: an exclusion in
 * the walk — a skip list for the slow files, a `.ts` filter that forgets a
 * directory — narrowed that gate's scan, and every other consumer was still
 * free to keep its own copy or to stop comparing at all. A walk that is copied
 * was the reason `source-scan.ts` was extracted; this is the same argument one
 * layer down, so the comparison is asserted here, once, for all of them.
 *
 * ## What "independent" means here
 *
 * The cases below never call `mainSources()` twice and compare it with itself.
 * The real tree is listed by a second walk written against `readdirSync` and the
 * root's absolute path, so:
 *
 *  - a file the walk skips is named in the difference, not just counted;
 *  - an empty read (a file opened but returned as `''`) is red, because every
 *    gate above would then pass about text it never saw;
 *  - a path the walk hands out has to resolve back to the file it came from,
 *    which is separately what a failure message depends on.
 *
 * The fixture trees cover the shapes the real `apps/desktop/src/main` no longer
 * has: it is flat, so nothing in the product tree exercises the recursion, the
 * non-TypeScript filter, or the sort order a failure message relies on.
 */

import { describe, expect, it } from 'vitest';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  type Dirent,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';

import { MAIN_SOURCE, REPO_ROOT, mainSources } from './main-sources';

/**
 * The same tree, listed by a walk that shares no code with the module.
 *
 * `root` is absolute, `prefix` is the repo-relative name of that root, and the
 * stack is explicit rather than recursive — a recursion that had been shared by
 * accident would not be an independent count.
 */
function independentWalk(root: string, prefix: string): string[] {
  const found: string[] = [];
  const pending = [''];
  while (pending.length > 0) {
    const under = pending.pop()!;
    for (const entry of readdirSync(join(root, under), { withFileTypes: true }) as Dirent[]) {
      const child = under === '' ? entry.name : `${under}/${entry.name}`;
      if (entry.isDirectory()) pending.push(child);
      else if (entry.name.endsWith('.ts')) found.push(`${prefix}/${child}`);
    }
  }
  return found.sort();
}

/** The path `mainSources()` hands out for one file of a fixture tree. */
function expectedPath(root: string, name: string): string {
  return relative(REPO_ROOT, join(root, name)).split(sep).join('/');
}

/** One fixture tree, removed however the test ends. */
function withFixtureTree(layout: (root: string) => void, body: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'ucad-main-sources-'));
  try {
    layout(root);
    body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** A `.ts` file whose content identifies it, so a wrong read is visible. */
function writeSource(root: string, name: string, text?: string): string {
  const full = join(root, name);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, text ?? `export const file = '${name}';\n`);
  return full;
}

describe('the main-process walk reads the tree it was given', () => {
  it('reads every TypeScript file under apps/desktop/src/main, and no others', () => {
    // The root is asserted by name, because every path below is relative to it
    // and a walk pointed one directory up would still be self-consistent.
    expect(MAIN_SOURCE, 'the scan root moved').toBe(
      join(REPO_ROOT, 'apps', 'desktop', 'src', 'main'),
    );

    const files = mainSources();
    expect(
      files.length,
      'the walk found no sources at all, so every gate above passes',
    ).toBeGreaterThan(5);

    // The set, not the count: a walk that skipped one file and read another
    // twice would satisfy a total, and the failure would name no file.
    const expected = independentWalk(MAIN_SOURCE, 'apps/desktop/src/main');
    expect(
      files.map((file) => file.path).sort(),
      'the walk and an independent readdirSync disagree about which files the main process has',
    ).toEqual(expected);

    // Named rather than implied: these are the files the consumer gates depend
    // on, so "the walk is reading the right tree" is not only a total.
    for (const required of [
      'apps/desktop/src/main/bootstrap.ts',
      'apps/desktop/src/main/update-service.ts',
      'apps/desktop/src/main/app-container.ts',
    ]) {
      expect(expected, `the main process no longer has ${required}`).toContain(required);
      expect(
        files.map((file) => file.path),
        `the walk skipped ${required}`,
      ).toContain(required);
    }

    for (const file of files) {
      // A path a message can print on any host. `relative` on Windows would
      // otherwise hand out backslashes, and the consumers' string comparisons
      // are written with `/`.
      expect(file.path, `${file.path} is not repository-relative`).not.toMatch(/^(\.{2}\/|\/)/);
      expect(file.path, `${file.path} does not use / as its separator`).not.toContain('\\');
      expect(file.path, `${file.path} is not a TypeScript source`).toMatch(/\.ts$/);

      // The path resolves back to the file it was read from, and the text is
      // that file's text. A file read as `''` (a descriptor opened, nothing
      // read) would leave every gate above green about an empty string.
      expect(file.source, `${file.path} was read as empty`).not.toBe('');
      expect(file.source, `${file.path} was read from a different file`).toBe(
        readFileSync(resolve(REPO_ROOT, file.path), 'utf8'),
      );
    }
  });

  it('walks subdirectories and reads nothing that is not TypeScript', () => {
    withFixtureTree(
      (root) => {
        writeSource(root, 'top.ts');
        writeSource(root, 'nested/middle.ts');
        writeSource(root, 'nested/deeper/bottom.ts');
        // Read: the filter is the name's suffix, so a declaration file is
        // included on purpose (see `mainSources()`).
        writeSource(root, 'types.d.ts', 'export type Nested = string;\n');
        // Not read: the four shapes a "the sources under main" filter has to
        // exclude.
        writeFileSync(join(root, 'notes.md'), '# not a source\n');
        writeFileSync(join(root, 'panel.tsx'), 'export const Panel = () => null;\n');
        writeFileSync(join(root, 'fixture.json'), '{}\n');
        writeFileSync(join(root, 'LICENSE'), 'not a source\n');
      },
      (root) => {
        const names = mainSources(root).map((file) => relative(root, resolve(REPO_ROOT, file.path)));
        expect(names, 'the walk skipped a nested source or read a non-source file').toEqual([
          'nested/deeper/bottom.ts',
          'nested/middle.ts',
          'top.ts',
          'types.d.ts',
        ]);
      },
    );
  });

  it('lists files in the order a reader would find them', () => {
    // Per-level sorting, with a directory's contents appearing where the
    // directory sorts. The order is what a failure message lists, and it was
    // copied identically into two consumers before the walk was extracted —
    // the reason one implementation is what keeps them from drifting apart.
    withFixtureTree(
      (root) => {
        writeSource(root, 'zebra.ts');
        writeSource(root, 'alpha.ts');
        writeSource(root, 'mike/one.ts');
        writeSource(root, 'mike/two.ts');
        writeSource(root, 'november/three.ts');
      },
      (root) => {
        const names = mainSources(root).map((file) => relative(root, resolve(REPO_ROOT, file.path)));
        expect(names).toEqual([
          'alpha.ts',
          'mike/one.ts',
          'mike/two.ts',
          'november/three.ts',
          'zebra.ts',
        ]);
        // `november/` sorts between `mike/` and `zebra.ts`, so this case tells a
        // per-level sort from a total one; a walk that listed every file only
        // after recursing would put the three nested entries in a different
        // place as well.
      },
    );
  });

  it('hands out a path that resolves to the file it read', () => {
    // A path is only useful to a failure message if a reader can open it. The
    // fixture lives outside the repository, so the path is a `..`-heavy
    // `relative()` result — the shape a port that joined `MAIN_SOURCE`-relative
    // names would lose.
    withFixtureTree(
      (root) => {
        writeSource(root, 'nested/one.ts', "export const one = 'one';\n");
      },
      (root) => {
        const files = mainSources(root);
        expect(files.map((file) => file.path)).toEqual([expectedPath(root, 'nested/one.ts')]);
        for (const file of files) {
          expect(resolve(REPO_ROOT, file.path), `${file.path} does not resolve to the file`).toBe(
            join(root, 'nested', 'one.ts'),
          );
          expect(file.source).toBe("export const one = 'one';\n");
        }
      },
    );
  });

  it('throws for a root it cannot list, naming the root', () => {
    // An empty list would be a gate that passes about a tree it never read, so
    // a missing root is red — and the message has to name the directory, not
    // only carry Node's absolute path and a stack pointing at this walk.
    withFixtureTree(
      () => {},
      (root) => {
        const missing = join(root, 'no-such-directory');
        expect(() => mainSources(missing)).toThrow(/could not list .*no-such-directory/);
        expect(() => mainSources(missing)).toThrow(/ENOENT/);
      },
    );
  });

  // A file this process may not read is the only way to reach the read branch
  // of a walk, and it needs a non-root user: root reads a mode-000 file. The
  // skip is named rather than silent, so a run on a root container says which
  // assertion it did not make.
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  it.skipIf(isRoot)('names the file it could not read, instead of a bare EACCES', () => {
    withFixtureTree(
      (root) => {
        writeSource(root, 'readable.ts', 'export const readable = true;\n');
        writeSource(root, 'locked.ts', 'export const locked = true;\n');
      },
      (root) => {
        // Non-vacuous: the same tree is scanned with both files readable, so
        // the failure below is about the permission rather than the fixture.
        expect(mainSources(root).map((file) => file.path)).toEqual([
          expectedPath(root, 'locked.ts'),
          expectedPath(root, 'readable.ts'),
        ]);

        chmodSync(join(root, 'locked.ts'), 0o000);
        try {
          expect(() => mainSources(root)).toThrow(/could not read .*locked\.ts/);
          expect(() => mainSources(root)).toThrow(/EACCES/);
        } finally {
          // Restored so the fixture can be removed whatever the assertions did.
          chmodSync(join(root, 'locked.ts'), 0o644);
        }
      },
    );
  });

  it('refuses a symbolic link file instead of following it', () => {
    // The old walk read a link file as whatever it pointed at, so a gate could
    // be scanning text from outside the tree under a path that looks like it
    // belongs to the tree.
    withFixtureTree(
      (root) => {
        writeSource(root, 'real.ts');
        writeFileSync(join(root, 'notes.md'), '# not a source\n');
        symlinkSync('notes.md', join(root, 'linked.ts'));
      },
      (root) => {
        expect(() => mainSources(root), 'a linked file was followed').toThrow(
          /refuses the symbolic link .*linked\.ts/,
        );
      },
    );
  });

  it('refuses a symbolic link directory instead of skipping it', () => {
    // The worse half: `Dirent.isDirectory()` is false for a link, so the old
    // walk skipped it without a word — and a consumer's independent count
    // skipped it the same way, which is exactly how a narrowed scan stays
    // green.
    withFixtureTree(
      (root) => {
        writeSource(root, 'real.ts');
        // Kept outside the scanned root on purpose: following the link would
        // read a source this walk was never given.
        const outside = mkdtempSync(join(tmpdir(), 'ucad-main-sources-outside-'));
        writeFileSync(join(outside, 'hidden.ts'), 'export const hidden = true;\n');
        symlinkSync(outside, join(root, 'linked-directory'));
        try {
          expect(() => mainSources(root), 'a linked directory was skipped silently').toThrow(
            /refuses the symbolic link .*linked-directory/,
          );
        } finally {
          rmSync(outside, { recursive: true, force: true });
        }
      },
      () => {},
    );
  });
});
