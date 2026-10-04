/**
 * §4.5.3 / T-3 — what a binding actually costs.
 *
 * This repo just learned that a token claim needs evidence (POSITIONING §3), so
 * the price of enabling skills is a function rather than a sentence in a
 * design doc. It estimates the *same* text the broker injects — `skillInstructionText`
 * is shared, not re-implemented here — which is the only way the number below
 * can be trusted as the number the budget will charge.
 *
 * Provenance travels with the value: the estimator's own `source` is what makes
 * this an estimate (`heuristic_chars_div_4`) or a count (`provider_tokenizer`).
 */

import type { TokenEstimator } from '@ucad/contracts';

import { skillInstructionText } from './registry';
import type { Skill } from './types';

/**
 * The token cost of injecting every skill in a binding.
 *
 * Pass the `TokenEstimator` the Context plane is already using, so the number
 * is commensurable with `ContextBudget.limitTokens` rather than being a second
 * opinion. Skills are charged before the turn's T-5 trimming runs, so this is
 * the amount a binding asks for, not necessarily the amount it keeps.
 */
export function estimateSkillTokens(skills: readonly Skill[], estimator: TokenEstimator): number {
  let total = 0;
  for (const skill of skills) {
    // `{}` rather than a model id: the heuristic ignores it, and a provider
    // tokenizer that needs one gets the same default ctx the broker's minter
    // passes, so the two numbers are measured the same way.
    total += estimator.estimate(skillInstructionText(skill), {});
  }
  return total;
}

/** Per-skill breakdown, for the UI and for a budget warning. */
export function estimateSkillTokensEach(
  skills: readonly Skill[],
  estimator: TokenEstimator,
): Array<{ skill: Skill; tokens: number }> {
  return skills.map((skill) => ({
    skill,
    tokens: estimator.estimate(skillInstructionText(skill), {}),
  }));
}
