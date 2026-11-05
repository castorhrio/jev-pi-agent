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
 * ## The line under the expected output: who can close it
 *
 * The command answers "how do you prove it". The question a reviewer asks next
 * is "then whose is it, and where does it get closed" — and the panel used to
 * stop at "you can run this yourself", which is an answer about the reader, not
 * about the blocker. So each block carries one more line, `diag.env.<id>.who`,
 * naming the holder: a write token, a Windows machine, a person. It is not a new
 * fact and it is not a new command — it is the parenthetical of that blocker's
 * heading in `docs/blockers.md` (`DemoBoundary.needs`), and the gate compares
 * the two, so the screen cannot name a different holder than the page.
 *
 * ## The copy button, and what happens when copying is not available
 *
 * The command is long enough that retyping it from a screenshot is a way to get
 * a *different* command, so there is a copy button with three states
 * (`复制中…` / `已复制` / `复制失败`). `navigator.clipboard` is undefined on a
 * non-secure origin and can reject for permission reasons, and the old failure
 * state said only `复制失败` — a dead end: the user is told the button did not
 * work and nothing about what to do instead. So the failed state also renders
 * `diag.env.copyFailedHint` under the command, which names the cause and the
 * next step (select the command and copy it by hand). It is a `role="status"`
 * region, because the failure appears *after* the click and a screen reader
 * would otherwise never hear it.
 *
 * ## Why the command block is focusable
 *
 * The hint says "select the command", and a keyboard user cannot select what
 * they cannot reach: a plain `<div>` is not in the tab order, so the fallback
 * the hint offers was mouse-only. The block is therefore `tabIndex={0}` with
 * `role="textbox"` + `aria-readonly`, which is what a read-only, selectable
 * field *is* — it is announced as a read-only text field rather than as an
 * anonymous group, and it is named by the sentence above it (`aria-labelledby`)
 * so the announcement says which blocker the command belongs to.
 *
 * ## Why the button's accessible name carries the state
 *
 * `aria-label` used to be the static `复制命令` while the state lived only in the
 * button's *text*. A screen reader re-focusing the button therefore heard the
 * same name before and after the click, and the one thing the button has to
 * report — did it work — was the one thing not announced. The name is now
 * `复制命令 — <state>` for the three non-idle states (and plain `复制命令` when
 * idle, so the name does not read `复制命令 — 复制命令`), which also keeps the
 * visible text inside the accessible name (WCAG 2.5.3).
 */
export function EnvSelfCheck(): JSX.Element {
  const t = useT();
  const [copyState, setCopyState] = useState<{
    readonly id: string;
    readonly state: 'copying' | 'copied' | 'failed';
  } | null>(null);

  const copy = useCallback((id: string, command: string) => {
    setCopyState({ id, state: 'copying' });
    // `navigator.clipboard` is *undefined* on a non-secure origin, and reading
    // `.writeText` off it throws synchronously — before any promise exists, so
    // the `.catch` below never runs and the button stays disabled on `复制中…`
    // forever. That is a worse dead end than the failure it was hiding: the
    // user is told the copy is in progress and it never finishes. So the
    // missing clipboard is answered here, as the same `failed` state a
    // rejection produces.
    const clipboard = navigator.clipboard as Clipboard | undefined;
    if (clipboard === undefined) {
      setCopyState({ id, state: 'failed' });
      return;
    }
    void clipboard
      .writeText(command)
      .then(() => setCopyState({ id, state: 'copied' }))
      .catch(() => setCopyState({ id, state: 'failed' }));
  }, []);

  /** The sentence the button shows, which is also the half its name carries. */
  const stateLabel = (state: 'idle' | 'copying' | 'copied' | 'failed'): string =>
    state === 'copying'
      ? t('diag.env.copying')
      : state === 'failed'
        ? t('diag.env.copyFailed')
        : state === 'copied'
          ? t('diag.env.copied')
          : t('diag.env.copy');

  return (
    <div className="card env-check">
      <h2>{t('diag.env.title')}</h2>
      <p className="muted">{t('diag.env.intro')}</p>
      {DEMO_BOUNDARIES.map((boundary) => {
        const state = copyState?.id === boundary.id ? copyState.state : 'idle';
        const commandId = `env-check-command-${boundary.id}`;
        const titleId = `env-check-title-${boundary.id}`;
        const label = stateLabel(state);
        return (
          <div className="env-check-item mt-3" key={boundary.id}>
            <div className="step-title" id={titleId}>
              {t(`diag.env.${boundary.id}`)}
            </div>
            <div className="row-gap mt-1">
              <div
                className="code grow"
                id={commandId}
                // Focusable and named, so the hint's "select the command" is
                // reachable without a mouse. `aria-readonly` is what makes the
                // textbox role honest: nothing here can be typed into.
                tabIndex={0}
                role="textbox"
                aria-readonly="true"
                aria-labelledby={titleId}
              >
                {boundary.command}
              </div>
              <button
                className="ghost"
                onClick={() => copy(boundary.id, boundary.command)}
                disabled={state === 'copying'}
                aria-label={
                  state === 'idle' ? t('diag.env.copy') : `${t('diag.env.copy')} — ${label}`
                }
                aria-describedby={commandId}
                title={boundary.command}
              >
                {label}
              </button>
            </div>
            {state === 'failed' ? (
              <div className="muted mt-1 env-check-hint" role="status">
                {t('diag.env.copyFailedHint')}
              </div>
            ) : null}
            <div className="muted mt-1 env-check-expected">{boundary.expected}</div>
            <div className="muted mt-1 env-check-who">{t(`diag.env.${boundary.id}.who`)}</div>
          </div>
        );
      })}
      <p className="muted mt-3">{t('diag.env.footnote')}</p>
    </div>
  );
}
