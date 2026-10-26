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
 * The launch used to be the one part not covered here, because it needs a
 * packaged app. It now takes its `spawn` as a parameter, so a fake child drives
 * every path that decides the outcome — the summary line arriving (split across
 * chunks), the timeout, a launch error, an early exit, and the stop that follows
 * each of them — including the `SIGKILL` fallback without which a wedged build
 * is left running as an orphan. What remains manual is running the real
 * artifact; the last cases keep THAT statement discoverable, since CONTRIBUTING
 * has to name the command or the reader is back to "read the line yourself".
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  RELEASE_DIR,
  findPackagedExecutable,
  launch,
  packagedExecutables,
  parseArgs,
  releaseDirFrom,
  resolvedAdapterIds,
  stop,
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

/**
 * A stand-in for `ChildProcess`, with the shape `launch`/`stop` actually touch.
 *
 * Nothing here spawns anything: `stdout`/`stderr` are emitters the test pushes
 * chunks into, and `kill` records the signals instead of delivering them. That
 * is enough to assert *when* a run finishes and *what* it was killed with, which
 * is exactly what a real launch makes impossible to observe.
 */
class FakeChild extends EventEmitter {
  pid: number | undefined = 4242;
  exitCode: number | null = null;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  signals: Array<string | undefined> = [];
  kill = vi.fn((signal?: string) => {
    this.signals.push(signal);
    return true;
  });

  /** The app prints a chunk on the diagnostic channel it uses in practice. */
  say(text: string): void {
    this.stderr.emit('data', Buffer.from(text));
  }
}

describe('the flags the command reads', () => {
  it('takes the value that follows a flag', () => {
    expect(parseArgs(['--require', 'universal,mock'])).toEqual({ require: 'universal,mock' });
    expect(parseArgs(['--timeout', '1000'])).toEqual({ timeout: '1000' });
  });

  it('reads a flag with nothing after it as a boolean', () => {
    expect(parseArgs(['--help'])).toEqual({ help: true });
    expect(parseArgs(['--help', '--timeout', '1000'])).toEqual({ help: true, timeout: '1000' });
  });

  it('does not swallow the next flag as a value', () => {
    // `--require --timeout 1000` is a missing value, not an adapter called
    // "--timeout": the reader gets an empty requirement and the timeout still
    // applies, instead of one silently eating the other.
    expect(parseArgs(['--require', '--timeout', '1000'])).toEqual({
      require: true,
      timeout: '1000',
    });
  });

  it('keeps the last value of a repeated flag', () => {
    expect(parseArgs(['--require', 'a', '--require', 'b'])).toEqual({ require: 'b' });
  });

  it('ignores bare words, which are not options', () => {
    expect(parseArgs(['package', '--timeout', '1000', 'extra'])).toEqual({ timeout: '1000' });
  });

  it('resolves --release against the repository, not the caller\'s cwd', () => {
    // The preflight is often started from a shell sitting somewhere else; the
    // answer must not depend on that. `release` is the default directory, so the
    // two spellings have to agree.
    expect(releaseDirFrom({})).toBe(RELEASE_DIR);
    expect(releaseDirFrom({ release: 'release' })).toBe(RELEASE_DIR);
    expect(releaseDirFrom({ release: 'out/ci' })).toBe(resolve(RELEASE_DIR, '..', 'out/ci'));
    expect(releaseDirFrom({ release: '/abs/elsewhere' })).toBe('/abs/elsewhere');
  });
});

describe('the launch, driven through an injected spawn', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('finishes the moment the summary line completes, and keeps every byte', async () => {
    // Real timers with a short bound on purpose: if the line stops being
    // recognised this fails in a second with `reason: 'timeout'`, instead of
    // hanging until the 30s test timeout and saying nothing useful.
    const child = new FakeChild();
    const spawnFn = vi.fn(() => child);
    const pending = launch('/opt/ucad', { spawnFn, timeoutMs: 1000 });

    child.say('Checking for update\n[ucad] adapters resolv');
    // Split mid-line: a run that judged each chunk would miss the line entirely.
    expect(child.kill).not.toHaveBeenCalled();
    child.say('ed: universal\n');

    const { output, reason } = await pending;
    expect(reason).toBe('resolved-line');
    expect(output).toContain('Checking for update');
    expect(output).toContain('[ucad] adapters resolved: universal');
    // stdin is ignored: a packaged app must not inherit a terminal and wait on it.
    expect(spawnFn).toHaveBeenCalledWith(
      '/opt/ucad',
      [],
      expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }),
    );
    expect(child.signals).toEqual(['SIGTERM']);
  });

  it('gives up at the timeout, so a build that never prints the line is a failure', async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const pending = launch('/opt/ucad', { spawnFn: () => child, timeoutMs: 1000 });

    child.say('Error: Cannot open display\n');
    await vi.advanceTimersByTimeAsync(999);
    expect(child.kill).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    const { output, reason } = await pending;
    expect(reason).toBe('timeout');
    // The output is kept for the tail in the failure message.
    expect(output).toContain('Cannot open display');
    expect(child.signals).toEqual(['SIGTERM']);
  });

  it('reports a launch that could not start at all, with the reason', async () => {
    const child = new FakeChild();
    const pending = launch('/opt/ucad', { spawnFn: () => child, timeoutMs: 10_000 });
    child.emit('error', new Error('ENOENT: no such file'));

    const { output, reason } = await pending;
    expect(reason).toBe('launch-error');
    expect(output).toContain('could not launch /opt/ucad');
    expect(output).toContain('ENOENT');
  });

  it('reports a build that exited before printing the line as exited, not as resolved', async () => {
    const child = new FakeChild();
    const pending = launch('/opt/ucad', { spawnFn: () => child, timeoutMs: 10_000 });
    child.exitCode = 1;
    child.emit('exit', 1);

    const { reason } = await pending;
    expect(reason).toBe('exited');
  });

  it('stops a timed-out run through the process tree on Windows', async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const taskkill = new EventEmitter();
    const spawnFn = vi.fn((command: string) => (command === 'taskkill' ? taskkill : child));
    const pending = launch('/opt/ucad', { spawnFn, platform: 'win32', timeoutMs: 10 });

    await vi.advanceTimersByTimeAsync(10);
    const { reason } = await pending;
    expect(reason).toBe('timeout');
    // `kill()` alone leaves the Chromium children behind on Windows.
    expect(spawnFn).toHaveBeenCalledWith(
      'taskkill',
      ['/pid', '4242', '/T', '/F'],
      expect.objectContaining({ windowsHide: true }),
    );
    expect(child.kill).not.toHaveBeenCalled();
  });
});

describe('the stop that keeps a failed run from leaving an orphan', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('escalates to SIGKILL when the app ignores SIGTERM', async () => {
    // `kill()` returning true means the signal was delivered, not that the app
    // died. A wedged Electron build ignores SIGTERM and would stay in the tray.
    vi.useFakeTimers();
    const child = new FakeChild();
    stop(child, { platform: 'linux', graceMs: 200 });
    expect(child.signals).toEqual(['SIGTERM']);

    await vi.advanceTimersByTimeAsync(200);
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('does not SIGKILL an app that honoured SIGTERM', async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    stop(child, { platform: 'linux', graceMs: 200 });
    child.exitCode = 143;

    await vi.advanceTimersByTimeAsync(200);
    expect(child.signals).toEqual(['SIGTERM']);
  });

  it('falls back to kill() when taskkill cannot be started', () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const taskkill = new EventEmitter();
    stop(child, { platform: 'win32', spawnFn: () => taskkill });

    taskkill.emit('error', new Error('ENOENT'));
    expect(child.kill).toHaveBeenCalled();
  });

  it('leaves an app that already exited alone', () => {
    const child = new FakeChild();
    child.exitCode = 0;

    stop(child, { platform: 'linux' });
    expect(child.kill).not.toHaveBeenCalled();
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

  it('tells the operator to leave a detached HEAD before packaging', () => {
    // A detached HEAD is a process trap, not a code defect: the build still
    // succeeds, and the result is traceable to no branch. It belongs in the
    // preflight checklist, where the operator is already reading, rather than
    // in a paragraph someone might read once.
    const contributing = readFileSync(join(REPO_ROOT, 'CONTRIBUTING.md'), 'utf8');
    const preflight = contributing.slice(contributing.indexOf('### Release preflight'));
    expect(preflight.length).toBeGreaterThan(0);
    expect(preflight).toMatch(/detached HEAD/u);
    expect(preflight).toContain('git switch main');
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
