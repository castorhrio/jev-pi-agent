import { describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '@renderer/App';
import { createFixtureApi } from '@renderer/dev/fixture-bridge';

/**
 * Workspace trust — the control has to fail out loud.
 *
 * §10 makes trust a decision the user makes once and can revoke. That framing
 * is what makes a *silent* failure unacceptable here: the trust state gates
 * file writes and command execution, so a change the user believes they made
 * but did not is a permission decision they did not actually take.
 *
 * The panel always said so in a comment. The code did the opposite — it caught
 * the rejection, called `setEntries((prev) => prev)` (a no-op), and rethrew;
 * both call sites invoke it as `void setTrust(...)`, so the rejection had no
 * handler. Measured in a real browser with the write failing: the state
 * correctly did not change, nothing was shown to the user, and the only trace
 * was an unhandled rejection in the console.
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

async function openExplorer(user: ReturnType<typeof userEvent.setup>) {
  const nav = screen.getAllByRole('navigation')[0]!;
  await user.click(within(nav).getByRole('button', { name: /^文件/ }));
  await screen.findByText('项目信任', { selector: 'h2' });
}

/** The trust card, so assertions cannot match the rail's trust badge instead. */
function trustCard(): HTMLElement {
  return screen.getByText('项目信任', { selector: 'h2' }).closest('.card') as HTMLElement;
}

describe('workspace trust — a failed change is reported, not swallowed', () => {
  it('says the state did not change, and keeps showing the state that is real', async () => {
    const user = userEvent.setup();
    const { fixture } = mount();
    await settle();
    await openExplorer(user);

    // The fixture workspace is trusted; make the write fail the way a
    // read-only config or a locked vault would.
    (fixture.api.workspace as { setTrust: unknown }).setTrust = () =>
      Promise.reject(new Error('EACCES: trust config is read-only'));
    await user.click(within(trustCard()).getByRole('button', { name: '受限' }));

    // Reported, with the reason, in words that say the change did not land.
    const notice = await screen.findByText(/信任状态没有改变/);
    expect(notice.textContent).toContain('EACCES: trust config is read-only');

    // And the card still shows the trust state that is actually in force.
    // Marking "受限" as selected on a failed write would be the lie.
    expect((within(trustCard()).getByRole('button', { name: '信任' }) as HTMLButtonElement).className)
      .toContain('primary');
    expect(
      (within(trustCard()).getByRole('button', { name: '受限' }) as HTMLButtonElement).className,
    ).not.toContain('primary');
  });

  it('clears the failure once a later attempt succeeds', async () => {
    const user = userEvent.setup();
    const { fixture } = mount();
    await settle();
    await openExplorer(user);

    const api = fixture.api.workspace as { setTrust: (next: string) => Promise<unknown> };
    let fail = true;
    const real = api.setTrust.bind(fixture.api.workspace);
    api.setTrust = (next: string) => {
      if (fail) return Promise.reject(new Error('EACCES: trust config is read-only'));
      return real(next);
    };

    await user.click(within(trustCard()).getByRole('button', { name: '受限' }));
    await screen.findByText(/信任状态没有改变/);

    // A stale error left on screen after a successful retry would be its own
    // kind of lie — the user would think the second attempt failed too.
    fail = false;
    await user.click(within(trustCard()).getByRole('button', { name: '受限' }));
    await waitFor(() => expect(screen.queryByText(/信任状态没有改变/)).toBeNull());
  });
});
