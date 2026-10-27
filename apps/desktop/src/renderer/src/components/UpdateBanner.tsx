import { useEffect, useState } from 'react';
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
 * `error` is silent too, *until the user has acted here*. The app checks on
 * startup, so a machine that is offline would otherwise open to an error
 * banner about a check nobody asked for. A download or install the user
 * started from this banner is different: they are watching this element, and
 * a failure that made it disappear is a dead end. So one click arms it, and a
 * failure then arrives with its reason, a retry and a way to dismiss it.
 *
 * The switch is exhaustive: the `default` branch is a `never` assignment, so
 * a new `UpdateState` fails `npm run typecheck` here until this component has
 * decided what it draws. At runtime an unknown state (an older renderer
 * beside a newer main process) draws nothing rather than taking the window
 * down.
 */
export function UpdateBanner(): JSX.Element | null {
  const t = useT();
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [engaged, setEngaged] = useState(false);

  useEffect(() => {
    const api = getApi();
    void api.app.updateStatus().then(setStatus).catch(() => undefined);
    return api.app.onUpdateStatus(setStatus);
  }, []);

  if (!status) return null;

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
            onClick={() => {
              setEngaged(true);
              void getApi()
                .app.downloadUpdate()
                .then(setStatus)
                .catch(() => undefined);
            }}
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
            onClick={() => {
              setEngaged(true);
              void getApi()
                .app.installUpdate()
                .catch(() => undefined);
            }}
          >
            {t('settings.restartNow')}
          </button>
        </div>
      );
    }

    case 'error': {
      if (!engaged) return null;
      const message = status.message?.trim();
      return (
        <div className="banner" role="alert">
          <span className="grow">
            {t('settings.updateFailed')}
            {message ? `: ${message}` : ''}
          </span>
          <button
            onClick={() => {
              void getApi()
                .app.checkUpdate()
                .then(setStatus)
                .catch(() => undefined);
            }}
          >
            {t('settings.checkUpdate')}
          </button>
          <button onClick={() => setEngaged(false)}>{t('common.close')}</button>
        </div>
      );
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
