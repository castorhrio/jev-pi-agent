import { describe, expect, it } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  UpdateControllerProvider,
  useUpdateController,
} from '@renderer/update-controller';
import { createFixtureApi } from '@renderer/dev/fixture-bridge';
import type { UcadApi, UpdateStatus } from '@ucad/contracts';

/**
 * The update controller's state transitions, as a sequence.
 *
 * `update-banner.e2e.test.tsx` walks the action × status table and checks what
 * the banner draws. That is a cross product, not a sequence: it can be green
 * while the two failure fields are left half-cleared between steps, because no
 * test asked what happened to the *other* one. The failures have two owners —
 * `statusFailure` for the opening read, `failure` for an action the user
 * started — and the bug this file pins is exactly the hand-off between them:
 * clearing one and not the other leaves the Settings card and the banner
 * disagreeing about whether the app is broken.
 */

const IDLE: UpdateStatus = {
  state: 'idle',
  currentVersion: '1.0.0',
  feedConfigured: true,
};

const AVAILABLE: UpdateStatus = {
  state: 'available',
  currentVersion: '1.0.0',
  latestVersion: '1.1.0',
  feedConfigured: true,
};

const READY: UpdateStatus = {
  state: 'ready',
  currentVersion: '1.0.0',
  latestVersion: '1.1.0',
  downloadedPath: '/tmp/UCAD-setup.exe',
  verified: true,
  feedConfigured: true,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Reads the controller directly, since `statusFailure` has no banner surface. */
function Probe(): JSX.Element {
  const controller = useUpdateController();
  return (
    <div>
      <output data-testid="status">{controller.status?.state ?? 'none'}</output>
      <output data-testid="pending">{controller.pendingAction ?? 'none'}</output>
      <output data-testid="failure">{controller.failure ?? 'none'}</output>
      <output data-testid="status-failure">{controller.statusFailure ?? 'none'}</output>
      <button onClick={controller.check}>run check</button>
      <button onClick={controller.download}>run download</button>
      <button onClick={controller.install}>run install</button>
      <button onClick={controller.dismissFailure}>dismiss</button>
    </div>
  );
}

interface MountOptions {
  readonly initial?: () => Promise<UpdateStatus | null>;
  readonly check?: () => Promise<UpdateStatus>;
  readonly download?: () => Promise<UpdateStatus>;
  readonly install?: () => Promise<boolean>;
}

function mount(options: MountOptions = {}) {
  const fixture = createFixtureApi('default');
  const listeners = new Set<(next: UpdateStatus) => void>();
  const api = {
    ...fixture.api,
    app: {
      ...fixture.api.app,
      updateStatus: options.initial ?? (async () => IDLE),
      onUpdateStatus: (cb: (next: UpdateStatus) => void) => {
        listeners.add(cb);
        return () => {
          listeners.delete(cb);
        };
      },
      checkUpdate: options.check ?? (async () => IDLE),
      downloadUpdate: options.download ?? (async () => IDLE),
      installUpdate: options.install ?? (async () => true),
    },
  } as unknown as UcadApi;

  (window as unknown as Record<string, unknown>).ucad = api;
  render(
    <UpdateControllerProvider>
      <Probe />
    </UpdateControllerProvider>,
  );

  return {
    emit: async (next: UpdateStatus) => {
      await act(async () => {
        for (const cb of listeners) cb(next);
      });
    },
  };
}

function field(name: 'status' | 'pending' | 'failure' | 'status-failure'): string {
  return screen.getByTestId(name).textContent ?? '';
}

describe('the update controller hands failure ownership over in sequence', () => {
  it('moves from a failed read to a failed action and clears both on dismissal', async () => {
    const user = userEvent.setup();
    mount({
      initial: async () => {
        throw new Error('status read failed');
      },
      check: async () => {
        throw new Error('check failed');
      },
    });

    // The opening read failed. It is `statusFailure`, not `failure`: nobody
    // asked for the check, and the banner must stay quiet about it.
    await waitFor(() => expect(field('status-failure')).toBe('status read failed'));
    expect(field('failure')).toBe('none');
    expect(field('status')).toBe('none');

    // The user acts. Their action's rejection is `failure`, and the stale
    // read failure is no longer the current answer.
    await user.click(screen.getByRole('button', { name: 'run check' }));
    await waitFor(() => expect(field('failure')).toBe('check failed'));
    expect(field('status-failure')).toBe('none');
    expect(field('pending')).toBe('check');

    // Dismissing answers both: one control, two fields, no half-cleared state.
    await user.click(screen.getByRole('button', { name: 'dismiss' }));
    expect(field('failure')).toBe('none');
    expect(field('status-failure')).toBe('none');
    expect(field('pending')).toBe('none');
  });

  it('lets a real status replace both failures and end the pending action', async () => {
    const user = userEvent.setup();
    const { emit } = mount({
      initial: async () => {
        throw new Error('status read failed');
      },
      check: async () => {
        throw new Error('check failed');
      },
    });

    await waitFor(() => expect(field('status-failure')).toBe('status read failed'));
    await user.click(screen.getByRole('button', { name: 'run check' }));
    await waitFor(() => expect(field('failure')).toBe('check failed'));

    // A pushed status is a better answer than either failure. `available` is
    // an ending for a check, so it also releases the pending action.
    await emit(AVAILABLE);
    expect(field('status')).toBe('available');
    expect(field('failure')).toBe('none');
    expect(field('status-failure')).toBe('none');
    expect(field('pending')).toBe('none');
  });

  it('refuses a pushed value whose state is not in UPDATE_STATES', async () => {
    const { emit } = mount();
    await waitFor(() => expect(field('status')).toBe('idle'));

    // The subscription used to hand Main's payload straight to `applyStatus`,
    // whose guard was "has a `state` key". A drifted state was written through
    // and every surface rendered something the tables do not know about.
    await emit({
      state: 'reticulating',
      currentVersion: '1.0.0',
      feedConfigured: true,
    } as unknown as UpdateStatus);
    expect(field('status')).toBe('idle');

    await emit(null as unknown as UpdateStatus);
    expect(field('status')).toBe('idle');
  });

  it('does not let a late check answer retire a download started after it', async () => {
    const user = userEvent.setup();
    const check = deferred<UpdateStatus>();
    const download = deferred<UpdateStatus>();
    mount({
      initial: async () => AVAILABLE,
      check: () => check.promise,
      download: () => download.promise,
    });
    await waitFor(() => expect(field('status')).toBe('available'));

    await user.click(screen.getByRole('button', { name: 'run check' }));
    await user.click(screen.getByRole('button', { name: 'run download' }));
    expect(field('pending')).toBe('download');

    // `ready` ends both a check and a download. The check was replaced before
    // it answered, so its answer belongs to nobody: it must neither change the
    // status nor clear the action the user is now waiting on.
    await act(async () => {
      check.resolve(READY);
      await check.promise;
    });
    expect(field('pending'), 'a superseded check cleared the download').toBe('download');
    expect(field('status'), 'a superseded check rewrote the status').toBe('available');

    await act(async () => {
      download.resolve(READY);
      await download.promise;
    });
    expect(field('pending')).toBe('none');
    expect(field('status')).toBe('ready');
  });

  it('does not let an earlier click of the same action settle a later one', async () => {
    const user = userEvent.setup();
    const first = deferred<UpdateStatus>();
    const second = deferred<UpdateStatus>();
    const answers = [first.promise, second.promise];
    let call = 0;
    mount({
      initial: async () => AVAILABLE,
      download: () => answers[call++]!,
    });
    await waitFor(() => expect(field('status')).toBe('available'));

    // The action name is identical on both clicks, so identity by action alone
    // would treat the first answer as the second click's answer.
    await user.click(screen.getByRole('button', { name: 'run download' }));
    await user.click(screen.getByRole('button', { name: 'run download' }));
    expect(field('pending')).toBe('download');

    await act(async () => {
      first.resolve(READY);
      await first.promise;
    });
    expect(field('pending'), 'the first click settled the second click').toBe('download');
    expect(field('status'), 'the first click rewrote the status').toBe('available');

    await act(async () => {
      second.resolve(READY);
      await second.promise;
    });
    expect(field('pending')).toBe('none');
    expect(field('status')).toBe('ready');
  });

  it('ends a rejected install while keeping its reason readable', async () => {
    const user = userEvent.setup();
    mount({
      initial: async () => READY,
      install: async () => {
        throw new Error('安装程序校验失败');
      },
    });
    await waitFor(() => expect(field('status')).toBe('ready'));

    await user.click(screen.getByRole('button', { name: 'run install' }));
    await waitFor(() => expect(field('failure')).toBe('安装程序校验失败'));

    // Nothing is installing any more, and there is nothing to retry without a
    // fresh check — but the user still has to be told why the click failed.
    expect(field('pending'), 'a rejected install is still reported as pending').toBe('none');
    expect(field('status')).toBe('ready');
  });
});
