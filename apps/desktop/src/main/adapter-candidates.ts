import { DEFAULT_AGENT_ID } from '@ucad/contracts';

/**
 * The adapters this build tries to load, in the order they are tried.
 *
 * The table lives here, away from Electron, for the same reason
 * `tray-icon.ts` does: the README states this list to a reader — "Two adapters
 * are registered — `universal` … and `mock` …", and 中文 to the same effect —
 * and a fact written twice with nothing comparing the two drifts. The resolver
 * (`adapter-resolution.ts`) is the only production consumer, so an inlined
 * table there could be deleted
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
 *
 * Both constants below are `Object.freeze`d. Nothing in this repo writes to
 * them, and that is the point: `as const` is a *compile-time* claim, so
 * `(ADAPTER_CANDIDATES as any).mock = '@somewhere/else'` compiles, runs, and
 * changes what the app loads while this file, the resolver and the README all
 * go on describing the table above. Freezing turns that into a runtime failure
 * at the line that does it; the contract gate asserts the objects are frozen,
 * so a later edit cannot quietly drop the wrapper either.
 *
 * ## This table must stay a literal type
 *
 * `as const satisfies Record<string, string>` is load-bearing, not style.
 * `as const` keeps every key and every value a literal, and `satisfies` checks
 * the shape without widening it, so `keyof typeof ADAPTER_CANDIDATES` is exactly
 * `'universal' | 'mock'`. Both compile-time proofs below depend on that: the
 * conditional in `DEFAULT_AGENT_IS_A_CANDIDATE` resolves to `true` only because
 * the key union is narrow, and `ADAPTER_LOAD_ORDER`'s `satisfies` rejects an id
 * outside it. Annotate the object as `Record<string, string>` instead and
 * `keyof` widens to `string`: any id then satisfies both checks, they still
 * compile, and the proof that the fallback names a shipped adapter silently
 * disappears. Keep the literal type — and the freeze — when editing.
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
 * adapter the Main process loads. That leaves two files stating one fact again,
 * so this assignment makes the table the authority: remove or rename the
 * adapter and `DEFAULT_AGENT_ID` stops being a key, `never` is not assignable
 * to `true`, and the build fails here instead of the fallback drifting to an id
 * no adapter answers to.
 *
 * The proof is only as good as the key type it reads. `ADAPTER_CANDIDATES` is
 * `as const satisfies Record<string, string>`, which is what keeps
 * `keyof typeof ADAPTER_CANDIDATES` a union of the ids actually written above;
 * if that table were annotated as `Record<string, string>`, `keyof` would be
 * `string`, this conditional would always pick `true`, and the proof would pass
 * for a removed adapter. The two declarations are one mechanism — see the
 * "literal type" paragraph above.
 */
export const DEFAULT_AGENT_IS_A_CANDIDATE: typeof DEFAULT_AGENT_ID extends keyof typeof ADAPTER_CANDIDATES
  ? true
  : never = true;

/**
 * The ids of `ADAPTER_CANDIDATES`, in the order the app tries them.
 *
 * The order is behaviour, not presentation: `resolveAdapterModules` walks
 * `Object.entries(ADAPTER_CANDIDATES)`, so declaration order in the object
 * literal above *is* the attempt order — and until this constant existed, the
 * only statement of it was the phrase "in the order they are tried" in the
 * doc comment. A later reader who reorders the table (alphabetically, say, or
 * by putting the "real" adapter last) would change which adapter the app
 * reports first and which one a resolution failure names first, with nothing
 * going red.
 *
 * That reliance is on the language, not on a convention: `Object.entries` and
 * `Object.keys` return a plain object's own string keys in **insertion
 * order** (ECMAScript `OrdinaryOwnPropertyKeys`), which for an object literal
 * is the order written above, and `Object.freeze` does not change it. So the
 * list below is the table's order and not a second opinion. The guarantee is
 * conditional on the table staying an object literal of non-index string
 * keys: build it from a `Map`, from an array of entries, or give it a key
 * that looks like an array index (`'0'` sorts first), and the order the
 * resolver walks changes while every sentence here goes on describing the old
 * one. That is why the contract gate compares this list with
 * `Object.keys(ADAPTER_CANDIDATES)` itself rather than with a sorted set.
 *
 * So the order is written down twice, deliberately, and
 *
 *  - the type ties every entry to a key of the table, so renaming or removing
 *    an adapter is a `tsc` error here rather than a stale string, and
 *  - the contract gate compares this list with `Object.keys(ADAPTER_CANDIDATES)`,
 *    so a reordering, an addition or a removal that skips this constant is a
 *    red test naming both lists.
 *
 * `bootstrap.ts` also *starts* adapters in this order — it iterates this list
 * rather than an inline `['universal', 'mock']`, which was a third copy of the
 * ids and meant an adapter added to the table could resolve and be logged while
 * never being started.
 *
 * If you add an adapter, add its id here in the position it should be tried;
 * if you move one, move it here too.
 */
export const ADAPTER_LOAD_ORDER = Object.freeze([
  'universal',
  'mock',
] as const satisfies readonly (keyof typeof ADAPTER_CANDIDATES)[]);
