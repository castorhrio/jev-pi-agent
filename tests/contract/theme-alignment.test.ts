/**
 * The theme-alignment page's quotes, pinned to what actually prints them.
 *
 * ## Why this file exists
 *
 * `docs/theme-alignment.md` is the page the first-review speaker reads out loud:
 * the two black lines translated into the theme's language, a 30-second script,
 * and the argument for what degrades without them. The page says of itself that
 * its narrative does not enter any gate — and that must stay true: nothing here
 * judges whether the argument is well made. But the page is also full of
 * backticked quotes — a hash, an engine chain, a confidence, a trace, a
 * fallback line, field names — and every one of them is something a speaker
 * points at on a screen. `docs/demo-script.md` has every sentence of its own
 * pinned by `demo-script.test.ts`; this page had none. The failure it prevents
 * is the on-stage one: the speaker says 「指 `置信度 72%`」 and the screen shows
 * something else, because a renderer moved, a dictionary value was reworded, or
 * the chain's trace shape changed — all silent, all discovered in front of a
 * reviewer with the projector already on.
 *
 * So this file pins the quotes, and only the quotes. Each check compares a
 * literal the page quotes with the thing that actually produces it:
 *
 *  - the screen literals in the 30-second table (`renderedHash 8847aa57a7138fd5`,
 *    `引擎链 jev > rule`, `置信度 72%`, `链路 jev:ok`) are printed by the same
 *    offline run `docs/demo-script.md` is pinned against — `runDemo()`, the
 *    computed run, not a transcript;
 *  - the four lines the page's own two-sentence claim says a speaker can point
 *    at are still quoted by the page. The claim is directional: the page may
 *    quote a subset of the run (it is a translation, not a transcript), but the
 *    lines it names as pointable have to stay on it;
 *  - the field names the page quotes (`renderedHash` in the context drawer,
 *    `引擎链` / `置信度` / `理由` in the decision panel) are the `zh-CN`
 *    dictionary's own values under the keys those surfaces render, and the
 *    fallback template is still the sentence the page quotes a rendering of —
 *    a reworded label is a red run, not a page that quietly points at a word
 *    the app no longer shows;
 *  - the two fallback materials (`jev:timeout > rule:ok` and
 *    `发生了回落：timeout`) are deliberately NOT printed by today's run — the
 *    offline demo answers without falling back, and the page says so out loud.
 *    They are produced here by a real fallback rehearsal instead: a chain whose
 *    first engine times out, whose trace therefore reads `jev:timeout > rule:ok`,
 *    whose result is stamped `fallback`, and whose on-screen sentence is the
 *    `decision.fallbackReason` template rendered with that reason. The page
 *    quotes the rehearsal's output, so a chain that stopped tracing its
 *    fallback, or a reworded template, is red here before it is wrong on stage;
 *  - the `permission.resolved` event type the page names as one of the three
 *    hand-off-able records exists in the contract, and every repository path
 *    the page points at is in the tree;
 *  - and the page still says its own quotes are pinned by this file — the
 *    sentence is part of what lets a reader trust the page, so it is pinned too.
 *
 * ## Why the rehearsal, not the source
 *
 * `packages/decision/src/chain.ts` promises in its header that a fallback
 * always leaves a trace. Reading the promise back out of the source would pin
 * the comment, not the behaviour — the same hole `demo-script.test.ts` closes
 * with "the line on screen is output, not source". Driving a real chain with a
 * real timeout exercises the promise: the rendered trace line and the rendered
 * fallback sentence are what the page quotes, and either one drifting is a page
 * describing a screen nobody will see. The invariant half — that the trace is
 * kept and the result stamped — is asserted on the real rehearsal, whose red
 * direction is a change to the chain itself rather than a mutated copy.
 *
 * ## What is deliberately not asserted
 *
 * The narrative. Whether the theme argument is persuasive, whether the 90
 * seconds read well, whether the reverse argument is fair — none of that is a
 * gate's business, and the page says so of itself. The four table rows are
 * required to exist because each carries quotes, not because the second counts
 * are a promise. And the page is not required to quote everything the run
 * prints: `docs/demo-script.md` carries the full step-by-step mapping, and the
 * `由谁给出` line the page mentions in prose is the speaker's to paraphrase.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { payloadSchemas } from '@ucad/contracts';
import type { DecisionEngine, DecisionEngineManifest, DecisionRequest } from '@ucad/contracts';
import {
  buildDecisionFacts,
  DecisionChain,
  JEV_ENGINE_ID,
  RULE_ENGINE_ID,
} from '@ucad/decision';
import { dictionaryFor } from '../../apps/desktop/src/shared/i18n';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const PAGE_PATH = join(REPO_ROOT, 'docs', 'theme-alignment.md');

/** The section a speaker reads out loud when the 30 seconds start. */
const SCRIPT_SECTION = '## 30 秒演示脚本（照着念）';

/** The four moments the table walks, as the page spells the second counts. */
const TABLE_SPANS: readonly string[] = ['0–8', '8–16', '16–24', '24–30'];

/** The labels whose lines the page claims a speaker can point at on a screen. */
const POINTED_AT: readonly string[] = ['renderedHash', '引擎链', '置信度', '链路'];

/**
 * The field names the page quotes, and the dictionary keys the surfaces render
 * them from. The page's claim is 「两句都能在屏幕上指到一个字段」 — each of
 * these has to still be the word the app puts on that surface.
 */
const LABELS: readonly {
  readonly key: string;
  readonly value: string;
  readonly surface: string;
}[] = [
  { key: 'context.renderedHash', value: 'renderedHash', surface: 'the context drawer' },
  { key: 'decision.chain', value: '引擎链', surface: 'the decision panel' },
  { key: 'decision.confidence', value: '置信度', surface: 'the decision panel' },
  { key: 'decision.rationale', value: '理由', surface: 'the decision panel' },
];

/** The dictionary key the page names as the fallback row's origin. */
const FALLBACK_KEY = 'decision.fallbackReason';

/** The fallback sentence's template, as the page quotes a rendering of it. */
const FALLBACK_TEMPLATE = '发生了回落：{reason}';

/** The reason a timed-out first engine leaves in the trace, per chain.ts. */
const TIMEOUT_REASON = 'timeout';

/** The key that records a permission refusal as an event nobody can deny happened. */
const PERMISSION_EVENT = 'permission.resolved';

/** The sentence that tells a reader which gate holds this page's quotes. */
const PINNED_BY = '这一页的引文由 `tests/contract/theme-alignment.test.ts` 钉住，叙事本身不进任何门禁';

/** The offline run, as `runDemo()` returns the parts this file compares. */
interface DemoRun {
  readonly steps: readonly { readonly step: number; readonly screen: readonly string[] }[];
  readonly facts: { readonly shortHash: string };
}

/** What one real fallback produced, rendered the way the page quotes it. */
interface Rehearsal {
  /** The trace line, as the chain rendered it: `<id>:<outcome> > …`. */
  readonly traceLine: string;
  /** The on-screen fallback sentence, as the dictionary template renders it. */
  readonly fallbackLine: string;
  /** Whether the chain recorded the fallback on the trace. */
  readonly usedFallback: boolean;
  /** The reason the chain recorded. */
  readonly reason: string;
  /** Whether the result was stamped with the fallback. */
  readonly resultStamped: boolean;
}

/** Whitespace is not the claim: the document writes one space, the screen two. */
function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * The section of a document that starts at `heading`, up to the next `## `.
 *
 * `undefined` when the heading is gone, on purpose: a page that dropped the
 * section would otherwise make "the quote is in the section" true of the whole
 * file, which is the shape of a gate that stopped looking.
 */
function sectionOf(markdown: string, heading: string): string | undefined {
  const start = markdown.indexOf(heading);
  if (start === -1) return undefined;
  const next = markdown.indexOf('\n## ', start + heading.length);
  return next === -1 ? markdown.slice(start) : markdown.slice(start, next);
}

/**
 * The table's moment rows: `| 0–8 | … | … |`, keyed by the second span.
 *
 * The span is the first cell and the quotes are the backticked literals in the
 * whole row — both the 做什么 cell and the 念什么 cell carry them. A row whose
 * first cell is not a second span (the header, the `---` rule) is not a moment
 * and is skipped rather than misread.
 */
function scriptRows(section: string): Array<{ span: string; literals: string[] }> {
  const rows: Array<{ span: string; literals: string[] }> = [];
  for (const line of section.split('\n')) {
    const cells = line.split('|').map((cell) => cell.trim());
    if (cells.length < 4) continue;
    if (!/^\d+–\d+$/.test(cells[1] ?? '')) continue;
    const literals = [...line.matchAll(/`([^`\n]+)`/g)].map((match) => match[1]!.trim());
    rows.push({ span: cells[1]!, literals });
  }
  return rows;
}

/**
 * Every way the page and the run disagree about the 30-second script.
 *
 * Empty means the table has its four moments, every literal it quotes is
 * printed by the offline run or produced by the fallback rehearsal, and each of
 * the four pointable lines the page's own claim names is still on the page.
 * Pure in `(section, run, rehearsal)` so each red direction is driven with a
 * mutated copy rather than argued about.
 */
function scriptProblems(section: string | undefined, run: DemoRun, rehearsal: Rehearsal): string[] {
  if (section === undefined) {
    return [
      `docs/theme-alignment.md: has no \`${SCRIPT_SECTION}\` section, so the 30 seconds a speaker ` +
        'reads out loud are on no page',
    ];
  }
  const problems: string[] = [];
  const rows = scriptRows(section);

  for (const span of TABLE_SPANS) {
    if (rows.some((row) => row.span === span)) continue;
    problems.push(
      `docs/theme-alignment.md: the 30-second table no longer has a ${span} row — a moment the ` +
        'script walks that is on no page reads, on stage, as a script that skips it',
    );
  }

  const runLines = run.steps.flatMap((step) => step.screen).map(normalize);
  const rehearsalLines = [rehearsal.traceLine, rehearsal.fallbackLine];
  for (const row of rows) {
    for (const literal of row.literals) {
      const wanted = normalize(literal);
      if (runLines.some((line) => line.includes(wanted))) continue;
      if (rehearsalLines.includes(wanted)) continue;
      problems.push(
        `docs/theme-alignment.md: the ${row.span} row says the screen shows "${literal}", and ` +
          'neither scripts/demo-walkthrough.mjs prints it nor does the fallback rehearsal ' +
          'produce it — the speaker points at a line that is not on any screen',
      );
    }
  }

  for (const label of POINTED_AT) {
    const printed = runLines.find((line) => line.startsWith(`${label} `));
    if (printed === undefined) {
      problems.push(
        `docs/theme-alignment.md: names \`${label}\` as a line a speaker can point at, and ` +
          'scripts/demo-walkthrough.mjs prints no such line any more — the claim about the ' +
          'screen and the screen itself have come apart',
      );
      continue;
    }
    if (!normalize(section).includes(printed)) {
      problems.push(
        `docs/theme-alignment.md: claims the speaker can point at \`${label}\` on the screen, ` +
          `and no longer quotes the line the run prints for it ("${printed}") — a moment the ` +
          'page walks without its quote is a moment the speaker improvises',
      );
    }
  }

  return problems;
}

/**
 * The page's quoted fallback sentence, extracted by the template's prefix.
 *
 * The sentence shape comes from the template this gate pins
 * ({@link FALLBACK_TEMPLATE}), not from a second spelling of it: whatever sits
 * between the prefix and the closing backtick is the quote being compared
 * against what the dictionary actually renders.
 */
function quotedFallbackSentence(section: string): string | undefined {
  const prefix = FALLBACK_TEMPLATE.split('{reason}')[0] ?? '';
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('`(' + escaped + '[^`\\n]+)`').exec(section)?.[1];
}

/**
 * Every way the page and the rehearsal disagree about the fallback row.
 *
 * Empty means the page still quotes the trace line and the fallback sentence a
 * real fallback produces — the sentence compared verbatim against what the
 * dictionary template renders, so a reworded template or a renamed reason is
 * red in both directions — and still names the dictionary key that renders it.
 * This is the direction the table check above cannot see: deleting the 24–30
 * row removes the quotes without leaving a stale one behind, and a page that no
 * longer shows where the fallback row comes from is a page whose
 * 「回落被记成回落」 has no answer on stage.
 */
function fallbackOriginProblems(section: string | undefined, rehearsal: Rehearsal): string[] {
  if (section === undefined) {
    return [
      `docs/theme-alignment.md: has no \`${SCRIPT_SECTION}\` section, so the 30 seconds a speaker ` +
        'reads out loud are on no page',
    ];
  }
  const problems: string[] = [];
  if (!section.includes(rehearsal.traceLine)) {
    problems.push(
      `docs/theme-alignment.md: the 30-second script no longer shows the fallback row's origin — ` +
        `nothing on the page quotes "${rehearsal.traceLine}", the trace a real fallback leaves, ` +
        'so the speaker cannot point at where a fallback row would come from',
    );
  }
  const quoted = quotedFallbackSentence(section);
  if (quoted === undefined) {
    problems.push(
      `docs/theme-alignment.md: the 30-second script no longer shows the fallback row's origin — ` +
        `nothing on the page quotes the \`${FALLBACK_KEY}\` sentence a real fallback renders`,
    );
  } else if (quoted !== rehearsal.fallbackLine) {
    problems.push(
      `docs/theme-alignment.md: quotes "${quoted}" as the fallback row, and \`${FALLBACK_KEY}\` ` +
        `now renders "${rehearsal.fallbackLine}" — the page quotes a line the app no longer shows`,
    );
  }
  if (!section.includes(FALLBACK_KEY)) {
    problems.push(
      `docs/theme-alignment.md: no longer names \`${FALLBACK_KEY}\`, so the page shows what a ` +
        'fallback row looks like without saying where the row comes from',
    );
  }
  return problems;
}

/**
 * Every way the page and the dictionary disagree about the field names.
 *
 * Empty means each label the page quotes is still the dictionary value the
 * surface renders and is still named on the page, the fallback template is
 * still the sentence the page quotes a rendering of, and the template keeps its
 * `{reason}` placeholder in both locales. Pure in `(page, zh, en)` so the
 * reworded-dictionary red direction is driven with a mutated copy rather than
 * argued about.
 */
function labelProblems(
  page: string,
  zh: Readonly<Record<string, string>>,
  en: Readonly<Record<string, string>>,
): string[] {
  const problems: string[] = [];
  for (const { key, value, surface } of LABELS) {
    const actual = zh[key];
    if (actual !== value) {
      problems.push(
        `apps/desktop/src/shared/i18n.ts: \`${key}\` is \`${actual ?? '(missing)'}\`, and ` +
          `docs/theme-alignment.md quotes \`${value}\` — the page names a field the app no ` +
          'longer shows (or the dictionary was reworded); the page and the dictionary have to ' +
          'move together',
      );
      continue;
    }
    if (!page.includes(value)) {
      problems.push(
        `docs/theme-alignment.md: no longer names \`${value}\` (${surface}), so the speaker is ` +
          'told the field exists without being told what to look for',
      );
    }
  }
  if (zh[FALLBACK_KEY] !== FALLBACK_TEMPLATE) {
    problems.push(
      `apps/desktop/src/shared/i18n.ts: \`${FALLBACK_KEY}\` is ` +
        `\`${zh[FALLBACK_KEY] ?? '(missing)'}\`, and docs/theme-alignment.md quotes ` +
        `\`${FALLBACK_TEMPLATE.replace('{reason}', TIMEOUT_REASON)}\` — the fallback sentence the ` +
        'page quotes is no longer the sentence the app renders',
    );
  }
  if (!zh[FALLBACK_KEY]?.includes('{reason}')) {
    problems.push(
      `apps/desktop/src/shared/i18n.ts: \`${FALLBACK_KEY}\` lost its \`{reason}\` placeholder, so ` +
        'the fallback sentence the page quotes can no longer be rendered from the template',
    );
  }
  if (!en[FALLBACK_KEY]?.includes('{reason}')) {
    problems.push(
      `apps/desktop/src/shared/i18n.ts: the English \`${FALLBACK_KEY}\` lost its \`{reason}\` ` +
        'placeholder, so the same fallback row renders without its reason in English',
    );
  }
  return problems;
}

/** A repository path the page points at, quoted in backticks. */
const REPO_REFERENCE = /`((?:docs|tests|scripts|packages|apps)\/[\w./-]+)`/g;

/**
 * Every way the page points at something that is not there.
 *
 * Empty means every backticked repository path is in the tree. Pure in
 * `(page, exists)` so the renamed-path red direction is driven with a mutated
 * copy rather than argued about.
 */
function referenceProblems(page: string, exists: (relativePath: string) => boolean): string[] {
  const problems: string[] = [];
  for (const match of page.matchAll(REPO_REFERENCE)) {
    const path = match[1]!;
    if (exists(path)) continue;
    problems.push(
      `docs/theme-alignment.md: points at \`${path}\`, which is not in the repository — the ` +
        'speaker would open a 404 in front of a reviewer',
    );
  }
  return problems;
}

/**
 * Whether the page still says which gate holds its quotes.
 *
 * Pure in `page` so the red direction is driven with a mutated copy rather than
 * argued about.
 */
function selfClaimProblems(page: string): string[] {
  if (page.includes(PINNED_BY)) return [];
  return [
    `docs/theme-alignment.md: no longer says "${PINNED_BY}" — a reader who trusts the page ` +
      'without that sentence is trusting quotes the page itself disclaims',
  ];
}

/**
 * The rehearsal's first engine: the real jev id, a real manifest, a decide that
 * never answers because the chain's per-call timeout fires first.
 *
 * The id is imported rather than spelled so the rendered trace line stays tied
 * to the engine the product actually registers — an id rename is a red page
 * here, not a rehearsal that quietly rehearses somebody else.
 */
function timedOutJevStub(): DecisionEngine {
  const manifest: DecisionEngineManifest = {
    id: JEV_ENGINE_ID,
    displayName: JEV_ENGINE_ID,
    version: '0.0.0',
    sideEffects: ['none'],
    supportedKinds: ['route'],
    timeoutMs: 5,
  };
  return {
    manifest,
    initialize: async () => undefined,
    supports: (kind) => manifest.supportedKinds.includes(kind),
    decide: async (request: DecisionRequest) => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      throw new Error(`${manifest.id} should have timed out (${request.requestId})`);
    },
    dispose: async () => undefined,
  };
}

/**
 * A real fallback, driven end to end.
 *
 * The chain is `[jev]` with the default rule fallback, and the jev stub's budget
 * is below its own compute time, so the chain marks the attempt `timeout`, falls
 * back to the rule engine, and stamps the result — the behaviour
 * `packages/decision/src/chain.ts` promises in its header. The rendered trace
 * line and the rendered fallback sentence are what the page quotes; this is
 * where they come from.
 */
async function driveFallbackRehearsal(): Promise<Rehearsal> {
  const zh = dictionaryFor('zh-CN');
  const chain = new DecisionChain({ engines: [timedOutJevStub()], logger: null });
  let traceLine = '';
  let usedFallback = false;
  let reason = '';
  let resultStamped = false;
  try {
    const { result, trace } = await chain.decideWithTrace({
      requestId: 'dec-theme-alignment',
      kind: 'route',
      sessionId: 'sess-demo',
      turnId: 'turn-demo',
      objective: '继续',
      facts: buildDecisionFacts({
        workspace: { id: 'ws_demo', trusted: true },
        availableAgents: [
          {
            id: 'mock',
            kind: 'universal',
            isDefaultRuntime: true,
            capabilities: { streaming: true, modelSelection: true, usageReporting: true },
          },
        ],
        context: { itemCount: 2, estimatedTokens: 180, freshness: 'fresh' },
        signals: { consecutiveFailures: 0, permissionDenials: 0, elapsedMs: 0, turnIndex: 1 },
      }),
      timeoutMs: 2000,
    });
    traceLine = trace.attempts.map((attempt) => `${attempt.engineId}:${attempt.outcome}`).join(' > ');
    usedFallback = trace.usedFallback;
    reason = trace.fallbackReason ?? '';
    resultStamped = result.fallback?.used === true;
  } finally {
    await chain.dispose();
  }
  return {
    traceLine,
    fallbackLine: (zh[FALLBACK_KEY] ?? '').replace('{reason}', reason),
    usedFallback,
    reason,
    resultStamped,
  };
}

const page = existsSync(PAGE_PATH) ? readFileSync(PAGE_PATH, 'utf8') : '';
const zhDictionary = dictionaryFor('zh-CN');
const enDictionary = dictionaryFor('en-US');
const rehearsal = await driveFallbackRehearsal();
const { runDemo } = await import('../../scripts/demo-walkthrough.mjs');
const demoRun = (await runDemo()) as DemoRun;

describe('the theme-alignment page quotes what actually prints', () => {
  it('the page is present, so the checks below have a subject', () => {
    expect(existsSync(PAGE_PATH), 'docs/theme-alignment.md is missing').toBe(true);
    expect(page.length, 'docs/theme-alignment.md is empty').toBeGreaterThan(0);
  });

  it('the 30-second table quotes only lines the run prints or the rehearsal produces', () => {
    const problems = scriptProblems(sectionOf(page, SCRIPT_SECTION), demoRun, rehearsal);
    expect(problems, `the page and the run disagree:\n  ${problems.join('\n  ')}`).toEqual([]);
  });

  it('still shows where the fallback row comes from', () => {
    const problems = fallbackOriginProblems(sectionOf(page, SCRIPT_SECTION), rehearsal);
    expect(problems, `the page lost the fallback row's origin:\n  ${problems.join('\n  ')}`).toEqual(
      [],
    );
  });

  it('names field names the app really renders, on the page and in the dictionary', () => {
    const problems = labelProblems(page, zhDictionary, enDictionary);
    expect(problems, `the page and the dictionary disagree:\n  ${problems.join('\n  ')}`).toEqual([]);
  });

  it('quotes the hash the run actually computed', () => {
    // The same rule `demo-script.test.ts` applies to `docs/demo-script.md`: the
    // hash is computed from the rendered bytes, so a renderer change moves it,
    // and a page still quoting the old digest is a page pointing at a number
    // that is no longer on any screen.
    const quoted = /renderedHash ([0-9a-f]{16})/.exec(page);
    expect(quoted, 'docs/theme-alignment.md quotes no `renderedHash …`').not.toBeNull();
    expect(
      quoted![1],
      `docs/theme-alignment.md quotes the hash ${quoted![1]} and the run computes ` +
        `${demoRun.facts.shortHash} — a renderer change moved the bytes and the page still ` +
        'shows the old digest',
    ).toBe(demoRun.facts.shortHash);
  });

  it('points only at things that exist', () => {
    const problems = referenceProblems(page, (relativePath) =>
      existsSync(join(REPO_ROOT, relativePath)),
    );
    expect(problems, `the page points at missing files:\n  ${problems.join('\n  ')}`).toEqual([]);
  });

  it('still says which gate pins its quotes', () => {
    const problems = selfClaimProblems(page);
    expect(problems, `the page disclaims its own gate:\n  ${problems.join('\n  ')}`).toEqual([]);
  });

  it('is not vacuous: the page really carries the quotes being compared', () => {
    // Without this, a refactor that emptied the extractors above would leave
    // every case green over a page that quotes nothing.
    const section = sectionOf(page, SCRIPT_SECTION);
    expect(section, `docs/theme-alignment.md has no \`${SCRIPT_SECTION}\` section`).toBeDefined();
    const rows = scriptRows(section!);
    expect(rows, 'the 30-second table has no moment rows').toHaveLength(TABLE_SPANS.length);
    const literals = rows.flatMap((row) => row.literals);
    expect(literals.length, 'the 30-second table quotes no screen text').toBeGreaterThanOrEqual(6);
    expect(section!).toContain(FALLBACK_KEY);
    expect(page).toContain('permission.resolved');
  });
});

describe('the rehearsal is a real fallback, not a transcript', () => {
  it('leaves a trace, records the reason, and stamps the result', () => {
    // The invariant chain.ts's header promises: a fallback is never a silent
    // degradation. If the chain stops tracing, or stops stamping, the page's
    // fallback row describes a screen the product can no longer produce — the
    // red direction here is a change to the chain itself, driven by hand.
    expect(rehearsal.usedFallback, 'the rehearsal did not record the fallback on the trace').toBe(
      true,
    );
    expect(rehearsal.reason, 'the rehearsal recorded no fallback reason').toBe(TIMEOUT_REASON);
    expect(rehearsal.resultStamped, 'the rehearsal result was not stamped with the fallback').toBe(
      true,
    );
  });

  it('renders the two lines the page quotes', () => {
    expect(rehearsal.traceLine).toBe(`${JEV_ENGINE_ID}:timeout > ${RULE_ENGINE_ID}:ok`);
    expect(rehearsal.fallbackLine).toBe('发生了回落：timeout');
  });

  it('is not vacuous: the rule engine really answered as the fallback', () => {
    // A rehearsal whose fallback produced nothing would render empty lines and
    // leave every comparison above green over a stale page.
    expect(rehearsal.traceLine, 'the rehearsal rendered no trace line').not.toBe('');
    expect(rehearsal.fallbackLine, 'the rehearsal rendered no fallback sentence').not.toBe('');
  });
});

describe('the event the page names as evidence is real', () => {
  it('permission.resolved is a contract payload, not just a name', () => {
    // The page's 「被问到「谁在用、怎么持续」」 half claims permission refusals
    // are hand-off-able records. The claim is only as good as the schema it
    // names: a payload the contract stopped admitting is a record nobody can
    // accept, whatever the page says.
    expect(
      payloadSchemas[PERMISSION_EVENT],
      `\`${PERMISSION_EVENT}\` is not a contract payload`,
    ).toBeDefined();
  });
});

describe('the checks above, when the page has drifted', () => {
  it('reports a confidence the run does not print, naming the row', () => {
    // The failure this file is for: a scorer moved, the page kept the old
    // number, and the speaker reads out a confidence the screen does not show.
    const drifted = page.replace('`置信度 72%`', '`置信度 99%`');
    expect(drifted, 'the confidence quote this case rewrites is gone').not.toBe(page);
    const problems = scriptProblems(sectionOf(drifted, SCRIPT_SECTION), demoRun, rehearsal);
    expect(problems.some((problem) => problem.includes('置信度 99%'))).toBe(true);
    expect(problems.some((problem) => problem.includes('16–24'))).toBe(true);
  });

  it('reports a page that dropped the fallback row, as a lost origin', () => {
    // The row is where the page explains where the fallback line would come
    // from. Deleting it leaves no stale quote behind — nothing for the
    // reconciliation above to catch — so the origin check is what goes red.
    const withoutRow = page
      .split('\n')
      .filter((line) => !line.startsWith('| 24–30 '))
      .join('\n');
    expect(withoutRow, 'the 24–30 row this case removes is gone').not.toBe(page);
    const problems = fallbackOriginProblems(sectionOf(withoutRow, SCRIPT_SECTION), rehearsal);
    expect(problems).toHaveLength(2);
    for (const problem of problems) {
      expect(problem).toContain("no longer shows the fallback row's origin");
    }
    expect(problems[0]).toContain('jev:timeout > rule:ok');
  });

  it('reports a page that dropped a moment of the script', () => {
    const withoutRow = page
      .split('\n')
      .filter((line) => !line.startsWith('| 8–16 '))
      .join('\n');
    expect(withoutRow, 'the 8–16 row this case removes is gone').not.toBe(page);
    const problems = scriptProblems(sectionOf(withoutRow, SCRIPT_SECTION), demoRun, rehearsal);
    expect(problems.some((problem) => problem.includes('no longer has a 8–16 row'))).toBe(true);
  });

  it('reports a page that dropped the section altogether', () => {
    const problems = scriptProblems(undefined, demoRun, rehearsal);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('has no');
  });

  it('reports a dictionary label the page no longer quotes', () => {
    const problems = labelProblems(page.replaceAll('置信度', '确定性'), zhDictionary, enDictionary);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('`置信度`');
  });

  it('reports a page that no longer says its quotes are pinned', () => {
    const disclaimed = page.replace(PINNED_BY, '这一页不进任何门禁：它是叙事，不是承诺');
    expect(disclaimed, 'the pinned-by sentence this case removes is gone').not.toBe(page);
    const problems = selfClaimProblems(disclaimed);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('disclaims');
  });

  it('reports a repository path the page points at that is not there', () => {
    const problems = referenceProblems(page, (relativePath) =>
      relativePath === 'packages/decision/src/chain.ts'
        ? false
        : existsSync(join(REPO_ROOT, relativePath)),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('packages/decision/src/chain.ts');
    expect(problems[0]).toContain('404');
  });
});

describe('the checks above, when the sources behind the page have drifted', () => {
  it('reports a reworded fallback template, naming the line the page quotes', () => {
    // The failure the dictionary half exists for: one character changes in
    // `decision.fallbackReason`, the app's fallback notice reads differently,
    // and the page keeps quoting the old sentence.
    const reworded = { ...zhDictionary, [FALLBACK_KEY]: '发生了回落！{reason}' };
    expect(reworded[FALLBACK_KEY]).not.toBe(zhDictionary[FALLBACK_KEY]);
    const problems = labelProblems(page, reworded, enDictionary);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(FALLBACK_KEY);
    expect(problems[0]).toContain('no longer the sentence the app renders');
  });

  it('reports a fallback template that lost its placeholder', () => {
    const reworded = { ...zhDictionary, [FALLBACK_KEY]: '发生了回落' };
    const problems = labelProblems(page, reworded, enDictionary);
    expect(problems).toHaveLength(2);
    expect(problems.some((problem) => problem.includes('lost its `{reason}` placeholder'))).toBe(
      true,
    );
  });

  it('reports an English fallback template that lost its placeholder', () => {
    const reworded = { ...enDictionary, [FALLBACK_KEY]: 'A fallback was used' };
    const problems = labelProblems(page, zhDictionary, reworded);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('English');
  });

  it('reports a trace that no longer reads jev:timeout > rule:ok', () => {
    // The failure the rehearsal half exists for: the chain's attempt rendering
    // changes — a renamed outcome, a trace that stops appending the fallback's
    // `:ok` — and the page's conditional row describes a shape the product no
    // longer produces. The stale quote is on the page, so this names it.
    const drifted: Rehearsal = { ...rehearsal, traceLine: 'jev:timed_out > rule:ok' };
    const problems = scriptProblems(sectionOf(page, SCRIPT_SECTION), demoRun, drifted);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('jev:timeout > rule:ok');
  });

  it('reports a renamed fallback reason, in both directions', () => {
    // The other half of the same rehearsal: the reason a timeout leaves changes
    // (`timed_out`, say), and the sentence the template renders no longer
    // matches the sentence the page quotes. Both the rendered line and the
    // stale quote are named, so the fix is unambiguous.
    const drifted: Rehearsal = {
      ...rehearsal,
      reason: 'timed_out',
      fallbackLine: FALLBACK_TEMPLATE.replace('{reason}', 'timed_out'),
    };
    const problems = fallbackOriginProblems(sectionOf(page, SCRIPT_SECTION), drifted);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('发生了回落：timeout');
    expect(problems[0]).toContain('发生了回落：timed_out');
  });
});
