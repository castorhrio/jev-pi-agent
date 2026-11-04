/**
 * The unit suite's one precondition, run once before any test file loads.
 *
 * `vitest.config.ts` registers this as `globalSetup`. It exists so the contract
 * tests that judge a published update feed can *require* the app's own rules
 * instead of asking whether some earlier command happened to build them: see
 * `tests/contract/app-rules-build.ts` for why the four answers those files used
 * to give are the defect, and why building inside a test file would be worse.
 *
 * A setup that throws ends the run with a non-zero exit and prints the reason.
 * That is the behaviour this replaces — `if (!RULES_BUILT) return;` ended the run
 * with a green tick and no reason at all.
 */

import { ensureAppRulesBuilt } from './contract/app-rules-build';

export default async function globalSetup(): Promise<void> {
  ensureAppRulesBuilt();
}
