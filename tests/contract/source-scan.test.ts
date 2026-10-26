/**
 * The blanking walk, tested where it is decided rather than where it is used.
 *
 * ## Why this file exists
 *
 * `source-scan.ts` is the single walk behind every gate that reads product
 * *code* out of source text — the update channel's construction scan, the
 * container's guard-scope scan, the scheme-literal count. Each of those gates
 * has fixtures of its own, and each of those fixtures is about the question the
 * gate asks. What none of them can show is the walk itself: a shape the walk
 * misreads is a shape every gate misreads, and the failure arrives as "the
 * count disagrees" or, worse, as nothing at all.
 *
 * The walk's blind spots have been found twice this way. The first was a regex
 * literal containing `//` (`/[//]/`), which was read as the start of a comment;
 * the second is the subject of the cases below — a template literal, which used
 * to be one more `quote` state, so everything between the backticks was "text",
 * `${…}` included.
 *
 * Reading an interpolation as text is wrong in both directions, and both are
 * pinned here:
 *
 *  - a comment inside `${…}` stayed verbatim, so prose was visible to a gate
 *    that asks about code — a `// this.requireStarted('db', this.db)` inside an
 *    interpolation counted as a guarded field;
 *  - a backtick inside such a comment closed the template early, and the rest
 *    of the source was read in the wrong state. The state after a stray
 *    backtick is *text*, where `//` is not a comment, so a real comment went on
 *    being read as code — the direction that makes a gate red about a comment
 *    nobody can fix.
 *
 * ## The shape of the cases
 *
 * Each one is a small source string, the blanking of it, and — where it
 * matters — a question a real gate would ask of the result. Asserting only
 * "the comment is gone" would leave the walk's *bookkeeping* untested: which
 * state it is in afterwards, whether the `/` after a closing backtick divides,
 * whether the positions still line up with the original so a failure message
 * points at the right line. Those are the parts a refactor breaks silently, so
 * they are asserted too.
 */

import { describe, expect, it } from 'vitest';

import { blankComments } from './source-scan';

/**
 * The walk's answer for one source, with its invariants checked on the way
 * through.
 *
 * Every case below goes through this: blanking must never change the length of
 * the source or the number of newlines in it, because every gate reports a
 * failure as `file:line` computed from `slice(0, index).split('\n')`. A walk
 * that dropped a byte would move every line number after it and still look
 * right in the test that only checks "the comment is gone".
 *
 * ## Why the third check is byte-by-byte
 *
 * Length and newline count are two totals, and two totals can agree while the
 * text has moved: emit one byte too many early on and one too few later, and a
 * shifted walk passes both. What every gate actually relies on is stronger —
 * an index into the blanked text is the *same* index in the original — so each
 * non-whitespace byte is compared with the source at its own index.
 *
 * The comparison is one-sided on purpose: blanked regions are spaces, so a
 * whitespace byte is skipped rather than compared (comment content is
 * *supposed* to differ there). Code, strings and regex literals must be
 * byte-identical where they sit, and that is what a refactor which re-emits
 * text in a different order breaks silently.
 */
function blank(source: string): string {
  const blanked = blankComments(source);
  expect(blanked.length, 'blanking changed the length of the source').toBe(source.length);
  expect(
    blanked.split('\n').length,
    'blanking changed the number of lines in the source',
  ).toBe(source.split('\n').length);

  const moved: string[] = [];
  for (let index = 0; index < source.length; index += 1) {
    const after = blanked[index]!;
    // Blanked comment content, and the source's own whitespace, are spaces:
    // nothing to compare, and nothing a gate could report a position from.
    if (/\s/.test(after)) continue;
    if (after !== source[index]) {
      moved.push(`${index}: ${JSON.stringify(source[index])} became ${JSON.stringify(after)}`);
    }
  }
  expect(
    moved,
    'a non-comment byte is no longer at the index it came from, so every `file:line` ' +
      'a gate prints from this text points somewhere else',
  ).toEqual([]);

  return blanked;
}

/** The text of a source with comments blanked, spaces collapsed — for prose-free comparison. */
function compact(source: string): string {
  return blank(source).replace(/\s+/g, ' ').trim();
}

describe('a template literal is text, and its interpolation is code', () => {
  it('blanks a block comment inside an interpolation', () => {
    // The shape from the bug report, and the one a reader writes without
    // thinking: a comment where the interpolation's expression sits. It is
    // code, so its comment is a comment — blanked like any other.
    const source = 'const x = `${a /* not a comment */ }`;';
    expect(compact(source)).toBe('const x = `${a }`;');
    expect(blank(source)).not.toContain('not a comment');
  });

  it('blanks a line comment inside an interpolation without eating the closing brace', () => {
    // The comment runs to the end of *its* line, and the interpolation can
    // continue on the next one. A walk that blanked past the newline would take
    // the `}` with it and then read the rest of the file inside a template.
    const source = ['const x = `${a // why', '  + b}`;', 'const y = 1;'].join('\n');
    expect(blank(source)).toContain('}`;');
    expect(compact(source)).toBe('const x = `${a + b}`; const y = 1;');
  });

  it('does not close the template on a backtick inside an interpolation comment', () => {
    // The stray-backtick case. Read as a `quote` state, the first backtick
    // closed the template — a backtick in the middle of a comment, which is
    // exactly where a reader would put one to talk about templates.
    const source = 'const s = `${a /* a ` in a comment */}`;\nconst after = 1;';
    expect(compact(source)).toBe('const s = `${a }`; const after = 1;');
    expect(blank(source), 'the comment survived, so the walk never entered it').not.toContain(
      'in a comment',
    );
  });

  it('does not close the template on a quote inside an interpolation', () => {
    // A string inside the interpolation is code: its quotes belong to it, and
    // its commas and braces are not the template's.
    const source = "const s = `${f('}', \"`\")}`; const after = 2;";
    expect(compact(source)).toBe("const s = `${f('}', \"`\")}`; const after = 2;");
    // And the walk is back in code afterwards: the comment after the statement
    // is blanked, which it could not be if the template were still open.
    expect(blank(`${source} // done`)).not.toContain('done');
  });

  it('counts braces inside an interpolation, so an object literal closes nothing', () => {
    // `${{ a: 1 }}` is legal and the first `}` is the object's. A walk that
    // closed the frame at the first brace would leave the second `}` and the
    // closing backtick being read as code, where they are not.
    expect(compact('const s = `${ { a: 1 } }`; const after = 3;')).toBe(
      'const s = `${ { a: 1 } }`; const after = 3;',
    );
    // Same with a block-bodied arrow function inside the interpolation, where
    // the braces nest one deeper.
    expect(compact('const s = `${(() => { return 1; })()}`; const after = 4;')).toBe(
      'const s = `${(() => { return 1; })()}`; const after = 4;',
    );
  });

  it('keeps template text verbatim, including slashes and braces', () => {
    // Text is what a user sees: `//` in it is not a comment, and neither `{`
    // nor `}` is anything to count.
    expect(compact('const s = `a // b { c }`; const after = 5;')).toBe(
      'const s = `a // b { c }`; const after = 5;',
    );
  });

  it('handles a template nested inside an interpolation', () => {
    // The shape that needs a stack rather than a flag: the inner template is
    // text, the code between the two `${…}` frames is code, and the closing
    // backticks come off in the order they went on.
    const source = 'const s = `${`inner ${x /* c */}`}`; const after = 6;';
    expect(compact(source)).toBe('const s = `${`inner ${x }`}`; const after = 6;');
    expect(blank(source), 'the inner interpolation\'s comment survived').not.toContain('/* c */');
    // And the same characters in *text* are text: the outer frame is not code,
    // so a comment written there is what the user asked to print.
    expect(compact('const s = `${`inner ${x}`} /* kept */`;')).toContain('/* kept */');
  });

  it('reads a regex literal inside an interpolation as a regex', () => {
    // The operand heuristic has to work inside the frame too: `${` starts code
    // where a value is expected, so `/[//]/` is a literal, not a comment.
    expect(compact('const s = `${/[//]/.test(x)}`; const after = 7;')).toBe(
      'const s = `${/[//]/.test(x)}`; const after = 7;',
    );
  });

  it('leaves the walk in code after the closing backtick', () => {
    // The bookkeeping the states share with regex literals: a closed template is
    // a *value*, so the `/` after it divides rather than opening a literal —
    // and a `//` after it is still a comment.
    expect(blank('const half = `${n}` / 2; // third')).not.toContain('third');
    expect(compact('const half = `${n}` / 2;')).toBe('const half = `${n}` / 2;');
  });
});

describe('a slash is a division where a value already ended', () => {
  it('reads chained division as division, and blanks the comment after it', () => {
    expect(compact('const q = a / b / c; // comment')).toBe('const q = a / b / c;');
    // The comment is not merely "not counted": it is gone, which is the half a
    // `toContain` on the code cannot see.
    expect(blank('const q = a / b / c; // comment')).not.toContain('comment');
  });

  it('reads a slash after a closing brace as division', () => {
    // `x = {} / 2` is silly code and legal arithmetic: `}` ends a value, so the
    // `/` divides. Read as a regex literal it would swallow the rest of the
    // line — the direction that loses source.
    expect(compact('x = {} / 2; // comment')).toBe('x = {} / 2;');
    expect(blank('x = {} / 2; // comment')).not.toContain('comment');
  });

  it('reads a slash after a bracketed, called, numeric or boolean value as division', () => {
    // The `}` case above shares a branch with every other way a value ends:
    // `startsRegexLiteral` treats `[\w$)\]]` as "a value just ended" and `}`
    // as its own case. The matrix pins the spellings that reach the first
    // branch — an index (`]`), a call (`)`), a number and a boolean — because
    // one regex covers them: moving any spelling to the operand side would
    // turn exactly that line into a swallowed comment, which no other fixture
    // here would catch.
    const cases: ReadonlyArray<readonly [source: string, code: string]> = [
      ['const q = arr[i] / 2; // comment', 'const q = arr[i] / 2;'],
      ['const q = f() / 2; // comment', 'const q = f() / 2;'],
      ['const q = 1 / 2; // comment', 'const q = 1 / 2;'],
      ['const q = true / 1; // comment', 'const q = true / 1;'],
      // Optional chaining: the value ends at the property name, and the `?.`
      // before it is part of the access rather than the `?` operator — a walk
      // that keyed on the `?` would read the `/` as a literal and swallow the
      // rest of the line.
      ['const q = obj?.a / 2; // comment', 'const q = obj?.a / 2;'],
      ['const q = obj?.[i] / 2; // comment', 'const q = obj?.[i] / 2;'],
      ['const q = obj?.() / 2; // comment', 'const q = obj?.() / 2;'],
      // A `#`-private field: the `#` is part of the name, so what ends the value
      // is the name. Spelled out because `#` is not in either punctuation set,
      // which makes the outcome depend on the name being emitted.
      ['const q = this.#count / 2; // comment', 'const q = this.#count / 2;'],
      // A TypeScript assertion: `as Foo` ends in an identifier like any other
      // value, so the `/` divides.
      ['const q = x as Foo / 2; // comment', 'const q = x as Foo / 2;'],
    ];
    for (const [source, code] of cases) {
      expect(compact(source), `${source} was read as a regex literal`).toBe(code);
      // The comment is gone, not merely uncounted: a literal attempt that ran
      // past the `//` would leave it readable in the blanked text.
      expect(blank(source), `${source} left its comment readable`).not.toContain('comment');
    }
  });

  it('keeps a closed interpolation a value, even with another one right behind it', () => {
    // `}${` adjacency: the `}` that closes one interpolation and the `$` that
    // opens the next are two frames' business, and the backtick that finally
    // closes the template is a value like any other. Read as an opening
    // position, the `/` after it would start a literal attempt that runs to the
    // end of the line and falls back — leaving the comment below readable.
    const source = 'const s = `${a}${b}` / 2; // comment';
    expect(compact(source)).toBe('const s = `${a}${b}` / 2;');
    expect(blank(source)).not.toContain('comment');
  });

  it('reads a slash after return as a regex literal, flags and all', () => {
    // The other side of the same heuristic: `return` asks for a value, so the
    // literal is a literal — and the `//` that would otherwise look like a
    // comment is inside it.
    expect(blank('return /re/g; // comment')).toContain('/re/g');
    expect(blank('return /re/g; // comment')).not.toContain('comment');
    expect(compact('const ok = /a[/]b/.test(s); // next')).toBe('const ok = /a[/]b/.test(s);');
  });

  it('does not mistake a regex literal for a comment when it holds two slashes', () => {
    // The first blind spot, kept here because the walk is shared: a slash needs
    // no escape inside a character class, so `/[//]/` is a valid literal and
    // the rest of its line must survive.
    const blanked = blank("const re = /[//]/; const kept = 1; // gone");
    expect(blanked).toContain('const kept = 1;');
    expect(blanked).not.toContain('gone');
  });

  it('falls back to division when a regex attempt runs off the end of the line', () => {
    // `/` at operand position with no closing slash on the line is division by
    // the conservative reading: the literal attempt stops at the newline and
    // the character is emitted as it was found. Pinned because the alternative
    // (swallowing the line) is the silent loss this module exists to remove.
    const source = 'const ratio = (a + b) / c; // note';
    expect(blank(source)).not.toContain('note');
    expect(blank(source)).toContain('const ratio = (a + b) / c;');
  });
});

/**
 * The other half of the heuristic, and the one place the bias had it backwards.
 *
 * Everything above asks "is this `/` a division?". This asks the reverse — "is
 * this `/` a literal?" — because a walk that answers "division" too eagerly is
 * the *lossy* direction: the `//` inside `/[//]/` then reaches the scanner, the
 * rest of the line is blanked, and the code after it is simply gone.
 *
 * The case is the `)` that closes a control-flow header. `if (x) /re/.test(s)`
 * is valid code, and the character in front of the `/` is `)` — which the
 * value-end rule reads as "a call just ended". It is not a call: an `if (…)`
 * header is followed by a *statement*. These fixtures were written as reverse
 * assertions, expecting to be green, and came back red.
 */
describe('a slash after a control-flow condition opens a regex literal', () => {
  it('keeps the literal, and still blanks the comment that follows it', () => {
    // The plain reading first: `/re/` is code and must survive verbatim, and
    // `// c` after it is a comment and must not. Both halves in one assertion
    // pair, because "the comment is gone" alone would be satisfied by a walk
    // that blanked the literal too.
    const source = 'if (x) /re/.test(s); // c';
    expect(blank(source)).toContain('if (x) /re/.test(s);');
    expect(blank(source)).not.toContain('// c');
  });

  it('keeps the two slashes inside a character class, so the rest of the line survives', () => {
    // The discriminating shape: `/[//]/` is where a wrong "division" answer
    // stops being cosmetic. Read as division, the two slashes in the class
    // reach the scanner as `//`, the rest of the line is blanked, and
    // `const kept = 1` disappears — source loss, silently, which is the whole
    // reason this module exists.
    const source = 'if (x) /[//]/.test(s); const kept = 1; // gone';
    const blanked = blank(source);
    expect(blanked).toContain('if (x) /[//]/.test(s);');
    expect(blanked, 'the code after the literal was swallowed').toContain('const kept = 1;');
    expect(blanked).not.toContain('gone');
  });

  it('reads while and for headers the same way', () => {
    // The keyword list is the whole mechanism, so it is driven for each word
    // that can end a statement header. A loop condition is the realistic
    // spelling of "a `)` that is not a call".
    for (const header of ['while (m = re.exec(s))', 'for (const n of xs)']) {
      const source = `${header} /[//]/.test(n); const kept = 1; // gone`;
      const blanked = blank(source);
      expect(blanked, `${header} had its literal read as division`).toContain(
        `${header} /[//]/.test(n);`,
      );
      expect(blanked, `${header} swallowed the code after it`).toContain('const kept = 1;');
      expect(blanked).not.toContain('gone');
    }
  });

  it('still reads a slash after a call or an operand as division', () => {
    // The control for the three cases above. It is the `(`'s leading *word*
    // that makes the difference, not the `)` itself: a call's paren records
    // the callee's name, so `f(x) / 2` divides as it always did — and so does
    // a `/` that comes after a value inside an `if` body, where the statement
    // position ended at the first byte written after the header.
    expect(compact('const q = f(x) / 2; // c')).toBe('const q = f(x) / 2;');
    expect(compact('if (x) y / 2; // c')).toBe('if (x) y / 2;');
    expect(compact('while (n) n / 2; // c')).toBe('while (n) n / 2;');
    // …and the nested shape, where the inner `)` closes a call inside the
    // header and the outer one closes the condition. Only a stack keeps the two
    // apart: the outer `)` must not be read as the call's.
    expect(blank('if (f(a)) /[//]/.test(s); const kept = 1; // gone')).toContain('const kept = 1;');
  });

  it('survives a newline between the header and the statement', () => {
    // A statement position is not "the character after `)`": Prettier wraps a
    // long condition, and the literal can be on the next line. The flag has to
    // live across whitespace and newlines and die at the first real byte.
    const source = ['if (x)', '  /[//]/.test(s);', 'const kept = 1; // gone'].join('\n');
    const blanked = blank(source);
    expect(blanked).toContain('/[//]/.test(s);');
    expect(blanked, 'the wrapped statement lost its literal and the line after it').toContain(
      'const kept = 1;',
    );
    expect(blanked).not.toContain('gone');
  });
});

describe('the walk keeps its positions', () => {
  it('leaves every non-comment byte where it was', () => {
    const source = ['const s = `${a /* c */}`;', 'const t = `x // y`;', 'const u = 1;'].join('\n');
    const blanked = blank(source);
    // The blanking is spaces, so a gate that reports `line:column` from an index
    // in the blanked text still points at the same character.
    expect(blanked.indexOf('const u')).toBe(source.indexOf('const u'));
    expect(blanked).toContain('const t = `x // y`;');
  });

  it('is idempotent, so a gate may blank a blanked source', () => {
    // Not a claim about the gates — it is a claim about the walk that makes the
    // shared module safe to compose, and it fails loudly if a state ever leaks
    // into the output (a blanked comment that reads as a quote, say).
    const source = 'const s = `${a /* c */}`; // trailing\nconst t = `x`; /* block */';
    const once = blank(source);
    expect(blankComments(once)).toBe(once);
  });
});
