import {
  forwardRef,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import type { AgentCatalogEntry, PermissionMode, ProviderDescriptorDto } from '@ucad/contracts';
import { getApi } from '../api';
import { useT } from '../i18n-context';

/**
 * The composer.
 *
 * The selectors live here, not in a sidebar, because a permission mode or an
 * agent choice is part of *sending this message* - it belongs next to the send
 * button, where the decision is actually made, and not in a panel the user has
 * to go and find.
 *
 * `@` mentions are the other half: the fastest way to point an agent at a file
 * is to type its path, and the fastest way to reference a decision is to
 * reference the pack that contains it.
 */
export const Composer = forwardRef<
  HTMLTextAreaElement,
  {
    value: string;
    onChange: (value: string) => void;
    onSend: () => void;
    onStop: () => void;
    running: boolean;
    busy: boolean;
    interrupted: boolean;
    agentId: string;
    onAgentChange: (id: string) => void;
    /**
     * The vendor for the next turn. `''` means "do not override" — the
     * session's own provider (or the agent's default) decides, which is what
     * happened before this picker existed. It is the first option on purpose:
     * forcing a value here would silently change behaviour for anyone who
     * never touched it.
     */
    providerId: string;
    onProviderChange: (id: string) => void;
    /** Only `supported` providers are offered; the rest cannot be called. */
    providers: ProviderDescriptorDto[];
    permissionMode: PermissionMode;
    onPermissionModeChange: (mode: PermissionMode) => void;
    agents: AgentCatalogEntry[];
    hasWorkspace: boolean;
    onOpenProject: () => void;
    workspacePath: string | null;
  }
>(function Composer(props, forwardedRef) {
  const t = useT();
  // `useRef<T>(null)` yields a *readonly* RefObject in React 18's types, so the
  // local ref declares the nullable element type explicitly to stay writable.
  const localRef = useRef<HTMLTextAreaElement | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [mention, setMention] = useState<{ query: string; at: number } | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [files, setFiles] = useState<string[]>([]);

  const setRef = useCallback(
    (node: HTMLTextAreaElement | null) => {
      localRef.current = node;
      if (typeof forwardedRef === 'function') forwardedRef(node);
      else if (forwardedRef) {
        (forwardedRef as React.MutableRefObject<HTMLTextAreaElement | null>).current = node;
      }
    },
    [forwardedRef],
  );

  // A file list is only worth fetching once, and only when a project is open.
  useEffect(() => {
    const root = props.workspacePath;
    if (!root) {
      setFiles([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      const out: string[] = [];
      const walk = async (dir: string, depth: number) => {
        if (depth > 2 || out.length > 400) return;
        try {
          const entries = await getApi().files.list(dir);
          for (const entry of entries) {
            if (out.length > 400) return;
            if (entry.kind === 'file') out.push(entry.path);
            else void walk(entry.path, depth + 1);
          }
        } catch {
          /* an unreadable directory should not break mentions */
        }
      };
      await walk(root, 0);
      if (!cancelled) setFiles(out.sort());
    })();
    return () => {
      cancelled = true;
    };
  }, [props.workspacePath]);

  const suggestions = useMemo(() => {
    if (!mention) return [];
    const q = mention.query.toLowerCase();
    const base = props.workspacePath ?? '';
    return files
      .filter((p) => p.toLowerCase().includes(q))
      .slice(0, 8)
      .map((p) => (base && p.startsWith(base) ? p.slice(base.length + 1) : p));
  }, [mention, files, props.workspacePath]);

  const applyMention = useCallback(
    (path: string) => {
      if (!mention) return;
      const el = localRef.current;
      const before = props.value.slice(0, mention.at);
      const after = props.value.slice(mention.at + 1 + mention.query.length);
      props.onChange(`${before}@${path} ${after}`);
      setMention(null);
      el?.focus();
    },
    [mention, props],
  );

  const onChange = useCallback(
    (event: React.ChangeEvent<HTMLTextAreaElement>) => {
      const next = event.target.value;
      props.onChange(next);
      const caret = event.target.selectionStart;
      const upto = next.slice(0, caret);
      const match = /@([^\s@]*)$/.exec(upto);
      setMention(match ? { query: match[1] ?? '', at: caret - (match[1]?.length ?? 0) - 1 } : null);
      setMentionIndex(0);
    },
    [props],
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (mention && suggestions.length > 0) {
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          setMentionIndex((i) => (i + 1) % suggestions.length);
          return;
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault();
          setMentionIndex((i) => (i - 1 + suggestions.length) % suggestions.length);
          return;
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
          event.preventDefault();
          const picked = suggestions[mentionIndex];
          if (picked) applyMention(picked);
          return;
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          setMention(null);
          return;
        }
      }
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        if (!props.running) props.onSend();
      }
    },
    [mention, suggestions, mentionIndex, applyMention, props],
  );

  const agent = props.agents.find((a) => a.manifest.id === props.agentId);
  const modeDanger = props.permissionMode !== 'read_only';

  return (
    <div className="composer">
      <div className="composer-inner">
        {props.interrupted && (
          <div className="notice warn">
            <span className="badge warn">INTERRUPTED</span>
            <span className="muted">{t('session.interrupted')}</span>
          </div>
        )}

        {!props.hasWorkspace && (
          <div className="notice info">
            <span className="muted">{t('welcome.step1')}</span>
            <button className="primary" onClick={props.onOpenProject}>
              {t('welcome.open')}
            </button>
          </div>
        )}

        <div className="composer-box" ref={boxRef}>
          <textarea
            ref={setRef}
            value={props.value}
            onChange={onChange}
            onKeyDown={onKeyDown}
            placeholder={
              props.hasWorkspace ? t('composer.placeholder') : t('welcome.step1')
            }
            disabled={!props.hasWorkspace}
            rows={2}
            spellCheck={false}
          />

          <div className="composer-bar">
            <select
              className="picker-select"
              value={props.agentId}
              onChange={(e) => props.onAgentChange(e.target.value)}
              aria-label="Agent"
              title={agent?.manifest.displayName ?? 'Agent'}
              disabled={!props.hasWorkspace}
            >
              {(props.agents.length > 0
                ? props.agents.map((a) => a.manifest.id)
                : ['mock']
              ).map((id) => (
                <option key={id} value={id}>
                  {props.agents.find((a) => a.manifest.id === id)?.manifest.displayName ?? id}
                </option>
              ))}
            </select>

            <select
              className="picker-select"
              value={props.providerId}
              onChange={(e) => props.onProviderChange(e.target.value)}
              aria-label={t('composer.provider')}
              title={t('composer.provider')}
              disabled={!props.hasWorkspace || props.providers.length === 0}
            >
              {/*
                RESEARCH §1: switching vendors should cost one click, not a
                trip through settings. A provider that this build cannot speak
                is not offered at all — listing it would be offering something
                that cannot work.
              */}
              <option value="">{t('composer.provider.auto')}</option>
              {props.providers
                .filter((p) => p.supported)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.displayName}
                  </option>
                ))}
            </select>

            <select
              className={`picker-select ${modeDanger ? 'warn' : ''}`}
              value={props.permissionMode}
              onChange={(e) => props.onPermissionModeChange(e.target.value as PermissionMode)}
              aria-label={t('session.permissionMode')}
              title={t('session.permissionMode')}
              disabled={!props.hasWorkspace}
            >
              <option value="read_only">{t('session.permission.read_only')}</option>
              <option value="ask">{t('session.permission.ask')}</option>
              <option value="workspace_write">
                {t('session.permission.workspace_write')}
              </option>
            </select>

            <span className="grow" />

            {/*
              The keyboard hint used to be rendered here AND again in the row
              below, so the user read the same sentence twice. It stays in the
              hint row, which also carries the @-mention reminder — and its
              absence here keeps the bar from crowding the Send control at
              narrow widths.
            */}

            {props.running ? (
              <button className="danger" onClick={props.onStop}>
                {t('composer.stop')}
              </button>
            ) : (
              <button
                className="primary"
                onClick={props.onSend}
                disabled={props.busy || !props.value.trim() || !props.hasWorkspace}
              >
                {props.busy ? t('composer.sending') : t('composer.send')}
              </button>
            )}
          </div>

          {mention && suggestions.length > 0 && (
            <div className="mentions">
              {suggestions.map((path, index) => (
                <div
                  key={path}
                  className={`mention ${index === mentionIndex ? 'on' : ''}`}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    applyMention(path);
                  }}
                >
                  <span>{path.split('/').pop()}</span>
                  <span className="p grow">{path}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="composer-hint">
          <span>{props.running ? t('composer.stop') : t('composer.hint')}</span>
          <span className="faint">@ {t('composer.mention')}</span>
        </div>
      </div>
    </div>
  );
});
