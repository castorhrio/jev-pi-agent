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
import type { WorkspaceActivationDto, WorkspaceDto } from '@ucad/contracts';

export function RecentProjects({
  currentId,
  onActivated,
  onOpenFolder,
}: {
  /**
   * The workspace that is open right now.
   *
   * Passed in rather than inferred from `index === 0`, which is what this
   * component used to do. The list is ordered by recency so the two agree most
   * of the time — but "most of the time" is how the row already marked
   * `当前项目` came to also carry an enabled primary button reading `切换到这里`,
   * i.e. an offer to switch to where the user already is.
   */
  currentId: string | null;
  /**
   * Called with the activation answer and the row the user clicked.
   *
   * Two arguments rather than one name, because on a superseded activation
   * those are two different projects: Main answers with the one actually loaded
   * (`next.id`) while the user asked for `requested`. This panel cannot tell
   * the user about that itself: a successful switch is followed immediately by
   * `onActivated`, which moves the user to the conversation, which unmounts
   * this panel — a notice rendered in this component's own state was never on
   * screen for a single frame. The caller owns a toast that survives the
   * navigation, so it needs both halves to say which project it ended up in and
   * which request was dropped.
   */
  onActivated: (next: WorkspaceActivationDto, requested: WorkspaceDto) => void;
  onOpenFolder: () => void;
}): JSX.Element {
  const t = useT();
  const [rows, setRows] = useState<WorkspaceDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

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

  /**
   * Asks Main to make `workspace` the project in force, and hands the answer up
   * untouched.
   *
   * The answer is deliberately not assumed to be the row that was clicked. When
   * a newer request won the race, Main loads *that* project and says so in
   * `activation`/`requestedWorkspaceId`; navigating on the clicked row instead
   * would take the user to a project whose code intelligence and rules were
   * never moved — the exact failure the activation queue exists to prevent,
   * reintroduced by the panel that displays the result.
   */
  const activate = (workspace: WorkspaceDto): void => {
    setBusyId(workspace.id);
    setError(null);
    void getApi()
      .workspace.activate(workspace.id)
      .then((next) => onActivated(next, workspace))
      .catch((e: unknown) => {
        // A folder that moved or an unmounted drive lands here. The reason is
        // the whole point — the user needs to know whether to re-pick the folder
        // or to fix the mount. A failure does *not* navigate, so this notice is
        // shown where it is set.
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

      {error && <div className="notice error">{error}</div>}

      <div className="card">
        {rows === null ? (
          <div className="faint">…</div>
        ) : rows.length === 0 ? (
          <div className="faint">{t('recent.empty')}</div>
        ) : (
          <table className="grid">
            <tbody>
              {rows.map((workspace) => {
                const isCurrent = workspace.id === currentId;
                return (
                  <tr key={workspace.id}>
                    <td>
                      <div className="truncate" title={workspace.path}>
                        {workspace.name}
                      </div>
                      <div className="faint truncate fs-note">
                        {workspace.path}
                      </div>
                    </td>
                    <td className="mono faint fs-note" style={{ whiteSpace: 'nowrap' }}>
                      {isCurrent ? t('currentProject') : ''}
                    </td>
                    <td className="actions">
                      {/*
                        The open project's action is disabled and says so.
                        It used to stay enabled and read `切换到这里`, which
                        re-activated the workspace already in use and navigated
                        the user off this page with nothing to show for it — a
                        primary button whose only observable effect was to take
                        the page away.
                      */}
                      <button
                        className={isCurrent ? '' : 'primary'}
                        disabled={isCurrent || busyId !== null}
                        onClick={() => activate(workspace)}
                      >
                        {isCurrent
                          ? t('recent.currentAction')
                          : busyId === workspace.id
                            ? t('common.loading')
                            : t('common.switchTo')}
                      </button>
                    </td>
                  </tr>
                );
              })}
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
