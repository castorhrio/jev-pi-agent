/**
 * §4.5 / skills plane — binding.
 *
 * `SkillRegistry` answers one question: *which skills apply to this agent,
 * right now, for this objective?* It is the whole feature — discovery is just
 * how the candidates are found.
 *
 * Two kinds of applicability, and both are needed:
 *
 *   1. **Bound** — the front matter names the agent (`agents: [pi]`). A bound
 *      skill is a standing instruction: it applies whatever the objective says.
 *      This is the "different agents need different skills" half of the
 *      request, and it must not evaporate because a keyword did not match.
 *   2. **Matched** — the objective names the skill's own words. This is how a
 *      skill written for one job reaches an agent it was never bound to.
 *
 * The scoring is deliberately dumb: deterministic lexical overlap between the
 * objective and the skill's `name` + `description`, with the hit that caused
 * each match quoted back. No model call, no corpus statistics, no similarity
 * index — because this repo's rule is that anything which affects injection
 * has to be explainable, and a number nobody can reconstruct is not
 * explainable. The same argument is why the cap is reported rather than
 * applied quietly.
 */

import type { Logger } from '@ucad/observability';

import { defaultSkillRoots, discoverSkills } from './discovery';
import type {
  DatabaseLike,
  Skill,
  SkillBinding,
  SkillDrop,
  SkillResolution,
  SkillRoot,
} from './types';

/**
 * How many skills one turn may carry.
 *
 * Three is a judgement, not a measurement: enough for a "style" + a "tool
 * usage" + a "review rules" binding, few enough that the standing-instruction
 * cost stays a rounding error next to the code context (§4.5). It is a cap
 * with a name, so it can be argued with — and `MAX_SKILLS_PER_TURN` is
 * overridable per registry.
 */
export const MAX_SKILLS_PER_TURN = 3;

/** Shorter than this and the word is noise (`a`, `in`, `the`). */
const MIN_TERM_LENGTH = 2;

/**
 * Words that carry no intent. Without this list a skill leaks across agents on
 * nothing: a description ending "Use for regression work" matches any objective
 * containing "for", and the one thing `agents:` exists to prevent happens.
 * Deliberately short and language-specific — this is a stop list for English
 * function words, not a tokenizer.
 */
const STOP_WORDS: ReadonlySet<string> = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'when', 'then',
  'use', 'used', 'using', 'any', 'all', 'can', 'its', 'it', 'of', 'to', 'in',
  'on', 'at', 'by', 'is', 'are', 'be', 'as', 'or', 'if', 'do', 'does', 'how',
  'you', 'your', 'we', 'our', 'their', 'them', 'they', 'was', 'were', 'will',
]);

/** Objective terms considered for matching; the tail cannot change the order. */
const MAX_MATCH_TERMS = 16;

/**
 * The score an **unbound** skill needs before it is injected.
 *
 * A bound skill is standing instructions and is in regardless. An unbound one
 * is being pulled into this agent's prompt on the strength of word overlap
 * alone, so a single incidental word is not enough: two description hits, or
 * one name hit (worth 3), or naming the skill outright. This is the guardrail
 * that keeps `agents: [pi]` meaning what it says.
 */
const MIN_UNBOUND_SCORE = 2;

/** A hit on the skill's own name is worth more than one in its description. */
const WEIGHT_NAME = 3;
const WEIGHT_DESCRIPTION = 1;
/** Saying the skill's full name is a stronger signal than sharing a word. */
const BONUS_WHOLE_NAME = 2;

export interface SkillRegistryOptions {
  logger: Logger;
  /**
   * Reserved. `skills` gets no table, so nothing is
   * written here; the parameter exists so the wiring signature does not have
   * to change when a table does.
   */
  db?: DatabaseLike;
  /** defaults to the user root, plus the workspace root when one is given */
  roots?: SkillRoot[];
  workspaceRoot?: string;
  /** per-turn cap; defaults to MAX_SKILLS_PER_TURN */
  maxPerTurn?: number;
}

/** ASCII words match whole tokens ("latest" is not a "test"); CJK matches as a substring. */
function termize(text: string): string[] {
  const lower = text.toLowerCase();
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const raw of lower.split(/[^\p{L}\p{N}_-]+/u)) {
    const term = raw.replace(/^[_.-]+|[_.-]+$/g, '');
    if (term.length < MIN_TERM_LENGTH) continue;
    if (seen.has(term)) continue;
    if (STOP_WORDS.has(term)) continue;
    seen.add(term);
    terms.push(term);
    if (terms.length >= MAX_MATCH_TERMS) break;
  }
  return terms;
}

/** The name and description, lower-cased once, as the whole match surface. */
function matchSurface(skill: Skill): { name: string; description: string } {
  return {
    name: skill.name.toLowerCase(),
    description: (skill.description ?? '').toLowerCase(),
  };
}

function containsTerm(haystack: string, term: string): boolean {
  if (haystack.length === 0) return false;
  // Non-ASCII terms are CJK prose with no word boundaries; ASCII terms get a
  // boundary so "test" does not fire on "latest".
  if (/^[\p{L}\p{N}_-]+$/u.test(term) && /[a-z0-9]/i.test(term)) {
    return new RegExp(`(^|[^a-z0-9])${escapeRegExp(term)}([^a-z0-9]|$)`, 'i').test(haystack);
  }
  return haystack.includes(term);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface Scored {
  score: number;
  /** the quotes that justify the score — this is the explanation */
  hits: string[];
}

function scoreSkill(skill: Skill, objective: string, terms: readonly string[]): Scored {
  const surface = matchSurface(skill);
  const lowerObjective = objective.toLowerCase();
  const hits: string[] = [];
  let score = 0;

  for (const term of terms) {
    const inName = containsTerm(surface.name, term);
    const inDescription = containsTerm(surface.description, term);
    if (!inName && !inDescription) continue;
    if (inName) score += WEIGHT_NAME;
    if (inDescription) score += WEIGHT_DESCRIPTION;
    hits.push(`'${term}' in ${inName && inDescription ? 'name and description' : inName ? 'name' : 'description'}`);
  }

  // A CJK objective has no spaces, so the term loop already covers it; this
  // catches the ASCII case where someone types the skill's exact name.
  if (surface.name.length >= MIN_TERM_LENGTH && lowerObjective.includes(surface.name)) {
    score += BONUS_WHOLE_NAME;
    hits.push(`the objective names the skill "${skill.name}" outright`);
  }

  return { score, hits };
}

/** The exact text a skill contributes to a Context item. */
export function skillInstructionText(skill: Skill): string {
  const header = [
    `# skill: ${skill.name}`,
    `# scope: ${skill.scope} | applies to: ${skill.agents.length > 0 ? skill.agents.join(', ') : 'every agent'}`,
    ...(skill.description ? [`# description: ${skill.description}`] : []),
  ];
  return `${header.join('\n')}\n\n${skill.body.trim()}`;
}

function bindingReason(skill: Skill, agentId: string, scored: Scored, bound: boolean): string {
  const matched = scored.score > 0;
  if (bound && matched) {
    return `bound to agent '${agentId}' by its front matter, and the objective ${scored.hits.join('; ')}`;
  }
  if (bound) {
    const via = skill.agents.length > 0 ? `front matter agents: [${skill.agents.join(', ')}]` : 'a front matter block that names no agent';
    return `bound to agent '${agentId}' by ${via}; kept as a standing instruction although the objective matched nothing`;
  }
  return `not bound to any agent, and the objective ${scored.hits.join('; ')}`;
}

export class SkillRegistry {
  private readonly logger: Logger;
  private readonly roots: SkillRoot[];
  private readonly maxPerTurn: number;
  private readonly db: DatabaseLike | undefined;

  /** Re-discovery happens only after `invalidate()`, so it stays cheap. */
  private cache: Skill[] | null = null;
  private skips: number = 0;

  constructor(opts: SkillRegistryOptions) {
    this.logger = opts.logger.child('skills');
    this.db = opts.db;
    this.roots = opts.roots ?? defaultSkillRoots(opts.workspaceRoot);
    this.maxPerTurn = Math.max(1, Math.floor(opts.maxPerTurn ?? MAX_SKILLS_PER_TURN));
  }

  /** The roots being watched, so the UI can show what UCAD is looking at. */
  watchedRoots(): readonly SkillRoot[] {
    return this.roots;
  }

  /**
   * Forces the next `list()` / `match()` to re-read the disk. Called by the
   * file watcher; the registry holds no other state, so this is the whole
   * invalidation story.
   */
  invalidate(): void {
    this.cache = null;
  }

  /** Every discovered skill, workspace shadowing user, sorted by name. */
  list(scope?: Skill['scope']): Skill[] {
    const all = this.discover();
    return scope ? all.filter((skill) => skill.scope === scope) : all;
  }

  /** The skills that apply to one agent, capped and ordered. */
  resolveForAgent(agentId: string, objective: string): Skill[] {
    return this.resolve(agentId, objective).bindings.map((binding) => binding.skill);
  }

  /**
   * The objective-matched subset with the reason for each, so the UI can
   * explain the binding instead of asserting it.
   */
  match(agentId: string, objective: string): SkillBinding[] {
    return this.resolve(agentId, objective).bindings.filter((binding) => binding.score > 0);
  }

  /**
   * The full answer: bound + matched, ranked, capped, with everything that did
   * not fit named explicitly.
   *
   * Ranking is `score` descending then `name` ascending, so two runs over the
   * same tree produce the same order and therefore the same pack (NFR-13).
   */
  resolve(agentId: string, objective: string): SkillResolution {
    const wanted = agentId.trim().toLowerCase();
    const terms = termize(objective);

    const applicable: Array<{ skill: Skill; score: number; hits: string[]; bound: boolean }> = [];
    for (const skill of this.discover()) {
      const bound = skill.agents.length === 0 || skill.agents.some((id) => id.toLowerCase() === wanted);
      const scored = scoreSkill(skill, objective, terms);
      // Bound skills are standing instructions and apply whatever the objective
      // says; an unbound one has to clear MIN_UNBOUND_SCORE on its own.
      if (!bound && scored.score < MIN_UNBOUND_SCORE) continue;
      applicable.push({ skill, score: scored.score, hits: scored.hits, bound });
    }

    applicable.sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name));

    const considered = applicable.length;
    const kept = applicable.slice(0, this.maxPerTurn);
    const overflow = applicable.slice(this.maxPerTurn);

    const bindings: SkillBinding[] = kept.map((entry) => ({
      skill: entry.skill,
      reason: bindingReason(entry.skill, agentId, entry, entry.bound),
      score: entry.score,
      text: skillInstructionText(entry.skill),
    }));
    const dropped: SkillDrop[] = overflow.map((entry, index) => ({
      skill: entry.skill,
      reason:
        `ranked #${this.maxPerTurn + index + 1} of ${considered} for this objective ` +
        `(score ${entry.score}); the per-turn cap is ${this.maxPerTurn}`,
    }));

    const note = this.note(agentId, considered, bindings, dropped);
    if (dropped.length > 0) this.logger.info('skills left out by the per-turn cap', { agentId, note });

    return { bindings, dropped, cap: this.maxPerTurn, considered, note };
  }

  private note(
    agentId: string,
    considered: number,
    bindings: SkillBinding[],
    dropped: SkillDrop[],
  ): string {
    if (considered === 0) return `no skills apply to agent '${agentId}' for this objective`;
    const bound = bindings.filter((binding) => binding.skill.agents.length > 0).length;
    const head =
      `${bindings.length} of ${considered} applicable skill(s) for agent '${agentId}'` +
      (bound > 0 ? ` (${bound} bound to it by front matter)` : '');
    if (dropped.length === 0) return head;
    return `${head}; ${dropped.length} left out by the per-turn cap of ${this.maxPerTurn}`;
  }

  /** The skills that could not be read this pass; for the UI's warning list. */
  skippedCount(): number {
    this.discover();
    return this.skips;
  }

  private discover(): Skill[] {
    const cached = this.cache;
    if (cached) return cached;

    let skips = 0;
    const skills = discoverSkills(
      this.roots.map((root) => root.path),
      {
        scopeOf: (root) => this.roots.find((known) => known.path === root)?.scope ?? 'workspace',
        onSkip: (skip) => {
          skips += 1;
          this.logger.warn('skipping a skill file', { path: skip.sourcePath, reason: skip.reason });
        },
      },
    );
    this.skips = skips;
    this.cache = skills;
    this.logger.debug('skills discovered', {
      roots: this.roots.map((root) => `${root.scope}:${root.path}`),
      skills: skills.length,
      skipped: skips,
      cap: this.maxPerTurn,
    });
    return skills;
  }

  /**
   * Reserved for the wiring in §0; deliberately unused so that adding a table
   * later is a change of behaviour rather than a change of signature.
   */
  database(): DatabaseLike | undefined {
    return this.db;
  }
}
