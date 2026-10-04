/**
 * §11.1 — the only place that executes Git.
 *
 * HARD RULE: the argument ARRAY is passed to `execFile` and `shell` is pinned to
 * `false`. A path, a commit message or a branch name can therefore never become
 * shell syntax; there is no command string to concatenate into.
 */

import { execFile } from 'node:child_process';
import type { Logger } from '@ucad/observability';
import { AppErrorThrow, errnoOf, fail } from './errors';

/** A `git diff` of a large binary-free change set is still text. */
const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;

/** Git messages are verbose; the UI only needs the first sentence. */
const STDERR_PREVIEW_LIMIT = 200;

export interface GitRunOptions {
  cwd: string;
  timeoutMs?: number;
  maxBufferBytes?: number;
  signal?: AbortSignal;
}

export interface GitCli {
  run(args: readonly string[], opts: GitRunOptions): Promise<string>;
}

export interface GitCliOptions {
  logger: Logger;
  /** Resolved once so a missing Git is one clear message, not a raw ENOENT. */
  binary?: string;
  timeoutMs?: number;
}

const NOT_A_REPO = /not a git repository|does not appear to be a git repository|detected dubious ownership|not a working tree/i;

/**
 * Git prints a human-readable banner before the reason ("On branch main",
 * "Changes not staged for commit:", ...). Those context lines are the worst
 * possible thing to show in a dialog, so they are skipped: a `fatal:` / `error:`
 * line wins, otherwise the first line that is not pure context.
 */
const CONTEXT_PREFIXES: ReadonlyArray<string> = [
  'on branch ',
  'head detached',
  'changes to be committed:',
  'changes not staged for commit:',
  'unmerged paths:',
  'untracked files:',
  'your branch is ahead of',
  'your branch is up to date with',
  'your branch and ',
];

function isContextLine(line: string): boolean {
  const lower = line.toLowerCase();
  return CONTEXT_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/**
 * Git stderr is user-facing only after this treatment: the `fatal:` / `error:`
 * prefixes go away, the text collapses to one line, and it is capped.
 */
export function sanitiseStderr(stderr: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const explicit = lines.find((line) => /^(fatal|error)\s*:/i.test(line));
  const first = explicit ?? lines.find((line) => !isContextLine(line)) ?? lines[0];
  if (first === undefined) {
    return 'Git 未提供错误详情';
  }
  const stripped = first.replace(/^(fatal|error|warning)\s*:\s*/i, '').trim();
  const oneLine = stripped.replace(/\s+/g, ' ');
  return oneLine.length > STDERR_PREVIEW_LIMIT
    ? `${oneLine.slice(0, STDERR_PREVIEW_LIMIT)}…`
    : oneLine || 'Git 未提供错误详情';
}

export function createGitCli(opts: GitCliOptions): GitCli {
  const binary = opts.binary ?? 'git';
  const logger = opts.logger.child('git:cli');

  return {
    run(args: readonly string[], runOpts: GitRunOptions): Promise<string> {
      // `execFile` never builds a shell command line, but the array is copied so
      // a caller cannot mutate it after the fact.
      const argv = [...args];
      const started = Date.now();

      return new Promise<string>((resolve, reject) => {
        execFile(
          binary,
          argv,
          {
            cwd: runOpts.cwd,
            shell: false,
            windowsHide: true,
            encoding: 'utf8',
            maxBuffer: runOpts.maxBufferBytes ?? DEFAULT_MAX_BUFFER,
            timeout: runOpts.timeoutMs ?? opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            ...(runOpts.signal ? { signal: runOpts.signal } : {}),
            env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
          },
          (error, stdout, stderr) => {
            const durationMs = Date.now() - started;
            if (!error) {
              logger.debug('git ok', { args: argv, durationMs });
              resolve(stdout);
              return;
            }

            const err = error as NodeJS.ErrnoException & { code?: number | string };
            const code = err.code;
            const out = typeof stdout === 'string' ? stdout : '';
            const errText = typeof stderr === 'string' ? stderr : '';
            logger.warn('git failed', {
              args: argv,
              durationMs,
              exitCode: typeof code === 'number' ? code : null,
              errno: typeof code === 'string' ? code : null,
              stderr: errText.slice(0, 2000),
            });

            if (code === 'ENOENT' || errnoOf(error) === 'ENOENT') {
              reject(
                fail('ADAPTER_NOT_AVAILABLE', '未找到 Git，请确认已安装 Git 并已加入 PATH', {
                  binary,
                }),
              );
              return;
            }
            if (typeof code === 'number' && code === 128 && NOT_A_REPO.test(errText)) {
              reject(fail('UNKNOWN', '该目录不是 Git 仓库', { cwd: runOpts.cwd }));
              return;
            }
            reject(
              new AppErrorThrow(
                fail('UNKNOWN', `Git 执行失败：${sanitiseStderr(errText || out)}`, {
                  args: argv,
                  exitCode: typeof code === 'number' ? code : null,
                }).appError,
                // the full text stays available for pattern matching, but only
                // the sanitised line is ever shown to the user
                errText,
              ),
            );
          },
        );
      });
    },
  };
}
