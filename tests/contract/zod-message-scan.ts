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
 * A message position is only scanned inside a Zod schema expression: a `z.…(…)`
 * call, one of the method calls listed below, or `ctx.addIssue({…})`. A
 * `message:` key in a file that merely imports Zod — a log record, an error
 * payload, an interface field — is not a sentence a person reads as a refusal,
 * and judging its language made the scan report shapes that were never
 * schemas. (The earlier version scanned every `message:` key in a
 * Zod-importing file; it stayed green only because those other sentences
 * happened to be Chinese too.)
 *
 * Within a schema expression it recognises:
 *
 *  - `message: '…'`, `required_error: '…'`, `invalid_type_error: '…'` in
 *    schema options;
 *  - the second argument of the methods that take a custom message positionally
 *    (`min`, `max`, `regex`, `refine`, `strict`, …), when that argument is a
 *    string literal;
 *  - `message: SOME_CONSTANT`, resolved to a `const SOME_CONSTANT = '…'` in the
 *    same file — the form `ipc-storage.ts` uses for its two sentences.
 *
 * ## What it cannot judge — reported, not ignored
 *
 * The shapes below sit in a message position but have no sentence the scan can
 * read without a parser. They are returned as `unresolved`, with a reason and
 * the source text at that position, and the app-wide test asserts that list is
 * empty. A blind spot is therefore a failing test with a name instead of a
 * silent pass:
 *
 *  - a template literal with `${…}` in it (the sentence is assembled at runtime);
 *  - a literal concatenated with `+` (the scan can read one half, not the whole);
 *  - a name this file does not define as a `const` (an imported sentence, a
 *    `let`, a helper result);
 *  - a call, member access, conditional or other expression.
 *
 * The remaining limits are shapes the scan does not even reach:
 *
 *  - a schema built through a destructured or renamed Zod namespace
 *    (`const { string } = z; string({ message })`, or `import { z as zod }`
 *    and `zod.string({ message })`) — only a literal `z.…` call opens a
 *    schema context, so the scan cannot tell a Zod call from any other call
 *    written in the same file;
 *  - a message attached through a helper that is not itself a Zod call;
 *  - a positional message that follows an argument containing a comma inside a
 *    regular-expression literal (`/a,b/`), because the argument walk does not
 *    parse regexes.
 *
 * Those limits are *pinned*, not merely listed: `zod-custom-messages.test.ts`
 * asserts that the renamed and destructured shapes are invisible to the scan,
 * so a blind spot is a contract with a name instead of a gap in a comment. If
 * the scan ever learns to see them, that assertion fails and says so — the
 * limit has to be lifted on purpose, not by accident.
 *
 * Listing them is not the same as fixing them: the alternative is a JavaScript
 * parser in a contract test, which is a much larger thing to keep correct than
 * the rule it guards. The false *positive* direction is still the one that
 * must not happen — a test that fails on code which is fine stops being run —
 * which is why messages outside schema expressions are not judged at all.
 *
 * Comments are blanked before scanning (`codeOnly` from `bare-throw-scan.ts`):
 * this repo *discusses* messages and wording in prose at length, and a scan
 * that counted prose would be red permanently.
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

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
 * Why a message position could not be read as a sentence.
 *
 * The reasons are separate because the fixes are: a template or a
 * concatenation needs the message written as one literal, a name needs a
 * same-file `const`, and anything else needs a person to look at the shape.
 */
export type ZodUnresolvedReason =
  | 'template-with-expression'
  | 'concatenated-literal'
  | 'unknown-constant'
  | 'not-a-literal';

/** A message position the scan can see but cannot judge. */
export interface ZodUnresolvedMessage {
  file: string;
  /** 1-based line the message position starts on */
  at: number;
  /** how it was attached: an option key, or a positional argument */
  key: string;
  reason: ZodUnresolvedReason;
  /** the value's source text, so a reader can see which shape was not judged */
  expression: string;
}

/** Everything one file contributes to the invariant. */
export interface ZodMessageScan {
  /** messages read as sentences; language is judged by the caller */
  messages: ZodCustomMessage[];
  /** message positions the scan could not read; the caller asserts this is empty */
  unresolved: ZodUnresolvedMessage[];
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

/** The `)` that closes the call opened at `openParen`. */
function matchingParen(text: string, openParen: number): number | undefined {
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
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return undefined;
}

/**
 * The spans of the calls that can hold a schema message option.
 *
 * A `message:` key is only a schema option when it sits inside one of these:
 * a `z.…(…)` constructor, a method that takes a message positionally (their
 * options-object form is the same key), or `ctx.addIssue({…})`. Without this,
 * a log record in a file that imports Zod (`{ message: appError.message }`)
 * would be judged as a schema sentence, and an unreadable one would be
 * reported as a blind spot in the invariant that does not exist.
 *
 * Spans are computed once per file. Nested calls produce nested spans; the
 * membership test only needs "inside any", so that is harmless.
 */
function schemaCallSpans(text: string): Array<{ open: number; close: number }> {
  const call = new RegExp(
    [
      // z.string(, z.object(, z.coerce.number(, … — the namespace itself.
      String.raw`\bz(?:\.[A-Za-z_$][\w$]*)+?\s*\(`,
      // The options form of the positional methods: .min(1, { message: … }).
      String.raw`\.(?:${[...SECOND_ARG_METHODS, ...FIRST_ARG_METHODS].join('|')})\s*\(`,
      // ctx.addIssue({ message: … }) under a superRefine callback.
      String.raw`\.addIssue\s*\(`,
    ].join('|'),
    'g',
  );

  const spans: Array<{ open: number; close: number }> = [];
  let match: RegExpExecArray | null;
  while ((match = call.exec(text)) !== null) {
    const open = match.index + match[0].length - 1;
    const close = matchingParen(text, open);
    if (close !== undefined) spans.push({ open, close });
  }
  return spans;
}

/** Is `at` inside one of the schema call spans? */
function insideSchemaSpan(
  spans: ReadonlyArray<{ open: number; close: number }>,
  at: number,
): boolean {
  return spans.some((span) => at > span.open && at < span.close);
}

/**
 * The source text at a message position, first line only.
 *
 * This is for an unresolved record: the reason says the scan could not read
 * it, and this says *what* it could not read. Long expressions are cut so one
 * finding stays one readable line.
 */
function expressionAt(text: string, at: number): string {
  let end = at;
  while (end < text.length && text[end] !== '\n' && text[end] !== '\r') end += 1;
  const raw = text.slice(at, end).trim();
  if (raw === '') return '(empty)';
  return raw.length > 80 ? `${raw.slice(0, 79)}…` : raw;
}

/**
 * Every message position in one file, and the ones the scan cannot judge.
 *
 * `messages` contains *all* readable messages, Chinese or not, so a caller can
 * check language and a test can also assert the scanner sees real sentences — a
 * scan that finds nothing passes every "no English" assertion vacuously.
 *
 * A position that is visible but unreadable goes to `unresolved` instead of
 * disappearing. That is the point of the split: the earlier version returned
 * only what it could read, so a message the scan failed to resolve was
 * indistinguishable from a file with no custom messages at all.
 */
export function scanZodMessages(file: string, text: string): ZodMessageScan {
  if (!importsZod(text)) return { messages: [], unresolved: [] };

  const code = codeOnly(text);
  const consts = constants(code);
  const spans = schemaCallSpans(code);
  const messages: ZodCustomMessage[] = [];
  const unresolved: ZodUnresolvedMessage[] = [];

  const record = (offset: number, key: string, valueAt: number): void => {
    const at = lineOf(code, offset);
    const literal = readLiteral(code, valueAt);

    if (literal) {
      // A template literal with `${…}` is not one sentence; the scan can read
      // the static parts and not the rest, and the sentence a person sees is
      // the one built at runtime.
      if (literal.quote === '`' && literal.value.includes('${')) {
        unresolved.push({
          file,
          at,
          key,
          reason: 'template-with-expression',
          expression: expressionAt(code, valueAt),
        });
        return;
      }
      // `'half' + rest` — the literal is only half of the sentence, so judging
      // its language would judge the wrong thing.
      if (/^\s*\+/.test(code.slice(literal.end))) {
        unresolved.push({
          file,
          at,
          key,
          reason: 'concatenated-literal',
          expression: expressionAt(code, valueAt),
        });
        return;
      }
      messages.push({ file, at, key, message: literal.value });
      return;
    }

    // A field *named* `message` whose value is a schema (`message: z.string()`)
    // is a shape, not a sentence option. A custom message is always a string.
    if (/^z\.[A-Za-z_$]/.test(code.slice(valueAt))) return;

    const identifier = readIdentifier(code, valueAt);
    if (!identifier) {
      unresolved.push({
        file,
        at,
        key,
        reason: 'not-a-literal',
        expression: expressionAt(code, valueAt),
      });
      return;
    }

    const value = consts.get(identifier.name);
    if (value !== undefined) {
      messages.push({ file, at, key: `${key} (via ${identifier.name})`, message: value });
      return;
    }

    // A bare name is a constant this file does not define (imported, or
    // assigned without `const`); anything that continues the expression is not
    // a name at all. Both are unreadable here, and both are reported.
    const compound = /^\s*(?:\.|\?\.|\(|\[)/.test(code.slice(identifier.end));
    unresolved.push({
      file,
      at,
      key,
      reason: compound ? 'not-a-literal' : 'unknown-constant',
      expression: expressionAt(code, valueAt),
    });
  };

  // Only a key inside a schema expression is a message position. The key
  // pattern alone also matches log records and type declarations, which is
  // why the span check comes before `record`.
  const keys = new RegExp(`\\b(${MESSAGE_KEYS.join('|')})\\s*:\\s*`, 'g');
  let match: RegExpExecArray | null;
  while ((match = keys.exec(code)) !== null) {
    const key = match[1] as string;
    if (!insideSchemaSpan(spans, match.index)) continue;
    record(match.index, key, keys.lastIndex);
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
    if (argument === undefined) continue;
    // `.email()` and `.min(3, )` have no argument in the message position;
    // there is nothing to read and nothing to report.
    if (code[argument] === ')' || code[argument] === ',') continue;
    record(match.index, `${method}() argument`, argument);
  }

  return { messages, unresolved };
}

/** The messages the scan could read, in source order. */
export function customMessages(file: string, text: string): ZodCustomMessage[] {
  return scanZodMessages(file, text).messages;
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

/* ------------------------------------------------------------------------- *
 * The scope of the scan in this repository
 * ------------------------------------------------------------------------- */

/**
 * Source roots outside `packages/` and `apps/`.
 *
 * Empty today: every workspace in this repository lives under one of those
 * two directories, and a workspace added there is picked up automatically. A
 * *top-level* workspace — a new directory beside `packages/` — is not, and has
 * to be listed here.
 */
const EXTRA_SCAN_ROOTS: readonly string[] = [];

/** The `src` directory of every workspace directly under `parent`. */
function rootsUnder(parent: string): string[] {
  if (!existsSync(parent)) return [];
  return readdirSync(parent, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(parent, entry.name, 'src'));
}

/**
 * The directories this repository's schemas live in — everything that ships.
 *
 * A scan needs a scope, and a scope that is only implied is a scope that can
 * shrink by accident: a workspace added as a new top-level directory would
 * carry schemas the English check never reads, and the check would keep
 * passing.
 *
 * The list is explicit here, and `zod-custom-messages.test.ts` asks two
 * questions about it — that every root exists and holds source, and that
 * every source root this repository has is in this list. A new top-level
 * workspace therefore fails a test until it is added to
 * {@link EXTRA_SCAN_ROOTS}: the omission becomes a decision instead of a
 * silence. `CONTRIBUTING.md` says the same in prose, under "Adding a
 * workspace package".
 */
export const SCAN_ROOTS: readonly string[] = [
  ...rootsUnder('packages'),
  ...rootsUnder('apps'),
  ...EXTRA_SCAN_ROOTS,
];

/** Every `.ts` / `.tsx` file under a directory, recursively. */
export function sourceFilesIn(root: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name)) out.push(full);
    }
  };
  if (existsSync(root)) walk(root);
  return out;
}

/** Every source file the invariant covers: the files under {@link SCAN_ROOTS}. */
export function shippedSourceFiles(): string[] {
  return SCAN_ROOTS.flatMap(sourceFilesIn);
}
