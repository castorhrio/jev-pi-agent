/**
 * The interface states the browser harness can be asked for — one list, one
 * type, one validator.
 *
 * ## Why this is not a type union in `fixture-bridge.ts` any more
 *
 * The scenario names used to be written down three times: a hand-written union
 * (`type Scenario = 'default' | …`), a hand-written array (`SCENARIOS`), and
 * `?scenario=` URLs in prose (README ×2, the step 6 checklist, the layout
 * targets). The union and the array sit next to each other and look like one
 * fact, so adding a state to one and not the other is invisible:
 *
 *  - added to the **union only**: `createFixtureApi('ochre')` type-checks and
 *    the fixture renders it, but `scenarioFromLocation()` validates against the
 *    array, so `?scenario=ochre` silently falls back to `default`. The state
 *    exists in the tests that construct it directly and nowhere a person can
 *    look at it — which is exactly how the five states of step 6 went five
 *    rounds without being looked at.
 *  - added to the **array only**: dead entries the compiler does not check,
 *    and `scenarioFromLocation()` returns a value nobody handles.
 *
 * The array is now the fact and the type is derived from it, so there is one
 * direction that can drift and it is a one-line change. `STATE_SCENARIOS` is
 * the subset the checklist asks a person to open by hand, and it is derived
 * with `satisfies` so a typo is a `npm run typecheck` failure rather than a
 * `?scenario=` that quietly shows the happy path.
 *
 * `tests/contract/scenario-states.test.ts` is what keeps the four consumers —
 * this file, the E2E suite, the layout gate, and the prose that tells a person
 * which URLs to open — pointing at the same five names.
 */

/**
 * Every scenario the harness knows, in the order a person is expected to meet
 * them: the populated workspace first, then the states worth visiting.
 *
 * `as const` rather than `Scenario[]`: the array is the type's source, and a
 * widened array type would let the two drift apart again (adding a string to
 * `SCENARIOS: string[]` would keep compiling while the union stayed behind).
 */
export const SCENARIOS = [
  'default',
  'empty',
  'loading',
  'error',
  'partial',
  'permission',
] as const;

/** The scenario names, as a union. Derived from {@link SCENARIOS}. */
export type Scenario = (typeof SCENARIOS)[number];

/** What `?scenario=` resolves to when it is missing or unrecognised. */
export const DEFAULT_SCENARIO = 'default' satisfies Scenario;

/**
 * The states step 6 of the manual checklist asks a person to look at.
 *
 * `default` is absent on purpose: it is the populated happy path, which
 * `critical-path.e2e.test.tsx` already drives end to end, and listing it here
 * would let "all five states are covered" be satisfied by the happy path.
 */
export const STATE_SCENARIOS = [
  'empty',
  'loading',
  'error',
  'partial',
  'permission',
] as const satisfies readonly Scenario[];

/** One of {@link STATE_SCENARIOS}. */
export type StateScenario = (typeof STATE_SCENARIOS)[number];

/**
 * The state whose *in-flight* frame is worth catching.
 *
 * `loading` delays every read, so the settled screen is the ordinary populated
 * one and the interesting frame is the one before the reads come back. Named
 * here so the layout gate can point at it without writing the state name a
 * second time.
 */
export const IN_FLIGHT_SCENARIO = 'loading' satisfies StateScenario;

/**
 * The states whose screen carries a failure message the product did not write.
 *
 * `error` paints the fatal pane (`App.tsx`'s `if (fatal)` branch, whose `<p>`
 * is the message verbatim) and `partial` paints a `ReadFailure` in the chat
 * region and in the rail. Both strings come from downstream — an IPC error, a
 * store that could not be opened, a path that does not exist — so their length
 * is not something this repository decides.
 *
 * Named here for the same reason `IN_FLIGHT_SCENARIO` is: the layout gate needs
 * to point at these two screens without spelling the state names out a second
 * time, and `tests/contract/scenario-states.test.ts` fails a target URL that
 * writes a walkable state inline.
 */
export const FAILURE_REASON_SCENARIOS = ['error', 'partial'] as const satisfies
  readonly StateScenario[];

/**
 * The query parameter that makes every failure reason carry a tail with no
 * break opportunity in it.
 *
 * `?reason=long` exists because the fixture's own reasons are short
 * (`[fixture:partial] sessions.list failed`), and a short reason cannot show
 * whether the box that renders it survives the shape a real one arrives in: a
 * Windows path, a URL, a stack frame — one token, two hundred characters, no
 * space to break at. The layout gate measures that shape at the tightest window
 * the product allows; see `tests/contract/layout.test.ts`.
 *
 * It is a harness knob, not a product feature: nothing in `apps/desktop/src`
 * outside `dev/` reads it, and the production bundle never installs the
 * fixture at all.
 */
export const LONG_REASON_PARAM = 'reason';

/** The value of {@link LONG_REASON_PARAM} that turns the long tail on. */
export const LONG_REASON_VALUE = 'long';

/**
 * Whether a `location.search` string asks for the long failure reason.
 *
 * Read through `URLSearchParams` rather than by matching the raw string, so
 * `?reason=long` and `?scenario=partial&reason=long` both work and a value that
 * merely contains the word (`?reason=longer`) does not.
 */
export function longReasonFromLocation(search: string): boolean {
  return new URLSearchParams(search).get(LONG_REASON_PARAM) === LONG_REASON_VALUE;
}

/**
 * A failure reason of the shape the product cannot control.
 *
 * A Windows path is the honest example: it is what an IPC error, a store that
 * could not be opened or a missing file actually says, it is long, and it
 * contains no space, no hyphen and no slash a line breaker may use — so a box
 * that renders it either wraps mid-token or pushes the window sideways. Two
 * hundred characters is past the width of every panel in the app at the
 * tightest window, which is the point: the tail must be longer than the box.
 *
 * Exported because the layout gate asserts that this exact string reached the
 * failure box: a copy of it in the test would be a second fact, and the two
 * would drift the first time the tail changed.
 */
export const LONG_REASON_TAIL =
  'C:\\Users\\someone\\AppData\\Local\\Programs\\UCAD\\resources\\app.asar\\node_modules\\@ucad\\desktop\\dist\\main\\bootstrap.js' +
  '\\C:\\Users\\someone\\AppData\\Local\\Programs\\UCAD\\resources\\app.asar\\node_modules\\@ucad\\desktop\\dist\\main\\bootstrap.js';

/** Whether a string names a scenario the harness can install. */
export function isScenario(value: string | null | undefined): value is Scenario {
  return typeof value === 'string' && (SCENARIOS as readonly string[]).includes(value);
}

/**
 * Reads the scenario out of a `location.search` string.
 *
 * The validation goes through {@link SCENARIOS} and not through a second list,
 * so a state that exists is reachable from a URL and a state that does not is
 * the happy path rather than a half-installed fixture.
 */
export function scenarioFromLocation(search: string): Scenario {
  const raw = new URLSearchParams(search).get('scenario');
  return isScenario(raw) ? raw : DEFAULT_SCENARIO;
}
