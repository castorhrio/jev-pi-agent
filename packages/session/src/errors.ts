/**
 * §0: every plane constructs errors through `appError(...)`. `AppError` is a
 * plain data object, so this class carries it on a real `Error` — the Desktop
 * can both `throw`/`catch` it and read `.appError` for the IPC error surface.
 */

import { appError } from '@ucad/contracts';
import type { AppError, AppErrorCode, ErrorComponent } from '@ucad/contracts';

export class SessionError extends Error {
  readonly appError: AppError;

  constructor(message: string, error: AppError) {
    super(message);
    this.name = 'SessionError';
    this.appError = error;
  }
}

/** Throwing helper so every failure site produces the same shape. */
export function fail(
  code: AppErrorCode,
  message: string,
  component: ErrorComponent = 'agent',
  details?: unknown,
): never {
  throw new SessionError(
    message,
    appError(code, message, component, details !== undefined ? { details } : {}),
  );
}
