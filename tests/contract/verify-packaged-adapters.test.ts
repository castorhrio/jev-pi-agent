/**
 * The packaged adapter check, judged without packaging anything.
 *
 * ## Why this file exists
 *
 * `scripts/verify-packaged-adapters.mjs` is the one step no CI job can take:
 * reading an adapter from *inside* a real `.asar` archive needs Electron's
 * patched `fs`, so the check launches a build that `npm run package` wrote. The
 * READMEs and `adapter-resolution.ts` all say "verified by hand" — which was,
 * until this script, an instruction to read a line in a terminal.
 *
 * An instruction is not a check: `adapters resolved: (none)` is a passing-looking
 * string, the line goes to stderr on Windows where a double-clicked build has no
 * console, and "I looked and it seemed fine" is the honest description of what
 * the manual step actually verified. So the judgement moved into pure functions
 * over the captured output, and this file pins them:
 *
 *  - the summary line is parsed, and `(none)` is *not* parsed as success;
 *  - a build that never reached resolution is reported as that, not as
 *    "no adapters" — the two send a reader to different places;
 *  - the executable to launch is looked for where `electron-builder` actually
 *    writes it, per platform; and
 *  - a missing build names the command that produces one.
 *
 * The launch itself is the only part not covered here, by construction: it needs
 * a packaged app. That is the same boundary the README states, and the last
 * case below keeps the statement discoverable — CONTRIBUTING has to name the
 * command, or the reader is back to "read the line yourself".
 */

import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findPackagedExecutable,
  packagedExecutables,
  resolvedAdapterIds,
  tailOf,
  verifyResolution,
} from '../../scripts/verify-packaged-adapters.mjs';

const here = import.meta.dirname;
const REPO_ROOT = join(here, '..', '..');

/** What a packaged launch prints around the line, on stderr, in one stream. */
const HEALTHY_OUTPUT = [
  'Checking for update using Github',
  '[ucad] adapters resolved: universal, mock',
  '[ucad] update feed resolved',
  '',
].join('\n');

describe('the summary line a packaged build prints', () => {
  it('reads the adapter ids, ignoring the lines around them', () => {
    expect(resolvedAdapterIds(HEALTHY_OUTPUT)).toEqual(['universal', 'mock']);
  });

  it('reports `(none)` as an empty list, not as a resolved adapter called `(none)`', () => {
    // The string that made the manual step weak: it contains
    // "adapters resolved:" and is printed by a completely broken build.
    expect(resolvedAdapterIds('[ucad] adapters resolved: (none)\n')).toEqual([]);
  });

  it('returns null when there is no line at all', () => {
    // Distinct from `[]` on purpose: a launch that never reached resolution has
    // a different cause (and a different fix) from one that resolved nothing.
    expect(resolvedAdapterIds('Error: Cannot open display\n')).toBeNull();
    // A line that merely mentions resolution is not the summary line.
    expect(resolvedAdapterIds('adapters resolved: universal\n')).toBeNull();
  });
});

describe('the verdict on a packaged launch', () => {
  it('passes when the build resolved the adapter that can do work', () => {
    expect(verifyResolution(HEALTHY_OUTPUT)).toEqual([]);
  });

  it('fails a build that resolved nothing, and says which state it is in', () => {
    const problems = verifyResolution('[ucad] adapters resolved: (none)\n');
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain('resolved no adapter at all');
    expect(problems[1]).toContain('"universal"');
  });

  it('fails a build that resolved something else but not the required adapter', () => {
    const problems = verifyResolution('[ucad] adapters resolved: mock\n');
    expect(problems).toHaveLength(1);
    // Both sides of the sentence: what was missing, and what was there — a
    // reader can tell "the table changed" from "the build is empty".
    expect(problems[0]).toContain('did not resolve "universal"');
    expect(problems[0]).toContain('"mock"');
  });

  it('fails a build that never printed the line, without calling it "no adapters"', () => {
    const problems = verifyResolution('Error: Cannot open display\n');
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('printed no `[ucad] adapters resolved:` line');
    expect(problems[0]).not.toContain('resolved no adapter at all');
  });

  it('takes the required adapters from the caller, so the check is not hard-coded', () => {
    expect(verifyResolution(HEALTHY_OUTPUT, { required: ['mock'] })).toEqual([]);
    expect(verifyResolution(HEALTHY_OUTPUT, { required: ['nobody-ships'] })).toHaveLength(1);
  });
});

describe('the build that gets launched', () => {
  it('looks in the unpacked directory each platform writes', () => {
    const releaseDir = join('/tmp', 'release');
    expect(packagedExecutables({ platform: 'win32', releaseDir })).toEqual([
      join(releaseDir, 'win-unpacked', 'UCAD.exe'),
    ]);
    expect(packagedExecutables({ platform: 'darwin', releaseDir })[0]).toBe(
      join(releaseDir, 'mac', 'UCAD.app', 'Contents', 'MacOS', 'UCAD'),
    );
    // Linux names the binary after `package.json#name`, which is lowercased —
    // launching `UCAD` there would fail on a case-sensitive filesystem.
    expect(packagedExecutables({ platform: 'linux', releaseDir })[0]).toBe(
      join(releaseDir, 'linux-unpacked', 'ucad'),
    );
  });

  it('finds the build once it exists, and reports nothing when it does not', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'ucad-packaged-check-'));
    try {
      const releaseDir = join(tempRoot, 'release');
      expect(findPackagedExecutable({ platform: 'linux', releaseDir })).toBeUndefined();

      const executable = join(releaseDir, 'linux-unpacked', 'ucad');
      mkdirSync(join(releaseDir, 'linux-unpacked'), { recursive: true });
      writeFileSync(executable, '#!/bin/sh\n');
      expect(findPackagedExecutable({ platform: 'linux', releaseDir })).toBe(executable);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

describe('the failure message a terminal sees', () => {
  it('keeps the tail of a long launch, which is where the reason is', () => {
    const output = Array.from({ length: 60 }, (_, index) => `line ${index + 1}`).join('\n');
    const tail = tailOf(output, 3);
    expect(tail.split('\n')).toEqual(['line 58', 'line 59', 'line 60']);
  });

  it('drops blank lines, so the tail is not empty whitespace', () => {
    expect(tailOf('first\n\n\nlast\n\n', 2)).toBe('first\nlast');
  });
});

describe('the manual step is discoverable as a command', () => {
  it('is named in CONTRIBUTING, next to the packaging command it depends on', () => {
    const contributing = readFileSync(join(REPO_ROOT, 'CONTRIBUTING.md'), 'utf8');
    const index = contributing.indexOf('scripts/verify-packaged-adapters.mjs');
    expect(index, 'CONTRIBUTING.md no longer names the packaged adapter check').toBeGreaterThan(-1);
    // The precondition and the command in the same breath: the script refuses to
    // run without a build, so the instructions have to say where one comes from.
    expect(contributing.slice(index - 400, index + 400)).toContain('npm run package');
  });

  it('is not claimed to run in CI, which still has no packaging job', () => {
    // The same claim `adapter-resolution.test.ts` keeps for the README bullets.
    // If a packaging job appears, the honest sentence changes with it — this
    // case exists so the change is made on purpose.
    const workflow = readFileSync(join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
    expect(/\bnpm run package\b|\belectron-builder\b/u.test(workflow)).toBe(false);
    expect(existsSync(join(REPO_ROOT, 'scripts', 'verify-packaged-adapters.mjs'))).toBe(true);
  });
});
