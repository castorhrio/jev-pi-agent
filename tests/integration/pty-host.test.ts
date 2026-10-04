/**
 * §11.2 — the User Terminal, against a real PTY.
 *
 * These tests deliberately do NOT skip. `node-pty` is an optional dependency,
 * so it may legitimately be absent on a machine whose native build failed — but
 * an absent PTY is a product state the user is shown, so it gets asserted just
 * as hard as a working one. The unavailable branch checks that
 * {@link probePty} explains itself and that `create()` refuses in those words,
 * which is the difference between "the terminal is not installed" and a pane
 * that looks like a command that produced no output.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { silentLogger } from '@ucad/observability';
import { PtyHost, probePty, type PtyDataEvent, type PtyExitEvent } from '@ucad/terminal';

/** ESC + [ — the head of every ANSI sequence a real terminal emits.
/** Enter. A pty expects the key, not a line-feed. */
const ESC_OPEN = String.fromCharCode(27) + '[';
const ENTER = '\r';

interface Harness {
  host: PtyHost;
  received: PtyDataEvent[];
  exits: PtyExitEvent[];
  root: string;
  text: () => string;
  /** Resolves with everything received so far once `needle` shows up. */
  waitFor: (needle: string, timeoutMs?: number) => Promise<string>;
}

/**
 * A tiny collector. The host is already rate-bounded in Main, so this only has
 * to be correct, not clever.
 */
function harness(): Harness {
  const root = mkdtempSync(path.join(tmpdir(), 'ucad-pty-'));
  const received: PtyDataEvent[] = [];
  const exits: PtyExitEvent[] = [];
  const host = new PtyHost({
    logger: silentLogger('pty-test'),
    onData: (event) => received.push(event),
    onExit: (event) => exits.push(event),
  });
  const text = (): string => received.map((event) => event.chunk).join('');
  return {
    host,
    received,
    exits,
    root,
    text,
    waitFor: async (needle, timeoutMs = 15_000) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const all = text();
        if (all.includes(needle)) return all;
        if (Date.now() > deadline) {
          throw new Error(
            `timed out after ${timeoutMs}ms waiting for ${JSON.stringify(needle)}; got ${JSON.stringify(all.slice(-600))}`,
          );
        }
        await delay(25);
      }
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** `process.kill(pid, 0)` is the only portable "is it still there" probe. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilGone(pid: number, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!isAlive(pid)) return true;
    if (Date.now() > deadline) return false;
    await delay(50);
  }
}

/** A command that prints ~200 KB, whatever the platform. */
const BURST_COMMAND = `"${process.execPath}" -e "process.stdout.write('A'.repeat(200000))"`;

const live: PtyHost[] = [];

afterEach(async () => {
  // Never leave a ConPTY worker attached to a test process: that is exactly the
  // state that aborts a real Electron process on exit.
  for (const host of live.splice(0)) {
    await host.killAll().catch(() => undefined);
  }
});

describe('PtyHost availability', () => {
  it('either provides a working PTY or explains, in words, why it cannot', async () => {
    const status = probePty();
    if (status.available) {
      expect(status.reason).toBeNull();
      return;
    }

    // The absent branch is the one that used to be silently invisible.
    expect(typeof status.reason, 'an absent PTY must carry a reason').toBe('string');
    expect((status.reason ?? '').trim().length).toBeGreaterThan(10);
    expect(status.reason).toContain('node-pty');
    // The raw error is for the log, not the UI — but it must exist, or the
    // reason is a guess.
    expect(typeof status.detail).toBe('string');

    const h = harness();
    live.push(h.host);
    await expect(
      h.host.create({ workspaceRoot: h.root, cwd: '.', cols: 80, rows: 24 }),
    ).rejects.toThrow(/node-pty/);
  });
});

describe.skipIf(!probePty().available)('PtyHost', () => {
  it('spawns a real terminal, round-trips a marker, and kills the process', async () => {
    const h = harness();
    live.push(h.host);
    const marker = `UCAD_PTY_${Date.now()}`;

    const { terminalId } = await h.host.create({
      workspaceRoot: h.root,
      cwd: '.',
      cols: 100,
      rows: 30,
    });

    const pid = h.host.pidOf(terminalId);
    expect(pid, 'a live PTY must report a pid').not.toBeNull();
    expect(h.host.isRunning(terminalId)).toBe(true);
    expect(h.host.count).toBe(1);

    h.host.write(terminalId, `echo ${marker}${ENTER}`);
    const all = await h.waitFor(marker);

    // A pipe would carry the text and nothing else. A PTY is a terminal: it
    // drives the cursor and repaints, which is the whole point of §11.2 and the
    // reason `vim` was unusable before.
    expect(all, 'a PTY must emit cursor addressing, not just bytes').toContain(ESC_OPEN);

    await h.host.kill(terminalId);
    expect(h.host.isRunning(terminalId)).toBe(false);
    expect(h.host.pidOf(terminalId)).toBeNull();
    expect(await waitUntilGone(pid as number), `pid ${pid} survived the kill`).toBe(true);
  });

  it('supports several terminals at once and tears them all down', async () => {
    const h = harness();
    live.push(h.host);

    const first = await h.host.create({ workspaceRoot: h.root, cwd: '.', cols: 80, rows: 24 });
    const second = await h.host.create({ workspaceRoot: h.root, cwd: '.', cols: 90, rows: 40 });
    expect(first.terminalId).not.toBe(second.terminalId);
    expect(h.host.count).toBe(2);

    const firstPid = h.host.pidOf(first.terminalId) as number;
    const secondPid = h.host.pidOf(second.terminalId) as number;

    h.host.write(second.terminalId, `echo SECOND${ENTER}`);
    await h.waitFor('SECOND');

    // §11.2 teardown: `app.exit()` with a live ConPTY worker is a 0xC0000409, so
    // `killAll()` has to leave nothing running. This is the code path the app
    // runs on quit.
    await h.host.killAll();
    expect(h.host.count).toBe(0);
    expect(await waitUntilGone(firstPid), `pid ${firstPid} survived killAll`).toBe(true);
    expect(await waitUntilGone(secondPid), `pid ${secondPid} survived killAll`).toBe(true);
  });

  it('resizes without dropping the session, and clamps absurd sizes', async () => {
    const h = harness();
    live.push(h.host);
    const { terminalId } = await h.host.create({
      workspaceRoot: h.root,
      cwd: '.',
      cols: 80,
      rows: 24,
    });

    h.host.resize(terminalId, 120, 40);
    h.host.resize(terminalId, 0, -5); // a collapsed pane must not reach the pty
    expect(h.host.isRunning(terminalId)).toBe(true);

    const marker = `UCAD_RESIZE_${Date.now()}`;
    h.host.write(terminalId, `echo ${marker}${ENTER}`);
    await h.waitFor(marker);
  });

  it('chunks and coalesces a burst instead of pushing it whole (NFR-06)', async () => {
    const h = harness();
    live.push(h.host);
    const { terminalId } = await h.host.create({
      workspaceRoot: h.root,
      cwd: '.',
      cols: 80,
      rows: 24,
    });

    h.host.write(terminalId, `${BURST_COMMAND}${ENTER}`);
    const deadline = Date.now() + 20_000;
    let length = 0;
    while (length < 200_000 && Date.now() < deadline) {
      await delay(50);
      length = h.text().length;
    }

    expect(length, 'the burst never arrived').toBeGreaterThan(200_000);
    // Nothing is lost by the chunking — it is a transport detail, not a cut.
    for (const event of h.received) {
      expect(Buffer.byteLength(event.chunk, 'utf8')).toBeLessThanOrEqual(64 * 1024);
    }
    // And the burst did not arrive as 200 000 separate pushes.
    expect(h.received.length, 'output was not coalesced').toBeLessThan(2000);
  });

  it('refuses a cwd outside the workspace', async () => {
    const h = harness();
    live.push(h.host);
    await expect(
      h.host.create({ workspaceRoot: h.root, cwd: '..', cols: 80, rows: 24 }),
    ).rejects.toThrow();
    expect(h.host.count).toBe(0);
  });

  it('refuses to write to a terminal it does not own', () => {
    const h = harness();
    live.push(h.host);
    expect(() => h.host.write('pty_does_not_exist', 'x')).toThrow();
  });

  it('spawns the platform shell, not a bare process', async () => {
    // Guards the Windows correctness rule in `pty-host.ts`: ConPTY needs
    // `name: 'xterm-color'` and an inherited PATH, or the session is unusable
    // in ways that look like "the terminal is broken".
    const h = harness();
    live.push(h.host);
    const { terminalId } = await h.host.create({
      workspaceRoot: h.root,
      cwd: '.',
      cols: 80,
      rows: 24,
    });
    h.host.write(terminalId, `echo SHELLCHECK${ENTER}`);
    await h.waitFor('SHELLCHECK');
  });
});