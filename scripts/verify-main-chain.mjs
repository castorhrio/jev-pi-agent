/**
 * The main chain, run on a real desktop session, with the evidence printed.
 *
 * ## Why this file exists
 *
 * `docs/manual-verification.md` asks six questions that no automated gate can
 * answer: does a real turn produce a checkable injected text and hash, does the
 * decision plane say *why*, does a handoff carry, does the update check survive
 * a real network, does closing the window do what the setting says. Every one of
 * them needs an Electron process, an OS key store and a display.
 *
 * They also need a machine that is not this one most of the time, so the run
 * used to end as "not performed on a real machine" — and a checklist nobody can
 * re-run quietly turns into a checklist nobody reads. This script makes the run
 * a command: it launches the built app under whatever display the caller has
 * (`xvfb-run` counts), drives the same surfaces a person would over the DevTools
 * protocol, and prints the lines the document asks for — hashes, injected bytes,
 * decision rationales, update states, process lifetimes.
 *
 * It is a *verifier*, not a test suite: each step asserts the observable
 * behaviour a human would read off the screen, and a step that cannot show it
 * fails rather than skipping. It is deliberately not in CI — the key store, the
 * tray and the vendor network are exactly what a container cannot provide, and a
 * job that flakes there takes the claim with it.
 *
 * ## The preconditions it can check for you
 *
 * On Linux, Chromium chooses its key store backend from the *declared* desktop
 * environment, so `org.freedesktop.secrets` answering on the session bus is not
 * enough: with no `XDG_CURRENT_DESKTOP`, `safeStorage` reports "encryption is
 * not available" and the app stops before a window exists. The script declares a
 * desktop for the child when the caller has not, and stops early with that
 * sentence when the key store still refuses — that is a machine problem, not a
 * product defect, and it should read like one.
 *
 * ## Usage
 *
 * ```bash
 * npm run package                       # once, writes release/
 * xvfb-run -a node scripts/verify-main-chain.mjs
 * ```
 *
 * Optional flags: `--exec <path>` (the built executable, when `release/` holds
 * more than one), `--home <dir>` (a throwaway profile; default
 * `<tmp>/ucad-main-chain`), `--project <dir>` (a throwaway project), `--steps
 * 1,2,3,4,5`, `--port <n>`, `--json <file>`, `--timeout 420000`, `--keep` (leave
 * the app and its profile in place), `--feed-url <https url>` (check the happy
 * path against this feed instead of the shipped one, for hosts that cannot
 * reach `github.com`).
 *
 * Two things this script cannot do, and does not claim: it writes the
 * workspace row instead of answering the native folder picker, so no trust
 * dialog is on screen; and the five fixture scenarios (step 6) belong to
 * `npm run dev:web`, which a human still walks by eye.
 *
 * The second one is now a refusal rather than a quiet nothing: `--steps`
 * accepts 1–5, and `--steps 6` stops the run with the reason instead of
 * exiting 0 having driven no step at all (see `parseSteps()`).
 *
 * The tray menu used to be a third: a native object no DevTools method reaches,
 * so step 5 printed the labels and asked a person to read them off the screen.
 * The app now writes the menu it built to its own log (`tray menu built`), and
 * step 5 asserts the three items from that line — the menu is checked, not
 * described.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import sqlite3Wasm from 'node-sqlite3-wasm';

// `node-sqlite3-wasm` is CommonJS: a named import throws at load in a `.mjs`,
// so the destructuring happens one line below the default import.
const { Database: WasmDatabase } = sqlite3Wasm;

// ---------------------------------------------------------------------------
// what this script can drive, and what it refuses to pretend to drive
// ---------------------------------------------------------------------------

/**
 * The steps this file actually drives.
 *
 * A value rather than a range, because of what the parse below used to do:
 * take whatever followed `--steps`, keep the tokens that looked like numbers,
 * and print `PASS` at the end regardless of what was left. `--steps 6` — step 6
 * is the five fixture states a person walks by eye under `npm run dev:web` —
 * launched the app, drove nothing, recorded nothing, and ended with
 * `PASS — steps 6 recorded above`. A verifier whose silence reads as a pass is
 * worse than no verifier: the transcript looks green and proves nothing.
 *
 * `tests/contract/verify-main-chain.test.ts` pins this list against the
 * `wants(n)` dispatch in `main()` in both directions, so a step declared here
 * with no function behind it — or a `wants(n)` with no entry here — is red
 * instead of being silently skipped.
 */
export const DRIVEN_STEPS = Object.freeze([1, 2, 3, 4, 5]);

/** The steps that belong to a human at another command, and why. */
export const MANUAL_STEPS = Object.freeze({
  6: 'the five fixture states are walked by eye under `npm run dev:web`',
});

/**
 * What `--steps` asked for, and every token that cannot be honoured.
 *
 * `rejected` is not a warning list: a non-empty one stops the run before the
 * app is launched. Half-honouring a request — `--steps 1,2,6` driving the first
 * two and quietly dropping the third — is the reading this returns instead of.
 */
export function parseSteps(raw) {
  const tokens = String(raw)
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean);
  const steps = [];
  const rejected = [];
  for (const token of tokens) {
    if (!/^\d+$/.test(token)) {
      rejected.push({ token, reason: `\`${token}\` is not a step number` });
      continue;
    }
    const step = Number(token);
    if (Object.hasOwn(MANUAL_STEPS, step)) {
      rejected.push({ token, reason: `step ${step} is not this script's to drive: ${MANUAL_STEPS[step]}` });
      continue;
    }
    if (!DRIVEN_STEPS.includes(step)) {
      rejected.push({
        token,
        reason: `there is no step ${step}; this script drives ${DRIVEN_STEPS.join(', ')}`,
      });
      continue;
    }
    if (!steps.includes(step)) steps.push(step);
  }
  if (steps.length === 0 && rejected.length === 0) {
    rejected.push({ token: '', reason: `no steps requested; pass e.g. --steps ${DRIVEN_STEPS.join(',')}` });
  }
  return { steps, rejected };
}

/**
 * The requested steps that ended up neither passing nor failing.
 *
 * Every branch inside a step is supposed to end in `pass()` or `fail()`. A step
 * that ends in neither has taken a path nobody wrote — a selector that stopped
 * matching and an `if` with no `else`, which is how a check for "the screen says
 * X" degrades into a check for nothing while still printing evidence. The run's
 * own verdict reads this, so "no complaint and no evidence" is a failure at the
 * end of the transcript rather than the silence that used to pass for success.
 */
export function stepCoverage({ requested, passed, failed }) {
  return requested
    .filter((step) => !failed.includes(step) && !passed.includes(step))
    .map((step) => ({
      step,
      message: 'the step neither passed nor failed, so nothing about it was verified',
    }));
}

// ---------------------------------------------------------------------------
// arguments
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);

function flag(name, fallback) {
  const at = argv.indexOf(`--${name}`);
  if (at === -1) return fallback;
  const next = argv[at + 1];
  return next === undefined || next.startsWith('--') ? fallback : next;
}

/** What `--steps` asked for, and why the run will refuse to start, if it will. */
const STEP_REQUEST = parseSteps(flag('steps', DRIVEN_STEPS.join(',')));
const STEPS = STEP_REQUEST.steps;
const PORT = Number(flag('port', 9411));
const TIMEOUT_MS = Number(flag('timeout', 420000));
const KEEP = argv.includes('--keep');
const JSON_OUT = flag('json', null);
const HOME = path.resolve(flag('home', path.join(tmpdir(), 'ucad-main-chain')));
const PROJECT = path.resolve(flag('project', path.join(HOME, 'project')));
const EXEC = path.resolve(flag('exec', defaultExecutable()));
/**
 * The feed the happy path checks against, when the shipped one cannot be
 * reached from this host.
 *
 * The shipped feed lives on `github.com`, and a verification host behind a
 * network that drops that host would otherwise record step 4 as "the product
 * cannot update" — a claim about the network wearing the product's name. The
 * flag points the *same* code path (real TLS, real JSON, real version compare)
 * at a real https document instead, and the run records which URL it used so
 * the record says what was actually measured.
 */
const FEED_URL = flag('feed-url', null);

/**
 * Where a profile's own data lives: the directory `app.getPath('userData')`
 * resolves to for the `HOME` handed to the child.
 *
 * Windows is asked for because the document says the six steps must be run
 * there, and a script that only reads the Linux layout would fail at the step
 * that matters most. `platform` is injectable for the same reason: the test that
 * pins it runs on Linux.
 */
export function profileDataDir(home, platform = process.platform) {
  return platform === 'win32'
    ? path.join(home, 'AppData', 'Roaming', 'ucad')
    : path.join(home, '.config', 'ucad');
}

/**
 * The environment a verification child is launched with.
 *
 * Two things are decided here and both are assertable without a desktop: the
 * key store is only asked for when the desktop is *declared* (`XDG_CURRENT_DESKTOP`
 * is what selects Chromium's backend, and the absence of it is what made a whole
 * run read as "no keyring"), and the session bus the keyring lives on is
 * inherited rather than invented.
 */
export function appEnv(
  home,
  extra,
  { platform = process.platform, parentEnv = process.env } = {},
) {
  const env = {
    PATH: parentEnv.PATH || '/usr/bin:/bin',
    HOME: home,
    ...(platform === 'win32'
      ? {
          SYSTEMROOT: parentEnv.SYSTEMROOT,
          USERPROFILE: home,
          APPDATA: path.join(home, 'AppData', 'Roaming'),
          LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
        }
      : {}),
  };
  for (const key of ['XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'DISPLAY', 'XAUTHORITY']) {
    if (parentEnv[key]) env[key] = parentEnv[key];
  }
  // The reason the whole run exists: an undeclared desktop selects no key store
  // backend at all, which is not what "a desktop session" is supposed to mean.
  env.XDG_CURRENT_DESKTOP = parentEnv.XDG_CURRENT_DESKTOP || 'GNOME';
  env.DESKTOP_SESSION = parentEnv.DESKTOP_SESSION || 'gnome';
  if (platform !== 'win32') env.ELECTRON_DISABLE_SANDBOX = '1';
  return { ...env, ...extra };
}

const DB_IN_PROFILE = path.join(profileDataDir(HOME), 'ucad.db');

function defaultExecutable() {
  const candidates =
    process.platform === 'win32'
      ? [path.join('release', 'win-unpacked', 'UCAD.exe')]
      : process.platform === 'darwin'
        ? [path.join('release', 'mac', 'UCAD.app', 'Contents', 'MacOS', 'UCAD')]
        : [path.join('release', 'linux-unpacked', 'ucad')];
  for (const candidate of candidates) {
    const abs = path.resolve(candidate);
    if (existsSync(abs)) return abs;
  }
  return path.resolve(candidates[0]);
}

const wants = (step) => STEPS.includes(step);

// ---------------------------------------------------------------------------
// evidence
// ---------------------------------------------------------------------------

const evidence = [];
const failures = [];
/** Every step that reached a `pass()`, in the order it got there. */
const passedSteps = new Set();

function record(step, key, value) {
  const line = `${step}:${key}=${value}`;
  evidence.push(line);
  console.log(`[evidence] ${line}`);
}

function fail(step, message) {
  failures.push({ step, message });
  console.error(`[FAIL] step ${step}: ${message}`);
}

function pass(step, message) {
  passedSteps.add(step);
  console.log(`[ok] step ${step}: ${message}`);
}

// ---------------------------------------------------------------------------
// launching the app, and reading what it says
// ---------------------------------------------------------------------------

class AppRun {
  constructor(child, { home, port }) {
    this.child = child;
    this.home = home;
    this.port = port;
    this.lines = [];
    this.exited = null;
    this.cdp = null;
    const collect = (chunk) => {
      for (const line of chunk.toString().split(/\r?\n/)) if (line.trim()) this.lines.push(line);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('exit', (code, signal) => {
      this.exited = { code, signal };
    });
  }

  static launch({ home, port, feedOverride }) {
    if (!existsSync(EXEC)) throw new Error(`no built executable at ${EXEC}; run \`npm run package\``);
    mkdirSync(home, { recursive: true });
    const env = appEnv(home, feedOverride === undefined ? {} : { UCAD_UPDATE_FEED: feedOverride });
    const child = spawn(EXEC, ['--no-sandbox', `--remote-debugging-port=${port}`], {
      cwd: path.dirname(EXEC),
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
    return new AppRun(child, { home, port });
  }

  async waitFor(re, timeoutMs) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const hit = this.lines.find((line) => re.test(line));
      if (hit) return hit;
      if (this.exited) break;
      await sleep(200);
    }
    return null;
  }

  /**
   * The app's own log file, which is where its refusals are written.
   *
   * `FileLogSink` is an async write stream, so the line arrives a moment after
   * the decision was made, and stdout carries only what the process `console`d.
   * Anything that asks "did the app say why" has to read this file.
   */
  get logFile() {
    return path.join(profileDataDir(this.home), 'logs', 'app.log');
  }

  async logLines() {
    try {
      return (await readFile(this.logFile, 'utf8')).split(/\r?\n/).filter(Boolean);
    } catch {
      return [];
    }
  }

  async waitForLog(re, timeoutMs) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const hit = (await this.logLines()).find((line) => re.test(line));
      if (hit) return hit;
      if (this.exited && (await this.logLines()).length) break;
      await sleep(300);
    }
    return null;
  }

  async waitForKeyFile(filePath, timeoutMs) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      if (existsSync(filePath)) return true;
      if (this.exited) return false;
      await sleep(250);
    }
    return false;
  }

  /**
   * Whether the renderer target still exists.
   *
   * A renderer-initiated `window.close()` destroys the page target even when the
   * window is only hidden, so "the page stopped answering" has two causes and
   * they are not the same finding: a destroyed target means the window is off
   * screen, a live-but-silent one means the renderer hung with the window up.
   */
  async hasPageTarget() {
    try {
      const res = await fetch(`http://127.0.0.1:${this.port}/json/list`);
      return (await res.json()).some((t) => t.type === 'page');
    } catch {
      return false;
    }
  }

  /** The renderer target, once the app has a window. */
  async attach(timeoutMs = 90000) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      if (this.exited) {
        const stopped = this.lines.find((l) => /startup stopped|fatal startup error|Encryption is not available/.test(l));
        throw new Error(`the app stopped before a window: ${stopped ?? JSON.stringify(this.exited)}`);
      }
      try {
        const res = await fetch(`http://127.0.0.1:${this.port}/json/list`);
        const pages = (await res.json()).filter((t) => t.type === 'page');
        if (pages.length) {
          this.target = pages[0];
          this.cdp = await Cdp.attach(pages[0].webSocketDebuggerUrl);
          return this.cdp;
        }
      } catch {
        /* the inspector is not listening yet */
      }
      await sleep(250);
    }
    throw new Error('no renderer target within the timeout (is the display usable?)');
  }

  async stop() {
    if (KEEP || this.exited || this.stopped) return;
    this.stopped = true;
    try {
      // Raced, not awaited: `Browser.close` takes the connection down with it,
      // so the reply never arrives and a bare `await` would hang the run with
      // nothing left on the event loop to wake it.
      await Promise.race([this.cdp?.send('Browser.close'), sleep(1500)]);
    } catch {
      /* already gone */
    }
    await sleep(500);
    if (this.exited) return;
    try {
      process.kill(-this.child.pid, 'SIGKILL');
    } catch {
      this.child.kill('SIGKILL');
    }
    await sleep(300);
  }
}

// ---------------------------------------------------------------------------
// a minimal DevTools protocol client (Node's global WebSocket; no new deps)
// ---------------------------------------------------------------------------

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    ws.addEventListener('message', (event) => {
      let msg;
      try {
        msg = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    });
  }

  static async attach(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('the CDP websocket failed to open')), { once: true });
    });
    const cdp = new Cdp(ws);
    await cdp.send('Runtime.enable');
    return cdp;
  }

  send(method, params = {}) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression, { timeoutMs = 150000 } = {}) {
    const raced = await Promise.race([
      this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }),
      sleep(timeoutMs, 'timeout'),
    ]);
    if (raced === 'timeout') throw new Error(`the page script timed out after ${timeoutMs}ms`);
    if (raced.exceptionDetails) {
      const detail = raced.exceptionDetails.exception?.description ?? JSON.stringify(raced.exceptionDetails);
      throw new Error(`the page script threw: ${String(detail).split('\n')[0]}`);
    }
    return raced.result.value;
  }
}

/**
 * The page-side helpers every step shares.
 *
 * Inlined as source because that is what DevTools speaks. `runPage` is the only
 * place caller values reach the script, and each one goes through
 * `JSON.stringify`, so a path or a label can never become code.
 */
const HELPERS = `
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (s) => document.querySelector(s);
const byText = (text) => [...document.querySelectorAll('button')].find((b) => (b.innerText || '').trim().includes(text));
const panel = () => q('.workspace, .surface, main') || document.body;
function setNative(el, value) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLSelectElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}
async function openSurface(name) {
  let b = q('button[data-surface="' + name + '"]');
  if (!b) {
    const more = q('button.more-toggle');
    if (more) { more.click(); await sleep(400); }
    b = q('button[data-surface="' + name + '"]');
  }
  if (!b) return false;
  b.click();
  await sleep(900);
  return true;
}
function readHash() {
  const label = [...document.querySelectorAll('*')].find((e) => e.children.length === 0 && e.textContent.trim() === 'renderedHash');
  if (!label) return null;
  const box = label.closest('div,section') ? label.closest('div,section').parentElement : label.parentElement;
  const code = box ? box.querySelector('.code') : null;
  const value = code ? code.textContent.trim() : null;
  return value && /^[0-9a-f]{16,}$/i.test(value) ? value : null;
}
/**
 * Wait until the window is a working application, not a mounted shell.
 *
 * The composer's pickers are disabled until the workspace row has been read
 * back, so "the select exists" is not the same as "the app is ready": a step
 * that starts typing the moment a renderer target appears types into a
 * disabled control and reads the result as a product defect. The wait is on
 * the enabled state, which is the app's own signal that it has a project.
 */
async function waitForApp(ms = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const sel = q('select[aria-label="Agent"]');
    if (sel && !sel.disabled) return Date.now() - t0;
    await sleep(400);
  }
  const sel = q('select[aria-label="Agent"]');
  throw new Error(
    sel
      ? 'the composer stayed disabled: the app never restored a project'
      : 'the composer never rendered: no select[aria-label="Agent"] in the window',
  );
}
async function sendTurn(objective) {
  await waitForApp();
  const agentSel = q('select[aria-label="Agent"]');
  if (![...agentSel.options].some((o) => o.value === 'mock')) throw new Error('the agent picker has no mock entry');
  setNative(agentSel, 'mock');
  setNative(q('textarea[aria-label="任务描述"]'), objective);
  await sleep(200);
  const send = byText('发送');
  if (!send) throw new Error('no send button');
  send.click();
  const t0 = Date.now();
  while (Date.now() - t0 < 90000) {
    await sleep(1200);
    const hash = readHash();
    if (hash) return { hash, waitedMs: Date.now() - t0 };
  }
  throw new Error('no renderedHash appeared within 90s of sending');
}
`;

function runPage(cdp, body, timeoutMs) {
  return cdp.evaluate(`(async () => {\n${HELPERS}\n${body}\n})()`, { timeoutMs });
}

// ---------------------------------------------------------------------------
// the workspace seed
// ---------------------------------------------------------------------------

/**
 * Give the profile a project, the way a person's second session would have one.
 *
 * The picker is a native dialog and no DevTools method reaches it, so the run
 * would stop at "click 打开项目" and prove nothing about everything after it. The
 * `workspaces` row is written directly instead, with the columns the app reads on
 * start-up to restore the most recent project. The skipped parts — the folder
 * picker, and the trust prompt the first open brings up — are recorded as such,
 * because a verification that quietly stands in for a step has to say so.
 */
async function seedWorkspace() {
  const boot = AppRun.launch({ home: HOME, port: PORT + 1 });
  const summary = await boot.waitFor(/^\[ucad\] adapters resolved: .*$/, 60000);
  if (!summary) {
    const stopped = await boot.waitFor(/startup stopped|Encryption is not available|fatal startup error/, 500);
    const tail = boot.lines
      .filter((line) => !/Fontconfig|Gdk-|libGL|MESA|vulkan|EGL|gbm|DevTools listening/i.test(line))
      .slice(-8);
    await boot.stop();
    throw new Error(
      `the app did not reach a running state.\n  ${stopped ?? 'no summary line within 60s'}\n` +
        `  what the app said:\n    ${tail.join('\n    ')}\n` +
        '  On Linux the usual cause is the OS key store: it needs a session bus that answers ' +
        'org.freedesktop.secrets, and a declared desktop (XDG_CURRENT_DESKTOP), which is what ' +
        'selects a key store backend at all.',
    );
  }
  record('boot', 'summary line', summary);
  const created = await boot.waitForKeyFile(DB_IN_PROFILE, 60000);
  await boot.stop();
  if (!created) throw new Error(`the first run left no database at ${DB_IN_PROFILE}`);

  const db = new WasmDatabase(DB_IN_PROFILE);
  try {
    const now = new Date().toISOString();
    // One `values` argument, not six: `node-sqlite3-wasm` binds an array or an
    // object, so positional arguments would bind only the first parameter and
    // leave `path` NULL.
    db.prepare(
      'INSERT OR REPLACE INTO workspaces (id, path, name, trust_state, created_at, last_opened_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(['ws_verify', PROJECT, path.basename(PROJECT), 'trusted', now, now]);
  } finally {
    db.close();
  }
  record('boot', 'project', PROJECT);
  record('boot', 'workspace seed', 'row written directly: no folder picker, no trust prompt on screen');
}

// ---------------------------------------------------------------------------
// steps
// ---------------------------------------------------------------------------

async function step1(cdp) {
  const objective = '分析登录失败的原因并运行相关测试';
  const first = await runPage(cdp, `return await sendTurn(${JSON.stringify(objective)});`);
  record(1, 'turn 1 renderedHash', first.hash);
  record(1, 'turn 1 waitedMs', first.waitedMs);

  const reread = await runPage(
    cdp,
    `await openSurface('context');
     await sleep(600);
     const drawer = panel().innerText;
     const shown = { rawBytes: drawer.includes('注入的原文'), hashInDrawer: drawer.includes(readHash() || '#none') };
     await openSurface('chat');
     await sleep(400);
     return { hash: readHash(), shown, estimate: (drawer.match(/估算来源\\s*([^\\n]+)/) || [])[1] || '' };`,
  );
  if (reread.hash !== first.hash) fail(1, `one turn read twice gave ${first.hash} then ${reread.hash}`);
  else pass(1, `the same turn reads the same hash in both surfaces (${first.hash.slice(0, 12)}…)`);
  record(1, 'context surface shows the raw bytes', reread.shown.rawBytes);
  if (!reread.shown.rawBytes) fail(1, 'the context surface showed no 注入的原文 block');

  // One byte of changed input has to move the hash. The objective is part of the
  // rendered bytes, so this is the DoD claim ("改一字节哈希失配") tested through
  // the interface a user actually touches.
  const again = await runPage(cdp, `return await sendTurn(${JSON.stringify(objective)});`);
  const shifted = await runPage(cdp, `return await sendTurn(${JSON.stringify(`${objective}.`)});`);
  record(1, 'turn 2 renderedHash (same input)', again.hash);
  record(1, 'turn 3 renderedHash (one byte more)', shifted.hash);
  if (again.hash === shifted.hash) fail(1, 'an added byte changed nothing, so the hash is not the rendered bytes');
  else pass(1, 'one injected byte moved the hash');

  const injected = await runPage(
    cdp,
    `await openSurface('context');
     await sleep(500);
     const t = panel().innerText;
     const at = t.indexOf('<ucad-context');
     const out = { head: at === -1 ? '' : t.slice(at, at + 200).replace(/\\s+/g, ' '), estimate: (t.match(/估算来源\\s*([^\\n]+)/) || [])[1] || '' };
     await openSurface('chat');
     return out;`,
  );
  record(1, 'injected bytes head', injected.head);
  record(1, 'token estimate source', injected.estimate);
  if (!injected.head.includes('<ucad-context')) fail(1, 'no injected bytes block in the context surface');
  if (!injected.estimate) fail(1, 'the estimate source never appeared next to the token count');
}

async function step2(cdp) {
  if (!(await runPage(cdp, `return await openSurface('decision');`))) fail(2, 'the decision surface is unreachable');

  const before = await runPage(
    cdp,
    `const t = panel().innerText;
     return { chain: (t.match(/引擎链[^\\n]*/) || [''])[0], engines: [...document.querySelectorAll('table tr')].length };`,
  );
  record(2, 'engine chain as configured', before.chain);
  // The claim step 2 makes in the document is "设置里引擎链与实跑一致", and it
  // cannot be made at all if the configured chain is not on the screen. This
  // line used to be recorded and never judged, so a renamed heading — or a
  // panel that failed to render — produced one blank evidence line and a pass.
  if (!before.chain) {
    fail(
      2,
      'the decision surface shows no 引擎链 line, so the configured chain cannot be compared with the one that ran',
    );
  }

  const ran = await runPage(
    cdp,
    `const b = byText('运行决策预览');
     if (!b) return { error: 'no 运行决策预览 button' };
     b.click();
     for (let i = 0; i < 20; i++) { await sleep(500); if (/confidence|置信度/.test(panel().innerText)) break; }
     const t = panel().innerText;
     const rows = [...document.querySelectorAll('table tr')].map((r) => r.innerText.replace(/\\s+/g, ' ').trim()).filter(Boolean);
     return { rows, engines: (t.match(/\\b(rule|jev)\\b/g) || []).length, confidences: (t.match(/\\d+%/g) || []).length };`,
    60000,
  );
  if (ran.error) fail(2, ran.error);
  const withRationale = ran.rows.filter((r) => /confidence=|置信度/.test(r));
  record(2, 'table rows', ran.rows.length);
  record(2, 'rows carrying a rationale', withRationale.length);
  record(2, 'engines named', ran.engines);
  record(2, 'confidences shown', ran.confidences);
  if (withRationale.length === 0) fail(2, 'no decision row carried a rationale');
  else pass(2, `${withRationale.length} decisions carry rationale + confidence + engine`);
  if (ran.rows.length > 0) record(2, 'sample row', ran.rows[ran.rows.length - 1].slice(0, 180));
}

async function step3(cdp) {
  if (!(await runPage(cdp, `return await openSurface('handoff');`))) fail(3, 'the handoff surface is unreachable');

  const generated = await runPage(
    cdp,
    `let gen = byText('生成交接摘要');
     for (let i = 0; i < 20 && !gen; i++) { await sleep(500); gen = byText('生成交接摘要'); }
     if (!gen) return { error: 'no 生成交接摘要 button' };
     gen.click();
     await sleep(3500);
     const t = panel().innerText;
     const base = t.lastIndexOf('带着它开新会话') + '带着它开新会话'.length;
     const at = (title) => { const i = t.indexOf(title, base); return i === -1 ? '' : t.slice(i, i + 200).replace(/\\s+/g, ' '); };
     return { full: t.replace(/\\s+/g, ' '), objective: at('目标'), state: at('当前状态'), decisions: at('已做的决定'), unfinished: at('未完成的工作') };`,
    60000,
  );
  if (generated.error) fail(3, generated.error);
  // Judged on the whole record: the section titles appear twice — once as the
  // "what to carry" checkboxes, once as the record itself — and reading only the
  // first hit reads the checkbox row.
  record(3, 'objective', generated.objective.slice(0, 100));
  record(3, 'current state', generated.state.slice(0, 100));
  record(3, 'decisions carried', /confidence=/.test(generated.full));
  record(3, 'unfinished work', generated.unfinished.slice(0, 70) || '(section absent)');
  if (!/confidence=/.test(generated.full)) fail(3, 'the handoff did not carry the decisions that were made');

  const carried = await runPage(
    cdp,
    `const carry = byText('带着它开新会话');
     if (!carry) return { error: 'no 带着它开新会话 button' };
     carry.click();
     await sleep(1500);
     return { composer: (q('textarea[aria-label="任务描述"]') || {}).value || '' };`,
    30000,
  );
  if (carried.error) fail(3, carried.error);
  record(3, 'composer after carry', carried.composer.replace(/\s+/g, ' ').slice(0, 100));
  if (!carried.composer.includes('交接')) fail(3, 'a new session did not start with the handoff in the input box');
  else pass(3, 'the handoff lands in the new session input');

  const history = await runPage(
    cdp,
    `await openSurface('handoff');
     await sleep(600);
     const t = panel().innerText;
     const i = t.indexOf('交接历史');
     const claim = byText('我来接手');
     let claimed = null;
     if (claim) { claim.click(); await sleep(1500); claimed = (byText('已认领') || panel()).innerText.slice(0, 40).replace(/\\s+/g, ' '); }
     return { history: i === -1 ? '' : t.slice(i, i + 260).replace(/\\s+/g, ' '), claimed };`,
    30000,
  );
  record(3, 'history', history.history.slice(0, 160));
  record(3, 'after claim', history.claimed);
  if (!/无人认领|已被更新的取代/.test(history.history)) fail(3, 'the handoff history shows no append/claim chain');
  else pass(3, 'history appends: the superseded record is still listed and readable');
}

/**
 * The configured-feed cases step 4 asks about, each in its own process.
 *
 * `expect` is the sentence `update-service.ts` puts on the screen for that
 * refusal. `tests/contract/verify-main-chain.test.ts` compares the two, because
 * an expectation that quietly falls behind the product wording turns this check
 * into a permanent failure — or, worse, a permanent pass.
 */
export const FEED_VARIANTS = Object.freeze([
  {
    label: 'plaintext override',
    value: 'http://example.com/update-feed.json',
    expect: /更新源必须使用 https/,
    refused: true,
  },
  { label: 'not a url', value: 'not-a-url', expect: /更新源地址无效/, refused: true },
  {
    // A well-formed https feed that answers nothing. `未配置更新源` is not
    // reachable from a packaged build — the build ships its own feed — so the
    // third case this step can actually show is a failed check, which the
    // document asks to see *with a reason* rather than as a silent button.
    label: 'unreachable https feed',
    value: 'https://127.0.0.1:1/update-feed.json',
    expect: /检查更新失败/,
    refused: false,
  },
]);

/**
 * Step 4, over the real network: the shipped feed first (this profile, real TLS,
 * the real GitHub Releases answer), then the refusals and the unset case, each
 * launched as its own process because `UCAD_UPDATE_FEED` is read at start-up.
 */
async function step4(run) {
  const readState = (cdp, tries = 2) =>
    runPage(
      cdp,
      `await waitForApp();
       if (!(await openSurface('settings'))) return { error: 'no settings surface' };
       let check = byText('检查更新');
       for (let i = 0; i < 20 && !check; i++) { await sleep(500); check = byText('检查更新'); }
       if (!check) return { error: 'no 检查更新 button' };
       const seen = [];
       for (let attempt = 0; attempt < ${tries}; attempt++) {
         check.click();
         let state = '';
         for (let i = 0; i < 25; i++) {
           await sleep(1000);
           const t = panel().innerText;
           const hit = t.match(/已是最新版本|发现新版本|检查更新失败[^\\n]*|未配置更新源|更新源必须[^\\n]*|更新源地址[^\\n]*/);
           if (hit) { state = hit[0]; break; }
         }
         seen.push(state || '(no state)');
         if (state && !/检查更新失败/.test(state)) break;
       }
       const t = panel().innerText;
       return { seen, state: seen[seen.length - 1], version: (t.match(/当前版本[\\s\\S]{0,16}/) || [''])[0].replace(/\\s+/g, ' ') };`,
      150000,
    );

  record(4, 'feed under test', FEED_URL ?? 'the feed shipped in the build (resources/update-config.json)');
  const shipped = await readState(run.cdp);
  if (shipped.error) fail(4, shipped.error);
  record(4, 'states seen on the shipped feed', shipped.seen.join(' | '));
  record(4, 'final state on the shipped feed', shipped.state);
  record(4, 'version line', shipped.version);
  if (/已是最新版本|发现新版本/.test(shipped.state)) {
    pass(4, `the real feed answered over the network: ${shipped.state}`);
  } else if (/检查更新失败/.test(shipped.state)) {
    // Honest, and the document asks for exactly this: a failed real-network
    // check must reach the screen with a reason instead of sitting silent.
    record(4, 'network outcome', `${shipped.state} — the failure path, not the happy one`);
  } else {
    fail(4, `the real-network check produced ${shipped.state}`);
  }

  for (const [index, variant] of FEED_VARIANTS.entries()) {
    const home = path.join(HOME, `feed-${index}`);
    rmSync(home, { recursive: true, force: true });
    const variantRun = AppRun.launch({ home, port: PORT + 10 + index, feedOverride: variant.value });
    try {
      await variantRun.attach(90000);
      const seen = await readState(variantRun.cdp, 1);
      // The reason belongs to the log and the sentence to the screen; the pair
      // is what makes a refused feed actionable, so both are read.
      const logLine = await variantRun.waitForLog(/update feed (ignored|refused|resolved)|UCAD_UPDATE_FEED/, 15000);
      record(4, `${variant.label} state`, seen.state);
      record(4, `${variant.label} log line`, (logLine ?? '(none)').slice(0, 160));
      if (!variant.expect.test(seen.state)) {
        fail(4, `${variant.label}: expected ${variant.expect}, saw ${seen.state}`);
      } else if (variant.value && !logLine) {
        fail(4, `${variant.label}: refused on screen but nothing in the log said why`);
      } else {
        pass(4, `${variant.label}: ${seen.state}`);
      }
    } catch (error) {
      fail(4, `${variant.label}: ${error.message}`);
    } finally {
      await variantRun.stop();
      rmSync(home, { recursive: true, force: true });
    }
  }
}

/**
 * The labels the tray menu is expected to carry, read from the product's own
 * i18n table.
 *
 * This is the *expectation* half of step 5. The observation half is the app's
 * own `tray menu built` log line, which names the rows it actually built; the
 * two are compared by `trayMenuVerdict()`. Reading the expectation out of
 * `apps/desktop/src/shared/i18n.ts` — the same table `buildTrayMenuTemplate()`
 * translates from — is what keeps a renamed label from turning this check into
 * a permanent failure about a sentence the product no longer has.
 */
export function trayMenuLabels(source) {
  const labels = [];
  for (const key of ['tray.show', 'tray.openProject', 'tray.quit']) {
    const hit = new RegExp(`'${key.replace('.', '\\.')}':\\s*'([^']*)'`).exec(source);
    if (hit) labels.push(hit[1]);
  }
  return labels;
}

/**
 * Whether the menu the app built is the menu the document asks about.
 *
 * `logLine` is the app's own `tray menu built` line, which carries the labels of
 * every row a user can click. Three outcomes, kept apart because they mean
 * different things:
 *
 *  - no line and no tray fault: the app built no menu and said nothing, which is
 *    the silent version of the failure the tray exists to prevent;
 *  - no line but a tray fault: this host has no notification area, so there is
 *    no menu to check — the document asks for that branch to be recorded, not
 *    failed;
 *  - a line: every expected label must be in it. A menu that lost 退出 UCAD is
 *    the app alive with no way out, which is the defect this step is for.
 */
export function trayMenuVerdict({ logLine, expected, trayFault }) {
  if (!logLine) {
    return trayFault
      ? {
          ok: true,
          message: `no tray on this host, so there is no menu to check (${trayFault.slice(0, 120)})`,
        }
      : { ok: false, message: 'the app built no tray menu and never said why' };
  }
  const missing = expected.filter((label) => !logLine.includes(label));
  if (missing.length) {
    return { ok: false, message: `the tray menu is missing ${missing.join(' / ')}` };
  }
  return { ok: true, message: `the tray menu carries ${expected.join(' / ')}` };
}

/**
 * What a close is allowed to have done, judged from what the run can observe.
 *
 * `visibility` is the renderer's own `document.visibilityState` read after the
 * close, or the reason it could not be read. It is the difference between "the
 * window is hidden and the app is still there" and "the process survived with
 * nothing on screen and no way back" — the second is exactly the failure the
 * tray exists to prevent, and a check that only asked "is the process alive"
 * would call it a pass.
 */
export function closeVerdict({ choice, exited, visibility, trayUnavailable }) {
  if (choice === '退出应用') {
    return exited
      ? { ok: true, message: 'the process exited on close, as the setting says' }
      : { ok: false, message: '"退出应用" was in force and the process survived the close' };
  }
  if (exited) {
    return trayUnavailable
      ? { ok: true, message: 'the tray could not be built here, so closing quit — and said so' }
      : { ok: false, message: 'hiding quit the process without saying why' };
  }
  if (visibility === 'hidden') {
    return { ok: true, message: 'the window is hidden and the process is alive' };
  }
  if (visibility.startsWith('gone')) {
    // The close this script can send is renderer-initiated, and that destroys
    // the page target even when the window is only hidden. The claim step 5
    // makes is still observable — the window is off screen and the process is
    // alive — but the *reason* it is off screen is the close, not the tray, so
    // the message says which one was measured.
    return {
      ok: true,
      message:
        'the window is off screen and the process is alive (renderer-initiated close: the page target is gone; the X button is a native close this script cannot send)',
    };
  }
  return {
    ok: false,
    message:
      visibility === 'visible'
        ? 'the process survived but the window is still on screen, so nothing was hidden'
        : `the process survived but the window could not be read back (${visibility})`,
  };
}

/** The renderer's answer to "is the window on screen", or why it could not answer. */
async function readWindowState(run) {
  try {
    const state = await run.cdp.evaluate('document.visibilityState', { timeoutMs: 10000 });
    if (typeof state === 'string' && state) return state;
  } catch {
    /* the page did not answer; the target list says whether it still exists */
  }
  return (await run.hasPageTarget())
    ? 'unreadable (the page did not answer)'
    : 'gone (the page target no longer exists)';
}

/**
 * What closing the window does, in both settings, in that order.
 *
 * Hide-first, because it is the case that leaves the process alive to be asked
 * again; 退出应用 is last because it ends the run. Where the tray cannot be
 * built, the app's own rule is that closing quits — and that is the fault path
 * the document asks for, so the log line is captured rather than treated as a
 * failure.
 *
 * The hide case is asserted on two observations, not one: the process is still
 * alive *and* the window says it is hidden. "Alive" alone is satisfied by an
 * app that hid itself into a tray that does not exist, which is the one outcome
 * a user cannot recover from without a task manager.
 */
async function step5() {
  let expected = [];
  try {
    expected = trayMenuLabels(
      readFileSync(new URL('../apps/desktop/src/shared/i18n.ts', import.meta.url), 'utf8'),
    );
  } catch {
    /* reported below: without the expectation there is nothing to compare */
  }
  if (!expected.length) {
    fail(5, 'the expected tray labels could not be read from apps/desktop/src/shared/i18n.ts');
  }

  for (const [index, choice] of ['隐藏到托盘', '退出应用'].entries()) {
    // One process per choice. The close this script can send is
    // renderer-initiated, and that destroys the page target even when the
    // window is only hidden — so the same process cannot be asked the second
    // question, and a shared process would report the first answer twice.
    const run = AppRun.launch({ home: HOME, port: PORT + 20 + index });
    try {
      await run.attach(90000);
      if (index === 0) {
        // The menu is built once per process, at start-up, and the app writes
        // what it built to its own log — so the three items are *asserted* here
        // instead of being printed for a person to read off the screen. Read
        // before the close: the close ends this process, and the log file is
        // shared with the next one.
        const menuLine = await run.waitForLog(/"msg":"tray menu built"/, 20000);
        const trayFault = menuLine ? null : await run.waitForLog(/tray unavailable/, 5000);
        record(
          5,
          'tray menu built',
          menuLine
            ? (/"items":\[[^\]]*\]/.exec(menuLine)?.[0] ?? menuLine.slice(0, 200))
            : '(the app logged no tray menu)',
        );
        const menuVerdict = trayMenuVerdict({ logLine: menuLine, expected, trayFault });
        if (menuVerdict.ok) pass(5, menuVerdict.message);
        else fail(5, menuVerdict.message);
      }
      // The choice is a pair of buttons, not a `<select>`, and they only render
      // once the settings read has come back — so the wait is on the button, and
      // the save is confirmed by the button becoming the selected one. Closing
      // on a click that was never persisted would test the default, not the
      // setting.
      const closed = await runPage(
        run.cdp,
        `if (!(await openSurface('settings'))) throw new Error('no settings surface');
         let wanted = null;
         for (let i = 0; i < 20 && !wanted; i++) {
           wanted = byText(${JSON.stringify(choice)});
           if (!wanted) await sleep(500);
         }
         if (!wanted) throw new Error('the settings surface has no ' + ${JSON.stringify(choice)} + ' button');
         wanted.click();
         await sleep(1500);
         const saved = byText(${JSON.stringify(choice)});
         if (!saved || !/primary/.test(saved.className)) {
           throw new Error('the choice was not saved: ' + ${JSON.stringify(choice)} + ' is not the selected button');
         }
         window.close();
         return true;`,
        30000,
      ).catch((error) => {
        fail(5, error.message);
        return false;
      });
      if (!closed) continue;
      await sleep(5000);
      const exited = run.exited;
      record(
        5,
        `close with "${choice}"`,
        exited ? `process exited, code ${exited.code}` : 'process still running',
      );
      const visibility = exited ? 'n/a (the process is gone)' : await readWindowState(run);
      record(5, `window after close with "${choice}"`, visibility);
      const trayUnavailable = exited
        ? Boolean(await run.waitFor(/tray unavailable|closing the window will quit/, 3000))
        : false;
      if (trayUnavailable) record(5, 'tray fault path', 'tray unavailable; closing the window will quit');

      const verdict = closeVerdict({ choice, exited, visibility, trayUnavailable });
      if (verdict.ok) pass(5, verdict.message);
      else fail(5, verdict.message);
    } finally {
      await run.stop();
    }
  }
}

// ---------------------------------------------------------------------------
// the run
// ---------------------------------------------------------------------------

async function main() {
  // Asked before anything is launched: a request this script cannot honour has
  // to end the run with a failure, not with a partial run and a `PASS` about
  // the steps that happened to be drivable. See `parseSteps()`.
  if (STEP_REQUEST.rejected.length) {
    for (const { reason } of STEP_REQUEST.rejected) console.error(`[FAIL] --steps: ${reason}`);
    return 1;
  }
  console.log(`[run] executable ${EXEC}`);
  if (!existsSync(EXEC)) {
    console.error('[FAIL] no built executable there. Run `npm run package` first, or pass --exec.');
    return 1;
  }
  if (wants(1) || wants(2) || wants(3)) {
    mkdirSync(PROJECT, { recursive: true });
    writeFileSync(path.join(PROJECT, 'auth.ts'), 'export function login(user: string) {\n  return user === "admin";\n}\n');
    writeFileSync(path.join(PROJECT, 'README.md'), '# verify-main-chain project\n');
  }

  const fresh = process.env.UCAD_VERIFY_FRESH === '1';
  if (fresh) rmSync(HOME, { recursive: true, force: true });
  if (!existsSync(DB_IN_PROFILE)) {
    try {
      await seedWorkspace();
    } catch (error) {
      // The message only. This step is the one place a foreign error can come
      // from (a wasm SQLite build whose stack is one 30 KB line), and a reader
      // of a verification run needs the sentence, not the source.
      console.error(`[BLOCKED] ${error.message.split('\n').slice(0, 6).join('\n')}`);
      return 2;
    }
  }
  record('boot', 'profile', HOME);

  const run = AppRun.launch({ home: HOME, port: PORT, feedOverride: FEED_URL ?? undefined });
  const deadline = Date.now() + TIMEOUT_MS;
  try {
    const cdp = await run.attach(90000);
    record('boot', 'renderer target', run.target.url);
    // `ucad started` carries `encrypted`, the one line that says the at-rest key
    // came from the OS key store rather than from nowhere. Recorded, not asserted:
    // step 6 has no claim about it, and a boot that stopped would not be here.
    const started = await run.waitForLog(/"msg":"ucad started"/, 20000);
    record('boot', 'start line', (started ?? '(not found in the app log)').slice(0, 200));
    if (wants(1)) await guard(1, deadline, () => step1(cdp));
    if (wants(2)) await guard(2, deadline, () => step2(cdp));
    if (wants(3)) await guard(3, deadline, () => step3(cdp));
    if (wants(4)) await guard(4, deadline, () => step4(run));
    if (wants(5)) {
      // Step 5 brings its own processes (see the note there), so the shared run
      // is stopped first: two instances on one profile would contend for the
      // database, and the close under test would be ambiguous.
      await run.stop();
      await guard(5, deadline, () => step5());
    }
  } catch (error) {
    fail('run', error.message);
    const tail = run.lines.filter((line) => /\[ucad\]|error/i.test(line)).slice(-12);
    console.error(`[app] last lines:\n  ${tail.join('\n  ')}`);
  } finally {
    if (!KEEP) await run.stop();
  }

  console.log('\n===== evidence =====');
  for (const line of evidence) console.log(`  ${line}`);
  // A requested step that reached neither verdict took a path nobody wrote.
  // Counted here, before the transcript is written, so the exit code, the
  // printed verdict and the `--json` file all answer to it.
  for (const gap of stepCoverage({
    requested: STEPS,
    passed: [...passedSteps],
    failed: failures.map((failure) => failure.step),
  })) {
    failures.push({ step: gap.step, message: gap.message });
  }

  if (JSON_OUT) {
    writeFileSync(
      JSON_OUT,
      JSON.stringify({ ranAt: new Date().toISOString(), executable: EXEC, platform: process.platform, evidence, failures }, null, 2),
    );
    console.log(`  json: ${JSON_OUT}`);
  }
  console.log('\n===== verdict =====');
  for (const failure of failures) console.log(`FAIL step ${failure.step}: ${failure.message}`);
  if (failures.length === 0) {
    console.log(`PASS — steps ${STEPS.join(', ')} recorded above`);
    return 0;
  }
  return 1;
}

async function guard(step, deadline, body) {
  if (Date.now() > deadline) {
    fail(step, 'the run deadline passed before this step started');
    return;
  }
  console.log(`\n--- step ${step} ---`);
  try {
    await body();
  } catch (error) {
    fail(step, error.message);
  }
}

/**
 * Run only when this file is the command.
 *
 * `tests/contract/verify-main-chain.test.ts` imports the module to drive the
 * environment and feed expectations without a display; an unguarded `main()`
 * would launch a whole verification run from `npm test`.
 */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
