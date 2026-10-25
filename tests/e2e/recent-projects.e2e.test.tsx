import { describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '@renderer/App';
import { createFixtureApi } from '@renderer/dev/fixture-bridge';
import type { WorkspaceDto } from '@ucad/contracts';

/**
 * Recent projects — the switcher, and what it offers on the row you are in.
 *
 * The surface exists because the session list is scoped to the open project, so
 * without it a user with two projects had a dead end. That makes the *actions*
 * the feature: a row that cannot be switched to is fine only when switching is
 * meaningless, and a row that says "current project" while offering "switch to
 * here" is a contradiction the user has to resolve by clicking and watching
 * nothing happen.
 */

type Fixture = ReturnType<typeof createFixtureApi>;

function mount(scenario: Parameters<typeof createFixtureApi>[0] = 'default') {
  const fixture: Fixture = createFixtureApi(scenario);
  (window as unknown as Record<string, unknown>).ucad = fixture.api;
  return { ...render(<App />), fixture };
}

async function settle() {
  await waitFor(() => expect(screen.getAllByText(/jev-pi-agent/).length).toBeGreaterThan(0), {
    timeout: 5000,
  });
}

/** Opens the recent-projects surface through the overflow menu, as a user does. */
async function openRecent(user: ReturnType<typeof userEvent.setup>) {
  const nav = screen.getAllByRole('navigation')[0]!;
  await user.click(within(nav).getByRole('button', { name: /更多/ }));
  await user.click(await screen.findByRole('menuitem', { name: '项目' }));
  await screen.findByText('最近打开的项目', { selector: 'h1' });
  // The heading renders before the list read resolves, so the rows have to be
  // awaited separately — asserting on the table straight after the heading is
  // a race that usually passes.
  await waitFor(() => expect(document.querySelector('.pane .card table.grid')).toBeTruthy());
}

/**
 * Points the panel at two projects: `open` (the one in use) and `other`.
 *
 * Both reads are stubbed because the seeded fixture has a single workspace and
 * an `activate` that ignores the id it was given. Leaving `activate` alone made
 * a switch to `other` report itself as a switch to `open`, which is exactly the
 * kind of fixture-shaped assertion that proves nothing about the app.
 */
async function withTwoProjects(fixture: Fixture) {
  const open = (await fixture.api.workspace.open()) as WorkspaceDto;
  const other: WorkspaceDto = {
    ...open,
    id: 'ws-2',
    name: 'other-project',
    path: 'C:/work/other-project',
  };
  const api = fixture.api.workspace as {
    listRecent: () => Promise<WorkspaceDto[]>;
    activate: (id: string) => Promise<WorkspaceDto>;
  };
  api.listRecent = () => Promise.resolve([other, open]);
  api.activate = (id) => Promise.resolve(id === other.id ? other : open);
  return { open, other };
}

/**
 * The recent-project row a workspace name sits in.
 *
 * Scoped to the panel's table: the open project's name also appears in the rail
 * chip and the title bar, so an unscoped `getByText` finds three of them.
 */
function rowFor(name: string): HTMLElement {
  const table = document.querySelector('.pane .card table.grid') as HTMLElement;
  return within(table).getByText(name).closest('tr') as HTMLElement;
}

describe('recent projects — the open project is a state, not an action', () => {
  it('marks the open project and disables its action instead of offering to switch to it', async () => {
    const user = userEvent.setup();
    mount();
    await settle();
    await openRecent(user);

    const row = rowFor('jev-pi-agent');
    expect(within(row).getByText('当前项目')).toBeTruthy();

    /*
     * The bug this asserts away: the row read `当前项目` on one line and
     * `切换到这里` on the next, in the accent-filled primary style. Clicking it
     * re-activated the workspace already in use and navigated the user off the
     * page — a primary control whose only observable effect was to take the
     * page away.
     */
    const action = within(row).getByRole('button', { name: '已打开' }) as HTMLButtonElement;
    expect(action.disabled).toBe(true);
    expect(within(row).queryByRole('button', { name: '切换到这里' })).toBeNull();
  });

  it('offers a real switch for a project that is not the open one', async () => {
    const user = userEvent.setup();
    const { fixture } = mount();
    await settle();

    // The seeded list holds only the open project, so the "other project" case
    // — the one the surface exists for — has to be constructed.
    await withTwoProjects(fixture);
    await openRecent(user);

    const otherRow = rowFor('other-project');
    // Not the open one, so no state badge and a genuine, enabled switch.
    expect(within(otherRow).queryByText('当前项目')).toBeNull();
    const action = within(otherRow).getByRole('button', { name: '切换到这里' }) as HTMLButtonElement;
    expect(action.disabled).toBe(false);

    // Exactly one enabled switch exists, and it is not on the open project.
    expect(screen.getAllByRole('button', { name: '切换到这里' })).toHaveLength(1);
    const openRow = rowFor('jev-pi-agent');
    expect(
      (within(openRow).getByRole('button', { name: '已打开' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('says which project it switched to', async () => {
    const user = userEvent.setup();
    const { fixture } = mount();
    await settle();

    await withTwoProjects(fixture);
    await openRecent(user);
    await user.click(within(rowFor('other-project')).getByRole('button', { name: '切换到这里' }));

    /*
     * Switching project drops the selected session and moves the user to the
     * conversation, so without the confirmation the page would simply change
     * under them with nothing saying why.
     *
     * This assertion is the reason the message moved out of the panel: the
     * panel set it in its own state and then navigated away, which unmounted
     * it before the notice could render. It was never on screen for a frame.
     */
    await waitFor(() => expect(screen.getByText(/已切换到「other-project」/)).toBeTruthy());
  });

  it('says which project is open when the click was superseded by a newer request', async () => {
    const user = userEvent.setup();
    const { fixture } = mount();
    await settle();

    await withTwoProjects(fixture);

    /*
     * The race this covers: the user clicks `other-project` while a newer
     * activation is already in flight. Main serialises the two and answers the
     * older request with the project that *is* in force — a third one, here —
     * plus `activation: 'superseded'` and `requestedWorkspaceId` naming what
     * was dropped. That contract is pinned in
     * `tests/contract/workspace-activation.test.ts`; what was missing was this
     * side of it.
     *
     * The panel navigates on the answered DTO, so consuming it as "the project
     * you clicked is now open" would show a confident confirmation naming the
     * wrong project — the user clicks A, lands in B, and is told it worked.
     */
    const third: WorkspaceDto = {
      ...(await fixture.api.workspace.open()),
      id: 'ws-3',
      name: 'winner-project',
      path: 'C:/work/winner-project',
    };
    const api = fixture.api.workspace as {
      activate: (id: string) => Promise<unknown>;
    };
    api.activate = (id: string) =>
      Promise.resolve({ ...third, activation: 'superseded', requestedWorkspaceId: id });

    await openRecent(user);
    await user.click(within(rowFor('other-project')).getByRole('button', { name: '切换到这里' }));

    // The notice names both projects: the one that is open and the one whose
    // request was dropped. Without the second name the user only learns they
    // are somewhere they did not ask for.
    await waitFor(() =>
      expect(screen.getByText(/你点的「other-project」没有生效/)).toBeTruthy(),
    );
    expect(screen.getByText(/先把「winner-project」加载了/)).toBeTruthy();

    // And it is not passed off as a plain success.
    expect(screen.queryByText('已切换到「other-project」。')).toBeNull();
    expect(screen.queryByText('已切换到「winner-project」。')).toBeNull();
  });
});
