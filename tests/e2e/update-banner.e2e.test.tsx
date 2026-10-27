import { describe, expect, it } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nProvider } from '@renderer/i18n-context';
import { UpdateBanner } from '@renderer/components/UpdateBanner';
import { createFixtureApi } from '@renderer/dev/fixture-bridge';
import {
  UPDATE_STATES,
  type UcadApi,
  type UpdateState,
  type UpdateStatus,
} from '@ucad/contracts';

/**
 * The banner is the renderer's projection of the update state machine.
 *
 * It used to be three `if`s and a `return null`: `downloading` borrowed the
 * check's copy ("检查中…"), and an `error` was drawn nowhere. The second half
 * is the one users meet — a download started from this banner changes the
 * element into a progress bar, and if the installer then fails its hash the
 * banner vanished, leaving the reason only on the Settings card. A button that
 * silently removes the thing the user was watching is a dead end.
 *
 * So the states are pinned here, not in Settings: every `UpdateState` has a
 * row, the actionable ones draw an action that calls the matching API, and a
 * failure is shown only after the user has acted in this banner. The last rule
 * is deliberate — the app checks on startup, and an offline machine must not
 * open with a failure banner about a check nobody asked for.
 *
 * Ownership is a named action, not "some click happened here": the banner
 * remembers whether it is waiting on a download, an install or a check, and
 * keeps that until the action ends. A rejection from the IPC surface has no
 * status to carry it, so it is answered locally — the alternative is a button
 * that does nothing and says nothing.
 */

const BASE = { currentVersion: '1.0.0', feedConfigured: true } as const;

const STATUS: Record<UpdateState, UpdateStatus> = {
  idle: { ...BASE, state: 'idle' },
  checking: { ...BASE, state: 'checking' },
  'up-to-date': { ...BASE, state: 'up-to-date', latestVersion: '1.0.0' },
  available: { ...BASE, state: 'available', latestVersion: '1.1.0', notes: 'Release notes.' },
  downloading: { ...BASE, state: 'downloading', latestVersion: '1.1.0', progress: 0.42 },
  ready: {
    ...BASE,
    state: 'ready',
    latestVersion: '1.1.0',
    downloadedPath: '/tmp/UCAD-setup.exe',
    verified: true,
  },
  error: { ...BASE, state: 'error', message: '安装包校验失败：SHA-256 不匹配，已删除该文件' },
  unsupported: { ...BASE, state: 'unsupported', feedConfigured: false, message: '未配置更新源' },
};

/**
 * Mounts the banner with a status the test releases explicitly.
 *
 * The initial `updateStatus()` promise is held open so a test can await the
 * render *after* the status lands. Without that, an assertion that a silent
 * state draws nothing would pass before the effect ran — the test would be
 * green and would have checked only the initial `null`.
 */
function mount(
  status: UpdateStatus,
  options: {
    readonly downloadError?: unknown;
    readonly checkError?: unknown;
    readonly installError?: unknown;
  } = {},
) {
  const fixture = createFixtureApi('default');
  const listeners = new Set<(next: UpdateStatus) => void>();
  const calls = { check: 0, download: 0, install: 0 };
  let resolveStatus!: (next: UpdateStatus) => void;
  const initial = new Promise<UpdateStatus>((resolve) => {
    resolveStatus = resolve;
  });

  const api = {
    ...fixture.api,
    app: {
      ...fixture.api.app,
      updateStatus: () => initial,
      onUpdateStatus: (cb: (next: UpdateStatus) => void) => {
        listeners.add(cb);
        return () => {
          listeners.delete(cb);
        };
      },
      checkUpdate: async () => {
        calls.check += 1;
        if (options.checkError !== undefined) throw options.checkError;
        return status;
      },
      downloadUpdate: async () => {
        calls.download += 1;
        if (options.downloadError !== undefined) throw options.downloadError;
        return status;
      },
      installUpdate: async () => {
        calls.install += 1;
        if (options.installError !== undefined) throw options.installError;
        return true;
      },
    },
  } as unknown as UcadApi;

  (window as unknown as Record<string, unknown>).ucad = api;
  const utils = render(
    <I18nProvider api={api}>
      <UpdateBanner />
    </I18nProvider>,
  );

  return {
    ...utils,
    calls,
    show: async () => {
      await act(async () => {
        resolveStatus(status);
      });
    },
    emit: async (next: UpdateStatus) => {
      await act(async () => {
        for (const cb of listeners) cb(next);
      });
    },
  };
}

function banner(): HTMLElement {
  const found = document.querySelector('.banner');
  if (found === null) throw new Error('the update banner is not rendered');
  return found as HTMLElement;
}

describe('the update banner accounts for every state', () => {
  it('has a row for every state the contract can publish', () => {
    expect(
      Object.keys(STATUS).sort(),
      'a state exists with no banner row, or a row exists for a state that is gone',
    ).toEqual([...UPDATE_STATES].sort());
    expect(UPDATE_STATES.length, 'the vocabulary shrank, so this table proves less').toBeGreaterThan(
      4,
    );
  });

  it('draws nothing for states with nothing to do, or a failure nobody here started', async () => {
    // `error` belongs in this list *before* an action: the startup check may
    // fail, and a banner about it would be noise on every offline launch.
    const silent: readonly UpdateState[] = [
      'idle',
      'checking',
      'up-to-date',
      'unsupported',
      'error',
    ];

    for (const state of silent) {
      const { show, unmount, container } = mount(STATUS[state]);
      await show();
      expect(container.querySelector('.banner'), `${state} drew a banner`).toBeNull();
      unmount();
    }
  });

  it('says it is downloading, not checking', async () => {
    const { show } = mount(STATUS.downloading);
    await show();

    // The copy shipped as "检查中…" while bytes were arriving; a user reading
    // that has no way to tell a download from a check.
    expect(within(banner()).getByText('正在下载…')).toBeTruthy();
    expect(within(banner()).getByText('42%')).toBeTruthy();
    expect(screen.queryByText('检查中…'), 'downloading still borrows the check copy').toBeNull();
  });

  it('offers the download action when a version is available', async () => {
    const user = userEvent.setup();
    const { show, calls } = mount(STATUS.available);
    await show();

    const element = banner();
    expect(within(element).getByText('发现新版本 · v1.1.0')).toBeTruthy();
    await user.click(within(element).getByRole('button', { name: '下载更新' }));
    expect(calls.download, 'the named button did not start the download').toBe(1);
  });

  it('offers the restart action when the installer is ready', async () => {
    const user = userEvent.setup();
    const { show, calls } = mount(STATUS.ready);
    await show();

    const element = banner();
    await user.click(within(element).getByRole('button', { name: '立即重启并安装' }));
    expect(calls.install, 'the named button did not install').toBe(1);
  });

  it('shows a failure the user started, with the reason and a retry', async () => {
    const user = userEvent.setup();
    const { show, emit, calls } = mount(STATUS.available);
    await show();

    // The action the user is watching. In the real app the service pushes
    // `downloading` and then the failure; here only the failure matters.
    await user.click(within(banner()).getByRole('button', { name: '下载更新' }));
    await emit(STATUS.error);

    const alert = screen.getByRole('alert');
    expect(alert, 'a failure after the user acted was not announced').toHaveTextContent(
      '检查更新失败',
    );
    expect(alert, 'the failure was announced without its reason').toHaveTextContent('SHA-256');

    await user.click(within(alert).getByRole('button', { name: '检查更新' }));
    expect(calls.check, 'the retry did not ask for a fresh check').toBe(1);
  });

  it('lets the user dismiss a failure without retrying', async () => {
    const user = userEvent.setup();
    const { show, emit, calls } = mount(STATUS.available);
    await show();

    await user.click(within(banner()).getByRole('button', { name: '下载更新' }));
    await emit(STATUS.error);
    await user.click(within(screen.getByRole('alert')).getByRole('button', { name: '关闭' }));

    expect(screen.queryByRole('alert'), 'a dismissed failure is still on screen').toBeNull();
    expect(calls.check, 'dismissing ran a check the user did not ask for').toBe(0);
  });

  it('keeps a background failure quiet, and shows one once the user has acted', async () => {
    const user = userEvent.setup();
    const { show, emit } = mount(STATUS.available);
    await show();

    // The startup check runs on its own; its failure is not this user's
    // question, and a banner about it would greet every offline launch.
    await emit(STATUS.error);
    expect(document.querySelector('.banner'), 'a background failure opened a banner').toBeNull();

    // The same failure after a click in this banner is the answer they are
    // watching for — ownership is the action, not the order of events.
    await emit(STATUS.available);
    await user.click(within(banner()).getByRole('button', { name: '下载更新' }));
    await emit(STATUS.error);
    expect(screen.getByRole('alert'), 'a failure after the user acted was hidden').toHaveTextContent(
      'SHA-256',
    );
  });

  it('forgets the action once a status ends it, so a later background failure stays quiet', async () => {
    const user = userEvent.setup();
    const { show, emit } = mount(STATUS.available);
    await show();

    await user.click(within(banner()).getByRole('button', { name: '下载更新' }));
    // `ready` is what a download ends at, so the pending action is over by the
    // time the next failure arrives.
    await emit(STATUS.ready);
    await emit(STATUS.error);

    expect(
      document.querySelector('.banner'),
      'a finished action still owned a later background failure',
    ).toBeNull();
  });

  it('turns a rejected download into a failure with a reason and a retry', async () => {
    const user = userEvent.setup();
    const { show, calls } = mount(STATUS.available, {
      downloadError: new Error('下载通道已断开'),
    });
    await show();

    await user.click(within(banner()).getByRole('button', { name: '下载更新' }));

    // A rejected IPC call pushes no status, so without a local failure the
    // banner would simply stay on "available" and the click would be a no-op.
    const alert = await screen.findByRole('alert');
    expect(alert, 'a rejected download left the click with no answer').toHaveTextContent(
      '下载通道已断开',
    );

    await user.click(within(alert).getByRole('button', { name: '检查更新' }));
    expect(calls.check, 'the retry after a rejection did not run a check').toBe(1);
    await waitFor(() =>
      expect(screen.queryByRole('alert'), 'the retry left the old failure on screen').toBeNull(),
    );
  });

  it('follows a pushed status instead of only the initial read', async () => {
    const { show, emit } = mount(STATUS['up-to-date']);
    await show();
    expect(document.querySelector('.banner')).toBeNull();

    await emit(STATUS.available);
    expect(within(banner()).getByText('发现新版本 · v1.1.0')).toBeTruthy();
  });
});
