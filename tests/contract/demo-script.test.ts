/**
 * The demo script, and the verifier steps it claims to be demonstrating.
 *
 * ## Why this file exists
 *
 * `docs/demo-script.md` is the page someone reads before standing in front of a
 * reviewer. It used to describe four demo actions that were *about* the product
 * and not *the same thing as* the run: the verifier drives five steps, the demo
 * script walked three of them and then jumped to the five interface states,
 * which is step 6 — the one step no command can drive. So the two documents
 * agreed on the story and disagreed on the steps, and the disagreement was
 * invisible until someone was on stage saying "and this is what the run checks"
 * about something the run does not check.
 *
 * The fix is a mapping, and a mapping between two documents is exactly the kind
 * of fact that rots. This file keeps it from rotting the way
 * `handoff-packs.test.ts` keeps the two handoff packs from rotting: every `[ok]`
 * line the demo script quotes has to still be printed by
 * `scripts/verify-main-chain.mjs`, and the set of steps it quotes has to be the
 * set the verifier actually drives.
 *
 * ## What is checked
 *
 *  - the demo script exists and is not empty;
 *  - every `[ok] step N: …` line it quotes is still in the verifier's source —
 *    a reworded `pass()` message is a red run, not a stale page;
 *  - and it is printed **under the step the demo attributes it to**. "In the
 *    file" is not the same claim: a short quote like `the handoff lands` is in
 *    the source once, under step 3, so a demo that printed it as step 1's line
 *    used to pass — the gate looked strict and could not tell the two steps
 *    apart. The attribution is computed from the source (see `stepRegions`),
 *    and a quote that cannot be tied to any step is red rather than waved
 *    through, because a quote the gate cannot place is a quote it cannot check;
 *  - the steps it quotes are **exactly** `DRIVEN_STEPS`, imported from the
 *    verifier rather than restated here. A demo that skips step 4 is a demo
 *    that never shows the update check; a demo that quotes a step the verifier
 *    does not drive is a demo of something nobody ran;
 *  - it quotes no `[ok]` line for step 6. Step 6 is the five states a person
 *    walks by eye; there is no command behind it, so a demo script that quotes
 *    an `[ok]` line for it is claiming a run that cannot happen.
 *
 * ## Why the quotes may be elided
 *
 * A `pass()` message is often a template: `the tray menu carries ${labels}`,
 * `${n} decisions carry …`, `the real feed answered over the network: ${state}`.
 * The document cannot quote the whole line, because the varying half is not
 * known until the run. So a quote may elide with `…`, and every literal piece
 * between the elisions has to be in the source. That is the same rule
 * `handoff-packs.test.ts` applies to the packs — quote the load-bearing half,
 * not the whole line — with the elision made explicit instead of implied.
 *
 * ## What is deliberately not asserted
 *
 * Wording, ordering, or that the demo would go well. Nor that the five demo
 * actions are the *only* thing on the page: the five interface states belong
 * there too, and they are checked by `state-walkthrough.test.ts`. This file only
 * keeps the demo script and the verifier talking about the same five steps.
 *
 * ## The one sentence a reviewer asks for on stage
 *
 * The demo script also has to say, in the section where the question is asked,
 * that the Windows six steps have **not** been run. That sentence lived only at
 * the end of `docs/manual-verification.md`, which is the document nobody opens
 * while standing in front of a reviewer: the question is asked of the demo
 * script, so the answer has to be in the demo script. And because the answer is
 * a command, the command has to be the same one the checklist gives — two
 * documents spelling one command two ways is the drift this repository keeps
 * finding. So the check is bidirectional: the demo script must carry the claim
 * and the command, and `docs/manual-verification.md` must still carry both. The
 * day a Windows run lands, both documents change together or this file goes red.
 *
 * The checks are pure functions of `(document, scriptSource)`, so the red
 * direction is driven with mutated copies rather than argued about.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { DRIVEN_STEPS } from '../../scripts/verify-main-chain.mjs';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const DEMO_PATH = join(REPO_ROOT, 'docs', 'demo-script.md');
const VERIFIER_PATH = join(REPO_ROOT, 'scripts', 'verify-main-chain.mjs');
const MANUAL_PATH = join(REPO_ROOT, 'docs', 'manual-verification.md');

/** The section a reviewer's "did you run it on a real machine?" lands in. */
const WINDOWS_SECTION = '## 被问到「真机跑过吗」';

/**
 * The claim, as both documents spell it.
 *
 * Deliberately the tail of the sentence rather than the whole of it: the demo
 * script bolds `Windows 六步仍未跑` and the checklist writes
 * `Windows 真机六步仍未跑`, and pinning either whole phrase would make the two
 * documents disagree about wording instead of about the fact. What has to be
 * true in both is that the six steps have not been run.
 */
const WINDOWS_CLAIM = '六步仍未跑';

/**
 * The command that produces the report, spelled the way a Windows reader types
 * it — the same literal `docs/manual-verification.md` gives.
 */
const WINDOWS_COMMAND =
  'node scripts\\verify-main-chain.mjs --exec release\\win-unpacked\\UCAD.exe --report win-report.json';

/** The flag that turns a carried-home report into a verdict. */
const WINDOWS_JUDGE = '--judge';

/** The step whose `[ok]` line no demo may quote: it is a person's walk, not a run. */
const MANUAL_STEP = 6;

/** The elision mark a quote uses for the half that varies between runs. */
const ELISION = '…';

/** One `[ok]` line the demo script quotes, and the step it belongs to. */
interface Quote {
  /** The step number the line is printed under. */
  readonly step: number;
  /** The quoted text after `[ok] step N: `, possibly elided with `…`. */
  readonly text: string;
}

/**
 * Every `[ok] step N: …` line in a document, in document order.
 *
 * The quote ends at the closing backtick or the end of the line, because the
 * document writes these inside inline code and a quote that ran on into the
 * surrounding prose would be compared against the source as one long string.
 */
function quotesIn(markdown: string): Quote[] {
  const quotes: Quote[] = [];
  for (const match of markdown.matchAll(/\[ok\] step (\d+): ([^`\n]+)/g)) {
    quotes.push({ step: Number(match[1]), text: match[2]!.trim() });
  }
  return quotes;
}

/**
 * The literal pieces of a quote, with the elided halves dropped.
 *
 * `the tray menu carries …` becomes `['the tray menu carries']`. A quote that is
 * nothing but an elision has no pieces and is reported by the caller, because a
 * quote that pins nothing is a quote that cannot go red.
 */
function pieces(text: string): string[] {
  return text
    .split(ELISION)
    .map((piece) => piece.trim())
    .filter((piece) => piece.length > 0);
}

/**
 * The verifier's source with its comments removed.
 *
 * The attribution below asks "which step's code prints this sentence", and a
 * doc comment that merely *mentions* a helper (`two are compared by
 * \`trayMenuVerdict()\``) would otherwise pull that helper's messages into a
 * step that never calls it — a gate that is weaker than it reads, which is the
 * defect this whole analysis is for. Block comments and whole-line `//`
 * comments are dropped; a trailing `//` is left alone because `https://` lives
 * in string literals and a naive strip would eat the rest of the line.
 */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

/**
 * The verifier's function definitions, each with the text that follows it.
 *
 * Sliced from one `function name(` to the next rather than brace-matched: the
 * source is full of braces inside template literals and inside the page scripts
 * it injects, and a brace counter that is off by one would attribute a message
 * to the wrong step — silently, and in the direction that makes the gate green.
 */
function functionSlices(source: string): Map<string, string> {
  const pattern = /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/g;
  const hits = [...source.matchAll(pattern)].map((match) => ({
    name: match[1]!,
    start: match.index,
  }));
  const slices = new Map<string, string>();
  hits.forEach((hit, index) => {
    const end = index + 1 < hits.length ? hits[index + 1]!.start : source.length;
    slices.set(hit.name, source.slice(hit.start, end));
  });
  return slices;
}

/**
 * The source text each driven step can print from.
 *
 * A step's `pass()` message is often built by a helper — `pass(5,
 * menuVerdict.message)` where `menuVerdict` came from `trayMenuVerdict()` — so a
 * region starts as the `stepN()` body and grows to include the body of every
 * function that body calls, until it stops growing. That is one level of
 * indirection more than the source happens to need today, on purpose: the
 * alternative is a gate that goes red the first time a message is moved into a
 * helper, which is how a gate gets deleted instead of fixed.
 *
 * A step with no `stepN()` function has no region, and a quote attributed to it
 * is then red — the same answer as a quote nobody prints.
 */
function stepRegions(source: string): Map<number, string> {
  const slices = functionSlices(codeOnly(source));
  const regions = new Map<number, string>();
  for (const step of DRIVEN_STEPS) {
    const body = slices.get(`step${step}`);
    if (body !== undefined) regions.set(step, body);
  }
  for (let round = 0; round < 8; round += 1) {
    let grew = false;
    for (const [step, text] of regions) {
      for (const [name, body] of slices) {
        if (text.includes(body)) continue;
        if (!new RegExp(`\\b${name}\\s*\\(`).test(text)) continue;
        regions.set(step, `${text}\n${body}`);
        grew = true;
      }
    }
    if (!grew) break;
  }
  return regions;
}

/** The steps whose code can print `piece`, in step order. */
function stepsPrinting(piece: string, regions: Map<number, string>): number[] {
  return [...regions]
    .filter(([, text]) => text.includes(piece))
    .map(([step]) => step)
    .sort((a, b) => a - b);
}

/**
 * Every way the demo script and the verifier disagree about the steps.
 *
 * Empty means the mapping is intact. Pure in `(document, scriptSource)` so the
 * interesting cases — a reworded message, a missing step, a quote for the
 * manual step — can be shown producing a failure instead of being argued about.
 */
function demoProblems(document: string, scriptSource: string): string[] {
  const problems: string[] = [];
  if (document.trim().length === 0) {
    return ['docs/demo-script.md: is missing or empty, so there is no demo to check'];
  }
  if (scriptSource.trim().length === 0) {
    return ['scripts/verify-main-chain.mjs: is missing or empty, so there is nothing to compare'];
  }

  const quotes = quotesIn(document);
  if (quotes.length === 0) {
    return [
      'docs/demo-script.md: quotes no `[ok] step N: …` line, so nothing ties the demo to the run',
    ];
  }

  const regions = stepRegions(scriptSource);

  for (const quote of quotes) {
    if (quote.step === MANUAL_STEP) {
      problems.push(
        `docs/demo-script.md: quotes an \`[ok]\` line for step ${MANUAL_STEP}, which no command ` +
          'drives — the five states are walked by eye, so a demo cannot show that line',
      );
      continue;
    }
    const literal = pieces(quote.text);
    if (literal.length === 0) {
      problems.push(
        `docs/demo-script.md: the step ${quote.step} quote is nothing but an elision, so it ` +
          'pins no wording and cannot go red',
      );
      continue;
    }
    for (const piece of literal) {
      if (!scriptSource.includes(piece)) {
        problems.push(
          `docs/demo-script.md: quotes "${piece}" from step ${quote.step}, and ` +
            'scripts/verify-main-chain.mjs no longer prints it — the demo describes output ' +
            'nobody will see',
        );
        continue;
      }
      // In the file is not the same claim as under this step. A short quote is
      // often printed by exactly one step, so a demo that moved it to another
      // step's row used to pass: the sentence was in the source, and nothing
      // asked which step prints it.
      const printedBy = stepsPrinting(piece, regions);
      if (printedBy.length === 0) {
        problems.push(
          `docs/demo-script.md: quotes "${piece}" for step ${quote.step}, and it is in ` +
            'scripts/verify-main-chain.mjs but not inside any step\'s code path — a quote the ' +
            'gate cannot tie to a step cannot go red for the right reason; put the message ' +
            'where the step prints it',
        );
        continue;
      }
      if (!printedBy.includes(quote.step)) {
        problems.push(
          `docs/demo-script.md: quotes "${piece}" for step ${quote.step}, and ` +
            `scripts/verify-main-chain.mjs prints it under step ${printedBy.join(', ')} — the ` +
            'demo attributes a line to a step that never prints it',
        );
      }
    }
  }

  const quoted = [...new Set(quotes.map((quote) => quote.step))].sort((a, b) => a - b);
  const driven = [...DRIVEN_STEPS].sort((a, b) => a - b);
  const missing = driven.filter((step) => !quoted.includes(step));
  const extra = quoted.filter((step) => !driven.includes(step) && step !== MANUAL_STEP);
  if (missing.length > 0) {
    problems.push(
      `docs/demo-script.md: the demo never shows step ${missing.join(', ')}, which the verifier ` +
        'drives — a step the demo skips is a step the reviewer is told nothing about',
    );
  }
  if (extra.length > 0) {
    problems.push(
      `docs/demo-script.md: quotes step ${extra.join(', ')}, which ` +
        `scripts/verify-main-chain.mjs does not drive (it drives ${driven.join(', ')})`,
    );
  }

  return problems;
}

/**
 * The section of a document that starts at `heading`, up to the next `## `.
 *
 * `undefined` when the heading is gone, on purpose: a document that dropped the
 * section would otherwise make "the sentence is in the section" true of the
 * whole file, which is the shape of a gate that stopped looking.
 */
function sectionOf(markdown: string, heading: string): string | undefined {
  const start = markdown.indexOf(heading);
  if (start === -1) return undefined;
  const next = markdown.indexOf('\n## ', start + heading.length);
  return next === -1 ? markdown.slice(start) : markdown.slice(start, next);
}

/**
 * Every way the two documents disagree about the Windows run.
 *
 * Empty means the demo script answers the question where it is asked, with the
 * command the checklist gives, and the checklist still says the same thing.
 * Pure in `(demo, manual)` so each red direction is driven rather than argued.
 */
function windowsProblems(demo: string, manual: string): string[] {
  const problems: string[] = [];

  const section = sectionOf(demo, WINDOWS_SECTION);
  if (section === undefined) {
    return [
      `docs/demo-script.md: has no \`${WINDOWS_SECTION}\` section, so the question a reviewer ` +
        'asks on stage has nowhere to be answered',
    ];
  }
  if (!section.includes(WINDOWS_CLAIM)) {
    problems.push(
      `docs/demo-script.md: the \`${WINDOWS_SECTION}\` section no longer says the Windows six ` +
        'steps have not been run — a demo that is silent about it reads as "it was run"',
    );
  }
  if (!section.includes(WINDOWS_COMMAND)) {
    problems.push(
      'docs/demo-script.md: the section no longer gives the command that produces the report, ' +
        'so "we have not run it" comes with no way to run it',
    );
  }
  if (!section.includes(WINDOWS_JUDGE)) {
    problems.push(
      'docs/demo-script.md: the section no longer says the carried-home report is judged with ' +
        `\`${WINDOWS_JUDGE}\`, so the command it gives has no reader`,
    );
  }

  // The other half of the same fact. If the checklist stops saying it, the demo
  // script is the only place left claiming it — and the two documents are
  // supposed to be one statement about one run.
  if (!manual.includes(WINDOWS_CLAIM)) {
    problems.push(
      'docs/manual-verification.md: no longer says the Windows six steps have not been run, ' +
        'while the demo script still does — one of the two is now wrong',
    );
  }
  if (!manual.includes(WINDOWS_COMMAND)) {
    problems.push(
      'docs/manual-verification.md: no longer spells the Windows command the demo script gives, ' +
        'so the two documents send the reader to two different commands',
    );
  }

  return problems;
}

const document = existsSync(DEMO_PATH) ? readFileSync(DEMO_PATH, 'utf8') : '';
const scriptSource = existsSync(VERIFIER_PATH) ? readFileSync(VERIFIER_PATH, 'utf8') : '';
const manual = existsSync(MANUAL_PATH) ? readFileSync(MANUAL_PATH, 'utf8') : '';

describe('the demo script demonstrates the steps the verifier drives', () => {
  it('the document is present, so the checks below have a subject', () => {
    // Unconditional: a missing document is a red run, not a skip.
    expect(existsSync(DEMO_PATH), 'docs/demo-script.md is missing').toBe(true);
    expect(document.length, 'docs/demo-script.md is empty').toBeGreaterThan(0);
  });

  it('quotes only output the verifier still prints, for exactly the driven steps', () => {
    const problems = demoProblems(document, scriptSource);
    expect(problems, `the demo and the verifier disagree:\n  ${problems.join('\n  ')}`).toEqual([]);
  });

  it('is not vacuous: the quotes really are in the document being compared', () => {
    // Without this, a refactor that emptied the extractor would leave the case
    // above passing over nothing at all.
    const quotes = quotesIn(document);
    expect(quotes.length, 'the demo script quotes no `[ok]` line').toBeGreaterThanOrEqual(
      DRIVEN_STEPS.length,
    );
    expect([...new Set(quotes.map((quote) => quote.step))].sort((a, b) => a - b)).toEqual(
      [...DRIVEN_STEPS].sort((a, b) => a - b),
    );
    // And the verifier really is the file being read, rather than the case
    // being green because nothing matched.
    expect(scriptSource).toContain('function pass(step, message)');
    expect(DRIVEN_STEPS.length, 'the verifier drives no steps').toBeGreaterThan(0);
  });
});

describe('the checks above, when the demo script has drifted', () => {
  it('reports a quote the verifier no longer prints', () => {
    // The failure this file is for: a `pass()` message is reworded, the demo
    // keeps quoting the old one, and the person on stage reads out a line that
    // will never appear.
    const problems = demoProblems(
      '`[ok] step 1: the same turn reads the same hash in both surfaces`',
      'pass(1, `the same turn reads the same digest in both surfaces`);',
    );
    expect(problems.some((problem) => problem.includes('no longer prints it'))).toBe(true);
  });

  it('reports a demo that skips a step the verifier drives', () => {
    // Step 4 is the one that used to be missing: the demo walked injection,
    // routing and handoff, then jumped to the five states, so the update check
    // was never shown and never mentioned.
    const withoutStep4 = document.replace(/\[ok\] step 4: [^`\n]+/g, '');
    expect(withoutStep4, 'the step 4 quote this case removes is gone').not.toBe(document);
    const problems = demoProblems(withoutStep4, scriptSource);
    expect(problems.some((problem) => problem.includes('never shows step 4'))).toBe(true);
  });

  it('reports a demo that quotes a step the verifier does not drive', () => {
    const problems = demoProblems(
      `${document}\n\`[ok] step 9: something nobody runs\``,
      scriptSource,
    );
    expect(problems.some((problem) => problem.includes('does not drive'))).toBe(true);
  });

  it('reports a demo that quotes an `[ok]` line for the manual step', () => {
    // The overclaim this file exists for: the five states are a person's walk,
    // and a demo script that prints an `[ok]` line for them is claiming a run
    // that cannot happen.
    const problems = demoProblems(
      `${document}\n\`[ok] step 6: the five states read as a first run\``,
      scriptSource,
    );
    expect(problems.some((problem) => problem.includes('walked by eye'))).toBe(true);
  });

  it('reports a quote that is nothing but an elision', () => {
    const problems = demoProblems(`${document}\n\`[ok] step 1: …\``, scriptSource);
    expect(problems.some((problem) => problem.includes('nothing but an elision'))).toBe(true);
  });

  it('reports a demo script that is missing altogether', () => {
    expect(demoProblems('', scriptSource)).toHaveLength(1);
    expect(demoProblems('', scriptSource)[0]).toContain('is missing or empty');
  });
});

/**
 * A verifier small enough to reason about, with one message per step.
 *
 * The real source is used for the green direction; this one is used for the red
 * direction, because the failure being demonstrated — a quote that belongs to
 * another step — cannot be produced by editing the real document without also
 * breaking the "quotes every driven step" rule, and a case that reds for two
 * reasons proves neither.
 */
const SYNTHETIC_SOURCE = [
  "const ORPHAN = 'a line no step prints';",
  'async function step1(cdp) { pass(1, `the same turn reads the same hash in both surfaces`); }',
  'async function step2(cdp) { pass(2, `${n} decisions carry rationale + confidence + engine`); }',
  'async function step3(cdp) { pass(3, `the handoff lands in the new session input`); }',
  'async function step4(run) { pass(4, `the real feed answered over the network: ${state}`); }',
  'async function step5() { pass(5, `the tray menu carries ${labels}`); }',
].join('\n');

/** One quote per driven step, each attributed to the step that prints it. */
const SYNTHETIC_DOCUMENT = [
  '`[ok] step 1: the same turn reads the same hash in both surfaces`',
  '`[ok] step 2: … decisions carry rationale + confidence + engine`',
  '`[ok] step 3: the handoff lands in the new session input`',
  '`[ok] step 4: the real feed answered over the network: …`',
  '`[ok] step 5: the tray menu carries …`',
].join('\n');

describe('a quote is tied to the step that prints it, not just to the file', () => {
  it('attributes every quote in the demo script to its own step', () => {
    // The green direction, on the real pair: every literal piece of every quote
    // is printed by the step the demo attributes it to. Without this the cases
    // below could be red because the analysis finds nothing at all.
    const regions = stepRegions(scriptSource);
    expect(regions.size, 'no step region was found in the verifier').toBe(DRIVEN_STEPS.length);
    for (const quote of quotesIn(document)) {
      for (const piece of pieces(quote.text)) {
        expect(
          stepsPrinting(piece, regions),
          `"${piece}" is quoted for step ${quote.step} and is not printed by it`,
        ).toContain(quote.step);
      }
    }
    // And the helper indirection really is followed: step 5's tray line is
    // built by `trayMenuVerdict()`, not written inside `step5()`.
    expect(stepsPrinting('the tray menu carries', regions)).toContain(5);
  });

  it('accepts the synthetic pair, so the red cases below are red for one reason', () => {
    expect(demoProblems(SYNTHETIC_DOCUMENT, SYNTHETIC_SOURCE)).toEqual([]);
  });

  it('reports a quote the verifier prints under a different step', () => {
    // The ambiguity this block exists for: `the handoff lands in the new session
    // input` is in the source, so the old check passed it — under step 1, where
    // the run never prints it. The demo would read out a line the reviewer sees
    // under a different heading, and nothing went red.
    const misattributed = SYNTHETIC_DOCUMENT.replace(
      '`[ok] step 1: the same turn reads the same hash in both surfaces`',
      '`[ok] step 1: the handoff lands in the new session input`',
    );
    expect(misattributed, 'the quote this case rewrites is gone').not.toBe(SYNTHETIC_DOCUMENT);
    const problems = demoProblems(misattributed, SYNTHETIC_SOURCE);
    expect(problems.some((problem) => problem.includes('prints it under step 3'))).toBe(true);
  });

  it('reports a quote that is in the source but outside every step', () => {
    // The other half of the same hole: a sentence that exists in the file and
    // is printed by nothing. Waving it through would leave the gate unable to
    // say which step it belongs to, which is the same as not checking it.
    const problems = demoProblems(
      `${SYNTHETIC_DOCUMENT}\n\`[ok] step 1: a line no step prints\``,
      SYNTHETIC_SOURCE,
    );
    expect(problems.some((problem) => problem.includes("not inside any step's code path"))).toBe(
      true,
    );
  });

  it("does not read a step's messages out of a comment that mentions its helper", () => {
    // The over-attribution that would make the gate weaker than it reads: a doc
    // comment saying "compared by `trayMenuVerdict()`" inside step 4 must not
    // pull step 5's tray line into step 4's region.
    const withMention = SYNTHETIC_SOURCE.replace(
      'async function step4(run) {',
      '// the two are compared by trayMenuVerdict()\nasync function step4(run) {',
    );
    expect(withMention, 'the comment this case adds is gone').not.toBe(SYNTHETIC_SOURCE);
    expect(stepsPrinting('the tray menu carries', stepRegions(withMention))).toEqual([5]);
  });
});

describe('the demo script answers "did you run it on Windows?" where it is asked', () => {
  it('carries the claim, the command and the judge flag in the section a reviewer asks in', () => {
    const problems = windowsProblems(document, manual);
    expect(
      problems,
      `the demo script and the checklist disagree about the Windows run:\n  ${problems.join('\n  ')}`,
    ).toEqual([]);
  });

  it('is not vacuous: the section, the claim and the command really are in the files', () => {
    // Without this, a refactor that emptied `sectionOf` would leave the case
    // above passing over nothing at all.
    const section = sectionOf(document, WINDOWS_SECTION);
    expect(section, `docs/demo-script.md has no \`${WINDOWS_SECTION}\` section`).toBeDefined();
    expect(section!).toContain(WINDOWS_CLAIM);
    expect(section!).toContain(WINDOWS_COMMAND);
    expect(section!).toContain(WINDOWS_JUDGE);
    // And the checklist really is the file being compared, rather than the case
    // being green because nothing matched.
    expect(manual).toContain(WINDOWS_CLAIM);
    expect(manual).toContain(WINDOWS_COMMAND);
  });

  it('reports a demo script that dropped the sentence', () => {
    // The failure this block exists for: the sentence goes back to living only
    // at the end of the checklist, and the person on stage has nothing to say.
    const withoutClaim = document.replaceAll(WINDOWS_CLAIM, '六步已跑');
    expect(withoutClaim, 'the claim this case removes is gone').not.toBe(document);
    const problems = windowsProblems(withoutClaim, manual);
    expect(problems.some((problem) => problem.includes('have not been run'))).toBe(true);
  });

  it('reports a demo script that dropped the command', () => {
    const withoutCommand = document.replace(WINDOWS_COMMAND, '跑一下那条命令');
    expect(withoutCommand, 'the command this case removes is gone').not.toBe(document);
    const problems = windowsProblems(withoutCommand, manual);
    expect(problems.some((problem) => problem.includes('no way to run it'))).toBe(true);
  });

  it('reports a demo script that dropped the section', () => {
    const withoutSection = document.replace(WINDOWS_SECTION, '## 别的标题');
    expect(withoutSection, 'the heading this case removes is gone').not.toBe(document);
    const problems = windowsProblems(withoutSection, manual);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('has nowhere to be answered');
  });

  it('reports a checklist that stopped saying it, while the demo script still does', () => {
    // The other direction: the day a Windows run lands, the checklist row is
    // updated and the demo script is not — or the reverse. Either way the two
    // documents are no longer one statement, and this is where that shows.
    const problems = windowsProblems(document, manual.replaceAll(WINDOWS_CLAIM, '六步已跑'));
    expect(problems.some((problem) => problem.includes('one of the two is now wrong'))).toBe(true);
  });

  it('reports a checklist that spells a different command', () => {
    const problems = windowsProblems(document, manual.replace(WINDOWS_COMMAND, 'node scripts\\verify-main-chain.mjs'));
    expect(problems.some((problem) => problem.includes('two different commands'))).toBe(true);
  });
});
