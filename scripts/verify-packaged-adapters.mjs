/**
 * The packaged adapter check, as a command instead of an instruction.
 *
 * ## Why this file exists
 *
 * Adapter resolution has one step no automated gate reaches: reading a module
 * from *inside* a real `.asar` archive needs Electron's patched `fs`, which only
 * a packaged launch provides. `tests/contract/adapter-resolution.test.ts` pins
 * everything on this side of that boundary — the search paths, the asar-shaped
 * app root, the failure reporting — and the README and CONTRIBUTING both say the
 * last step is manual. Both of those used to end with "read the
 * `adapters resolved:` line it prints", which is a sentence that decays:
 *
 *  - the line is one of several a packaged app prints, and nothing says which
 *    ones are expected, so "I looked and it seemed fine" is the natural reading;
 *  - `(none)` is a *passing-looking* string. An app that resolved no adapter at
 *    all still prints a line, and a reader skimming for "adapters resolved:"
 *    finds one;
 *  - and on Windows the line goes to stderr, which a double-clicked build does
 *    not have, so an unreadable check reports itself as a clean one.
 *
 * So the check is a script: it launches the build that `npm run package` wrote,
 * captures stdout and stderr, and asserts the summary line names the adapter
 * that can actually do work. Exit code 0 or 1; a failing run prints the tail of
 * what the app said instead of asking the reader to scroll a terminal.
 *
 * ## Why it is not in CI
 *
 * Deliberately, and the READMEs say so: `electron-builder` packaging is slow,
 * platform-specific and fragile (the Windows symlink-privilege trap in
 * CONTRIBUTING is one example), and a packaging job that flakes gets switched
 * off — taking the claim with it. The honest arrangement is a gate that exists,
 * runs on demand, and states that it is manual. `readme-parity.test.ts` and
 * `adapter-resolution.test.ts` keep that statement true of `ci.yml`.
 *
 * ## Usage
 *
 * ```bash
 * npm run package                 # once, writes release/
 * node scripts/verify-packaged-adapters.mjs
 * ```
 *
 * Optional flags: `--require universal,mock` (default `universal`), `--timeout
 * 60000`. On a headless machine, wrap it: `xvfb-run node
 * scripts/verify-packaged-adapters.mjs`. The environment is inherited, so
 * `ELECTRON_DISABLE_SANDBOX=1` reaches the launched build if it is set.
 *
 * ## The contract with the tests
 *
 * Everything that decides pass/fail is a pure function over strings — which
 * executable to launch, what the line says, whether the ids satisfy the
 * requirement — so `tests/contract/verify-packaged-adapters.test.ts` can pin the
 * judgement without packaging anything. The process handling is also covered,
 * by injecting the `spawn` it would otherwise call: the tests drive a fake
 * child through the resolved-line, timeout, error, exit and stop paths, so the
 * only thing left manual is running a real packaged app.
 *
 * ## Leaving nothing behind
 *
 * A check that starts a tray app has to stop it, and "stopped" has to mean
 * the whole app: a packaged UCAD runs Chromium children, and a signal to the
 * app alone leaves them running — the orphan this script is supposed to
 * prevent. So the build is spawned as the leader of its own process group and
 * the *group* is signalled, which is the same move
 * `packages/terminal/src/process-tree.ts` makes for the same reason (§11.1:
 * killing a process must kill what it started). Windows has no process
 * groups, so `taskkill /T /F` walks the tree there instead.
 *
 * Leading a group has one consequence worth naming: the build no longer
 * receives the terminal's own `SIGINT`, so the script stops it itself when
 * the operator interrupts the check.
 */

import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Where `electron-builder` writes the build (`build.directories.output`). */
export const RELEASE_DIR = join(root, 'release');

/** The summary line `adapter-resolution.ts` prints on the diagnostic channel. */
const RESOLVED_LINE = /^\[ucad\] adapters resolved: (.*)$/m;

/** What an empty resolution prints — a line that looks like success. */
const NONE = '(none)';

/**
 * The binaries `electron-builder` may have written, in the order they are tried.
 *
 * The unpacked directories are tried before any installer: an installer, if it
 * is launched at all, installs the app instead of running it, and prints nothing
 * this script could read. Paths differ per platform because the packaging
 * target does, and each candidate is a fact about electron-builder's output
 * layout rather than a guess:
 *
 *  - Windows: `release/win-unpacked/UCAD.exe` (`productName`);
 *  - macOS: `release/mac/UCAD.app/Contents/MacOS/UCAD` (`productName`), with the
 *    same directory suffixed per architecture when cross-building;
 *  - Linux: `release/linux-unpacked/ucad` (`package.json#name`, lowercased).
 */
export function packagedExecutables({
  platform = process.platform,
  releaseDir = RELEASE_DIR,
  productName = 'UCAD',
  packageName = 'ucad',
} = {}) {
  const packagedName = productName;
  if (platform === 'win32') {
    return [join(releaseDir, 'win-unpacked', `${packagedName}.exe`)];
  }
  if (platform === 'darwin') {
    return [
      join(releaseDir, 'mac', `${packagedName}.app`, 'Contents', 'MacOS', packagedName),
      join(releaseDir, 'mac-arm64', `${packagedName}.app`, 'Contents', 'MacOS', packagedName),
      join(releaseDir, 'mac-x64', `${packagedName}.app`, 'Contents', 'MacOS', packagedName),
    ];
  }
  return [
    join(releaseDir, 'linux-unpacked', packageName),
    join(releaseDir, 'linux-unpacked', packagedName),
  ];
}

/** The first candidate that exists, or `undefined` — the caller says what to run. */
export function findPackagedExecutable(options) {
  return packagedExecutables(options).find((candidate) => existsSync(candidate));
}

/**
 * The adapter ids the build reported, or `null` when it printed no summary.
 *
 * `null` and `[]` are different answers and are kept apart: no line means the
 * app never got as far as resolution (it crashed, or the build is not this
 * product's), while `(none)` means resolution ran and found nothing. Both fail
 * the check, but for different reasons, and a reader who is told "no adapters"
 * for a crashed launch looks in the wrong place.
 */
export function resolvedAdapterIds(output) {
  const match = RESOLVED_LINE.exec(output);
  if (match === null) return null;
  const ids = match[1]
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0 && id !== NONE);
  return ids;
}

/**
 * Everything wrong with what the build printed, as sentences.
 *
 * Empty means the check passed. The messages name the command to run and the
 * line to expect, because the reader of a failure is holding a built app and
 * deciding whether the *build* or the *repository* is broken.
 */
export function verifyResolution(output, { required = ['universal'] } = {}) {
  const ids = resolvedAdapterIds(output);
  if (ids === null) {
    return [
      'the build printed no `[ucad] adapters resolved:` line; it did not reach adapter ' +
        'resolution (see the output below), or it is not a UCAD build',
    ];
  }
  const problems = [];
  if (ids.length === 0) {
    problems.push(
      'the build resolved no adapter at all (`adapters resolved: (none)`); the search paths ' +
        'missed every candidate, which is the packaged-layout bug this check exists for',
    );
  }
  const missing = required.filter((id) => !ids.includes(id));
  if (missing.length > 0) {
    problems.push(
      `the build did not resolve ${missing.map((id) => `"${id}"`).join(', ')}; ` +
        `it resolved ${ids.length === 0 ? 'nothing' : ids.map((id) => `"${id}"`).join(', ')}`,
    );
  }
  return problems;
}

/** `--flag value` and `--flag` pairs, as `make-update-feed.mjs` reads them. */
export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token || !token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

/**
 * Where to look for the build: `--release` is relative to the repository, not
 * to the directory the command happened to be run from.
 *
 * `npm run package` writes `release/` beside `package.json`, and a preflight is
 * as likely to be started from a shell sitting in `apps/desktop` as from the
 * root. Resolving against `root` keeps one answer for both.
 */
export function releaseDirFrom(args) {
  return typeof args.release === 'string' ? resolve(root, args.release) : RELEASE_DIR;
}

/** The last few lines of a launch, for a failure message a terminal can show. */
export function tailOf(output, lines = 25) {
  return output.split('\n').filter((line) => line.trim().length > 0).slice(-lines).join('\n');
}

/**
 * Launch the build and collect its output until the summary line appears.
 *
 * Resolves with the captured output — the caller judges it — and never waits for
 * the app to exit: a packaged UCAD is a tray app that would sit there until
 * killed. The process is stopped as soon as the line is seen, and what is
 * stopped is the whole tree, not just the app: `kill()` alone can leave the
 * Chromium children running.
 *
 * `timeoutMs` is a real bound rather than decoration: a build that fails to
 * start (no display, a missing DLL, a sandbox refusal as root) prints an error
 * and keeps running, and a check that hangs is reported as a broken repository.
 *
 * `spawnFn` and `platform` are seams, defaulted to the real ones: they let the
 * tests drive a fake child through the resolved-line, timeout, launch-error,
 * exit and stop paths, so this is not the one I/O function nobody can fail.
 *
 * `onChild` is handed the child as soon as it exists, before the launch
 * settles: a caller that may be interrupted needs the handle while the build
 * is still running, and the promise does not resolve until then.
 */
export function launch(
  executable,
  {
    timeoutMs = 45_000,
    spawnFn = spawn,
    platform = process.platform,
    killGraceMs,
    killFn,
    onChild,
  } = {},
) {
  return new Promise((resolvePromise) => {
    let output = '';
    let settled = false;
    let timer;

    const child = spawnFn(executable, [], {
      // `ignore` for stdin: the app must not inherit a terminal and wait on it.
      stdio: ['ignore', 'pipe', 'pipe'],
      // The environment is inherited on purpose: `ELECTRON_DISABLE_SANDBOX=1`
      // and the display variables `xvfb-run` sets only reach the build this
      // way. No credential travels here — the README promises the key is handed
      // to the Agent Host when a request needs it, never through an
      // environment variable.
      env: process.env,
      windowsHide: true,
      // POSIX only: the build leads its own process group, which is what lets
      // `stop()` signal the tree and not just the app. On Windows `detached`
      // would mean a new console instead, and `taskkill /T /F` walks the tree
      // there anyway.
      detached: platform !== 'win32',
    });
    onChild?.(child);

    const finish = (reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stop(child, { spawnFn, platform, graceMs: killGraceMs, killFn });
      resolvePromise({ output, reason });
    };

    const collect = (chunk) => {
      output += String(chunk);
      if (RESOLVED_LINE.test(output)) finish('resolved-line');
    };

    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    child.on('error', (error) => {
      output += `\n[verify-packaged-adapters] could not launch ${executable}: ${error.message}\n`;
      finish('launch-error');
    });
    child.on('exit', () => finish('exited'));

    timer = setTimeout(() => finish('timeout'), timeoutMs);
  });
}

/** How long a stopped build gets to honour `SIGTERM` before it is `SIGKILL`ed. */
const KILL_GRACE_MS = 5_000;

/**
 * `process.kill`, wrapped so it can be handed around as a plain function.
 *
 * The seam is called as `killFn(pid, signal)`; wrapping keeps the receiver
 * attached to `process` rather than depending on how the caller invokes it.
 */
const defaultKill = (pid, signal) => process.kill(pid, signal);

/**
 * Signal a whole process group, and say whether the signal was delivered.
 *
 * A negative pid means "every process in that group" to `kill(2)`, and that
 * group is the only way to reach the Chromium children a packaged build
 * starts: they are not in the app's own group otherwise, so a signal to the
 * app alone leaves them running.
 *
 * Signal 0 is the existence probe — `kill(2)` reads it as "may I signal
 * this?", which answers "is the group still there?" without sending
 * anything. That is the question the escalation needs, because the app can be
 * gone while a child of its tree is not.
 *
 * `killFn` is the seam the tests use: a real group signal needs a real
 * process group, and a test that signals whatever group happens to carry that
 * id on the machine is a test that can hit something else.
 */
function signalGroup(killFn, pid, signal) {
  try {
    killFn(-pid, signal);
    return true;
  } catch {
    // ESRCH: nothing is there. EPERM: it is there, and not ours to signal.
    return false;
  }
}

/**
 * Stop the launched app, and its children on the platforms that need it.
 *
 * `SIGTERM` on its own is not enough. `kill()` returning `true` says the signal
 * was *delivered*, not that the process died: a packaged Electron app that is
 * wedged (no display, a hung renderer, a sandbox refusal) ignores it and sits
 * there, and every manual smoke run would leave another tray process behind.
 * So the non-Windows path escalates to `SIGKILL` after a grace period — long
 * enough for a healthy app to shut down cleanly, short enough to be invisible in
 * a run that already failed.
 *
 * And what is signalled is the *tree*, on every platform. `child.kill()`
 * reaches the build's own process; the Chromium children it started are
 * another process group, and a check that leaves them behind has not cleaned
 * up after itself. The build is therefore spawned as the leader of its own
 * group (see `launch`), and that group is what gets `SIGTERM` and, if it is
 * still there, `SIGKILL`. `packages/terminal/src/process-tree.ts` makes the
 * same move for the same reason (§11.1: killing a process must kill what it
 * started). Windows has no process groups, so `taskkill /T /F` walks the tree
 * there instead.
 */
export function stop(
  child,
  {
    spawnFn = spawn,
    platform = process.platform,
    graceMs = KILL_GRACE_MS,
    killFn = defaultKill,
  } = {},
) {
  // The app is already gone — its pid may have been reaped and handed to
  // another process by now, and a group signal aimed at a recycled pid would
  // hit a stranger — so nothing is signalled. The escalation below is the
  // deliberate exception, and it runs inside the grace period.
  if (child.exitCode !== null) return;
  if (platform === 'win32' && typeof child.pid === 'number') {
    spawnFn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }).on(
      'error',
      () => child.kill(),
    );
    return;
  }
  const pid = typeof child.pid === 'number' ? child.pid : null;
  const groupSignalled = pid === null ? false : signalGroup(killFn, pid, 'SIGTERM');
  if (!groupSignalled) {
    // There is no group to signal — the build was not spawned detached, or it
    // is already gone. The app itself is all there is to reach.
    child.kill('SIGTERM');
  }
  const escalate = setTimeout(() => {
    // "Is the app still alive?" is the wrong question: the app can be gone
    // while a child of its tree is not, and that child is the orphan this
    // function exists to prevent. So the group is probed instead — inside the
    // grace period, while the pid is still the one this check started.
    if (pid !== null && signalGroup(killFn, pid, 0)) {
      if (!signalGroup(killFn, pid, 'SIGKILL')) child.kill('SIGKILL');
      return;
    }
    if (child.exitCode === null) child.kill('SIGKILL');
  }, graceMs);
  // A safety net, not work: it must never be the reason the script stays alive.
  // It still fires when the build ignores `SIGTERM`, because a spawned child
  // keeps the event loop alive on its own — the timer does not have to.
  escalate.unref?.();
}

/**
 * What an interrupt means for the run.
 *
 * The check is started by a person who may change their mind, and the build
 * leads its own process group: it no longer receives the terminal's own
 * `SIGINT`, so the script has to stop it. The run also has to end as an
 * interruption rather than as a verdict on the build — exit code 130 says "the
 * operator stopped this", not "the build is broken", and a reader who is told
 * the build failed when they pressed Ctrl+C looks in the wrong place.
 */
export function interruptRun(state, signal, { platform = process.platform, killFn } = {}) {
  state.interrupted = true;
  state.signal = signal;
  state.exitCode = signal === 'SIGINT' ? 130 : 143;
  if (state.child !== null) stop(state.child, { platform, killFn });
  return state;
}

const USAGE = `usage: node scripts/verify-packaged-adapters.mjs [options]

Launches the build in release/ (written by \`npm run package\`), captures its
output, and fails unless the \`adapters resolved:\` line names every required
adapter. Manual on purpose: no CI job packages the app.

  --require universal,mock   adapters the build must have resolved (default: universal)
  --timeout 45000            how long to wait for the summary line, in ms
  --release release          the directory \`npm run package\` wrote
  --help                     this text
`;

async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(USAGE);
    return;
  }
  const required =
    typeof args.require === 'string'
      ? args.require.split(',').map((id) => id.trim()).filter(Boolean)
      : ['universal'];
  const timeoutMs =
    typeof args.timeout === 'string' && Number.isFinite(Number(args.timeout))
      ? Number(args.timeout)
      : 45_000;

  const releaseDir = releaseDirFrom(args);
  const executable = findPackagedExecutable({ releaseDir });
  if (executable === undefined) {
    throw new Error(
      `no packaged build under ${releaseDir}\n` +
        'run `npm run package` first — this check is about the built app, not the source tree.',
    );
  }
  if (!statSync(executable).isFile()) {
    throw new Error(`not a file: ${executable}`);
  }

  process.stdout.write(`launching ${executable}\n`);

  // The build leads its own process group, so the terminal's `SIGINT` no
  // longer reaches it: the script has to stop it itself, and the run has to
  // end as an interruption rather than as a verdict on the build.
  const state = { child: null, interrupted: false, signal: null, exitCode: 0 };
  const onSignal = (signal) => {
    interruptRun(state, signal, { platform: process.platform });
    process.exitCode = state.exitCode;
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  const { output, reason } = await launch(executable, {
    timeoutMs,
    onChild: (child) => {
      state.child = child;
      // Interrupted before the build even existed: stop it as it appears.
      if (state.interrupted) interruptRun(state, state.signal, { platform: process.platform });
    },
  });

  if (state.interrupted) {
    process.stderr.write('\n[verify-packaged-adapters] interrupted; the build was stopped.\n');
    return;
  }

  if (reason === 'timeout') {
    throw new Error(
      `the build printed no \`adapters resolved:\` line within ${timeoutMs}ms.\n` +
        'On a headless machine the app needs a display: try\n' +
        `  xvfb-run node scripts/verify-packaged-adapters.mjs --timeout ${timeoutMs * 2}\n` +
        `output tail:\n${tailOf(output)}`,
    );
  }

  const problems = verifyResolution(output, { required });
  if (problems.length > 0) {
    throw new Error(`${problems.join('\n')}\noutput tail:\n${tailOf(output)}`);
  }

  const ids = resolvedAdapterIds(output) ?? [];
  process.stdout.write(`\n[ucad] packaged adapter check: OK\n`);
  process.stdout.write(`  executable: ${executable}\n`);
  process.stdout.write(`  adapters resolved: ${ids.join(', ')}\n`);
  process.stdout.write(
    '\nthis is the manual step the README names: no CI job packages the app, so keep the\n' +
      'result in the release notes rather than assuming a gate ran.\n',
  );
}

// Only run as a command; importing the helpers must launch nothing.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
