/**
 * The one precondition every suite on this machine shares: a temp directory
 * with headroom.
 *
 * ## Why this is a gate and not a retry
 *
 * `tests/contract/*.test.ts` create throwaway trees with `mkdtempSync(tmpdir())`
 * — a fake git repo, a synthetic screenshot manifest, a Chromium profile for the
 * layout gate. On a box whose `/tmp` is a quota'd tmpfs that has run out of
 * blocks, every one of those writes fails, and what a person sees is a suite
 * that reports dozens of broken files with `Unknown system error -122, write`.
 * That message names no directory, no limit and no fix, so the next thing they
 * do is re-run it, then suspect the tree, then bisect a defect that lives in the
 * machine.
 *
 * The incident this replaced, measured rather than remembered: `/tmp` here is
 * `tmpfs … usrquota`, and the user's quota had between 64 KiB and 256 KiB of
 * blocks left. `df` still reported 348M free, because `df` reads the filesystem
 * and the quota reads the user. Eight contract cases across two files went red
 * on a green HEAD over exactly that gap.
 *
 * So the check is one write, before anything is judged, and it *refuses* rather
 * than warns: a run that continues past a temp directory with no headroom
 * produces failures that read like product failures, which is the defect class
 * this repository has named repeatedly — a green or red line about something
 * that was never measured.
 *
 * ## Why the probe writes bytes instead of creating a file
 *
 * A zero-byte create succeeds on a filesystem with inodes left and no blocks,
 * which is the state a full tmpfs is in. The probe therefore allocates real
 * blocks. It does **not** claim the run will fit: it says "this directory took
 * 1 MiB just now", which is the strongest statement that costs nothing. Whether
 * the Chromium profile fits is decided by the run, loudly, in the right files.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * How much the probe allocates.
 *
 * 1 MiB is the smallest number that separates "a quota with room" from "a quota
 * with a few blocks left", which is the state that produced the false red above
 * (64 KiB passed there, 256 KiB did not). It is also cheap enough to run before
 * every gate invocation without anyone being tempted to skip it.
 */
export const PROBE_BYTES = 1024 * 1024;

/**
 * Directories offered as `TMPDIR` when the default one has no headroom.
 *
 * Ordered by how likely each is to be on a different quota than `/tmp`:
 * `/var/tmp` is a separate mount on most distributions and is not wiped between
 * boots; `~/.cache` is on the user's own disk. `/tmp` is not listed — it is what
 * `os.tmpdir()` already returned, and offering it back would be noise.
 */
export const TMPDIR_CANDIDATES = ['/var/tmp', '~/.cache/ucad-tmp'];

/** Writes `bytes` into `dir`, and returns how it failed, or null. */
function writeFailure(dir, bytes) {
  let target;
  try {
    target = path.join(dir, `ucad-tmp-probe-${process.pid}.bin`);
    fs.writeFileSync(target, bytes);
    return null;
  } catch (error) {
    /*
     * Node has no name for errno -122, so a quota'd tmpfs reports `UNKNOWN` and
     * the reader loses the one number that says EDQUOT — the original false red
     * was `Unknown system error -122, write`, and that is why the number is
     * carried through instead of the name alone.
     */
    const code = error?.code ?? 'UNKNOWN';
    const errno = Number.isFinite(error?.errno) ? ` (errno ${error.errno})` : '';
    return `${code}${errno}`;
  } finally {
    // `force` only swallows ENOENT: under a path whose parent is a file this
    // removal throws ENOTDIR, and a cleanup error replacing the write's errno
    // would send the reader after the wrong thing.
    try {
      if (target !== undefined) fs.rmSync(target, { force: true });
    } catch {
      /* nothing removable was ever created */
    }
  }
}

/**
 * Expands a leading `~` to the user's home directory.
 *
 * The candidate list is written the way a person would type it, and a literal
 * `~/.cache` path is not a thing anyone means: resolved as a relative path it
 * creates a directory called `~` wherever the process happens to be standing.
 */
export function expandHome(dir) {
  if (dir === '~') return os.homedir();
  if (dir.startsWith('~/')) return path.join(os.homedir(), dir.slice(2));
  return dir;
}

/**
 * Whether `dir` can hold `PROBE_BYTES` of new data, creating it if absent.
 *
 * Exported because the suggestion in the message has to be a directory that
 * passed this same write — offering an unprobed path would send the reader into
 * a second failure, which is worse than offering none.
 */
export function isTempDirWritable(dir) {
  const expanded = expandHome(dir);
  try {
    fs.mkdirSync(expanded, { recursive: true });
  } catch {
    return false;
  }
  return writeFailure(expanded, randomBytes(PROBE_BYTES)) === null;
}

/**
 * The first {@link TMPDIR_CANDIDATES} entry that took the probe write, or null.
 *
 * Probed, not assumed: this is the value the caller puts in the command line it
 * tells a person to type.
 */
export function usableTempDir() {
  return TMPDIR_CANDIDATES.find((candidate) => isTempDirWritable(candidate)) ?? null;
}

/**
 * What is wrong with the temp directory, in one sentence a person can act on.
 *
 * Returns `null` when there is nothing wrong, so each caller decides how loud a
 * problem is — the gate refuses, the suite's setup throws — and this file does
 * not get to choose the voice.
 */
export function tempDirProblem(dir = os.tmpdir()) {
  const code = writeFailure(dir, randomBytes(PROBE_BYTES));
  if (code === null) return null;

  const megabytes = PROBE_BYTES / (1024 * 1024);
  return (
    `${dir} is not usable: allocating ${megabytes} MiB there failed with ${code}. ` +
    'The contract and E2E suites create their throwaway trees and the layout ' +
    "gate's Chromium profile under os.tmpdir(), so a temp directory without headroom " +
    'turns dozens of unrelated files red at once over an errno that names no product ' +
    'defect. This is the machine, not the tree.'
  );
}
