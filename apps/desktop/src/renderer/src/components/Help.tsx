import { useMemo } from 'react';
import { DEMO_BOUNDARIES } from '../../../shared/demo-boundaries';
import { useT } from '../i18n-context';

/**
 * Quick Start.
 *
 * The complaint this answers is "I opened the app and did not know what to do".
 * So it leads with the state the user is actually in — the three steps are
 * checked off as they become true — and defers the concepts to the bottom, where
 * they are useful rather than blocking.
 */
export function HelpPanel({
  onOpenProject,
  onNewSession,
  onOpenSettings,
  hasWorkspace,
  hasSession,
}: {
  onOpenProject: () => void;
  onNewSession: () => void;
  onOpenSettings: () => void;
  hasWorkspace: boolean;
  hasSession: boolean;
}): JSX.Element {
  const t = useT();

  const shortcuts = useMemo(
    () => [
      { keys: 'Ctrl / ⌘ + O', label: t('menu.file.openProject') },
      { keys: 'Ctrl / ⌘ + N', label: t('session.new') },
      { keys: 'Ctrl / ⌘ + Enter', label: t('composer.send') },
      { keys: 'Esc', label: t('help.sc.stop') },
      { keys: 'Ctrl / ⌘ + L', label: t('help.sc.composer') },
      { keys: 'Ctrl / ⌘ + K', label: t('tab.explorer') },
      { keys: 'Ctrl / ⌘ + U', label: t('menu.help.checkUpdate') },
      { keys: 'F1', label: t('menu.help.quickStart') },
    ],
    [t],
  );

  const stepState = (n: number): string =>
    n === 1 ? (hasWorkspace ? 'done' : 'current') : n === 2 ? (hasSession ? 'done' : hasWorkspace ? 'current' : '') : '';

  return (
    <div className="pane">
      <div className="pane-head">
        <h1>{t('help.title')}</h1>
        <p>{t('help.subtitle')}</p>
      </div>

      <div className="steps">
        <div className={`step ${stepState(1)}`}>
          <div className="step-n">{hasWorkspace ? '✓' : '1'}</div>
          <div className="grow">
            <div className="step-title">{t('welcome.step1')}</div>
            <div className="muted">{t('welcome.step1Hint')}</div>
            {!hasWorkspace && (
              <button className="primary mt-2" onClick={onOpenProject}>
                {t('welcome.open')}
              </button>
            )}
          </div>
        </div>

        <div className={`step ${stepState(2)}`}>
          <div className="step-n">{hasSession ? '✓' : '2'}</div>
          <div className="grow">
            <div className="step-title">{t('welcome.step2')}</div>
            <div className="muted">{t('welcome.step2Hint')}</div>
            {hasWorkspace && !hasSession && (
              <button className="mt-2" onClick={onNewSession}>
                {t('session.new')}
              </button>
            )}
          </div>
        </div>

        <div className="step">
          <div className="step-n">3</div>
          <div className="grow">
            <div className="step-title">{t('welcome.step3')}</div>
            <div className="muted">{t('welcome.step3Hint')}</div>
          </div>
        </div>
      </div>

      <div className="card">
        <h2>{t('help.shortcuts')}</h2>
        <div className="defs">
          {shortcuts.map((entry) => (
            <div className="def" key={entry.keys}>
              <span className="k">
                <kbd>{entry.keys}</kbd>
              </span>
              <span className="v" style={{ textAlign: 'left' }}>
                {entry.label}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <h2>{t('help.whatIsContext')}</h2>
        <p className="muted">
          {t('help.whatIsContextBody')}
        </p>
      </div>

      <div className="card">
        <h2>{t('help.whatIsDecision')}</h2>
        <p className="muted">
          {t('help.whatIsDecisionBody')}
        </p>
      </div>

      {/*
        The three external blockers, on screen.

        `docs/demo-script.md` answers "did you run it on a real machine?" with
        three offline commands and the line each one prints. That page is read
        before the demo; this card is what is open *during* it. The commands and
        the expected lines come from `shared/demo-boundaries.ts` — one list, read
        by the page's gate and by this panel — so the two cannot drift into
        quoting different commands. The sentence above each command is prose and
        lives in the dictionary, in both locales.
      */}
      <div className="card">
        <h2>{t('help.boundary.title')}</h2>
        <p className="muted">{t('help.boundary.intro')}</p>
        {DEMO_BOUNDARIES.map((boundary) => (
          <div className="mt-3" key={boundary.id}>
            <div className="step-title">{t(`help.boundary.${boundary.id}`)}</div>
            <div className="code mt-1">{boundary.command}</div>
            <div className="muted mt-1">{boundary.expected}</div>
          </div>
        ))}
        <p className="muted mt-3">{t('help.boundary.footnote')}</p>
      </div>

      <div className="card">
        <h2>{t('settings.title')}</h2>
        <button onClick={onOpenSettings}>{t('settings.title')}</button>
      </div>
    </div>
  );
}
