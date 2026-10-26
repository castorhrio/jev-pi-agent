/**
 * Bridges `@ucad/git` to the narrow `GitLike` seam that `@ucad/context` declares
 * (§6 of the service contracts).
 *
 * The seam exists so the Context plane never imports the Git package. That
 * means the two summaries the broker needs — "is the worktree dirty" and "what
 * does the diff say" — have to be derived here, including a token estimate,
 * because the broker has to charge the diff against the turn budget (T-5) and
 * `GitService.diff` is per-path.
 */

import type { GitService } from '@ucad/git';
import type { HeuristicTokenEstimator } from '@ucad/context';
import { describeError } from '@ucad/contracts';
import type { Logger } from '@ucad/observability';

export interface GitLikeBridgeOptions {
  git: GitService;
  estimator: HeuristicTokenEstimator;
  logger: Logger;
  /** resolves a workspaceId to its on-disk root */
  resolveRoot: (workspaceId: string) => string;
  /** bound on how much of the diff is summarised into a context item */
  maxDiffTokens?: number;
  /** how many per-file diffs may be in flight at once (default 4) */
  diffConcurrency?: number;
  /**
   * whole-summary budget in ms, `git status` included; whatever has not
   * answered by then is reported and logged (default 2000)
   */
  diffDeadlineMs?: number;
}

/**
 * How many `git diff` calls run at once.
 *
 * The per-file calls were serial, which is fine for one agent on one repo and
 * not for what this app is for: several agents turn the same workspace into a
 * queue of subprocess spawns, and the summary sits on the turn boundary — the
 * one place where latency is charged to the user twice. Four is enough to hide
 * the spawn cost without turning one turn into a burst of git processes.
 */
const DEFAULT_DIFF_CONCURRENCY = 4;

/**
 * The whole summary's budget.
 *
 * A `git diff` — or the `git status` that starts the summary — that hangs (a
 * stale index lock, a network drive) must not hold the turn open until the app
 * is closed. Two seconds is well past a normal summary and short enough that a
 * person notices nothing but the answer being smaller than expected. What came
 * back in time is used; what did not is logged, not silently invented.
 */
const DEFAULT_DIFF_DEADLINE_MS = 2_000;

/**
 * The three flags that decide what a late answer may claim.
 *
 *  - `expired` — the deadline timer fired. Monotonic, and the only test for
 *    "too late"; the diff workers stop claiming paths on it.
 *  - `statusInFlight` — `git status` was called and has not settled. True on
 *    the deadline line when status is the call that hung, false on every
 *    `status-late` line.
 *  - `snapshotTaken` — the returned array was built from `collected`. A diff
 *    that lands after this is only evidence about a subprocess, never part of
 *    the answer. Not set on the status-stage early return: no path was
 *    listed, so no diff exists to report.
 *
 * `snapshotTaken` does not imply `expired`: a summary that finishes inside its
 * budget takes the snapshot with `expired` still false. A status-stage
 * deadline returns before either flag is settled. So each late line has its
 * own guard: a late status is defined by `expired`, a late diff by
 * `snapshotTaken`.
 *
 * The combinations, including the impossible ones, are pinned as a table in
 * `tests/contract/git-bridge.test.ts` ("the three flags, as a table").
 */
export class GitLikeBridge {
  private readonly opts: GitLikeBridgeOptions;

  constructor(opts: GitLikeBridgeOptions) {
    this.opts = opts;
  }

  async status(workspaceId: string): Promise<{
    dirty: boolean;
    branch?: string;
    head: string;
    changedFiles: number;
  }> {
    const root = this.opts.resolveRoot(workspaceId);
    const dto = await this.opts.git.status(workspaceId, root);
    const changedFiles =
      dto.staged.length + dto.unstaged.length + dto.untracked.length;
    return {
      dirty: dto.dirty,
      ...(dto.branch ? { branch: dto.branch } : {}),
      head: dto.head,
      changedFiles,
    };
  }

  /**
   * The dirty files' patches, bounded in both directions.
   *
   * Two bounds, because the two failure modes are different: too many *files*
   * is a cost problem (solved by `limit` before any subprocess starts), and one
   * *slow file* is a latency problem (solved by the concurrency cap plus the
   * overall deadline). The order of the result is the order `git status` listed
   * the paths, not the order they happened to finish — a diff summary that
   * reshuffled itself between turns would look like the repository changed.
   *
   * `diffDeadlineMs` is the budget for the *summary*, so `git status` is inside
   * it. `status` is the first subprocess of the call and, on a stale index lock
   * or a workspace on a network drive, the one that hangs before any per-file
   * work even starts; leaving it outside made the documented budget a bound on
   * the file diffs only, and a turn could still wait on git forever.
   */
  async diffSummary(input: {
    workspaceId: string;
    limit?: number;
  }): Promise<Array<{ path: string; patch: string; tokens: number }>> {
    const root = this.opts.resolveRoot(input.workspaceId);
    const limit = input.limit ?? 10;
    const deadlineMs = this.opts.diffDeadlineMs ?? DEFAULT_DIFF_DEADLINE_MS;

    // Armed before `git status`, not after it — see the doc comment above.
    let expired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        expired = true;
        resolve();
      }, deadlineMs);
    });

    // Whether the `git status` subprocess is still running right now.
    //
    // The summary cannot cancel it: `GitService.status` takes no
    // `AbortSignal`, so a `git status` that is still out there when the
    // deadline fires keeps running and its answer is dropped when it lands.
    // A subprocess the reader cannot see is a subprocess nobody can account
    // for, so the state is measured rather than assumed.
    let statusInFlight = false;

    // Whether the caller's answer has been built from `collected`. A `git
    // diff` that finishes after this point cannot contribute to it any more;
    // see `logLateDiff`.
    let snapshotTaken = false;

    /**
     * Records a `git status` that answered after the deadline.
     *
     * The deadline line said `statusInFlight: true`; that was a snapshot, and
     * a snapshot has no ending. This line is the ending, and it changes
     * nothing else: the summary was already returned empty and no diff was
     * spawned for a path nobody listed. `expired` is the test for "too late" —
     * one clock, one answer.
     *
     * `stage: 'status-late'` (not `'status'`) keeps a report from counting one
     * hung `git status` twice; the deadline line is the giving-up snapshot,
     * this one is the same subprocess arriving afterwards.
     */
    const logLateStatus = (outcome: 'answered' | 'failed', error?: unknown): void => {
      if (!expired) return;
      this.opts.logger.debug('git diff summary discarded a late status answer', {
        workspaceId: input.workspaceId,
        stage: 'status-late',
        // The subprocess has returned — that is the only reason the answer is
        // here at all — so nothing of it is still out there.
        statusInFlight: false,
        inFlight: 0,
        // The same shape as the deadline line, so the two can be read
        // side by side: both of them describe a summary with nothing in it.
        // `requested` is 0 here by construction, not by measurement: `status`
        // is what produces the path list, so a summary that gave up on
        // `status` never had a path to request a diff for. A reader adding
        // these numbers up gets a zero row and should read it as "this
        // summary never started", which is exactly what happened.
        collected: 0,
        requested: 0,
        abandoned: 0,
        failed: 0,
        outcome,
        ...(error !== undefined ? { error: describeError(error) } : {}),
      });
    };

    /**
     * Records a `git diff` that answered after the summary was built.
     *
     * `snapshotTaken`, not `expired`, decides this: a diff can cross the
     * finish line while the deadline timer fires, just before `out` is built.
     * That answer is in the summary the caller receives, and calling it late
     * would contradict the answer. Only a diff that finishes after the
     * snapshot is guaranteed to be dropped.
     *
     * The line names the path the answer belonged to — the deadline line only
     * counted it as abandoned, and a count cannot tell a slow file from a hung
     * one once the summary has returned. `stage: 'diff-late'` keeps a report
     * counting `stage: 'diff'` from counting one slow file twice. A late
     * failure gets `outcome: 'failed'` and its error instead of the in-time
     * "skipped" line, which would describe work nobody is waiting for.
     */
    const logLateDiff = (
      path: string,
      outcome: 'answered' | 'failed',
      error?: unknown,
    ): void => {
      if (!snapshotTaken) return;
      this.opts.logger.debug('git diff summary discarded a late diff answer', {
        workspaceId: input.workspaceId,
        stage: 'diff-late',
        path,
        outcome,
        ...(error !== undefined ? { error: describeError(error) } : {}),
      });
    };

    try {
      // The flag is set from the call's *return value*, not from its
      // resolution: a `status` that rejects still left a subprocess behind,
      // and waiting to set it inside `.then()` would have missed exactly the
      // hang this field exists for. A synchronous throw never returns here at
      // all — it lands in the `catch` below with no deadline log, which is the
      // one path where reporting `inFlight` would be a claim about a git
      // process that was never spawned.
      const statusCall = this.opts.git.status(input.workspaceId, root);
      statusInFlight = true;
      const status = await Promise.race([
        statusCall.then(
          (dto) => {
            statusInFlight = false;
            logLateStatus('answered');
            return { answered: true as const, dto };
          },
          (error) => {
            statusInFlight = false;
            // A failure that lands after the deadline is dropped by the race
            // and reaches nobody: the summary was already returned, and the
            // rejection has no caller left to refuse. Written down here so a
            // git process that died on a stale lock is not the same as one
            // that never ran.
            logLateStatus('failed', error);
            // The two endings are told apart here, because the difference is
            // what the caller sees.
            //
            // Late — the deadline has fired. The race has already settled,
            // the summary is on its way back empty, and `Promise.race`
            // attaches a handler to *both* branches: the rejection of the
            // branch that lost is consumed by the race, so it never reaches
            // the process as an unhandled rejection and there is nobody left
            // to hand it to. It is recorded above, and that is all that is
            // left to do with it. Saying so here is what keeps the next
            // reader from "fixing" a re-throw that would only throw into a
            // promise nobody is waiting for any more.
            //
            // In time — the summary has no status to work from, and the
            // failure belongs to the caller. The re-throw is what carries it
            // to the `catch` below, which reports it and answers with an
            // empty summary. Swallowing it here would report a deadline
            // that never happened.
            if (expired) {
              return { answered: false as const, dto: undefined };
            }
            throw error;
          },
        ),
        deadline.then(() => ({ answered: false as const, dto: undefined })),
      ]);

      if (!status.answered) {
        // Nothing was listed, so there is nothing to be selective about: the
        // summary is empty and the reason is logged, otherwise a hung workspace
        // and a clean one read the same in a bug report.
        this.opts.logger.debug('git diff summary stopped at its deadline', {
          workspaceId: input.workspaceId,
          deadlineMs,
          stage: 'status',
          collected: 0,
          requested: 0,
          abandoned: 0,
          failed: 0,
          // Subprocesses still running. At this stage the only one is
          // `git status` itself, and it cannot be cancelled — it keeps
          // running and its answer is dropped when it lands. Reporting
          // `inFlight: 0` here would claim the workspace was quiet while a
          // git process was still out there.
          inFlight: statusInFlight ? 1 : 0,
          // Named on its own, so the reader does not have to work out *which*
          // subprocess the count above refers to.
          statusInFlight,
        });
        return [];
      }

      const paths = [
        ...status.dto.staged.map((e) => e.path),
        ...status.dto.unstaged.map((e) => e.path),
        ...status.dto.untracked,
      ].slice(0, limit);

      type Item = { path: string; patch: string; tokens: number };
      // Indexed rather than pushed: the workers finish out of order and the
      // answer must not.
      const collected: Array<Item | undefined> = new Array<Item | undefined>(paths.length);
      if (paths.length === 0) return [];

      const concurrency = Math.max(
        1,
        Math.min(this.opts.diffConcurrency ?? DEFAULT_DIFF_CONCURRENCY, paths.length),
      );

      let next = 0;
      // How many workers are inside `git.diff` right now. At the deadline this
      // is the number of subprocesses still running, and it is the difference
      // between "the diff was short because there was little to diff" and "the
      // diff was short because git hung".
      let inFlight = 0;
      // Paths whose `git diff` actually returned, whatever it printed. Not the
      // same as `collected`: a binary or empty patch came back in time and was
      // dropped on purpose, and calling that "abandoned" would put a hang and a
      // binary in the same bucket.
      let answered = 0;
      // Paths whose `git diff` failed outright. Counted apart from both the
      // answered and the abandoned paths: a failure is not a hang, and one
      // unreadable file must not be reported as "the summary was truncated".
      let failed = 0;

      const worker = async (): Promise<void> => {
        // `expired` is checked before claiming a path, so the deadline stops new
        // subprocesses rather than merely stopping the waiting.
        while (!expired) {
          const index = next++;
          if (index >= paths.length) return;
          const path = paths[index] as string;
          inFlight += 1;
          try {
            const diff = await this.opts.git.diff({ workspaceRoot: root, path });
            // A diff that lands after the summary was built is dropped: `out`
            // is already a copy of `collected`, so the assignment below lands
            // on a list nobody reads. The deadline line counted this path as
            // abandoned, but a count cannot tell a slow file from a hung one
            // once the summary has returned; `logLateDiff` writes the ending
            // and names the path.
            answered += 1;
            logLateDiff(path, 'answered');
            if (diff.binary || diff.patch.trim() === '') continue;
            collected[index] = {
              path,
              patch: diff.patch,
              tokens: this.opts.estimator.estimate(diff.patch),
            };
          } catch (error) {
            // One path failed: removed between `status` and `diff`, unreadable,
            // or a corrupt index entry. Dropping the whole summary over it
            // would turn one bad file into "this project has no diff", which is
            // a claim about every other file too. The other paths answered, so
            // they stay in the answer; this one is logged and left out.
            failed += 1;
            if (snapshotTaken) {
              // The summary was already answered, so this failure is not a
              // path that was skipped from it — it is an ending for a path
              // the deadline line counted as abandoned.
              logLateDiff(path, 'failed', error);
            } else {
              this.opts.logger.debug('git diff skipped a path that failed', {
                workspaceId: input.workspaceId,
                path,
                error: describeError(error),
              });
            }
          } finally {
            inFlight -= 1;
          }
        }
      };

      await Promise.race([
        Promise.all(Array.from({ length: concurrency }, () => worker())),
        deadline,
      ]);

      // The answer is frozen here. A worker still inside `git diff` can no
      // longer join it; from now on its result is evidence about a subprocess,
      // not part of the summary, and `logLateDiff` says so when it lands.
      snapshotTaken = true;

      const out = collected.filter((item): item is Item => item !== undefined);
      if (expired) {
        // Not an error: the turn gets a smaller `git_diff` than it asked for,
        // and the reason has to be findable, otherwise "the diff was short" and
        // "the diff was empty" read the same in a bug report.
        //
        // The deadline stops the *waiting*, not the subprocesses that already
        // started: a `git diff` in flight keeps running and its result is
        // discarded when it lands. That is deliberate — cancelling would mean
        // an `AbortSignal` threaded through `GitService.diff` — but it has to
        // be visible, so `abandoned` names the paths git never answered for and
        // `inFlight` names how many subprocesses are still out there. Binary and
        // empty patches are not abandoned: they answered, and were dropped for
        // a reason the other two fields already tell.
        //
        // This line is a snapshot and cannot name the paths that answer after
        // it. Their endings are written by `logLateDiff`, with a stage of their
        // own, so `abandoned` here remains what it was measured to be.
        //
        // The fields are arithmetic, not adjectives, and they now close without
        // the reader doing the subtraction:
        //
        //   requested = answered + failed + abandoned
        //   abandoned = neverStarted + inFlight
        //   answered  = collected + droppedEmptyOrBinary
        //
        // `droppedEmptyOrBinary` is its own field because it was the one gap a
        // reader could only fill by computing `answered - collected`: a summary
        // of three items out of five answered paths is either "two were binary"
        // or "two came back empty", and both are fine — but they are not
        // `abandoned`, so leaving the difference implicit invited exactly that
        // misreading. `neverStarted` is clamped at zero so a future change to
        // the worker pool cannot make the log print a negative path count.
        const droppedEmptyOrBinary = answered - out.length;
        this.opts.logger.debug('git diff summary stopped at its deadline', {
          workspaceId: input.workspaceId,
          deadlineMs,
          stage: 'diff',
          collected: out.length,
          requested: paths.length,
          answered,
          droppedEmptyOrBinary,
          abandoned: Math.max(0, paths.length - answered - failed),
          failed,
          neverStarted: Math.max(0, paths.length - answered - failed - inFlight),
          inFlight,
        });
      }
      return out;
    } catch (error) {
      // A workspace that is not a Git repo is normal, not an error: the
      // Context pack simply has no `git_diff` item.
      this.opts.logger.debug('git diff summary unavailable', {
        workspaceId: input.workspaceId,
        error: describeError(error),
      });
      return [];
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
