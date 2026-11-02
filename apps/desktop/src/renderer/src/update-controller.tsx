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
 *  - a check and a download end at a status listed in
 *    `ACTION_COMPLETED_STATES`, and nowhere else — progress never ends one, or
 *    a download that fails after its progress bar appeared would lose the
 *    failure. An install is the exception, and its row is empty on purpose:
 *    `installUpdate()` answers a boolean, so the call settling is its only
 *    ending (`CALL_SETTLED_ACTIONS`);
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
 *  - a push is authoritative only over the endings it declares. The status is
 *    always updated — Main has just measured it — but the pending action is
 *    released exactly when `ACTION_COMPLETED_STATES` says this state ends that
 *    action. A push that is progress, or an ending for some *other* action,
 *    therefore leaves the click in flight: a download is not over because a
 *    background check pushed `available` (which is where a download starts).
 *    Reading "push wins" as "any push ends the action" would retire the
 *    download the user is waiting on; the same e2e file asserts both halves;
 *  - a pushed status that does not match the contract is drift, not a status:
 *    a state outside `UPDATE_STATES` *or* a field of the wrong type, or a
 *    required field that is missing (`updateStatusProblem`). It is refused
 *    *and* warned about, with the reason, because dropping it is otherwise
 *    invisible — no surface renders the payload, so the renderer would look
 *    like a banner that simply stopped updating. A status with a legal state
 *    and no `currentVersion` used to be accepted, which is how the Settings
 *    card came to show a blank version instead of the last status it could
 *    trust;
 *  - that refusal is the same answer for an action's own answer. A click whose
 *    call resolves something that is not a status is drift too: it is warned
 *    about and the pending action is released, because leaving it set would
 *    be the silent stuck spinner this file exists to prevent;
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
 * A row may be empty only for an action named in `CALL_SETTLED_ACTIONS`, and
 * then it is a statement rather than an omission: no status ends that action.
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
  // Empty on purpose. `installAndRestart()` resolves a boolean, never a
  // status: every refusal sets `error` (which no row ends, because the pending
  // action is what keeps the reason on screen), and the only stay-alive
  // success leaves the service in `ready` — the state the install *started*
  // from, not an ending. The call settling is the ending, so no pushed status
  // may retire an install; `CALL_SETTLED_ACTIONS` says so, and the cross
  // product in `tests/e2e/update-banner.e2e.test.tsx` rejects an empty row
  // that nobody declared.
  install: [],
} as const satisfies Readonly<Record<PendingAction, readonly UpdateStatus['state'][]>>;

/**
 * Actions whose own call settling is the only ending they have.
 *
 * `install` is here because `installUpdate()` answers `true`/`false`: there is
 * no status to wait for, and the table's empty row above is a decision this
 * list makes visible. A status-answering install (a Main that drifted from the
 * contract) is still released exactly once — by `settle`, before its status is
 * applied — so the empty row cannot strand it.
 */
export const CALL_SETTLED_ACTIONS = ['install'] as const satisfies readonly PendingAction[];

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
      // at compile time. A payload that is not the contract's status — a state
      // outside `UPDATE_STATES`, a required field that is missing, a field of
      // the wrong type — is drift; writing it through would make every surface
      // render something the contract does not describe.
      //
      // The refusal is also the *only* trace the drift leaves: the payload is
      // dropped before it reaches state, so no surface draws it and nothing
      // else in the renderer can observe it. Refusing in silence is how a
      // renamed state sits in a build for weeks looking like "the banner is
      // just not updating". One warning, carrying both the payload and the
      // reason, is what turns that into a line in the console — the reason is
      // what decides whether the state or a field has to be fixed.
      // `tests/e2e/update-controller.e2e.test.tsx` asserts it, so the warning
      // cannot be dropped as noise.
      const problem = updateStatusProblem(next);
      if (problem !== null) {
        warnRefusedStatus(next, problem);
        return;
      }
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
   * `install` is the only action in `CALL_SETTLED_ACTIONS`, so it is the only
   * one released here; check and download end from `ACTION_COMPLETED_STATES`
   * in `applyStatus`.
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
          const problem = updateStatusProblem(next);
          if (problem === null) {
            applyStatus(next as UpdateStatus);
            return;
          }
          // The contract's other answer, and only for the action that has it.
          if (action === 'install' && typeof next === 'boolean') return;
          // Drift, and the answer a click was waiting on: warn, then end the
          // action. A check or download whose answer is not a status would
          // otherwise wait forever for a push that may never come, which is a
          // spinner that never resolves and no sentence anywhere.
          warnRefusedStatus(next, problem);
          pendingRef.current = null;
          setPendingAction(null);
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
 * The field types the contract declares, as one table.
 *
 * The guard used to read `state` and stop there, and that is the hole this
 * table closes: `{ state: 'available' }` was accepted, so the Settings card
 * drew an empty version and the banner drew a progress bar at 0% — a status
 * the contract does not describe, rendered as if it were one. A guard that
 * answers "is this an `UpdateStatus`?" has to look at the fields
 * `UpdateStatus` declares, not only the interesting one.
 *
 * `required: true` is the two fields every status carries
 * (`currentVersion`, `feedConfigured`); the rest are optional, which means
 * "may be absent", *not* "may be anything". `verified: 'no'` would light the
 * "checksum verified" badge for an installer nothing checked, so a present
 * optional field is held to its declared `typeof` too. A field that is absent
 * is fine: every renderer of an optional field already has a fallback
 * (`latestVersion ? … : ''`, `progress ?? 0`), so absence is a defined state.
 *
 * Ranges are deliberately *not* policed. `progress` is clamped by both
 * surfaces before it is drawn, so a service that overshoots 1 still produces a
 * truthful bar; refusing the status instead would replace a slightly wrong bar
 * with no bar.
 *
 * The two aliases after the table are the compile-time half: adding a field to
 * `UpdateStatus` in `@ucad/contracts` makes `npm run typecheck` fail here until
 * the guard has been told what type that field is — at the edit that already
 * has the contract open, rather than at the bug report.
 */
const UPDATE_STATUS_FIELDS = [
  { name: 'currentVersion', type: 'string', required: true },
  { name: 'feedConfigured', type: 'boolean', required: true },
  { name: 'latestVersion', type: 'string', required: false },
  { name: 'notes', type: 'string', required: false },
  { name: 'progress', type: 'number', required: false },
  { name: 'downloadedPath', type: 'string', required: false },
  { name: 'verified', type: 'boolean', required: false },
  { name: 'message', type: 'string', required: false },
  { name: 'checkedAt', type: 'string', required: false },
] as const;

type _StatusField = (typeof UPDATE_STATUS_FIELDS)[number]['name'];
/** Nothing the contract declares is left outside the table (`state` excepted). */
type _EveryStatusFieldIsListed<
  T extends never = Exclude<keyof UpdateStatus, 'state' | _StatusField>,
> = T;
/** …and the table invents no field the contract does not have. */
type _NoListedFieldIsForeign<T extends never = Exclude<_StatusField, keyof UpdateStatus>> = T;

/**
 * Why `value` is not the status one of the update calls promises, or `null`.
 *
 * The reason is a *sentence about the payload* rather than a boolean, because
 * the only place this guard's answer is used is a refusal, and a refusal
 * nobody can act on is noise: "refused an update state" does not say whether
 * the state is unknown (Main and renderer disagree about the vocabulary) or a
 * field went missing (a half-built payload). This string names the field, or
 * the offending state, which is the difference between two different fixes.
 *
 * `null` and "an object with a `state`" are the two answers the old guard
 * confused: `null` is the contract's own "no status yet", and every other
 * non-status is drift. `isUpdateStatus` is this function asked as a yes/no, so
 * the two cannot drift apart.
 *
 * Exported for `tests/e2e/update-status-vocabulary.e2e.test.tsx`, which asks
 * it about every published state, every invented one, and every required or
 * optional field missing or mistyped; a hand-written `state` check here would
 * pass the refusal e2e case and fail that contract.
 */
const UPDATE_STATE_SET: ReadonlySet<string> = new Set(UPDATE_STATES);

function hasField(status: Record<string, unknown>, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(status, name) && status[name] !== undefined;
}

export function updateStatusProblem(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return 'the payload is not an object';
  const status = value as Record<string, unknown>;
  const state = status.state;
  if (typeof state !== 'string') return '`state` is missing or not a string';
  if (!UPDATE_STATE_SET.has(state)) return `\`state\` is "${state}", which is not in UPDATE_STATES`;
  for (const field of UPDATE_STATUS_FIELDS) {
    const actual = typeof status[field.name];
    if (!hasField(status, field.name)) {
      if (field.required) {
        return `\`${field.name}\` is missing (the contract requires a ${field.type})`;
      }
      continue;
    }
    if (actual !== field.type) {
      // "an object", not "a object": the reason is read in a console at the
      // moment somebody is deciding what to fix.
      const article = actual === 'object' || actual === 'undefined' ? 'an' : 'a';
      return `\`${field.name}\` is ${article} ${actual}, not a ${field.type}`;
    }
  }
  return null;
}

export function isUpdateStatus(value: unknown): value is UpdateStatus {
  return updateStatusProblem(value) === null;
}

/**
 * The one sentence a refused payload leaves behind.
 *
 * One function rather than a closure per call site: the same refusal happens
 * on a push and on an action's own answer, and two spellings of a warning is
 * how one of them later loses the payload — or the reason — that makes it
 * actionable. A plain declaration, so it is hoisted above its use.
 */
function warnRefusedStatus(next: unknown, problem: string): void {
  console.warn('[update-controller] refused an update status that does not match the contract', {
    next,
    problem,
  });
}
