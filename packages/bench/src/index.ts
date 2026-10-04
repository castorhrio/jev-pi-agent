/**
 * Token accounting for the Context Broker — the measurement behind the claim
 * that UCAD spends fewer context tokens than a naive "paste the files" turn.
 *
 * Three strategies, one budget, one estimator, one fixture:
 *
 *  - `naive_full_file`  — what most tools do: rank the files and paste whole
 *                         files until the budget runs out. The ranking is the
 *                         naive one: objective terms matched against the *path*,
 *                         ties broken by size, because an agent that has not
 *                         read anything yet has no better signal.
 *  - `naive_grep_topk`  — literal search over the objective's terms, top-k hits
 *                         per term, each hit padded with its surrounding lines.
 *  - `broker_budgeted`  — the real `ContextBroker.build()` output, i.e. the
 *                         bytes `InjectionRenderer` actually emits.
 *
 * Honesty rules this file obeys, because a benchmark that flatters the product
 * is worth nothing:
 *  1. **One definition of a token.** Every row is measured with the caller's
 *     `TokenEstimator` over the exact text that would be injected, including
 *     for the broker (not the pack's own `budget.usedTokens`, which scores item
 *     bodies before the renderer's headers are added).
 *  2. **Same budget for all three.** A strategy that is allowed a bigger budget
 *     is not cheaper, it is just allowed to be wrong later.
 *  3. **Recall is binary and unforgiving.** Every needle's defining symbol must
 *     appear in the injected text. A strategy that is cheap because it dropped
 *     the answer scores `recall: false`, and `summarise()` says so.
 *  4. **The fixture is never tuned to make the broker win.** A negative result is
 *     a finding and is reported as one.
 */

import type { ContextPack, TokenEstimator } from '@ucad/contracts';
import type { FixtureFile, FixtureWorkspace } from './fixture';

export type Strategy = 'naive_full_file' | 'naive_grep_topk' | 'broker_budgeted';

export interface ComparisonRow {
  label: string;
  strategy: Strategy;
  tokens: number;
  items: number;
  /** true when the strategy still contained every needle passed in */
  recall: boolean;
}

export interface CompareInput {
  /** a real, deterministic synthetic workspace */
  fixture: FixtureWorkspace;
  objective: string;
  /** file paths that genuinely must appear in the context for the task to succeed */
  needles: string[];
  budgetTokens: number;
  estimator: TokenEstimator;
  /** the broker's build(), for the broker_budgeted row */
  brokerBuild: () => Promise<ContextPack>;
  /** grep padding around a hit, in lines. Default 2. */
  grepContextLines?: number;
  /** max grep hits kept per objective term. Default 20. */
  grepTopK?: number;
}

export interface CompareSummary {
  savedVsNaiveTokens: number;
  savedVsNaivePercent: number;
  recallPreserved: boolean;
}

/** ASCII-ish objective terms, same splitting rule a grep-style tool uses. */
function terms(objective: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of objective.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3 || seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
  }
  return out;
}

function fileText(file: FixtureFile): string {
  return file.lines.join('\n');
}

/**
 * Every price in this file goes through here, so the `ctx` argument is the same
 * for all three strategies and no row can be quietly measured on different terms
 * than another.
 */
function price(estimator: TokenEstimator, text: string): number {
  return estimator.estimate(text, {});
}

/** What a strategy chose to inject, before it is priced. */
interface Selection {
  text: string;
  items: number;
}

/**
 * `naive_full_file`: rank by objective terms found in the *path*, then paste
 * whole files until the budget is exhausted. This is the behaviour the Context
 * Broker is supposed to beat, so it is implemented as favourably as it can be
 * without reading any file content: a real tool would use an LLM here, which
 * is exactly the cost this comparison is about.
 */
function selectFullFiles(
  fixture: FixtureWorkspace,
  objectiveTerms: ReadonlyArray<string>,
  budgetTokens: number,
  estimator: TokenEstimator,
): Selection {
  const scored = fixture.files
    .map((file) => {
      const path = file.path.toLowerCase();
      const hits = objectiveTerms.filter((term) => path.includes(term)).length;
      return { file, rank: [hits, file.lines.length] as const };
    })
    .sort((a, b) => b.rank[0] - a.rank[0] || b.rank[1] - a.rank[1] || a.file.path.localeCompare(b.file.path));

  const chosen: string[] = [];
  let used = 0;
  for (const { file } of scored) {
    const text = fileText(file);
    const cost = price(estimator, text);
    if (used + cost > budgetTokens) continue; // a file that does not fit is skipped, not a stop
    chosen.push(text);
    used += cost;
  }
  return { text: chosen.join('\n\n'), items: chosen.length };
}

/**
 * `naive_grep_topk`: literal case-insensitive search, top-k hits per term, each
 * hit padded with its neighbours — the classic "grep with context" retrieval.
 * Hits are taken in file order and the first hits win, which is the honest
 * failure mode of a tool that cannot rank.
 */
function selectGrepSnippets(
  fixture: FixtureWorkspace,
  objectiveTerms: ReadonlyArray<string>,
  budgetTokens: number,
  estimator: TokenEstimator,
  contextLines: number,
  topK: number,
): Selection {
  const seen = new Set<string>();
  const snippets: string[] = [];
  let used = 0;

  outer: for (const term of objectiveTerms) {
    let hits = 0;
    for (const file of fixture.files) {
      for (let i = 0; i < file.lines.length; i += 1) {
        const line = file.lines[i] ?? '';
        if (!line.toLowerCase().includes(term)) continue;
        if (hits >= topK) break outer;
        hits += 1;
        const start = Math.max(0, i - contextLines);
        const end = Math.min(file.lines.length, i + contextLines + 1);
        const key = `${file.path}:${start}-${end}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const text = `${file.path}:${start + 1}-${end}\n${file.lines.slice(start, end).join('\n')}`;
        const cost = price(estimator, text);
        if (used + cost > budgetTokens) break outer;
        snippets.push(text);
        used += cost;
      }
    }
  }
  return { text: snippets.join('\n\n'), items: snippets.length };
}

/** The bytes the broker would actually put in front of the model. */
function brokerText(pack: ContextPack): string {
  const rendered = pack.injection?.rendered;
  if (typeof rendered === 'string' && rendered.length > 0) return rendered;
  // No injection plan attached: fall back to the item bodies, which is still
  // the pack's own content rather than a guess about it.
  return pack.items.map((item) => JSON.stringify(item.payload)).join('\n\n');
}

/** Every needle's defining symbol must appear in the injected text. */
function recallOf(fixture: FixtureWorkspace, needles: ReadonlyArray<string>, text: string): boolean {
  const byPath = new Map(fixture.files.map((file) => [file.path, file]));
  return needles.every((path) => {
    const file = byPath.get(path);
    if (!file) throw new Error(`needle "${path}" is not in the fixture; a benchmark against a missing file is meaningless`);
    // A needle without a declared symbol falls back to its own file name, which
    // is still "did the agent see this file" rather than a free pass.
    const symbol = file.definingSymbol ?? (file.path.slice(file.path.lastIndexOf('/') + 1).split('.')[0] ?? file.path);
    return text.includes(symbol);
  });
}

export async function compareStrategies(input: CompareInput): Promise<ComparisonRow[]> {
  const objectiveTerms = terms(input.objective);
  const rows: ComparisonRow[] = [];

  const full = selectFullFiles(input.fixture, objectiveTerms, input.budgetTokens, input.estimator);
  rows.push({
    label: `whole files (${input.fixture.files.length} in tree, budget ${input.budgetTokens} tok)`,
    strategy: 'naive_full_file',
    tokens: price(input.estimator, full.text),
    items: full.items,
    recall: recallOf(input.fixture, input.needles, full.text),
  });

  const grep = selectGrepSnippets(
    input.fixture,
    objectiveTerms,
    input.budgetTokens,
    input.estimator,
    input.grepContextLines ?? 2,
    input.grepTopK ?? 20,
  );
  rows.push({
    label: `grep top-k hits, ${input.grepContextLines ?? 2} lines of context`,
    strategy: 'naive_grep_topk',
    tokens: price(input.estimator, grep.text),
    items: grep.items,
    recall: recallOf(input.fixture, input.needles, grep.text),
  });

  const pack = await input.brokerBuild();
  const injected = brokerText(pack);
  rows.push({
    label: `ContextBroker.build() (${pack.items.length} items, omitted ${pack.omitted.length}, truncated ${String(pack.budget.truncated)})`,
    strategy: 'broker_budgeted',
    tokens: price(input.estimator, injected),
    items: pack.items.length,
    recall: recallOf(input.fixture, input.needles, injected),
  });

  return rows;
}

/**
 * `savedVsNaive*` is measured against `naive_full_file` — the strategy a real
 * turn falls back to when nothing is indexing the workspace. `recallPreserved`
 * is a *regression* test, not an achievement: true only when the broker keeps
 * every needle that **some** naive strategy kept. If any naive row found the
 * definitions and the broker did not, this is `false` — a broker that is 95%
 * cheaper and lost the answer has not saved anything, it has just made the
 * failure cheaper.
 */
export function summarise(rows: ComparisonRow[]): CompareSummary {
  const naive = rows.find((row) => row.strategy === 'naive_full_file');
  const broker = rows.find((row) => row.strategy === 'broker_budgeted');
  const baseline = naive?.tokens ?? 0;
  const brokerTokens = broker?.tokens ?? 0;
  const anyNaiveRecall = rows
    .filter((row) => row.strategy !== 'broker_budgeted')
    .some((row) => row.recall);

  return {
    savedVsNaiveTokens: baseline - brokerTokens,
    savedVsNaivePercent: baseline > 0 ? Math.round(((baseline - brokerTokens) / baseline) * 1000) / 10 : 0,
    recallPreserved: broker !== undefined && (broker.recall || !anyNaiveRecall),
  };
}

export { generateFixtureWorkspace } from './fixture';
export type { FixtureFile, FixtureNeedle, FixtureSpec, FixtureWorkspace } from './fixture';
