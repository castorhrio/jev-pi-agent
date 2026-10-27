/**
 * The update feed's two log lines, and the rule that each is said once.
 *
 * The feed is read on *every* update check — `UpdateService` asks for it each
 * time the user presses the button — so both lines `readUpdateFeed()` can
 * produce are de-duplicated: "update feed resolved" and the refused-override
 * warning. A line per check would make the log of a long-running app mostly
 * repetitions of a fact that did not change, which is the noise that makes a
 * report harder to read rather than easier.
 *
 * ## Why the rule is a value instead of two flags in `bootstrap.ts`
 *
 * The "already said" state used to be two module-level `let`s in
 * `bootstrap.ts`, declared next to the code that read them. That is a promise
 * nothing can check: `bootstrap.ts` imports Electron at the top, so no test can
 * import it, and the only way to observe the flags would be `vi.resetModules()`
 * plus a fake Electron — a test of the harness rather than of the rule. The
 * behaviour a user depends on (two checks, one line) was therefore described in
 * a comment and asserted nowhere.
 *
 * `createUpdateFeedAnnouncer()` is the same rule as a value: the factory owns
 * the "already said" state in its closure, `announce()` is the only way to
 * write, and `tests/contract/update-feed-log.test.ts` drives it with a
 * recording logger — no Electron, no module-reset dance. `bootstrap.ts` keeps
 * one instance for the life of the process, and a source scan in that test file
 * fails if the flags grow back next to it.
 *
 * ## An unsaid line is not a said line
 *
 * Both flags are set *after* the write, not before. The old code did the
 * opposite (`if (… && !logged) { logged = true; ucad?.logger.info(…) }`), which
 * meant a line produced before the container's logger existed was dropped and
 * marked as delivered: the next check, with a logger, saw the flag and said
 * nothing. A startup that asked for the feed early would therefore lose the one
 * line that tells an operator where the feed came from. Nothing can print
 * without a target, so nothing is counted as said without one either.
 *
 * The other half of that decision: the two lines have separate flags. They are
 * not alternatives — a build can resolve its feed on one check and be told on a
 * later one that its override is unusable — and a shared flag would let the
 * first line silence the second.
 */

import type { ChannelUrlRejection, ResolvedUpdateFeed } from './update-feed';

/**
 * What the announcer needs from a logger.
 *
 * Narrower than `Logger` on purpose: two methods, both one-way, so a test can
 * pass an object literal and so this module cannot start writing at other
 * levels without a visible change here.
 */
export interface UpdateFeedLogTarget {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

/**
 * The sentence each refusal produces, one per reason.
 *
 * `Record<ChannelUrlRejection, string>` rather than the `if`/`else` this was
 * written as first: the two refusals are different problems with different
 * fixes — "not a URL" is a typo, "not https" is a downgrade this app will not
 * take — and the branch paired them by *position* (anything that was not
 * `invalid-url` got the https sentence). A third reason added to
 * `ChannelUrlRejection` would have compiled and been reported as a downgrade
 * attempt, which is the one log line in the updater that must not guess. As a
 * table the new reason does not compile until it has a sentence.
 *
 * Exported for the runtime half of the same check: `tests/contract/update-feed-log.test.ts`
 * compares the keys with the reasons `resolveUpdateFeed()` actually produces,
 * because `tests/` is transpiled without typechecking and a test cannot
 * enumerate a type. Adding a reason means adding it to both — which is the
 * point, and the price of the compiler only seeing one direction.
 *
 * **One sentence, two call sites.** `UpdateService.resolveFeed()` writes this
 * same warning when a caller hands it a feed directly, so the sentence cannot
 * name only the environment override: the service is reached by a value that
 * may have come from either the override or the packaged configuration. It
 * names both places a build's feed is configured, which is true at both call
 * sites. A second, service-local pair of sentences used to sit beside this
 * table, and `tests/contract/update-integrity.test.ts` now asserts the service
 * writes exactly `UPDATE_FEED_REFUSAL_MESSAGE[reason]` for every reason — the
 * same rule as the announcer's, not a lookalike that can drift.
 */
export const UPDATE_FEED_REFUSAL_MESSAGE: Record<ChannelUrlRejection, string> = {
  'invalid-url':
    'update feed ignored: UCAD_UPDATE_FEED or update-config.json is not a valid URL',
  'not-https':
    'update feed ignored: UCAD_UPDATE_FEED or update-config.json must be an https URL',
};

/** The line a resolved feed produces, said once. */
export const UPDATE_FEED_RESOLVED_MESSAGE = 'update feed resolved';

/** The announcement, and the "already said" state it carries. */
export interface UpdateFeedAnnouncer {
  /**
   * Say whichever line this resolution calls for, at most once per instance.
   *
   * `target` may be absent: the feed can be read before the container is up.
   * In that case nothing is written and nothing is marked as said, so the line
   * is still available to the first check that has somewhere to put it.
   */
  announce(resolved: ResolvedUpdateFeed, target: UpdateFeedLogTarget | null | undefined): void;
}

/**
 * A fresh announcer — one process's worth of "already said".
 *
 * Not a module-level singleton: the state belongs to the caller, so two tests
 * (or a future second process wiring) cannot silence each other, and a caller
 * that wants to announce again can hold its own instance.
 */
export function createUpdateFeedAnnouncer(): UpdateFeedAnnouncer {
  let resolvedSaid = false;
  let refusalSaid = false;
  return {
    announce(resolved, target) {
      // No target, no line — and no flag either; see the header.
      if (!target) return;
      if (resolved.rejected !== undefined && !refusalSaid) {
        target.warn(UPDATE_FEED_REFUSAL_MESSAGE[resolved.rejected], {
          reason: resolved.rejected,
        });
        refusalSaid = true;
      }
      if (resolved.url !== null && !resolvedSaid) {
        // `source` is why this is worth a line at all: "env" and "config" are
        // different answers to "where is this build checking", and the reader
        // of a log cannot tell them apart from the URL alone.
        target.info(UPDATE_FEED_RESOLVED_MESSAGE, { source: resolved.source });
        resolvedSaid = true;
      }
    },
  };
}
