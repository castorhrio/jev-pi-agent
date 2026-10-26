/**
 * An independent oracle for `blankComments()`.
 *
 * ## Why an oracle, and why not another fixture
 *
 * Every round of work on `source-scan.ts` has ended the same way: a gate
 * misread a spelling, the spelling was added to a fixture, and the next one
 * was found later — by a reader, or by a failure somewhere else. Fixtures are
 * still the right way to pin a *known* shape (they name what the walk must
 * read), but they cannot answer "is there a shape nobody has thought of yet?"
 *
 * A TypeScript parser can. `@typescript-eslint/typescript-estree` is already
 * in the toolchain (it is what `typescript-eslint` lints with), so this test
 * asks it for the comment ranges in the same text and compares the two
 * readings byte by byte:
 *
 *  - every byte inside a parser-reported comment is a space in
 *    `blankComments()`, except newlines, which stay newlines;
 *  - every byte outside every comment is unchanged.
 *
 * It is deliberately not a second implementation of the same heuristic. The
 * oracle knows nothing about regex literals, template interpolations or
 * control-flow parens; it only knows what the language's parser knows. That is
 * what makes an agreement meaningful: two unrelated ways of deciding where
 * comments are.
 *
 * ## Real sources, not only fixtures
 *
 * The walk below reads every `.ts`/`.tsx` file under `apps/desktop/src`,
 * `packages/*` and `tests/contract` — the repository's own code, including
 * this suite's fixtures. A file that disagrees fails here and names the line
 * and column, rather than waiting for a downstream gate to lose a call.
 *
 * ## The known-differences list
 *
 * A real disagreement is not automatically a bug in `blankComments()`; a
 * parser can read a construct the walk deliberately refuses (the module doc
 * in `source-scan.ts` names `}` as the unexamined lossy direction). Such a
 * file goes in `KNOWN_DIFFERENCES` with the reason, explicitly, and the test
 * then stops asserting on it. The list is checked in both directions: an
 * unexpected difference fails, and an entry that no longer differs fails too,
 * so a stale exemption cannot outlive the bug it was written for.
 *
 * Add an entry only after deciding which reading is right. "The scanner is
 * wrong" means fix the scanner and the fixture; "the scanner's refusal is
 * deliberate" means write why here. Do not add an entry to get green.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, type Dirent } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '@typescript-eslint/typescript-estree';

import { blankComments } from './source-scan';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(here, '../..');
const FIXTURES = path.join(here, 'fixtures/scan');

/** A file whose two readings are allowed to differ, and why. */
interface KnownDifference {
  /** repo-relative, forward slashes */
  readonly file: string;
  readonly reason: string;
}

/**
 * The accepted disagreements. Empty today: every source in the repository
 * agrees with the parser. An entry here exempts the whole file, so it is a
 * decision about a construct, not a way to silence one line.
 */
const KNOWN_DIFFERENCES: readonly KnownDifference[] = [];

/** A comment range as the parser reports it: UTF-16 code-unit offsets. */
interface CommentRange {
  readonly start: number;
  readonly end: number;
}

/** One place the two readings disagree, with the position a reader needs. */
interface Difference {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly detail: string;
}

/** Every `.ts`/`.tsx` file under a directory, skipping build and vendor trees. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'release') {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      sourceFiles(full, out);
    } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
      out.push(full);
    }
  }
  return out;
}

/** The parser's comment ranges for `source`. */
function parserComments(source: string, file: string): CommentRange[] {
  const program = parse(source, {
    range: true,
    loc: false,
    comment: true,
    // `.tsx` allows JSX; `.ts` must not, or `const x = <T>y` would be read as
    // an element. The extension is the only thing the parser is told.
    jsx: file.endsWith('.tsx'),
    filePath: file,
  });
  return (program.comments ?? []).map((comment) => ({
    start: comment.range[0],
    end: comment.range[1],
  }));
}

/** Line and column (1-based) of a code-unit offset. */
function positionAt(source: string, offset: number): { line: number; column: number } {
  let line = 1;
  let column = 1;
  for (let i = 0; i < offset; i += 1) {
    if (source[i] === '\n') {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { line, column };
}

/** What a display of the byte says when it is invisible or a quote. */
function byte(text: string): string {
  return text === '\n' ? '\\n' : JSON.stringify(text);
}

/**
 * Every disagreement between `blanker` and the parser for one source.
 *
 * `blanker` is a parameter rather than `blankComments` here so the comparison
 * itself can be shown going red (a blanker that leaves comments in place, or
 * one that blanks code) instead of only ever running over a source that
 * agrees. The real assertions pass `blankComments`.
 */
function differences(
  source: string,
  file: string,
  blanker: (text: string) => string = blankComments,
): Difference[] {
  const blanked = blanker(source);
  if (blanked.length !== source.length) {
    return [
      {
        file,
        line: 1,
        column: 1,
        detail: `the blanker changed the length: ${source.length} -> ${blanked.length} bytes`,
      },
    ];
  }

  const inComment = new Uint8Array(source.length);
  for (const range of parserComments(source, file)) {
    for (let i = range.start; i < range.end; i += 1) inComment[i] = 1;
  }

  const out: Difference[] = [];
  for (let i = 0; i < source.length; i += 1) {
    const original = source[i]!;
    const actual = blanked[i]!;
    let detail: string | null = null;
    if (inComment[i]) {
      if (original === '\n') {
        if (actual !== '\n') {
          detail = `a newline inside a comment became ${byte(actual)}`;
        }
      } else if (actual !== ' ') {
        detail = `a comment byte ${byte(original)} survived as ${byte(actual)}`;
      }
    } else if (actual !== original) {
      detail = `code byte ${byte(original)} became ${byte(actual)} outside every comment`;
    }
    if (detail !== null) {
      const { line, column } = positionAt(source, i);
      out.push({ file: relative(file), line, column, detail });
      if (out.length >= 20) return out;
    }
  }
  return out;
}

/** A repo-relative path, as every failure message should print it. */
function relative(file: string): string {
  return path.relative(REPO_ROOT, file).split(path.sep).join('/');
}

/** Differences that are not covered by an entry in `KNOWN_DIFFERENCES`. */
function unexpectedDifferences(
  observed: readonly Difference[],
  known: readonly KnownDifference[],
): Difference[] {
  const exempt = new Set(known.map((entry) => entry.file));
  return observed.filter((entry) => !exempt.has(entry.file));
}

/** Known entries whose file no longer differs at all. */
function staleKnownDifferences(
  observed: readonly Difference[],
  known: readonly KnownDifference[],
): string[] {
  const differing = new Set(observed.map((entry) => entry.file));
  return known.filter((entry) => !differing.has(entry.file)).map((entry) => entry.file);
}

describe('the parser is an independent oracle for comment blanking', () => {
  it('can go red when a comment is left in place', () => {
    // The comparison is only worth something if it can fail. `identity` is a
    // blanker that reads every comment as code — the exact bug class this
    // module exists to avoid — and the oracle has to name it.
    const source = readFileSync(path.join(FIXTURES, 'comments.ts'), 'utf8');
    const found = differences(source, path.join(FIXTURES, 'comments.ts'), (text) => text);
    expect(found.length, 'a blanker that blanked nothing was accepted').toBeGreaterThan(0);
    expect(found[0]!.detail).toContain('comment byte');
  });

  it('can go red when code is blanked', () => {
    // The other direction: the walk losing source is the failure that hides
    // calls from a gate, and it must not look like agreement.
    const source = 'const value = 1; // comment\n';
    const found = differences(source, 'inline.ts', (text) => text.replace(/[^\s]/g, ' '));
    expect(found.length, 'a blanker that erased code was accepted').toBeGreaterThan(0);
    expect(found.some((entry) => entry.detail.includes('outside every comment'))).toBe(true);
  });

  it('keeps the known-differences list honest in both directions', () => {
    // The exemption list is the one place a disagreement can hide, so its
    // maintenance rule is pinned rather than trusted: an unlisted difference
    // is reported, a listed one is accepted, and an entry whose file no longer
    // differs is reported too.
    const observed: Difference[] = [
      { file: 'a.ts', line: 1, column: 1, detail: 'a comment byte survived' },
    ];
    expect(unexpectedDifferences(observed, []), 'an unlisted difference was accepted').toHaveLength(
      1,
    );
    expect(
      unexpectedDifferences(observed, [{ file: 'a.ts', reason: 'the walk refuses the shape' }]),
    ).toEqual([]);
    expect(
      staleKnownDifferences(observed, [{ file: 'b.ts', reason: 'no longer true' }]),
      'a stale exemption was accepted',
    ).toEqual(['b.ts']);
    expect(staleKnownDifferences(observed, [{ file: 'a.ts', reason: 'still true' }])).toEqual([]);
  });

  it('reads a line comment, a block comment and an interpolation comment as comments', () => {
    // The fixtures first, so a failure below is about the tree rather than
    // about the oracle having stopped seeing comments altogether. This also
    // pins the parser's reading of the shapes the walk was built for:
    // `//` in a string, `//` in template text, `/[//]/`, and a comment inside
    // `${…}`.
    for (const name of readdirSync(FIXTURES).filter((file) => file.endsWith('.ts'))) {
      const file = path.join(FIXTURES, name);
      const source = readFileSync(file, 'utf8');
      expect(parserComments(source, file).length, `${name} has no comments to compare`).toBeGreaterThan(
        0,
      );
      expect(differences(source, file), `${name} disagrees with the parser`).toEqual([]);
    }
  });

  it('agrees with the parser on every source the repository ships', () => {
    // The active half: today's repository has no disagreement at all, so this
    // is a real oracle rather than a list of exceptions. A new construct the
    // walk misreads fails here, before a downstream gate loses a call.
    const roots = [
      path.join(REPO_ROOT, 'apps/desktop/src'),
      path.join(REPO_ROOT, 'packages'),
      path.join(REPO_ROOT, 'tests/contract'),
    ];
    for (const root of roots) {
      expect(
        sourceFiles(root).length,
        `the oracle read no sources under ${relative(root)}`,
      ).toBeGreaterThan(0);
    }
    const files = roots.flatMap((root) => sourceFiles(root));
    expect(files.length, 'the oracle found no sources at all').toBeGreaterThan(0);

    const observed = files.flatMap((file) => differences(readFileSync(file, 'utf8'), file));
    expect(
      unexpectedDifferences(observed, KNOWN_DIFFERENCES).slice(0, 5),
      'blankComments() disagrees with the TypeScript parser. Fix the walk (and add a fixture) ' +
        'or, if the refusal is deliberate, add the file to KNOWN_DIFFERENCES with the reason.',
    ).toEqual([]);
    expect(
      staleKnownDifferences(observed, KNOWN_DIFFERENCES),
      'a KNOWN_DIFFERENCES entry names a file that no longer differs; remove the exemption',
    ).toEqual([]);
  });
});
