/**
 * Working-directory containment for the shells this package spawns.
 *
 * `path.relative` compares strings, so a junction planted inside an untrusted
 * workspace (`link -> C:\Users`) passes a lexical check while the shell's
 * actual working directory sits outside it. Both sides are resolved to their
 * real paths before comparing, so the boundary holds on where the directory
 * *is*, not on what it is called.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fail } from './errors';

/**
 * Resolve `cwdInput` against the workspace root, resolve both to their real
 * paths, and refuse anything that lands outside. Returns the real cwd the
 * child should be spawned in.
 */
export function containCwdToRoot(workspaceRoot: string, cwdInput: string): string {
  if (typeof cwdInput !== 'string' || cwdInput.length === 0) {
    throw fail('UNKNOWN', '终端工作目录无效');
  }
  if (typeof workspaceRoot !== 'string' || workspaceRoot.trim().length === 0) {
    throw fail('UNKNOWN', '工作区路径无效');
  }
  const root = realpath(path.resolve(workspaceRoot));
  const cwd = realpath(path.resolve(root, cwdInput));
  const relative = path.relative(root, cwd);
  if (!(relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)))) {
    throw fail('PERMISSION_DENIED', '该目录不在当前工作区内', { path: cwd });
  }
  return cwd;
}

function realpath(p: string): string {
  try {
    // The JS implementation, not `.native`: the native one can surface
    // `\\?\`-prefixed paths on Windows, which would silently break the
    // comparison and the child's cwd.
    return fs.realpathSync(p);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw fail('UNKNOWN', '该目录不存在');
    }
    throw err;
  }
}
