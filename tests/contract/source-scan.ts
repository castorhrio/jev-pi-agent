/**
 * Source text with every comment blanked, and every other byte where it was.
 *
 * ## Why this is a module rather than a local helper
 *
 * Two gates in this suite read product sources to answer questions about
 * *code* — "is this `beforeLaunch` seam passed anywhere in the main process",
 * "which fields does the retention bag ask the guard for". Both of them had
 * their own copy of this walk, and both copies carried the same blind spot,
 * stated in a comment instead of being fixed: a regex literal containing two
 * adjacent slashes (`/[//]/`, which is valid — `/` needs no escape inside a
 * character class) was read as the start of a `//` comment.
 *
 * The consequence was the wrong way round. The rest of that line was blanked,
 * so code sitting after the literal became invisible: a guarded call
 * disappeared from the count (loud — the count then disagreed), and, in the
 * other file, a `new UpdateService({ beforeLaunch })` sitting after the
 * literal disappeared *silently*. One implementation, tested here, is the
 * difference between a blind spot a comment mentions and a blind spot a
 * fixture shows.
 *
 * ## The rules
 *
 *  - comments become spaces; newlines stay newlines, so every index — and
 *    therefore every line number printed in a failure — still points at the
 *    original source;
 *  - strings and template literals are kept verbatim (a seam inside a string
 *    is still a source fact worth seeing), and `//` inside one is not a
 *    comment;
 *  - regex literals are recognised and kept verbatim, so the `//` inside one
 *    is not a comment either. Detection is the usual operand-position
 *    heuristic: a `/` starts a regex where a value is expected — after an
 *    operator, an opening bracket, a comma, or a keyword like `return` — and
 *    is division after an identifier, a number, `)`, `]` or `}`;
 *  - the heuristic is biased the safe way. A `/` wrongly read as a regex keeps
 *    the following text verbatim, which can only make a gate *find* something
 *    (red on a comment that names a seam, say); it cannot hide code, because a
 *    regex scan stops at the end of the line and falls back to division rather
 *    than swallowing the rest of the file. A `/` wrongly read as division is
 *    the direction that loses text, and that is the case this module exists to
 *    remove: the fixtures in the two gate files drive it.
 */
export function blankComments(source: string): string {
  const out: string[] = [];
  /** The last identifier-ish text emitted, for the keyword test below. */
  let tail = '';
  /** The last non-space character emitted, or `null` at the start of the file. */
  let previous: string | null = null;
  let quote: string | null = null;

  const emit = (text: string): void => {
    out.push(text);
    tail = (tail + text).slice(-24);
    const last = text[text.length - 1];
    if (last !== undefined && !/\s/.test(last)) previous = last;
  };
  /** A blanked region: positions preserved, and it teaches the scan nothing. */
  const blank = (text: string): void => {
    out.push(text);
  };

  const LIMIT = source.length;
  let i = 0;
  while (i < LIMIT) {
    const ch = source[i]!;
    const next = source[i + 1];

    if (quote !== null) {
      emit(ch);
      if (ch === '\\') {
        emit(next ?? '');
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      emit(ch);
      i += 1;
      continue;
    }

    if (ch === '/' && next === '*') {
      // A block comment: blank it, keep its newlines, and stop after `*/`.
      blank('  ');
      i += 2;
      while (i < LIMIT && !(source[i] === '*' && source[i + 1] === '/')) {
        blank(source[i] === '\n' ? '\n' : ' ');
        i += 1;
      }
      if (i < LIMIT) {
        blank('  ');
        i += 2;
      }
      continue;
    }

    if (ch === '/' && next === '/') {
      // Checked before the regex literal below, because `//` is always a
      // comment: an empty regex literal cannot be written, so there is no
      // reading of those two characters that starts one.
      while (i < LIMIT && source[i] !== '\n') {
        blank(' ');
        i += 1;
      }
      continue;
    }

    if (ch === '/') {
      if (startsRegexLiteral(previous, tail)) {
        const end = regexLiteralEnd(source, i);
        if (end !== -1) {
          emit(source.slice(i, end));
          // A regex literal is a value: a `/` after it is division, not the
          // start of another literal.
          tail = (tail + '0').slice(-24);
          previous = '0';
          i = end;
          continue;
        }
      }
    }

    emit(ch);
    i += 1;
  }

  return out.join('');
}

/** Keywords after which a `/` opens a regex literal rather than dividing. */
const KEYWORDS_BEFORE_REGEX =
  /(?:^|[^\w$])(?:return|typeof|instanceof|case|in|of|new|delete|void|do|else|yield|await|throw)\s*$/;

/** Punctuation after which a value — and therefore a regex — is expected. */
const OPERAND_BEFORE_REGEX = new Set([
  '(',
  ',',
  '=',
  ':',
  '[',
  '!',
  '&',
  '|',
  '?',
  '{',
  ';',
  '+',
  '-',
  '*',
  '%',
  '~',
  '^',
  '<',
  '>',
]);

/**
 * Whether the `/` at the cursor opens a regex literal.
 *
 * Division follows a value — an identifier, a number, `)`, `]`, `}`, or a
 * regex literal just closed (recorded as `0`). Everything else in code is a
 * position where a value is expected, except that `return /re/.test(x)` and
 * friends are values *because* of the keyword, which the tail check covers.
 */
function startsRegexLiteral(previous: string | null, tail: string): boolean {
  if (previous === null) return true;
  if (/[\w$)\]]/.test(previous)) return KEYWORDS_BEFORE_REGEX.test(tail);
  if (previous === '}') return false;
  return OPERAND_BEFORE_REGEX.has(previous);
}

/**
 * The index just past the regex literal opening at `start`, or `-1` when the
 * `/` is not one after all.
 *
 * Escapes are skipped, `/` inside a character class does not close the
 * literal (that is the whole point — `/[//]/` is the shape the old walk read
 * as a comment), and a newline ends the attempt: a regex literal cannot span
 * lines, so anything else is division and the caller says so by returning the
 * character as it found it.
 */
function regexLiteralEnd(source: string, start: number): number {
  let inClass = false;
  for (let i = start + 1; i < source.length; i += 1) {
    const ch = source[i]!;
    if (ch === '\n') return -1;
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (ch === '[') {
      inClass = true;
      continue;
    }
    if (ch === ']') {
      inClass = false;
      continue;
    }
    if (ch === '/' && !inClass) {
      // Flags, if any, belong to the literal.
      let end = i + 1;
      while (end < source.length && /[a-z]/i.test(source[end]!)) end += 1;
      return end;
    }
  }
  return -1;
}
