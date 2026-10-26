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
 * judgement without packaging anything. Only `launch` touches a real process.
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
function parseArgs(argv) {
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

/** The last few lines of a launch, for a failure message a terminal can show. */
export function tailOf(output, lines = 25) {
  return output.split('\n').filter((line) => line.trim().length > 0).slice(-lines).join('\n');
}

/**
 * Launch the build and collect its output until the summary line appears.
 *
 * Resolves with the captured output — the caller judges it — and never waits for
 * the app to exit: a packaged UCAD is a tray app that would sit there until
 * killed. The process is stopped as soon as the line is seen, with the tree
 * killed on Windows where `kill()` alone can leave the Chromium children.
 *
 * `timeoutMs` is a real bound rather than decoration: a build that fails to
 * start (no display, a missing DLL, a sandbox refusal as root) prints an error
 * and keeps running, and a check that hangs is reported as a broken repository.
 */
export function launch(executable, { timeoutMs = 45_000 } = {}) {
  return new Promise((resolvePromise) => {
    let output = '';
    let settled = false;
    let timer;

    const child = spawn(executable, [], {
      // `ignore` for stdin: the app must not inherit a terminal and wait on it.
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
      windowsHide: true,
    });

    const finish = (reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stop(child);
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

/** Stop the launched app, and its children on the platforms that need it. */
function stop(child) {
  if (child.exitCode !== null) return;
  if (process.platform === 'win32' && typeof child.pid === 'number') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }).on(
      'error',
      () => child.kill(),
    );
    return;
  }
  child.kill('SIGTERM');
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

  const releaseDir = typeof args.release === 'string' ? resolve(root, args.release) : RELEASE_DIR;
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
  const { output, reason } = await launch(executable, { timeoutMs });

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
