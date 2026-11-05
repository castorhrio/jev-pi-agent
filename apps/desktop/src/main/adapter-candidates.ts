import { DEFAULT_AGENT_ID } from '@ucad/contracts';

/**
 * The adapters this build tries to load, in the order they are tried.
 *
 * The table lives here, away from Electron, because the README states this list
 * to a reader in both languages and `tests/contract/adapter-candidates.test.ts`
 * compares the two. `adapter-resolution.ts` is the only production consumer.
 *
 * A missing entry must not stop the app from starting (ADR-017), so this is a
 * list of attempts, not a requirement: `resolveAdapterModules` logs each failure
 * and carries on.
 *
 * Ids are the user-visible names — settings, the `adapters resolved` log line,
 * the README. The specifier is a bare package name resolved through Node, not a
 * relative path, because the workspace layout is gone once the app is packaged.
 *
 * Both constants are frozen. `as const` is a compile-time claim only, so
 * `(ADAPTER_CANDIDATES as any).mock = '@somewhere/else'` would compile, run and
 * change what the app loads; freezing turns that into a runtime failure at the
 * line that does it, and the contract gate asserts both objects are frozen. The
 * freeze is shallow, which is enough while every value is a string — if an id
 * ever maps to an object, freeze the nested value too.
 *
 * Keep `as const satisfies Record<string, string>`. It is what makes
 * `keyof typeof ADAPTER_CANDIDATES` the union of the ids written below, and both
 * compile-time proofs in this file depend on that: annotate the object as
 * `Record<string, string>` instead and `keyof` widens to `string`, so the proofs
 * go on compiling while proving nothing.
 */
export const ADAPTER_CANDIDATES = Object.freeze({
  // The reference adapter that actually talks to a model.
  universal: '@ucad/adapter-universal',
  // The executable specification of the protocol, for offline work and CI.
  mock: '@ucad/adapter-mock',
} as const satisfies Record<string, string>);

/**
 * Compile-time proof that the fallback agent names an adapter this build ships.
 *
 * `DEFAULT_AGENT_ID` lives in the contracts package because the Renderer needs
 * it, and the Renderer must not import a Main-process module to learn which
 * adapter the Main process loads. This assignment makes the table the authority:
 * remove or rename the adapter and `DEFAULT_AGENT_ID` stops being a key, `never`
 * is not assignable to `true`, and the build fails here instead of the fallback
 * drifting to an id no adapter answers to.
 */
export const DEFAULT_AGENT_IS_A_CANDIDATE: typeof DEFAULT_AGENT_ID extends keyof typeof ADAPTER_CANDIDATES
  ? true
  : never = true;

/**
 * The ids of `ADAPTER_CANDIDATES`, in the order the app tries them.
 *
 * The order is behaviour, not presentation: `resolveAdapterModules` walks
 * `Object.entries(ADAPTER_CANDIDATES)`, and `Object.entries` returns an object
 * literal's own string keys in insertion order, so declaration order above *is*
 * the attempt order. Reordering the table changes which adapter the app reports
 * first and which one a failure names first.
 *
 * So the order is written down twice on purpose, and both copies are checked:
 *
 *  - the type ties every entry to a key of the table, so renaming or removing an
 *    adapter is a `tsc` error here rather than a stale string, and
 *  - the contract gate compares this list with `Object.keys(ADAPTER_CANDIDATES)`,
 *    so a reordering, an addition or a removal that skips this constant is a red
 *    test naming both lists.
 *
 * `bootstrap.ts` starts adapters by iterating this list rather than an inline
 * `['universal', 'mock']`, which was a third copy of the ids and meant an
 * adapter added to the table could resolve and be logged while never being
 * started.
 *
 * If you add an adapter, add its id here in the position it should be tried; if
 * you move one, move it here too.
 */
export const ADAPTER_LOAD_ORDER = Object.freeze([
  'universal',
  'mock',
] as const satisfies readonly (keyof typeof ADAPTER_CANDIDATES)[]);
