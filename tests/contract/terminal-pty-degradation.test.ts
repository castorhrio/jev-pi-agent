/**
 * §11.2 — what the product does when the optional `node-pty` is not there.
 *
 * ## The claim this file turns into a gate
 *
 * `pty-host.ts` says, in its header, that a missing native module "must not
 * break `npm install` or app startup" and that its absence is "reported as a
 * first-class, explained fact". `command-runner.ts` says the piped console "is
 * kept as the surface that works when the optional `node-pty` native module is
 * unavailable, which is why the panel still offers it". `TerminalPanel.tsx`
 * draws exactly that: one sentence carrying Main's own reason, and the command
 * console as the whole surface.
 *
 * Three files, one promise, and until this file no gate that could fail on it.
 * `tests/integration/pty-host.test.ts` asserts whichever branch the machine is
 * on — so on a developer machine with a working native build, the absent branch
 * is asserted nowhere, and the sentence a user would actually read is never
 * produced by any test. That is the shape this repository keeps naming: a
 * promise that is only checked where it is already true.
 *
 * ## How both directions are made reachable on one machine
 *
 * `tests/fixtures/pty-probe/hook.cjs` patches `Module._load` in a **child
 * process**, so `require('node-pty')` inside the built `@ucad/terminal` answers
 * `missing` or `present` on demand. Nothing in the product is stubbed: the
 * module under test is the built package, loaded the way Main loads it, and the
 * hook only decides what the optional dependency resolves to.
 *
 * ## What each direction asserts
 *
 *  - **missing** — `probePty()` reports unavailable with a reason that names
 *    `node-pty` and says what to do about it; `PtyHost.create()` refuses with
 *    `ADAPTER_NOT_AVAILABLE` **in that same sentence** (a second wording would
 *    be a second thing to keep true); and `CommandRunner` still runs a command
 *    and returns its output, which is the degradation claim itself.
 *  - **present** — `probePty()` reports available with no reason and no detail,
 *    and `create()` succeeds. Without this direction, a probe that always
 *    answered "unavailable" would pass the first one.
 *
 * ## What it deliberately does not check
 *
 * That a real shell runs. That is `tests/integration/pty-host.test.ts`, against
 * a real PTY, and it is skipped where there is none. This file is about the
 * answer the product gives when there is none — the answer that has to be right
 * on exactly the machines where the other file cannot run.
 */

import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '..', '..');
const HOOK = join(REPO_ROOT, 'tests', 'fixtures', 'pty-probe', 'hook.cjs');
const PROBE = join(REPO_ROOT, 'tests', 'fixtures', 'pty-probe', 'probe.cjs');
const PANEL = join(
  REPO_ROOT,
  'apps',
  'desktop',
  'src',
  'renderer',
  'src',
  'components',
  'TerminalPanel.tsx',
);

/** Printed by `probe.cjs` in front of its JSON, so a log line cannot be read as the answer. */
const MARKER = 'PTY-PROBE ';

interface ProbeAnswer {
  status: { available: boolean; reason: string | null; detail: string | null };
  create: { ok: boolean; terminalId?: string; message?: string; code?: string | null };
  console: { ok: boolean; text?: string; message?: string; code?: string | null };
}

/**
 * Runs the probe with `node-pty` answering `mode`.
 *
 * `cwd` is the repository root so `require('@ucad/terminal')` resolves through
 * the workspace symlink, exactly as it does in Main.
 */
function probe(mode: 'missing' | 'present'): ProbeAnswer {
  const result = spawnSync(process.execPath, ['--require', HOOK, PROBE], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, UCAD_PTY_STUB: mode },
    timeout: 60_000,
  });
  const line = (result.stdout ?? '')
    .split('\n')
    .find((candidate) => candidate.startsWith(MARKER));
  if (line === undefined) {
    throw new Error(
      `the probe printed no answer (exit ${String(result.status)}); stderr: ${result.stderr ?? ''}`,
    );
  }
  return JSON.parse(line.slice(MARKER.length)) as ProbeAnswer;
}

describe('without node-pty, the product says so instead of pretending', () => {
  const answer = probe('missing');

  it('reports the terminal as unavailable, with a reason a user can act on', () => {
    expect(answer.status.available).toBe(false);
    // The reason is the whole disclosure on screen, so it has to name the thing
    // that is missing and the thing to do about it — not "terminal unavailable".
    expect(answer.status.reason).toContain('node-pty');
    expect(answer.status.reason).toContain('npm install');
    expect((answer.status.reason ?? '').trim().length).toBeGreaterThan(20);
  });

  it('keeps the raw load error for the log, separate from the sentence', () => {
    // `detail` is never shown in the UI; it exists so the reason is not a guess.
    // A probe that reported the same string twice would lose the distinction.
    expect(answer.status.detail).toContain("Cannot find module 'node-pty'");
    expect(answer.status.detail).not.toBe(answer.status.reason);
  });

  it('refuses to create a terminal, in the same sentence the panel shows', () => {
    expect(answer.create.ok).toBe(false);
    expect(answer.create.code).toBe('ADAPTER_NOT_AVAILABLE');
    // One wording, not two: a second sentence here would be a second thing to
    // keep true, and the panel prints `availability.reason`.
    expect(answer.create.message).toBe(answer.status.reason);
  });

  it('still runs a command through the piped console', () => {
    // The degradation claim: the PTY is gone, the command channel is not. This
    // is why `TerminalPanel` keeps offering `CommandConsole` in that state.
    expect(answer.console.ok, answer.console.message ?? '').toBe(true);
    expect(answer.console.text).toContain('ucad-pty-probe-console-marker');
  });
});

describe('with node-pty, the probe does not report a false absence', () => {
  const answer = probe('present');

  it('reports the terminal as available, with no reason and no detail', () => {
    // The other direction of the same assertion. Without it, a `probePty()`
    // that always answered "unavailable" would pass the block above.
    expect(answer.status.available).toBe(true);
    expect(answer.status.reason).toBeNull();
    expect(answer.status.detail).toBeNull();
  });

  it('creates a terminal, so the positive answer is one something can use', () => {
    expect(answer.create.ok, answer.create.message ?? '').toBe(true);
    expect(answer.create.terminalId).toMatch(/^pty_/);
  });
});

describe('the two directions are decided by the hook, not by the machine', () => {
  it('answers differently for the two modes', () => {
    // If the hook were ignored, both runs would report the same thing and every
    // assertion above would be measuring this machine's native build instead of
    // the branch it claims to measure.
    expect(probe('missing').status.available).not.toBe(probe('present').status.available);
  });

  it('refuses to pick an answer for itself', () => {
    // A hook that defaulted to one mode would make the two runs above identical
    // and green. It exits non-zero and names the variable instead.
    const result = spawnSync(process.execPath, ['--require', HOOK, PROBE], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: { ...process.env, UCAD_PTY_STUB: '' },
      timeout: 60_000,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('UCAD_PTY_STUB');
  });
});

describe('the screen is wired to that answer', () => {
  const panel = readFileSync(PANEL, 'utf8');

  it('prints Main’s own reason rather than a second wording', () => {
    // The panel is the only place a user meets this state, and it must show the
    // sentence `probePty()` produced — not a translation of it.
    expect(panel).toContain('reason: availability.reason');
  });

  it('offers the command console exactly when the PTY is unavailable', () => {
    // "The command channel is the only working surface, so it is the *whole*
    // surface" — the comment above this line. Asserted as wiring, because the
    // console being drawn unconditionally would hide the state instead of
    // reporting it.
    expect(panel).toContain('{availability !== null && !ptyReady && <CommandConsole api={api} />}');
  });
});
