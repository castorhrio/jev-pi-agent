import { useEffect, useState } from 'react';
import { getApi } from '../api';
import { useT } from '../i18n-context';
import type { AppData } from '../state/hooks';
import type { SessionViewState } from '../state/session-reducer';

export interface StatusBarProps {
  data: AppData;
  view: SessionViewState;
  onOpenHelp: () => void;
}

/**
 * A status line, not a label strip.
 *
 * The one number UCAD has that no other tool does is the turn's context budget —
 * what the agent has been given and how much room is left. That is the thing a
 * user of this product actually needs to watch, so it gets a bar rather than a
 * line of text.
 */
export function StatusBar({ data, view, onOpenHelp }: StatusBarProps): JSX.Element {
  const t = useT();
  const [branch, setBranch] = useState<string | null>(null);

  useEffect(() => {
    const workspaceId = data.workspace?.id;
    if (!workspaceId) {
      setBranch(null);
      return;
    }
    let cancelled = false;
    void getApi()
      .git.status(workspaceId)
      .then((status) => {
        if (!cancelled) setBranch(status.branch);
      })
      .catch(() => {
        /* not a git repo */
      });
    return () => {
      cancelled = true;
    };
  }, [data.workspace?.id]);

  const ctx = view.context;
  const ratio = ctx && ctx.itemCount > 0 ? Math.min(1, ctx.estimatedTokens / 32_000) : 0;
  const level = ratio > 0.85 ? 'err' : ratio > 0.6 ? 'warn' : '';

  return (
    // A `<footer>`, so the status line lives in the `contentinfo` landmark. As a
    // bare div its contents sat outside every landmark, which axe-core flags
    // and which means a screen-reader user has no landmark to jump to for the
    // one place the app reports its own state.
    <footer className="statusbar">
      <span className="seg">
        <span className={`dot ${dotFor(view.status)}`} />
        {view.status}
      </span>

      {branch && <span className="seg">{branch}</span>}
      {branch && data.workspace && <span className="seg txt truncate">{data.workspace.name}</span>}

      <span className="seg">seq {view.lastSeq}</span>

      {ctx && (
        <span className="meter" title={`${ctx.itemCount} items · ${ctx.strategy}`}>
          <span className="faint">ctx</span>
          <span className="meter-track">
            <span className={`meter-fill ${level}`} style={{ width: `${ratio * 100}%` }} />
          </span>
          <span>
            {ctx.estimatedTokens} tok · {ctx.estimateSource}
          </span>
        </span>
      )}

      {view.usage && (
        <span className="seg">
          {view.usage.inputTokens.toLocaleString()}↑ {view.usage.outputTokens.toLocaleString()}
          ↓{view.usage.estimated ? ' ≈' : ''}
        </span>
      )}

      <span className="spacer" />

      {view.permissions.some((p) => !p.resolved) && (
        <span className="seg">
          <span className="dot warn" />
          {t('permission.title')}
        </span>
      )}

      <button className="link" onClick={onOpenHelp}>
        {t('help.title')}
      </button>

      {data.diagnostics ? (
        <span className="seg">
          v{data.diagnostics.version} · schema v{data.diagnostics.schemaVersion} ·{' '}
          {data.diagnostics.encryptionEnabled
            ? t('settings.encrypted')
            : t('settings.notEncrypted')}
        </span>
      ) : (
        /*
         * This segment used to be wrapped in `{data.diagnostics && …}`, so a
         * failed read made it disappear without a word. The version and the
         * at-rest state are the two things a user is most likely to come to
         * the status bar to check, and a gap in the bar reads as "not
         * important" rather than "we could not find out".
         */
        data.endpointErrors.diagnostics && (
          <span className="seg">
            <span className="dot warn" />
            {t('statusbar.diagnosticsUnknown')}
          </span>
        )
      )}
    </footer>
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
