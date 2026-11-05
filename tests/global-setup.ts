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
import { tempDirProblem, usableTempDir } from '../scripts/temp-dir-probe.mjs';

export default async function globalSetup(): Promise<void> {
  /*
   * The machine before the tree.
   *
   * The contract suite creates its throwaway trees under `os.tmpdir()`, so a
   * temp directory with no headroom fails dozens of unrelated files with an
   * errno that names no directory and no fix — a green HEAD reads as a broken
   * repository. The probe allocates 1 MiB, and it throws rather than warns so
   * the run ends with the reason instead of a verdict about code that was never
   * measured.
   */
  const problem = tempDirProblem();
  if (problem !== null) {
    const usable = usableTempDir();
    throw new Error(
      usable === null
        ? `${problem}\nNo fallback directory took the same write either: free space or raise ` +
          'the quota behind os.tmpdir(), then re-run.'
        : `${problem}\nRe-run against a directory that passed the same write: TMPDIR=${usable} npm test`,
    );
  }

  ensureAppRulesBuilt();
}
