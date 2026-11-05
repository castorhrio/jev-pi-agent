import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nProvider } from '@renderer/i18n-context';
import { EnvSelfCheck } from '@renderer/components/EnvSelfCheck';
import { createFixtureApi } from '@renderer/dev/fixture-bridge';
import { DEMO_BOUNDARIES } from '../../apps/desktop/src/shared/demo-boundaries';
import { dictionaryFor } from '../../apps/desktop/src/shared/i18n';

/**
 * The copy button's failure state, and the two accessibility promises around it.
 *
 * ## Why this file exists
 *
 * `EnvSelfCheck` renders the three external blockers as commands a user can run
 * on their own machine. The command is long, so there is a copy button — and
 * `navigator.clipboard` is not always there: it is undefined on a non-secure
 * origin, and `writeText` can reject when the permission is refused. The old
 * failure state said `复制失败` and nothing else, which is a dead end: the user
 * is told the button did not work and nothing about what to do instead. The
 * command is right there on screen, but nothing said so.
 *
 * Two smaller things were wrong in the same corner, and both are invisible to
 * anyone using a mouse:
 *
 *  - the command block was a plain `<div>`, so it was not in the tab order. The
 *    fallback the hint offers ("select the command and copy it by hand") was
 *    mouse-only, which is exactly the user who cannot use the button either;
 *  - the button's `aria-label` was the static `复制命令` while the state lived
 *    only in the button's *text*. A screen reader re-focusing the button heard
 *    the same name before and after the click, so the one thing the button has
 *    to report — did it work — was the one thing not announced.
 *
 * ## What is asserted
 *
 *  - the failed state renders `diag.env.copyFailedHint` (read from the
 *    dictionary, not restated here) as a live region, so it is both visible and
 *    announced;
 *  - the hint is absent until something has actually failed — a permanent
 *    "copying may not work" line would be noise on every machine where it does;
 *  - the command block is focusable, is a read-only textbox, and is named by the
 *    sentence above it;
 *  - the button's accessible name carries the state, and still contains the
 *    visible text (WCAG 2.5.3), in all three non-idle states.
 *
 * ## What is deliberately not asserted
 *
 * That the clipboard really receives the command — that is the browser's job,
 * and the stub below is the whole of the environment. Nor the wording of the
 * hint: it is read out of the dictionary, so rewording it is a one-file change
 * and this file keeps checking that the *sentence the dictionary holds* is the
 * one on screen.
 */

const ZH = dictionaryFor('zh-CN');

/** The command block for a boundary, by the id the panel gives it. */
function commandBlock(id: string): HTMLElement {
  const el = document.getElementById(`env-check-command-${id}`);
  expect(el, `the panel renders no command block for \`${id}\``).not.toBeNull();
  return el as HTMLElement;
}

/**
 * Mount the panel with a clipboard that does what `outcome` says.
 *
 * `navigator.clipboard` is replaced rather than spied on: happy-dom's own
 * implementation is not what a non-secure origin has (it is `undefined` there),
 * and the failure this file is about is a rejected `writeText`, which no real
 * clipboard in a test can produce.
 */
function mount(outcome: 'resolve' | 'reject' | 'absent') {
  const fixture = createFixtureApi('default');
  (window as unknown as Record<string, unknown>).ucad = fixture.api;

  const written: string[] = [];
  if (outcome === 'absent') {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
  } else {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: (text: string) => {
          written.push(text);
          return outcome === 'resolve'
            ? Promise.resolve()
            : Promise.reject(new Error('clipboard unavailable'));
        },
      },
    });
  }

  const utils = render(
    <I18nProvider api={fixture.api}>
      <EnvSelfCheck />
    </I18nProvider>,
  );
  return { ...utils, written };
}

/** The copy button of the first block, found by the name it starts with. */
function copyButton(): HTMLElement {
  return screen.getAllByRole('button', { name: /复制命令/ })[0]!;
}

describe('the copy button, when copying is not available', () => {
  it('says what to do next, in the words the dictionary holds', async () => {
    const user = userEvent.setup();
    mount('reject');

    // Nothing has failed yet, so the hint is not on screen: a permanent
    // "copying may not work" line is noise on every machine where it does.
    expect(screen.queryByText(ZH['diag.env.copyFailedHint']!)).toBeNull();

    await user.click(copyButton());

    const hint = await screen.findByText(ZH['diag.env.copyFailedHint']!);
    expect(hint).toBeInTheDocument();
    // A live region, because the sentence appears *after* the click: without
    // one, a screen-reader user hears the button's new name and nothing else.
    expect(hint.getAttribute('role')).toBe('status');
    // And the button itself reports the failure, rather than only its text.
    expect(copyButton()).toHaveAccessibleName(/复制失败/);
  });

  it('offers the same next step when the clipboard is missing altogether', async () => {
    // The other shape of the same failure: `navigator.clipboard` is undefined on
    // a non-secure origin, so the call throws before any promise exists. The
    // user must land in the same place.
    const user = userEvent.setup();
    mount('absent');

    await user.click(copyButton());

    expect(await screen.findByText(ZH['diag.env.copyFailedHint']!)).toBeInTheDocument();
  });

  it('does not show the hint when the copy worked', async () => {
    // The red direction of the case above: a hint that is always rendered would
    // pass it while telling every user their clipboard is broken.
    const user = userEvent.setup();
    const { written } = mount('resolve');

    await user.click(copyButton());

    await waitFor(() => expect(copyButton()).toHaveAccessibleName(/已复制/));
    expect(screen.queryByText(ZH['diag.env.copyFailedHint']!)).toBeNull();
    expect(written).toEqual([DEMO_BOUNDARIES[0]!.command]);
  });
});

describe('the command block, for a user without a mouse', () => {
  it('is in the tab order and is announced as a read-only field', () => {
    mount('resolve');
    const block = commandBlock(DEMO_BOUNDARIES[0]!.id);

    // The hint says "select the command"; a plain div cannot be reached, so the
    // fallback it offers would be mouse-only.
    expect(block.getAttribute('tabindex')).toBe('0');
    expect(block.getAttribute('role')).toBe('textbox');
    expect(block.getAttribute('aria-readonly')).toBe('true');
    expect(block.textContent).toBe(DEMO_BOUNDARIES[0]!.command);

    block.focus();
    expect(document.activeElement, 'the command block cannot take focus').toBe(block);
  });

  it('is named by the sentence above it, so the announcement says which blocker', () => {
    mount('resolve');
    const block = commandBlock(DEMO_BOUNDARIES[0]!.id);
    // A read-only textbox with no name is announced as "text field, read only"
    // and nothing else — three of them in a row would be indistinguishable.
    expect(block).toHaveAccessibleName(ZH[`diag.env.${DEMO_BOUNDARIES[0]!.id}`]!);
  });

  it('gives every block its own name, rather than one shared label', () => {
    mount('resolve');
    const names = DEMO_BOUNDARIES.map((boundary) =>
      commandBlock(boundary.id).getAttribute('aria-labelledby'),
    );
    expect(new Set(names).size, 'two command blocks share one accessible name').toBe(
      DEMO_BOUNDARIES.length,
    );
  });
});

describe("the copy button's accessible name", () => {
  it('is the plain action while idle, with no dangling separator', () => {
    mount('resolve');
    expect(copyButton()).toHaveAccessibleName(ZH['diag.env.copy']!);
  });

  it('carries the state after the click, and still contains the visible text', async () => {
    // The defect this pins: the name was static, so re-focusing the button after
    // the click announced the same thing as before it. The visible text has to
    // stay inside the name as well (WCAG 2.5.3), or a speech-input user saying
    // what they see would not match the control.
    const user = userEvent.setup();
    mount('resolve');

    await user.click(copyButton());
    await waitFor(() => expect(copyButton()).toHaveAccessibleName(/已复制/));

    const name = copyButton().getAttribute('aria-label')!;
    const visible = copyButton().textContent!.trim();
    expect(name).toContain(visible);
    expect(name).toContain(ZH['diag.env.copy']!);
  });
});
