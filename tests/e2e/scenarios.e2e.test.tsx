import { describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '@renderer/App';
import { createFixtureApi } from '@renderer/dev/fixture-bridge';
import { createTranslator } from '../../apps/desktop/src/shared/i18n';

/**
 * Step 6 of `docs/manual-verification.md`, as a gate: the five interface states.
 *
 * The checklist asks a person to open `?scenario=empty|loading|error|partial|permission`
 * in `npm run dev:web` and answer four questions — is it blank, does a failure
 * carry its reason, does the loading state pretend to be finished, and can the
 * permission prompt be read before deciding. Those four questions had **no
 * automated answer at all**: the fixture was covered by
 * `tests/contract/fixture-bridge.test.ts` (does it implement every method) and
 * the happy path by `critical-path.e2e.test.tsx`, but nothing asserted what the
 * five states actually put on screen. A state that renders a blank panel, or
 * that renders "还没有对话" while the read is still in flight, was green.
 *
 * This file is the automatable half of step 6. It does not replace the human
 * walkthrough — a DOM cannot tell you whether the empty state *looks* like a
 * first run — but it does mean the four claims are checked on every run instead
 * of once by hand.
 *
 * The fifth state also caught a harness defect while this was written:
 * `permissions.respond` returned success and emitted nothing, so the dialog
 * stayed on screen after 拒绝 was clicked. The fixture now emits
 * `permission.resolved`, which is what the real host does and what
 * `usePermissionQueue` waits for; the last test here pins it.
 */

type Fixture = ReturnType<typeof createFixtureApi>;

const t = createTranslator('zh-CN');

function mount(scenario: Parameters<typeof createFixtureApi>[0]) {
  const fixture: Fixture = createFixtureApi(scenario);
  (window as unknown as Record<string, unknown>).ucad = fixture.api;
  return { ...render(<App />), fixture };
}

/**
 * The rail's session column, so assertions cannot match the chat pane.
 *
 * It is an `<aside aria-label="会话与文件">`, i.e. the `complementary`
 * landmark — not a `<nav>`. The first version of this helper grabbed
 * `getAllByRole('navigation')[0]`, which is the *surface tab strip* ("对话 /
 * 文件 / 变更 / 上下文"), so every rail assertion was really reading the tab
 * bar and failed for the wrong reason. Scoping by the landmark's own label is
 * what makes "the rail says X" mean the rail.
 */
function rail(): HTMLElement {
  return screen.getByRole('complementary', { name: t('rail.landmark') });
}

describe('step 6 · empty — a first run is not a blank page', () => {
  it('says what to do next instead of rendering nothing', async () => {
    mount('empty');

    // The lead and the three steps are the whole point of the state: a first
    // run that renders an empty conversation is indistinguishable from a
    // broken one.
    expect(await screen.findByText(t('empty.chat'))).toBeTruthy();
    expect(screen.getByText(t('empty.chatSteps'))).toBeTruthy();
    for (const step of ['empty.chatStep1', 'empty.chatStep2', 'empty.chatStep3'] as const) {
      expect(screen.getByText(t(step)), `${step} is missing from the first-run screen`).toBeTruthy();
    }

    // And the rail explains why there are no sessions rather than showing an
    // empty list: "no project" and "no sessions" are different facts.
    expect(within(rail()).getByText(t('empty.sessionsNoWorkspace'))).toBeTruthy();

    // Nothing is still loading, so nothing may say it is.
    expect(screen.queryByText(t('common.loading'))).toBeNull();
  });
});

describe('step 6 · loading — the loading state does not pretend to be finished', () => {
  it('says 加载中 while reads are in flight, and does not claim the conversation is empty', async () => {
    const { fixture } = mount('loading');

    // Photograph the frame *while* the reads are in flight. Waiting for the
    // app to settle would measure the loaded state and prove nothing.
    await waitFor(() => expect(fixture.pending()).toBeGreaterThan(0), { timeout: 5000 });

    // Both the rail and the conversation say they are loading.
    await waitFor(() => expect(within(rail()).getByText(t('common.loading'))).toBeTruthy());
    expect(screen.getAllByText(t('common.loading')).length).toBeGreaterThan(1);

    // The lie this test exists for: an unarrived history rendered as
    // "还没有对话". A loading window that says that is a confident false
    // statement about data that has not been read yet.
    expect(screen.queryByText(t('empty.chat'))).toBeNull();
    expect(within(rail()).queryByText(t('empty.sessions'))).toBeNull();
  });
});

describe('step 6 · error — a failure carries its reason', () => {
  it('shows the original error text, not an empty panel', async () => {
    mount('error');

    expect(await screen.findByText(t('error.title'))).toBeTruthy();
    // The reason, verbatim: the fixture's own message, which is what a real
    // rejection would carry. "出错了" alone would send the reader nowhere.
    expect(screen.getByText(/\[fixture:error\] workspace\.listRecent failed/)).toBeTruthy();
    // And a way out.
    expect(screen.getByRole('button', { name: t('error.retry') })).toBeTruthy();
  });

  it('says what to do next, above the buttons it is talking about', async () => {
    // The fourth `error` criterion in `docs/state-walkthrough.md` asks whether
    // this screen "说得出下一步", and the answer has to be readable off the
    // screen rather than inferred from three bare verbs. Order is the whole
    // claim: the same sentence *below* the buttons explains a choice already
    // made, so this asserts position, not presence.
    mount('error');

    const next = await screen.findByText(t('error.fatalNext'));
    const retry = screen.getByRole('button', { name: t('error.retry') });
    expect(
      next.compareDocumentPosition(retry) & Node.DOCUMENT_POSITION_FOLLOWING,
      'the next-step sentence sits after the buttons it describes',
    ).toBeTruthy();
  });
});

describe('step 6 · partial — one subsystem down, the rest still usable', () => {
  it('keeps the healthy panels and names the failed one', async () => {
    mount('partial');

    // The workspace read succeeded, so the project is on screen.
    await waitFor(() => expect(screen.getAllByText(/jev-pi-agent/).length).toBeGreaterThan(0));

    // The sessions read failed, and the rail says so with the reason instead
    // of rendering an empty list — the realistic failure this scenario exists
    // to show.
    // The heading and the reason are two elements (`.rail-note` and
    // `.rail-note-detail`), so the assertion reads the rail's text rather than
    // one node's — a heading alone would pass while the reason was dropped.
    await waitFor(() => expect(within(rail()).getByText(t('sessions.loadFailed'))).toBeTruthy());
    expect(rail().textContent).toContain('[fixture:partial] sessions.list failed');
    expect(within(rail()).queryByText(t('empty.sessions'))).toBeNull();
  });
});

describe('step 6 · permission — the prompt can be read before deciding', () => {
  it('names the category, risk, resource, command and reason, and the answer takes effect', async () => {
    const user = userEvent.setup();
    const { fixture } = mount('permission');

    const dialog = await screen.findByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    // Named, so a screen reader announces what is being asked.
    const titleId = dialog.getAttribute('aria-labelledby');
    expect(titleId).toBeTruthy();
    expect(document.getElementById(titleId as string)?.textContent).toBe(t('permission.title'));

    // What is being requested, in the user's words — not just "an agent wants
    // permission". These five are the fixture's request, verbatim.
    const body = dialog.textContent ?? '';
    for (const expected of ['SHELL', 'high', 'C:/work/jev-pi-agent', 'rm -rf build', '清理构建产物']) {
      expect(body, `the prompt does not say ${expected}`).toContain(expected);
    }

    // All four answers are offered, and 拒绝 is one of them.
    for (const key of [
      'permission.allow_once',
      'permission.allow_session',
      'permission.allow_workspace',
      'permission.deny',
    ] as const) {
      expect(within(dialog).getByRole('button', { name: t(key) })).toBeTruthy();
    }

    await user.click(within(dialog).getByRole('button', { name: t('permission.deny') }));

    // The dialog closes because the decision reached the event log — the
    // fixture used to accept the click and emit nothing, which left the prompt
    // on screen forever.
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const log = await fixture.api.events.since({ sessionId: 'sess-1', afterSeq: 0 });
    const resolved = log.filter((event) => event.type === 'permission.resolved');
    expect(resolved).toHaveLength(1);
    expect((resolved[0]!.payload as { requestId: string; decision: string }).requestId).toBe('req-1');
    expect((resolved[0]!.payload as { decision: string }).decision).toBe('deny');
  });

  it('really revokes a rule, so the panel re-read shows it gone', async () => {
    const { fixture } = mount('permission');
    expect(await fixture.api.permissions.listRules()).toHaveLength(1);
    await fixture.api.permissions.revokeRule('rule-1');
    expect(await fixture.api.permissions.listRules()).toHaveLength(0);
  });
});
