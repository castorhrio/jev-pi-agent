/**
 * Answers `require('node-pty')` one of two ways, before any module loads.
 *
 * ## Why a child process and a `--require` hook
 *
 * `node-pty` is an **optional** dependency, so the branch that matters most —
 * "the native module is not there" — is the branch a developer machine almost
 * never takes. `tests/integration/pty-host.test.ts` asserts whichever branch
 * the machine happens to be on, which means the absent branch is asserted on
 * machines without a native build and nowhere else. A gate that only runs on
 * the machines that already have the thing it is about is not a gate.
 *
 * Patching `Module._load` in a child process makes both answers reachable on
 * any machine, and it patches the **real** resolution path: `pty-host.ts` calls
 * `require('node-pty')` inside a `try`/`catch`, and this hook is what that call
 * meets. Nothing in the product is stubbed, replaced or imported differently —
 * the module under test is the built `@ucad/terminal`, loaded the way Main
 * loads it.
 *
 * ## The two answers
 *
 *  - `UCAD_PTY_STUB=missing` — the require throws `MODULE_NOT_FOUND`, which is
 *    what a machine whose native build failed actually sees.
 *  - `UCAD_PTY_STUB=present` — the require returns a module that exports
 *    `spawn`, which is the shape `probePty()` accepts. The fake PTY is inert:
 *    it records listeners and does nothing, because the question here is
 *    "does the probe report a usable module", not "does a shell run".
 *
 * An unrecognised value throws rather than defaulting: a hook that silently
 * picked one answer would make both directions of the test measure the same
 * thing, which is the class of defect this repository keeps naming.
 */

'use strict';

const Module = require('node:module');

const MODE = process.env.UCAD_PTY_STUB;

if (MODE !== 'missing' && MODE !== 'present') {
  throw new Error(
    `UCAD_PTY_STUB must be "missing" or "present", got ${JSON.stringify(MODE ?? null)}`,
  );
}

/** The slice of `node-pty` `PtyHost` uses, with every effect removed. */
function inertPty() {
  return {
    pid: 4242,
    write() {},
    resize() {},
    kill() {},
    onData() {},
    onExit() {},
  };
}

const load = Module._load;

Module._load = function patchedLoad(request, ...rest) {
  if (request !== 'node-pty') {
    return load.call(this, request, ...rest);
  }
  if (MODE === 'missing') {
    const error = new Error("Cannot find module 'node-pty'");
    error.code = 'MODULE_NOT_FOUND';
    throw error;
  }
  return { spawn: () => inertPty() };
};
