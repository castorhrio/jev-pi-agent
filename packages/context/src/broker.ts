/**
 * §4.5 / §6 — the Context Broker.
 *
 * `build()` is the deterministic pipeline of §6.1 and it must be replayable:
 * the same workspace, the same objective and the same budget produce the same
 * item set, in the same order, with the same `renderedHash`. That is what
 * makes the Context Drawer evidence rather than decoration.
 *
 * Order of business, numbered:
 *   1. resolve the strategy
 *   2. collect candidates in a FIXED order: instruction → skill → git_diff
 *      (only when dirty) → handoff → symbol/file (Basic search) → summary
 *   3. dedup            (T-5①)
 *   4. drop stale items (T-5②)
 *   5. budget trimming  (T-5③④)
 *   6. estimate tokens and compute `budgetShare`
 *   7. persist `context_packs` (revision 1) + `context_items`, then open the
 *      T-4 ledger
 *
 * Every step that can lose information writes an entry into `pack.omitted`
 * (T-6) and flips `budget.truncated`. Nothing disappears quietly.
 */

import type {
  AgentManifest,
  BuildContextInput,
  CodeLocation,
  CodeOverview,
  CodeSearchResult,
  ContextBudgetState,
  ContextHandoff,
  ContextInjectionPlan,
  ContextItem,
  ContextOmitReason,
  ContextPack,
  ContextPackBuiltPayload,
  ContextPackDelta,
  ContextPackExtendedPayload,
  ContextStrategy,
  ExtendContextInput,
  ExtendDropReason,
  FreshnessState,
  InjectionProfile,
  TokenEstimateSource,
} from '@ucad/contracts';
import { appError, CONTEXT_KIND_DROP_PRIORITY, validatePayload } from '@ucad/contracts';
import { nowIso, sha256Hex, ulid } from '@ucad/observability';
import type { Logger } from '@ucad/observability';
import { ContextStore } from './store';
import { extractObjectiveFromRendered, itemBodyText } from './renderer';
import type {
  BuildContextInputPreview,
  ContextBrokerContract,
  ContextBrokerOptions,
  ContextBuildResult,
  ContextExtendResult,
  DatabaseLike,
  InjectionRendererLike,
  ItemMinter,
  TurnBudgetLedgerApi,
} from './types';

/** §4.5.1: these kinds survive a staleness drop, because they are not indexed. */
const KEEP_WHEN_STALE: ReadonlySet<ContextItem['kind']> = new Set(['instruction', 'handoff', 'summary']);

/**
 * Freshness for an item whose body was read *during this build*.
 *
 * NFR-11 says stale project knowledge must never be passed off as current. The
 * subtlety the token benchmark exposed is that a provider's `freshness` answers
 * "how old is your **index**?", which is a different question from "how old is
 * the text you just read?". The Basic provider has no persistent index at all,
 * so it reports `stale: true` unconditionally — and T-5② then dropped every
 * single search hit, leaving the Context pack with zero source lines. The pack
 * looked 95% cheaper and was completely useless.
 *
 * So: when the item carries real text materialised from the working tree in
 * this same call, the content is fresh by construction and the staleness that
 * still matters — "this provider has no symbol graph" — is a *capability* fact
 * the UI already shows. A pointer with no body keeps the provider's verdict,
 * because there we genuinely cannot vouch for it.
 */
function contentFreshness(providerFreshness: FreshnessState, hasBody: boolean): FreshnessState {
  if (!hasBody) return providerFreshness;
  return {
    ...providerFreshness,
    stale: false,
    // the reason the *provider* is still stale stays visible, minus the
    // staleness flag that only ever applied to its index
    ...(providerFreshness.stalenessReason ? {} : {}),
  };
}

/**
 * Orders search terms by how likely they are to identify code.
 *
 * The naive order (whatever the objective says first) wastes the item budget on
 * filler: "修复登录失败并补测试" searches `修复` / `登录` / `失败` before it
 * ever reaches the identifier that actually names a function. Ranking is purely
 * lexical and deterministic — no corpus statistics, no model, nothing to drift:
 *
 *   1. longer terms first — identifiers and paths beat single characters
 *   2. code-shaped terms first — `camelCase`, `snake_case`, `dotted`, `ns::sym`
 *   3. the original order breaks ties, so the result is stable across runs
 *
 * This is the cheapest possible ranking and it recovered recall in the token
 * benchmark without adding a dependency.
 */
export function rankObjectiveTerms(terms: readonly string[]): string[] {
  const shape = (term: string): number => {
    if (/[._]/.test(term)) return 3;
    if (/[a-z][A-Z]/.test(term)) return 3;
    if (term.includes('::')) return 3;
    if (/^[A-Za-z][A-Za-z0-9]*$/.test(term)) return 2;
    return 1; // CJK and other space-delimited prose
  };
  return terms
    .map((term, index) => ({ term, index, shape: shape(term) }))
    .sort((a, b) => {
      if (a.shape !== b.shape) return b.shape - a.shape;
      if (a.term.length !== b.term.length) return b.term.length - a.term.length;
      return a.index - b.index;
    })
    .map((entry) => entry.term);
}
const MAX_SEARCH_TERMS = 8;
const MAX_LOCATIONS_PER_TERM = 5;
const MAX_SEARCH_ITEMS = 12;
const MAX_DIFF_ITEMS = 8;
const MAX_DIFF_PATCH_CHARS = 4000;
/**
 * Skill bodies are cut below `MAX_ITEM_BODY_CHARS` (4000) so the item fits the
 * renderer's ceiling with its own truncation marker still intact, and so the
 * `truncated` flag on the item is UCAD's honest statement rather than a
 * surprise the user discovers in the Drawer.
 */
const MAX_SKILL_ITEM_CHARS = 3500;
const MAX_EXTEND_ITEMS_DEFAULT = 10;
const MAX_EXTEND_ITEMS_HARD = 50;
const MIN_TERM_LENGTH = 2;

/** §6.4 boundary 3 default: return a partial pack instead of hanging. */
const DEFAULT_COLLECT_BUDGET_MS = 1000;

const DEFAULT_PREVIEW_BUDGET = { maxInputTokens: 32_000, reservedOutputTokens: 4_000 };

/**
 * The manifest used when `context.preview` names an agent that is not
 * registered. Conservative on purpose: `prompt_prefix` works everywhere, and
 * pretending an unknown agent has a tool contract would be a guess.
 */
const UNKNOWN_AGENT_MANIFEST: AgentManifest = {
  id: 'unknown',
  displayName: 'Unknown agent',
  kind: 'native',
  isDefaultRuntime: false,
  transport: 'child_process',
  providerBinding: 'both',
  pinned: [],
  capabilities: {
    streaming: false,
    sessionResume: false,
    modelSelection: false,
    fileTools: false,
    shellTools: false,
    permissionCallbacks: 'none',
    nativeSandbox: false,
    mcp: false,
    skills: false,
    subagents: false,
    usageReporting: 'none',
    injectionModes: ['prompt_prefix'],
    toolContract: 'none',
  },
};

/** §6.1 ①: a path-looking token in the objective means text-first. */
const FILE_PATH_PATTERN = /[\w./\\-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|kts|rb|php|c|h|cc|cpp|hpp|cs|swift|scala|vue|svelte|md|json|ya?ml|toml|ini|sql|sh|ps1|css|scss|html)\b/i;

/**
 * `@ucad/skills`, structurally (§1.3).
 *
 * Declared here, like `GitLike` and `SessionStoreLike`, so the Context plane
 * never imports the skills package: a skill reaches the Agent *through* the
 * Context Pack, and that seam has to stay narrow enough that neither package
 * can quietly grow a dependency on the other. A real `SkillRegistry` satisfies
 * this interface as-is.
 *
 * `text` is produced by the skills package rather than composed here, because
 * the bytes that are measured (`estimateSkillTokens`) and the bytes that are
 * rendered have to be the same bytes.
 */
interface SkillBindingLike {
  skill: {
    name: string;
    description?: string;
    body: string;
    scope: 'workspace' | 'user';
    agents: string[];
  };
  /** the sentence the Drawer shows, quoted verbatim into the item `reason` */
  reason: string;
  score: number;
  text: string;
}

interface SkillResolutionLike {
  bindings: SkillBindingLike[];
  dropped: Array<{ skill: { name: string }; reason: string }>;
  cap: number;
  note: string;
}

export interface SkillBinderLike {
  resolve(agentId: string, objective: string): SkillResolutionLike;
}


interface CollectionContext {
  providerId: string;
  signal: AbortSignal | undefined;
  /** epoch ms; the collect phase returns a partial pack past this (NFR-05) */
  deadline: number;
  estimatorCtx: { modelId?: string; providerId?: string };
}

interface Collected {
  items: ContextItem[];
  /** true when the collect phase was cut short (abort or soft deadline) */
  partial: boolean;
}

interface ExtendCollection {
  items: ContextItem[];
  dropped: Array<{ itemId: string; why: ExtendDropReason }>;
}

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

/** §6.1 ① — `'auto'` resolves deterministically from open files + objective. */
export function resolveStrategy(
  requested: ContextStrategy | 'auto' | undefined,
  openFiles: string[] | undefined,
  objective: string,
): { strategy: ContextStrategy; reason: string } {
  if (requested && requested !== 'auto') {
    return { strategy: requested, reason: `strategy "${requested}" was requested explicitly` };
  }
  const open = (openFiles ?? []).filter((file) => file.trim().length > 0);
  if (open.length > 0) {
    return { strategy: 'text_first', reason: `${open.length} file(s) are open in the editor` };
  }
  if (FILE_PATH_PATTERN.test(objective)) {
    return { strategy: 'text_first', reason: 'the objective names a concrete file path' };
  }
  return { strategy: 'hybrid', reason: 'no open files and no explicit file path in the objective' };
}

/** §6.1 ②d — deterministic, ASCII-aware term extraction, capped at 8. */
export function objectiveTerms(objective: string, limit = MAX_SEARCH_TERMS): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  // Split on anything that is not a letter/digit/dot/underscore/dash, so a
  // CJK objective still yields one contiguous run per term.
  for (const raw of objective.split(/[^\p{L}\p{N}._-]+/u)) {
    const term = raw.replace(/^[._-]+|[._-]+$/g, '').toLowerCase();
    if (term.length < MIN_TERM_LENGTH) continue;
    if (seen.has(term)) continue;
    seen.add(term);
    out.push(term);
    if (out.length >= limit) break;
  }
  return out;
}

/** `path:start-end` → path + inclusive range; anything else → no range. */
function referenceParts(reference: string | undefined): { path: string; start: number | null; end: number | null } {
  const raw = (reference ?? '').trim();
  if (!raw) return { path: '', start: null, end: null };
  const match = /^(.*?):(\d+)(?:-(\d+))?$/.exec(raw);
  if (!match) return { path: raw, start: null, end: null };
  const start = Number(match[2]);
  const end = match[3] === undefined ? start : Number(match[3]);
  return { path: match[1] ?? raw, start, end };
}

/** A missing range means "the whole reference", which overlaps any range. */
function rangesOverlap(
  a: { start: number | null; end: number | null },
  b: { start: number | null; end: number | null },
): boolean {
  if (a.start === null || b.start === null) return true;
  const aEnd = a.end ?? a.start;
  const bEnd = b.end ?? b.start;
  return Math.max(a.start, b.start) <= Math.min(aEnd, bEnd);
}

/** Higher index = lower priority = dropped earlier (§4.5.3). */
function priorityIndex(kind: ContextItem['kind']): number {
  const index = CONTEXT_KIND_DROP_PRIORITY.indexOf(kind);
  return index === -1 ? CONTEXT_KIND_DROP_PRIORITY.length : index;
}

function isLocation(value: unknown): value is CodeLocation {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<CodeLocation>;
  return typeof candidate.path === 'string' && typeof candidate.startLine === 'number';
}

function readSearchResult(result: unknown): CodeSearchResult | null {
  if (!result || typeof result !== 'object') return null;
  const items = (result as Partial<CodeSearchResult>).items;
  if (!Array.isArray(items)) return null;
  return {
    items: items.filter(isLocation),
    truncated: (result as Partial<CodeSearchResult>).truncated === true,
    freshness: (result as Partial<CodeSearchResult>).freshness ?? { stale: true, stalenessReason: 'unknown_revision' },
  };
}

function readOverview(result: unknown): CodeOverview | null {
  if (!result || typeof result !== 'object') return null;
  const summary = (result as Partial<CodeOverview>).summary;
  if (typeof summary !== 'string') return null;
  return result as CodeOverview;
}

/** T-3: the caller's declaration wins; otherwise the provider's tokenizer. */
function resolveEstimateSource(declared: TokenEstimateSource, provider: TokenEstimateSource | undefined): TokenEstimateSource {
  if (declared && declared !== 'unknown') return declared;
  if (provider === 'provider_tokenizer' || provider === 'heuristic_chars_div_4') return provider;
  return 'unknown';
}

function clampIndex(value: unknown, fallback: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(Math.floor(value), max));
}

// ---------------------------------------------------------------------------
// broker
// ---------------------------------------------------------------------------

export class ContextBroker implements ContextBrokerContract {
  private readonly db: DatabaseLike;
  private readonly logger: Logger;
  private readonly ledger: TurnBudgetLedgerApi;
  private readonly estimator: ContextBrokerOptions['estimator'];
  private readonly renderer: InjectionRendererLike;
  private readonly intelligence: ContextBrokerOptions['intelligence'];
  private readonly git: ContextBrokerOptions['git'];
  private readonly sessionStore: ContextBrokerOptions['sessionStore'];
  private readonly store: ContextStore;
  private readonly collectBudgetMs: number;
  private readonly resolveAgent: ContextBrokerOptions['resolveAgent'];
  private readonly defaultBudget: { maxInputTokens: number; reservedOutputTokens: number };
  /** optional; without a binder the build is byte-identical to before skills */
  private readonly skills: SkillBinderLike | undefined;

  /** Live packs and their resolved profiles: what the Drawer reads first. */
  private readonly livePacks = new Map<string, ContextPack>();
  private readonly liveProfiles = new Map<string, InjectionProfile>();
  private readonly liveInjections = new Map<string, ContextInjectionPlan>();
  private readonly liveDeltas = new Map<string, ContextPackDelta>();
  private readonly turnToPack = new Map<string, string>();

  /**
   * `skills` is a second, optional argument rather than a member of
   * `ContextBrokerOptions` so that a caller that has no skills configured
   * constructs exactly the broker it constructed before, and so this package
   * keeps no compile-time dependency on the skills package. It is the wiring
   * seam: Main passes the registry here once the desktop wires it up.
   */
  constructor(opts: ContextBrokerOptions, skills?: SkillBinderLike) {
    this.db = opts.db;
    this.logger = opts.logger.child('broker');
    this.ledger = opts.ledger;
    this.estimator = opts.estimator;
    this.intelligence = opts.intelligence;
    this.git = opts.git;
    this.sessionStore = opts.sessionStore;
    this.renderer = opts.renderer;
    this.skills = skills;
    this.store = new ContextStore({ db: opts.db, logger: opts.logger, ...(opts.blobs ? { blobs: opts.blobs } : {}) });
    this.collectBudgetMs = opts.collectBudgetMs ?? DEFAULT_COLLECT_BUDGET_MS;
    this.resolveAgent = opts.resolveAgent;
    this.defaultBudget = opts.defaultBudget ?? DEFAULT_PREVIEW_BUDGET;
  }

  // -------------------------------------------------------------------------
  // §6.1 build
  // -------------------------------------------------------------------------

  async build(input: BuildContextInput, signal?: AbortSignal): Promise<ContextPack> {
    return (await this.runBuild(input, signal, true)).pack;
  }

  /** §6.1 + the T-3 payload Main hands to the sequencer (SEQ-6). */
  async buildPlan(input: BuildContextInput, signal?: AbortSignal): Promise<ContextBuildResult> {
    return this.runBuild(input, signal, true);
  }

  /**
   * `context.preview` — a dry run for the Context Drawer.
   *
   * It runs the *entire* pipeline so the Drawer shows the real thing, under a
   * throwaway `turnId`, and it neither writes a row nor touches the active
   * turn's ledger. A preview that charged the real budget would make the
   * previewed turn smaller than the real one.
   */
  async preview(input: BuildContextInputPreview): Promise<ContextPack> {
    const manifest = this.resolveAgent?.(input.agentId) ?? UNKNOWN_AGENT_MANIFEST;
    if (!this.resolveAgent) {
      this.logger.warn('preview without an agent resolver; using a conservative manifest', {
        agentId: input.agentId,
      });
    }

    const contextWindow = manifest.capabilities.contextWindowTokens;
    const buildInput: BuildContextInput = {
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      turnId: ulid('preview_'),
      objective: input.objective,
      agent: manifest,
      budget: {
        maxInputTokens: input.budget?.maxInputTokens ?? contextWindow ?? this.defaultBudget.maxInputTokens,
        reservedOutputTokens:
          input.budget?.reservedOutputTokens ?? this.defaultBudget.reservedOutputTokens,
        estimateSource: input.budget?.estimateSource ?? this.estimator.source,
      },
      strategy: input.strategy,
      ...(input.signal ? { signal: input.signal } : {}),
    };

    const result = await this.runBuild(buildInput, input.signal, false);
    return result.pack;
  }

  private async runBuild(
    input: BuildContextInput,
    signal: AbortSignal | undefined,
    persist: boolean,
  ): Promise<ContextBuildResult> {
    const effectiveSignal = signal ?? input.signal;
    const provider = this.resolveProvider(input.workspaceId, input.sessionId);
    const { strategy, reason: strategyReason } = resolveStrategy(input.strategy, input.openFiles, input.objective);
    const limitTokens = this.limitFor(input.budget.maxInputTokens, input.budget.reservedOutputTokens);
    const estimateSource = resolveEstimateSource(input.budget.estimateSource, this.providerTokenizer(input.workspaceId, input.sessionId));

    const minter = this.createMinter();
    const collection: Collected = await this.collectCandidates(input, {
      providerId: provider,
      signal: effectiveSignal,
      deadline: Date.now() + this.collectBudgetMs,
      estimatorCtx: {
        ...(input.model?.id ? { modelId: input.model.id } : {}),
        providerId: provider,
      },
    }, minter);

    // §6.1 ⑥: `estimatedTokens` is the cost of the text the renderer will
    // actually emit (reason line + payload, sanitized), so the budget is
    // measured against the injection and not against a neighbour of it.
    collection.items = this.rescore(collection.items, minter);

    // T-5① dedup → T-5② stale → T-5③④ budget. Fixed order, no exceptions.
    const trimmed = this.trim(collection.items, limitTokens, minter, collection.partial);
    const truncated = trimmed.truncated || collection.partial;

    const items = trimmed.items.map((item) => ({
      ...item,
      // §6.1 ⑥: `budgetShare` is this item's slice of the turn's allowance.
      budgetShare: limitTokens > 0 ? item.estimatedTokens / limitTokens : 0,
    }));
    const usedTokens = items.reduce((sum, item) => sum + item.estimatedTokens, 0);

    const packId = persist ? ulid('cp_') : ulid('preview_');
    const createdAt = nowIso();

    const pack: ContextPack = {
      id: packId,
      revision: 1,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      strategy,
      strategyReason,
      items,
      omitted: trimmed.omitted,
      budget: {
        packId,
        revision: 1,
        limitTokens,
        usedTokens,
        remainingTokens: Math.max(0, limitTokens - usedTokens),
        estimateSource,
        truncated,
      },
      createdAt,
      objective: input.objective,
    };

    const resolved = this.renderer.resolveProfile(input.agent);
    const injection = this.renderer.render(pack, resolved.profile);
    pack.injection = injection;

    if (resolved.warning) {
      this.logger.warn('injection mode downgraded', { agentId: input.agent.id, warning: resolved.warning });
    }

    const builtPayload: ContextPackBuiltPayload = {
      packId: pack.id,
      revision: 1,
      strategy,
      strategyReason,
      itemCount: items.length,
      omittedCount: trimmed.omitted.length,
      estimatedTokens: usedTokens,
      // T-3: the provenance travels into the event and into the UI.
      estimateSource,
      renderedHash: injection.renderedHash,
      injectionMode: resolved.profile.mode,
    };
    const validated = validatePayload('context.pack.built', builtPayload);
    if (!validated) {
      // Our own payload failed our own schema: that is a bug, not a runtime
      // condition, and the turn must not continue on a payload the admission
      // pipeline would reject.
      throw appError('UNKNOWN', 'context.pack.built payload failed its own schema', 'context', {
        details: { packId: pack.id },
      });
    }

    if (persist) {
      const renderedRef = this.store.storeRendered(injection.rendered, {
        packId: pack.id,
        turnId: pack.turnId,
        revision: 1,
      });
      this.store.savePack(
        {
          id: pack.id,
          workspaceId: pack.workspaceId,
          sessionId: pack.sessionId,
          turnId: pack.turnId,
          revision: 1,
          strategy,
          strategyReason,
          limitTokens,
          usedTokens,
          estimateSource,
          truncated,
          injectionMode: resolved.profile.mode,
          renderedHash: injection.renderedHash,
          renderedRef,
          createdAt,
        },
        items,
      );

      // T-4: the ledger is keyed by turn, so it must be opened *after* the row
      // it accounts for exists, and it is charged from this point on.
      this.ledger.open({ turnId: pack.turnId, packId: pack.id, limitTokens, estimateSource });

      this.livePacks.set(pack.id, pack);
      this.liveProfiles.set(pack.id, resolved.profile);
      this.liveInjections.set(pack.turnId, injection);
      this.turnToPack.set(pack.turnId, pack.id);
    }

    return {
      pack,
      injection,
      builtPayload: validated,
      ...(resolved.warning ? { warning: resolved.warning } : {}),
    };
  }

  /**
   * §6.1 ② — candidate collection in a fixed order.
   *
   * The order is part of the contract, not an implementation detail: a
   * different order would produce a different pack for the same workspace and
   * break replay.
   */
  private async collectCandidates(
    input: BuildContextInput,
    ctx: CollectionContext,
    minter: ItemMinter,
  ): Promise<Collected> {
    const items: ContextItem[] = [];
    let partial = false;

    // (a) instruction — always present, and the one item that never goes stale.
    items.push(this.instructionItem(input, minter));

    const aborted = (): boolean => {
      if (ctx.signal?.aborted) {
        if (!partial) this.logger.warn('collect aborted; returning a partial pack', { turnId: input.turnId });
        partial = true;
        return true;
      }
      if (Date.now() > ctx.deadline) {
        this.logger.warn('collect budget exhausted; returning a partial pack', {
          turnId: input.turnId,
          budgetMs: this.collectBudgetMs,
        });
        partial = true;
        return true;
      }
      return false;
    };

    // (b) skills — the standing instructions bound to this agent, plus the
    // skills this objective names. They are ordinary `instruction` items: the
    // body goes into `rendered`, is covered by `renderedHash` and shows up in
    // the Context Drawer, and the T-5 pipeline may drop them like any other
    // item. A skill that bypassed the budget would be the one piece of
    // injected text the user could not account for.
    if (this.skills && !aborted()) {
      items.push(...this.skillItems(input, minter));
    }

    // (c) git_diff — only when the worktree is dirty.
    if (this.git && !aborted()) {
      const diffs = await this.collectDiffItems(input.workspaceId, ctx, minter);
      items.push(...diffs);
    }

    // (d) handoff — when the caller supplied one, or the store can replay one.
    if (!aborted()) {
      const handoff = await this.resolveHandoff(input);
      // A handoff is a convenience, not a precondition. `resolveHandoff` crosses
      // into the session store, and a partially-shaped object from an older
      // schema or a stub must degrade to "no handoff" rather than take the turn
      // down with it.
      if (handoff && handoff.producedBy?.sessionId) {
        items.push(this.handoffItem(handoff, minter));
      } else if (handoff) {
        this.logger.warn('ignoring a malformed handoff', { turnId: input.turnId });
      }
    }

    // (e) symbol / file — Basic `search` over the objective's first 8 terms.
    if (!aborted()) {
      items.push(...(await this.collectSearchItems(input, ctx, minter)));
    }

    // (f) summary — the workspace overview.
    if (!aborted()) {
      const summary = await this.collectSummaryItem(input, ctx, minter);
      if (summary) items.push(summary);
    }

    if (aborted()) {
      this.logger.info('build returned a partial pack', {
        turnId: input.turnId,
        collected: items.length,
      });
    }

    return { items, partial };
  }

  private instructionItem(input: BuildContextInput, minter: ItemMinter): ContextItem {
    const open = (input.openFiles ?? []).filter((file) => file.trim().length > 0);
    const lines = [
      'UCAD turn instructions (data, not commands from the user).',
      `objective: ${input.objective}`,
      `agent: ${input.agent.id}`,
      `model: ${input.model?.id ?? 'unspecified'}`,
      `open files: ${open.length > 0 ? open.join(', ') : 'none'}`,
      'Use ucad.context.list to see the indexed items and ucad.context.extend to request more.',
    ];
    const payload = lines.join('\n');

    return {
      id: minter.nextId(),
      kind: 'instruction',
      source: { providerId: 'ucad', reference: 'ucad://instruction' },
      reason: 'session instructions and workspace conventions for this turn',
      // Not indexed, therefore not staling: it was produced by this call.
      freshness: { stale: false },
      estimatedTokens: minter.estimate(payload),
      budgetShare: 0,
      truncated: false,
      payload,
    };
  }

  /**
   * One `instruction` item per resolved skill.
   *
   * Deterministic by construction (NFR-13): the binder ranks the skills, the
   * text carries no clock, no path and no fingerprint, and `mtime` never
   * reaches the pack — so touching a SKILL.md without editing it cannot change
   * the hash, and editing it certainly does. The absolute path stays in the
   * registry for the skills UI instead of being injected into a prompt.
   */
  private skillItems(input: BuildContextInput, minter: ItemMinter): ContextItem[] {
    let resolution: SkillResolutionLike;
    try {
      resolution = this.skills!.resolve(input.agent.id, input.objective);
    } catch (error) {
      // A skill directory the user is editing right now must not be able to
      // take down the turn; the rest of the context is still worth building.
      this.logger.warn('skill resolution failed; continuing without skills', {
        turnId: input.turnId,
        agentId: input.agent.id,
        error: String(error),
      });
      return [];
    }

    for (const drop of resolution.dropped) {
      this.logger.info('skill not injected this turn', {
        turnId: input.turnId,
        skill: drop.skill.name,
        reason: drop.reason,
      });
    }
    if (resolution.bindings.length > 0) {
      this.logger.debug('skills bound to this turn', {
        turnId: input.turnId,
        agentId: input.agent.id,
        bound: resolution.bindings.map((binding) => binding.skill.name),
        note: resolution.note,
      });
    }

    return resolution.bindings.map((binding) => {
      const text =
        binding.text.length > MAX_SKILL_ITEM_CHARS
          ? `${binding.text.slice(0, MAX_SKILL_ITEM_CHARS)}\n[skill body truncated at ${MAX_SKILL_ITEM_CHARS} chars]`
          : binding.text;
      return {
        id: minter.nextId(),
        kind: 'instruction' as const,
        source: { providerId: 'ucad', reference: `ucad://skill/${binding.skill.name}` },
        reason: `skill '${binding.skill.name}' applies to this agent: ${binding.reason}`,
        // Read from disk during this call, so it is fresh by construction and
        // it survives the T-5② staleness drop like any other instruction.
        freshness: { stale: false },
        estimatedTokens: minter.estimate(text),
        budgetShare: 0,
        truncated: text !== binding.text,
        payload: text,
      };
    });
  }

  private async collectDiffItems(
    workspaceId: string,
    ctx: CollectionContext,
    minter: ItemMinter,
  ): Promise<ContextItem[]> {
    let status: { dirty: boolean; head: string };
    try {
      status = await this.git!.status(workspaceId);
    } catch (error) {
      this.logger.warn('git status failed; skipping diff context', { workspaceId, error: String(error) });
      return [];
    }
    if (!status.dirty) return [];

    let diffs: Array<{ path: string; patch: string; tokens: number }>;
    try {
      diffs = await this.git!.diffSummary({ workspaceId, limit: MAX_DIFF_ITEMS });
    } catch (error) {
      this.logger.warn('git diff summary failed; skipping diff context', { workspaceId, error: String(error) });
      return [];
    }

    return diffs.slice(0, MAX_DIFF_ITEMS).map((diff) => {
      const patch = diff.patch.length > MAX_DIFF_PATCH_CHARS
        ? `${diff.patch.slice(0, MAX_DIFF_PATCH_CHARS)}\n[diff truncated at ${MAX_DIFF_PATCH_CHARS} chars]`
        : diff.patch;
      return {
        id: minter.nextId(),
        kind: 'git_diff' as const,
        source: { providerId: 'git', reference: diff.path },
        reason: 'worktree is dirty; this diff was captured from the live worktree during this build',
        // The diff IS the current state, so it is not stale. Claiming
        // `dirty_worktree` staleness here would make T-5② drop every diff.
        freshness: { stale: false, workspaceRevision: status.head },
        estimatedTokens: minter.estimate(patch),
        budgetShare: 0,
        truncated: patch !== diff.patch,
        payload: { path: diff.path, patch },
      };
    });
  }

  private async resolveHandoff(input: BuildContextInput): Promise<ContextHandoff | null> {
    if (input.handoff) return input.handoff;
    if (!this.sessionStore) return null;
    try {
      return this.sessionStore.createHandoff(input.sessionId);
    } catch (error) {
      // A session with no completed turn has no handoff. That is normal, not
      // an error, but it is worth seeing in the log.
      this.logger.debug('no handoff available', { sessionId: input.sessionId, reason: String(error) });
      return null;
    }
  }

  private handoffItem(handoff: ContextHandoff, minter: ItemMinter): ContextItem {
    const payload = JSON.stringify(handoff);
    return {
      id: minter.nextId(),
      kind: 'handoff',
      source: { providerId: 'ucad', reference: `ucad://handoff/${handoff.producedBy.sessionId}` },
      reason: 'deterministic handoff replayed from a previous session (§4.12.1)',
      freshness: {
        stale: false,
        ...(handoff.intelligenceFreshness ? { ...handoff.intelligenceFreshness } : {}),
      },
      estimatedTokens: minter.estimate(payload),
      budgetShare: 0,
      truncated: false,
      payload: handoff,
    };
  }

  private async collectSearchItems(
    input: BuildContextInput,
    ctx: CollectionContext,
    minter: ItemMinter,
  ): Promise<ContextItem[]> {
    const terms = rankObjectiveTerms(objectiveTerms(input.objective));
    if (terms.length === 0) return [];

    const items: ContextItem[] = [];
    const seenLocations = new Set<string>();

    // Fair share per term. A single broad term ("session" in a repo full of
    // session code) used to consume the entire item budget before the specific
    // identifiers were ever searched — the token benchmark caught it losing the
    // needle outright. Every ranked term now gets a guaranteed allocation, and
    // a term may only spend leftover budget after every other term has had its
    // share.
    const fairShare = Math.max(1, Math.ceil(MAX_SEARCH_ITEMS / terms.length));
    const perTermUsed = new Map<string, number>();

    for (const term of terms) {
      if (ctx.signal?.aborted || Date.now() > ctx.deadline) break;
      if (items.length >= MAX_SEARCH_ITEMS) break;

      const used = perTermUsed.get(term) ?? 0;
      // after the fair round, later terms may draw on what is left
      const allowance = used < fairShare ? fairShare - used : MAX_SEARCH_ITEMS;

      const outcome = await this.query(ctx, {
        kind: 'search',
        providerId: ctx.providerId,
        input: { workspaceId: input.workspaceId, query: term, limit: MAX_LOCATIONS_PER_TERM },
      });
      if (outcome.status !== 'ok') {
        this.logger.warn('search unavailable for a term', {
          term,
          status: outcome.status,
          reason: outcome.reason,
        });
        continue;
      }

      const parsed = readSearchResult(outcome.result);
      if (!parsed) continue;

      let taken = 0;
      for (const location of parsed.items.slice(0, MAX_LOCATIONS_PER_TERM)) {
        if (items.length >= MAX_SEARCH_ITEMS) break;
        if (taken >= allowance) break;
        const reference = `${location.path}:${location.startLine}-${location.endLine}`;
        if (seenLocations.has(reference)) continue;
        seenLocations.add(reference);
        taken += 1;

        const snippet = this.readSnippet(location);
        const payload = {
          path: location.path,
          startLine: location.startLine,
          endLine: location.endLine,
          ...(location.symbol ? { symbol: location.symbol } : {}),
          ...(location.kind ? { kind: location.kind } : {}),
          ...(snippet ? { snippet } : {}),
        };
        const text = JSON.stringify(payload);

        items.push({
          id: minter.nextId(),
          // A hit that names a symbol is a symbol item; a bare hit is a file
          // slice. Both are dropped by the same T-5 rules.
          kind: location.symbol ? 'symbol' : 'file',
          source: { providerId: ctx.providerId, reference },
          reason: `literal search for "${term}" matched in the working tree`,
          freshness: contentFreshness(parsed.freshness, Boolean(snippet)),
          estimatedTokens: minter.estimate(text),
          budgetShare: 0,
          truncated: false,
          payload,
        });
      }
      perTermUsed.set(term, (perTermUsed.get(term) ?? 0) + taken);
    }

    return items;
  }

  /** `snippetRef` is the provider's blob; a miss is not an error. */
  private readSnippet(location: CodeLocation): string | null {
    if (!location.snippetRef) return null;
    const text = this.store.readRendered(location.snippetRef);
    if (text === null) return null;
    return text.length > MAX_DIFF_PATCH_CHARS ? text.slice(0, MAX_DIFF_PATCH_CHARS) : text;
  }
  private async collectSummaryItem(
    input: BuildContextInput,
    ctx: CollectionContext,
    minter: ItemMinter,
  ): Promise<ContextItem | null> {
    const outcome = await this.query(ctx, {
      kind: 'overview',
      providerId: ctx.providerId,
      input: { workspaceId: input.workspaceId },
    });
    if (outcome.status !== 'ok') {
      this.logger.warn('overview unavailable', { status: outcome.status, reason: outcome.reason });
      return null;
    }
    const overview = readOverview(outcome.result);
    if (!overview) return null;

    const payload = {
      summary: overview.summary,
      entryPoints: Array.isArray(overview.entryPoints) ? overview.entryPoints : [],
      ...(overview.modules ? { modules: overview.modules } : {}),
    };

    return {
      id: minter.nextId(),
      kind: 'summary',
      source: { providerId: ctx.providerId, reference: `ucad://overview/${input.workspaceId}` },
      reason: 'workspace overview: file count, extension histogram, entry points',
      freshness: overview.freshness ?? { stale: true, stalenessReason: 'unknown_revision' },
      estimatedTokens: minter.estimate(JSON.stringify(payload)),
      budgetShare: 0,
      truncated: false,
      payload,
    };
  }

  // -------------------------------------------------------------------------
  // T-5 / T-6
  // -------------------------------------------------------------------------

  /**
   * The exact truncation order of §6.1 ③④⑤: drop by kind priority first
   * (lowest priority first) and only then truncate a single item — the last
   * resort, because truncating destroys evidence that dropping does not.
   */
  private trim(items: ContextItem[], limitTokens: number, minter: ItemMinter, partial: boolean): {
    items: ContextItem[];
    omitted: Array<{ itemId: string; why: ContextOmitReason }>;
    truncated: boolean;
  } {
    const omitted: Array<{ itemId: string; why: ContextOmitReason }> = [];
    let truncated = partial;

    // ① dedup: same source reference + overlapping line range → keep the first.
    const seen = new Map<string, Array<{ start: number | null; end: number | null }>>();
    const deduped: ContextItem[] = [];
    for (const item of items) {
      const { path, start, end } = referenceParts(item.source.reference);
      if (path) {
        const prior = seen.get(path) ?? [];
        if (prior.some((range) => rangesOverlap(range, { start, end }))) {
          omitted.push({ itemId: item.id, why: 'dedup' });
          continue;
        }
        prior.push({ start, end });
        seen.set(path, prior);
      }
      deduped.push(item);
    }

    // ② stale: an item UCAD cannot vouch for does not go into the prompt.
    const fresh: ContextItem[] = [];
    for (const item of deduped) {
      if (item.freshness.stale === true && !KEEP_WHEN_STALE.has(item.kind)) {
        omitted.push({ itemId: item.id, why: 'stale' });
        continue;
      }
      fresh.push(item);
    }

    // ④ budget: drop by `CONTEXT_KIND_DROP_PRIORITY`, lowest priority first.
    let kept = fresh;
    const total = (list: ContextItem[]): number => list.reduce((sum, item) => sum + item.estimatedTokens, 0);
    if (total(fresh) > limitTokens) {
      const order = fresh
        .map((item, position) => ({ item, position }))
        .sort((a, b) => priorityIndex(b.item.kind) - priorityIndex(a.item.kind) || a.position - b.position);

      let running = total(fresh);
      const dropped = new Set<string>();
      for (const { item } of order) {
        if (running <= limitTokens) break;
        running -= item.estimatedTokens;
        dropped.add(item.id);
        omitted.push({ itemId: item.id, why: 'budget' });
        truncated = true;
      }
      kept = fresh.filter((item) => !dropped.has(item.id));
    }

    // ③ budget: as the last step, shrink the single largest item to fit.
    if (total(kept) > limitTokens && kept.length > 0) {
      const target = [...kept].sort((a, b) => b.estimatedTokens - a.estimatedTokens || a.id.localeCompare(b.id))[0];
      if (target) {
        const allowance = Math.max(0, limitTokens - (total(kept) - target.estimatedTokens));
        const fitted = this.fitTo(target, allowance, minter);
        if (fitted) {
          kept = kept.map((item) => (item.id === target.id ? fitted : item));
          truncated = true;
        } else {
          // Even an empty body does not fit: the item cannot be represented
          // within this turn's budget at all, so it is dropped and recorded.
          kept = kept.filter((item) => item.id !== target.id);
          omitted.push({ itemId: target.id, why: 'budget' });
          truncated = true;
        }
      }
    }

    return { items: kept, omitted, truncated };
  }

  /**
   * Shrinks one item's payload until it fits `allowanceTokens`. Deterministic:
   * halving from a fixed start, so the same budget always yields the same
   * bytes. Returns null when not even an empty body fits.
   */
  private fitTo(item: ContextItem, allowanceTokens: number, minter: ItemMinter): ContextItem | null {
    if (allowanceTokens <= 0) return null;
    const text = itemBodyText(item);
    if (minter.estimate(text) <= allowanceTokens) return item;

    let length = text.length;
    let fitted: string | null = null;
    for (let attempt = 0; attempt < 24; attempt++) {
      const candidate = `${text.slice(0, length)}\n[truncated to fit the turn budget]`;
      if (minter.estimate(candidate) <= allowanceTokens) {
        fitted = candidate;
        break;
      }
      length = Math.floor(length / 2);
      if (length <= 0) break;
    }
    if (fitted === null) return null;

    return {
      ...item,
      payload: fitted,
      estimatedTokens: minter.estimate(fitted),
      truncated: true,
    };
  }

  // -------------------------------------------------------------------------
  // §6 extend
  // -------------------------------------------------------------------------

  async extend(input: ExtendContextInput, signal?: AbortSignal): Promise<ContextPackDelta> {
    return (await this.extendPlan(input, signal)).delta;
  }

  /** The extend flow of §6, plus the `context.pack.extended` payload. */
  async extendPlan(input: ExtendContextInput, signal?: AbortSignal): Promise<ContextExtendResult> {
    if (input.trigger !== 'agent_tool' && input.trigger !== 'user_action') {
      throw appError('UNKNOWN', `invalid extend trigger "${String(input.trigger)}"`, 'context', {
        details: { packId: input.packId },
      });
    }

    const pack = this.getPack(input.packId);
    if (!pack) {
      throw appError('STORAGE_ERROR', `context pack "${input.packId}" was not found`, 'context', {
        details: { packId: input.packId, turnId: input.turnId },
      });
    }

    const effectiveSignal = signal ?? input.signal;
    const providerId = this.resolveProvider(pack.workspaceId, input.sessionId);
    const minter = this.createMinter(pack.items.length);
    const maxItems = clampIndex(input.maxItems, MAX_EXTEND_ITEMS_DEFAULT, MAX_EXTEND_ITEMS_HARD);

    const collection = await this.collectForExtend(pack, input, {
      providerId,
      signal: effectiveSignal,
      deadline: Date.now() + this.collectBudgetMs,
      estimatorCtx: { providerId },
    }, minter);

    collection.items = this.rescore(collection.items, minter);

    const added: ContextItem[] = [];
    const dropped = [...collection.dropped];

    for (const candidate of collection.items) {
      if (added.length >= maxItems) {
        dropped.push({ itemId: candidate.id, why: 'no_match' });
        continue;
      }
      // T-4: the charge is what enforces the budget, and it is charged here —
      // extend() is not a way around build()'s limit.
      const remaining = this.ledger.remaining(input.turnId);
      if (candidate.estimatedTokens > remaining) {
        dropped.push({ itemId: candidate.id, why: 'budget' });
        continue;
      }
      this.ledger.charge(input.turnId, candidate.estimatedTokens);
      added.push(candidate);
    }

    const budget = this.budgetAfterExtend(pack, input.turnId);
    const revision = pack.revision + 1;
    const profile = this.profileFor(pack);

    const { injection: _previousInjection, ...carried } = pack;
    const nextPack: ContextPack = {
      ...carried,
      revision,
      items: [...pack.items, ...added],
      omitted: pack.omitted,
      budget,
      createdAt: pack.createdAt,
    };

    const injection = this.renderer.render(nextPack, profile);
    nextPack.injection = injection;
    // I-8: the increment an adapter appends mid-turn.
    const extendRendered = this.renderer.renderDelta(nextPack, added, profile).rendered;

    this.db.transaction(() => {
      this.store.writeItems(pack.id, revision, added);
      this.store.updatePack({
        id: pack.id,
        revision,
        limitTokens: budget.limitTokens,
        usedTokens: budget.usedTokens,
        truncated: budget.truncated,
        injectionMode: profile.mode,
        renderedHash: injection.renderedHash,
        renderedRef: this.store.storeRendered(injection.rendered, { packId: pack.id, revision }),
      });
    });

    const delta: ContextPackDelta = {
      packId: pack.id,
      baseRevision: pack.revision,
      revision,
      addedItems: added,
      removedItemIds: [],
      budget,
      dropped,
      createdAt: nowIso(),
    };

    const extendedPayload: ContextPackExtendedPayload = {
      packId: pack.id,
      revision,
      trigger: input.trigger,
      addedItemIds: added.map((item) => item.id),
      addedTokens: added.reduce((sum, item) => sum + item.estimatedTokens, 0),
      remainingTokens: Math.max(0, budget.remainingTokens),
      dropped,
    };
    const validated = validatePayload('context.pack.extended', extendedPayload);
    if (!validated) {
      throw appError('UNKNOWN', 'context.pack.extended payload failed its own schema', 'context', {
        details: { packId: pack.id, revision },
      });
    }

    this.livePacks.set(pack.id, nextPack);
    this.liveInjections.set(pack.turnId, injection);
    this.liveDeltas.set(deltaKey(pack.id, revision), delta);

    this.logger.info('context pack extended', {
      packId: pack.id,
      revision,
      trigger: input.trigger,
      added: added.length,
      dropped: dropped.length,
    });

    return { delta, pack: nextPack, injection, extendedPayload: validated, extendRendered };
  }

  private async collectForExtend(
    pack: ContextPack,
    input: ExtendContextInput,
    ctx: CollectionContext,
    minter: ItemMinter,
  ): Promise<ExtendCollection> {
    const items: ContextItem[] = [];
    const dropped: Array<{ itemId: string; why: ExtendDropReason }> = [];
    const terms = objectiveTerms(input.request, MAX_SEARCH_TERMS);
    if (terms.length === 0) {
      this.logger.info('extend request produced no searchable term', { packId: pack.id, request: input.request });
      return { items, dropped };
    }

    const wantedKinds = new Set<string>(input.kinds ?? []);
    const seen = new Set<string>();

    for (const term of terms) {
      if (ctx.signal?.aborted || Date.now() > ctx.deadline) break;
      // The attempt id is minted before the query so a provider failure or an
      // empty result is recorded as a drop rather than vanishing.
      const attemptId = minter.nextId();

      const outcome = await this.query(ctx, {
        kind: 'search',
        providerId: ctx.providerId,
        input: { workspaceId: pack.workspaceId, query: term, limit: MAX_LOCATIONS_PER_TERM },
      });

      if (outcome.status !== 'ok') {
        // C-5: `unsupported` is not an error and not "no results".
        dropped.push({ itemId: attemptId, why: 'provider_unavailable' });
        this.logger.warn('extend search unavailable', {
          packId: pack.id,
          term,
          status: outcome.status,
          reason: outcome.reason,
        });
        continue;
      }

      const parsed = readSearchResult(outcome.result);
      if (!parsed) {
        dropped.push({ itemId: attemptId, why: 'no_match' });
        continue;
      }

      let matched = 0;
      for (const location of parsed.items.slice(0, MAX_LOCATIONS_PER_TERM)) {
        const kind: ContextItem['kind'] = location.symbol ? 'symbol' : 'file';
        if (wantedKinds.size > 0 && !wantedKinds.has(kind)) continue;

        const reference = `${location.path}:${location.startLine}-${location.endLine}`;
        if (seen.has(reference)) continue;
        seen.add(reference);

        const payload = {
          path: location.path,
          startLine: location.startLine,
          endLine: location.endLine,
          ...(location.symbol ? { symbol: location.symbol } : {}),
          ...(location.kind ? { kind: location.kind } : {}),
        };
        const text = JSON.stringify(payload);
        items.push({
          id: minter.nextId(),
          kind,
          source: { providerId: ctx.providerId, reference },
          reason: `extended on request for "${term}"`,
          freshness: parsed.freshness,
          estimatedTokens: minter.estimate(text),
          budgetShare: 0,
          truncated: false,
          payload,
        });
        matched++;
      }

      if (matched === 0) dropped.push({ itemId: attemptId, why: 'no_match' });
    }

    return { items, dropped };
  }

  /** §6.4: released at turn end. Idempotent for a turn that never built. */
  async release(input: { turnId: string }): Promise<void> {
    this.ledger.release(input.turnId);
    const packId = this.turnToPack.get(input.turnId);
    this.liveInjections.delete(input.turnId);
    this.turnToPack.delete(input.turnId);
    if (packId) {
      this.livePacks.delete(packId);
      this.liveProfiles.delete(packId);
    }
    this.logger.debug('turn context released', { turnId: input.turnId, packId: packId ?? null });
  }

  // -------------------------------------------------------------------------
  // reads
  // -------------------------------------------------------------------------

  /**
   * The live pack when this process owns it, otherwise rebuilt from
   * `context_packs` + `context_items`.
   *
   * Two honest gaps after a restart, both of them §8.1 schema limits rather
   * than choices: there is no `objective` column (it is read back out of the
   * rendered envelope, which is the pack's canonical serialization) and there
   * is no table for `omitted` (the counts survive in the rendered
   * `<omitted/>` lines and in `context.pack.built.omittedCount`).
   */
  getPack(packId: string): ContextPack | null {
    const live = this.livePacks.get(packId);
    if (live) return live;

    const row = this.store.readPackRow(packId);
    if (!row) return null;

    const items = this.store.readItems(packId);
    const rendered = this.store.readRendered(row.rendered_text_ref);
    const limit = row.limit_tokens ?? 0;
    const used = row.used_tokens ?? items.reduce((sum, item) => sum + item.estimatedTokens, 0);

    return {
      id: row.id,
      revision: row.revision,
      workspaceId: row.workspace_id,
      sessionId: row.session_id,
      turnId: row.turn_id,
      strategy: (row.strategy as ContextStrategy) ?? 'hybrid',
      strategyReason: row.strategy_reason,
      items,
      omitted: [],
      budget: {
        packId: row.id,
        revision: row.revision,
        limitTokens: limit,
        usedTokens: used,
        remainingTokens: Math.max(0, limit - used),
        estimateSource: (row.estimate_source as TokenEstimateSource) ?? 'unknown',
        truncated: row.truncated === 1,
      },
      createdAt: row.created_at,
      objective: (rendered ? extractObjectiveFromRendered(rendered) : null) ?? objectiveFromInstruction(items) ?? '',
      // I-2: the render is a projection, the pack is the audit fact source, and
      // both are persisted. The Context Drawer reads the pack, so the plan has
      // to ride along here — otherwise the UI would have to make a second call
      // just to show `rendered` and `renderedHash`.
      ...(this.getInjection(row.turn_id)
        ? { injection: this.getInjection(row.turn_id) as ContextInjectionPlan }
        : {}),
    };
  }

  /**
   * The plan the Agent actually received. While the process owns the turn this
   * is the exact object that was rendered; after a restart it is rebuilt from
   * the stored envelope, so `renderedHash` keeps matching the bytes on disk
   * (NFR-13 stays auditable).
   */
  getInjection(turnId: string): ContextInjectionPlan | null {
    const live = this.liveInjections.get(turnId);
    if (live) return live;

    const row = this.store.readPackRowForTurn(turnId);
    if (!row) return null;
    const rendered = this.store.readRendered(row.rendered_text_ref);
    if (rendered === null) return null;

    const manifest = this.manifestForSession(row.session_id);
    const resolved = this.renderer.resolveProfile(manifest);
    const profile: InjectionProfile = { ...resolved.profile, mode: (row.injection_mode as InjectionProfile['mode']) ?? resolved.profile.mode };

    const items = this.store.readItems(row.id);
    const maxEntries = Math.max(0, profile.maxIndexEntries);
    const index = items.slice(0, maxEntries).map((item) => ({
      itemId: item.id,
      kind: item.kind,
      ...(item.source.reference ? { ref: item.source.reference } : {}),
      stale: item.freshness.stale === true,
      tokens: item.estimatedTokens,
    }));

    return {
      turnId: row.turn_id,
      packId: row.id,
      packRevision: row.revision,
      profile,
      rendered,
      renderedHash: row.rendered_hash ?? sha256Hex(rendered),
      index,
      // The per-item omission list is not persisted; the counts are, inside
      // the rendered envelope and in the event log.
      omitted: [],
      estTokens: this.estimator.estimate(rendered, {}),
      estimateSource: (row.estimate_source as TokenEstimateSource) ?? this.estimator.source,
    };
  }

  getDelta(packId: string, revision: number): ContextPackDelta | null {
    const live = this.liveDeltas.get(deltaKey(packId, revision));
    if (live) return live;

    const row = this.store.readPackRow(packId);
    if (!row) return null;
    const addedItems = this.store.readItemsAddedIn(packId, revision);
    if (addedItems.length === 0 && revision > 1) return null;

    const limit = row.limit_tokens ?? 0;
    const used = row.used_tokens ?? 0;
    return {
      packId,
      baseRevision: Math.max(1, revision - 1),
      revision,
      addedItems,
      removedItemIds: [],
      budget: {
        packId,
        revision,
        limitTokens: limit,
        usedTokens: used,
        remainingTokens: Math.max(0, limit - used),
        estimateSource: (row.estimate_source as TokenEstimateSource) ?? 'unknown',
        truncated: row.truncated === 1,
      },
      dropped: [],
      createdAt: row.created_at,
    };
  }

  /** T-4: the pack a turn's ledger is keyed on; `null` once released. */
  getPackIdForTurn(turnId: string): string | null {
    const live = this.turnToPack.get(turnId);
    if (live) return live;
    const state = this.ledger.state(turnId);
    return state?.packId ?? null;
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  /**
   * Ids are minted in insertion order (`ci_<seq>_<ulid>`), which is what makes
   * `ORDER BY id` reproduce the pack's original order on reload — and hence
   * the original `renderedHash`.
   */
  private createMinter(startSequence = 0): ItemMinter {
    let sequence = startSequence;
    return {
      nextId: () => {
        sequence += 1;
        return `ci_${String(sequence).padStart(6, '0')}_${ulid()}`;
      },
      estimate: (text: string) => this.estimator.estimate(text, {}),
    };
  }

  /** §6.1 ⑥: one authoritative token count per item, over its rendered text. */
  private rescore(items: ContextItem[], minter: ItemMinter): ContextItem[] {
    return items.map((item) => ({ ...item, estimatedTokens: minter.estimate(itemBodyText(item)) }));
  }

  private limitFor(maxInputTokens: number, reservedOutputTokens: number): number {
    const raw = Number.isFinite(maxInputTokens) ? maxInputTokens : 0;
    const reserved = Number.isFinite(reservedOutputTokens) ? Math.max(0, reservedOutputTokens) : 0;
    return Math.max(0, Math.round(raw - reserved));
  }

  private budgetAfterExtend(pack: ContextPack, turnId: string): ContextBudgetState {
    const state = this.ledger.state(turnId);
    if (state && state.packId === pack.id) {
      return { ...state, revision: pack.revision + 1 };
    }
    // The ledger is gone (released, or another process owns the turn): fall
    // back to the pack's own numbers plus what was just added, so the delta
    // still accounts for every token.
    const used = pack.budget.usedTokens + pack.items.reduce((sum, item) => sum + item.estimatedTokens, 0);
    return {
      packId: pack.id,
      revision: pack.revision + 1,
      limitTokens: pack.budget.limitTokens,
      usedTokens: Math.min(used, pack.budget.limitTokens),
      remainingTokens: Math.max(0, pack.budget.limitTokens - used),
      estimateSource: pack.budget.estimateSource,
      truncated: pack.budget.truncated,
    };
  }

  private profileFor(pack: ContextPack): InjectionProfile {
    const remembered = this.liveProfiles.get(pack.id);
    if (remembered) return remembered;
    const manifest = this.manifestForSession(pack.sessionId);
    const resolved = this.renderer.resolveProfile(manifest);
    this.liveProfiles.set(pack.id, resolved.profile);
    return resolved.profile;
  }

  private manifestForSession(sessionId: string): AgentManifest {
    if (!this.sessionStore || !this.resolveAgent) return UNKNOWN_AGENT_MANIFEST;
    try {
      const session = this.sessionStore.getSession(sessionId);
      const agentId = session?.agentId;
      if (!agentId) return UNKNOWN_AGENT_MANIFEST;
      return this.resolveAgent(agentId) ?? UNKNOWN_AGENT_MANIFEST;
    } catch (error) {
      this.logger.warn('agent manifest lookup failed', { sessionId, error: String(error) });
      return UNKNOWN_AGENT_MANIFEST;
    }
  }

  private resolveProvider(workspaceId: string, sessionId?: string): string {
    let requested: string | undefined;
    if (sessionId && this.sessionStore) {
      try {
        requested = this.sessionStore.getSession(sessionId)?.providerId;
      } catch (error) {
        this.logger.warn('session lookup failed for provider resolution', { sessionId, error: String(error) });
      }
    }
    try {
      const provider = this.intelligence.resolve(requested, workspaceId);
      const id = provider?.manifest?.id;
      if (id) return id;
    } catch (error) {
      this.logger.warn('intelligence resolve failed; falling back to basic', { workspaceId, error: String(error) });
    }
    return 'basic';
  }

  /** T-3: the provider's declared tokenizer, when it declares one (C-4). */
  private providerTokenizer(workspaceId: string, sessionId?: string): TokenEstimateSource | undefined {
    try {
      const provider = this.intelligence.resolve(
        sessionId && this.sessionStore ? this.sessionStore.getSession(sessionId)?.providerId : undefined,
        workspaceId,
      );
      const tokenizer = provider?.manifest?.capabilities?.tokenizer;
      return tokenizer === 'provider_tokenizer' || tokenizer === 'heuristic_chars_div_4' ? tokenizer : undefined;
    } catch {
      return undefined;
    }
  }

  /** NFR-05: the signal is forwarded; a throwing provider is not fatal. */
  private async query(
    ctx: CollectionContext,
    input: { kind: 'search' | 'overview'; providerId: string; input: unknown },
  ): Promise<{
    status: 'ok' | 'cancelled' | 'error' | 'unsupported';
    result: unknown;
    freshness: FreshnessState;
    durationMs: number;
    providerId: string;
    reason?: string;
  }> {
    try {
      return await this.intelligence.query({
        kind: input.kind,
        providerId: input.providerId,
        input: input.input,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
    } catch (error) {
      this.logger.warn('intelligence query threw', {
        kind: input.kind,
        providerId: input.providerId,
        error: String(error),
      });
      return {
        status: 'error',
        result: null,
        freshness: { stale: true, stalenessReason: 'provider_stale' },
        durationMs: 0,
        providerId: input.providerId,
        reason: String(error),
      };
    }
  }

}

function deltaKey(packId: string, revision: number): string {
  return `${packId}@${revision}`;
}

function objectiveFromInstruction(items: ContextItem[]): string | null {
  const instruction = items.find(
    (item) => item.kind === 'instruction' && typeof item.payload === 'string',
  );
  if (!instruction || typeof instruction.payload !== 'string') return null;
  const match = /^objective:\s*(.*)$/m.exec(instruction.payload);
  return match ? (match[1] ?? '') : null;
}
