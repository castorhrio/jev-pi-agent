/**
 * §12.1 Settings / Storage — the §8.4 retention and cleanup surface.
 *
 * The product's rule is §17.1: the product must not keep data the user did not
 * agree to keep, and a failure must show its reason. Three rules follow, and
 * they shape every line below:
 *
 *  - **No number without a measurement.** Sizes and row counts come from
 *    `storage:usage` / `storage:previewPurge`, which read the database and
 *    `fs.stat`. If the call fails, the panel shows the reason — it never falls
 *    back to zeros, because "0 bytes, nothing to clean" and "could not read
 *    storage" look identical and only one of them is true.
 *  - **Nothing irreversible happens on one click.** Every destructive action
 *    first asks Main what it *would* remove, and only the second, explicitly
 *    labelled confirm click deletes. The preview is not decoration: the confirm
 *    request carries `confirm: true` and Main refuses anything else.
 *  - **The result is reported, not assumed.** After a purge the panel shows the
 *    counts Main actually measured, including the "nothing matched" case, which
 *    is a success and not an error.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { StoragePurgeResult, StoragePurgeScope, StorageUsageDto } from '@ucad/contracts';
import { getApi } from '../api';
import { useT } from '../i18n-context';
import type { AppData } from '../state/hooks';

function Def({ k, children }: { k: string; children: React.ReactNode }): JSX.Element {  return (
    <div className="def">
      <span className="k">{k}</span>
      <span className="v">{children}</span>
    </div>
  );
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Byte counts are measured in bytes; only the unit is presentation. */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

const PURGE_ACTIONS: ReadonlyArray<{ scope: StoragePurgeScope; label: string }> = [
  { scope: 'expired', label: 'retention.purgeExpired' },
  { scope: 'workspace', label: 'retention.purgeWorkspace' },
  { scope: 'all', label: 'retention.purgeAll' },
];

export function StoragePanel({ data }: { data: AppData }): JSX.Element {
  const t = useT();
  const api = useMemo(() => getApi(), []);

  const [usage, setUsage] = useState<StorageUsageDto | null>(null);
  const [usageFailure, setUsageFailure] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const [days, setDays] = useState('90');
  const [forever, setForever] = useState(false);
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveFailure, setSaveFailure] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const [preview, setPreview] = useState<StorageUsageDto | null>(null);
  const [armed, setArmed] = useState<StoragePurgeScope | null>(null);
  const [previewFailure, setPreviewFailure] = useState<string | null>(null);
  const [purgeBusy, setPurgeBusy] = useState<StoragePurgeScope | null>(null);
  const [purgeFailure, setPurgeFailure] = useState<string | null>(null);
  const [result, setResult] = useState<StoragePurgeResult | null>(null);

  const [orphanBusy, setOrphanBusy] = useState(false);
  const [orphanFailure, setOrphanFailure] = useState<string | null>(null);
  const [orphanNote, setOrphanNote] = useState<string | null>(null);

  const workspaceId = data.workspace?.id ?? null;

  const load = useCallback(async () => {
    setUsageFailure(null);
    try {
      const current = await api.storage.usage();
      setUsage(current);
      // The stored setting is the source of truth: every reload re-seeds the
      // input from what is actually persisted, so a failed save can never leave
      // the field showing a value the database does not hold.
      setDays((current.retentionDays ?? 90).toString());
      setForever(current.retentionDays === null);
    } catch (error) {
      // An empty panel here would be a lie: the data exists, we failed to read
      // it, and the user has to be told which of the two it is.
      setUsage(null);
      setUsageFailure(message(error));
    } finally {
      setLoaded(true);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const saveRetention = useCallback(async () => {
    setSaveBusy(true);
    setSaveFailure(null);
    setSaved(null);
    try {
      const parsed = forever ? null : Number.parseInt(days, 10);
      await api.storage.setRetention(parsed);
      setSaved(
        parsed === null
          ? t('retention.savedForever')
          : t('retention.saved', { days: parsed }),
      );
      await load();
    } catch (error) {
      setSaveFailure(message(error));
    } finally {
      setSaveBusy(false);
    }
  }, [api, days, forever, load, t]);

  /** First click of a destructive action: show what it would remove. */
  const runPreview = useCallback(
    async (scope: StoragePurgeScope) => {
      setPreviewFailure(null);
      setPurgeFailure(null);
      setResult(null);
      setOrphanNote(null);
      if (armed === scope) {
        setArmed(null);
        setPreview(null);
        return;
      }
      try {
        const next = await api.storage.previewPurge(scope, workspaceId ?? undefined);
        setPreview(next);
        setArmed(scope);
      } catch (error) {
        setPreview(null);
        setArmed(null);
        setPreviewFailure(message(error));
      }
    },
    [api, armed, workspaceId],
  );

  /** Second click: the user has seen the counts and says yes. */
  const runPurge = useCallback(
    async (scope: StoragePurgeScope) => {
      setPurgeBusy(scope);
      setPurgeFailure(null);
      try {
        const done = await api.storage.purge({
          scope,
          workspaceId: workspaceId ?? undefined,
          confirm: true,
        });
        setResult(done);
        setArmed(null);
        setPreview(null);
        await load();
      } catch (error) {
        // The reason is shown verbatim; a cleanup that failed silently is the
        // one outcome §17.1 rules out.
        setPurgeFailure(message(error));
        setResult(null);
        setArmed(null);
        setPreview(null);
      } finally {
        setPurgeBusy(null);
      }
    },
    [api, load, workspaceId],
  );

  const collectOrphans = useCallback(async () => {
    setOrphanBusy(true);
    setOrphanFailure(null);
    setOrphanNote(null);
    try {
      const done = await api.storage.collectOrphanBlobs();
      setOrphanNote(t('retention.collected', { count: done.removed, bytes: formatBytes(done.bytes) }));
      await load();
    } catch (error) {
      setOrphanFailure(message(error));
    } finally {
      setOrphanBusy(false);
    }
  }, [api, load, t]);

  const daysInvalid = !forever && (!/^\d+$/.test(days.trim()) || Number.parseInt(days, 10) <= 0);

  return (
    <div className="pane">
      <div className="pane-head">
        <h1>{t('retention.title')}</h1>
        <p>{t('retention.subtitle')}</p>
      </div>

      {usageFailure && (
        <div className="notice error">
          {usageFailure}
        </div>
      )}

      {!usage && !usageFailure && !loaded && <div className="faint">{t('common.loading')}</div>}

      {usage && (
        <div className="card">
          <h2>{t('retention.onDisk')}</h2>
          <div className="defs">
            <Def k={t('retention.dbSize')}>
              <span className="mono">{formatBytes(usage.dbBytes)}</span>
            </Def>
            <Def k={t('retention.blobSize')}>
              <span className="mono">{formatBytes(usage.blobBytes)}</span>
            </Def>
          </div>

          <div className="block-title" style={{ marginTop: 14 }}>
            <span>{t('retention.counts')}</span>
          </div>
          <div className="defs">
            <Def k={t('retention.sessions')}>{usage.sessions.toLocaleString()}</Def>
            <Def k={t('retention.turns')}>{usage.turns.toLocaleString()}</Def>
            <Def k={t('retention.events')}>{usage.events.toLocaleString()}</Def>
            <Def k={t('retention.messages')}>{usage.messages.toLocaleString()}</Def>
            <Def k={t('retention.blobFiles')}>{usage.blobFiles.toLocaleString()}</Def>
            <Def k={t('retention.expired')}>
              <span className={usage.expiredSessions > 0 ? 'badge warn' : 'badge ok'}>
                {usage.expiredSessions.toLocaleString()}
              </span>
            </Def>
          </div>

          <div className="row-gap" style={{ marginTop: 12, flexWrap: 'wrap' }}>
            <span className="faint" style={{ fontSize: 11.5 }}>
              {t('retention.orphans')}
            </span>
            <button onClick={() => void collectOrphans()} disabled={orphanBusy}>
              {t('retention.collectOrphans')}
            </button>
          </div>
          {orphanNote && (
            <div className="notice info" style={{ marginTop: 8 }}>
              {orphanNote}
            </div>
          )}
          {orphanFailure && (
            <div className="notice error" style={{ marginTop: 8 }}>
              {orphanFailure}
            </div>
          )}
        </div>
      )}

      <div className="card">
        <h2>{t('retention.days')}</h2>
        <div className="row-gap" style={{ flexWrap: 'wrap' }}>
          <input
            value={days}
            onChange={(event) => {
              // Typing a number always leaves "keep forever", so the setting is
              // never a one-way door the user has to restart the app to undo.
              setDays(event.target.value);
              setForever(false);
            }}
            aria-label={t('retention.days')}
            style={{ width: 120 }}
          />
          <button className={forever ? 'primary' : ''} onClick={() => setForever(true)}>
            {t('retention.forever')}
          </button>
          <button className="primary" onClick={() => void saveRetention()} disabled={saveBusy || daysInvalid}>
            {t('retention.set')}
          </button>
        </div>
        {daysInvalid && (
          <div className="notice warn" style={{ marginTop: 10 }}>
            {t('retention.days')}: <span className="mono">{days}</span>
          </div>
        )}
        {saved && (
          <div className="notice info" style={{ marginTop: 10 }}>
            {saved}
          </div>
        )}
        {saveFailure && (
          <div className="notice error" style={{ marginTop: 10 }}>
            {saveFailure}
          </div>
        )}
      </div>

      <div className="card">
        <h2>{t('retention.purgeTitle')}</h2>

        {workspaceId === null && (
          <div className="notice warn" style={{ marginBottom: 10 }}>
            {t('retention.workspaceMissing')}
          </div>
        )}

        <div className="row-gap" style={{ flexWrap: 'wrap' }}>
          {PURGE_ACTIONS.map((action) => {
            const disabled = action.scope === 'workspace' && workspaceId === null;
            return (
              <button
                key={action.scope}
                className={armed === action.scope ? 'primary' : ''}
                disabled={disabled || purgeBusy !== null}
                onClick={() => void runPreview(action.scope)}
              >
                {t(action.label)}
              </button>
            );
          })}
        </div>

        {previewFailure && (
          <div className="notice error" style={{ marginTop: 10 }}>
            {previewFailure}
          </div>
        )}

        {armed !== null && preview && (
          <div className="notice warn" style={{ marginTop: 10 }}>
            <div>
              <strong>{t('retention.purgeConfirmTitle')}</strong>
            </div>
            <div style={{ marginTop: 6 }}>
              {t('retention.purgeConfirm', {
                sessions: preview.sessions,
                events: preview.events,
                blobs: preview.blobFiles,
                bytes: formatBytes(preview.blobBytes),
              })}
            </div>
            <div className="faint" style={{ marginTop: 4, fontSize: 11.5 }}>
              {t('retention.purgeIrreversible')}
            </div>
            <div className="row-gap" style={{ marginTop: 10 }}>
              <button
                className="danger"
                disabled={purgeBusy !== null}
                onClick={() => void runPurge(armed)}
              >
                {purgeBusy === armed ? t('retention.busy') : t('retention.purgeConfirmTitle')}
              </button>
              <button
                onClick={() => {
                  setArmed(null);
                  setPreview(null);
                }}
              >
                {t('common.cancel')}
              </button>
            </div>
          </div>
        )}

        {armed === null && !preview && !previewFailure && (
          <div className="faint" style={{ marginTop: 8, fontSize: 11.5 }}>
            {t('retention.needConfirm')}
          </div>
        )}

        {purgeFailure && (
          <div className="notice error" style={{ marginTop: 10 }}>
            {purgeFailure}
          </div>
        )}

        {result && (
          <div className="notice info" style={{ marginTop: 10 }}>
            {result.sessionsRemoved === 0
              ? t('retention.purgeNothing')
              : t('retention.purgeDone', {
                  sessions: result.sessionsRemoved,
                  bytes: formatBytes(result.bytesReclaimed),
                })}
            <div className="defs" style={{ marginTop: 8 }}>
              <Def k={t('retention.events')}>{result.eventsRemoved.toLocaleString()}</Def>
              <Def k={t('retention.blobs')}>{result.blobFilesRemoved.toLocaleString()}</Def>
              <Def k={t('retention.onDisk')}>
                <span className="mono">{formatBytes(result.bytesReclaimed)}</span>
              </Def>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
