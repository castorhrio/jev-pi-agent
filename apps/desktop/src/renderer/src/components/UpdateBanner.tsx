import { useEffect, useState } from 'react';
import type { UpdateStatus } from '@ucad/contracts';
import { getApi } from '../api';
import { useT } from '../i18n-context';

/**
 * Update banner.
 *
 * Shown only when there is something actionable. A desktop app that nags about
 * being up to date trains people to ignore its banners, so `up-to-date` and
 * `idle` are silent — the state is still visible in Settings.
 */
export function UpdateBanner(): JSX.Element | null {
  const t = useT();
  const [status, setStatus] = useState<UpdateStatus | null>(null);

  useEffect(() => {
    const api = getApi();
    void api.app.updateStatus().then(setStatus).catch(() => undefined);
    return api.app.onUpdateStatus(setStatus);
  }, []);

  if (!status) return null;

  if (status.state === 'available') {
    return (
      <div className="banner accent">
        <span className="grow">
          {t('settings.updateAvailable')} · v{status.latestVersion}
        </span>
        <button
          className="primary"
          onClick={() => {
            void getApi()
              .app.downloadUpdate()
              .catch(() => undefined);
          }}
        >
          {t('settings.checkUpdate')}
        </button>
      </div>
    );
  }

  if (status.state === 'downloading') {
    const percent = Math.round((status.progress ?? 0) * 100);
    return (
      <div className="banner">
        <span className="grow">{t('settings.checking')}</span>
        <div className="progress">
          <div className="progress-fill" style={{ width: `${percent}%` }} />
        </div>
        <span className="faint">{percent}%</span>
      </div>
    );
  }

  if (status.state === 'ready') {
    return (
      <div className="banner ok">
        <span className="grow">
          {t('settings.updateAvailable')} · v{status.latestVersion}
        </span>
        <button
          className="primary"
          onClick={() => {
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

  return null;
}
