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
  // A subsystem was read from the composition root before `start()` built it.
  // This was reported as `STORAGE_ERROR`, which pointed a support report at
  // SQLite when the fault was the container's lifecycle.
  | 'CONTAINER_NOT_STARTED'
  | 'MIGRATION_FAILED'
  | 'BUDGET_EXCEEDED'
  | 'INJECTION_UNSUPPORTED'
  | 'TOOL_CONTRACT_UNAVAILABLE'
  | 'DECISION_TIMEOUT'
  | 'INTELLIGENCE_UNAVAILABLE'
  // The refusals below used to be plain `Error`s with only a message.
  // The message is what the user reads; the code is what the log line, the
  // support report and any later statistics read. Without one, "the project
  // is not there" and "the provider exploded" were both `UNKNOWN`.
  | 'WORKSPACE_NOT_FOUND'
  | 'NO_ACTIVE_WORKSPACE'
  | 'NOT_FOUND'
  | 'INVALID_INPUT'
  // A write was refused because the file changed since the caller read it
  // (§11.3 optimistic concurrency). It has its own code because the Renderer
  // has a real decision to offer — reload, or overwrite on purpose — and a
  // message it would have to pattern-match is not a contract.
  | 'REVISION_CONFLICT'
  // Something this build has no way to offer right now: no window to put a
  // dialog in, no update service wired up, an attachment type no adapter
  // reads. The message names which one; the code keeps the refusal out of
  // `UNKNOWN`, where it was indistinguishable from a crash.
  | 'FEATURE_UNAVAILABLE'
  | 'UNKNOWN';

export type ErrorComponent =
  | 'agent'
  | 'context'
  | 'intelligence'
  | 'decision'
  | 'storage'
  | 'ipc'
  // The composition root itself: a subsystem reached before `start()` built
  // it. Distinct from `storage`, which is the layer the caller would have
  // used — a report that filters on `storage` must not collect it.
  | 'container';

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

/**
 * Whether each code is worth retrying.
 *
 * A `Set` of the retryable codes answered "false" for every code it did not
 * name, so a new code inherited "not retryable" without anyone deciding that —
 * and `tsc` could not tell a deliberate `false` from a forgotten row. The
 * record makes the classification total: adding a member to `AppErrorCode`
 * fails the build until this table answers for it. Exported for the runtime
 * half of the same check (`tests/contract/error-formatting.test.ts`), because
 * a test cannot enumerate a type and the suite transpiles without typechecking.
 */
export const RETRYABLE: Readonly<Record<AppErrorCode, boolean>> = {
  WORKSPACE_NOT_TRUSTED: false,
  ADAPTER_NOT_AVAILABLE: false,
  AGENT_START_FAILED: false,
  NATIVE_SESSION_LOST: false,
  PERMISSION_DENIED: false,
  // The process can be started again; the fault is not in the request.
  PROCESS_EXITED: true,
  // A host that stopped answering may answer on the next attempt.
  HOST_UNRESPONSIVE: true,
  AUTH_REQUIRED: false,
  // Transient by definition.
  RATE_LIMITED: true,
  NETWORK_ERROR: true,
  // A locked or busy database is retried; a failed migration is not, and has
  // its own code.
  STORAGE_ERROR: true,
  CONTAINER_NOT_STARTED: false,
  MIGRATION_FAILED: false,
  BUDGET_EXCEEDED: false,
  INJECTION_UNSUPPORTED: false,
  TOOL_CONTRACT_UNAVAILABLE: false,
  DECISION_TIMEOUT: false,
  INTELLIGENCE_UNAVAILABLE: false,
  WORKSPACE_NOT_FOUND: false,
  NO_ACTIVE_WORKSPACE: false,
  NOT_FOUND: false,
  INVALID_INPUT: false,
  // The retry is the user's decision, not an automatic one: retrying with the
  // same expected revision would fail again.
  REVISION_CONFLICT: false,
  FEATURE_UNAVAILABLE: false,
  UNKNOWN: false,
};

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
    retryable: RETRYABLE[code],
    component,
    ...(extra.details !== undefined ? { details: extra.details } : {}),
    ...(extra.vendor !== undefined ? { vendor: extra.vendor } : {}),
  };
}

/**
 * The throwable form of `appError()`.
 *
 * `appError()` returns a plain object, and a plain object is the right thing to
 * *return*. It is the wrong thing to *throw*:
 *
 *  - `throw { code, message }` reaches `ipcMain.handle`, which serialises the
 *    rejection to the Renderer; only `Error` instances are carried faithfully,
 *    and even then only the *message* survives the bridge — a bare object
 *    arrives as unhelpful text;
 *  - half the app catches with `instanceof Error`, and a thrown object silently
 *    stops matching those branches;
 *  - the old workaround at the call sites was
 *    `throw new Error(appError('PERMISSION_DENIED', …).message)`, which kept the
 *    message and threw the code away — so the log line for a refusal nobody
 *    could distinguish from a crash said `UNKNOWN`.
 *
 * `codedError()` is an `Error` that carries `code`/`component`/`retryable`, so
 * `handle()` in `ipc.ts` logs a stable code while `error.message` stays the
 * user-safe sentence it always was. `toAppError()` recognises it as-is.
 *
 * The code stops there — at Main's log line. It is **not** part of what the
 * Renderer receives: `handle()` logs the full `AppError` and then rejects with
 * `new Error(appError.message)`, so the Renderer gets one sentence and no
 * fields. That narrowing is deliberate, not incidental. Electron carries an
 * `Error` across the bridge as its message, so a `code` attached here would
 * arrive as `undefined` anyway; a Renderer that branched on it would branch on
 * nothing, forever. Read the sentence for the user, read this object for the
 * log. `tests/contract/ipc-error-bridge.test.ts` holds the boundary.
 */
export function codedError(
  code: AppErrorCode,
  message: string,
  component: ErrorComponent,
): Error & { code: AppErrorCode; component: ErrorComponent; retryable: boolean } {
  return Object.assign(new Error(message), {
    name: 'AppFailure',
    code,
    component,
    retryable: RETRYABLE[code],
  });
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

/**
 * The canonical `AppError` a thrown value carries, if any.
 *
 * Planes such as `@ucad/files` and `@ucad/git` throw an `AppErrorThrow`, which
 * keeps the `AppError` on `.appError` instead of spreading `code`/`component`
 * onto the `Error` itself. `toAppError()` used to look only at the top level,
 * so every one of those refusals became `UNKNOWN` in the IPC log — the exact
 * collapse `codedError()` was introduced to end. Reading the carried shape is
 * how the log (and a bridge rule that needs a stable code) sees the code the
 * plane actually chose.
 */
export function carriedAppError(value: unknown): AppError | null {
  if (value === null || typeof value !== 'object') return null;
  if ('code' in value && 'component' in value) return value as AppError;
  const nested = (value as { appError?: unknown }).appError;
  if (nested !== null && typeof nested === 'object' && 'code' in nested && 'component' in nested) {
    return nested as AppError;
  }
  return null;
}

export function toAppError(value: unknown, component: ErrorComponent = 'ipc'): AppError {
  const carried = carriedAppError(value);
  if (carried !== null) return carried;
  return appError('UNKNOWN', describeError(value), component);
}
