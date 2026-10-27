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
 * Mounts the real App against a fixture whose update status is `status`.
 */
function mountWithUpdateStatus(status: UpdateStatus) {
  const fixture: Fixture = createFixtureApi('default');
  const downloadUpdate = vi.fn(async (): Promise<UpdateStatus> => status);
  const api = {
    ...fixture.api,
    app: {
      ...fixture.api.app,
      updateStatus: async (): Promise<UpdateStatus> => status,
      checkUpdate: async (): Promise<UpdateStatus> => status,
      downloadUpdate,
    },
  };
  (window as unknown as Record<string, unknown>).ucad = api;
  return { ...render(<App />), downloadUpdate };
}

/**
 * Mounts the real App against a fixture whose update check answers
 * "a new version is available".
 */
function mountWithUpdateAvailable() {
  return mountWithUpdateStatus(AVAILABLE);
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

describe('the update surface, when no feed is configured', () => {
  it('says so instead of reporting nothing to do', async () => {
    // README, both languages: "With no feed the app says so rather than failing
    // quietly" / "没有配置时应用会直说，而不是静默失败". The service answers
    // `unsupported`; this is the surface where a person reads the sentence, so
    // the assertion is on the rendered card rather than on the status object.
    const user = userEvent.setup();
    mountWithUpdateStatus({
      state: 'unsupported',
      currentVersion: '1.0.0',
      feedConfigured: false,
    });
    await settle();
    await openSettings(user);

    expect(await within(updateCard()).findByText('未配置更新源')).toBeTruthy();
  });
});

/**
 * The Settings card is where a user goes when the banner is quiet.
 *
 * It used to answer every failure with `.catch(() => undefined)`: a rejected
 * download, a rejected install and even a failed `updateStatus()` read all
 * produced no change and no sentence. The click looked like a control that did
 * nothing — the one outcome the banner's contract forbids. Both surfaces now
 * read the same controller, so the card carries the same failure the banner
 * does.
 */
describe('a failed update action in Settings is never a silent click', () => {
  function mountWithBrokenUpdate(
    overrides: Partial<ReturnType<typeof createFixtureApi>['api']['app']>,
  ) {
    const fixture = createFixtureApi('default');
    const api = {
      ...fixture.api,
      app: {
        ...fixture.api.app,
        updateStatus: async (): Promise<UpdateStatus> => AVAILABLE,
        ...overrides,
      },
    };
    (window as unknown as Record<string, unknown>).ucad = api;
    return render(<App />);
  }

  it('shows the reason when the download is rejected', async () => {
    const user = userEvent.setup();
    mountWithBrokenUpdate({
      downloadUpdate: async () => {
        throw new Error('下载通道已断开');
      },
    });
    await settle();
    await openSettings(user);

    await user.click(within(updateCard()).getByRole('button', { name: '下载更新' }));

    expect(await within(updateCard()).findByText(/下载通道已断开/)).toBeTruthy();
  });

  it('keeps the check button usable after a rejected check', async () => {
    const user = userEvent.setup();
    mountWithBrokenUpdate({
      checkUpdate: async () => {
        throw new Error('检查通道已断开');
      },
    });
    await settle();
    await openSettings(user);

    const card = updateCard();
    await user.click(within(card).getByRole('button', { name: '检查更新' }));

    expect(await within(card).findByText(/检查通道已断开/)).toBeTruthy();
    // The failure keeps the pending action (it owns the message), but the
    // control must not stay stuck on "检查中…" with no way to retry.
    const retry = within(card).getByRole('button', { name: '检查更新' });
    expect(retry).toBeEnabled();
  });

  it('says the status could not be read, instead of showing the fallback as fact', async () => {
    const user = userEvent.setup();
    mountWithBrokenUpdate({
      updateStatus: async () => {
        throw new Error('更新服务离线');
      },
    });
    await settle();
    await openSettings(user);

    expect(await within(updateCard()).findByText(/读取更新状态失败/)).toBeTruthy();
    expect(within(updateCard()).getByText(/更新服务离线/)).toBeTruthy();
  });
});
