import { useCallback, useState } from 'react';
import { DEMO_BOUNDARIES } from '../../../shared/demo-boundaries';
import { useT } from '../i18n-context';

/**
 * The three external blockers, as something the user can run.
 *
 * ## Why this is on Diagnostics and not on Help
 *
 * It used to be a card on the Help page, titled 本次演示的边界, and the title was
 * the problem: Help answers "where do I start", and this block answered "what
 * is the state of this machine right now". A user who opened Help to learn the
 * shortcuts got three paragraphs about our release paperwork instead, phrased
 * as an account of what we had not done yet. That is an internal ledger on a
 * user-facing page.
 *
 * Diagnostics is where a user already goes to ask what is true right now, and
 * the same three blocks read differently there: not "we have not run this", but
 * "here is a command you can run, and here is the line it prints". The tone
 * change is the point of the move — the commands and the expected lines are
 * unchanged, because they are the scripts' own output.
 *
 * ## What is deliberately not here
 *
 * The commands and the expected lines. They live in
 * `apps/desktop/src/shared/demo-boundaries.ts`, which is also what
 * `docs/demo-script.md` is compared against by
 * `tests/contract/demo-boundaries.test.ts` — one list, two readers. A copy here
 * would let the page and the screen quote different commands while every gate
 * stayed green.
 *
 * Nor is the *reason* each blocker is open: that is `docs/blockers.md`, and a
 * panel that restated it would be a third copy of a fact with two homes.
 *
 * ## The copy button
 *
 * The commands are long enough that retyping one from a screenshot is a way to
 * get a different command. `navigator.clipboard` is unavailable on a non-secure
 * origin, so a failed copy says so instead of silently doing nothing — the same
 * three-state handling `ContextDrawer` uses for the rendered bytes.
 */
export function EnvSelfCheck(): JSX.Element {
  const t = useT();
  const [copied, setCopied] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  const copy = useCallback((id: string, command: string) => {
    void navigator.clipboard
      .writeText(command)
      .then(() => {
        setCopied(id);
        setFailed(null);
      })
      .catch(() => {
        setFailed(id);
        setCopied(null);
      });
  }, []);

  return (
    <div className="card env-check">
      <h2>{t('diag.env.title')}</h2>
      <p className="muted">{t('diag.env.intro')}</p>
      {DEMO_BOUNDARIES.map((boundary) => (
        <div className="env-check-item mt-3" key={boundary.id}>
          <div className="step-title">{t(`diag.env.${boundary.id}`)}</div>
          <div className="row-gap mt-1">
            <div className="code grow">{boundary.command}</div>
            <button
              className="ghost"
              onClick={() => copy(boundary.id, boundary.command)}
              aria-label={`${t('diag.env.copy')}: ${boundary.command}`}
            >
              {failed === boundary.id
                ? t('diag.env.copyFailed')
                : copied === boundary.id
                  ? t('diag.env.copied')
                  : t('diag.env.copy')}
            </button>
          </div>
          <div className="muted mt-1 env-check-expected">{boundary.expected}</div>
        </div>
      ))}
      <p className="muted mt-3">{t('diag.env.footnote')}</p>
    </div>
  );
}
