/**
 * The source scan behind the "no English custom message" invariant.
 *
 * ## Why this exists
 *
 * `apps/desktop/src/main/ipc-errors.ts` decides whether an issue's message is
 * Zod's own English or a sentence this app wrote, and it decides that by
 * *language* (`isZodOwnText`). That rule is only safe while every custom
 * message in this app is Chinese: an English custom message would be read as
 * Zod's, replaced by the generic table sentence, and the carefully written
 * refusal would disappear from the line a person reads — with nothing failing.
 *
 * A convention in `CONTRIBUTING.md` cannot enforce that; prose is not
 * compiled. So the convention is a scan, and the scan has to be tested itself
 * (see `zod-custom-messages.test.ts`): a scanner that only ever runs over a
 * code base that passes has an unknown failure mode.
 *
 * ## What it recognises
 *
 *  - `message: '…'`, `required_error: '…'`, `invalid_type_error: '…'` in any
 *    file that imports `zod` (the schema options object form);
 *  - the second argument of the methods that take a custom message positionally
 *    (`min`, `max`, `regex`, `refine`, `strict`, …), when that argument is a
 *    string literal;
 *  - `message: SOME_CONSTANT`, resolved to a `const SOME_CONSTANT = '…'` in the
 *    same file — the form `ipc-storage.ts` uses for its two sentences.
 *
 * ## What it does not recognise — the limits, stated
 *
 *  - a message built at runtime (a template literal with an expression, a
 *    function call) — there is no sentence to judge;
 *  - a message imported from another module, or assigned without `const`
 *    (the purge constants live beside their schemas, which is why the one-hop
 *    lookup is enough today);
 *  - a positional message that follows an argument containing a comma inside a
 *    regular-expression literal (`/a,b/`), because the argument walk does not
 *    parse regexes.
 *
 * Each of those is a false *negative*: a shape the scan cannot judge. They are
 * listed rather than fixed because the alternative — a JavaScript parser in a
 * contract test — is a much larger thing to keep correct than the rule it
 * guards. The false *positive* direction is the one that must not happen: a
 * test that fails on code which is fine stops being run.
 *
 * Comments are blanked before scanning (`codeOnly` from `bare-throw-scan.ts`):
 * this repo *discusses* messages and wording in prose at length, and a scan
 * that counted prose would be red permanently.
 */

import { codeOnly } from './bare-throw-scan';

/** One custom message found in source. */
export interface ZodCustomMessage {
  file: string;
  /** 1-based line the message is written on */
  at: number;
  /** how it was attached: an option key, or a positional argument */
  key: string;
  /** the sentence itself, with a same-file constant already resolved */
  message: string;
}

/**
 * The option keys that carry a custom message.
 *
 * `required_error` / `invalid_type_error` are the older spellings of the same
 * thing; they are listed because a schema written against them still carries a
 * sentence a person reads.
 */
const MESSAGE_KEYS = ['message', 'required_error', 'invalid_type_error'] as const;

/**
 * Methods whose *second* argument is a custom message.
 *
 * Only methods where the value being checked is the first argument: `min(3, '…')`,
 * `regex(/…/, '…')`, `refine(fn, '…')`. The string methods on this list
 * (`startsWith`, `includes`, …) are Zod's two-argument refinements, not the
 * one-argument `String` methods of the same name — which is why a two-argument
 * call to one of them in a Zod file is judged and a one-argument call is not.
 */
const SECOND_ARG_METHODS = [
  'min',
  'max',
  'length',
  'regex',
  'refine',
  'startsWith',
  'endsWith',
  'includes',
] as const;

/**
 * Methods whose *first* — and only — argument is a custom message.
 *
 * `z.string().email('换成公司邮箱')` and `.strict(PURGE_UNKNOWN_FIELD)` are the
 * shapes here: there is no value to check, so the sentence is the whole call.
 * A no-argument call (`.email()`) is left alone, because there is nothing to
 * judge.
 */
const FIRST_ARG_METHODS = ['email', 'url', 'uuid', 'strict', 'nonempty'] as const;

const CJK = /[\u4e00-\u9fff]/;

/** Does this file import Zod at all? A file that does not cannot define one. */
function importsZod(text: string): boolean {
  return /\bfrom\s+['"]zod['"]/.test(text) || /\brequire\(\s*['"]zod['"]\s*\)/.test(text);
}

/**
 * Reads a string literal starting at `at`, if there is one.
 *
 * Escapes are kept as written: the point is whether the sentence is Chinese,
 * and `\n` is not.
 */
function readLiteral(
  text: string,
  at: number,
): { value: string; end: number; quote: string } | undefined {
  const quote = text[at];
  if (quote !== "'" && quote !== '"' && quote !== '`') return undefined;

  let value = '';
  let i = at + 1;
  while (i < text.length) {
    const ch = text[i] as string;
    if (ch === '\\') {
      const next = text[i + 1];
      if (next !== undefined) value += next;
      i += 2;
      continue;
    }
    if (ch === quote) {
      // A template literal with `${…}` in it is not one sentence; callers that
      // care check the raw source slice, this just reports what it read.
      return { value, end: i + 1, quote };
    }
    value += ch;
    i += 1;
  }
  return undefined;
}

/** The same-file `const NAME = '…'` declarations, for one-hop resolution. */
function constants(text: string): Map<string, string> {
  const found = new Map<string, string>();
  const declaration = /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*/g;
  let match: RegExpExecArray | null;
  while ((match = declaration.exec(text)) !== null) {
    const name = match[1] as string;
    const literal = readLiteral(text, declaration.lastIndex);
    if (literal) found.set(name, literal.value);
  }
  return found;
}

/** The identifier (if any) that starts at `at`, with its end offset. */
function readIdentifier(text: string, at: number): { name: string; end: number } | undefined {
  const match = /^[A-Za-z_$][\w$]*/.exec(text.slice(at));
  return match ? { name: match[0], end: at + match[0].length } : undefined;
}

/**
 * The start of the second argument of the call whose `(` ends at `openParen`,
 * or `undefined` when the call has only one argument.
 *
 * Deliberately a character walk rather than a regex: the first argument can be
 * a nested call (`refine(isReady, …)`) or a regex literal, and only the comma
 * at the call's own depth separates the arguments.
 */
function secondArgument(text: string, openParen: number): number | undefined {
  // The call's own arguments sit one level in from the `(` we start on, so the
  // separator is the comma at depth 1; a comma deeper than that belongs to a
  // nested call or object.
  let depth = 0;
  let i = openParen;
  while (i < text.length) {
    const ch = text[i] as string;
    if (ch === "'" || ch === '"' || ch === '`') {
      const literal = readLiteral(text, i);
      if (literal) {
        i = literal.end;
        continue;
      }
    }
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (depth <= 1) return undefined;
      depth -= 1;
    } else if (ch === ',' && depth === 1) {
      let next = i + 1;
      while (next < text.length && /\s/.test(text[next] as string)) next += 1;
      return next;
    }
    i += 1;
  }
  return undefined;
}

/** The start of the first argument of the call whose `(` ends at `openParen`. */
function firstArgument(text: string, openParen: number): number {
  let next = openParen + 1;
  while (next < text.length && /\s/.test(text[next] as string)) next += 1;
  return next;
}

/**
 * Every custom message in one file.
 *
 * Returns *all* of them, Chinese or not, so a caller can check language and a
 * test can also assert the scanner sees real sentences — a scan that finds
 * nothing passes every "no English" assertion vacuously.
 */
export function customMessages(file: string, text: string): ZodCustomMessage[] {
  if (!importsZod(text)) return [];

  const code = codeOnly(text);
  const consts = constants(code);
  const found: ZodCustomMessage[] = [];

  const push = (offset: number, key: string, literalAt: number): void => {
    const literal = readLiteral(code, literalAt);
    if (literal) {
      found.push({ file, at: lineOf(code, offset), key, message: literal.value });
      return;
    }
    const identifier = readIdentifier(code, literalAt);
    if (!identifier) return;
    const value = consts.get(identifier.name);
    // A name this file does not define is imported or built elsewhere; the
    // scan cannot see its text, which is a documented limit rather than a
    // reason to fail.
    if (value !== undefined) {
      found.push({ file, at: lineOf(code, offset), key: `${key} (via ${identifier.name})`, message: value });
    }
  };

  const keys = new RegExp(`\\b(${MESSAGE_KEYS.join('|')})\\s*:\\s*`, 'g');
  let match: RegExpExecArray | null;
  while ((match = keys.exec(code)) !== null) {
    const key = match[1] as string;
    push(match.index, key, keys.lastIndex);
  }

  const positional = new RegExp(
    `\\.(${[...SECOND_ARG_METHODS, ...FIRST_ARG_METHODS].join('|')})\\s*\\(`,
    'g',
  );
  const secondArg = new Set<string>(SECOND_ARG_METHODS);
  while ((match = positional.exec(code)) !== null) {
    const method = match[1] as string;
    const openParen = positional.lastIndex - 1;
    const argument = secondArg.has(method)
      ? secondArgument(code, openParen)
      : firstArgument(code, openParen);
    if (argument !== undefined) push(match.index, `${method}() argument`, argument);
  }

  return found;
}

/** 1-based line number of an offset. */
function lineOf(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i += 1) {
    if (text[i] === '\n') line += 1;
  }
  return line;
}

/** The messages that are not Chinese — the findings this scan exists for. */
export function englishMessages(file: string, text: string): ZodCustomMessage[] {
  return customMessages(file, text).filter((found) => !CJK.test(found.message));
}
