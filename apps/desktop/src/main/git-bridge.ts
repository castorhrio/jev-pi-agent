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
}

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

      const out: Array<{ path: string; patch: string; tokens: number }> = [];
      for (const path of paths) {
        const diff = await this.opts.git.diff({ workspaceRoot: root, path });
        if (diff.binary || diff.patch.trim() === '') continue;
        const tokens = this.opts.estimator.estimate(diff.patch);
        out.push({ path, patch: diff.patch, tokens });
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
