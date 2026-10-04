/**
 * The file editor.
 *
 * §7.1 `files.write` (M2) exists in the backend and has had no UI at all, which
 * made the product read-only: an agent could change files, but a person could
 * not. That is the single largest reason the app could not be "投入使用".
 *
 * Two rules it must not break:
 *   §11.3 optimistic concurrency — `read` returns a content hash and `write`
 *   takes `expectedRevision`; a mismatch is a conflict the user must resolve,
 *   not an overwrite. An agent and a human editing the same file is the normal
 *   case in this product, not an edge case.
 *   §4.9 permissions — a write outside the workspace, or one the policy denies,
 *   surfaces as a refusal with its reason.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { getApi } from '../api';
import { useT } from '../i18n-context';

const AUTOSAVE_DEBOUNCE_MS = 800;

export function FileEditor({
  path,
  onSaved,
  onClose,
}: {
  path: string;
  onSaved?: () => void;
  onClose?: () => void;
}): JSX.Element {
  const t = useT();
  const [content, setContent] = useState('');
  const [revision, setRevision] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [state, setState] = useState<'idle' | 'loading' | 'saving' | 'conflict' | 'error'>(
    'idle',
  );
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setState('loading');
    setMessage(null);
    setDirty(false);
    void getApi()
      .files.read(path, { maxBytes: 2 * 1024 * 1024 })
      .then((result) => {
        if (cancelled) return;
        setContent(result.content);
        setRevision(result.revision);
        setTruncated(result.truncated);
        setState('idle');
      })
      .catch((error) => {
        if (cancelled) return;
        setState('error');
        setMessage(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  const save = useCallback(
    async (opts: { force?: boolean } = {}) => {
      if (!revision) return;
      setState('saving');
      setMessage(null);
      try {
        const result = await getApi().files.write(path, content, {
          ...(opts.force ? {} : { expectedRevision: revision }),
        });
        setRevision(result.revision);
        setDirty(false);
        setState('idle');
        onSaved?.();
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        // A revision mismatch is not a failure to retry blindly — it means
        // something else changed the file and the user has to choose.
        if (/revision|conflict|冲突|已修改/i.test(text)) {
          setState('conflict');
          setMessage(text);
        } else {
          setState('error');
          setMessage(text);
        }
      }
    },
    [path, content, revision, onSaved],
  );

  // Autosave, but never on a conflict: retrying over someone else's change
  // without asking is exactly the failure §11.3 exists to prevent.
  useEffect(() => {
    if (!dirty || state === 'conflict' || state === 'saving') return;
    const timer = setTimeout(() => {
      void save();
    }, AUTOSAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [dirty, content, state, save]);

  const lines = useMemo(() => content.split('\n').length, [content]);

  return (
    <div className="editor">
      <div className="editor-bar">
        <span className="mono truncate grow">{path}</span>
        <span className="faint mono">{lines} lines</span>
        {truncated && <span className="badge warn">{t('editor.truncated')}</span>}
        {revision && (
          <span className="badge" title={t('editor.revisionHint')}>
            {revision.slice(0, 10)}
          </span>
        )}
        {dirty && <span className="badge accent">{t('editor.unsaved')}</span>}
        {state === 'saving' && <span className="faint">{t('editor.saving')}</span>}
        <button className="ghost" onClick={() => void save()} disabled={!dirty || state === 'saving'}>
          {t('editor.save')}
        </button>
        {onClose && (
          <button className="ghost" onClick={onClose}>
            {t('common.close')}
          </button>
        )}
      </div>

      {state === 'conflict' && (
        <div className="notice warn">
          <div className="grow">
            <div>{t('editor.conflict')}</div>
            <div className="faint mono" style={{ fontSize: 11 }}>
              {message}
            </div>
          </div>
          <button
            onClick={() => {
              void getApi()
                .files.read(path, { maxBytes: 2 * 1024 * 1024 })
                .then((r) => {
                  setContent(r.content);
                  setRevision(r.revision);
                  setDirty(false);
                  setState('idle');
                })
                .catch(() => undefined);
            }}
          >
            {t('editor.reload')}
          </button>
          <button className="danger" onClick={() => void save({ force: true })}>
            {t('editor.overwrite')}
          </button>
        </div>
      )}

      {state === 'error' && message && (
        <div className="notice error">
          <span className="grow">{message}</span>
        </div>
      )}

      <textarea
        className="editor-area"
        value={content}
        spellCheck={false}
        readOnly={state === 'loading' || state === 'conflict'}
        onChange={(e) => {
          setContent(e.target.value);
          setDirty(true);
        }}
        onKeyDown={(e) => {
          if (e.key === 's' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void save();
          }
        }}
      />

      <div className="faint editor-hint">
        {t('editor.hint')} · Ctrl+S {t('editor.save')}
      </div>
    </div>
  );
}
