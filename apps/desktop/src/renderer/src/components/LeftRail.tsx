import { useCallback, useEffect, useState } from 'react';
import { getApi } from '../api';
import { useT } from '../i18n-context';
import type { AppData } from '../state/hooks';

type FileEntry = { name: string; path: string; kind: 'file' | 'dir' };


/**
 * The left rail switches *context* — which thread, which file. Surfaces live in
 * the segmented control above the main column, so the two jobs never compete for
 * the same column and the rail never fills with things that are not a
 * destination.
 */
export function LeftRail({
  data,
  sessionId,
  onSelectSession,
  onNewSession,
  onResume,
  onRenameSession,
  onDeleteSession,
  onOpenProject,
  onOpenFile,
  selectedFile,
}: {
  data: AppData;
  sessionId: string | null;
  onSelectSession: (id: string) => void;
  onNewSession: () => void;
  onResume: () => void;
  onRenameSession: (id: string, title: string) => void;
  onDeleteSession: (id: string, title: string) => void;
  onOpenProject: () => void;
  onOpenFile: (path: string) => void;
  /**
   * The file currently open in the Explorer. The rail shows a file tree as
   * well as the Explorer surface, and two lists that look identical but
   * disagree about the selection read as two different applications.
   */
  selectedFile: string | null;
}): JSX.Element {
  const t = useT();
  const root = data.workspace?.path ?? null;
  const [filesOpen, setFilesOpen] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const startRename = (id: string, title: string): void => {
    setConfirmDeleteId(null);
    setEditingId(id);
    setDraft(title);
  };

  const commitRename = (id: string): void => {
    const next = draft.trim();
    setEditingId(null);
    // An empty title is not a rename; keeping the old one is not a surprise.
    if (next.length === 0) return;
    if (next !== data.sessions.find((s) => s.id === id)?.title) onRenameSession(id, next);
  };

  return (
    <aside className="rail" aria-label={t('rail.landmark')}>
      <div className="rail-section grow">
        <div className="rail-head">
          <span>{t('rail.threads')}</span>
          <span className="row-gap" style={{ gap: 2 }}>
            <button onClick={onResume} title={t('session.resume')} aria-label={t('session.resume')}>
              ⟳
            </button>
            <button onClick={onNewSession} title={t('session.new')} aria-label={t('session.new')}>
              +
            </button>
          </span>
        </div>
        <div className="rail-body">
          {data.endpointErrors.sessions ? (
            // A failed read is not an empty list. Saying "no sessions yet"
            // when the list simply could not be loaded is how a real project
            // came to look like a fresh install.
            <div className="rail-note rail-note-error">
              <div>{t('sessions.loadFailed')}</div>
              <div className="faint rail-note-detail">{data.endpointErrors.sessions}</div>
            </div>
          ) : data.loading ? (
            /*
             * Not "no sessions yet" — *not known yet*.
             *
             * The empty state carries an invitation ("click + above to start"),
             * so rendering it before the list arrives tells the user something
             * false and asks them to act on it. A slow start on a big database
             * is enough to get there.
             */
            <div className="faint rail-note">{t('common.loading')}</div>
          ) : data.sessions.length === 0 ? (
            <div className="faint rail-note">{t('empty.sessions')}</div>
          ) : (
            data.sessions.map((session) => (
              <div
                key={session.id}
                className={`row-item ${session.id === sessionId ? 'active' : ''}`}
                onClick={() => {
                  setConfirmDeleteId(null);
                  onSelectSession(session.id);
                }}
              >
                {editingId === session.id ? (
                  <input
                    className="rail-rename"
                    value={draft}
                    autoFocus
                    onChange={(e) => setDraft(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    onBlur={() => commitRename(session.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitRename(session.id);
                      if (e.key === 'Escape') setEditingId(null);
                    }}
                    aria-label={t('session.rename')}
                  />
                ) : (
                  <div className="t truncate">{session.title || t('session.new')}</div>
                )}
                <div className="m">
                  <span className={`dot ${dotFor(session.status)}`} />
                  <span className="truncate">{session.agentId}</span>
                  <span>·</span>
                  <span>{session.status}</span>
                  <span className="spacer" />
                  <span className="row-gap" style={{ gap: 2 }}>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        startRename(session.id, session.title);
                      }}
                      title={t('session.rename')}
                      aria-label={t('session.rename')}
                    >
                      ✎
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditingId(null);
                        setConfirmDeleteId(confirmDeleteId === session.id ? null : session.id);
                      }}
                      title={t('session.delete')}
                      aria-label={t('session.delete')}
                    >
                      🗑
                    </button>
                  </span>
                </div>
                {confirmDeleteId === session.id && (
                  <div
                    className="notice warn"
                    onClick={(e) => e.stopPropagation()}
                    style={{ marginTop: 6 }}
                  >
                    <div>{t('session.deleteConfirm')}</div>
                    <div className="row-gap" style={{ marginTop: 6 }}>
                      <button
                        className="primary"
                        onClick={() => {
                          setConfirmDeleteId(null);
                          onDeleteSession(session.id, session.title);
                        }}
                      >
                        {t('session.delete')}
                      </button>
                      <button onClick={() => setConfirmDeleteId(null)}>{t('common.cancel')}</button>
                    </div>
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </div>

      <div className="rail-section grow">
        <div className="rail-head">
          <button
            className="rail-caret"
            onClick={() => setFilesOpen((v) => !v)}
            aria-expanded={filesOpen}
            aria-label={t('rail.files')}
          >
            {filesOpen ? '▾' : '▸'}
          </button>
          <span>{t('rail.files')}</span>
        </div>

        {!root ? (
          <div className="rail-body">
            <button onClick={onOpenProject} style={{ width: '100%' }}>
              {t('welcome.open')}
            </button>
          </div>
        ) : (
          filesOpen && (
            <FileTree root={root} onOpenFile={onOpenFile} selectedPath={selectedFile} />
          )
        )}
      </div>

      <div className="rail-section">
        <div className="rail-head">
          <span>{t('rail.project')}</span>
        </div>
        <div className="rail-body">
          <div className="defs">
            <div className="def">
              <span className="k">{t('rail.trust')}</span>
              <span className="v">
                <span
                  className={`badge ${
                    data.workspace?.trustState === 'trusted'
                      ? 'ok'
                      : data.workspace?.trustState === 'restricted'
                        ? 'warn'
                        : ''
                  }`}
                >
                  {data.workspace?.trustState ?? t('common.unknown')}
                </span>
              </span>
            </div>
            <div className="def">
              <span className="k">{t('rail.provider')}</span>
              <span className="v">
                {data.activeSession?.providerId ?? data.activeSession?.modelId ?? '—'}
              </span>
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
}

function FileTree({
  root,
  onOpenFile,
  selectedPath,
}: {
  root: string;
  onOpenFile: (path: string) => void;
  /** Marked so this tree agrees with the Explorer surface about what is open. */
  selectedPath: string | null;
}): JSX.Element {
  const t = useT();
  const [dir, setDir] = useState(root);
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    void getApi()
      .files.list(dir)
      .then((list) => {
        if (!cancelled) setEntries(list);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [dir]);

  const up = useCallback(() => {
    if (dir === root) return;
    const idx = Math.max(dir.lastIndexOf('/'), dir.lastIndexOf('\\'));
    setDir(idx > 0 ? dir.slice(0, idx) : root);
  }, [dir, root]);

  if (error) {
    return (
      <div className="rail-body">
        <div className="faint rail-note">{error}</div>
      </div>
    );
  }

  const sorted = entries
    .filter((entry) => !entry.name.startsWith('.'))
    .slice()
    .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1));

  return (
    <div className="rail-body">
      {dir !== root && (
        <div className="tree-row" onClick={up}>
          <span className="caret">↑</span>
          <span className="faint">{t('common.back')}</span>
        </div>
      )}
      {sorted.length === 0 ? (
        <div className="faint rail-note">{t('empty.explorer')}</div>
      ) : (
        sorted.map((entry) => (
          <div
            key={entry.path}
            className={`tree-row ${selectedPath === entry.path ? 'sel' : ''}`}
            onClick={() => (entry.kind === 'dir' ? setDir(entry.path) : onOpenFile(entry.path))}
            title={entry.path}
          >
            <span className="caret">{entry.kind === 'dir' ? '▸' : ''}</span>
            <span className="truncate">{entry.name}</span>
          </div>
        ))
      )}
    </div>
  );
}

function dotFor(status: string): string {
  switch (status) {
    case 'RUNNING':
      return 'running';
    case 'INTERRUPTED':
    case 'WAITING_PERMISSION':
    case 'CANCELLING':
      return 'warn';
    case 'FAILED':
      return 'err';
    case 'READY':
    case 'CLOSED':
      return 'ok';
    default:
      return '';
  }
}
