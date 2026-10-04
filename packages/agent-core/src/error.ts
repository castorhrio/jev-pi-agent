/**
 * §0: every plane builds errors through `appError(...)`. `AppError` is plain
 * data, so it is carried on a real `Error` — callers can both `throw`/`catch`
 * and read `.appError` for the IPC error surface. Mirrors `SessionError` in
 * `@ucad/session`; it exists here because `@ucad/agent-core` must not depend on
 * `@ucad/session`'s error class.
 */

import { appError } from '@ucad/contracts';
import type { AppError, AppErrorCode, ErrorComponent } from '@ucad/contracts';

export interface AgentErrorLike {
  readonly appError: AppError;
}

export class TurnRuntimeError extends Error implements AgentErrorLike {
  readonly appError: AppError;

  constructor(message: string, error: AppError) {
    super(message);
    this.name = 'TurnRuntimeError';
    this.appError = error;
  }
}

/** Throwing helper: every failure site of this package produces the same shape. */
export function fail(
  code: AppErrorCode,
  message: string,
  component: ErrorComponent = 'agent',
  details?: unknown,
): never {
  throw new TurnRuntimeError(
    message,
    appError(code, message, component, details !== undefined ? { details } : {}),
  );
}

/** Non-throwing constructor, for the paths that must hand an error to a promise. */
export function runtimeError(
  code: AppErrorCode,
  message: string,
  component: ErrorComponent = 'agent',
  details?: unknown,
): TurnRuntimeError {
  return new TurnRuntimeError(
    message,
    appError(code, message, component, details !== undefined ? { details } : {}),
  );
}

/** Best-effort read of the `AppError` carried by an unknown throwable. */
export function asAppError(value: unknown, component: ErrorComponent = 'agent'): AppError {
  if (value instanceof TurnRuntimeError) return value.appError;
  if (
    value !== null &&
    typeof value === 'object' &&
    'code' in value &&
    'component' in value &&
    'retryable' in value
  ) {
    return value as AppError;
  }
  if (value !== null && typeof value === 'object' && 'appError' in value) {
    const inner = (value as { appError?: unknown }).appError;
    if (inner !== null && typeof inner === 'object' && 'code' in inner) return inner as AppError;
  }
  const message = value instanceof Error ? value.message : String(value);
  return appError('UNKNOWN', message, component);
}
