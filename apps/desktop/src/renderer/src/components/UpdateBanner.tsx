import { useCallback, useEffect, useRef, useState } from 'react';
import type { UpdateStatus } from '@ucad/contracts';
import { getApi } from '../api';
import { useT } from '../i18n-context';

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
 * `pendingAction` ends when the action does: a terminal status for that action
 * (`ready` after a download, anything past `checking` for a check) clears it,
 * as does dismissing a failure. Progress (`downloading`, `checking`) does not,
 * or a download that fails after its progress bar appeared would lose the
 * failure. An error status keeps it so the failure stays rendered.
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
type PendingAction = 'download' | 'install' | 'check';

/**
 * Whether a status means `action` is over, so the banner may forget it.
 *
 * `error` is not an ending on purpose: the failure is what the pending action
 * is for. Progress statuses are not endings either — a download that has shown
 * its bar is still the download whose failure the user is waiting on.
 */
function actionCompleted(action: PendingAction, state: UpdateStatus['state']): boolean {
  if (state === 'error' || state === 'checking' || state === 'downloading') return false;
  // A download ends at `ready`; an `available` status did not download
  // anything, so it cannot be the download's answer.
  return action === 'download' ? state === 'ready' : true;
}

/**
 * The message in an IPC rejection.
 *
 * Main rejects every handler with a real `Error` (`toUserError` in
 * `main/ipc.ts`), and the Renderer deliberately imports no runtime code from
 * the CommonJS `@ucad/contracts`, so it cannot use `describeError` either.
 * `String(error)` keeps a non-`Error` rejection from rendering as
 * `[object Object]`.
 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
