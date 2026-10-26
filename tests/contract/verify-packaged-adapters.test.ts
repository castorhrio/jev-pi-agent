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
 *  - the **first** summary line is the answer, both in the parser and in the
 *    launch, so a later line cannot rescue a launch that resolved nothing — the
 *    rule is stated in `resolvedAdapterIds` and pinned from both ends here;
 *  - a build that never reached resolution is reported as that, not as
 *    "no adapters" — the two send a reader to different places;
 *  - the executable to launch is looked for where `electron-builder` actually
 *    writes it, per platform; and
 *  - a missing build names the command that produces one.
 *
 * The launch used to be the one part not covered here, because it needs a
 * packaged app. It now takes its `spawn` as a parameter, so a fake child drives
 * every path that decides the outcome — the summary line arriving (split across
 * chunks, and only judged once its newline has arrived, because a chunk cut
 * through `universal, mock` parses as the shorter list `universal, mo`), the
 * timeout, a launch error, an early exit, and the stop that follows each of
 * them — including the `SIGKILL` fallback without which a wedged build is left
 * running as an orphan. What remains manual is running the real artifact; the
 * last cases keep THAT statement discoverable, since CONTRIBUTING has to name
 * the command or the reader is back to "read the line yourself".
 *
 * The stop is pinned on the *tree*, because that is what the orphan was. The
 * old code signalled the app's own process and asked "is the app still alive?"
 * before escalating — so an app that died on `SIGTERM` while a Chromium child
 * it had started kept running was never cleaned up. The build now leads its own
 * process group, the group is what gets signalled, and the question the
 * escalation asks is "is the group still there?". The group signal is a seam
 * too: a test that signalled whatever group happened to carry that id on the
 * machine could hit something else entirely.
 *
 * The escalation is also not the caller's to opt into: the grace period has a
 * default, and the cases that pass none are the ones that matter, because the
 * command an operator runs passes none either. A timeout — the path where the
 * build has proved nothing about shutting down — is pinned to reach `SIGKILL`
 * as a group for exactly that reason.
 *
 * That question turns out to have three answers, not two, and the third one is
 * the dangerous one: a probe can be *refused* (`EPERM` — a pid recycled onto
 * another user's process, a sandboxed syscall) and a refusal is not "the group
 * is gone". Reading it as gone would send `SIGKILL` to a process this one has
 * just been told it may not signal. So the escalation gives up on a refusal and
 * writes down why; the tests pin both the give-up and its message, because a
 * cleanup that quietly stops cleaning up is indistinguishable from one that
 * never ran.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  KILL_GRACE_MS,
  RELEASE_DIR,
  SUMMARY_LINE_PATTERNS,
  findPackagedExecutable,
  interruptRun,
  launch,
  packagedExecutables,
  parseArgs,
  releaseDirFrom,
  resolvedAdapterIds,
  stop,
  tailOf,
  verifyResolution,
} from '../../scripts/verify-packaged-adapters.mjs';
import { readWorkflowFiles, workflowsPackageTheApp } from './ci-shape';

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

  it('takes the first summary line a build prints, and only that one', () => {
    // A packaged UCAD is a tray app and keeps printing; a build whose resolution
    // is attempted more than once can therefore print the line twice. The first
    // line is the launch's own resolution, so `exec` without `/g` — which
    // returns the first match — is the documented answer rather than an
    // accident of statement order. Both directions are pinned below, because a
    // "last line wins" edit would look like a tidy-up.
    expect(
      resolvedAdapterIds(
        '[ucad] adapters resolved: universal, mock\n[ucad] adapters resolved: (none)\n',
      ),
    ).toEqual(['universal', 'mock']);
    expect(
      resolvedAdapterIds(
        '[ucad] adapters resolved: (none)\n[ucad] adapters resolved: universal\n',
      ),
    ).toEqual([]);
  });

  it('returns null when there is no line at all', () => {
    // Distinct from `[]` on purpose: a launch that never reached resolution has
    // a different cause (and a different fix) from one that resolved nothing.
    expect(resolvedAdapterIds('Error: Cannot open display\n')).toBeNull();
    // A line that merely mentions resolution is not the summary line.
    expect(resolvedAdapterIds('adapters resolved: universal\n')).toBeNull();
  });

  it('keeps the report and stream patterns in their own roles', () => {
    // The two patterns answer different questions, and naming them by consumer
    // is what makes that checkable. A captured output that ends mid-line is a
    // *finished* capture, so `report` reads it: `$` matches the end of the
    // string as well as the end of a line, and `['universal', 'mo']` is the
    // honest answer to "what did this captured output say".
    const halfLine = '[ucad] adapters resolved: universal, mo';
    expect(SUMMARY_LINE_PATTERNS.report.test(halfLine)).toBe(true);
    expect(resolvedAdapterIds(halfLine)).toEqual(['universal', 'mo']);
    // `verifyResolution` is a report consumer too: it must judge the capture it
    // was given rather than reporting "no summary line" because the capture
    // ended without a newline (a build can print the line and exit).
    expect(verifyResolution(halfLine)).toEqual([]);

    // `stream` is the launch's pattern, and the same half line must not satisfy
    // it: the value is still arriving, and stopping here would report the
    // shorter list `universal, mo` as the build's resolution. This is the
    // assertion that goes red if the launch is ever switched back to `report`.
    expect(SUMMARY_LINE_PATTERNS.stream.test(halfLine)).toBe(false);

    // Once the terminator arrives, both patterns agree — one complete line.
    const wholeLine = `${halfLine}ck\n`;
    expect(SUMMARY_LINE_PATTERNS.report.test(wholeLine)).toBe(true);
    expect(SUMMARY_LINE_PATTERNS.stream.test(wholeLine)).toBe(true);
    expect(resolvedAdapterIds(wholeLine)).toEqual(['universal', 'mock']);
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

  it('judges the first resolution, so a later line cannot rescue the launch', () => {
    // The failure this keeps out of the "retry" direction: if the verdict read
    // the last line, a build that resolved nothing and later printed a good
    // line — from a second attempt, or from a line that was already in the
    // buffer — would pass. The first line is the state this launch reached.
    const problems = verifyResolution(
      '[ucad] adapters resolved: (none)\n[ucad] adapters resolved: universal\n',
    );
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain('resolved no adapter at all');
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

/**
 * A stand-in for the process group `stop()` signals.
 *
 * The real thing is `process.kill(-pid, …)`, which needs a real process group
 * to exist. A test that signalled whatever group happened to carry that id on
 * the machine could hit something else, so the group is faked instead: this
 * records what was sent and answers whether the group still has a member.
 */
class FakeGroup {
  /** Every signal sent to the group, in order. */
  signals: Array<{ pid: number; signal: string | number }> = [];
  /** Whether the group still has a member in it. */
  alive = true;
  /**
   * The error the existence probe (signal 0) throws, when the test wants one.
   *
   * `alive = false` is the ordinary ESRCH case; this is the other failure a
   * probe can produce — a permission refusal, which is what a recycled pid or
   * another user's group looks like through `kill(2)`. The two have to be
   * separable, because the code's decision depends on which one it got.
   */
  probeError: NodeJS.ErrnoException | undefined;

  kill = vi.fn((pid: number, signal: string | number) => {
    if (signal === 0 && this.probeError !== undefined) throw this.probeError;
    if (!this.alive) {
      const error = new Error('kill ESRCH');
      (error as NodeJS.ErrnoException).code = 'ESRCH';
      throw error;
    }
    this.signals.push({ pid, signal });
    return true;
  });

  /** The signals sent, without the existence probe (signal 0). */
  get sent(): Array<{ pid: number; signal: string | number }> {
    return this.signals.filter((entry) => entry.signal !== 0);
  }
}

/** An error shaped like the one `kill(2)` surfaces, with a `code` to branch on. */
function errnoError(code: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(`kill ${code}`);
  error.code = code;
  return error;
}

/** The state `interruptRun` reads and writes. */
interface RunState {
  child: FakeChild | null;
  interrupted: boolean;
  signal: string | null;
  exitCode: number;
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
    const group = new FakeGroup();
    const spawnFn = vi.fn(() => child);
    const pending = launch('/opt/ucad', { spawnFn, killFn: group.kill, timeoutMs: 1000 });

    // Cut *inside* the word the line is matched on, which is the boundary that
    // hurts: a run that judged each chunk on its own would see
    // `[ucad] adapters reso` and `lved: universal` and never the line.
    child.say('Checking for update\n[ucad] adapters reso');
    expect(child.kill).not.toHaveBeenCalled();
    child.say('lved: universal\n');

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
    // The build is stopped through its group, so its Chromium children go too.
    expect(group.sent).toEqual([{ pid: -4242, signal: 'SIGTERM' }]);
  });

  it('does not judge a summary line whose value is still arriving', async () => {
    // The other half of the same chunk-boundary problem, and the one that reads
    // as a pass. `RESOLVED_LINE` is anchored with `$` under `/m`, which matches
    // the end of the *string* as well as the end of a line — so a chunk ending
    // mid-value parses as a complete, *smaller* resolution:
    // `[ucad] adapters resolved: universal, mo` yields `['universal', 'mo']`.
    // The launch therefore waits for the newline. This is not a hypothetical:
    // a pipe read boundary can fall anywhere, and the id list it cuts through
    // is the answer the operator reads.
    vi.useFakeTimers();
    const child = new FakeChild();
    const group = new FakeGroup();
    const pending = launch('/opt/ucad', {
      spawnFn: () => child,
      killFn: group.kill,
      timeoutMs: 1000,
    });

    child.say('[ucad] adapters resolved: universal, mo');
    await vi.advanceTimersByTimeAsync(0);
    // Nothing settled on the truncated list: no stop, no verdict.
    expect(child.kill).not.toHaveBeenCalled();
    expect(group.sent).toEqual([]);

    child.say('ck\n');
    const { output, reason } = await pending;
    expect(reason).toBe('resolved-line');
    expect(resolvedAdapterIds(output)).toEqual(['universal', 'mock']);
    expect(group.sent).toEqual([{ pid: -4242, signal: 'SIGTERM' }]);
  });

  it('recognises the line when the console writes CRLF', async () => {
    // "The newline has arrived" is two characters on a console that writes
    // `\r\n`, and `.` in a JavaScript regex does not match `\r`: without the
    // optional carriage return the check would wait out its whole timeout on a
    // build that printed the line, and report the wait as a launch that never
    // reached resolution. Real timers and a short bound, so that failure is a
    // second of waiting rather than the test timeout.
    const child = new FakeChild();
    const group = new FakeGroup();
    const pending = launch('/opt/ucad', {
      spawnFn: () => child,
      killFn: group.kill,
      timeoutMs: 1000,
    });

    child.say('[ucad] adapters resolved: universal, mock\r\n');
    const { output, reason } = await pending;
    expect(reason).toBe('resolved-line');
    // And the carriage return is not part of the last id.
    expect(resolvedAdapterIds(output)).toEqual(['universal', 'mock']);
    expect(group.sent).toEqual([{ pid: -4242, signal: 'SIGTERM' }]);
  });

  it('judges the launch on the line, so output that arrives later changes nothing', async () => {
    // A packaged UCAD is a tray app: it keeps printing after the summary line
    // (update-feed chatter, renderer warnings), and it stays alive until it is
    // stopped. So the verdict is taken at the line and everything after it is
    // dropped on purpose — first line wins, and later output cannot replace it.
    // That is a trade, not an accident of statement order, and the case below
    // is what keeps it one: it rules out a *second* summary line arriving after
    // a good one and re-deciding whether the check passed. What is observable
    // from outside is the verdict and the captured output; the `settled` guard
    // in `collect` is what makes both of them a snapshot of the line.
    const child = new FakeChild();
    const group = new FakeGroup();
    const pending = launch('/opt/ucad', {
      spawnFn: () => child,
      killFn: group.kill,
      timeoutMs: 1000,
    });

    child.say('[ucad] adapters resolved: universal\n');
    const { output, reason } = await pending;

    // The app keeps talking after the verdict was reached.
    child.say('[ucad] adapters resolved: (none)\nError: renderer went away\n');

    expect(reason).toBe('resolved-line');
    expect(verifyResolution(output)).toEqual([]);
    // `(none)` is the passing-looking failure this whole script exists for; if
    // late output could reach the verdict it would replace a good line with it.
    expect(output).not.toContain('(none)');
    expect(output).not.toContain('renderer went away');
    // And the late output did not trigger a second stop of the tree.
    expect(group.sent).toEqual([{ pid: -4242, signal: 'SIGTERM' }]);
  });

  it('gives the build its own process group, so the tree can be signalled', async () => {
    // Without this there is no group to signal: the build would sit in the
    // script's own group, where `kill(-pid)` means something else entirely.
    const child = new FakeChild();
    const group = new FakeGroup();
    const spawnFn = vi.fn(() => child);
    const pending = launch('/opt/ucad', { spawnFn, killFn: group.kill, timeoutMs: 1000 });

    expect(spawnFn).toHaveBeenCalledWith(
      '/opt/ucad',
      [],
      expect.objectContaining({ detached: true }),
    );
    child.say('[ucad] adapters resolved: universal\n');
    await pending;
  });

  it('does not detach on Windows, where a detached build would get its own console', async () => {
    const child = new FakeChild();
    const group = new FakeGroup();
    const taskkill = new EventEmitter();
    const spawnFn = vi.fn((command: string) => (command === 'taskkill' ? taskkill : child));
    const pending = launch('/opt/ucad', {
      spawnFn,
      killFn: group.kill,
      platform: 'win32',
      timeoutMs: 1000,
    });

    expect(spawnFn).toHaveBeenCalledWith(
      '/opt/ucad',
      [],
      expect.objectContaining({ detached: false }),
    );
    child.say('[ucad] adapters resolved: universal\n');
    await pending;
  });

  it('settles on the first summary line when both arrive in one chunk', async () => {
    // The same first-line assumption at the launch level, where it is harder to
    // see: a chunk that carries two lines is appended whole, so the verdict is
    // decided by the parser's first match rather than by which chunk arrived.
    const child = new FakeChild();
    const group = new FakeGroup();
    const pending = launch('/opt/ucad', {
      spawnFn: () => child,
      killFn: group.kill,
      timeoutMs: 1000,
    });

    child.say('[ucad] adapters resolved: universal\n[ucad] adapters resolved: (none)\n');
    const { output, reason } = await pending;

    expect(reason).toBe('resolved-line');
    expect(resolvedAdapterIds(output)).toEqual(['universal']);
    expect(verifyResolution(output)).toEqual([]);
    // One stop for one launch, not one per summary line.
    expect(group.sent).toEqual([{ pid: -4242, signal: 'SIGTERM' }]);
  });

  it('reports the child while the build is still running', async () => {
    // A caller that may be interrupted needs the handle before the launch
    // settles: the promise only resolves once the build is on its way out.
    const child = new FakeChild();
    const group = new FakeGroup();
    const seen: unknown[] = [];
    const pending = launch('/opt/ucad', {
      spawnFn: () => child,
      killFn: group.kill,
      timeoutMs: 1000,
      onChild: (handle) => seen.push(handle),
    });

    expect(seen).toEqual([child]);
    child.say('[ucad] adapters resolved: universal\n');
    await pending;
  });

  it('gives up at the timeout, so a build that never prints the line is a failure', async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const group = new FakeGroup();
    const pending = launch('/opt/ucad', {
      spawnFn: () => child,
      killFn: group.kill,
      timeoutMs: 1000,
    });

    child.say('Error: Cannot open display\n');
    await vi.advanceTimersByTimeAsync(999);
    expect(child.kill).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    const { output, reason } = await pending;
    expect(reason).toBe('timeout');
    // The output is kept for the tail in the failure message.
    expect(output).toContain('Cannot open display');
    // The timeout is the path most likely to leave an orphan — the build never
    // proved it can shut down, it is exactly the wedged case — so it goes
    // through the group stop, not `child.kill()`.
    expect(child.kill).not.toHaveBeenCalled();
    expect(group.sent).toEqual([{ pid: -4242, signal: 'SIGTERM' }]);

    // And that stop escalates on its default grace period, with no number
    // passed by this test beyond the launch's own default: a timed-out build
    // that ignores SIGTERM is the orphan, and it is `SIGKILL`ed as a group.
    await vi.advanceTimersByTimeAsync(KILL_GRACE_MS);
    expect(group.sent).toEqual([
      { pid: -4242, signal: 'SIGTERM' },
      { pid: -4242, signal: 'SIGKILL' },
    ]);
  });

  it('escalates to SIGKILL on its default grace period, with none passed in', async () => {
    // The command an operator runs passes no `killGraceMs`, and neither does
    // this case. That is the point: the escalation is the reason the script
    // exists, so it must not be a property of the *tested* call path only —
    // `launch(executable)` has to stop a wedged build through the group and
    // then, when the group is still there, `SIGKILL` it.
    vi.useFakeTimers();
    const child = new FakeChild();
    const group = new FakeGroup(); // `alive: true` — nothing honoured SIGTERM
    const pending = launch('/opt/ucad', {
      spawnFn: () => child,
      killFn: group.kill,
      timeoutMs: 60_000,
    });

    child.say('[ucad] adapters resolved: universal\n');
    const { reason } = await pending;
    expect(reason).toBe('resolved-line');
    expect(group.sent).toEqual([{ pid: -4242, signal: 'SIGTERM' }]);

    // One millisecond short: the grace period is a period, not a formality.
    await vi.advanceTimersByTimeAsync(KILL_GRACE_MS - 1);
    expect(group.sent).toEqual([{ pid: -4242, signal: 'SIGTERM' }]);

    await vi.advanceTimersByTimeAsync(1);
    expect(group.sent).toEqual([
      { pid: -4242, signal: 'SIGTERM' },
      { pid: -4242, signal: 'SIGKILL' },
    ]);
  });

  it('reports a launch that could not start at all, with the reason', async () => {
    const child = new FakeChild();
    const group = new FakeGroup();
    const pending = launch('/opt/ucad', {
      spawnFn: () => child,
      killFn: group.kill,
      timeoutMs: 10_000,
    });
    child.emit('error', new Error('ENOENT: no such file'));

    const { output, reason } = await pending;
    expect(reason).toBe('launch-error');
    expect(output).toContain('could not launch /opt/ucad');
    expect(output).toContain('ENOENT');
  });

  it('reports a build that exited before printing the line as exited, not as resolved', async () => {
    const child = new FakeChild();
    const group = new FakeGroup();
    const pending = launch('/opt/ucad', {
      spawnFn: () => child,
      killFn: group.kill,
      timeoutMs: 10_000,
    });
    child.exitCode = 1;
    child.emit('exit', 1);

    const { reason } = await pending;
    expect(reason).toBe('exited');
    // It is already gone, so there is nothing left to stop.
    expect(group.kill).not.toHaveBeenCalled();
  });

  it('stops a timed-out run through the process tree on Windows', async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const group = new FakeGroup();
    const taskkill = new EventEmitter();
    const spawnFn = vi.fn((command: string) => (command === 'taskkill' ? taskkill : child));
    const pending = launch('/opt/ucad', {
      spawnFn,
      killFn: group.kill,
      platform: 'win32',
      timeoutMs: 10,
    });

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
    // Windows has no process groups; `taskkill /T` is what walks the tree.
    expect(group.kill).not.toHaveBeenCalled();
  });
});

describe('the stop that keeps a failed run from leaving an orphan', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('signals the whole tree, not just the app', () => {
    // `child.kill()` reaches the build's own process; the Chromium children it
    // started are a group of their own, and a check that leaves them running
    // has not cleaned up after itself. So the group is what gets the signal —
    // a negative pid is "every process in that group".
    const child = new FakeChild();
    const group = new FakeGroup();
    stop(child, { platform: 'linux', graceMs: 200, killFn: group.kill });

    expect(group.sent).toEqual([{ pid: -4242, signal: 'SIGTERM' }]);
    // The app itself is not signalled twice: the group already covers it.
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('escalates to SIGKILL when the app ignores SIGTERM', async () => {
    // `kill()` returning true means the signal was delivered, not that the app
    // died. A wedged Electron build ignores SIGTERM and would stay in the tray.
    vi.useFakeTimers();
    const child = new FakeChild();
    const group = new FakeGroup();
    stop(child, { platform: 'linux', graceMs: 200, killFn: group.kill });
    expect(group.sent).toEqual([{ pid: -4242, signal: 'SIGTERM' }]);

    await vi.advanceTimersByTimeAsync(200);
    expect(group.sent).toEqual([
      { pid: -4242, signal: 'SIGTERM' },
      { pid: -4242, signal: 'SIGKILL' },
    ]);
  });

  it('kills the tree even when the app itself is already gone', async () => {
    // The case the old code missed. It asked "is the app still alive?" and
    // stopped asking once the app was dead — while a child the app had started
    // was still running. The group is what says whether anything is left.
    vi.useFakeTimers();
    const child = new FakeChild();
    const group = new FakeGroup();
    stop(child, { platform: 'linux', graceMs: 200, killFn: group.kill });
    child.exitCode = 0; // the app is gone; its child is not

    await vi.advanceTimersByTimeAsync(200);
    expect(group.sent).toEqual([
      { pid: -4242, signal: 'SIGTERM' },
      { pid: -4242, signal: 'SIGKILL' },
    ]);
  });

  it('does not SIGKILL an app that honoured SIGTERM', async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const group = new FakeGroup();
    stop(child, { platform: 'linux', graceMs: 200, killFn: group.kill });
    child.exitCode = 143;
    group.alive = false; // the whole tree is gone

    await vi.advanceTimersByTimeAsync(200);
    expect(group.sent).toEqual([{ pid: -4242, signal: 'SIGTERM' }]);
  });

  it('does not read a refused probe as "the group is gone"', async () => {
    // `EPERM` from the probe is not an answer about existence: the group is
    // there and is not this process's to signal. The realistic way to get here
    // is a pid recycled between the launch and the probe (the app died and its
    // id went to someone else's process), or a sandbox refusing the syscall.
    // The old code answered "not alive" to every error, so it read the refusal
    // as an empty group and sent SIGKILL to a pid it had just been told it may
    // not touch. Two things are asserted instead: nothing further is signalled,
    // and the give-up is written down rather than silent.
    vi.useFakeTimers();
    const child = new FakeChild();
    const group = new FakeGroup();
    const warn = vi.fn();
    stop(child, { platform: 'linux', graceMs: 200, killFn: group.kill, warn });
    expect(group.sent).toEqual([{ pid: -4242, signal: 'SIGTERM' }]);

    group.probeError = errnoError('EPERM');
    await vi.advanceTimersByTimeAsync(200);

    // Not even the group's own SIGKILL: the refusal is the reason to stop.
    expect(group.sent).toEqual([{ pid: -4242, signal: 'SIGTERM' }]);
    // Nor a SIGKILL aimed at the app on the strength of "the group must be
    // empty" — that inference is exactly what the probe failed to establish.
    expect(child.signals).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]?.[0]);
    expect(message).toContain('EPERM');
    expect(message).toContain('4242');
  });

  it('gives up the escalation on a probe that failed for want of a code too', async () => {
    // The error need not be an errno at all (a seam may throw anything), and an
    // unrecognised failure is no more an answer about existence than `EPERM`.
    vi.useFakeTimers();
    const child = new FakeChild();
    const group = new FakeGroup();
    const warn = vi.fn();
    stop(child, { platform: 'linux', graceMs: 200, killFn: group.kill, warn });

    group.probeError = new Error('kill ESOMETHINGNEW') as NodeJS.ErrnoException;
    await vi.advanceTimersByTimeAsync(200);

    expect(group.sent).toEqual([{ pid: -4242, signal: 'SIGTERM' }]);
    expect(child.signals).toEqual([]);
    expect(String(warn.mock.calls[0]?.[0])).toContain('unknown error');
  });

  it('falls back to the app itself when there is no group to signal', async () => {
    // A build that was not spawned detached has no group of its own, and the
    // app itself is then all there is to reach.
    vi.useFakeTimers();
    const child = new FakeChild();
    const group = new FakeGroup();
    group.alive = false;
    stop(child, { platform: 'linux', graceMs: 200, killFn: group.kill });
    expect(child.signals).toEqual(['SIGTERM']);

    // And the escalation still reaches it, or a wedged app stays in the tray.
    await vi.advanceTimersByTimeAsync(200);
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('walks the tree with taskkill on Windows, where there are no process groups', () => {
    const child = new FakeChild();
    const group = new FakeGroup();
    const taskkill = new EventEmitter();
    const spawnFn = vi.fn(() => taskkill);

    stop(child, { platform: 'win32', spawnFn, killFn: group.kill });

    expect(spawnFn).toHaveBeenCalledWith(
      'taskkill',
      ['/pid', '4242', '/T', '/F'],
      expect.objectContaining({ windowsHide: true }),
    );
    expect(group.kill).not.toHaveBeenCalled();
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
    const group = new FakeGroup();
    child.exitCode = 0;

    stop(child, { platform: 'linux', killFn: group.kill });
    expect(child.kill).not.toHaveBeenCalled();
    expect(group.kill).not.toHaveBeenCalled();
  });
});

describe('the operator who changes their mind', () => {
  it('stops the build and ends the run as an interruption', () => {
    // The build leads its own process group, so it no longer receives the
    // terminal's own SIGINT: the script has to stop it, and the run has to end
    // as an interruption rather than as a verdict on the build.
    const child = new FakeChild();
    const group = new FakeGroup();
    const state: RunState = { child, interrupted: false, signal: null, exitCode: 0 };

    interruptRun(state, 'SIGINT', { platform: 'linux', killFn: group.kill });

    expect(state.interrupted).toBe(true);
    expect(state.exitCode).toBe(130);
    expect(group.sent).toEqual([{ pid: -4242, signal: 'SIGTERM' }]);
  });

  it('remembers the interruption for a build that only appears afterwards', () => {
    // Ctrl+C can land before the build is even spawned. The run still has to
    // end as an interruption, and the build still has to be stopped.
    const state: RunState = { child: null, interrupted: false, signal: null, exitCode: 0 };
    interruptRun(state, 'SIGTERM', { platform: 'linux' });
    expect(state.interrupted).toBe(true);
    expect(state.exitCode).toBe(143);

    const child = new FakeChild();
    const group = new FakeGroup();
    state.child = child;
    interruptRun(state, state.signal as string, { platform: 'linux', killFn: group.kill });
    expect(group.sent).toEqual([{ pid: -4242, signal: 'SIGTERM' }]);
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

  it('puts the Ctrl+C claim in the release checklist, where it is verified', () => {
    // CONTRIBUTING states that an interrupted check exits `130`. That is a
    // claim about the terminal delivering `SIGINT`, which no unit test can
    // observe — `interruptRun` is driven directly. So the claim needs a manual
    // step, in the list the operator is already reading, or it is a sentence
    // nobody has ever checked.
    const contributing = readFileSync(join(REPO_ROOT, 'CONTRIBUTING.md'), 'utf8');
    const preflight = contributing.slice(contributing.indexOf('### Release preflight'));
    expect(preflight, 'CONTRIBUTING.md no longer has a "### Release preflight" section').not.toBe(
      '',
    );
    expect(preflight).toMatch(/Ctrl\+C/u);
    expect(preflight).toContain('130');
  });

  it('names the grace period the script really uses, so the sentence cannot drift', () => {
    // The paragraph above the checklist promises a stopped build five seconds
    // before `SIGKILL`. That number is `KILL_GRACE_MS`, and a doc that states a
    // duration nobody checks is the kind of sentence that is wrong for a year.
    const contributing = readFileSync(join(REPO_ROOT, 'CONTRIBUTING.md'), 'utf8');
    expect(contributing).toContain(`${KILL_GRACE_MS / 1000}-second grace period`);
  });

  it('is not claimed to run in CI, which still has no packaging job', () => {
    // The same claim `adapter-resolution.test.ts` keeps for the README bullets,
    // and the same vocabulary: `workflowsPackageTheApp` names `npm run
    // package`, `npm run dist` and `electron-builder`, so a release job added
    // under any of them turns this red. If a packaging job appears, the honest
    // sentence changes with it — this case exists so the change is made on
    // purpose.
    //
    // The whole directory is read, not `ci.yml`: "the script does not run in
    // CI" is a claim about every workflow GitHub runs, so a `release.yml` that
    // packaged the app and then ran the script would falsify it just as much.
    const workflows = readWorkflowFiles(join(REPO_ROOT, '.github', 'workflows'));
    expect(workflows.length).toBeGreaterThan(0);
    expect(workflowsPackageTheApp(workflows)).toBe(false);
    expect(existsSync(join(REPO_ROOT, 'scripts', 'verify-packaged-adapters.mjs'))).toBe(true);
  });
});
