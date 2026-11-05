import { useCallback, useState } from 'react';
import { DEMO_BOUNDARIES } from '../../../shared/demo-boundaries';
import { useT } from '../i18n-context';

/**
 * The three external blockers, as something the user can run.
 *
 * Diagnostics, not Help: Help answers "where do I start", this answers "what is
 * true on this machine right now". The commands and the expected lines come from
 * `apps/desktop/src/shared/demo-boundaries.ts` — one list, also compared against
 * `docs/demo-script.md` by `tests/contract/demo-boundaries.test.ts` — so the page
 * and the screen cannot quote different commands. Why each blocker is open is
 * `docs/blockers.md`, not here.
 *
 * The copy button has three states (`复制中…` / `已复制` / `复制失败`): the command is
 * long enough that retyping it from a screenshot is a way to get a different
 * command, and `navigator.clipboard` is unavailable on a non-secure origin.
 */
export function EnvSelfCheck(): JSX.Element {
  const t = useT();
  const [copyState, setCopyState] = useState<{
    readonly id: string;
    readonly state: 'copying' | 'copied' | 'failed';
  } | null>(null);

  const copy = useCallback((id: string, command: string) => {
    setCopyState({ id, state: 'copying' });
    void navigator.clipboard
      .writeText(command)
      .then(() => setCopyState({ id, state: 'copied' }))
      .catch(() => setCopyState({ id, state: 'failed' }));
  }, []);

  return (
    <div className="card env-check">
      <h2>{t('diag.env.title')}</h2>
      <p className="muted">{t('diag.env.intro')}</p>
      {DEMO_BOUNDARIES.map((boundary) => {
        const state = copyState?.id === boundary.id ? copyState.state : 'idle';
        const commandId = `env-check-command-${boundary.id}`;
        return (
          <div className="env-check-item mt-3" key={boundary.id}>
            <div className="step-title">{t(`diag.env.${boundary.id}`)}</div>
            <div className="row-gap mt-1">
              <div className="code grow" id={commandId}>
                {boundary.command}
              </div>
              <button
                className="ghost"
                onClick={() => copy(boundary.id, boundary.command)}
                disabled={state === 'copying'}
                aria-label={t('diag.env.copy')}
                aria-describedby={commandId}
                title={boundary.command}
              >
                {state === 'copying'
                  ? t('diag.env.copying')
                  : state === 'failed'
                    ? t('diag.env.copyFailed')
                    : state === 'copied'
                      ? t('diag.env.copied')
                      : t('diag.env.copy')}
              </button>
            </div>
            <div className="muted mt-1 env-check-expected">{boundary.expected}</div>
          </div>
        );
      })}
      <p className="muted mt-3">{t('diag.env.footnote')}</p>
    </div>
  );
}
