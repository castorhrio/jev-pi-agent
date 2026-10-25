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
