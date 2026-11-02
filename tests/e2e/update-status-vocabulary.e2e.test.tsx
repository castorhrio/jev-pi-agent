import { describe, expect, it } from 'vitest';
import { UPDATE_STATES, type UpdateStatus } from '@ucad/contracts';
import { isUpdateStatus, updateStatusProblem } from '@renderer/update-controller';
import { SCENARIOS, createFixtureApi } from '@renderer/dev/fixture-bridge';

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
 * a new state added to `UPDATE_STATES` arrives here as five more refusals
 * without anyone editing this list.
 *
 * The vocabulary is only half of what the contract says. `UpdateStatus` also
 * declares two required fields (`currentVersion`, `feedConfigured`) and seven
 * optional ones, and the guard used to accept a *published state with no
 * `currentVersion`* — which Settings draws as a blank version. The second half
 * of this file holds the guard to the fields, in both directions: a missing or
 * mistyped required field is refused, a present-but-mistyped optional field is
 * refused (`verified: 'no'` would light the verified badge), and an absent
 * optional field stays accepted, because every surface already has a fallback
 * for it.
 *
 * It lives under `tests/e2e/` because that config is the one that resolves
 * `@renderer` and transforms `.tsx`; it is a contract test in everything but
 * its directory.
 */

/** A status that satisfies the whole contract, so only `state` varies. */
function statusLike(state: unknown): Record<string, unknown> {
  return { state, currentVersion: '1.0.0', feedConfigured: true };
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

/** The refusal reason, required to name the field so the fix is obvious. */
const MISSING_VERSION = '`currentVersion` is missing (the contract requires a string)';
const MISSING_FEED = '`feedConfigured` is missing (the contract requires a boolean)';

describe('isUpdateStatus is the UPDATE_STATES vocabulary', () => {
  it('accepts every state the contract publishes', () => {
    for (const state of UPDATE_STATES) {
      expect(
        isUpdateStatus(statusLike(state)),
        `"${state}" is in UPDATE_STATES and the guard refused it — a published status would be dropped`,
      ).toBe(true);
      expect(updateStatusProblem(statusLike(state))).toBeNull();
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
      // The reason is the half that makes the console line usable: it has to
      // name the state, because that is what has to be added to the vocabulary
      // (or removed from Main).
      expect(updateStatusProblem(statusLike(state))).toBe(
        `\`state\` is "${state}", which is not in UPDATE_STATES`,
      );
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
      // `null` is the contract's own "no status yet" — it is not a failure, so
      // it must not be reported as if the payload were malformed drift.
      expect(updateStatusProblem(value)).toBeTypeOf('string');
    }
  });
});

describe('isUpdateStatus is the whole UpdateStatus, not only its state', () => {
  it('refuses a published state with a required field missing, and names the field', () => {
    // This is the case the state-only guard let through. `null` is the
    // interesting one of the two: `typeof null === 'object'`, so a guard that
    // asked "is it there?" rather than "is it a string" would accept it and
    // Settings would draw nothing where the version belongs.
    for (const state of UPDATE_STATES) {
      const noVersion: Record<string, unknown> = statusLike(state);
      delete noVersion.currentVersion;
      expect(isUpdateStatus(noVersion), `${state}: a status with no currentVersion was accepted`).toBe(
        false,
      );
      expect(updateStatusProblem(noVersion)).toBe(MISSING_VERSION);

      const nullVersion = { ...statusLike(state), currentVersion: null };
      expect(isUpdateStatus(nullVersion)).toBe(false);
      expect(updateStatusProblem(nullVersion)).toBe('`currentVersion` is an object, not a string');

      const noFeed: Record<string, unknown> = statusLike(state);
      delete noFeed.feedConfigured;
      expect(
        isUpdateStatus(noFeed),
        `${state}: a status with no feedConfigured was accepted — the banner would read it as "no feed"`,
      ).toBe(false);
      expect(updateStatusProblem(noFeed)).toBe(MISSING_FEED);

      // `undefined` is the same fact as "absent" under this repo's
      // `exactOptionalPropertyTypes: false`, so it has to be answered the same
      // way rather than read as a `boolean` that happens to be falsy.
      const undefinedFeed = { ...statusLike(state), feedConfigured: undefined };
      expect(isUpdateStatus(undefinedFeed)).toBe(false);
      expect(updateStatusProblem(undefinedFeed)).toBe(MISSING_FEED);
    }
  });

  it('refuses a required field of the wrong type', () => {
    // Main and renderer disagreeing about a field's type is drift of the same
    // class as an unknown state, and the surfaces render both unguarded:
    // `update.currentVersion` in Settings, `update.progress` in the banner.
    for (const [patch, expected] of [
      [{ currentVersion: 42 }, '`currentVersion` is a number, not a string'],
      [{ currentVersion: true }, '`currentVersion` is a boolean, not a string'],
      [{ feedConfigured: 'yes' }, '`feedConfigured` is a string, not a boolean'],
      [{ feedConfigured: 0 }, '`feedConfigured` is a number, not a boolean'],
    ] as const) {
      const status = { ...statusLike('available'), ...patch };
      expect(isUpdateStatus(status), `accepted ${JSON.stringify(status)}`).toBe(false);
      expect(updateStatusProblem(status)).toBe(expected);
    }
  });

  it('holds a present optional field to its declared type, and lets an absent one be', () => {
    // Absence is a state the surfaces already draw (`latestVersion ? … : ''`,
    // `progress ?? 0`), so it stays accepted. Presence with the wrong type is
    // not: `verified: 'no'` is truthy and would render "checksum verified" for
    // an installer nothing checked, which is the one claim this product cannot
    // afford to get wrong.
    const complete: UpdateStatus = {
      state: 'ready',
      currentVersion: '1.0.0',
      latestVersion: '1.1.0',
      notes: 'Release notes.',
      progress: 0.42,
      downloadedPath: '/tmp/UCAD-setup.exe',
      verified: true,
      message: 'staged',
      checkedAt: '2026-10-31T00:00:00.000Z',
      feedConfigured: true,
    };
    expect(updateStatusProblem(complete)).toBeNull();

    const minimal: UpdateStatus = { state: 'idle', currentVersion: '1.0.0', feedConfigured: true };
    expect(updateStatusProblem(minimal)).toBeNull();

    for (const [patch, expected] of [
      [{ latestVersion: 42 }, '`latestVersion` is a number, not a string'],
      [{ notes: null }, '`notes` is an object, not a string'],
      [{ progress: '0.42' }, '`progress` is a string, not a number'],
      [{ downloadedPath: false }, '`downloadedPath` is a boolean, not a string'],
      [{ verified: 'no' }, '`verified` is a string, not a boolean'],
      [{ message: {} }, '`message` is an object, not a string'],
      [{ checkedAt: 0 }, '`checkedAt` is a number, not a string'],
    ] as const) {
      const status = { ...minimal, ...patch };
      expect(isUpdateStatus(status), `accepted ${JSON.stringify(status)}`).toBe(false);
      expect(updateStatusProblem(status)).toBe(expected);
    }
  });

  it('answers isUpdateStatus and updateStatusProblem the same way', () => {
    // Two questions, one implementation: the boolean is the reason asked as
    // yes/no. If they ever disagree, one call site accepts what another
    // refuses, and the difference is invisible until somebody reads a console
    // line next to a rendered blank.
    const values: unknown[] = [
      ...UPDATE_STATES.map((state) => statusLike(state)),
      ...UPDATE_STATES.map((state) => ({ ...statusLike(state), currentVersion: undefined })),
      ...UPDATE_STATES.map((state) => ({ ...statusLike(state), feedConfigured: 2 })),
      ...NEAR_MISSES.map((state) => statusLike(state)),
      null,
      {},
      'available',
      0,
    ];
    for (const value of values) {
      expect(updateStatusProblem(value) === null, JSON.stringify(value) ?? String(value)).toBe(
        isUpdateStatus(value),
      );
    }
  });
});

describe('the browser fixture answers statuses the guard accepts', () => {
  it('answers a complete status in every scenario, so the harness cannot teach a lie', async () => {
    // The fixture is the success path's representative: it answers a finished
    // check, never `null`. `null` is still part of the contract — `app.
    // updateStatus()` may answer it, and `FixtureUpdateOverrides` types the
    // override as `() => Promise<UpdateStatus | null>` so a test can drive the
    // "nothing measured yet" path — but the default has to be a status the
    // real guard accepts, or every UI test built on the fixture proves a
    // payload the product would refuse.
    for (const scenario of SCENARIOS) {
      const { api } = createFixtureApi(scenario);
      const status: unknown = await api.app.updateStatus();
      expect(status, `${scenario}: the fixture answered no status`).not.toBeNull();
      expect(updateStatusProblem(status), `${scenario}: ${JSON.stringify(status)}`).toBeNull();
    }
  });
});
