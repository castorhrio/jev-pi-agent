/**
 * §9 GitService — every Git call in UCAD goes through here; the Renderer never
 * executes Git itself.
 *
 * Security posture:
 *  - argv arrays only, `shell: false` pinned in {@link createGitCli} (§11.1)
 *  - an empty path list is a no-op. `git add --` with no pathspec would stage
 *    the entire worktree, so the guard is not optional
 *  - `discard` destroys work and is treated as high risk
 *  - a non-repository produces one Chinese sentence, never a git stderr dump
 */

import { MAX_EVENT_PAYLOAD_BYTES } from '@ucad/contracts';
import type { GitDiffDto, GitStatusDto } from '@ucad/contracts';
import type { Logger } from '@ucad/observability';
import type { PermissionEngine } from '@ucad/permissions';
import { AppErrorThrow, fail } from './errors';
import { createGitCli } from './git-cli';
import type { GitCli } from './git-cli';
import { EMPTY_HEAD, parsePorcelainStatus, toGitStatusDto } from './porcelain';

export interface GitServiceOptions {
  logger: Logger;
  permissions: PermissionEngine;
  /** Injection seam for tests / a non-default git path. */
  cli?: GitCli;
  gitBinary?: string;
  timeoutMs?: number;
}

export interface GitDiffInput {
  workspaceRoot: string;
  path?: string;
  staged?: boolean;
  signal?: AbortSignal;
}

/**
 * Irreversible shapes (§4.9). `git clean -f` is matched with the flags in any
 * order, so `-fd`, `-df`, `-xfd` and `--force` are all covered.
 */
const HIGH_RISK_PATTERNS: ReadonlyArray<RegExp> = [
  /\bgit\s+reset\b[^\n]*(--hard\b|--merge\b)/i,
  /\bgit\s+clean\b[^\n]*(?:--force\b|-[a-z]*f)/i,
  /\bgit\s+push\b[^\n]*(--force\b|--force-with-lease\b|-f\b)/i,
  /\bgit\s+filter-branch\b/i,
  /\bgit\s+checkout\s+(?:\.\s*$|--\s+\.\s*$)/i,
  /\bgit\s+restore\b[^\n]*\s--worktree\b/i,
];

const BINARY_PATCH = /^(GIT binary patch|Binary files .+ differ)/m;

/** A renderable text hunk; its absence means every change was binary. */
const HUNK_HEADER = /^@@ /m;

export class GitService {
  private readonly logger: Logger;
  private readonly permissions: PermissionEngine;
  private readonly cli: GitCli;
  private readonly timeoutMs: number | undefined;

  constructor(opts: GitServiceOptions) {
    this.logger = opts.logger.child('git');
    this.permissions = opts.permissions;
    this.cli =
      opts.cli ??
      createGitCli({
        logger: opts.logger,
        ...(opts.gitBinary !== undefined ? { binary: opts.gitBinary } : {}),
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      });
    this.timeoutMs = opts.timeoutMs;
  }

  // -------------------------------------------------------------------------
  // read
  // -------------------------------------------------------------------------

  /** §9 `GitStatusDto`. `workspaceId` is context for the log and the audit trail. */
  async status(workspaceId: string, workspaceRoot: string, signal?: AbortSignal): Promise<GitStatusDto> {
    const stdout = await this.run(
      ['status', '--porcelain=v1', '-b', '--untracked-files=all'],
      workspaceRoot,
      signal,
    );
    const parsed = parsePorcelainStatus(stdout);
    const head = await this.head(workspaceRoot, signal);

    this.logger.debug('git status', {
      workspaceId,
      branch: parsed.branch,
      staged: parsed.staged.length,
      unstaged: parsed.unstaged.length,
      untracked: parsed.untracked.length,
    });
    return toGitStatusDto(parsed, head);
  }

  /**
   * `git diff [--staged] [-- <path>]`. NFR-06: a patch over
   * {@link MAX_EVENT_PAYLOAD_BYTES} is cut and flagged; a binary patch is
   * reported as `binary` with an empty patch rather than base64 noise.
   */
  async diff(input: GitDiffInput): Promise<GitDiffDto> {
    // `git diff` is the one Git command that does NOT fail outside a
    // repository: it silently degrades to `--no-index` and exits 0. The
    // explicit probe is what keeps the "该目录不是 Git 仓库" contract true for
    // every method (§9).
    await this.assertRepository(input.workspaceRoot, input.signal);

    const args = ['diff'];
    if (input.staged === true) {
      args.push('--staged');
    }
    if (input.path !== undefined && input.path.length > 0) {
      args.push('--', input.path);
    }

    const patch = await this.run(args, input.workspaceRoot, input.signal);
    const base: GitDiffDto = {
      ...(input.path !== undefined ? { path: input.path } : {}),
      staged: input.staged === true,
      patch: '',
      truncated: false,
      binary: false,
    };

    if (BINARY_PATCH.test(patch) && !HUNK_HEADER.test(patch)) {
      // Only when NOTHING is renderable. A mixed patch (text files plus a
      // staged binary) keeps its hunks, otherwise one .png would blank the
      // whole diff view.
      this.logger.info('git diff is binary', { path: input.path ?? null, staged: base.staged });
      return { ...base, binary: true };
    }

    if (Buffer.byteLength(patch, 'utf8') <= MAX_EVENT_PAYLOAD_BYTES) {
      return { ...base, patch };
    }
    return { ...base, patch: truncateToBytes(patch, MAX_EVENT_PAYLOAD_BYTES), truncated: true };
  }

  // -------------------------------------------------------------------------
  // write (GIT_WRITE — §4.9 asks the user; the IPC layer owns the prompt)
  // -------------------------------------------------------------------------

  async stage(workspaceRoot: string, paths: string[], signal?: AbortSignal): Promise<void> {
    const specs = this.pathspecs(paths);
    if (specs === null) {
      // §9 / §11.1: an empty list must NOT reach `git add --`, which would
      // stage the whole worktree.
      this.logger.debug('stage: empty path list, no-op');
      return;
    }
    await this.run(['add', '--', ...specs], workspaceRoot, signal);
    this.logger.info('git stage', { count: specs.length });
  }

  async unstage(workspaceRoot: string, paths: string[], signal?: AbortSignal): Promise<void> {
    const specs = this.pathspecs(paths);
    if (specs === null) {
      this.logger.debug('unstage: empty path list, no-op');
      return;
    }
    try {
      await this.run(['restore', '--staged', '--', ...specs], workspaceRoot, signal);
    } catch (err) {
      // `git restore` needs >= 2.23; fall back to the porcelain-stable form.
      this.logger.info('git restore unavailable, falling back to git reset', { err: messageOf(err) });
      await this.run(['reset', '--quiet', '--', ...specs], workspaceRoot, signal);
    }
    this.logger.info('git unstage', { count: specs.length });
  }

  /** Destroys uncommitted work — always high risk (§4.9). */
  async discard(workspaceRoot: string, paths: string[], signal?: AbortSignal): Promise<void> {
    const specs = this.pathspecs(paths);
    if (specs === null) {
      this.logger.debug('discard: empty path list, no-op');
      return;
    }
    const command = `git checkout -- ${specs.join(' ')}`;
    const risk = this.permissions.assess({
      category: 'GIT_WRITE',
      command,
      sessionPermissionMode: 'ask',
      workspaceTrusted: true,
    });
    this.logger.warn('git discard (destructive)', { count: specs.length, risk });
    await this.run(['checkout', '--', ...specs], workspaceRoot, signal);
  }

  async commit(workspaceRoot: string, message: string, signal?: AbortSignal): Promise<{ sha: string }> {
    if (typeof message !== 'string' || message.trim().length === 0) {
      throw fail('UNKNOWN', '提交信息不能为空');
    }
    try {
      // The message is one argv element, so a message containing `;`, `&&` or
      // a quote is data, never syntax.
      await this.run(['commit', '-m', message], workspaceRoot, signal);
    } catch (err) {
      // git prints a banner before the reason, so the raw stderr is matched,
      // not the already-sanitised UI message.
      const haystack = err instanceof AppErrorThrow ? `${err.stderr ?? ''}\n${err.message}` : String(err);
      if (/nothing to commit|no changes added|nothing added to commit/i.test(haystack)) {
        throw fail('UNKNOWN', '没有需要提交的更改');
      }
      throw err;
    }
    const sha = await this.head(workspaceRoot, signal);
    this.logger.info('git commit', { sha });
    return { sha };
  }

  // -------------------------------------------------------------------------
  // risk
  // -------------------------------------------------------------------------

  /**
   * §9: pure classification used to decide whether a Git action needs an
   * explicit user prompt. `discard` is always high risk, and so are the
   * irreversible command shapes.
   */
  isHighRisk(command: string): boolean {
    if (typeof command !== 'string' || command.length === 0) {
      return false;
    }
    const text = command.startsWith('git ') ? command : `git ${command}`;
    return HIGH_RISK_PATTERNS.some((re) => re.test(text));
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  private async run(args: readonly string[], cwd: string, signal?: AbortSignal): Promise<string> {
    return this.cli.run(args, {
      cwd,
      ...(signal ? { signal } : {}),
      ...(this.timeoutMs !== undefined ? { timeoutMs: this.timeoutMs } : {}),
    });
  }

  /**
   * A repository with no commits makes `rev-parse HEAD` fail. That is a normal
   * V1 state (a freshly `git init`-ed folder), so it yields
   * {@link EMPTY_HEAD} instead of an error (§9).
   */
  private async head(cwd: string, signal?: AbortSignal): Promise<string> {
    try {
      return (await this.run(['rev-parse', 'HEAD'], cwd, signal)).trim();
    } catch (err) {
      if (err instanceof AppErrorThrow && err.appError.code === 'ADAPTER_NOT_AVAILABLE') {
        throw err;
      }
      this.logger.debug('git rev-parse HEAD failed (probably no commits yet)', {
        reason: messageOf(err),
      });
      return EMPTY_HEAD;
    }
  }

  /** Outside a repository `git rev-parse` exits 128, which the CLI maps. */
  private async assertRepository(cwd: string, signal?: AbortSignal): Promise<void> {
    const inside = await this.run(['rev-parse', '--is-inside-work-tree'], cwd, signal);
    if (inside.trim() !== 'true') {
      throw fail('UNKNOWN', '该目录不是 Git 仓库', { cwd });
    }
  }

  /** null means "no paths" — the caller must no-op rather than run git. */
  private pathspecs(paths: string[]): string[] | null {
    if (!Array.isArray(paths)) {
      throw fail('UNKNOWN', '路径列表无效');
    }
    const specs = paths.filter((p) => typeof p === 'string' && p.length > 0);
    return specs.length === 0 ? null : specs;
  }
}

function truncateToBytes(text: string, maxBytes: number): string {
  const cut = Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8');
  // a split multi-byte sequence leaves one replacement character behind
  return cut.endsWith('\uFFFD') ? cut.slice(0, -1) : cut;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
