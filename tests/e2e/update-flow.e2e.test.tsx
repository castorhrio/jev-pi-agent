import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '@renderer/App';
import { createFixtureApi } from '@renderer/dev/fixture-bridge';
import type { UpdateStatus } from '@ucad/contracts';

/**
 * The update flow's buttons, and what they are called.
 *
 * Two defects shipped here, and neither of them was visible in a screenshot:
 *
 *  1. The download button in Settings had the label `—` — an em dash standing
 *     in for a word that was never written. The button did its job; nobody
 *     could tell what it did, and a screen-reader user heard "dash".
 *
 *  2. The banner's download button was labelled 检查更新 / "Check for updates"
 *     while calling `downloadUpdate()`. Clicking a button that says "check"
 *     and starting a download is exactly the sort of surprise a control plane
 *     should not spring on anyone.
 *
 * The fixture only ever answers `up-to-date`, so neither button was ever
 * rendered — the whole update surface was untested, which is why both defects
 * could sit there. This file drives the `available` state directly, so the
 * surface is now reachable by a test at all.
 *
 * The label and the action are asserted together on purpose. A button can be
 * named and still lie; what matters is that the name and the call agree.
 */

const AVAILABLE: UpdateStatus = {
  state: 'available',
  currentVersion: '1.0.0',
  latestVersion: '1.1.0',
  feedConfigured: true,
  checkedAt: '2026-10-25T10:00:00.000Z',
};

type Fixture = ReturnType<typeof createFixtureApi>;

/**
 * Mounts the real App against a fixture whose update check answers
 * "a new version is available".
 */
function mountWithUpdateAvailable() {
  const fixture: Fixture = createFixtureApi('default');
  const downloadUpdate = vi.fn(async (): Promise<UpdateStatus> => AVAILABLE);
  const api = {
    ...fixture.api,
    app: {
      ...fixture.api.app,
      updateStatus: async (): Promise<UpdateStatus> => AVAILABLE,
      checkUpdate: async (): Promise<UpdateStatus> => AVAILABLE,
      downloadUpdate,
    },
  };
  (window as unknown as Record<string, unknown>).ucad = api;
  return { ...render(<App />), downloadUpdate };
}

async function settle() {
  await waitFor(() => expect(screen.getAllByText(/jev-pi-agent/).length).toBeGreaterThan(0), {
    timeout: 5000,
  });
}

function nav(): HTMLElement {
  // Two `<nav>` elements exist (the rail and the preview's own), so the first
  // is the one carrying the surface buttons.
  return screen.getAllByRole('navigation')[0]!;
}

async function openSettings(user: ReturnType<typeof userEvent.setup>) {
  await user.click(within(nav()).getByRole('button', { name: /更多/ }));
  await user.click(await screen.findByRole('menuitem', { name: '设置' }));
  await screen.findByRole('heading', { level: 1, name: '设置' });
}

/**
 * The update card on the settings surface.
 *
 * The query is scoped to the card on purpose: the banner carries a button with
 * the same name, so an unscoped lookup would find two of them and fail on the
 * count rather than on the thing being tested.
 */
function updateCard(): HTMLElement {
  const heading = screen.getAllByRole('heading', { name: '更新' })[0];
  const card = heading?.closest('.card');
  if (card === null || card === undefined) throw new Error('update card not found');
  return card as HTMLElement;
}

describe('the update surface, when a new version exists', () => {
  it('names the banner action for what it does', async () => {
    mountWithUpdateAvailable();
    await settle();

    // The banner is the first thing a user meets when a release is out, and
    // its button starts the download. It must not say "check for updates":
    // that is a different action, and the one the user just performed.
    const banner = document.querySelector('.banner');
    expect(banner, 'the update banner is not shown when a version is available').not.toBeNull();

    const action = within(banner as HTMLElement).getByRole('button');
    expect(action.textContent?.trim()).toBe('下载更新');
    expect(action.textContent ?? '').not.toContain('检查更新');
  });

  it('names the settings action for what it does, and never leaves it blank', async () => {
    const user = userEvent.setup();
    mountWithUpdateAvailable();
    await settle();
    await openSettings(user);

    const card = updateCard();
    const download = within(card).getByRole('button', { name: '下载更新' });
    // A named button is the point; a bare `—` is what shipped.
    expect(download.textContent?.trim()).not.toBe('—');
    expect(download.textContent?.trim()).not.toBe('');

    // And the name has to match the action. This is the assertion that would
    // have caught the banner's "check for updates" label.
    expect(download.textContent ?? '').not.toContain('检查更新');
  });

  it('performs the download when the named button is pressed', async () => {
    const user = userEvent.setup();
    const { downloadUpdate } = mountWithUpdateAvailable();
    await settle();
    await openSettings(user);

    const download = within(updateCard()).getByRole('button', { name: '下载更新' });
    await user.click(download);

    await waitFor(() => expect(downloadUpdate).toHaveBeenCalledTimes(1));
  });
});
