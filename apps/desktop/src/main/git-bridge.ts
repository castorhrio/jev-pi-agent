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
  /** whole-summary budget in ms; the remainder is reported and logged (default 2000) */
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
 * A `git diff` that hangs (a stale index lock, a network drive) must not hold
 * the turn open until the app is closed. Two seconds is well past a normal
 * summary and short enough that a person notices nothing but the answer being
 * smaller than expected. What came back in time is used; what did not is
 * logged, not silently invented.
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
   */
  async diffSummary(input: {
    workspaceId: string;
    limit?: number;
  }): Promise<Array<{ path: string; patch: string; tokens: number }>> {
    const root = this.opts.resolveRoot(input.workspaceId);
    const limit = input.limit ?? 10;
    try {
      const dto = await this.opts.git.status(input.workspaceId, root);
      const paths = [
        ...dto.staged.map((e) => e.path),
        ...dto.unstaged.map((e) => e.path),
        ...dto.untracked,
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
      const deadlineMs = this.opts.diffDeadlineMs ?? DEFAULT_DIFF_DEADLINE_MS;

      let next = 0;
      let expired = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          expired = true;
          resolve();
        }, deadlineMs);
      });

      const worker = async (): Promise<void> => {
        // `expired` is checked before claiming a path, so the deadline stops new
        // subprocesses rather than merely stopping the waiting.
        while (!expired) {
          const index = next++;
          if (index >= paths.length) return;
          const path = paths[index] as string;
          const diff = await this.opts.git.diff({ workspaceRoot: root, path });
          if (diff.binary || diff.patch.trim() === '') continue;
          collected[index] = {
            path,
            patch: diff.patch,
            tokens: this.opts.estimator.estimate(diff.patch),
          };
        }
      };

      try {
        await Promise.race([
          Promise.all(Array.from({ length: concurrency }, () => worker())),
          deadline,
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }

      const out = collected.filter((item): item is Item => item !== undefined);
      if (expired) {
        // Not an error: the turn gets a smaller `git_diff` than it asked for,
        // and the reason has to be findable, otherwise "the diff was short" and
        // "the diff was empty" read the same in a bug report.
        this.opts.logger.debug('git diff summary stopped at its deadline', {
          workspaceId: input.workspaceId,
          deadlineMs,
          collected: out.length,
          requested: paths.length,
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
    }
  }
}
