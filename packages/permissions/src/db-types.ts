/**
 * Structural mirror of the `@ucad/storage` surface consumed by this package
 *.
 *
 * §0 requires a strict dependency direction, and §6 sets the precedent for
 * declaring structured interfaces locally instead of importing another plane's
 * package (`GitLike` / `SessionStoreLike`). The real `Database` from
 * `@ucad/storage` is structurally assignable to {@link DatabaseLike}, so
 * `new PermissionEngine({ db, logger })` accepts it unchanged, but this package
 * never has to hard-depend on the storage build order.
 *
 * Only the members actually used are declared: a wider structural type would
 * make assignability depend on members nobody calls.
 */

/** §2 `RunResult`. */
export interface RunResultLike {
  changes: number;
  lastInsertRowid: number;
}

/** §2 `SqlDriver`, reduced to the members the Permission Engine uses. */
export interface SqlDriverLike {
  run(sql: string, params?: unknown[]): RunResultLike;
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[];
  get<T = Record<string, unknown>>(sql: string, params?: unknown[]): T | undefined;
  transaction<T>(fn: () => T): T;
}

/** §2 `Database`, reduced to the members the Permission Engine uses. */
export interface DatabaseLike {
  readonly driver: SqlDriverLike;
  readonly schemaVersion: number;
  transaction<T>(fn: () => T): T;
}
