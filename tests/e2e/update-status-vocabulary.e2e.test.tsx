import { describe, expect, it } from 'vitest';
import { UPDATE_STATES } from '@ucad/contracts';
import { isUpdateStatus } from '@renderer/update-controller';

/**
 * `isUpdateStatus` must read the contract's vocabulary, not a second copy of it.
 *
 * The guard was once "an object with a `state` key", and a renamed state was
 * written through to every surface. It now asks `UPDATE_STATES`, the tuple
 * `UpdateState` is derived from and the service derives its document policy
 * from — but that fact lived only in a comment, and the e2e case next door
 * proves one drifted value is refused, not that the accepted set is the
 * published set. A hand-written `Set` of the states, added for speed, would
 * keep that case green while `idle` or a future state silently started being
 * refused (a banner that stops updating) or accepted (a banner rendering a
 * state the tables do not know).
 *
 * So this file asks the guard about **every** member and a family of
 * near-misses derived from them. The near-misses are generated, not typed out:
 * a new state added to `UPDATE_STATES` arrives here as four more refusals
 * without anyone editing this list.
 *
 * It lives under `tests/e2e/` because that config is the one that resolves
 * `@renderer` and transforms `.tsx`; it is a contract test in everything but
 * its directory.
 */

/** A value shaped like the guard's input. Only `state` is read. */
function statusLike(state: unknown): { state: unknown; currentVersion: string } {
  return { state, currentVersion: '1.0.0' };
}

/**
 * State-shaped strings the contract does not publish.
 *
 * `reticulating` is the literal from the original incident; the rest are
 * mutations of the real vocabulary, which is where a hand-written list tends to
 * drift (case, whitespace, plural). Each one is checked against
 * `UPDATE_STATES` first, so a mutation that accidentally *is* a published state
 * fails as a broken fixture instead of asserting the guard should refuse it.
 */
const NEAR_MISSES: readonly string[] = [
  'reticulating',
  ...UPDATE_STATES.flatMap((state) => [
    state.toUpperCase(),
    `${state} `,
    ` ${state}`,
    `${state}s`,
    `not-${state}`,
  ]),
];

describe('isUpdateStatus is the UPDATE_STATES vocabulary', () => {
  it('accepts every state the contract publishes', () => {
    for (const state of UPDATE_STATES) {
      expect(
        isUpdateStatus(statusLike(state)),
        `"${state}" is in UPDATE_STATES and the guard refused it — a published status would be dropped`,
      ).toBe(true);
    }
  });

  it('refuses every state-shaped string the contract does not publish', () => {
    for (const state of NEAR_MISSES) {
      expect(
        (UPDATE_STATES as readonly string[]).includes(state),
        `fixture bug: "${state}" is a published state, so the refusal below would be wrong`,
      ).toBe(false);
      expect(
        isUpdateStatus(statusLike(state)),
        `"${state}" is not in UPDATE_STATES and the guard accepted it — a drifted state would be rendered`,
      ).toBe(false);
    }
  });

  it('refuses values that are not a status object at all', () => {
    // The old guard's "object with a `state` key" also accepted `{}` as far as
    // the key check went and then read `undefined`; these are the shapes the
    // subscription can actually hand over when a build is broken.
    for (const value of [
      null,
      undefined,
      'idle',
      42,
      true,
      [],
      {},
      { state: 42 },
      { state: null },
      { state: undefined },
      { state: {} },
    ]) {
      expect(isUpdateStatus(value), `accepted ${JSON.stringify(value) ?? String(value)}`).toBe(
        false,
      );
    }
  });
});
