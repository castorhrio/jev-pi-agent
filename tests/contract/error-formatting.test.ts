/**
 * §17.1: a failure must show its reason. "Showing its reason" is trivially
 * defeated by formatting the error wrongly, which is exactly what happened:
 * `appError()` returns a plain object, so every `catch` that reached for
 * `String(error)` rendered it as the literal text `[object Object]`.
 *
 * These assertions are deliberately blunt — the contract is not "includes the
 * code", it is "never renders as `[object Object]`, ever".
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appError, codedError, describeError, toAppError } from '@ucad/contracts';

describe('describeError', () => {
  it('never renders the string "[object Object]"', () => {
    const values: unknown[] = [
      appError('STORAGE_ERROR', 'decision could not be persisted', 'decision'),
      { code: 'NETWORK_ERROR', message: 'socket hang up' },
      { message: 'no code on this one' },
      { weird: true, shape: 1 },
      {},
      Object.create(null),
      42,
      null,
      undefined,
      Symbol('sym'),
    ];

    for (const value of values) {
      expect(describeError(value)).not.toBe('[object Object]');
      expect(describeError(value)).not.toContain('undefined');
      expect(describeError(value).length).toBeGreaterThan(0);
    }
  });

  it('keeps the error code in front of the message for an AppError', () => {
    expect(describeError(appError('STORAGE_ERROR', 'insert failed', 'decision'))).toBe(
      'STORAGE_ERROR: insert failed',
    );
  });

  it('uses an Error message as-is', () => {
    expect(describeError(new Error('ECONNRESET'))).toBe('ECONNRESET');
  });

  it('passes a string through', () => {
    expect(describeError('plain text')).toBe('plain text');
  });

  it('describes an unknown object by its shape, never by its values (NFR-08)', () => {
    const secret = 'sk-live-do-not-log-me';
    const rendered = describeError({ apiKey: secret, nested: { token: secret } });
    expect(rendered).not.toContain(secret);
    expect(rendered).toContain('apiKey');
  });

  it('survives a property getter that throws', () => {
    const hostile = {
      get message(): string {
        throw new Error('nope');
      },
    };
    expect(() => describeError(hostile)).not.toThrow();
  });

  it('feeds toAppError, which no longer stringifies an AppError to nothing', () => {
    const converted = toAppError({ code: 'RATE_LIMITED', message: 'slow down' }, 'ipc');
    expect(converted.message).toBe('RATE_LIMITED: slow down');
  });
});

/**
 * `appError()` is the shape a plane *returns*; `codedError()` is the shape it
 * *throws*.
 *
 * The difference is not cosmetic. A thrown plain object is not an `Error`, so
 * every `instanceof Error` branch stops matching it, and Electron's
 * `ipcMain.handle` — which serialises a rejection to the Renderer — only carries
 * an `Error` faithfully. The previous workaround was to throw
 * `new Error(appError(code, message, …).message)`, which kept the sentence and
 * dropped the code: a permission refusal was logged as `UNKNOWN`.
 */
describe('codedError', () => {
  it('is a real Error that keeps its code', () => {
    const failure = codedError('WORKSPACE_NOT_FOUND', '项目不存在：ws_1', 'ipc');

    // `instanceof Error` is what half the app branches on, and what Electron
    // needs to carry the rejection across the bridge.
    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toBe('项目不存在：ws_1');
    expect(failure.code).toBe('WORKSPACE_NOT_FOUND');
    expect(failure.component).toBe('ipc');
    expect(failure.retryable).toBe(false);
  });

  it('marks the codes that are worth retrying', () => {
    // The single table again, not a second opinion copied per call site.
    expect(codedError('NETWORK_ERROR', 'socket hang up', 'ipc').retryable).toBe(true);
    expect(codedError('NO_ACTIVE_WORKSPACE', '没有已打开的项目', 'ipc').retryable).toBe(false);
  });

  it('survives toAppError with the code it was given', () => {
    // This is the property `handle()` in `ipc.ts` relies on: it converts the
    // rejection before logging, and a conversion that answered `UNKNOWN` here
    // is how "the project is gone" became indistinguishable from a crash.
    const converted = toAppError(codedError('INVALID_INPUT', '不接受明文凭据', 'ipc'), 'ipc');
    expect(converted.code).toBe('INVALID_INPUT');
    expect(converted.message).toBe('不接受明文凭据');
  });

  it('renders as its message, never as [object Object]', () => {
    expect(describeError(codedError('NOT_FOUND', '会话不存在', 'ipc'))).toBe('会话不存在');
  });
});

/**
 * The meta-test: a *new* one must not be able to ask for the same silence.
 *
 * The tests above pin what `codedError()` does. They do not pin that the code
 * base *uses* it — and the failure they were written for was not one bad
 * formatting function, it was five call sites that each reached for
 * `throw new Error(appError(…).message)` and threw the code away. A test per
 * call site would be back to "the one place we remembered"; this one reads the
 * sources instead, so a throw added tomorrow fails here rather than in a
 * support report.
 *
 * Two patterns are refused:
 *
 *   - `throw new Error(...)` — a rejection crossing the bridge with no §4.11
 *     code, which `toAppError()` can only answer as `UNKNOWN`;
 *   - `throw appError(...)` — a thrown plain object, which stops matching every
 *     `instanceof Error` branch and does not survive Electron's serialisation.
 *
 * The allowlist is a debt ledger, not a filter: it is compared for equality, so
 * it fails when a bare throw appears **and** when an entry is fixed and left
 * behind.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const mainSrc = path.resolve(here, '../../apps/desktop/src/main');

/**
 * The one bare `throw new Error()` Main may keep.
 *
 * `bootstrap.ts` raises it inside `installTray()` and catches it a few lines
 * below: nothing crosses the IPC bridge, the app degrades to
 * "closing the window quits", and the reason goes into the log as a `warn`
 * with the tray problem, not as a §4.11 code the Renderer could act on.
 */
const ALLOWED = [
  {
    file: 'bootstrap.ts',
    line: 'throw new Error(`tray icon could not be decoded: ${icon.path}`);',
    why: 'thrown and caught inside installTray(); the tray degrades, nothing crosses IPC',
  },
];

interface Bare {
  file: string;
  line: string;
}

/**
 * The sources with comments removed.
 *
 * The comments in this code base *discuss* the anti-pattern — "the previous
 * workaround was `throw new Error(appError(…).message)`" is a sentence in three
 * files — and a scan that counted prose would be a scan nobody could keep
 * green. Strings are left alone: a bare throw hidden behind a `//` in a string
 * literal is not a thing that happens, while stripping string literals would
 * also strip the messages this test is about.
 */
function codeOnly(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function bareThrows(): Bare[] {
  const found: Bare[] = [];
  for (const file of fs.readdirSync(mainSrc).sort()) {
    if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue;
    const text = codeOnly(fs.readFileSync(path.join(mainSrc, file), 'utf8'));
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (/\bthrow\s+new\s+Error\s*\(/.test(line) || /\bthrow\s+appError\s*\(/.test(line)) {
        found.push({ file, line });
      }
    }
  }
  return found;
}

describe('every refusal in Main names a code (§4.11)', () => {
  it('main/*.ts throws no bare Error outside the allowlist', () => {
    const found = bareThrows();
    const asText = found.map((entry) => `${entry.file}: ${entry.line}`).sort();
    const allowed = ALLOWED.map((entry) => `${entry.file}: ${entry.line}`).sort();

    // Equality, not "subset": an entry that was fixed has to leave the ledger,
    // otherwise the ledger slowly becomes a description of nothing.
    expect(asText).toEqual(allowed);
  });

  it('the allowlist entry still exists, so the ledger is not stale', () => {
    for (const entry of ALLOWED) {
      const text = fs.readFileSync(path.join(mainSrc, entry.file), 'utf8');
      expect(text, `${entry.file} no longer contains the allowlisted throw`).toContain(
        entry.line,
      );
      expect(entry.why.length).toBeGreaterThan(0);
    }
  });

  it('the IPC surface refuses through codedError, not through a bare sentence', () => {
    // The two files that hold every handler. A `new Error` here is the exact
    // shape that made "the project is gone" and "the provider exploded" both
    // log as `UNKNOWN`.
    for (const file of ['ipc.ts', 'ipc-storage.ts', 'ipc-mcp.ts']) {
      const text = fs.readFileSync(path.join(mainSrc, file), 'utf8');
      expect(text, `${file} throws a bare Error`).not.toMatch(/throw new Error\(/);
      expect(text, `${file} throws a plain appError object`).not.toMatch(/throw appError\(/);
    }
  });
});
