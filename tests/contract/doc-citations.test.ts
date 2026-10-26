/**
 * A doc comment that names a test case must name one that exists.
 *
 * ## Why this gate exists
 *
 * Several files in this repository argue their design by pointing at the case
 * that holds them: `ci-shape.ts` says *see the case that …*, the README gates do
 * the same, and each citation is how a reader gets from a claim to the evidence
 * for it. Nothing compared those names with the suite, though, so the evidence
 * could be renamed or deleted while the argument went on pointing at it. That
 * failure is silent in the worst way: the prose still reads as verified, and the
 * reader who follows the pointer finds nothing and concludes they are looking at
 * the wrong file.
 *
 * So the citations are checked. A doc comment cites a case as
 * `` `it('part of the name')` `` (or `` `describe('…')` ``), and this file
 * extracts every such citation from a fixed list of sources and looks for a
 * declared case whose name contains it. A citation that matches nothing is red,
 * with both fixes in the message.
 *
 * ## Why a marker, and why italics are refused
 *
 * The natural way to cite is in italics — *the case that does X* — and that is
 * how these comments were written. It cannot be checked: the same italics are
 * used for emphasis (*reported*, *before*), and a rule that only checked italic
 * text matching an existing case name would silently exempt every stale
 * citation the moment its case was renamed. That is the shape of guard this
 * repository already removed twice (the `skipIf` guards in `readme*.test.ts`):
 * a check whose subject can make it pass by disappearing is not a check.
 *
 * The two ways out are a marker that is unambiguously a citation, or a matcher
 * clever enough to tell a citation from emphasis. The second is the one that
 * gets edited until it stops trying, so the marker wins — and the reason
 * italics are then *banned* for multi-word phrases is what closes the loop: if
 * an italic phrase could stay, the next person would write the citation the way
 * it reads best, and this gate would not see it. One word of emphasis is fine
 * (`*reported*`); a phrase is either emphasis (write it as "…" or **…**) or a
 * citation (write it as `it(…)`).
 *
 * ## What is deliberately not read
 *
 * Only `/** … *&#47;` blocks in the five sources listed below, and only the
 * `it(…)` / `describe(…)` marker form. A citation written in a `//` line
 * comment, or an italic single word, is outside the gate — see the extension
 * rule at {@link CITED_SOURCES}. The scope is a decision, not an oversight: the
 * doc comments are where these files argue, and widening the reader to every
 * comment would trade a checkable rule for a scanner nobody trusts.
 *
 * ## Why nothing here skips
 *
 * The first case asserts unconditionally that `tests/` and every cited source
 * exist. A missing directory or source is a red run, not a skip: this gate's
 * whole subject is text that names other text, so losing half of the pair has to
 * fail — see `readme-parity.test.ts` for the same rule and the history behind
 * it.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const TESTS_DIR = join(REPO_ROOT, 'tests');

/**
 * The sources whose doc comments cite cases.
 *
 * Adding one is a line here; removing one has to be a deliberate edit rather
 * than a file that quietly drops out of the scan, because the case below asserts
 * that every entry still exists. Start here when a new module starts pointing at
 * its tests in prose — a source outside this list has its citations unchecked,
 * and this header is the only place that says so.
 */
const CITED_SOURCES = [
  'tests/contract/ci-shape.ts',
  'tests/contract/readme-parity.test.ts',
  'apps/desktop/src/main/adapter-candidates.ts',
  'apps/desktop/src/main/adapter-resolution.ts',
  'apps/desktop/src/main/decision-facade.ts',
] as const;

/** One `it(…)` / `describe(…)` marker in a doc comment, with where it is. */
interface Citation {
  /** The source file the citation was written in. */
  readonly source: string;
  /** Which of the two markers it used. */
  readonly form: 'it' | 'describe';
  /** The name fragment the comment quotes. */
  readonly name: string;
  /** 1-based line in `source`. */
  readonly line: number;
}

/** A multi-word italic phrase in a doc comment, with where it is. */
interface ItalicPhrase {
  readonly source: string;
  /** The phrase, whitespace collapsed — how it reads, not how it was wrapped. */
  readonly text: string;
  /** 1-based line the phrase starts on. */
  readonly line: number;
}

/** What one scan of the sources found, and everything wrong with it. */
interface CitationReport {
  readonly citations: readonly Citation[];
  readonly italicPhrases: readonly ItalicPhrase[];
  readonly problems: readonly string[];
}

/** The number of `\n`s in `text` before `index`. */
function newlinesBefore(text: string, index: number): number {
  return text.slice(0, index).split('\n').length - 1;
}

/** One `/** … *&#47;` block, with its `*` decoration stripped and newlines kept. */
interface DocBlock {
  /** The comment body, marker stripped, newlines kept so line numbers survive. */
  readonly text: string;
  /** 1-based line of the `/**` delimiter, i.e. of the first line of `text`. */
  readonly line: number;
}

/** Every doc comment in a source file. */
function docBlocks(source: string): DocBlock[] {
  const blocks: DocBlock[] = [];
  for (const match of source.matchAll(/\/\*\*([\s\S]*?)\*\//gu)) {
    const raw = match[1] ?? '';
    blocks.push({
      text: raw
        .split('\n')
        .map((line) => line.replace(/^\s*\*? ?/u, ''))
        .join('\n'),
      line: 1 + newlinesBefore(source, match.index ?? 0),
    });
  }
  return blocks;
}

/** The `it(…)` / `describe(…)` citations in one doc comment. */
function citationsIn(source: string, block: DocBlock): Citation[] {
  return [...block.text.matchAll(/`(it|describe)\('([^']*)'\)`/gu)].map((match) => ({
    source,
    form: (match[1] ?? 'it') as 'it' | 'describe',
    name: match[2] ?? '',
    line: block.line + newlinesBefore(block.text, match.index ?? 0),
  }));
}

/**
 * The multi-word italic phrases in one doc comment.
 *
 * Code spans are masked first, so a `*` inside a glob or a path (`*.yml`) cannot
 * pair with the next one and swallow the prose between them. `**bold**` is left
 * alone by the lookarounds — it is the replacement this gate recommends for
 * emphasis, so it must not itself be red.
 */
function italicPhrasesIn(source: string, block: DocBlock): ItalicPhrase[] {
  const masked = block.text.replace(/`[^`]*`/gu, (span) => ' '.repeat(span.length));
  return [...masked.matchAll(/(?<!\*)\*([^*]+)\*(?!\*)/gu)]
    .map((match) => ({
      source,
      text: (match[1] ?? '').replace(/\s+/gu, ' ').trim(),
      line: block.line + newlinesBefore(masked, match.index ?? 0),
    }))
    .filter((phrase) => /\s/u.test(phrase.text));
}

/** The failure a stale citation reports. */
function staleCitationProblem(citation: Citation): string {
  return [
    `${citation.source}:${citation.line} cites \`${citation.form}('${citation.name}')\` in a doc comment, ` +
      'and no `it(…)` / `describe(…)` under `tests/` has a name containing that text.',
    'So the evidence this sentence points at is gone — renamed, moved or deleted — and the comment',
    'still reads as if somebody checked it. Fix it one of two ways:',
    '  1. Correct the citation to the case name as it stands (quote only the distinctive part — a',
    '     substring of the name is enough), or delete the sentence if the case is genuinely gone.',
    '  2. Add the missing case under `tests/`, so that the doc and the suite agree again.',
  ].join('\n');
}

/** The failure a multi-word italic phrase reports. */
function italicPhraseProblem(phrase: ItalicPhrase): string {
  return [
    `${phrase.source}:${phrase.line} puts a multi-word phrase in italics: "${phrase.text}".`,
    'In these files an italic phrase is either emphasis or a citation of a test case, and nothing',
    'can tell the two apart — which is exactly the shape a stale citation takes. So pick one:',
    '  1. Emphasis of more than one word: use quotes or bold — "…" or **…** — and leave italics for',
    '     a single word.',
    '  2. A citation: write `it(\'part of the case name\')` (or `describe(\'…\')`), which',
    '     `tests/contract/doc-citations.test.ts` then checks against the suite.',
    'Do not leave the phrase in italics "just this once": it is the one form this gate cannot see.',
  ].join('\n');
}

/**
 * Every way the citations can be wrong, as a function of its inputs.
 *
 * Pure, so a fixture can show it answering something other than `[]` — the one
 * thing a gate about references must be able to prove, and the reason the real
 * run below is paired with cases that fail on purpose.
 */
function citationReport(
  sources: Readonly<Record<string, string>>,
  declaredNames: readonly string[],
): CitationReport {
  const citations: Citation[] = [];
  const italicPhrases: ItalicPhrase[] = [];
  const problems: string[] = [];

  for (const [source, text] of Object.entries(sources)) {
    for (const block of docBlocks(text)) {
      for (const citation of citationsIn(source, block)) {
        citations.push(citation);
        if (declaredNames.some((name) => name.includes(citation.name))) continue;
        problems.push(staleCitationProblem(citation));
      }
      for (const phrase of italicPhrasesIn(source, block)) {
        italicPhrases.push(phrase);
        problems.push(italicPhraseProblem(phrase));
      }
    }
  }

  return { citations, italicPhrases, problems };
}

/**
 * A case declared with `it(…)`, `describe(…)` or `test(…)`, at the start of a
 * line.
 *
 * Two deliberate properties, and the first one was learned the hard way:
 *
 *  - **Anchored to the start of a line** (`^` with the `m` flag). The first
 *    version matched `it(…)` anywhere in the text, so it collected the
 *    citations written in doc comments — `* see \`it('a case')\` *` became a
 *    "declared name", and a stale citation vouched for itself. The gate went
 *    green on the exact defect it exists for. Every real declaration in this
 *    suite starts a line (`it(…)`, `it.skipIf(cond)(…)`, `it.each(rows)(…)`),
 *    and no comment line does: a doc-comment citation line starts with `*` and a
 *    `//` citation starts with `/`.
 *  - **Broad otherwise.** The names are only haystacks for a substring search,
 *    so a pattern that is slightly too greedy costs nothing, while one that
 *    missed `it.skipIf(condition)('name')` or `it.each(rows)('name')` would turn
 *    a real case into a red citation. Both variants are in this suite
 *    (`budget.test.ts`, `build-graph.test.ts`), so this is not hypothetical.
 */
const CASE_DECLARATION =
  /^\s*(?:it|describe|test)(?:\.\w+)*(?:\([^()\n]*\))?\(\s*(?:'([^']*)'|"([^"]*)"|`([^`]*)`)/gmu;

/** The case names declared in one file's source. */
function caseNamesIn(source: string): string[] {
  return [...source.matchAll(CASE_DECLARATION)].map(
    (match) => match[1] ?? match[2] ?? match[3] ?? '',
  );
}

/**
 * Every case name declared under `tests/`, recursively.
 *
 * `*.test.ts` only: a helper module (`ci-shape.ts`, `adapter-contract.ts`) does
 * not declare cases, and reading it buys nothing except another chance for a
 * citation to be counted as a declaration.
 */
function declaredCaseNames(dir: string): string[] {
  const names: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      names.push(...declaredCaseNames(full));
      continue;
    }
    if (!/\.test\.tsx?$/u.test(entry.name)) continue;
    names.push(...caseNamesIn(readFileSync(full, 'utf8')));
  }
  return names;
}

/** The sources as this run reads them, keyed by their repository-relative path. */
function readSources(): Record<string, string> {
  const sources: Record<string, string> = {};
  for (const source of CITED_SOURCES) {
    sources[source] = readFileSync(join(REPO_ROOT, ...source.split('/')), 'utf8');
  }
  return sources;
}

/**
 * The suite's case names, read once.
 *
 * Empty when `tests/` is gone, and the first case below turns that into a red
 * run instead of a stack trace at import time. Reading is lazy for the same
 * reason: a missing source would otherwise throw while the module loads, before
 * any assertion could say which file disappeared.
 */
const declaredNames = existsSync(TESTS_DIR) ? declaredCaseNames(TESTS_DIR) : [];

/** The real scan. Called after the existence assertions, not at import. */
function readReport(): CitationReport {
  return citationReport(readSources(), declaredNames);
}

describe('a doc comment cites a case that exists', () => {
  it('finds the suite and every cited source, so the checks below are not vacuous', () => {
    // Unconditional and first, because everything below is a comparison between
    // two sets of text. A deleted `tests/` directory would make the citation
    // scan answer `[]` for the wrong reason, which is the `skipIf` shape this
    // repository already removed from the README gates.
    expect(existsSync(TESTS_DIR), `the tests directory is missing (${TESTS_DIR})`).toBe(true);
    for (const source of CITED_SOURCES) {
      const path = join(REPO_ROOT, ...source.split('/'));
      expect(existsSync(path), `a cited source is missing (${path})`).toBe(true);
    }
    // …and the two sets have to be non-trivial: no declared cases means the
    // suite moved or the matcher broke, and no citations means the sources
    // stopped pointing at their evidence (or the extractor did).
    expect(
      declaredNames.length,
      'no it()/describe() case name was read from tests/',
    ).toBeGreaterThan(100);
    expect(
      readReport().citations.length,
      'no doc-comment citation was found in the sources above; either every source lost its ' +
        'citations or the extractor stopped matching `it(…)`',
    ).toBeGreaterThan(4);
  });

  it('names only cases the suite still declares', () => {
    // The real run. The message is the report rather than one citation at a
    // time, so a rename shows every place that still uses the old name in one
    // failure instead of one per run.
    const problems = readReport().problems;
    expect(
      problems,
      `doc comments and the suite disagree:\n  ${problems.join('\n  ')}`,
    ).toEqual([]);
  });
});

/**
 * Fixtures, because a gate about references has to show it can fail.
 *
 * Each source below is a doc comment in the shape the real ones have, driven
 * through the same `citationReport` the repository run uses — so the red cases
 * are not a second implementation that could drift from the green one.
 */
describe('the citation check can fail', () => {
  const SOURCE = 'src/example.ts';
  const names = ['reports the file, the line and the fix', 'reads a workflow directory'];

  it('accepts a citation that is part of a case name', () => {
    // The marker quotes a *fragment*, not the whole name, so a comment can stay
    // readable: `it('reports the file, the line and the fix')` names a case
    // whose full name goes on to explain it.
    const report = citationReport(
      { [SOURCE]: "/**\n * The failure is asserted (*see* nothing).\n */" },
      names,
    );
    expect(report.citations).toEqual([]);
    expect(report.problems).toEqual([]);

    const cited = citationReport(
      {
        [SOURCE]: [
          '/**',
          ' * The wording is asserted in `ci-shape.test.ts`',
          " * (`it('reports the file, the line and the fix')`).",
          ' */',
        ].join('\n'),
      },
      names,
    );
    expect(cited.citations).toEqual([
      { source: SOURCE, form: 'it', name: 'reports the file, the line and the fix', line: 3 },
    ]);
    expect(cited.problems).toEqual([]);
  });

  it('reads a case name from a declaration, and never from a comment that cites one', () => {
    // The hole this case exists for was real, and the first version of this file
    // had it: names were collected from every `it(…)`-shaped string under
    // `tests/`, including the citations written in doc comments — so a stale
    // citation counted as the declaration of itself and the gate went green on
    // the defect it was built for. Anchoring to the start of a line is the fix,
    // and this is the case that fails if that anchor is ever dropped.
    const source = [
      "describe('a group', () => {",
      "  it('a case', () => {});",
      "  it.skipIf(flag)('a conditional case', () => {});",
      "  it.each(rows)('%s is handled', () => {});",
      '});',
      "/** The gate cites `it('a case that was renamed away')` here. */",
      "// it('a line comment is not a declaration')",
    ].join('\n');
    expect(caseNamesIn(source)).toEqual([
      'a group',
      'a case',
      'a conditional case',
      '%s is handled',
    ]);
    // …and the citation in that source is still *checked*, which is the other
    // half: the extractor must not read it, and the scan must not skip it.
    const report = citationReport(
      { [SOURCE]: source },
      ['a case', 'a conditional case', '%s is handled'],
    );
    expect(report.citations).toEqual([
      { source: SOURCE, form: 'it', name: 'a case that was renamed away', line: 6 },
    ]);
    expect(report.problems).toHaveLength(1);
  });

  it('reports a citation whose case was renamed away, with the file, the line and both fixes', () => {
    // The defect this file exists for: the comment still says the case proves
    // it, the case is now called something else, and the reader who follows the
    // pointer finds nothing.
    const report = citationReport(
      {
        [SOURCE]: [
          '/**',
          ' * The comment used to be enforced by',
          " * `it('skips a symlinked workflow file')`; now nothing is.",
          ' */',
        ].join('\n'),
      },
      ['follows a symlinked workflow file, so a link cannot hide a packaging step'],
    );
    expect(report.citations).toHaveLength(1);
    expect(report.problems).toHaveLength(1);
    const problem = report.problems[0]!;
    // The address, so the fix is a one-line edit rather than a search.
    expect(problem).toContain(`${SOURCE}:3`);
    expect(problem).toContain("`it('skips a symlinked workflow file')`");
    // Both fixes, and the second one is the opposite direction: correct the
    // comment, or bring the evidence back. A message that only said "no such
    // test" would leave the reader guessing which of the two the project wants.
    expect(problem).toContain('Correct the citation to the case name as it stands');
    expect(problem).toContain('Add the missing case under `tests/`');
  });

  it('reports a multi-word italic phrase, so a citation cannot hide in emphasis', () => {
    // The hole a marker-only rule leaves: somebody writes the citation the way
    // the comments used to, in italics, and no marker is there to check. The ban
    // is what makes the marker the only way to cite, so this case asserts the
    // failure *and* that it names the two readings.
    const report = citationReport(
      { [SOURCE]: '/**\n * This is pinned by *skips a symlinked workflow file*.\n */' },
      names,
    );
    expect(report.citations).toEqual([]);
    expect(report.italicPhrases).toEqual([
      { source: SOURCE, text: 'skips a symlinked workflow file', line: 2 },
    ]);
    expect(report.problems).toHaveLength(1);
    const problem = report.problems[0]!;
    expect(problem).toContain(`${SOURCE}:2`);
    expect(problem).toContain('"skips a symlinked workflow file"');
    expect(problem).toContain('use quotes or bold');
    expect(problem).toContain("write `it('part of the case name')`");
  });

  it('leaves emphasis alone: one italic word, bold, and code spans are not citations', () => {
    // The control for the case above. A ban that also fired on `*reported*`,
    // `**In this repository**` or `` `*.yml` `` would be a style gate nobody
    // keeps green, and the first fix a reader would reach for is disabling it.
    // Note the glob: its `*` is inside a code span on purpose, because a real
    // one (`*.yml` / `*.yaml`) sits in `ci-shape.ts` and must not pair up.
    const report = citationReport(
      {
        [SOURCE]: [
          '/**',
          ' * A missing adapter is *reported*, never fatal.',
          ' * **No automated gate covers that step.** The reader takes `*.yml` / `*.yaml`.',
          ' * An inline comment (`a * b`) is not a citation either.',
          ' */',
        ].join('\n'),
      },
      names,
    );
    expect(report.citations).toEqual([]);
    expect(report.italicPhrases).toEqual([]);
    expect(report.problems).toEqual([]);
  });

  it('reads doc comments only, which is the declared scope', () => {
    // A `//` comment is outside the scan by design (the header says so), and
    // pinning it means the scope cannot be widened by accident — or narrowed
    // silently: the case fails if the reader starts picking up line comments,
    // which is the edit that would red every `*emphasis*` in a `//` note.
    const report = citationReport(
      {
        [SOURCE]: [
          "/** The doc comment cites `it('reads a workflow directory')`. */",
          "// a line comment citing `it('a case that does not exist')` is not read",
        ].join('\n'),
      },
      names,
    );
    expect(report.citations).toHaveLength(1);
    expect(report.problems).toEqual([]);
  });
});
