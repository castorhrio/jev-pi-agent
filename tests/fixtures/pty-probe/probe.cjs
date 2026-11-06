/**
 * Asks the built `@ucad/terminal` the three questions the degradation contract
 * is about, and prints the answers as one JSON line.
 *
 * Run as `node --require hook.cjs probe.cjs` (see `hook.cjs` for why the
 * `node-pty` answer is decided by a hook rather than by the machine). The three
 * questions, in the order the product asks them:
 *
 *  1. `probePty()` — what the panel is told before it offers a terminal at all;
 *  2. `PtyHost.create()` — what happens if something asks anyway;
 *  3. `CommandRunner.run()` — whether the piped console still works, which is
 *     the whole reason `TerminalPanel` keeps offering it when the PTY is gone
 *     (`command-runner.ts` header: "the surface that works when the optional
 *     `node-pty` native module is unavailable").
 *
 * Plain CommonJS on purpose: it is loaded by `node` directly, with no build
 * step in between, and it must resolve `@ucad/terminal` exactly as Main does.
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** Printed before the JSON so a stray log line cannot be mistaken for it. */
const MARKER = 'PTY-PROBE ';

/** The text the console is asked to produce; the test looks for exactly this. */
const CONSOLE_MARKER = 'ucad-pty-probe-console-marker';

function describeError(error) {
  if (error === null || typeof error !== 'object') {
    return { message: String(error), code: null };
  }
  const appError = error.appError;
  return {
    message: typeof error.message === 'string' ? error.message : String(error),
    code: typeof appError?.code === 'string' ? appError.code : null,
  };
}

async function main() {
  const terminal = require('@ucad/terminal');
  const { silentLogger } = require('@ucad/observability');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ucad-pty-probe-'));
  const answer = {
    status: terminal.probePty(),
    create: null,
    console: null,
  };

  const host = new terminal.PtyHost({ logger: silentLogger('pty-probe') });
  try {
    const created = await host.create({ workspaceRoot: root, cwd: '.', cols: 80, rows: 24 });
    answer.create = { ok: true, terminalId: created.terminalId };
  } catch (error) {
    answer.create = { ok: false, ...describeError(error) };
  }
  await host.killAll().catch(() => undefined);

  const runner = new terminal.CommandRunner({
    logger: silentLogger('console-probe'),
    // `CommandRunner` never consults the engine: the decision arrives on the
    // input and `isAllowDecision()` is what gates the spawn. An empty object is
    // the honest stand-in for "this probe is not asking a policy question".
    permissions: {},
  });
  const chunks = [];
  try {
    for await (const chunk of runner.run({
      sessionId: 'probe-session',
      turnId: 'probe-turn',
      workspaceRoot: root,
      command: process.execPath,
      args: ['-e', `process.stdout.write(${JSON.stringify(CONSOLE_MARKER)})`],
      permissionDecision: 'allow_once',
    })) {
      chunks.push(chunk.chunk);
    }
    answer.console = { ok: true, text: chunks.join('') };
  } catch (error) {
    answer.console = { ok: false, ...describeError(error) };
  }

  fs.rmSync(root, { recursive: true, force: true });
  process.stdout.write(`${MARKER}${JSON.stringify(answer)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
