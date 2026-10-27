import { useCallback, useEffect, useRef, useState } from 'react';
import type { UpdateStatus } from '@ucad/contracts';
import { getApi } from '../api';
import { useT } from '../i18n-context';
import { describeError } from '../error-message';

/**
 * Update banner.
 *
 * Shown only when there is something actionable. `idle`, `checking`,
 * `up-to-date` and `unsupported` are silent: a banner that announces "you are
 * up to date" or "no feed configured" on every start trains people to ignore
 * it. Settings carries the full picture for anyone who goes looking.
 *
 * A failure is shown only when it belongs to an action the user started *in
 * this banner* — `pendingAction`. The app checks on startup, so a machine that
 * is offline would otherwise open to an error banner about a check nobody
 * asked for. The old flag was a bare `engaged` boolean: "the user clicked
 * something here at some point", which made a background check and a download
 * failure two events distinguished only by their order. Naming the action is
 * what lets the banner say which one it is still waiting on, and it is why an
 * unrelated failure that arrives after a click is still the user's to see.
 *
 * `pendingAction` ends when the action does, and "does" is `ACTION_COMPLETED_STATES`
 * below rather than a rule spread over two `if`s: one row per action, listing
 * the statuses that answer it. A download is over at `ready` and nowhere else
 * (`available` downloaded nothing); a check and an install are over at any
 * status that is not progress or failure. Progress (`checking`, `downloading`)
 * never ends one, or a download that fails after its progress bar appeared
 * would lose the failure; `error` never does, because the failure is exactly
 * what the pending action is still for. Dismissing a failure ends it too.
 *
 * The three calls are also awaited here, not just pushed. The main process
 * pushes every transition, but an IPC rejection is a failure with no status:
 * without a local one, a rejected `downloadUpdate()` would leave the banner
 * unchanged and the click with no answer at all. `localFailure` is that answer;
 * any status afterwards replaces it, and starting another action clears it.
 *
 * The switch is exhaustive: the `default` branch is a `never` assignment, so
 * a new `UpdateState` fails `npm run typecheck` here until this component has
 * decided what it draws. At runtime an unknown state (an older renderer
 * beside a newer main process) draws nothing rather than taking the window
 * down.
 */

/** The action the user started from this banner. */
export type PendingAction = 'download' | 'install' | 'check';

/**
 * Which statuses mean each action is over — one row per action, no complement.
 *
 * The rule used to be a complement (`not error, not checking, not downloading
 * → over`, with a special case for a download), which is a rule you can only
 * read by subtracting: a *new* state silently counted as an ending for every
 * action, so the banner would forget a check while it was still running. As a
 * table the question is asked per status and per action, a new `UpdateState`
 * is a row somebody has to answer, and
 * `tests/e2e/update-banner.e2e.test.tsx` walks the cross product to check that
 * this is the table `actionCompleted()` actually reads.
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
  // `localFailure` — which this table never sees.
  install: ['idle', 'up-to-date', 'available', 'ready', 'unsupported'],
} as const satisfies Readonly<Record<PendingAction, readonly UpdateStatus['state'][]>>;

/**
 * Whether a status means `action` is over, so the banner may forget it.
 *
 * Reads the table rather than deciding again: the e2e suite asserts the two
 * agree for every action × state pair, so a state this function answered
 * differently would be a red test instead of a second opinion.
 */
export function actionCompleted(action: PendingAction, state: UpdateStatus['state']): boolean {
  const endings: readonly UpdateStatus['state'][] = ACTION_COMPLETED_STATES[action];
  return endings.includes(state);
}

export function UpdateBanner(): JSX.Element | null {
  const t = useT();
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [localFailure, setLocalFailure] = useState<string | null>(null);
  // The subscription is installed once, so it cannot read the render-time
  // `pendingAction`: a status pushed ten seconds after the click would still
  // see the value from mount. The ref is the current one.
  const pendingRef = useRef<PendingAction | null>(null);

  const begin = useCallback((action: PendingAction) => {
    pendingRef.current = action;
    setPendingAction(action);
    setLocalFailure(null);
  }, []);

  const applyStatus = useCallback((next: UpdateStatus) => {
    setStatus(next);
    // A real status is a better answer than a rejection, so it replaces the
    // local failure rather than sitting beside it.
    setLocalFailure(null);
    const action = pendingRef.current;
    if (action !== null && actionCompleted(action, next.state)) {
      pendingRef.current = null;
      setPendingAction(null);
    }
  }, []);

  useEffect(() => {
    const api = getApi();
    void api.app
      .updateStatus()
      .then((next) => {
        if (next) applyStatus(next);
      })
      .catch(() => undefined);
    return api.app.onUpdateStatus(applyStatus);
  }, [applyStatus]);

  /**
   * Starts an action and turns its rejection into the failure the user sees.
   *
   * The pending action is kept on rejection: `localFailure` is rendered under
   * the same ownership rule as an error status, and dismissing or retrying is
   * what ends it. Without `.catch` here the rejection would be an unhandled
   * promise and the click would look like a no-op.
   */
  const run = (action: PendingAction, start: () => Promise<unknown>): void => {
    begin(action);
    void start()
      .then((next) => {
        // `installUpdate()` answers a boolean; every other call answers the
        // status the subscription also sees. Applying it twice is harmless —
        // the state is the same — and it is what lets a check settle without
        // waiting for a push.
        if (isUpdateStatus(next)) applyStatus(next);
      })
      .catch((error: unknown) => {
        setLocalFailure(describeError(error));
      });
  };

  const failureBanner = (message: string): JSX.Element => (
    <div className="banner" role="alert">
      <span className="grow">
        {t('settings.updateFailed')}
        {message ? `: ${message}` : ''}
      </span>
      <button onClick={() => run('check', () => getApi().app.checkUpdate())}>
        {t('settings.checkUpdate')}
      </button>
      <button
        onClick={() => {
          pendingRef.current = null;
          setPendingAction(null);
          setLocalFailure(null);
        }}
      >
        {t('common.close')}
      </button>
    </div>
  );

  if (!status) return null;

  // A rejection has no status to switch on, and the status may still be the
  // pre-action one (`available`). It is drawn first, under the same ownership
  // gate, so the click always has an answer.
  if (pendingAction !== null && localFailure !== null) {
    return failureBanner(localFailure);
  }

  switch (status.state) {
    case 'available': {
      const version = status.latestVersion ? ` · v${status.latestVersion}` : '';
      return (
        <div className="banner accent">
          <span className="grow">
            {t('settings.updateAvailable')}
            {version}
          </span>
          <button
            className="primary"
            onClick={() => run('download', () => getApi().app.downloadUpdate())}
          >
            {t('settings.downloadUpdate')}
          </button>
        </div>
      );
    }

    case 'downloading': {
      // The progress bar is the only place this state is drawn, so the label
      // says what is happening rather than reusing the check's "检查中…".
      const percent = Math.round(Math.min(1, Math.max(0, status.progress ?? 0)) * 100);
      return (
        <div className="banner">
          <span className="grow">{t('settings.downloading')}</span>
          <div className="progress">
            <div className="progress-fill" style={{ width: `${percent}%` }} />
          </div>
          <span className="faint">{percent}%</span>
        </div>
      );
    }

    case 'ready': {
      const version = status.latestVersion ? ` · v${status.latestVersion}` : '';
      return (
        <div className="banner ok">
          <span className="grow">
            {t('settings.updateAvailable')}
            {version}
          </span>
          <button
            className="primary"
            onClick={() => run('install', () => getApi().app.installUpdate())}
          >
            {t('settings.restartNow')}
          </button>
        </div>
      );
    }

    case 'error': {
      if (pendingAction === null) return null;
      return failureBanner(status.message?.trim() ?? '');
    }

    case 'idle':
    case 'checking':
    case 'up-to-date':
    case 'unsupported':
      return null;

    default:
      return unknownBannerState(status.state);
  }
}

/** Whether a value is the status one of the update calls promises. */
function isUpdateStatus(value: unknown): value is UpdateStatus {
  return typeof value === 'object' && value !== null && 'state' in value;
}

/**
 * The compile-time half of the exhaustiveness claim above.
 *
 * `state` is `never` only while every member of `UpdateState` has a case. A
 * new state makes this call fail `npm run typecheck`; at runtime the parameter
 * can only hold a value from a different contract version, and drawing
 * nothing is the safe answer there.
 */
function unknownBannerState(state: never): null {
  void state;
  return null;
}
