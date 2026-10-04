/**
 * The skills plane — the types a skill file, a discovered skill and a resolved
 * binding travel as.
 *
 * A skill here is **not** a new authoring format and **not** a marketplace.
 * It is a named, file-backed fragment of standing instructions that gets bound
 * to particular agent ids, discovered from the disk exactly where the
 * `agentskills.io` / `SKILL.md` convention already puts them
 * (`<root>/.ucad/skills/<name>/SKILL.md`). POSITIONING §1 puts skill
 * *self-learning* out of scope on purpose, so nothing in this package writes,
 * installs or learns a skill: it reads files and explains what it bound.
 *
 * The delivery path is the Context plane (§4.5 / §4.6): a bound skill becomes
 * an ordinary `instruction` ContextItem, so its text lands in `rendered` and is
 * covered by `renderedHash` (NFR-13). There is deliberately no second,
 * private injection channel — see `packages/context/src/broker.ts`.
 */

/** Where a skill file was found. Workspace wins over user on a name clash. */
export type SkillScope = 'workspace' | 'user';

/**
 * The front matter UCAD reads. `name` and `description` are the keys the
 * `agentskills.io` convention already defines, so a UCAD skill file is a
 * portable skill file; `agents` and `tools` are additional keys in the same
 * block, which a consumer that does not know them simply ignores.
 */
export interface SkillFrontmatter {
  name: string;
  description?: string;
  /** agent ids this skill applies to; empty = applies to every agent */
  agents: string[];
  /** optional tool allow/deny patterns, e.g. `['read_file', 'deny:rm -rf*']` */
  tools: string[];
}

export interface Skill {
  /** stable, derived from the file path alone — never from mtime or content */
  id: string;
  name: string;
  description?: string;
  agents: string[];
  tools: string[];
  /** the SKILL.md body, with the front matter block stripped */
  body: string;
  sourcePath: string;
  scope: SkillScope;
  /** mtime + size, so the UI can tell a stale listing from a live one */
  fingerprint: string;
  bytes: number;
}

/** A skill that matched one `(agent, objective)` pair, and why. */
export interface SkillBinding {
  skill: Skill;
  /** the sentence the Context Drawer and the item `reason` both quote */
  reason: string;
  score: number;
  /**
   * The exact text to inject. Produced here rather than in the broker so the
   * bytes that are measured (`estimateSkillTokens`) and the bytes that are
   * rendered cannot drift apart.
   */
  text: string;
}

/** A skill that applies but did not make the per-turn cap, and why. */
export interface SkillDrop {
  skill: Skill;
  reason: string;
}

/**
 * The whole answer to "what applies to this agent right now". The cap and the
 * dropped skills travel with it so a truncated list is never silent.
 */
export interface SkillResolution {
  bindings: SkillBinding[];
  dropped: SkillDrop[];
  /** the per-turn cap that was applied */
  cap: number;
  /** how many skills applied before the cap */
  considered: number;
  /** one legible line the UI can show without re-deriving anything */
  note: string;
}

/** A root to scan, with the scope that decides who wins a name collision. */
export interface SkillRoot {
  path: string;
  scope: SkillScope;
}

/** A file that looked like a skill and was not usable, with the reason. */
export interface SkillSkip {
  sourcePath: string;
  reason: string;
}

/**
 * Only `driver` and `transaction` are ever named, and in fact nothing is
 * written: `skills` gets no table, so the parameter is
 * reserved for wiring symmetry rather than for a schema.
 */
export interface DatabaseLike {
  driver: unknown;
  transaction<T>(fn: () => T): T;
}
