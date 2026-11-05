/**
 * The three external blockers, as the Diagnostics panel shows them.
 *
 * ## Why this is a module and not three paragraphs in a component
 *
 * `docs/demo-script.md` answers "did you run it on a real machine?" with three
 * commands that run offline and print one line each — one per external blocker
 * (the published feed has no `sha256`, the Windows six steps have not been run,
 * the five interface states have not been signed off). That section is written
 * for someone reading the page before standing in front of a reviewer.
 *
 * On stage, nobody reads the page: the app is open, the reviewer asks the
 * question, and the answer has to be **on screen**. So the same three blocks
 * are rendered in Diagnostics → 本机环境自检, and the risk is the obvious one — two
 * copies of one fact, drifting. The page keeps quoting a command that was
 * renamed, the panel keeps showing the old one, and the person on stage points
 * at a line that will never appear.
 *
 * The fix is the shape this repository uses everywhere else: one list, read by
 * both sides, with a gate that goes red when they disagree.
 * `tests/contract/demo-boundaries.test.ts` compares this list against the
 * page's blocks (command and expected line, verbatim) and against the sentence
 * each block is introduced by, and `tests/contract/degraded-commands.ts` derives
 * the count gate's list from here rather than restating it.
 *
 * ## What is deliberately not here
 *
 * The one-sentence claim above each command. It is prose, so it lives in
 * `i18n.ts` (`diag.env.<id>`) in both locales — the panel is bilingual and the
 * page is Chinese, and a Chinese sentence hardcoded in a shared module would be
 * an English UI showing Chinese. The gate pins the Chinese half to the page's
 * heading word for word; the English half is a hand-proofread sentence and is
 * checked only for existing, because the page it mirrors is Chinese.
 *
 * Nor is the *reason* each blocker is still open. That is `docs/blockers.md`,
 * and a panel that restated it would be a third copy of a fact that already has
 * two homes.
 */

/** Which blocker a block answers. Also the i18n key suffix. */
export type DemoBoundaryId = 'feed' | 'windows' | 'states';

/** One blocker: the command to run, and the line it prints. */
export interface DemoBoundary {
  readonly id: DemoBoundaryId;
  /** The command, spelled the way the page gives it — a reader types this. */
  readonly command: string;
  /**
   * The first line the command prints, as the page quotes it.
   *
   * Elided with `…` where the line varies between machines (a count, a path, a
   * timestamp). The elisions are the page's, not this file's: the gate compares
   * the two strings whole, so a reworded output is a red run rather than a
   * panel that quietly shows yesterday's sentence.
   */
  readonly expected: string;
}

/**
 * The three blocks, in the page's order.
 *
 * Order is the blockers page's order (feed, Windows, five states) and nothing
 * reads it as a fact; it is kept so a diff of this list reads like a diff of
 * the page.
 */
export const DEMO_BOUNDARIES: readonly DemoBoundary[] = [
  {
    id: 'feed',
    command: 'node scripts/release-gate.mjs --simulate-missing-sha',
    expected:
      'REFUSED — the published feed is one the app refuses to install from, so a release ' +
      'published now would not reach anyone through it: no version may ship until the feed is ' +
      'fixed (node scripts/publish-feed.mjs --dry-run, then --apply --verify)',
  },
  {
    id: 'windows',
    command: 'node scripts/verify-main-chain.mjs --judge tests/fixtures/judge/fail.json',
    expected: '[FAIL] step … failed in that run — a red report is a result, and the row stays open',
  },
  {
    id: 'states',
    command: 'node scripts/screenshot-sources.mjs --check',
    expected: 'PASS — … renderer source(s) and … screenshot(s) match …',
  },
];
