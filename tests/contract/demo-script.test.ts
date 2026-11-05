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
 *  - and every `pass()`/`fail()` call site that names a step sits inside that
 *    step's code path (see `orphanVerdicts`). The attribution above asks whether
 *    a *sentence* is reachable from a step; this asks whether the *verdict* is.
 *    A `pass()` in a function no step calls is invisible to the first question —
 *    no quote points at it — so the run would print one line fewer and every
 *    check here would stay green;
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

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { DEMO_BOUNDARIES, type DemoBoundary } from '../../apps/desktop/src/shared/demo-boundaries';
import { DRIVEN_STEPS } from '../../scripts/verify-main-chain.mjs';
// The three degraded-path commands and their block reader live in one module
// because `blocker-closing.test.ts` counts the same list: a copy in each file
// would let one gate be edited while the other kept counting the old length.
import { DEGRADED_COMMANDS, degradedBlocks } from './degraded-commands.ts';

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

/** One function definition in the verifier, with the text that follows it. */
interface Slice {
  readonly name: string;
  /** Offset of `function` in the comment-stripped source. */
  readonly start: number;
  /** Offset one past the last character this definition owns. */
  readonly end: number;
  readonly text: string;
}

/**
 * The verifier's function definitions, each with the text that follows it.
 *
 * Sliced from one `function name(` to the next rather than brace-matched: the
 * source is full of braces inside template literals and inside the page scripts
 * it injects, and a brace counter that is off by one would attribute a message
 * to the wrong step — silently, and in the direction that makes the gate green.
 *
 * The offsets are kept, not just the text, because the call-site check below
 * asks "which function is this `pass()` inside" — a question about a position,
 * which a concatenated string cannot answer.
 */
function functionSlices(source: string): Slice[] {
  const pattern = /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/g;
  const hits = [...source.matchAll(pattern)].map((match) => ({
    name: match[1]!,
    start: match.index,
  }));
  return hits.map((hit, index) => {
    const end = index + 1 < hits.length ? hits[index + 1]!.start : source.length;
    return { name: hit.name, start: hit.start, end, text: source.slice(hit.start, end) };
  });
}

/**
 * How many rounds of "and the functions *those* functions call" to follow.
 *
 * Eight is a guard rail, not a behaviour: the source needs exactly one round
 * today (`step5()` calls `trayMenuVerdict()`, which builds the message), and a
 * second round would only matter if a helper started calling a helper. The
 * number is here so the loop terminates on a source that calls itself in a
 * cycle — without it, a recursive helper would hang the suite instead of
 * failing it. If a message ever moves two helpers deep, the closure still finds
 * it; if it moves nine deep, the quote goes red as "not inside any step's code
 * path", which is a loud failure rather than a silent one.
 */
const MAX_CLOSURE_ROUNDS = 8;

/**
 * The functions each driven step's code can reach, by name.
 *
 * A step's `pass()` message is often built by a helper — `pass(5,
 * menuVerdict.message)` where `menuVerdict` came from `trayMenuVerdict()` — so a
 * region starts as `stepN()` and grows to include every function that region
 * calls, until it stops growing. That is one level of indirection more than the
 * source happens to need today, on purpose: the alternative is a gate that goes
 * red the first time a message is moved into a helper, which is how a gate gets
 * deleted instead of fixed.
 *
 * A step with no `stepN()` function has no entry, and a quote attributed to it
 * is then red — the same answer as a quote nobody prints.
 */
function stepClosure(source: string): Map<number, Set<string>> {
  const slices = functionSlices(codeOnly(source));
  const byName = new Map(slices.map((slice) => [slice.name, slice.text]));
  const closure = new Map<number, Set<string>>();
  for (const step of DRIVEN_STEPS) {
    if (byName.has(`step${step}`)) closure.set(step, new Set([`step${step}`]));
  }
  for (let round = 0; round < MAX_CLOSURE_ROUNDS; round += 1) {
    let grew = false;
    for (const names of closure.values()) {
      for (const [name] of byName) {
        if (names.has(name)) continue;
        const called = [...names].some((known) =>
          new RegExp(`\\b${name}\\s*\\(`).test(byName.get(known)!),
        );
        if (!called) continue;
        names.add(name);
        grew = true;
      }
    }
    if (!grew) break;
  }
  return closure;
}

/**
 * The source text each driven step can print from.
 *
 * The closure above, rendered back into text: `stepsPrinting()` asks whether a
 * quoted sentence appears in a step's reachable code, which is a question about
 * content rather than about position.
 */
function stepRegions(source: string): Map<number, string> {
  const slices = functionSlices(codeOnly(source));
  const byName = new Map(slices.map((slice) => [slice.name, slice.text]));
  const regions = new Map<number, string>();
  for (const [step, names] of stepClosure(source)) {
    regions.set(
      step,
      [...names].map((name) => byName.get(name)!).join('\n'),
    );
  }
  return regions;
}

/**
 * Every `pass(N, …)` / `fail(N, …)` call site that is not inside step N's code.
 *
 * ## Why this exists
 *
 * Everything above attributes a *sentence* to a step, and it does so by looking
 * for the sentence in the step's reachable code. That is the right question for
 * a quote, and it is not the same question as "does this step's code actually
 * print anything". A `pass()` that sits in a function no step calls is invisible
 * to the attribution: no quote points at it, so nothing goes red, and the step
 * it names is a step whose verdict is printed by code the run never reaches.
 *
 * So the call sites are checked directly, from the other end: every verdict with
 * a **numeric** step argument has to sit inside a function that step's closure
 * contains. A verdict whose step is a variable (`fail(step, …)` in the runner's
 * guard) or a word (`fail('run', …)` in the top-level catch) is not a claim
 * about one step and is skipped — those two shapes are the only ones in the
 * source, and the "not vacuous" case below counts the numeric ones so a source
 * that stopped matching cannot pass this by finding nothing.
 *
 * The failure names the line and the function, because the fix is "move the
 * message into the step that prints it", and that is a place, not a sentence.
 */
function orphanVerdicts(source: string): string[] {
  const code = codeOnly(source);
  const slices = functionSlices(code);
  const closure = stepClosure(source);
  const problems: string[] = [];
  for (const match of code.matchAll(/\b(pass|fail)\(\s*(\d+)\s*,/g)) {
    const step = Number(match[2]);
    const at = match.index ?? 0;
    const line = code.slice(0, at).split('\n').length;
    const owner = slices.find((slice) => at >= slice.start && at < slice.end);
    const where = `scripts/verify-main-chain.mjs:${line}`;
    if (owner === undefined) {
      problems.push(
        `${where}: \`${match[1]}(${step}, …)\` sits outside every function, so no step's code ` +
          'path prints it — the verdict is attributed to a step that never reaches it',
      );
      continue;
    }
    const names = closure.get(step);
    if (names === undefined) {
      problems.push(
        `${where}: \`${match[1]}(${step}, …)\` names step ${step}, and there is no ` +
          `\`step${step}()\` for it to belong to — the verdict is printed for a step the ` +
          'verifier does not drive',
      );
      continue;
    }
    if (!names.has(owner.name)) {
      problems.push(
        `${where}: \`${match[1]}(${step}, …)\` sits in \`${owner.name}()\`, which step ${step}'s ` +
          'code path never calls — the message would be attributed to a step that does not ' +
          'print it',
      );
    }
  }
  return problems;
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

/**
 * ## Why this block exists
 *
 * Everything above asks "is this sentence printed by the step the demo
 * attributes it to", and answers it by searching the step's reachable code for
 * the sentence. That is the right question for a quote, and it leaves one hole
 * open: a `pass()` that sits in a function **no step calls** is invisible to it.
 * No quote points at that call site, so nothing goes red — and the step it names
 * is a step whose verdict is printed by code the run never reaches. The gate
 * would read as strict as ever while the run printed one line fewer.
 *
 * So the call sites are checked from the other end, by position rather than by
 * text: every `pass(N, …)` / `fail(N, …)` with a numeric step has to sit inside
 * a function that step's closure contains. The two shapes that are not a claim
 * about one step — `fail(step, …)` in the runner's guard, `fail('run', …)` in
 * the top-level catch — are skipped, and the "not vacuous" case counts the
 * numeric ones so a source that stopped matching cannot pass by finding nothing.
 *
 * The red direction is driven on a source small enough to reason about, because
 * the failure being demonstrated (a verdict printed by a function nobody calls)
 * cannot be produced by editing the real verifier without also breaking the
 * quotes above — and a case that reds for two reasons proves neither.
 */

/** A verifier whose step 1 prints its verdict through a helper, as step 5 does. */
const INDIRECT_SOURCE = [
  'async function step1(cdp) { helper(); }',
  "function helper() { pass(1, 'the same turn reads the same hash in both surfaces'); }",
].join('\n');

describe('every verdict the verifier prints belongs to the step it names', () => {
  it('finds no `pass()`/`fail()` call site outside the step that prints it', () => {
    const problems = orphanVerdicts(scriptSource);
    expect(
      problems,
      `the verifier prints verdicts from code no step reaches:\n  ${problems.join('\n  ')}`,
    ).toEqual([]);
  });

  it('is not vacuous: every driven step has a numeric verdict call site', () => {
    // Without this, an extractor that stopped matching would leave the case
    // above green over an empty list — the shape of a gate that stopped looking.
    const code = codeOnly(scriptSource);
    const sites = [...code.matchAll(/\b(pass|fail)\(\s*(\d+)\s*,/g)].map((match) =>
      Number(match[2]),
    );
    expect(sites.length, 'the verifier has no numeric `pass()`/`fail()` call site').toBeGreaterThanOrEqual(
      DRIVEN_STEPS.length,
    );
    for (const step of DRIVEN_STEPS) {
      expect(sites, `no verdict is printed for step ${step}`).toContain(step);
    }
    // And the two non-numeric shapes really are in the source, so the skip above
    // is a decision about this file rather than a rule that never fires.
    expect(code).toContain("fail('run', error.message)");
    expect(code).toContain('fail(step, ');
  });

  it('accepts a verdict printed by a helper the step calls', () => {
    // The indirection the closure exists for: `pass(1, …)` inside `helper()`,
    // reached from `step1()`. A gate that only looked inside `stepN()` would
    // call this an orphan and be wrong.
    expect(orphanVerdicts(INDIRECT_SOURCE)).toEqual([]);
  });

  it('reports a verdict printed by a function no step calls', () => {
    // The hole this block closes: the message is in the file, the step number is
    // right, and the run never reaches the line that prints it.
    const orphaned = [
      'async function step1(cdp) { pass(1, `the same turn reads the same hash in both surfaces`); }',
      "function helper() { pass(1, 'a line from nowhere'); }",
    ].join('\n');
    const problems = orphanVerdicts(orphaned);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('which step 1\'s code path never calls');
    expect(problems[0]).toContain('helper()');
  });

  it('reports a verdict that names a step the verifier does not drive', () => {
    const problems = orphanVerdicts(
      'async function step1(cdp) { pass(7, `a step nobody drives`); }',
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('there is no `step7()`');
  });

  it('reports a verdict that sits outside every function', () => {
    const problems = orphanVerdicts("pass(1, 'printed at the top level');");
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('outside every function');
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

// ---------------------------------------------------------------------------
// The 30-second main chain, offline
// ---------------------------------------------------------------------------

/**
 * The section a reviewer reads out loud when there is no Windows machine, no
 * token and no network in the room.
 *
 * `docs/demo-script.md` used to describe the main chain only as five actions
 * driven by `scripts/verify-main-chain.mjs`, which needs a packaged Electron
 * app, a display and an OS key store. That is the right instrument for "did it
 * work on a real machine" and the wrong one for "is the page I am about to read
 * out loud still describing this build": nobody can re-run it on a laptop.
 *
 * `scripts/demo-walkthrough.mjs` runs the same three claims through the same
 * code the app runs — `InjectionRenderer.render()`, `DecisionChain`,
 * `assessRisk()` / `defaultPolicy()` — with no window, no network and no token.
 * The pack is fixed and `render()` is pure, so the hash it prints is the same on
 * every machine, which is what lets the document quote it verbatim.
 *
 * This block keeps the two halves from drifting, in both directions:
 *
 *  - every literal the document quotes for a step is printed by that step's run
 *    — so a reworded label, a changed engine id or a renderer change that moves
 *    the hash is a red run rather than a stale page;
 *  - every step the script runs is shown in the document — so a step added to
 *    the script and forgotten in the page is red too;
 *  - and the script really is a run, not a transcript: it imports the product's
 *    packages and does not contain the hash it prints.
 */

const DEMO_CHAIN_SECTION = '## 30 秒主链路（离线可跑）';
const WALKTHROUGH_PATH = join(REPO_ROOT, 'scripts', 'demo-walkthrough.mjs');

/** One step of the offline run, as the script reports it. */
interface ChainStep {
  readonly step: number;
  readonly title: string;
  readonly proves: string;
  readonly screen: readonly string[];
}

/** The run, as `runDemo()` returns it. */
interface ChainRun {
  readonly steps: readonly ChainStep[];
  readonly facts: { readonly shortHash: string; readonly engineId: string };
}

/** Whitespace is not the claim: the document writes one space, the screen two. */
function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * The step rows of the section: `| 1 | … | … | … |`.
 *
 * The step number is the first cell and the quoted screen text is the fourth;
 * a row whose first cell is not a bare integer (`| 1. 注入原文与哈希 | …`) is a
 * different table and is skipped rather than misread.
 */
function chainRows(section: string): Array<{ step: number; literals: string[] }> {
  const rows: Array<{ step: number; literals: string[] }> = [];
  for (const line of section.split('\n')) {
    const cells = line.split('|').map((cell) => cell.trim());
    if (cells.length < 6) continue;
    const step = Number(cells[1]);
    if (!Number.isInteger(step) || step <= 0) continue;
    const literals = [...cells[4]!.matchAll(/`([^`\n]+)`/g)].map((match) => match[1]!.trim());
    rows.push({ step, literals });
  }
  return rows;
}

/**
 * Every way the page and the offline run disagree.
 *
 * Empty means the document quotes only what the run prints, and the run prints
 * every step the document shows. Pure in `(document, run)` so the red direction
 * is driven with mutated copies instead of argued about.
 */
function chainProblems(document: string, run: ChainRun): string[] {
  const section = sectionOf(document, DEMO_CHAIN_SECTION);
  if (section === undefined) {
    return [
      `docs/demo-script.md: has no \`${DEMO_CHAIN_SECTION}\` section, so the offline run has ` +
        'nowhere to be read out loud',
    ];
  }
  const rows = chainRows(section);
  if (rows.length === 0) {
    return [
      `docs/demo-script.md: the \`${DEMO_CHAIN_SECTION}\` section lists no step row, so nothing ` +
        'ties the page to the run',
    ];
  }

  const problems: string[] = [];
  const byStep = new Map(run.steps.map((step) => [step.step, step]));

  for (const row of rows) {
    const step = byStep.get(row.step);
    if (step === undefined) {
      problems.push(
        `docs/demo-script.md: shows step ${row.step}, and scripts/demo-walkthrough.mjs does not ` +
          `run it (it runs ${run.steps.map((s) => s.step).join(', ')})`,
      );
      continue;
    }
    if (row.literals.length === 0) {
      problems.push(
        `docs/demo-script.md: step ${row.step} quotes no screen text, so a reader has nothing to ` +
          'compare the screen against',
      );
      continue;
    }
    const screen = step.screen.map(normalize);
    for (const literal of row.literals) {
      const wanted = normalize(literal);
      if (!screen.some((line) => line.includes(wanted))) {
        problems.push(
          `docs/demo-script.md: step ${row.step} says the screen shows "${literal}", and ` +
            'scripts/demo-walkthrough.mjs does not print it — the page describes a screen ' +
            'nobody will see',
        );
      }
    }
  }

  for (const step of run.steps) {
    if (!rows.some((row) => row.step === step.step)) {
      problems.push(
        `docs/demo-script.md: scripts/demo-walkthrough.mjs runs step ${step.step} ` +
          `(${step.title}), and the \`${DEMO_CHAIN_SECTION}\` section never shows it`,
      );
    }
  }

  return problems;
}

const walkthroughSource = existsSync(WALKTHROUGH_PATH) ? readFileSync(WALKTHROUGH_PATH, 'utf8') : '';
const { runDemo } = await import('../../scripts/demo-walkthrough.mjs');
const chainRun = (await runDemo()) as ChainRun;

describe('the 30-second main chain is a run, and the page quotes it', () => {
  it('the script is present and is a run rather than a transcript', () => {
    expect(existsSync(WALKTHROUGH_PATH), 'scripts/demo-walkthrough.mjs is missing').toBe(true);
    // The three claims come from the product's own packages. A script that
    // printed a hand-written transcript would pass every comparison below and
    // prove nothing, so the imports are the assertion.
    expect(walkthroughSource).toContain("from '@ucad/context'");
    expect(walkthroughSource).toContain("from '@ucad/decision'");
    expect(walkthroughSource).toContain("from '@ucad/permissions'");
    // And the hash it prints is computed, not pasted: the literal in the source
    // would make the document agree with a constant.
    expect(
      walkthroughSource.includes(chainRun.facts.shortHash),
      'scripts/demo-walkthrough.mjs contains the hash it prints, so the hash is a constant ' +
        'rather than the sha256 of the bytes it rendered',
    ).toBe(false);
  });

  it('runs the four steps the page walks', () => {
    expect(chainRun.steps.map((step) => step.step)).toEqual([1, 2, 3, 4]);
    for (const step of chainRun.steps) {
      expect(step.screen.length, `step ${step.step} prints nothing`).toBeGreaterThan(0);
    }
  });

  it('quotes only what the run prints, and shows every step the run prints', () => {
    const problems = chainProblems(document, chainRun);
    expect(problems, `the page and the offline run disagree:\n  ${problems.join('\n  ')}`).toEqual([]);
  });

  it('quotes the hash the run actually computed', () => {
    const section = sectionOf(document, DEMO_CHAIN_SECTION) ?? '';
    expect(
      section.includes(chainRun.facts.shortHash),
      `the page does not quote the hash this build renders (${chainRun.facts.shortHash}) — ` +
        'a renderer change moved the bytes and the page still shows the old digest',
    ).toBe(true);
  });
});

describe('the checks above, when the page or the run has drifted', () => {
  it('reports a step the run prints and the page never shows', () => {
    const withoutStep4 = document.replace(/^\| 4 \|.*$/m, '');
    expect(withoutStep4, 'the step 4 row this case removes is gone').not.toBe(document);
    const problems = chainProblems(withoutStep4, chainRun);
    expect(problems.some((problem) => problem.includes('never shows it'))).toBe(true);
  });

  it('reports a screen line the page quotes and the run no longer prints', () => {
    const reworded = document.replace('`置信度 72%`', '`置信度 99%`');
    expect(reworded, 'the confidence quote this case rewrites is gone').not.toBe(document);
    const problems = chainProblems(reworded, chainRun);
    expect(problems.some((problem) => problem.includes('does not print it'))).toBe(true);
  });

  it('reports a step the page shows and the run does not drive', () => {
    const extra = document.replace(
      '| 4 | 触发权限弹窗',
      '| 9 | 打开一个不存在的面板 | 什么也不证明 | `面板 不存在` |\n| 4 | 触发权限弹窗',
    );
    expect(extra, 'the step 9 row this case adds is gone').not.toBe(document);
    const problems = chainProblems(extra, chainRun);
    expect(problems.some((problem) => problem.includes('does not run it'))).toBe(true);
  });

  it('reports a section that is missing altogether', () => {
    const problems = chainProblems(document.replace(DEMO_CHAIN_SECTION, '## 别的标题'), chainRun);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('has no');
  });
});

// ---------------------------------------------------------------------------
// The three external blockers, and the line on screen while they are open
// ---------------------------------------------------------------------------

/**
 * ## Why this block exists
 *
 * `docs/blockers.md` and `docs/manual-verification.md` say, for each of the
 * three external blockers, what to type, what to see and where to put the
 * result. `docs/demo-script.md` said only what to *say* when a reviewer asks
 * "did you run it on a real machine?" — a sentence, with nothing on screen
 * behind it. On stage that is the weakest possible answer: the reviewer is
 * being asked to believe a claim about a machine nobody in the room has.
 *
 * Each blocker does have a command that runs **offline, on this machine**, and
 * prints one line that answers the question in the negative, out loud:
 *
 *  - the v1.0.0 feed has no `sha256`, so the release gate refuses to let a
 *    version ship — `node scripts/release-gate.mjs --simulate-missing-sha`;
 *  - the Windows six steps have not been run, and a hand-written report is not
 *    evidence — `node scripts/verify-main-chain.mjs --judge …/fail.json`;
 *  - the five states have not been signed off, but the images are still
 *    photographs of the current sources — `node scripts/screenshot-sources.mjs --check`.
 *
 * So the section now carries three blocks, each a command plus the first line
 * of its output. This block keeps the two halves together: the command has to
 * be the one the script answers to, and the quoted line has to be a literal the
 * script still prints. A reworded `REFUSED` sentence, a renamed flag or a
 * deleted script is a red run rather than a page that reads well and proves
 * nothing.
 *
 * ## Why the quoted line may be elided
 *
 * Two of the three lines carry a value that changes between machines — the
 * report path, the counts and the manifest path. The document elides those with
 * `…`, the same mark the `[ok]` quotes above use, and every literal piece of at
 * least {@link MIN_PIECE} characters has to be in the script's source. Short
 * pieces are dropped rather than checked: `PASS — ` is a label, not a claim.
 *
 * ## What is deliberately not asserted
 *
 * That the commands exit 0, or that the blockers are resolved. Two of the three
 * exit 1 on purpose — that is the point of showing them. This block only pins
 * that the page and the scripts still describe the same output.
 */

/** The shortest piece of a quoted line that counts as pinning wording. */
const MIN_PIECE = 20;

/** The script a `node scripts/…` command runs, or `undefined` for anything else. */
function scriptOf(command: string): string | undefined {
  return /^node (scripts\/[\w.-]+\.mjs)\b/.exec(command)?.[1];
}

/**
 * The source with its string concatenations joined and whitespace collapsed.
 *
 * A message long enough to matter is written across several `' … ' +` lines in
 * the source, so a verbatim comparison against the raw text would fail on a
 * line break rather than on a reworded sentence — the gate would be red for a
 * reason that is not the claim.
 */
function flatten(source: string): string {
  return source.replace(/' \+\s*\n\s*'/g, '').replace(/\s+/g, ' ');
}

/**
 * Every way the page and the three scripts disagree about what is on screen.
 *
 * Empty means each blocker has a block, the block's command is the one the page
 * promises, and every literal piece of its expected first line is still printed
 * by the script that command runs.
 */
function degradedProblems(
  section: string | undefined,
  read: (relativePath: string) => string | null,
): string[] {
  if (section === undefined) {
    return [
      `docs/demo-script.md: has no \`${WINDOWS_SECTION}\` section, so the three blockers have ` +
        'nowhere to be answered on stage',
    ];
  }
  const blocks = degradedBlocks(section);
  const problems: string[] = [];

  for (const command of DEGRADED_COMMANDS) {
    const block = blocks.find((candidate) => candidate.command === command);
    if (block === undefined) {
      problems.push(
        `docs/demo-script.md: gives no expected output for \`${command}\`, so that blocker is ` +
          'answered with a sentence rather than with a line on screen',
      );
      continue;
    }
    const script = scriptOf(command);
    if (script === undefined) {
      problems.push(`docs/demo-script.md: \`${command}\` does not name a script this gate can read`);
      continue;
    }
    const source = read(script);
    if (source === null) {
      problems.push(`docs/demo-script.md: \`${command}\` names \`${script}\`, which is not in the tree`);
      continue;
    }
    const flat = flatten(source);
    const literal = pieces(block.firstLine).filter((piece) => piece.length >= MIN_PIECE);
    if (literal.length === 0) {
      problems.push(
        `docs/demo-script.md: the expected first line for \`${command}\` pins no wording of at ` +
          `least ${MIN_PIECE} characters, so it cannot go red for the right reason`,
      );
      continue;
    }
    for (const piece of literal) {
      if (!flat.includes(piece)) {
        problems.push(
          `docs/demo-script.md: quotes "${piece}" as the first line of \`${command}\`, and ` +
            `${script} no longer prints it — the page describes output nobody will see`,
        );
      }
    }
  }

  return problems;
}

/** The repository text at a path, or `null` when the file is not there. */
function readRepoFile(relativePath: string): string | null {
  const absolute = join(REPO_ROOT, relativePath);
  return existsSync(absolute) ? readFileSync(absolute, 'utf8') : null;
}

describe('each external blocker has a command and a line on screen', () => {
  it('gives every blocker a command whose script still prints the quoted line', () => {
    const problems = degradedProblems(sectionOf(document, WINDOWS_SECTION), readRepoFile);
    expect(
      problems,
      `the demo script and the three scripts disagree:\n  ${problems.join('\n  ')}`,
    ).toEqual([]);
  });

  it('is not vacuous: three blocks, three scripts, three real sources', () => {
    const section = sectionOf(document, WINDOWS_SECTION);
    expect(section, `docs/demo-script.md has no \`${WINDOWS_SECTION}\` section`).toBeDefined();
    const commands = degradedBlocks(section!).map((block) => block.command);
    for (const command of DEGRADED_COMMANDS) {
      expect(commands, `the page gives no block for \`${command}\``).toContain(command);
      const script = scriptOf(command)!;
      expect(existsSync(join(REPO_ROOT, script)), `${script} is not in the tree`).toBe(true);
      // And the line really is compared against a script that prints something:
      // an empty source would make every `includes` false, which is red — but a
      // source that is the wrong file would make them false for the wrong
      // reason, so the script has to be the one the command names.
      expect(readRepoFile(script)!.length).toBeGreaterThan(0);
    }
  });

  it('reports an expected line the script no longer prints', () => {
    // The failure this block is for: a `REFUSED` sentence is reworded, the page
    // keeps quoting the old one, and the person on stage points at a line that
    // will never appear.
    const broken = document.replace(
      'a red report is a result, and the row stays open',
      'a red report is a claim, and the row stays open',
    );
    expect(broken, 'the quote this case rewrites is gone').not.toBe(document);
    const problems = degradedProblems(sectionOf(broken, WINDOWS_SECTION), readRepoFile);
    expect(problems.some((problem) => problem.includes('no longer prints it'))).toBe(true);
  });

  it('reports a blocker that lost its command', () => {
    const broken = document.replace('$ node scripts/screenshot-sources.mjs --check\n', '');
    expect(broken, 'the command this case removes is gone').not.toBe(document);
    const problems = degradedProblems(sectionOf(broken, WINDOWS_SECTION), readRepoFile);
    expect(problems.some((problem) => problem.includes('gives no expected output'))).toBe(true);
  });

  it('reports a command whose script is not in the tree', () => {
    // Driven through the reader rather than through the document: the three
    // commands are fixed, so the only way a script can go missing is the tree
    // losing it — and a page that quotes a script nobody can run is the same
    // defect as a page that quotes a line nobody prints.
    const problems = degradedProblems(sectionOf(document, WINDOWS_SECTION), () => null);
    expect(problems.some((problem) => problem.includes('is not in the tree'))).toBe(true);
  });

  it('reports a section that is missing altogether', () => {
    const problems = degradedProblems(undefined, readRepoFile);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('nowhere to be answered');
  });
});

// ---------------------------------------------------------------------------
// The one input the demo picks on purpose
// ---------------------------------------------------------------------------

/**
 * ## Why this block exists
 *
 * `step3()` of `scripts/demo-walkthrough.mjs` sends `objective: '继续'` and
 * `signals.turnIndex: 1` so that the jev engine abstains and the rule engine
 * answers — which is what makes the panel show a **fallback** rather than a
 * confident first-engine answer. The script says so in a comment; the page did
 * not, so the one line a reviewer is most likely to question ("why did jev not
 * answer?") had no answer on the page, and the person on stage would have had
 * to open the source to find one.
 *
 * So the 30-second table's step 3 row now says the objective is deliberately
 * vague, and this block pins both halves: the script still sends that objective,
 * and the page still says why. Change the objective to something specific and
 * the demo silently stops demonstrating the fallback — that is a red run here,
 * not a discovery on stage.
 */

/** The objective the demo sends on purpose. */
const VAGUE_OBJECTIVE = "objective: '继续'";

/** The words the page uses to say it is on purpose. */
const VAGUE_NOTE = '故意挑的模糊输入';

/** The body of `step3()`, sliced to the next function definition. */
function step3Body(source: string): string {
  const start = source.indexOf('async function step3(');
  if (start === -1) return '';
  const end = source.indexOf('async function step4(', start);
  return end === -1 ? source.slice(start) : source.slice(start, end);
}

/** The step 3 row of the 30-second table, or `undefined` when it is gone. */
function step3Row(markdown: string): string | undefined {
  const section = sectionOf(markdown, DEMO_CHAIN_SECTION);
  if (section === undefined) return undefined;
  return section.split('\n').find((line) => /^\|\s*3\s*\|/.test(line.trim()));
}

/**
 * Every way the page and the script disagree about the vague objective.
 *
 * Empty means the script still sends it and the page still says it is on
 * purpose. Pure in `(document, scriptSource)` so the red direction is driven
 * with mutated copies rather than argued about.
 */
function vagueInputProblems(markdown: string, scriptSource: string): string[] {
  const problems: string[] = [];
  if (!step3Body(scriptSource).includes(VAGUE_OBJECTIVE)) {
    problems.push(
      `scripts/demo-walkthrough.mjs: step3() no longer sends \`${VAGUE_OBJECTIVE}\`, so the jev ` +
        'engine may answer and the demo stops showing a fallback — the page still says it does',
    );
  }
  const row = step3Row(markdown);
  if (row === undefined) {
    problems.push(
      `docs/demo-script.md: the \`${DEMO_CHAIN_SECTION}\` section has no step 3 row, so the ` +
        'vague objective is not explained anywhere a reviewer reads',
    );
  } else if (!row.includes(VAGUE_NOTE)) {
    problems.push(
      `docs/demo-script.md: the step 3 row does not say the objective is a ${VAGUE_NOTE}, so ` +
        '"why did jev not answer?" has no answer on the page',
    );
  }
  return problems;
}

describe('the demo says which input it picked on purpose', () => {
  it('sends the vague objective and says so on the page', () => {
    const problems = vagueInputProblems(document, walkthroughSource);
    expect(problems, `the page and the run disagree:\n  ${problems.join('\n  ')}`).toEqual([]);
  });

  it('is not vacuous: the objective and the note really are in the files', () => {
    expect(step3Body(walkthroughSource), 'step3() was not found').toContain(VAGUE_OBJECTIVE);
    expect(step3Row(document), 'the step 3 row was not found').toContain(VAGUE_NOTE);
  });

  it('reports a page that stopped explaining the objective', () => {
    const broken = document.replace(VAGUE_NOTE, '一句普通输入');
    expect(broken, 'the note this case rewrites is gone').not.toBe(document);
    const problems = vagueInputProblems(broken, walkthroughSource);
    expect(problems.some((problem) => problem.includes('has no answer on the page'))).toBe(true);
  });

  it('reports a script that stopped sending the vague objective', () => {
    const broken = walkthroughSource.replace(VAGUE_OBJECTIVE, "objective: '修复登录失败并补测试'");
    expect(broken, 'the objective this case rewrites is gone').not.toBe(walkthroughSource);
    const problems = vagueInputProblems(document, broken);
    expect(problems.some((problem) => problem.includes('stops showing a fallback'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The line on screen is output, not source
// ---------------------------------------------------------------------------

/**
 * ## Why this block exists
 *
 * The block above asks whether each expected line is still **in the source** of
 * the script its command runs. That is a real check and it has a hole the size
 * of the whole point: a sentence can be in the source and never printed. A
 * message moved into a branch the flag does not take, a `pass()` behind an
 * early return, a line that only prints when the network answers — all of them
 * are "in the file", so the page, the shared list and the panel agree, and the
 * person on stage points at a line that will never appear.
 *
 * Worse, the two sides of that comparison are the page and the list, and both
 * are edited by the same person in the same commit. Two copies of one sentence
 * that agree with each other and with a source file prove that the sentence was
 * typed three times, not that it is printed once.
 *
 * So this block runs the three commands and compares against **stdout and
 * stderr of a real run**. It is the same rule the block above applies, moved
 * one step closer to the screen: every literal piece of at least
 * {@link MIN_PIECE} characters in an expected line has to be a substring of
 * what the command actually printed.
 *
 * ## Why both streams
 *
 * The three commands split their answer: `release-gate.mjs
 * --simulate-missing-sha` prints its `REFUSED` line on stdout, and
 * `verify-main-chain.mjs --judge` prints the `[FAIL] step …` line on stderr. A
 * check that read only stdout would be red about a line the reader does see,
 * and the fix for that would be to weaken the check rather than to fix it.
 *
 * ## What is deliberately not asserted
 *
 * That the commands exit 0. Two of the three exit 1 on purpose — that is what
 * they are demonstrating. Nor the wording of the rest of the output: this block
 * only asks whether the quoted line is among the lines printed.
 */

/** How long one of the three commands may take before the run counts as failed. */
const RUN_TIMEOUT_MS = 120_000;

/** One command's real run: everything it printed, and how it ended. */
interface CommandRun {
  /** stdout and stderr, joined — the reader sees both. */
  readonly output: string;
  /** The exit code, or `null` when the run was killed (a timeout, a signal). */
  readonly status: number | null;
}

/**
 * Run one `node scripts/…` command from the repository root.
 *
 * `process.execPath` rather than the literal `node` in the command: the command
 * is written for a reader's shell, and the test has to run under the same
 * interpreter as the suite rather than whatever `node` resolves to on `PATH`.
 */
function runCommand(command: string): CommandRun {
  const script = scriptOf(command);
  if (script === undefined) return { output: '', status: null };
  const args = command.split(/\s+/).slice(2);
  const result = spawnSync(process.execPath, [join(REPO_ROOT, script), ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: RUN_TIMEOUT_MS,
  });
  return { output: `${result.stdout ?? ''}\n${result.stderr ?? ''}`, status: result.status };
}

/** Each command is run once per file rather than once per case. */
const commandRuns = new Map<string, CommandRun>();

/** The cached run of a command, so three cases do not spawn three times. */
function runOnce(command: string): CommandRun {
  const cached = commandRuns.get(command);
  if (cached !== undefined) return cached;
  const run = runCommand(command);
  commandRuns.set(command, run);
  return run;
}

/**
 * Every way the shared list quotes a line its command does not print.
 *
 * Empty means each expected line is a substring of a real run's output. Pure in
 * `(boundaries, run)` so the red direction is driven with a mutated list and a
 * stubbed run instead of argued about.
 */
function outputProblems(
  boundaries: readonly DemoBoundary[],
  run: (command: string) => CommandRun | undefined,
): string[] {
  const problems: string[] = [];
  for (const boundary of boundaries) {
    const result = run(boundary.command);
    if (result === undefined) {
      problems.push(
        `apps/desktop/src/shared/demo-boundaries.ts: \`${boundary.id}\` shows a line for ` +
          `\`${boundary.command}\`, and nothing ran it — a line nobody ran is a line nobody saw`,
      );
      continue;
    }
    if (result.status === null) {
      problems.push(
        `apps/desktop/src/shared/demo-boundaries.ts: \`${boundary.command}\` did not finish ` +
          '(killed by a timeout or a signal), so the line the panel shows was never printed',
      );
      continue;
    }
    const literal = pieces(boundary.expected).filter((piece) => piece.length >= MIN_PIECE);
    if (literal.length === 0) {
      problems.push(
        `apps/desktop/src/shared/demo-boundaries.ts: \`${boundary.id}\` pins no wording of at ` +
          `least ${MIN_PIECE} characters, so its expected line cannot go red for the right reason`,
      );
      continue;
    }
    for (const piece of literal) {
      if (!result.output.includes(piece)) {
        problems.push(
          `apps/desktop/src/shared/demo-boundaries.ts: \`${boundary.id}\` shows "${piece}" as ` +
            `the line \`${boundary.command}\` prints, and that command never printed it — the ` +
            'page, the list and the panel agree on a sentence the script does not say',
        );
      }
    }
  }
  return problems;
}

describe('the expected line is what the command prints, not what the source says', () => {
  it('every expected line is a substring of a real run of its own command', () => {
    const problems = outputProblems(DEMO_BOUNDARIES, runOnce);
    expect(
      problems,
      `the panel quotes lines the commands do not print:\n  ${problems.join('\n  ')}`,
    ).toEqual([]);
  });

  it('is not vacuous: three commands, three runs, three lines with wording to check', () => {
    // Without this, a list whose expected lines were all short pieces would pass
    // the case above by having nothing to compare — the shape of a gate that
    // stopped looking.
    expect(DEMO_BOUNDARIES).toHaveLength(3);
    expect(new Set(DEMO_BOUNDARIES.map((boundary) => boundary.command)).size).toBe(3);
    for (const boundary of DEMO_BOUNDARIES) {
      const literal = pieces(boundary.expected).filter((piece) => piece.length >= MIN_PIECE);
      expect(
        literal.length,
        `${boundary.id} has no piece of at least ${MIN_PIECE} characters to look for`,
      ).toBeGreaterThan(0);
      const result = runOnce(boundary.command);
      expect(result.status, `\`${boundary.command}\` did not finish`).not.toBeNull();
      expect(result.output.trim().length, `\`${boundary.command}\` printed nothing`).toBeGreaterThan(
        0,
      );
    }
  });

  it('reports an expected line the command never prints', () => {
    // The failure this block is for: the sentence is in the script's source (so
    // the block above stays green), the page and the list both quote it, and the
    // run never reaches the line that prints it.
    const broken = DEMO_BOUNDARIES.map((boundary) =>
      boundary.id === 'feed'
        ? {
            ...boundary,
            expected:
              'REFUSED — the published feed is one the app would happily install from, and ' +
              'this sentence is printed by nothing at all',
          }
        : boundary,
    );
    const problems = outputProblems(broken, runOnce);
    expect(problems.some((problem) => problem.includes('never printed it'))).toBe(true);
    expect(problems.some((problem) => problem.includes('`feed`'))).toBe(true);
  });

  it('reports a command that was never run', () => {
    const problems = outputProblems(DEMO_BOUNDARIES, () => undefined);
    expect(problems).toHaveLength(DEMO_BOUNDARIES.length);
    expect(problems[0]).toContain('nothing ran it');
  });

  it('reports a run that was killed before it printed anything', () => {
    const problems = outputProblems(DEMO_BOUNDARIES, () => ({ output: '', status: null }));
    expect(problems.some((problem) => problem.includes('did not finish'))).toBe(true);
  });

  it('reports an expected line with no wording long enough to check', () => {
    const broken = DEMO_BOUNDARIES.map((boundary) => ({ ...boundary, expected: 'PASS — …' }));
    const problems = outputProblems(broken, runOnce);
    expect(problems.some((problem) => problem.includes('cannot go red for the right reason'))).toBe(
      true,
    );
  });
});

/**
 * The defence-day checklist: the page somebody reads while standing up.
 *
 * ## Why this file checks it
 *
 * `docs/demo-script.md` is the script — what to say, in what order, and what the
 * screen should show. It is not the page you read at 09:40 with the projector
 * already on: that page has to be a list of things to run and things to look at,
 * in the order the day happens, and every line of it has to be true *today*.
 *
 * A checklist rots differently from a script. A script that quotes a reworded
 * `[ok]` line is caught by the cases above; a checklist that says `npm run dev`
 * after the script was renamed, or points at a screenshot that was moved, is
 * caught by nothing — the reader finds out on stage. So every command, every
 * path and the one hash a reviewer is asked to verify are checked here.
 *
 * ## What is checked
 *
 *  - every `npm run <name>` the page names is a script in `package.json`;
 *  - every `node scripts/…` it names is a file in the repository;
 *  - every `docs/…` path it names exists (placeholders like `win-YYYYMMDD.json`
 *    are skipped — they are a naming convention, not a file);
 *  - the hash it tells the presenter to read out is the same literal
 *    `docs/demo-script.md` prints, because two pages spelling two hashes is two
 *    demonstrations that only one of them verified;
 *  - and the five things the brief asked the page to cover are on it: the app
 *    starts, the drawer's hash can be checked, the decision chain is visible,
 *    the permission prompt can be demonstrated, and the ten screenshots can be
 *    flipped through.
 *
 * Deliberately not asserted: wording, ordering, or that the demo would go well.
 */

const DEFENSE_PATH = join(REPO_ROOT, 'docs', 'defense-checklist.md');
const PACKAGE_PATH = join(REPO_ROOT, 'package.json');

/** A `npm run <name>` the page tells the presenter to type. */
const NPM_SCRIPT = /npm run ([\w:.-]+)/g;

/** A `node scripts/…` the page tells the presenter to type. */
const NODE_SCRIPT = /node (scripts[\\/][\w.-]+\.(?:mjs|cjs|js|ts))/g;

/** A repository path the page points at. */
const DOC_PATH = /docs\/[\w./-]+\.(?:md|png|json)/g;

/** The hash the presenter reads out, as both pages spell it. */
const HASH_LITERAL = /renderedHash ([0-9a-f]{16})/;

/** The five things the checklist has to cover, each with the literal that proves it. */
const CHECKLIST_COVERS: readonly { readonly what: string; readonly literal: string }[] = [
  { what: 'the app starts', literal: 'npm run dev' },
  { what: 'the drawer hash can be checked', literal: 'renderedHash' },
  { what: 'the decision chain is visible', literal: '引擎链' },
  { what: 'the permission prompt can be demonstrated', literal: 'Agent 请求权限' },
  { what: 'the ten screenshots can be flipped through', literal: '--walkthrough' },
];

/** What the checklist is compared against. */
interface DefenceRepository {
  /** The text of the checklist, or `''` when it is not there. */
  readonly checklist: string;
  /** The demo script, for the hash comparison. */
  readonly demo: string;
  /** The `scripts` block of `package.json`. */
  readonly scripts: ReadonlySet<string>;
  /** Whether a repository-relative path exists. */
  readonly exists: (relativePath: string) => boolean;
}

/**
 * Every way the checklist names something that is not there.
 *
 * Pure in `(checklist, repository)` so the red direction is driven with a
 * mutated copy: a gate whose failure path has never run is a gate that might be
 * reporting `[]` whatever it is handed.
 */
function checklistProblems(repository: DefenceRepository): string[] {
  const { checklist } = repository;
  if (checklist.trim().length === 0) {
    return ['docs/defense-checklist.md: is missing or empty, so there is no page to read on the day'];
  }

  const problems: string[] = [];
  for (const match of checklist.matchAll(NPM_SCRIPT)) {
    const name = match[1]!;
    if (repository.scripts.has(name)) continue;
    problems.push(
      `docs/defense-checklist.md: tells the presenter to run \`npm run ${name}\`, which is not a ` +
        'script in package.json — the command on the page is not the command in the repository',
    );
  }
  for (const match of checklist.matchAll(NODE_SCRIPT)) {
    const path = match[1]!.replaceAll('\\', '/');
    if (repository.exists(path)) continue;
    problems.push(
      `docs/defense-checklist.md: tells the presenter to run \`node ${path}\`, which is not in ` +
        'the repository',
    );
  }
  for (const match of checklist.matchAll(DOC_PATH)) {
    const path = match[0];
    // `win-YYYYMMDD.json` is a naming convention the reader fills in, not a file.
    if (path.includes('YYYY')) continue;
    if (repository.exists(path)) continue;
    problems.push(
      `docs/defense-checklist.md: points at \`${path}\`, which is not in the repository — the ` +
        'presenter would open a 404 in front of a reviewer',
    );
  }

  for (const { what, literal } of CHECKLIST_COVERS) {
    if (checklist.includes(literal)) continue;
    problems.push(
      `docs/defense-checklist.md: does not cover ${what} (\`${literal}\`), so the page is a list ` +
        'of commands rather than a rehearsal of the demonstration',
    );
  }

  const mine = HASH_LITERAL.exec(checklist);
  const theirs = HASH_LITERAL.exec(repository.demo);
  if (mine === null) {
    problems.push(
      'docs/defense-checklist.md: names no `renderedHash …`, so the one number a reviewer can ' +
        'verify on their own machine is not on the page',
    );
  } else if (theirs === null) {
    problems.push(
      'docs/demo-script.md: no longer prints a `renderedHash …`, so the checklist has nothing to ' +
        'agree with',
    );
  } else if (mine[1] !== theirs[1]) {
    problems.push(
      `docs/defense-checklist.md: tells the presenter to read out \`${mine[1]}\` and ` +
        `docs/demo-script.md prints \`${theirs[1]}\` — two pages, two hashes, one of them is wrong`,
    );
  }

  return problems;
}

const DEFENCE: DefenceRepository = {
  checklist: existsSync(DEFENSE_PATH) ? readFileSync(DEFENSE_PATH, 'utf8') : '',
  demo: document,
  scripts: new Set(
    Object.keys(
      (JSON.parse(readFileSync(PACKAGE_PATH, 'utf8')) as { scripts?: Record<string, string> })
        .scripts ?? {},
    ),
  ),
  exists: (relativePath) => existsSync(join(REPO_ROOT, relativePath)),
};

describe('the defence-day checklist only names things that exist', () => {
  it('names commands, paths and a hash that are all real today', () => {
    const problems = checklistProblems(DEFENCE);
    expect(
      problems,
      `the checklist and the repository disagree:\n  ${problems.join('\n  ')}`,
    ).toEqual([]);
  });

  it('is not vacuous: the page really carries the commands being compared', () => {
    // Without this, a page that lost every command would pass the case above
    // over an empty list of matches.
    expect(DEFENCE.checklist.length, 'docs/defense-checklist.md is empty').toBeGreaterThan(500);
    expect([...DEFENCE.checklist.matchAll(NPM_SCRIPT)].length).toBeGreaterThan(2);
    expect([...DEFENCE.checklist.matchAll(NODE_SCRIPT)].length).toBeGreaterThan(1);
    expect(DEFENCE.scripts.has('dev:web'), 'package.json lost `dev:web`').toBe(true);
  });

  it('reports a command the repository does not have', () => {
    const problems = checklistProblems({
      ...DEFENCE,
      checklist: DEFENCE.checklist.replace('npm run dev:web', 'npm run dev:web2'),
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('npm run dev:web2');
    expect(problems[0]).toContain('not a script in package.json');
  });

  it('reports a script file that was renamed', () => {
    const problems = checklistProblems({
      ...DEFENCE,
      checklist: DEFENCE.checklist.replace(
        'node scripts/screenshot-sources.mjs --walkthrough',
        'node scripts/screenshots.mjs --walkthrough',
      ),
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('scripts/screenshots.mjs');
  });

  it('reports a screenshot or document that is not there', () => {
    const problems = checklistProblems({
      ...DEFENCE,
      checklist: DEFENCE.checklist.replace(
        'docs/screenshots/empty.png',
        'docs/screenshots/first-run.png',
      ),
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('docs/screenshots/first-run.png');
  });

  it('reports a hash that disagrees with the demo script', () => {
    // The failure this case is for: the pack changed, the demo script was
    // updated, and the checklist kept the old number — so the presenter reads
    // out a hash the screen does not show.
    const problems = checklistProblems({
      ...DEFENCE,
      checklist: DEFENCE.checklist.replace('8847aa57a7138fd5', '0000000000000000'),
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('two pages, two hashes');
  });

  it('reports a page that dropped one of the five things to demonstrate', () => {
    const problems = checklistProblems({
      ...DEFENCE,
      checklist: DEFENCE.checklist.replaceAll('引擎链', '决策面板'),
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('the decision chain is visible');
  });

  it('reports a checklist that is missing altogether', () => {
    const problems = checklistProblems({ ...DEFENCE, checklist: '' });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('is missing or empty');
  });
});
