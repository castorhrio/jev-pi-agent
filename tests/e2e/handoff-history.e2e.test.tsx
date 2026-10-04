import { describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '@renderer/App';
import { createFixtureApi } from '@renderer/dev/fixture-bridge';
import type { UcadApi } from '@ucad/contracts';

/**
 * The handoff history, in a DOM.
 *
 * RESEARCH §2 pairs supersede-not-delete with a claim protocol. The store
 * enforces both (tests/contract/handoff-chain.test.ts); this file is about
 * whether a user can actually *see* the result. Two reasons that is not
 * automatic:
 *
 *  - a store capability nothing renders is dead code, and
 *  - the claim state is the whole point of the feature. A handoff that looks
 *    identical whether or not another agent has taken it communicates nothing,
 *    and "someone else is already on this" is exactly what a user needs to
 *    avoid colliding with.
 */

type Fixture = ReturnType<typeof createFixtureApi>;

function mount(scenario: Parameters<typeof createFixtureApi>[0] = 'default') {
  const fixture: Fixture = createFixtureApi(scenario);
  (window as unknown as Record<string, unknown>).ucad = fixture.api;
  return { ...render(<App />), api: fixture.api as UcadApi };
}

async function settle() {
  await waitFor(() => expect(screen.getAllByText(/jev-pi-agent/).length).toBeGreaterThan(0), {
    timeout: 5000,
  });
}

function nav() {
  return screen.getAllByRole('navigation')[0]!;
}

/**
 * Opens the handoff surface and generates a handoff for the seeded session.
 *
 * This waits only for the handoff *document*. The history is a second read that
 * happens after the write resolves, so it lands a tick later — tests that care
 * about it must await `waitForHistory()` rather than assume it is already
 * there. Asserting on it straight after this helper is a race, and a race that
 * usually passes is worse than no test.
 *
 * The wait used to be `findByText(/修复注入哈希不一致/)`, on the assumption that
 * the seeded handoff's objective appears only in the handoff panel. It does
 * not: that string is also the **session title in the rail**, so the helper
 * returned while the panel was still showing its empty state — and every test
 * built on it was asserting against a panel that had not rendered yet. The
 * regenerate button exists only once a handoff is on screen, so it is the
 * honest signal.
 */
async function openHandoff(user: ReturnType<typeof userEvent.setup>) {
  await user.click(within(nav()).getByRole('button', { name: /更多/ }));
  await user.click(await screen.findByRole('menuitem', { name: '交接' }));
  await screen.findByText('交接摘要', { selector: 'h1' });
  await user.click(screen.getByRole('button', { name: '生成交接摘要' }));
  await screen.findByRole('button', { name: '重新生成' });
}

/** Waits for the chain read that follows the handoff write. */
async function waitForHistory() {
  return screen.findByText('交接历史');
}

describe('handoff history (RESEARCH §2 supersede-not-delete)', () => {
  it('shows the chain with each entry’s claim state', async () => {
    const user = userEvent.setup();
    mount();
    await settle();
    await openHandoff(user);
    await waitForHistory();

    await screen.findByText('交接历史');

    // Newest first, contiguous sequence numbers.
    expect(screen.getByText('#3')).toBeTruthy();
    expect(screen.getByText('#2')).toBeTruthy();
    expect(screen.getByText('#1')).toBeTruthy();

    // The three lifecycle states are all rendered, each with its own wording.
    expect(screen.getByText('无人认领')).toBeTruthy();
    expect(screen.getByText('认领中')).toBeTruthy();
    expect(screen.getByText('已完成')).toBeTruthy();
  });

  it('names who claimed a handoff, so two agents cannot silently collide', async () => {
    const user = userEvent.setup();
    mount();
    await settle();
    await openHandoff(user);
    await waitForHistory();

    // The claimed entry must say who holds it. A bare "claimed" badge does
    // not tell the reader whether that is them.
    expect(screen.getAllByText('由 universal 认领').length).toBe(2);
  });

  it('marks superseded entries as still readable rather than hiding them', async () => {
    const user = userEvent.setup();
    mount();
    await settle();
    await openHandoff(user);
    await waitForHistory();

    // The two older entries were replaced but must not disappear — that is
    // the difference between "superseded" and "deleted".
    expect(screen.getAllByText('已被更新的取代')).toHaveLength(2);
  });

  it('hides the history block when there is only one handoff', async () => {
    const user = userEvent.setup();
    mount();
    await settle();

    await user.click(within(nav()).getByRole('button', { name: /更多/ }));
    await user.click(await screen.findByRole('menuitem', { name: '交接' }));
    await screen.findByText('交接摘要', { selector: 'h1' });

    // Before generating anything there is no chain to describe. An empty
    // "交接历史" heading would be a section with nothing in it.
    expect(screen.queryByText('交接历史')).toBeNull();
    expect(screen.getByText(/还没有交接摘要/)).toBeTruthy();
  });

  it('does not blank the handoff when the chain read fails', async () => {
    const user = userEvent.setup();
    const fixture: Fixture = createFixtureApi('default');
    // The document is the product; the history is an addition to it. A
    // failing history read must not take the handoff down with it.
    (fixture.api.sessions as { listHandoffs: () => Promise<never> }).listHandoffs = () =>
      Promise.reject(new Error('history unavailable'));
    (window as unknown as Record<string, unknown>).ucad = fixture.api;
    render(<App />);
    await settle();
    await openHandoff(user);

    // Scoped to the handoff document, and that is not pedantry: the seeded
    // objective is also the session title in the rail, so an unscoped
    // `getByText` matches twice once the helper waits properly. "The handoff
    // still rendered" is a claim about the document, not about the sidebar.
    const doc = document.querySelector('.handoff-doc') as HTMLElement;
    expect(doc).toBeTruthy();
    expect(within(doc).getByText(/修复注入哈希不一致/)).toBeTruthy();
    expect(screen.queryByText('交接历史')).toBeNull();
  });
});

/**
 * The claim handshake has to be reachable, not just implemented.
 *
 * A store method no user can invoke is dead code, and the refusal rule is the
 * part that most needs exercising: "someone else already has this" is
 * information, and the panel has to show it rather than swallow it.
 */
describe('handoff claim handshake', () => {
  it('offers a claim action on the newest unclaimed handoff', async () => {
    const user = userEvent.setup();
    mount();
    await settle();
    await openHandoff(user);
    await waitForHistory();

    expect(screen.getByRole('button', { name: '我来接手' })).toBeTruthy();
  });

  it('claims the handoff and shows who holds it', async () => {
    const user = userEvent.setup();
    mount();
    await settle();
    await openHandoff(user);
    await waitForHistory();

    await user.click(screen.getByRole('button', { name: '我来接手' }));

    // The button is replaced by the completion action, and the chain now
    // names the holder. The panel must show the stored state, not an
    // optimistic local guess.
    await waitFor(() => expect(screen.getByRole('button', { name: '标记完成' })).toBeTruthy());
    expect(screen.queryByRole('button', { name: '我来接手' })).toBeNull();
  });

  it('completes a claimed handoff', async () => {
    const user = userEvent.setup();
    mount();
    await settle();
    await openHandoff(user);
    await waitForHistory();

    await user.click(screen.getByRole('button', { name: '我来接手' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '标记完成' })).toBeTruthy());
    await user.click(screen.getByRole('button', { name: '标记完成' }));

    // Done: no claim or complete action remains, because there is nothing
    // left to do to it.
    await waitFor(() => expect(screen.queryByRole('button', { name: '标记完成' })).toBeNull());
    expect(screen.queryByRole('button', { name: '我来接手' })).toBeNull();
  });

  it('never offers an action on a superseded handoff', async () => {
    const user = userEvent.setup();
    mount();
    await settle();
    await openHandoff(user);
    await waitForHistory();

    // Two entries are superseded. Offering 认领 there would be offering to
    // take ownership of work that has already been replaced — and the store
    // would happily allow it, because it does not know about the UI's intent.
    const superseded = screen.getAllByText('已被更新的取代');
    expect(superseded).toHaveLength(2);
    for (const node of superseded) {
      const row = node.closest('.row-gap');
      expect(within(row as HTMLElement).queryByRole('button')).toBeNull();
    }
    // Exactly one claim action exists, for the newest entry.
    expect(screen.getAllByRole('button', { name: '我来接手' })).toHaveLength(1);
  });

  it('surfaces a refusal instead of swallowing it', async () => {
    const user = userEvent.setup();
    const fixture: Fixture = createFixtureApi('default');
    // Reject outright rather than delegating first: a refusal means the claim
    // did **not** happen, so the entry must still read as unclaimed afterwards.
    // Delegating and then throwing would mutate the chain and the test would
    // assert the wrong thing.
    (fixture.api.sessions as { claimHandoff: unknown }).claimHandoff = () =>
      Promise.reject(new Error('handoff hnd-3 is already claimed by another-agent'));
    (window as unknown as Record<string, unknown>).ucad = fixture.api;
    render(<App />);
    await settle();
    await openHandoff(user);
    await waitForHistory();

    await user.click(screen.getByRole('button', { name: '我来接手' }));

    // The failure is reported, and the panel still re-reads the truth rather
    // than assuming the click worked.
    await waitFor(() =>
      expect(screen.getByText(/already claimed by another-agent/)).toBeTruthy(),
    );
    expect(screen.queryByRole('button', { name: '我来接手' })).toBeTruthy();
  });
});

/**
 * What a handoff carries into the next session.
 *
 * This is the product's first metric made concrete: after
 * switching agents, the user should not have to re-explain the architecture,
 * the failed attempts or the open questions). The button used to carry the
 * objective and nothing else, so the decisions, the failed commands and the
 * pending work were all dropped on the floor — the feature's own reason for
 * existing, half used.
 *
 * The picker is therefore the feature, not a nicety on it: what is *not*
 * ticked must genuinely not appear in the composer, and what is ticked must
 * appear. Asserting the presence of checkboxes would prove nothing; the
 * assertions below read the composer's text.
 */
describe('carrying a handoff into the next session', () => {
  function composer(): HTMLTextAreaElement {
    return screen.getByPlaceholderText(/描述任务/) as HTMLTextAreaElement;
  }

  it('offers a checkbox per section that has content, and nothing empty', async () => {
    const user = userEvent.setup();
    mount();
    await settle();
    await openHandoff(user);

    const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
    expect(boxes.length).toBeGreaterThan(1);
    // Default: everything with content is carried, because the promise is
    // "you do not have to re-explain yourself".
    expect(boxes.every((box) => box.checked)).toBe(true);
  });

  it('carries the decisions and the open work, not only the objective', async () => {
    const user = userEvent.setup();
    mount();
    await settle();
    await openHandoff(user);

    await user.click(screen.getByRole('button', { name: '带着它开新会话' }));

    // The composer now holds a document, not a sentence.
    const text = composer().value;
    expect(text).toContain('修复注入哈希不一致');
    // The seeded handoff records these; if they are missing, the next agent is
    // being asked to redo work this session already did.
    expect(text).toMatch(/renderContextPack|renderedHash/);
  });

  it('leaves out exactly what was unticked', async () => {
    const user = userEvent.setup();
    mount();
    await settle();
    await openHandoff(user);

    // Untick the first section, then carry the rest.
    const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
    const firstLabel = boxes[0]!.closest('label')?.textContent ?? '';
    await user.click(boxes[0]!);
    expect(boxes[0]!.checked).toBe(false);

    await user.click(screen.getByRole('button', { name: '带着它开新会话' }));
    const text = composer().value;
    expect(text).not.toContain(`## ${firstLabel}`);
    // And the sections that were left ticked are still there.
    expect(text).toContain('## ');
  });

  it('refuses to carry nothing rather than pretending it carried something', async () => {
    const user = userEvent.setup();
    mount();
    await settle();
    await openHandoff(user);

    const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
    for (const box of boxes) await user.click(box);

    // A handoff with no sections is a document with a title and no content, and
    // the button that produces it is disabled so the user is told why.
    const button = screen.getByRole('button', { name: '带着它开新会话' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText(/不会带过去任何东西/)).toBeTruthy();
  });
});
