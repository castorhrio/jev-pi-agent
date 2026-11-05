/**
 * The temp-directory probe: one precondition the whole suite shares, judged on
 * its own rather than only through the gate that calls it.
 *
 * ## Why this file exists
 *
 * `npm test` on this machine went red across 8 cases in 2 files with
 * `Unknown system error -122, write` — `EDQUOT`, from a quota'd tmpfs `/tmp`.
 * The HEAD was green, the code was untouched, and nothing in the transcript
 * said a word about the filesystem. The next reader's options were "re-run it"
 * and "bisect a defect that does not exist".
 *
 * `scripts/temp-dir-probe.mjs` is the fix, and `ci-gate-local.test.ts` already
 * covers the gate's half (refuse, name the directory, run no step). What lives
 * here is the half a subprocess cannot reach: the message's *suggestion*, which
 * has to be a directory that actually took the same write, and the two branches
 * that decide whether the reader gets a command to type or a sentence about
 * quota and free space. A suggestion that does not work is worse than none — it
 * is the run failing twice.
 */

import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  expandHome,
  PROBE_BYTES,
  TMPDIR_CANDIDATES,
  isTempDirWritable,
  tempDirProblem,
  usableTempDir,
} from '../../scripts/temp-dir-probe.mjs';

const cleanup: string[] = [];

afterEach(() => {
  while (cleanup.length > 0) {
    const dir = cleanup.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'ucad-temp-probe-'));
  cleanup.push(root);
  return root;
}

/** A path that cannot hold a write: a regular file where a directory is named. */
function unwritable(root: string): string {
  const file = join(root, 'not-a-directory');
  writeFileSync(file, 'a path that resolves, but is not a directory\n', 'utf8');
  return file;
}

describe('the temp directory probe', () => {
  it('says nothing is wrong with a directory that took the write', () => {
    expect(tempDirProblem(scratch()), 'a writable directory must not be a problem').toBeNull();
    // The suite's own default: if this is not null, every case below is
    // refusing for the reason the probe exists to name, and the run is telling
    // the truth about the machine rather than about this file.
    expect(tempDirProblem(), `os.tmpdir() (${tmpdir()}) is not writable on this box`).toBeNull();
  });

  it('leaves no probe file behind', () => {
    const root = scratch();
    const before = readdirSync(root);
    expect(tempDirProblem(root)).toBeNull();
    expect(readdirSync(root), 'the probe wrote into the directory and did not clean up').toEqual(
      before,
    );
  });

  it('names the directory, the errno and the size it tried to allocate', () => {
    const root = scratch();
    const dead = unwritable(root);
    const problem = tempDirProblem(dead);
    expect(problem, 'a path that is not a directory must be a problem').not.toBeNull();
    expect(problem).toContain(dead);
    expect(problem).toContain('is not usable');
    expect(problem).toContain(`${PROBE_BYTES / (1024 * 1024)} MiB`);
    // The errno is the part a reader acts on: "Unknown system error -122" is
    // what sent the last round looking for a code defect, and Node has no name
    // for -122 — so the number has to travel with the name, not instead of it.
    expect(problem, problem!).toMatch(/ENOSPC|EDQUOT|ENOTDIR|EACCES|EPERM|UNKNOWN/);
    expect(problem, problem!).toContain('errno -');
    // This is the strongest claim the probe is allowed to make. It measured one
    // allocation, not the size of the run, so it must not read as a promise
    // that the suite would have fitted.
    expect(problem, problem!).not.toMatch(/will (?:be enough|fit)/);
  });

  it('offers a fallback only after the same write passed there', () => {
    /*
     * The value the callers put into the command line they tell a person to
     * type. An unprobed suggestion is the run failing twice, so what comes back
     * has to be one of the known candidates and has to take the probe right
     * now — and when nothing takes it, the answer is null rather than the least
     * bad of a set of broken paths.
     */
    const usable = usableTempDir();
    if (usable === null) {
      expect(
        TMPDIR_CANDIDATES.every((candidate) => !isTempDirWritable(candidate)),
        'usableTempDir() said no, but a candidate is writable',
      ).toBe(true);
      return;
    }
    expect(TMPDIR_CANDIDATES).toContain(usable);
    expect(isTempDirWritable(usable)).toBe(true);
  });

  it('allocates real blocks, because an inode is not the limit that bites', () => {
    // A zero-byte create succeeds on a filesystem with inodes left and no
    // blocks, which is the state a full tmpfs is in. The size here is the whole
    // design: 64 KiB passed over the machine whose quota this probe exists for,
    // and 256 KiB did not.
    expect(PROBE_BYTES).toBeGreaterThanOrEqual(1024 * 1024);
    expect(isTempDirWritable(scratch())).toBe(true);
  });

  it('expands a ~ candidate instead of making a literal "~" directory', () => {
    // The candidate list is written the way a person types it. Resolved
    // relatively, `~/.cache/ucad-tmp` would create a directory called `~`
    // wherever the process happens to be standing — including inside this
    // repository — and then report that it is writable.
    expect(expandHome('~/.cache/ucad-tmp')).toBe(join(homedir(), '.cache', 'ucad-tmp'));
    expect(expandHome('~')).toBe(homedir());
    expect(expandHome('/var/tmp')).toBe('/var/tmp');
    expect(expandHome('relative/still')).toBe('relative/still');
  });

  it('refuses a path whose parent is a file, rather than mkdir-ing into it', () => {
    const root = scratch();
    expect(isTempDirWritable(join(unwritable(root), 'child'))).toBe(false);
  });
});
