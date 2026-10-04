/**
 * §0 error convention for the command plane. A denied command and a missing
 * binary must both be one short, user-safe sentence.
 */

import { appError } from '@ucad/contracts';
import type { AppError, AppErrorCode } from '@ucad/contracts';

export class AppErrorThrow extends Error {
  readonly appError: AppError;

  constructor(error: AppError) {
    super(error.message);
    this.name = 'AppError';
    this.appError = error;
  }
}

export function fail(code: AppErrorCode, message: string, details?: unknown): AppErrorThrow {
  return new AppErrorThrow(appError(code, message, 'ipc', details === undefined ? {} : { details }));
}

export function isAppError(value: unknown): value is AppErrorThrow {
  return value instanceof AppErrorThrow;
}

export function errnoOf(value: unknown): string | undefined {
  if (typeof value === 'object' && value !== null && 'code' in value) {
    const code = (value as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}
