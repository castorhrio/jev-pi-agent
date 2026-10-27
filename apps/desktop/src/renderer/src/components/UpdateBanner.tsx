import { useT } from '../i18n-context';
import { useUpdateController } from '../update-controller';

/**
 * Update banner.
 *
 * Shown only when there is something actionable. `idle`, `checking`,
 * `up-to-date` and `unsupported` are silent: a banner that announces "you are
 * up to date" or "no feed configured" on every start trains people to ignore
 * it. Settings carries the full picture for anyone who goes looking.
 *
 * A failure is shown only when it belongs to an action the user started *in
 * this banner or the Settings card*. The app checks on startup, so a machine
 * that is offline would otherwise open to an error banner about a check
 * nobody asked for. A local `failure` is always such an action — the
 * controller sets it only from a click — while a pushed `error` status needs
 * the pending action to tell a background check from one the user is waiting
 * on. Naming the action is what lets the banner say which one it is still
 * waiting on, and it is why an unrelated failure that arrives after a click is
 * still the user's to see.
 *
 * A local failure does not require a pending action: an install rejection
 * ends the action (there is nothing to retry without a fresh check) but must
 * still show its reason. Gating the local failure on `pendingAction` would
 * have turned that into a silent dead end.
 *
 * The name, the table of endings and the local-failure answer all live in
 * `update-controller.tsx`, because Settings needs exactly the same rules. A
 * second copy there is how the Settings card ended up with three
 * `.catch(() => undefined)` calls that turned every failed click into silence.
 *
 * The three calls are awaited by that controller, not just pushed. The main
 * process pushes every transition, but an IPC rejection is a failure with no
 * status: without a local one, a rejected `downloadUpdate()` would leave the
 * banner unchanged and the click with no answer at all.
 *
 * The switch is exhaustive: the `default` branch is a `never` assignment, so
 * a new `UpdateState` fails `npm run typecheck` here until this component has
 * decided what it draws. At runtime an unknown state (an older renderer
 * beside a newer main process) draws nothing rather than taking the window
 * down.
 */
export function UpdateBanner(): JSX.Element | null {
  const t = useT();
  const { status, pendingAction, failure, check, download, install, dismissFailure } =
    useUpdateController();

  const failureBanner = (message: string): JSX.Element => (
    <div className="banner" role="alert">
      <span className="grow">
        {t('settings.updateFailed')}
        {message ? `: ${message}` : ''}
      </span>
      <button onClick={check}>{t('settings.checkUpdate')}</button>
      <button onClick={dismissFailure}>{t('common.close')}</button>
    </div>
  );

  if (!status) return null;

  // A rejection has no status to switch on, and the status may still be the
  // pre-action one (`available`). The controller only records `failure` for a
  // click, so this is attributable without a pending action — which an install
  // rejection has already released.
  if (failure !== null) {
    return failureBanner(failure);
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
          <button className="primary" onClick={download}>
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
          <button className="primary" onClick={install}>
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
