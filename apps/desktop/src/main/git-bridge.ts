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

    /**
     * Records a `git status` that answered after the deadline.
     *
     * The deadline log below says `statusInFlight: true`, and that is true
     * *at that moment*: the subprocess is still out there and cannot be
     * cancelled. It is a snapshot, and a snapshot has no ending — so without
     * this line a reader could not tell whether the git process finished a
     * moment later or is still hanging, and the two call for different
     * reactions (wait it out vs. go and kill the workspace).
     *
     * The answer itself changes nothing: the summary was already returned
     * empty, and no `git diff` is spawned for a path nobody listed. What
     * changes is that the answer is now *on the record* as dropped, rather
     * than landing on nothing and disappearing.
     *
     * `expired` is the test for "too late" rather than a separate timer: it
     * is already the flag the workers stop on, so there is one clock and one
     * answer to "is it still in time".
     *
     * The `stage` is `'status-late'`, not `'status'`. Both lines are about the
     * same subprocess, and sharing the stage name made them the same *kind* of
     * line as far as anything machine-readable is concerned: a support report
     * could only tell them apart by the event string, and a report that counts
     * `stage: 'status'` occurrences counted one hung `git status` twice. The
     * deadline line is the snapshot of a summary that gave up; this one is the
     * same subprocess arriving afterwards, and the two call for different
     * readings.
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
        collected: 0,
        requested: 0,
        abandoned: 0,
        failed: 0,
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
            // A diff that lands after the deadline is counted here and dropped
            // there. The deadline line is a snapshot taken at the deadline, and
            // it already accounts for this path — as `inFlight` while it was
            // running, as `abandoned` afterwards. No second line is written
            // for it: the arithmetic (`requested = answered + failed +
            // abandoned`) already says what became of every path, and a
            // per-path line would only restate it.
            //
            // The one late answer that does get a line of its own is
            // `git status` (see `logLateStatus`), because there the deadline
            // line carries a *subprocess* count and the reader cannot tell
            // from it whether that process is still hanging.
            answered += 1;
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
            this.opts.logger.debug('git diff skipped a path that failed', {
              workspaceId: input.workspaceId,
              path,
              error: describeError(error),
            });
          } finally {
            inFlight -= 1;
          }
        }
      };

      await Promise.race([
        Promise.all(Array.from({ length: concurrency }, () => worker())),
        deadline,
      ]);

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
