/**
 * `@ucad/skills` — file-backed agent skills.
 *
 * A skill is a named markdown file with optional front matter, discovered at
 * `<workspace>/.ucad/skills/<name>/SKILL.md` and `~/.ucad/skills/<name>/SKILL.md`,
 * using the `agentskills.io` / `SKILL.md` convention rather than a format of
 * UCAD's own. This package finds those files and works out which ones apply to
 * a given agent and objective.
 *
 * What it deliberately does not do (POSITIONING §1): no authoring studio, no
 * marketplace, no install step, and above all no *self-learning* — nothing here
 * writes a skill, rates one, or proposes a new one.
 *
 * How a skill reaches an Agent: through the Context plane, as an ordinary
 * `instruction` ContextItem, so its text is inside `rendered` and inside
 * `renderedHash` (NFR-13, §4.6) and the user can audit it in the Context
 * Drawer. There is no second injection channel.
 *
 * Dependencies: `@ucad/observability` for the logger and the id hash,
 * `@ucad/contracts` for the `TokenEstimator` type. Nothing else, and no new
 * npm dependency in the tree.
 */

export {
  discoverSkills,
  defaultSkillRoots,
  SKILL_FILE_NAME,
  MAX_SKILL_FILE_BYTES,
} from './discovery';
export type { DiscoverOptions } from './discovery';

export { parseSkillFile, MAX_FRONTMATTER_CHARS } from './frontmatter';
export type { FrontmatterResult } from './frontmatter';

export { SkillRegistry, skillInstructionText, MAX_SKILLS_PER_TURN } from './registry';
export type { SkillRegistryOptions } from './registry';

export { estimateSkillTokens, estimateSkillTokensEach } from './tokens';

export type {
  DatabaseLike,
  Skill,
  SkillBinding,
  SkillDrop,
  SkillFrontmatter,
  SkillResolution,
  SkillRoot,
  SkillScope,
  SkillSkip,
} from './types';
