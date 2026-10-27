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
 *    `failure` and owned by the pending action. The alternative is a button
 *    that does nothing and says nothing;
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
import type { UpdateStatus } from '@ucad/contracts';
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
  // An install answers with a boolean, not a status (the app quits), so any
  // settled status ends it. A failed install arrives as a rejected IPC call —
  // `failure` — which this table never sees.
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
  const pendingRef = useRef<PendingAction | null>(null);

  const applyStatus = useCallback((next: UpdateStatus) => {
    setStatus(next);
    // A real status is a better answer than a rejection or a failed read, so
    // it replaces them rather than sitting beside them.
    setFailure(null);
    setStatusFailure(null);
    const action = pendingRef.current;
    if (action !== null && actionCompleted(action, next.state)) {
      pendingRef.current = null;
      setPendingAction(null);
    }
  }, []);

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
   * Starts an action and turns its rejection into the failure the user sees.
   *
   * The pending action is kept on rejection: `failure` is rendered under the
   * same ownership rule as an error status, and dismissing or retrying is what
   * ends it. Without this the rejection would be an unhandled promise and the
   * click would look like a no-op.
   */
  const run = useCallback(
    (action: PendingAction, start: () => Promise<unknown>): void => {
      pendingRef.current = action;
      setPendingAction(action);
      setFailure(null);
      void start()
        .then((next) => {
          // `installUpdate()` answers a boolean; every other call answers the
          // status the subscription also sees. Applying it twice is harmless —
          // the state is the same — and it is what lets a check settle without
          // waiting for a push.
          if (isUpdateStatus(next)) applyStatus(next);
        })
        .catch((error: unknown) => {
          setFailure(describeError(error));
        });
    },
    [applyStatus],
  );

  const check = useCallback(() => run('check', () => getApi().app.checkUpdate()), [run]);
  const download = useCallback(() => run('download', () => getApi().app.downloadUpdate()), [run]);
  const install = useCallback(() => run('install', () => getApi().app.installUpdate()), [run]);

  const dismissFailure = useCallback(() => {
    pendingRef.current = null;
    setPendingAction(null);
    setFailure(null);
  }, []);

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

/** Whether a value is the status one of the update calls promises. */
function isUpdateStatus(value: unknown): value is UpdateStatus {
  return typeof value === 'object' && value !== null && 'state' in value;
}
