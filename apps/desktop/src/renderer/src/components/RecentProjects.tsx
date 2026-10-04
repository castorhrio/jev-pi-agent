/**
 * §12.1 Welcome — "Recent projects、Open Folder".
 *
 * This is not a cosmetic page. Until it existed the only way to change project
 * was the OS folder dialog, so a user with two projects could open the second
 * one and then never get back to the first without remembering its path — and
 * the session list is now scoped to the open project, which made the missing
 * switcher a genuine dead end rather than a missing convenience.
 *
 * A row whose folder has disappeared says so, in words, instead of opening an
 * empty Explorer.
 */

import { useCallback, useEffect, useState } from 'react';
import { getApi } from '../api';
import { useT } from '../i18n-context';
import type { WorkspaceDto } from '@ucad/contracts';

export function RecentProjects({
  onActivated,
  onOpenFolder,
}: {
  onActivated: () => void;
  onOpenFolder: () => void;
}): JSX.Element {
  const t = useT();
  const [rows, setRows] = useState<WorkspaceDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    void getApi()
      .workspace.listRecent()
      .then((list) => setRows(list))
      .catch((e: unknown) => {
        setRows([]);
        setError(e instanceof Error ? e.message : String(e));
      });
  }, []);

  useEffect(load, [load]);

  const activate = (workspace: WorkspaceDto): void => {
    setBusyId(workspace.id);
    setError(null);
    setFlash(null);
    void getApi()
      .workspace.activate(workspace.id)
      .then((next) => {
        setFlash(t('recent.switched', { name: next.name }));
        onActivated();
      })
      .catch((e: unknown) => {
        // A folder that moved or an unmounted drive lands here. The reason is
        // the whole point — the user needs to know whether to re-pick the folder
        // or to fix the mount.
        setError(t('recent.switchFailed', { reason: e instanceof Error ? e.message : String(e) }));
      })
      .finally(() => setBusyId(null));
  };

  return (
    <div className="pane">
      <div className="pane-head">
        <h1>{t('recent.title')}</h1>
        <p>{t('recent.subtitle')}</p>
      </div>

      {flash && <div className="notice info">{flash}</div>}
      {error && <div className="notice error">{error}</div>}

      <div className="card">
        {rows === null ? (
          <div className="faint">…</div>
        ) : rows.length === 0 ? (
          <div className="faint">{t('recent.empty')}</div>
        ) : (
          <table className="grid">
            <tbody>
              {rows.map((workspace, index) => (
                <tr key={workspace.id}>
                  <td>
                    <div className="truncate" title={workspace.path}>
                      {workspace.name}
                    </div>
                    <div className="faint truncate" style={{ fontSize: 11 }}>
                      {workspace.path}
                    </div>
                  </td>
                  <td className="mono faint" style={{ fontSize: 11, whiteSpace: 'nowrap' }}>
                    {index === 0 ? t('currentProject') : ''}
                  </td>
                  <td>
                    <button
                      className="primary"
                      disabled={busyId !== null}
                      onClick={() => activate(workspace)}
                    >
                      {busyId === workspace.id ? t('common.loading') : t('common.switchTo')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="row-gap">
        <button className="primary" onClick={onOpenFolder} disabled={busyId !== null}>
          {t('recent.open')}
        </button>
        <button onClick={load}>{t('common.refresh')}</button>
      </div>
    </div>
  );
}
