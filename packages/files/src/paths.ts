/**
 * §7.2 path rules — the only place in UCAD that decides whether a path is
 * inside the workspace.
 *
 * Order is fixed and must stay this way:
 *   1. `path.resolve(workspaceRoot, input)` removes `..` segments
 *   2. `fs.realpathSync` (native) resolves symlinks, junctions and Windows 8.3
 *      short names
 *   3. the result is compared with the realpath'd workspace root, case
 *      insensitively on Windows
 *   4. outside => `{ external: true }`; the CALLER decides, which becomes an
 *      `EXTERNAL_PATH` permission prompt (§4.9). This function never throws for
 *      an out-of-workspace path.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { errnoOf, fail } from './errors';

export interface CanonicalPath {
  /** Absolute, symlink-resolved path (the value sent to the Permission Engine). */
  path: string;
  /** True when the path leaves the workspace after step 2. */
  external: boolean;
}

const IS_WINDOWS = process.platform === 'win32';

/** Bounds the "nearest existing ancestor" walk against a pathological tree. */
const MAX_ANCESTOR_WALK = 64;

/** Windows `\\?\` (and `\\?\UNC\`) prefixed paths must compare like normal ones. */
function stripNamespace(input: string): string {
  if (!input.startsWith('\\\\?\\')) {
    return input;
  }
  const rest = input.slice(4);
  return rest.startsWith('UNC\\') ? `\\\\${rest.slice(4)}` : rest;
}

/** Comparison form: resolved, separator-normalised, case-folded on Windows. */
function compareKey(input: string): string {
  const resolved = path.resolve(stripNamespace(input));
  return IS_WINDOWS ? resolved.toLowerCase() : resolved;
}

function realpathSyncSafe(target: string): string | null {
  try {
    // `native` is libuv's uv_fs_realpath, which on Windows expands 8.3 short
    // names (PROGRA~1) and follows junctions; the JS fallback does not.
    return typeof fs.realpathSync.native === 'function'
      ? fs.realpathSync.native(target)
      : fs.realpathSync(target);
  } catch (err) {
    // ENOENT / ENOTDIR simply mean "does not exist yet" — that is the write-to-
    // a-new-file case. Any other errno (EACCES, ELOOP, ...) also degrades to
    // "unresolved": the containment check then falls back to `path.resolve`,
    // which is strictly more conservative than trusting a symlink.
    void errnoOf(err);
    return null;
  }
}

/**
 * realpath of `target`, or of its nearest existing ancestor with the missing
 * tail appended. Creating `workspace/new/file.ts` therefore still resolves
 * inside the workspace instead of being mistaken for an external path (§7.2).
 */
export function realpathBestEffort(target: string): string {
  let current = path.resolve(target);
  const tail: string[] = [];

  for (let step = 0; step <= MAX_ANCESTOR_WALK; step += 1) {
    const real = realpathSyncSafe(current);
    if (real !== null) {
      return tail.length === 0 ? stripNamespace(real) : path.join(real, ...tail.reverse());
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    tail.push(path.basename(current));
    current = parent;
  }
  return path.resolve(target);
}

/** `root` itself, or a real descendant of it. Sibling prefixes (`C:\ws2`) are NOT inside. */
export function isInside(root: string, target: string): boolean {
  const rootKey = compareKey(root);
  const targetKey = compareKey(target);
  if (targetKey === rootKey) {
    return true;
  }
  return targetKey.startsWith(rootKey.endsWith(path.sep) ? rootKey : rootKey + path.sep);
}

/**
 * §7.2 canonicalization. `input` must be a non-empty string without a NUL byte;
 * anything else is rejected instead of being coerced.
 */
export function canonicalize(workspaceRoot: string, input: unknown): CanonicalPath {
  if (typeof workspaceRoot !== 'string' || workspaceRoot.trim().length === 0) {
    throw fail('PERMISSION_DENIED', '工作区路径无效');
  }
  if (typeof input !== 'string' || input.length === 0 || input.includes('\0')) {
    throw fail('PERMISSION_DENIED', '路径无效');
  }

  // Resolved against the *realpath'd* root so a short-name root (or a root that
  // is itself reached through a junction) compares against the same form.
  const rootReal = realpathBestEffort(workspaceRoot);
  const target = realpathBestEffort(path.resolve(rootReal, input));
  return { path: target, external: !isInside(rootReal, target) };
}
