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
import { RETRYABLE, appError, codedError, describeError, toAppError } from '@ucad/contracts';
import type { AppErrorCode } from '@ucad/contracts';
import { scanBareThrows } from './bare-throw-scan';

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

  it('attaches code/component/retryable as own enumerable properties', () => {
    // This is a contract, not an implementation detail: the Renderer-side test
    // "nothing enumerable crosses the bridge" is only meaningful because these
    // three *are* enumerable here and `toUserError()` rebuilds a clean `Error`.
    // Attach them with `Object.defineProperty` instead (enumerable: false) and
    // that test would keep passing for the wrong reason — there would be
    // nothing left for the wrapper to drop.
    const keys = Object.keys(codedError('NOT_FOUND', '会话不存在', 'ipc'));
    expect(keys).toContain('code');
    expect(keys).toContain('component');
    expect(keys).toContain('retryable');
  });
});

/**
 * Retryability is a decision about every code, not a default for the unnamed.
 *
 * The compile-time half is the table's type: `Record<AppErrorCode, boolean>`
 * means a new code fails `npm run typecheck` until someone answers for it.
 * This is the runtime half. The suite transpiles without typechecking, and a
 * test cannot enumerate a type — so the codes are written out below and
 * compared with the table in *both* directions: a code the table forgets is a
 * missing row, and a row for a code that no longer exists is a classification
 * nothing can ever read.
 */
describe('the retryable table', () => {
  const RETRYABLE_CODES = [
    'PROCESS_EXITED',
    'HOST_UNRESPONSIVE',
    'RATE_LIMITED',
    'NETWORK_ERROR',
    'STORAGE_ERROR',
  ] as const satisfies readonly AppErrorCode[];

  const TERMINAL_CODES = [
    'WORKSPACE_NOT_TRUSTED',
    'ADAPTER_NOT_AVAILABLE',
    'AGENT_START_FAILED',
    'NATIVE_SESSION_LOST',
    'PERMISSION_DENIED',
    'AUTH_REQUIRED',
    'CONTAINER_NOT_STARTED',
    'MIGRATION_FAILED',
    'BUDGET_EXCEEDED',
    'INJECTION_UNSUPPORTED',
    'TOOL_CONTRACT_UNAVAILABLE',
    'DECISION_TIMEOUT',
    'INTELLIGENCE_UNAVAILABLE',
    'WORKSPACE_NOT_FOUND',
    'NO_ACTIVE_WORKSPACE',
    'NOT_FOUND',
    'INVALID_INPUT',
    'FEATURE_UNAVAILABLE',
    'UNKNOWN',
  ] as const satisfies readonly AppErrorCode[];

  it('classifies every code, and no code that is gone', () => {
    // Equality, not a subset: both a missing row and a leftover row fail.
    expect([...RETRYABLE_CODES, ...TERMINAL_CODES].sort()).toEqual(
      Object.keys(RETRYABLE).sort(),
    );
    for (const code of RETRYABLE_CODES) {
      expect(RETRYABLE[code], `${code} lost its retryable classification`).toBe(true);
    }
    for (const code of TERMINAL_CODES) {
      expect(RETRYABLE[code], `${code} is classified as retryable`).toBe(false);
    }
  });

  it('is the one table both constructors read', () => {
    // Not a second copy of the answers: `appError()` and `codedError()` each
    // consult `RETRYABLE`, so a code whose row says `true` must arrive as
    // retryable through both shapes a plane can produce.
    for (const [code, retryable] of Object.entries(RETRYABLE)) {
      const asCode = code as AppErrorCode;
      expect(appError(asCode, 'x', 'ipc').retryable, code).toBe(retryable);
      expect(codedError(asCode, 'x', 'ipc').retryable, code).toBe(retryable);
    }
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
 * The scan itself lives in `bare-throw-scan.ts` and is exercised on fixtures
 * below. Two shapes it originally missed are pinned there: a trailing `//`
 * comment (prose that names the pattern is not a throw) and a throw whose
 * argument is wrapped onto the next line (still a bare throw).
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
 * The two facts the allowlist needs, read through the shared scanner: the file
 * names Main throws a bare error in, and the allowlisted entry still being
 * there.
 *
 * `mainSrc` is scanned rather than the whole app because that is where an
 * uncaught rejection can end up across the IPC bridge; the Renderer's own
 * `throw` statements are caught by its own tests.
 */
function bareThrows(): Bare[] {
  const sources = fs
    .readdirSync(mainSrc)
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
    .sort()
    .map((file) => ({ file, text: fs.readFileSync(path.join(mainSrc, file), 'utf8') }));

  return scanBareThrows(sources).map(({ file, line }) => ({ file, line }));
}

/**
 * The scanner, on fixtures.
 *
 * A meta-test is only as good as its ability to fail. These feed it the shapes
 * a real call site takes, including the two the first version missed, so a
 * future "simplification" of the scan is caught here rather than by the
 * guarantee silently disappearing.
 */
describe('the bare-throw scan', () => {
  it('catches a throw written on one line', () => {
    const found = scanBareThrows([
      { file: 'a.ts', text: 'export function f(): never {\n  throw new Error("boom");\n}' },
      { file: 'b.ts', text: 'throw appError("CODE", "message", "ipc");' },
    ]);

    expect(found.map((entry) => entry.file)).toEqual(['a.ts', 'b.ts']);
    expect(found[0]?.at).toBe(2);
    expect(found[0]?.line).toBe('throw new Error("boom");');
  });

  it('catches a throw whose argument is wrapped onto the next line', () => {
    // The line-by-line version could not see this one: the `(` is the last
    // thing on the line, so the sentence and the code were both legitimate.
    const text = [
      'export function f(): never {',
      '  throw new Error(',
      '    `workspace ${id} could not be activated`,',
      '  );',
      '}',
    ].join('\n');

    const found = scanBareThrows([{ file: 'wrapped.ts', text }]);

    expect(found).toHaveLength(1);
    // Reported where the statement starts, not where the argument ends.
    expect(found[0]?.at).toBe(2);
    expect(found[0]?.line).toBe('throw new Error(');
  });

  it('does not count prose in a trailing comment as a throw', () => {
    // The exact sentence shape this code base uses to explain the fix. Scanned
    // as code, it would make the allowlist comparison fail on every file that
    // documents the past failure.
    const found = scanBareThrows([
      {
        file: 'doc.ts',
        text: 'const ok = 1; // used to be throw new Error(appError("C", "m", "ipc").message)',
      },
    ]);

    expect(found).toEqual([]);
  });

  it('still counts a throw after a trailing comment on the same line', () => {
    // The other direction of the same rule: blanking the comment must not take
    // the code in front of it with it.
    const found = scanBareThrows([
      { file: 'mixed.ts', text: 'if (!ok) throw new Error("boom"); // refuse without a code' },
    ]);

    expect(found).toHaveLength(1);
    expect(found[0]?.line).toBe('if (!ok) throw new Error("boom");');
  });

  it('ignores throws inside block comments', () => {
    const found = scanBareThrows([
      {
        file: 'quiet.ts',
        text: [
          '/**',
          ' * A previous version did:',
          ' *   throw new Error("boom");',
          ' */',
          'export const ok = 1;',
        ].join('\n'),
      },
    ]);

    expect(found).toEqual([]);
  });

  it('reports a throw inside a string literal, which is the documented boundary', () => {
    // Strings are deliberately not stripped: stripping them would also hide the
    // message of every throw this test is about. The cost is that a literal
    // quoting the pattern is counted, and the scan fails loudly. That direction
    // is chosen on purpose — a false negative would make the guarantee vanish
    // without anybody noticing.
    const found = scanBareThrows([
      { file: 'literal.ts', text: 'const message = "throw new Error(\\"quoted\\")";' },
    ]);

    expect(found).toHaveLength(1);
  });
});

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
