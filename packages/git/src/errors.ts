/**
 * §0 error convention for the Git plane. Git's own stderr never reaches the
 * Renderer verbatim — it is capped and prefixed here, and the full text goes
 * to the (redacting) logger.
 */

import { appError } from '@ucad/contracts';
import type { AppError, AppErrorCode } from '@ucad/contracts';

export class AppErrorThrow extends Error {
  readonly appError: AppError;
  /** Raw git stderr, kept off the UI message but available for matching. */
  readonly stderr: string | undefined;

  constructor(error: AppError, stderr?: string) {
    super(error.message);
    this.name = 'AppError';
    this.appError = error;
    this.stderr = stderr;
  }
}

export function fail(code: AppErrorCode, message: string, details?: unknown): AppErrorThrow {
  return new AppErrorThrow(appError(code, message, 'ipc', details === undefined ? {} : { details }));
}

export function errnoOf(value: unknown): string | undefined {
  if (typeof value === 'object' && value !== null && 'code' in value) {
    const code = (value as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

export function isAppError(value: unknown): value is AppErrorThrow {
  return value instanceof AppErrorThrow;
}
