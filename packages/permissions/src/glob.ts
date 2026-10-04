/**
 * §4.9 `PermissionRule.matcher` evaluation: `prefix`, `glob`, `exact`.
 *
 * V1 ships its own matcher — no dependency is added (brief constraint) and no
 * vendor matcher may leak into a cross-package signature (§0).
 *
 * Determinism: no clock, no randomness, no I/O. Matching is case-insensitive
 * because `resource` values are canonicalized filesystem paths (§7.2, Windows
 * paths are case-insensitive) and `command` values are shell text whose casing
 * carries no meaning for an allow/deny decision.
 */

import type { PermissionRule } from '@ucad/contracts';

export type PermissionMatcher = PermissionRule['matcher'];

/**
 * Wildcard match supporting `*` (any run of characters, separators included) and
 * `?` (exactly one character). `**` therefore behaves like `*`; there is no
 * segment-boundary semantics in V1.
 *
 * Iterative backtracking: linear in the common case, O(n·m) worst case, and it
 * never builds a RegExp from user input.
 */
export function globMatch(pattern: string, value: string, caseInsensitive = true): boolean {
  const p = caseInsensitive ? pattern.toLowerCase() : pattern;
  const v = caseInsensitive ? value.toLowerCase() : value;

  let pi = 0;
  let vi = 0;
  let star = -1;
  let mark = 0;

  while (vi < v.length) {
    const pc = pi < p.length ? p[pi] : undefined;
    const vc = v[vi];
    if (pc !== undefined && (pc === '?' || pc === vc)) {
      pi += 1;
      vi += 1;
    } else if (pc === '*') {
      star = pi;
      mark = vi;
      pi += 1;
    } else if (star >= 0) {
      pi = star + 1;
      mark += 1;
      vi = mark;
    } else {
      return false;
    }
  }

  while (pi < p.length && p[pi] === '*') {
    pi += 1;
  }
  return pi === p.length;
}

/** Evaluate one matcher against one subject string. */
export function matchPermissionTarget(matcher: PermissionMatcher, subject: string): boolean {
  const value = matcher.value ?? '';
  if (value === '') {
    return false;
  }
  switch (matcher.kind) {
    case 'exact':
      return value.toLowerCase() === subject.toLowerCase();
    case 'prefix':
      return subject.toLowerCase().startsWith(value.toLowerCase());
    case 'glob':
      return globMatch(value, subject);
    default:
      return false;
  }
}
