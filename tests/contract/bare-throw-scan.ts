/**
 * The source scan behind the §4.11 meta-test in `error-formatting.test.ts`.
 *
 * It lives in its own module so the scan itself can be tested on fixtures. A
 * meta-test that is only ever run over a code base that currently passes is a
 * test whose failure mode is unknown: if the scanner stops recognising a bare
 * throw, every source file keeps passing and the guarantee quietly disappears.
 * The fixtures in `error-formatting.test.ts` therefore feed it the shapes a
 * real call site takes — including the two the first version missed.
 */

export interface BareThrow {
  file: string;
  /** 1-based line the `throw` starts on */
  at: number;
  /** the source line, trimmed, with any comment blanked */
  line: string;
}

type Source = { file: string; text: string };

/**
 * The source with comments blanked out, offsets and newlines preserved.
 *
 * Blanked rather than deleted, so a finding can still be reported by line.
 *
 * Comments are blanked because this code base *discusses* the anti-pattern —
 * "the previous workaround was `throw new Error(appError(…).message)`" is a
 * sentence in three files — and a scan that counted prose would be a scan
 * nobody could keep green. `//` comments are included, unlike the first version
 * of this function, which only removed comments that occupied a whole line: a
 * trailing `// throw new Error(…)` in prose was scanned as code.
 *
 * String and template literals are left alone. A bare throw hidden behind a
 * `//` inside a string is not a thing that happens, while stripping strings
 * would also strip the messages this test is about. The quote tracking is not a
 * parser: a quote character inside a regular-expression literal can leave a
 * comment unstripped. That direction is deliberate — the meta-test then fails
 * loudly on a false positive instead of passing on a false negative.
 */
export function codeOnly(text: string): string {
  let out = '';
  let i = 0;
  const end = text.length;
  let quote: '"' | "'" | '`' | null = null;

  while (i < end) {
    const ch = text[i] as string;
    const next = text[i + 1];

    if (quote !== null) {
      out += ch;
      if (ch === '\\') {
        // Keep the escaped character with its escape, so `\"` does not close.
        if (next !== undefined) out += next;
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }

    if (ch === '/' && next === '/') {
      while (i < end && text[i] !== '\n') {
        out += ' ';
        i += 1;
      }
      continue;
    }

    if (ch === '/' && next === '*') {
      out += '  ';
      i += 2;
      while (i < end && !(text[i] === '*' && text[i + 1] === '/')) {
        out += text[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      if (i < end) {
        out += '  ';
        i += 2;
      }
      continue;
    }

    if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    out += ch;
    i += 1;
  }

  return out;
}

/**
 * `throw new Error(…)` (no §4.11 code, so the Renderer can only log `UNKNOWN`)
 * and `throw appError(…)` (a thrown plain object, which stops matching every
 * `instanceof Error` branch and does not survive Electron's serialisation).
 *
 * Matched over the whole text rather than line by line: a throw whose argument
 * is wrapped onto the next line is still a bare throw, and the line-by-line
 * version could not see one. The reported line is where `throw` starts.
 */
const BARE_THROW = /\bthrow\s+(?:new\s+Error|appError)\s*\(/g;

export function scanBareThrows(sources: readonly Source[]): BareThrow[] {
  const found: BareThrow[] = [];

  for (const source of sources) {
    const code = codeOnly(source.text);
    const lines = code.split('\n');
    for (const match of code.matchAll(BARE_THROW)) {
      const index = match.index ?? 0;
      const at = code.slice(0, index).split('\n').length;
      found.push({ file: source.file, at, line: (lines[at - 1] ?? '').trim() });
    }
  }

  return found;
}
