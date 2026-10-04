import { useCallback, useEffect, useMemo, useState } from 'react';
import { getApi } from '../api';
import { useT } from '../i18n-context';
import { FileEditor } from './FileEditor';
import type { AppData } from '../state/hooks';

type Entry = { name: string; path: string; kind: 'file' | 'dir' };

// ---------------------------------------------------------------------------
// Explorer
// ---------------------------------------------------------------------------

export function Explorer({
  data,
  selectedPath,
  onSelectFile,
}: {
  data: AppData;
  selectedPath: string | null;
  /** Reported upward so the left rail's tree can mark the same file. */
  onSelectFile: (path: string | null) => void;
}): JSX.Element {
  const t = useT();
  const [dir, setDir] = useState<string | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [editing, setEditing] = useState(false);
  const [file, setFile] = useState<{
    path: string;
    content: string;
    truncated: boolean;
  } | null>(null);

  const root = data.workspace?.path ?? null;
  useEffect(() => {
    setDir(root);
  }, [root]);

  useEffect(() => {
    if (!dir) {
      setEntries([]);
      return;
    }
    let cancelled = false;
    void getApi()
      .files.list(dir)
      .then((list) => {
        if (!cancelled) setEntries(list);
      })
      .catch(() => {
        if (!cancelled) setEntries([]);
      });
    return () => {
      cancelled = true;
    };
  }, [dir]);

  // A file opened from the left rail arrives as a path; show it here.
  // No `onSelectFile` call here: `selectedPath` *is* the App-level selection, so
  // writing it back would be this effect updating its own input.
  useEffect(() => {
    if (!selectedPath) return;
    setFile(null);
    void getApi()
      .files.read(selectedPath, { maxBytes: 512 * 1024 })
      .then((result) =>
        setFile({
          path: selectedPath,
          content: result.content,
          truncated: result.truncated,
        }),
      )
      .catch(() => undefined);
  }, [selectedPath]);

  const open = useCallback(
    (path: string) => {
      setFile(null);
      // Report the selection outward. The left rail shows a file tree too, and
      // two identical lists that disagree about which file is open read as two
      // different applications.
      onSelectFile(path);
      void getApi()
        .files.read(path, { maxBytes: 512 * 1024 })
        .then((result) =>
          setFile({ path, content: result.content, truncated: result.truncated }),
        )
        .catch(() => undefined);
    },
    [onSelectFile],
  );

  const up = useCallback(() => {
    if (!dir || !root || dir === root) return;
    const idx = Math.max(dir.lastIndexOf('/'), dir.lastIndexOf('\\'));
    setDir(idx > 0 ? dir.slice(0, idx) : root);
    setFile(null);
  }, [dir, root]);

  const sorted = useMemo(
    () =>
      entries
        .slice()
        .sort((a, b) =>
          a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1,
        ),
    [entries],
  );

  // §10: Workspace Trust gates project-level capabilities. It is a decision the
  // user makes once — and it must be visible and revocable. A trust state the
  // user cannot see or change is not a control, it is a constant.
  const trust = data.workspace?.trustState ?? 'untrusted';
  const setTrust = useCallback(
    async (next: 'untrusted' | 'trusted' | 'restricted') => {
      try {
        await getApi().workspace.setTrust(next);
        await data.refresh();
      } catch (error) {
        // Surface it: silently ignoring a failed trust change would leave the
        // user believing a permission decision they did not make.
        setEntries((prev) => prev);
        throw error;
      }
    },
    [data],
  );

  return (
    <div className="pane">
      <div className="pane-head">
        <h1>{t('tab.explorer')}</h1>
        <p className="mono" style={{ fontSize: 11.5 }}>
          {root ?? t('welcome.step1')}
        </p>
      </div>

      {root && (
        <div className="card">
          <h2>{t('trust.title')}</h2>
          <div className="row-gap" style={{ flexWrap: 'wrap' }}>
            {(['untrusted', 'trusted', 'restricted'] as const).map((level) => (
              <button
                key={level}
                className={trust === level ? 'primary' : ''}
                onClick={() => void setTrust(level)}
              >
                {t(`trust.${level}`)}
              </button>
            ))}
          </div>
          <div className="faint" style={{ fontSize: 11.5, marginTop: 6 }}>
            {t(`trust.${trust}.hint`)}
          </div>
        </div>
      )}

      {!root ? (
        <div className="empty">{t('welcome.step1Hint')}</div>
      ) : (
        <div className="split">
          <div className="card split-list">
            {dir !== root && (
              <div className="tree-row" onClick={up}>
                <span className="caret">&#8593;</span>
                <span className="faint">{t('common.back')}</span>
              </div>
            )}
            {sorted.length === 0 ? (
              <div className="faint rail-note">{t('empty.explorer')}</div>
            ) : (
              sorted.map((entry) => (
                <div
                  key={entry.path}
                  className={`tree-row ${file?.path === entry.path ? 'sel' : ''}`}
                  onClick={() => {
                    if (entry.kind === 'dir') {
                      setDir(entry.path);
                      setFile(null);
                    } else {
                      open(entry.path);
                    }
                  }}
                >
                  <span className="caret">{entry.kind === 'dir' ? '▸' : ''}</span>
                  <span className="truncate">{entry.name}</span>
                </div>
              ))
            )}
          </div>

          <div className="split-main">
            {file ? (
              <>
                <div className="block-title is-path">
                  <span className="truncate" title={file.path}>
                    {file.path}
                  </span>
                  {file.truncated && <span className="badge warn">…</span>}
                  {trust !== 'untrusted' ? (
                    <button
                      className="ghost"
                      onClick={() => setEditing((v) => !v)}
                    >
                      {editing ? t('editor.preview') : t('editor.edit')}
                    </button>
                  ) : null}
                </div>
                {trust === 'untrusted' && (
                  <div className="notice warn" style={{ marginBottom: 8 }}>
                    <span className="grow">{t('editor.needsTrust')}</span>
                    <button onClick={() => void setTrust('trusted')}>
                      {t('trust.trusted')}
                    </button>
                  </div>
                )}
                {editing ? (
                  <FileEditor
                    path={file.path}
                    onSaved={() => open(file.path)}
                    onClose={() => setEditing(false)}
                  />
                ) : (
                  <div className="code" style={{ maxHeight: '62vh' }}>
                    {file.content}
                  </div>
                )}
              </>
            ) : (
              <div className="empty">{t('empty.explorer')}</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Changes (Git)
// ---------------------------------------------------------------------------

export function Changes({ data }: { data: AppData }): JSX.Element {  const t = useT();
  const [status, setStatus] = useState<{
    branch: string;
    head: string;
    staged: Array<{ path: string }>;
    unstaged: Array<{ path: string }>;
    untracked: string[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [patch, setPatch] = useState<{ path: string; text: string } | null>(null);
  const [message, setMessage] = useState('');

  const workspaceId = data.workspace?.id ?? null;

  const refresh = useCallback(async () => {
    if (!workspaceId) return;
    try {
      setStatus(await getApi().git.status(workspaceId));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [workspaceId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const allPaths = useMemo(() => {
    if (!status) return [];
    return [
      ...status.staged.map((s) => s.path),
      ...status.unstaged.map((s) => s.path),
      ...status.untracked,
    ];
  }, [status]);

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const showDiff = async (path: string) => {
    try {
      const d = await getApi().git.diff({ path });
      setPatch({ path, text: d.binary ? '' : d.patch });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="pane">
      <div className="pane-head">
        <h1>{t('tab.changes')}</h1>
        {status && (
          <p className="mono" style={{ fontSize: 11.5 }}>
            {status.branch} · {status.head.slice(0, 7)} · {allPaths.length}
          </p>
        )}
      </div>

      {error && <div className="notice error">{error}</div>}

      {allPaths.length === 0 ? (
        <div className="empty">{t('empty.changes')}</div>
      ) : (
        <div className="card" style={{ padding: '4px 0' }}>
          <table className="grid">
            <tbody>
              {allPaths.map((path) => {
                const staged = status?.staged.some((s) => s.path === path) ?? false;
                return (
                  <tr key={path}>
                    <td>
                      <span
                        className="truncate"
                        style={{ cursor: 'pointer', display: 'block', maxWidth: 460 }}
                        onClick={() => void showDiff(path)}
                        title={path}
                      >
                        {path}
                      </span>
                    </td>
                    <td style={{ width: 1 }}>
                      <span className={`badge ${staged ? 'ok' : ''}`}>
                        {staged ? t('changes.staged') : t('changes.unstaged')}
                      </span>
                    </td>
                    <td style={{ width: 1 }}>
                      {/* A flex row: two bare buttons in a cell wrapped onto two
                          lines, which made every staged row twice as tall as
                          the unstaged ones. */}
                      <div className="row-gap" style={{ flexWrap: 'nowrap' }}>
                        <button
                          className="ghost"
                          title={t('changes.stage')}
                          aria-label={`${t('changes.stage')}: ${path}`}
                          onClick={() => void run(() => getApi().git.stage([path]))}
                        >
                          +
                        </button>
                        {staged && (
                          <button
                            className="ghost"
                            title={t('changes.unstage')}
                            aria-label={`${t('changes.unstage')}: ${path}`}
                            onClick={() => void run(() => getApi().git.unstage([path]))}
                          >
                            −
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="card">
        <h2>{t('changes.commitTitle')}</h2>
        <div className="row-gap">
          <input
            placeholder={t('changes.commitPlaceholder')}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
          />
          <button
            className="primary"
            disabled={!message.trim()}
            onClick={() =>
              void run(async () => {
                await getApi().git.commit(message.trim());
                setMessage('');
              })
            }
          >
            {t('changes.commit')}
          </button>
        </div>
      </div>

      {patch && (
        <>
          <div className="block-title is-path">
            <span className="truncate" title={patch.path}>
              {patch.path}
            </span>
          </div>
          <DiffView patch={patch.text} />
        </>
      )}
    </div>
  );
}

export function DiffView({ patch }: { patch: string }): JSX.Element {
  const t = useT();
  const lines = useMemo(() => patch.split('\n'), [patch]);
  if (patch.trim() === '') {
    return <div className="faint">{t('empty.diff')}</div>;
  }
  return (
    <div className="diff">
      {lines.map((line, index) => {
        let cls = '';
        if (line.startsWith('@@')) cls = 'hunk';
        else if (
          line.startsWith('+++') ||
          line.startsWith('---') ||
          line.startsWith('diff ') ||
          line.startsWith('index ')
        )
          cls = 'meta';
        else if (line.startsWith('+')) cls = 'add';
        else if (line.startsWith('-')) cls = 'del';
        return (
          <div className={`line ${cls}`} key={index}>
            {line || ' '}
          </div>
        );
      })}
    </div>
  );
}
