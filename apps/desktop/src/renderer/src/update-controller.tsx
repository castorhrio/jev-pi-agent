/**
 * One controller for the update card and the update banner.
 *
 * The banner used to own this state, and Settings owned a second copy: its own
 * `update`, its own subscription, and three `.catch(() => undefined)` calls
 * around the actions. That is the same contract implemented twice, and the
 * second copy had lost the half that matters — a click that failed said
 * nothing at all. Sharing the state is not tidiness for its own sake: a
 * download started from the banner is the download the Settings card is
 * watching, and a failure belongs to whichever surface the user acted in.
 *
 * The rules this controller implements:
 *  - every action ends at a status listed in `ACTION_COMPLETED_STATES`, and
 *    nowhere else — progress never ends one, or a download that fails after its
 *    progress bar appeared would lose the failure;
 *  - an IPC rejection is a failure with no status, so it is kept locally as
 *    `failure`. The alternative is a button that does nothing and says
 *    nothing;
 *  - only the most recently started action owns the answer. A check that
 *    resolves after the user has moved on to a download must not retire that
 *    download, and two clicks on the same button are two actions;
 *  - a pushed status outranks the action it ends. When Main pushes a state the
 *    table counts as an ending for the pending action, that action is over:
 *    the push is the service stating what is true now, and the click's own late
 *    answer is dropped (its token no longer matches a cleared `pendingRef`).
 *    The opposite—a click's answer outranking a push—would let a stale answer
 *    overwrite what Main has just measured. `tests/e2e/update-controller.e2e.test.tsx`
 *    pins this direction;
 *  - a failed *initial read* is a different fact from a failed action, and gets
 *    its own field (`statusFailure`). The banner stays quiet about it — the app
 *    checks on startup, and an offline launch must not open with an error
 *    banner about a check nobody asked for — while Settings, which is where a
 *    user goes looking, says what happened.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import { UPDATE_STATES, type UpdateStatus } from '@ucad/contracts';
import { getApi } from './api';
import { describeError } from './error-message';

/** The action the user started from one of the update surfaces. */
export type PendingAction = 'download' | 'install' | 'check';

/**
 * Which statuses mean each action is over — one row per action, no complement.
 *
 * The rule used to be a complement (`not error, not checking, not downloading
 * → over`, with a special case for a download), which is a rule you can only
 * read by subtracting: a *new* state silently counted as an ending for every
 * action, so the banner would forget a check while it was still running. As a
 * table the question is asked per status and per action, a new `UpdateState`
 * is a row somebody has to answer, and `tests/e2e/update-banner.e2e.test.tsx`
 * walks the cross product to check that this is the table `actionCompleted()`
 * actually reads.
 *
 * `error` is in no row on purpose — the failure is what the pending action is
 * for. Progress (`checking`, `downloading`) is in no row either: a download
 * that has shown its bar is still the download whose failure the user is
 * waiting on.
 */
export const ACTION_COMPLETED_STATES = {
  // A check answers with where the app stands now: up to date, a version to
  // download, a verified installer, or no feed. `idle` is the service before
  // any check and still an answer to a click that arrived during start-up.
  check: ['idle', 'up-to-date', 'available', 'ready', 'unsupported'],
  // Only `ready`: `available` is the state a download *starts* from, so it
  // cannot be the download's answer, and `up-to-date` would be a check's.
  download: ['ready'],
  // An install normally answers with a boolean rather than a status (the app
  // quits), so the controller releases it when the call settles; a status is
  // the other way an install can end, for the paths that stay alive. A failed
  // install arrives as a rejected IPC call — `failure` — which this table never
  // sees.
  install: ['idle', 'up-to-date', 'available', 'ready', 'unsupported'],
} as const satisfies Readonly<Record<PendingAction, readonly UpdateStatus['state'][]>>;

/**
 * The states no action ends at — progress and failure, on purpose.
 *
 * Every `UpdateState` must be either an ending in at least one row above or
 * listed here. The list is the place a new state goes when the honest answer is
 * "an action is still waiting on this"; without it, a new state is neither an
 * ending nor a decision, and silence is indistinguishable from an oversight.
 * `tests/e2e/update-banner.e2e.test.tsx` checks both directions.
 */
export const NEVER_TERMINAL_STATES = [
  'checking',
  'downloading',
  // `error` is answered by the banner's failure contract, not by forgetting
  // the action that produced it.
  'error',
] as const satisfies readonly UpdateStatus['state'][];

/**
 * The compile-time half of "every state is classified".
 *
 * The e2e suite walks the cross product at runtime, but a new `UpdateState`
 * that nobody classified would still be a state whose pending action is
 * never released — a silent stuck spinner, found only by a human clicking
 * long enough. Asking the type system the same question makes that omission a
 * `tsc` error: `Exclude` of everything classified must be `never`.
 *
 * The aliases below are not exported, and none of them is a value: the two
 * `T extends never = …` defaults *are* the assertions. `_EndingState` and
 * `_NeverTerminalState` are the vocabularies the tables contribute, and the
 * two assertions ask the two halves of the question — nothing unclassified,
 * and nothing classified twice.
 */
type _EndingState = (typeof ACTION_COMPLETED_STATES)[PendingAction][number];
type _NeverTerminalState = (typeof NEVER_TERMINAL_STATES)[number];
type _EveryStateIsClassified<
  T extends never = Exclude<UpdateStatus['state'], _EndingState | _NeverTerminalState>,
> = T;
/**
 * The other direction: no state may be in both tables.
 *
 * `_EveryStateIsClassified` only says nothing is *missing*. A state added to
 * an ending row *and* to `NEVER_TERMINAL_STATES` would satisfy it while the
 * two tables contradict each other — `actionCompleted()` would release the
 * pending action for a state the other table says is still in flight, which is
 * the stuck-spinner bug in the opposite direction. The e2e suite asserts the
 * disjointness at runtime (it has to: `npm test` does not typecheck), but only
 * for the states it walks. This alias makes the overlap a `tsc` error at the
 * edit that causes it, with `Extract` naming the state in the compiler's
 * message.
 */
type _NoStateIsBothEndingAndNeverTerminal<
  T extends never = Extract<_EndingState, _NeverTerminalState>,
> = T;

/**
 * Whether a status means `action` is over, so the surfaces may forget it.
 *
 * Reads the table rather than deciding again: the e2e suite asserts the two
 * agree for every action × state pair, so a state this function answered
 * differently would be a red test instead of a second opinion.
 */
export function actionCompleted(action: PendingAction, state: UpdateStatus['state']): boolean {
  const endings: readonly UpdateStatus['state'][] = ACTION_COMPLETED_STATES[action];
  return endings.includes(state);
}

export interface UpdateController {
  status: UpdateStatus | null;
  pendingAction: PendingAction | null;
  /** The reason an action the user started failed. */
  failure: string | null;
  /** The reason the initial status read failed, when there is no status at all. */
  statusFailure: string | null;
  check(): void;
  download(): void;
  install(): void;
  dismissFailure(): void;
}

const UpdateControllerContext = createContext<UpdateController | null>(null);

export function UpdateControllerProvider({ children }: { children: ReactNode }): JSX.Element {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [statusFailure, setStatusFailure] = useState<string | null>(null);
  // The subscription is installed once, so it cannot read the render-time
  // `pendingAction`: a status pushed ten seconds after the click would still
  // see the value from mount. The ref is the current one.
  //
  // The token matters as much as the action. Identity by action alone would
  // let two clicks on the same button share one answer — the first click's
  // late result would retire the second click, which is still waiting. The
  // token is bumped per call, so only the click that is still current may
  // apply a status or a failure.
  const pendingRef = useRef<{ action: PendingAction; token: number } | null>(null);
  const tokenRef = useRef(0);

  /**
   * Drops both kinds of failure at once.
   *
   * They are cleared together on purpose: a real status, a fresh action and a
   * dismissal all make the old failure stale, and clearing only the one the
   * caller happened to think of is how `failure` and `statusFailure` came to
   * disagree across three call sites.
   */
  const clearFailures = useCallback(() => {
    setFailure(null);
    setStatusFailure(null);
  }, []);

  const applyStatus = useCallback(
    (next: UpdateStatus) => {
      // The subscription hands this function whatever Main pushed, typed only
      // at compile time. A state outside `UPDATE_STATES` is contract drift,
      // not a status; writing it through would make every surface render a
      // state the tables do not know about.
      if (!isUpdateStatus(next)) return;
      setStatus(next);
      // A real status is a better answer than a rejection or a failed read, so
      // it replaces them rather than sitting beside them.
      clearFailures();
      const pending = pendingRef.current;
      if (pending !== null && actionCompleted(pending.action, next.state)) {
        pendingRef.current = null;
        setPendingAction(null);
      }
    },
    [clearFailures],
  );

  useEffect(() => {
    const api = getApi();
    let cancelled = false;
    void api.app
      .updateStatus()
      .then((next) => {
        // `null` means the service has no status yet, which is not a failure.
        if (!cancelled && next) applyStatus(next);
      })
      .catch((error: unknown) => {
        if (!cancelled) setStatusFailure(describeError(error));
      });
    const unsubscribe = api.app.onUpdateStatus(applyStatus);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [applyStatus]);

  /**
   * Takes ownership of an answer, and ends the one action that ends with its
   * call.
   *
   * Ownership is checked against the token, not just the action name: a check
   * started before a download must not apply its late status (which may be an
   * ending for the download) or overwrite the download's failure. `false` means
   * the action was superseded, and the caller drops the answer silently.
   *
   * An install ends when `installUpdate()` settles, whether it resolved or
   * rejected. A success normally quits the app, but the harness, `dev:web` and
   * a quit the user cancels all stay alive: leaving the action set there would
   * claim an install that is over, and the next background failure would be
   * attributed to a click nobody is waiting on. A rejection ends it too —
   * nothing can be retried without a fresh check, and the banner draws the
   * local `failure` without asking for a pending action. Both outcomes go
   * through this one release, so success and failure cannot drift apart.
   *
   * Every other action ends from `ACTION_COMPLETED_STATES` in `applyStatus`, so
   * this function deliberately releases only `install`.
   *
   * One invariant holds across both paths: for a given token, at most one call
   * clears `pendingRef`. An install that answers with a status (`idle`, say)
   * runs `settle` first and then `applyStatus`; the second sees `null` and
   * cannot retire an action that has since replaced it.
   */
  const settle = useCallback((action: PendingAction, token: number): boolean => {
    if (pendingRef.current?.token !== token) return false;
    if (action === 'install') {
      pendingRef.current = null;
      setPendingAction(null);
    }
    return true;
  }, []);

  /**
   * Starts an action and turns its rejection into the failure the user sees.
   *
   * The answer is claimed through `settle` before anything is applied: a stale
   * answer neither rewrites the status nor overwrites the current action's
   * failure.
   */
  const run = useCallback(
    (action: PendingAction, start: () => Promise<unknown>): void => {
      const token = tokenRef.current + 1;
      tokenRef.current = token;
      pendingRef.current = { action, token };
      setPendingAction(action);
      // Acting is a better answer than the failed read or the previous
      // rejection, so both go; if this action fails, its own `failure` is the
      // one the user sees.
      clearFailures();
      void start()
        .then((next) => {
          if (!settle(action, token)) return;
          // `installUpdate()` answers a boolean; every other call answers the
          // status the subscription also sees. Applying it twice is harmless —
          // the state is the same — and it is what lets a check settle without
          // waiting for a push.
          if (isUpdateStatus(next)) applyStatus(next);
        })
        .catch((error: unknown) => {
          if (!settle(action, token)) return;
          setFailure(describeError(error));
        });
    },
    [applyStatus, clearFailures, settle],
  );

  const check = useCallback(() => run('check', () => getApi().app.checkUpdate()), [run]);
  const download = useCallback(() => run('download', () => getApi().app.downloadUpdate()), [run]);
  const install = useCallback(() => run('install', () => getApi().app.installUpdate()), [run]);

  const dismissFailure = useCallback(() => {
    pendingRef.current = null;
    setPendingAction(null);
    // Dismissing is the user saying "I have read this", so it clears the
    // failed read too: the card and the banner share one controller, and a
    // card still showing statusFailure after the dismissal would make the
    // close button look broken.
    clearFailures();
  }, [clearFailures]);

  const value = useMemo<UpdateController>(
    () => ({
      status,
      pendingAction,
      failure,
      statusFailure,
      check,
      download,
      install,
      dismissFailure,
    }),
    [status, pendingAction, failure, statusFailure, check, download, install, dismissFailure],
  );

  return (
    <UpdateControllerContext.Provider value={value}>{children}</UpdateControllerContext.Provider>
  );
}

export function useUpdateController(): UpdateController {
  const controller = useContext(UpdateControllerContext);
  if (controller === null) {
    throw new Error('useUpdateController must be used inside <UpdateControllerProvider>');
  }
  return controller;
}

/**
 * Whether a value is the status one of the update calls promises.
 *
 * The old check was "an object with a `state` key", which accepts
 * `{ state: 'whatever' }` — exactly the contract drift this guard exists to
 * stop. The state must be a member of `UPDATE_STATES`, the same tuple the
 * service derives its own policy table from, so a state added on one side and
 * not the other is refused instead of rendered.
 */
function isUpdateStatus(value: unknown): value is UpdateStatus {
  if (typeof value !== 'object' || value === null) return false;
  const state = (value as { state?: unknown }).state;
  return typeof state === 'string' && (UPDATE_STATES as readonly string[]).includes(state);
}
