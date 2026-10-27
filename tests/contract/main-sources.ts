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
 * *one* implementation is what lets that one comparison cover them all.
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
 */

import { readdirSync, readFileSync } from 'node:fs';
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
 * Every `.ts` file under `dir`, repo-relative and read.
 *
 * Sorted by name at each level rather than in total, so a failure lists files
 * in the order a reader would find them. A missing directory throws, which is
 * the right answer for a scan root: an empty list would be a gate that passes
 * about a tree it never read.
 */
export function mainSources(dir: string = MAIN_SOURCE): SourceFile[] {
  return readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return mainSources(full);
      if (!entry.name.endsWith('.ts')) return [];
      return [
        {
          path: relative(REPO_ROOT, full).split(sep).join('/'),
          source: readFileSync(full, 'utf8'),
        },
      ];
    });
}
