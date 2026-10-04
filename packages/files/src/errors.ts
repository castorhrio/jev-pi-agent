/**
 * §0 error convention: every failure leaves this package as an `AppError`
 * built by `appError`, never as a raw `fs` / vendor message.
 */

import { appError } from '@ucad/contracts';
import type { AppError, AppErrorCode } from '@ucad/contracts';

/**
 * Carries the canonical `AppError` shape on the `Error` so Main, the IPC layer
 * and the log all observe the same `code` / `component`. Mirrors the pattern
 * used by `@ucad/storage`.
 */
export class AppErrorThrow extends Error {
  readonly appError: AppError;

  constructor(error: AppError) {
    super(error.message);
    this.name = 'AppError';
    this.appError = error;
  }
}

/** The service is only ever reached through the IPC bridge, hence `ipc`. */
export function fail(code: AppErrorCode, message: string, details?: unknown): AppErrorThrow {
  return new AppErrorThrow(appError(code, message, 'ipc', details === undefined ? {} : { details }));
}

export function isAppError(value: unknown): value is AppErrorThrow {
  return value instanceof AppErrorThrow;
}

/** Best-effort errno extraction without ever leaking the raw message. */
export function errnoOf(value: unknown): string | undefined {
  if (typeof value === 'object' && value !== null && 'code' in value) {
    const code = (value as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}
