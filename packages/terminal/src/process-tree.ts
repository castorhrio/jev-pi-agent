/**
 * Process-tree termination.
 *
 * §11.1: killing a process must kill what it started. `child.kill()` on Windows
 * only signals the direct child, so `npm`, `node` or any tool that itself
 * spawns helpers leaves orphans behind that keep writing to the workspace after
 * the user pressed stop. `taskkill /T /F` walks the tree.
 */

import { execFile } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type { Logger } from '@ucad/observability';
import { errnoOf } from './errors';

const IS_WINDOWS = process.platform === 'win32';
const TASKKILL_TIMEOUT_MS = 10_000;

export function runTaskkill(pid: number): Promise<void> {
  return new Promise<void>((resolve) => {
    // argv array + shell:false — the pid is a number, but the rule stands here
    // too so this file can never become the place a shell string is built.
    execFile(
      'taskkill',
      ['/pid', String(pid), '/T', '/F'],
      { shell: false, windowsHide: true, timeout: TASKKILL_TIMEOUT_MS },
      (error) => {
        // ESRCH (already gone) is success for our purposes.
        void error;
        resolve();
      },
    );
  });
}

/**
 * Best-effort kill of a child and everything it spawned. Never rejects: a
 * failure here must not mask the original error path.
 */
export async function killProcessTree(
  child: ChildProcess,
  logger: Logger,
  reason: string,
): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) {
    return;
  }
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  if (IS_WINDOWS) {
    logger.info('killing process tree', { pid, reason });
    await runTaskkill(pid);
    return;
  }

  // POSIX: the group kill needs the child to be a group leader; when it is not,
  // fall back to signalling the child itself.
  try {
    process.kill(-pid, 'SIGKILL');
    logger.info('killed process group', { pid, reason });
    return;
  } catch (err) {
    logger.debug('process group kill unavailable', { pid, errno: errnoOf(err) ?? 'unknown' });
  }
  try {
    child.kill('SIGKILL');
  } catch {
    /* the process is already gone */
  }
}
