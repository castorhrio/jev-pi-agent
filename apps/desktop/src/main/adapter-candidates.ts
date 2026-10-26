/**
 * The adapters this build tries to load, in the order they are tried.
 *
 * The table lives here, away from Electron, for the same reason
 * `tray-icon.ts` does: the README states this list to a reader — "Two adapters
 * are registered — `universal` … and `mock` …", and 中文 to the same effect —
 * and a fact written twice with nothing comparing the two drifts. `bootstrap.ts`
 * is the only production consumer, so an inlined table there could be deleted
 * or extended without any test noticing, while the README went on describing
 * the old set. The contract gate
 * (`tests/contract/adapter-candidates.test.ts`) imports this constant and
 * compares it with the provider limitation in both languages of the README.
 *
 * A missing entry must not stop the app from starting (ADR-017: no single
 * adapter is required), so the table is a list of *attempts*, not a
 * requirement: `resolveAdapterModules` logs each failure and carries on.
 *
 * Ids are the user-visible names — they appear in settings, in the log line
 * "adapters resolved", and in the README. The specifier is a bare package name
 * resolved through Node, not a relative path, because the workspace layout is
 * gone once the app is packaged.
 */
export const ADAPTER_CANDIDATES = {
  // The reference adapter that actually talks to a model.
  universal: '@ucad/adapter-universal',
  // The executable specification of the protocol, for offline work and CI.
  mock: '@ucad/adapter-mock',
} as const satisfies Record<string, string>;
