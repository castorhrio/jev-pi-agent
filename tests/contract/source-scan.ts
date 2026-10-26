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
 * ## Template literals are code again, not text
 *
 * A template literal used to be one more `quote` state, so everything between
 * the backticks was read as text — including `${…}`, which is not text at all.
 * That is a hole in both directions, and it is the second blind spot this
 * module has grown a fixture for:
 *
 *  - a comment inside an interpolation stayed verbatim, so a gate reading
 *    "which identifiers appear in the code" counted with the comment;
 *  - a backtick inside such a comment (`` `${a /* ` *\/}b` ``) closed the
 *    template early, and the rest of the template became code — where `//` is
 *    a comment and text is not text any more. That is a *swallowing* error,
 *    the direction that hides source.
 *
 * So `${` now opens a code frame and the `}` that closes it returns to the
 * template's text. Braces are counted inside the frame, quotes and regex
 * literals are read again there (they are code), and a nested template inside
 * an interpolation is another frame — a stack, because `` `${`${a}`}` `` is
 * valid and one boolean could not describe it.
 *
 * ## The rules
 *
 *  - comments become spaces; newlines stay newlines, so every index — and
 *    therefore every line number printed in a failure — still points at the
 *    original source;
 *  - strings and template literal *text* are kept verbatim (a seam inside a
 *    string is still a source fact worth seeing), and `//` inside one is not a
 *    comment;
 *  - the code inside a `${…}` interpolation is scanned as code: its comments
 *    are blanked, its strings and regex literals are kept, and a `/` there is
 *    judged by the same rule as anywhere else;
 *  - regex literals are recognised and kept verbatim, so the `//` inside one
 *    is not a comment either. Detection is the usual operand-position
 *    heuristic: a `/` starts a regex where a value is expected — after an
 *    operator, an opening bracket, a comma, a keyword like `return`, or the
 *    `)` that closed a control-flow condition — and is division after an
 *    identifier, a number, `)`, `]` or `}`;
 *  - the heuristic is biased the safe way. A `/` wrongly read as a regex keeps
 *    the following text verbatim, which can only make a gate *find* something
 *    (red on a comment that names a seam, say); it cannot hide code, because a
 *    regex scan stops at the end of the line and falls back to division rather
 *    than swallowing the rest of the file. A `/` wrongly read as division is
 *    the direction that loses text, and that is the case this module exists to
 *    remove: the fixtures in the gate files drive it.
 *
 * ## Statement position after a control-flow `)`
 *
 * `)` is a value ending — `f(x) / 2` is division — with one exception that the
 * first version of this heuristic missed: the `)` that closes an `if (…)`,
 * `while (…)` or `for (…)` header is followed by a *statement*, not by an
 * operator. `if (x) /re/.test(s);` is valid code, and reading its `/` as
 * division is the lossy direction after all: `/[//]/` then puts a `//` at the
 * scanner, which blanks the rest of the line — source gone, silently. The
 * fixture for it (`if (x) /[//]/.test(s); const kept = 1;`) was written as a
 * reverse assertion, i.e. one that should have been green, and came back red.
 *
 * So `(` records whether the word in front of it was a control-flow keyword,
 * and the matching `)` marks a statement position. A call's `(` records the
 * callee's name instead, so `f(x) / 2` still divides.
 *
 * The remaining lossy direction is `}`: after a closing brace the walk says
 * division, because an object literal is far more common than a block whose
 * next statement is an expression starting with a regex. That is a deliberate
 * refusal, pinned by a fixture, rather than an unexamined hole — and it is the
 * reason the paragraph above is about one case and not about a guarantee.
 */
export function blankComments(source: string): string {
  const out: string[] = [];
  /** The last identifier-ish text emitted, for the keyword test below. */
  let tail = '';
  /** The last non-space character emitted, or `null` at the start of the file. */
  let previous: string | null = null;
  /** `'` or `"` while inside a plain string; template literals are frames. */
  let quote: string | null = null;
  /**
   * One entry per open `(` in code: whether a control-flow keyword led it.
   *
   * `(` rather than the keyword itself, because `if (f(a)) /re/` nests — the
   * inner `)` closes a call and the outer one closes the condition, and only a
   * stack keeps the two apart.
   */
  const openParens: boolean[] = [];
  /**
   * Whether what was just emitted ended a control-flow header — a statement
   * position, where a `/` opens a literal even though the character in front
   * of it is `)`.
   */
  let afterControlParen = false;

  const emit = (text: string): void => {
    out.push(text);
    tail = (tail + text).slice(-24);
    const last = text[text.length - 1];
    if (last !== undefined && !/\s/.test(last)) {
      previous = last;
      // A statement position lasts across the whitespace and newlines between
      // the header and the statement — `if (x)\n  /re/.test(s)` is the same
      // code wrapped — and ends at the first real byte written after it.
      afterControlParen = false;
    }
  };
  /** A value just ended, whatever its spelling: a `/` after it is division. */
  const emitValue = (text: string): void => {
    emit(text);
    tail = (tail + '0').slice(-24);
    previous = '0';
  };
  /** A blanked region: positions preserved, and it teaches the scan nothing. */
  const blank = (text: string): void => {
    out.push(text);
  };

  /**
   * Where the walk is, as a stack.
   *
   * Empty is plain code. `template` is the text between backticks (verbatim),
   * `interpolation` is the code inside `${…}` — which is code, with one extra
   * duty: the `}` at depth 0 closes the frame and hands the walk back to the
   * template text it came from. Nested templates push another `template` frame
   * on top, so `` `${`${a}`}` `` needs no special case.
   */
  interface Frame {
    readonly kind: 'template' | 'interpolation';
    /** Braces seen inside an interpolation, so only the matching `}` closes it. */
    depth: number;
  }
  const frames: Frame[] = [];
  const top = (): Frame | undefined => frames[frames.length - 1];

  const LIMIT = source.length;
  let i = 0;
  while (i < LIMIT) {
    const ch = source[i]!;
    const next = source[i + 1];
    const frame = top();

    if (frame?.kind === 'template') {
      // Template *text*: kept verbatim. A `//` here is two characters the user
      // will see, not a comment, and a `${` here is the one thing that is not
      // text — it opens code, which is where a comment would start.
      if (ch === '\\') {
        emit(ch);
        emit(next ?? '');
        i += 2;
        continue;
      }
      if (ch === '`') {
        frames.pop();
        // Closing a template is a value, exactly like closing a regex literal:
        // `` `${a}` / 2 `` is division, not the start of another literal.
        emitValue(ch);
        i += 1;
        continue;
      }
      if (ch === '$' && next === '{') {
        frames.push({ kind: 'interpolation', depth: 0 });
        emit('${');
        i += 2;
        continue;
      }
      emit(ch);
      i += 1;
      continue;
    }

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

    if (ch === '"' || ch === "'") {
      quote = ch;
      emit(ch);
      i += 1;
      continue;
    }

    if (ch === '`') {
      frames.push({ kind: 'template', depth: 0 });
      emit(ch);
      i += 1;
      continue;
    }

    if (frame?.kind === 'interpolation') {
      // Only the `}` that matches the interpolation's own `{` closes it; the
      // others are object literals and blocks inside the code, and counting
      // them here is what keeps `${{ a: 1 }}` from ending at the first brace.
      if (ch === '{') {
        frame.depth += 1;
        emit(ch);
        i += 1;
        continue;
      }
      if (ch === '}') {
        if (frame.depth === 0) {
          frames.pop();
          emitValue(ch);
        } else {
          frame.depth -= 1;
          emit(ch);
        }
        i += 1;
        continue;
      }
    }

    if (ch === '(') {
      // See "Statement position after a control-flow `)`": the word in front of
      // the paren decides what the matching `)` will mean.
      openParens.push(CONTROL_FLOW_PAREN_BEFORE.test(tail));
      emit(ch);
      i += 1;
      continue;
    }

    if (ch === ')') {
      const closesControlFlow = openParens.pop() === true;
      emit(ch);
      afterControlParen = closesControlFlow;
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
      if (afterControlParen || startsRegexLiteral(previous, tail)) {
        const end = regexLiteralEnd(source, i);
        if (end !== -1) {
          emitValue(source.slice(i, end));
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

/**
 * Keywords whose parenthesised header ends in a `)` that is followed by a
 * *statement* rather than by an operand.
 *
 * `switch` and `catch` are here for uniformity rather than because a literal
 * follows them in practice (`{` does, and `{` is already an operand position):
 * a word missing from this list is a hole, a word that never matters is not.
 */
const CONTROL_FLOW_PAREN_BEFORE = /(?:^|[^\w$])(?:if|while|for|with|switch|catch)\s*$/;

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
 *
 * The one `)` that is not asked here is the control-flow one: the caller knows
 * whether the paren it just closed was an `if (…)` header, and a statement
 * position overrides this function's answer. See the module comment.
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
