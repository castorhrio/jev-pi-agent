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
import { appError, describeError, toAppError } from '@ucad/contracts';

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
