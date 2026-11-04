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
      if (scriptSource.includes(piece)) continue;
      problems.push(
        `docs/demo-script.md: quotes "${piece}" from step ${quote.step}, and ` +
          'scripts/verify-main-chain.mjs no longer prints it — the demo describes output ' +
          'nobody will see',
      );
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

const document = existsSync(DEMO_PATH) ? readFileSync(DEMO_PATH, 'utf8') : '';
const scriptSource = existsSync(VERIFIER_PATH) ? readFileSync(VERIFIER_PATH, 'utf8') : '';

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
