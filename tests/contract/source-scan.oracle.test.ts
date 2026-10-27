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
 * then stops asserting on that one disagreement.
 *
 * **The list cannot become a list of approved files, and that is the point of
 * its shape.** An entry is a *pinned pattern*, not a file name: it carries the
 * exact disagreement it is excused from (`shape`, a `RegExp` matched against
 * the byte-level detail the comparison prints) as well as the reason. So an
 * exemption covers the construct somebody decided about and nothing else —
 * anything new that the walk misreads in that same file still fails, and an
 * entry whose pattern no longer matches anything is reported as stale rather
 * than quietly keeping the file exempt forever.
 *
 * Empty is the strongest setting, not the weakest: with no entries nothing is
 * excused, so the assertion below reduces to "the parser and the walk agree on
 * every shipped source". That direction is pinned too (`unexpectedDifferences`
 * with an empty list returns everything it observed), so an empty list cannot
 * turn into a filter that answers `[]` for input it never looked at.
 *
 * Add an entry only after deciding which reading is right. "The scanner is
 * wrong" means fix the scanner and the fixture; "the scanner's refusal is
 * deliberate" means write the pattern and why here. Do not add an entry to get
 * green, and do not widen an entry's pattern to cover the next failure.
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

/** One accepted disagreement: which file, which pattern, and why. */
interface KnownDifference {
  /** repo-relative, forward slashes */
  readonly file: string;
  /** The exact disagreement this entry excuses, matched against `detail`. */
  readonly shape: RegExp;
  readonly reason: string;
}

/**
 * The accepted disagreements. Empty today: every source in the repository
 * agrees with the parser.
 *
 * An entry is deliberately *two* facts — a pinned `shape` and a `reason` — so
 * that adding one is a decision about a construct rather than about a file.
 * The list is a value here rather than prose in a pull request because the
 * difference that motivated an exemption is a fact about bytes, and a sentence
 * ("the walk misreads this file") cannot be checked while a pattern can. See
 * `malformedKnownDifferences`, `unexpectedDifferences` and
 * `staleKnownDifferences` for what each half is held to.
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

/** Whether an entry deliberately covers this one disagreement. */
function exempts(entry: KnownDifference, difference: Difference): boolean {
  // Both halves have to agree. A file-only exemption is what turns an oracle
  // into a hand-approved exception table: the next misread in that file would
  // then be excused by an entry written about a different construct.
  return entry.file === difference.file && entry.shape.test(difference.detail);
}

/** Differences that no entry in `KNOWN_DIFFERENCES` excuses. */
function unexpectedDifferences(
  observed: readonly Difference[],
  known: readonly KnownDifference[],
): Difference[] {
  return observed.filter(
    (difference) => !known.some((entry) => exempts(entry, difference)),
  );
}

/** Known entries that excuse nothing any more, as `file: /shape/`. */
function staleKnownDifferences(
  observed: readonly Difference[],
  known: readonly KnownDifference[],
): string[] {
  return known
    .filter((entry) => !observed.some((difference) => exempts(entry, difference)))
    .map((entry) => `${entry.file}: ${String(entry.shape)}`);
}

/**
 * Whether a pattern is no pattern at all.
 *
 * A `RegExp` that can match the empty string matches *every* detail, because
 * `.test()` succeeds the moment one position matches nothing. That is the
 * "approved file" exemption wearing a pattern's clothes — it would cover the
 * next misread in the file as well as the one somebody thought about — so it is
 * refused by name rather than accepted as a technically-valid entry.
 */
function matchesEveryDetail(shape: RegExp): boolean {
  return shape.source.trim() === '' || shape.test('');
}

/**
 * Entries that are not pinned to a shape a reader could check.
 *
 * The list is the one place a disagreement can hide, so its entries are held to
 * a form the comparison can verify: a `RegExp` that actually distinguishes the
 * disagreement from every other one (see `matchesEveryDetail`), a repo-relative
 * `.ts` path, and a reason that says which reading is right. Types are not enough here —
 * `tests/` belongs to no tsc project, so an entry written with a string where
 * the pattern belongs would compile everywhere and exempt nothing (or, worse,
 * be coerced into a match-everything pattern by a later rewrite).
 */
function malformedKnownDifferences(known: readonly KnownDifference[]): string[] {
  return known.flatMap((entry) => {
    const problems: string[] = [];
    // Repo-relative and a source file: an absolute path or a `..` segment is a
    // path from somebody else's machine, and a path that points at the wrong
    // file would make the exemption look live while it excused nothing.
    const segments = entry.file.split('/');
    if (
      !/^[\w./-]+\.tsx?$/.test(entry.file) ||
      segments.includes('..') ||
      !/^[\w.-]/.test(entry.file)
    ) {
      problems.push('file is not a repo-relative .ts path');
    }
    if (!(entry.shape instanceof RegExp)) problems.push('shape is not a RegExp');
    else if (matchesEveryDetail(entry.shape)) problems.push('shape matches every detail');
    if (entry.reason.trim() === '') problems.push('no reason given');
    return problems.map((problem) => `${entry.file || '<no file>'}: ${problem}`);
  });
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
    // is reported, a listed one is accepted, and an entry that no longer
    // excuses anything is reported too.
    const observed: Difference[] = [
      { file: 'a.ts', line: 1, column: 1, detail: 'a comment byte "/" survived' },
    ];
    const entry: KnownDifference = {
      file: 'a.ts',
      shape: /comment byte/,
      reason: 'the walk refuses the shape',
    };
    expect(unexpectedDifferences(observed, []), 'an unlisted difference was accepted').toHaveLength(
      1,
    );
    expect(unexpectedDifferences(observed, [entry])).toEqual([]);
    expect(
      staleKnownDifferences(observed, [
        { file: 'b.ts', shape: /comment byte/, reason: 'no longer true' },
      ]),
      'a stale exemption was accepted',
    ).toHaveLength(1);
    expect(staleKnownDifferences(observed, [entry])).toEqual([]);
    // And the shipped list is held to the same form: an entry written as free
    // text would be an exemption nobody can check.
    expect(malformedKnownDifferences(KNOWN_DIFFERENCES), 'an exemption is not pinned').toEqual([]);
  });

  it('reads an empty exemption list as “no difference is acceptable”', () => {
    // The direction the real assertion below depends on: with no entries,
    // *every* observed difference is unexpected, so an empty list is the
    // strongest setting rather than the weakest. Pinned because the failure
    // mode is silent — a `filter` that answered `[]` for input it had not
    // looked at would make the oracle green about a source nobody compared.
    const observed: Difference[] = [
      { file: 'a.ts', line: 1, column: 1, detail: 'a comment byte "/" survived' },
      { file: 'b.ts', line: 7, column: 2, detail: 'code byte "d" became " " outside every comment' },
    ];
    expect(unexpectedDifferences(observed, []), 'an empty list excused a difference').toEqual(
      observed,
    );
    expect(unexpectedDifferences([], []), 'an empty list reported a difference it never saw').toEqual(
      [],
    );
    expect(staleKnownDifferences(observed, []), 'an empty list has nothing to go stale').toEqual([]);
  });

  it('exempts the disagreement an entry describes, not the file it lives in', () => {
    // The difference between an oracle with exceptions and an approved-file
    // table. Both differences below are in `a.ts`; the entry was written about
    // the first one, so the second still fails — which is what makes the
    // exemption a decision about a construct.
    const commentSurvived: Difference = {
      file: 'a.ts',
      line: 1,
      column: 1,
      detail: 'a comment byte "/" survived as "/"',
    };
    const codeLost: Difference = {
      file: 'a.ts',
      line: 9,
      column: 3,
      detail: 'code byte "d" became " " outside every comment',
    };
    const entry: KnownDifference = {
      file: 'a.ts',
      shape: /comment byte/,
      reason: 'the walk refuses a slash inside a character class',
    };

    expect(unexpectedDifferences([commentSurvived], [entry])).toEqual([]);
    expect(
      unexpectedDifferences([codeLost], [entry]),
      'an entry excused a different disagreement in the same file, so the list is an approved-file table',
    ).toEqual([codeLost]);
    expect(
      unexpectedDifferences([commentSurvived, codeLost], [entry]),
      'the pinned entry stopped working when it shared a run with another difference',
    ).toEqual([codeLost]);

    // Staleness is a fact about the pattern, not about the file: the entry
    // above stays live while a difference it describes is still observed, and
    // goes stale the moment only other differences remain.
    expect(staleKnownDifferences([commentSurvived], [entry])).toEqual([]);
    expect(
      staleKnownDifferences([codeLost], [entry]),
      'an entry whose pattern matched nothing was treated as live',
    ).toHaveLength(1);
  });

  it('refuses an exemption written as free text', () => {
    // `tests/` is in no tsc project, so the interface is documentation here
    // and the runtime check is the gate. An entry with a string where the
    // pattern belongs, or with no reason, is a difference somebody approved by
    // hand — exactly what the shape requirement exists to prevent.
    const asText = { file: 'a.ts', shape: 'comment byte', reason: 'the walk refuses it' };
    const noReason = { file: 'a.ts', shape: /comment byte/, reason: '  ' };
    const matchesEverything = { file: 'a.ts', shape: /(?:)/, reason: 'whatever it was' };
    const notAPath = { file: '/abs/a.ts', shape: /comment byte/, reason: 'the walk refuses it' };

    expect(malformedKnownDifferences([asText as unknown as KnownDifference])).toEqual([
      'a.ts: shape is not a RegExp',
    ]);
    expect(malformedKnownDifferences([noReason])).toEqual(['a.ts: no reason given']);
    expect(malformedKnownDifferences([matchesEverything])).toEqual([
      'a.ts: shape matches every detail',
    ]);
    expect(malformedKnownDifferences([notAPath])).toEqual([
      '/abs/a.ts: file is not a repo-relative .ts path',
    ]);
    // The positive control: a well-formed entry passes, so the answers above
    // are not the function refusing everything.
    expect(
      malformedKnownDifferences([
        { file: 'apps/desktop/src/main/app-container.ts', shape: /^code byte/, reason: 'deliberate' },
      ]),
    ).toEqual([]);
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
      'a KNOWN_DIFFERENCES entry excuses nothing any more — the file is clean, or its pinned ' +
        'pattern no longer matches the difference it was written for. Remove the entry rather ' +
        'than widening its pattern.',
    ).toEqual([]);
  });
});
