/**
 * The main process's source tree, read as text.
 *
 * ## Why this is a module rather than a local helper
 *
 * Three gates ask questions about the *code* of the main process rather than
 * about a value it produces — "does any construction pass the launch seam",
 * "does any file outside the container ask the start-up guard", "is the update
 * feed announced more than once". Each of them needs the same thing first: every
 * `.ts` file under `apps/desktop/src/main`, with a path a failure can name.
 *
 * Two of them had written that walk themselves, and the copies were identical
 * down to the sort order — the same shape `source-scan.ts` was extracted from
 * after two copies of the comment walk disagreed about a regex literal. A walk
 * that is copied is a walk that can be narrowed in one place: a skip list for
 * "the files that are slow", a filter that keeps `bootstrap.ts` and forgets a
 * subdirectory. The gates that consume this one compare it against an
 * independent `readdirSync` count for exactly that reason, so the walk being
 * *one* implementation is what lets that one comparison cover them all — and
 * `tests/contract/main-sources.test.ts` is that comparison itself, since the
 * gates below cannot prove the walk they are built on.
 *
 * ## What is deliberately not here
 *
 * No blanking, no matching, no interpretation. `blankComments()` in
 * `source-scan.ts` is the one comment walk, and each gate writes the small
 * pattern it is about — this module's job ends at "here is every file, and
 * here is its original text".
 *
 * `dir` is a parameter for the gates that feed the walk a fixture tree; the
 * paths are still repo-relative, because that is the shape a failure message
 * needs and the shape every consumer asserts on.
 *
 * ## Failures name the path a reader can open
 *
 * A scan root is not user input: if the walk cannot list or read a file, the
 * gate is about to pass or fail about a tree it did not read, and the reader
 * needs to know *which* file. Node's own `ENOENT`/`EACCES` carries an absolute
 * path in the message and, in CI, a stack that points at this walk rather than
 * at the file. Both are replaced by an error that starts with the repo-relative
 * path, with the original error kept as `cause` for the code.
 *
 * A symbolic link is refused rather than followed. Following a linked file
 * scans text whose real path is outside the tree; a linked *directory* is worse
 * — `Dirent.isDirectory()` is false for it, so the old walk skipped it without
 * a word and the consumers' independent count agreed, because that count skips
 * it the same way. The repository has none, so the answer for one being
 * introduced is "say so", not "guess".
 */

import { readdirSync, readFileSync, type Dirent } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** The repository root, as an absolute path. */
export const REPO_ROOT = join(import.meta.dirname, '..', '..');

/** The one directory the main-process scans read. */
export const MAIN_SOURCE = join(REPO_ROOT, 'apps', 'desktop', 'src', 'main');

/** One source file, with the path a failure names and the text a scan reads. */
export interface SourceFile {
  /** repo-relative, `/`-separated, so a message reads the same on every host */
  readonly path: string;
  readonly source: string;
}

/**
 * The name this module calls `full`.
 *
 * repo-relative and `/`-separated, because every failure in a gate above this
 * is written as `path:line` and read by somebody on another host.
 */
function scanPath(full: string): string {
  return relative(REPO_ROOT, full).split(sep).join('/');
}

/** The listing, with the original error's code kept and the path made readable. */
function listDirectory(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch (cause) {
    throw new Error(
      `the main-process scan could not list ${scanPath(dir)}: ${(cause as Error).message}`,
      { cause },
    );
  }
}

/** The text of one file, failing with the file's repo-relative name. */
function readSource(full: string): string {
  try {
    return readFileSync(full, 'utf8');
  } catch (cause) {
    throw new Error(
      `the main-process scan could not read ${scanPath(full)}: ${(cause as Error).message}`,
      { cause },
    );
  }
}

/**
 * Every `.ts` file under `dir`, repo-relative and read.
 *
 * Sorted by name at each level rather than in total, so a failure lists files
 * in the order a reader would find them (a directory's contents appear where
 * the directory sorts). A missing directory throws, which is the right answer
 * for a scan root: an empty list would be a gate that passes about a tree it
 * never read.
 *
 * `.d.ts` is included: the filter is "the name ends in `.ts`", and a
 * declaration file has no runtime code for a gate to be wrong about. A second
 * filter for declarations would be one more way for a file to go unread.
 */
export function mainSources(dir: string = MAIN_SOURCE): SourceFile[] {
  return listDirectory(dir)
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(
          `the main-process scan refuses the symbolic link ${scanPath(full)}: ` +
            'a link is read as the thing it points at, and a linked directory is skipped by the walk entirely',
        );
      }
      if (entry.isDirectory()) return mainSources(full);
      if (!entry.name.endsWith('.ts')) return [];
      return [{ path: scanPath(full), source: readSource(full) }];
    });
}
