/** §4.11 Error contract. */

export type AppErrorCode =
  | 'WORKSPACE_NOT_TRUSTED'
  | 'ADAPTER_NOT_AVAILABLE'
  | 'AGENT_START_FAILED'
  | 'NATIVE_SESSION_LOST'
  | 'PERMISSION_DENIED'
  | 'PROCESS_EXITED'
  | 'HOST_UNRESPONSIVE'
  | 'AUTH_REQUIRED'
  | 'RATE_LIMITED'
  | 'NETWORK_ERROR'
  | 'STORAGE_ERROR'
  | 'MIGRATION_FAILED'
  | 'BUDGET_EXCEEDED'
  | 'INJECTION_UNSUPPORTED'
  | 'TOOL_CONTRACT_UNAVAILABLE'
  | 'DECISION_TIMEOUT'
  | 'INTELLIGENCE_UNAVAILABLE'
  | 'UNKNOWN';

export type ErrorComponent =
  | 'agent'
  | 'context'
  | 'intelligence'
  | 'decision'
  | 'storage'
  | 'ipc';

export interface AppError {
  code: AppErrorCode;
  /** user-safe */
  message: string;
  retryable: boolean;
  component: ErrorComponent;
  /** sanitized — never contains secrets or raw vendor payloads */
  details?: unknown;
  vendor?: { name: string; code?: string };
}

const RETRYABLE: ReadonlySet<AppErrorCode> = new Set<AppErrorCode>([
  'NETWORK_ERROR',
  'RATE_LIMITED',
  'HOST_UNRESPONSIVE',
  'PROCESS_EXITED',
  'STORAGE_ERROR',
]);

/** Single constructor so every plane produces errors the same way. */
export function appError(
  code: AppErrorCode,
  message: string,
  component: ErrorComponent,
  extra: { details?: unknown; vendor?: { name: string; code?: string } } = {},
): AppError {
  return {
    code,
    message,
    retryable: RETRYABLE.has(code),
    component,
    ...(extra.details !== undefined ? { details: extra.details } : {}),
    ...(extra.vendor !== undefined ? { vendor: extra.vendor } : {}),
  };
}

/**
 * A single line a human can act on.
 *
 * `appError()` deliberately returns a plain object, not an `Error` subclass, so
 * every `catch` site that reached for `String(error)` rendered a thrown AppError
 * as the literal string `[object Object]` — an error message that tells the user
 * nothing, which is exactly the "silent degradation" §17.1 forbids. Every catch
 * site formats through this instead.
 *
 * NFR-08: an unrecognised object is described by its *keys only*. Its values may
 * be a raw vendor payload or a credential, and a log line is not the place to
 * discover that.
 */
export function describeError(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === 'string') return value;
  if (value === undefined) return 'unknown error (nothing was thrown)';
  if (value === null) return 'null';
  if (typeof value === 'object') {
    try {
      const record = value as Record<string, unknown>;
      const message = record.message;
      if (typeof message === 'string' && message.length > 0) {
        const code = record.code;
        return typeof code === 'string' ? `${code}: ${message}` : message;
      }
      const keys = Object.keys(record);
      return keys.length > 0 ? `[object ${keys.slice(0, 8).join(', ')}]` : '[object]';
    } catch {
      return '[unreadable error]';
    }
  }
  return String(value);
}

export function toAppError(value: unknown, component: ErrorComponent = 'ipc'): AppError {
  if (value && typeof value === 'object' && 'code' in value && 'component' in value) {
    return value as AppError;
  }
  return appError('UNKNOWN', describeError(value), component);
}
