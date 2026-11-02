import { describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  UpdateControllerProvider,
  useUpdateController,
} from '@renderer/update-controller';
import { createFixtureApi } from '@renderer/dev/fixture-bridge';
import type { UpdateStatus } from '@ucad/contracts';

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

const UP_TO_DATE: UpdateStatus = {
  state: 'up-to-date',
  currentVersion: '1.0.0',
  latestVersion: '1.0.0',
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

const ERROR: UpdateStatus = {
  state: 'error',
  currentVersion: '1.0.0',
  message: 'a background check failed',
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
  /**
   * The real call answers a boolean, but the controller also accepts a status
   * for the install paths that stay alive long enough to report one.
   */
  readonly install?: () => Promise<boolean | UpdateStatus>;
}

function mount(options: MountOptions = {}) {
  const listeners = new Set<(next: UpdateStatus) => void>();
  // The bridge's own update surface is the contract's (`FixtureUpdateOverrides`
  // widens only `installUpdate`, for the drift case), so the object handed to
  // the renderer is a `UcadApi` the compiler has seen — no whole-api cast, and
  // a method added to `UcadApi` would fail `fixture-bridge.test.ts` instead of
  // slipping past this file.
  const fixture = createFixtureApi('default', {
    updateStatus: options.initial ?? (async () => IDLE),
    checkUpdate: options.check ?? (async () => IDLE),
    downloadUpdate: options.download ?? (async () => IDLE),
    installUpdate: options.install ?? (async () => true),
    onUpdateStatus: (cb: (next: UpdateStatus) => void) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
  });

  window.ucad = fixture.api;
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

  it('lets a pushed terminal status end the check it answers', async () => {
    const user = userEvent.setup();
    const check = deferred<UpdateStatus>();
    const { emit } = mount({
      initial: async () => IDLE,
      check: () => check.promise,
    });
    await waitFor(() => expect(field('status')).toBe('idle'));

    await user.click(screen.getByRole('button', { name: 'run check' }));
    expect(field('pending')).toBe('check');

    // No token guards a push: it is Main stating what is true now, and
    // `available` is an ending for a check. So the push takes ownership of the
    // answer the click was waiting for (the same choice the module comment
    // states). The click's own answer is now stale and must be dropped —
    // `pendingRef` is already clear, so `settle` refuses it.
    await emit(AVAILABLE);
    expect(field('status')).toBe('available');
    expect(field('pending')).toBe('none');

    await act(async () => {
      check.resolve(UP_TO_DATE);
      await check.promise;
    });
    expect(field('status'), 'a superseded check overwrote the newer push').toBe('available');
    expect(field('pending')).toBe('none');
    expect(field('failure')).toBe('none');
  });

  it('keeps a download pending when a push is not an ending for it', async () => {
    const user = userEvent.setup();
    const download = deferred<UpdateStatus>();
    const { emit } = mount({
      initial: async () => IDLE,
      download: () => download.promise,
    });
    await waitFor(() => expect(field('status')).toBe('idle'));

    await user.click(screen.getByRole('button', { name: 'run download' }));
    expect(field('pending')).toBe('download');

    // A push is authoritative for the status — Main has just measured it — but
    // only for the endings it declares. `available` is where a download starts,
    // not where it ends, so the download the user is waiting on stays pending.
    // The opposite rule ("any push ends the action") would silently retire it
    // and leave a progress bar that never resolves.
    await emit(AVAILABLE);
    expect(field('status')).toBe('available');
    expect(field('pending'), 'a non-terminal push retired the download').toBe('download');
    expect(field('failure')).toBe('none');

    // …and the download's own ending still releases it.
    await act(async () => {
      download.resolve(READY);
      await download.promise;
    });
    expect(field('pending')).toBe('none');
    expect(field('status')).toBe('ready');
  });

  it('refuses a pushed value whose state is not in UPDATE_STATES and says so', async () => {
    // The refusal is the only place contract drift can be seen: the payload is
    // dropped before it reaches state, so no surface renders it and nothing
    // else in the renderer can notice. The warning is therefore part of the
    // contract, not debug output — a silent refusal is indistinguishable from
    // "the banner just stopped updating". Spied rather than tolerated, so a
    // future edit cannot delete the warning and keep this green.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { emit } = mount();
      await waitFor(() => expect(field('status')).toBe('idle'));
      // A status the renderer *does* understand is not a refusal: the spy is
      // tied to the drift, not to every push this provider ever receives.
      expect(warn).not.toHaveBeenCalled();

      // The subscription used to hand Main's payload straight to `applyStatus`,
      // whose guard was "has a `state` key". A drifted state was written through
      // and every surface rendered something the tables do not know about.
      const drifted = {
        state: 'reticulating',
        currentVersion: '1.0.0',
        feedConfigured: true,
      } as unknown as UpdateStatus;
      await emit(drifted);
      expect(field('status')).toBe('idle');
      // The payload is carried, not just the fact: a console line that says
      // "refused something" leaves the reader without the state name that has
      // to be added to `UPDATE_STATES` (or removed from Main). The reason is
      // carried too, and it names the state rather than repeating the fact.
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]).toEqual([
        '[update-controller] refused an update status that does not match the contract',
        {
          next: drifted,
          problem: '`state` is "reticulating", which is not in UPDATE_STATES',
        },
      ]);

      // A non-object is the same class of drift: refused, and warned about,
      // rather than reaching `setStatus(null)` (which means "not read yet").
      await emit(null as unknown as UpdateStatus);
      expect(field('status')).toBe('idle');
      expect(warn).toHaveBeenCalledTimes(2);
      expect(warn.mock.calls[1]).toEqual([
        '[update-controller] refused an update status that does not match the contract',
        { next: null, problem: 'the payload is not an object' },
      ]);
    } finally {
      warn.mockRestore();
    }
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

  it('refuses a status with a published state but a missing required field', async () => {
    // The state-only guard accepted this one, which is why it is a case of its
    // own rather than another drifted state: the vocabulary was right and the
    // payload was still not a status. Settings draws `update.currentVersion`
    // and reads `feedConfigured` to choose its copy, so writing it through
    // showed a blank version — or, worse, "no feed configured" for a build
    // that has one.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { emit } = mount();
      await waitFor(() => expect(field('status')).toBe('idle'));

      const partial = {
        state: 'available',
        latestVersion: '1.1.0',
        feedConfigured: true,
      } as unknown as UpdateStatus;
      await emit(partial);
      expect(field('status'), 'a status Settings cannot draw was written through').toBe('idle');
      expect(warn.mock.calls[0]).toEqual([
        '[update-controller] refused an update status that does not match the contract',
        {
          next: partial,
          problem: '`currentVersion` is missing (the contract requires a string)',
        },
      ]);

      // The other required field, for the same reason: `false` and "absent"
      // are not the same claim, and only one of them is the contract's.
      const noFeed = { state: 'unsupported', currentVersion: '1.0.0' } as unknown as UpdateStatus;
      await emit(noFeed);
      expect(field('status')).toBe('idle');
      expect(warn.mock.calls[1]?.[1]).toEqual({
        next: noFeed,
        problem: '`feedConfigured` is missing (the contract requires a boolean)',
      });
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  it('ends a click whose answer is not a status, instead of waiting forever', async () => {
    // A check or download ends at a status, so an answer the guard refuses
    // leaves the pending action with nothing to retire it — a spinner that
    // resolves when a push happens to arrive, which for a failed action is
    // never. The action is over (its call settled), so it is released, and the
    // refusal is written to the console because a stuck click is not something
    // the user can act on.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      mount({
        initial: async () => IDLE,
        check: async () => ({ state: 'up-to-date' } as unknown as UpdateStatus),
      });
      await waitFor(() => expect(field('status')).toBe('idle'));

      await userEvent.setup().click(screen.getByRole('button', { name: 'run check' }));
      await waitFor(() => expect(field('pending')).toBe('none'));

      expect(field('status'), 'a refused answer rewrote the status').toBe('idle');
      // Not a user-facing `failure`: drift is a bug to fix in a build, not a
      // sentence a person should be shown about their own press.
      expect(field('failure')).toBe('none');
      expect(warn.mock.calls[0]?.[1]).toEqual({
        next: { state: 'up-to-date' },
        problem: '`currentVersion` is missing (the contract requires a string)',
      });
    } finally {
      warn.mockRestore();
    }
  });

  it('releases the install action when the installer reports success', async () => {
    const user = userEvent.setup();
    mount({
      initial: async () => READY,
      install: async () => true,
    });
    await waitFor(() => expect(field('status')).toBe('ready'));

    await user.click(screen.getByRole('button', { name: 'run install' }));

    // The app quits after a real install, so nothing has to retire the action.
    // The harness, `dev:web` and a quit the user cancels all stay alive, and
    // there the action used to stay pending forever — claiming an install that
    // had already succeeded.
    await waitFor(() =>
      expect(field('pending'), 'a successful install is still reported as pending').toBe('none'),
    );
    expect(field('failure')).toBe('none');
    expect(field('status')).toBe('ready');
  });

  it('releases a status-answering install when its call settles, not from the table', async () => {
    const user = userEvent.setup();
    const check = deferred<UpdateStatus>();
    mount({
      initial: async () => READY,
      // `installUpdate()` is typed `Promise<boolean>` and the fixture widens
      // only this one method, so this is the Main-drifted value the renderer's
      // guard exists for. `available` ends a *check*, not an install: the
      // install row is empty. The release therefore comes from `settle` — the
      // call settling — and `applyStatus` then finds `pendingRef` already
      // clear. If the release came from the table, this test would still pass
      // with a wrong row; the next test is the other half.
      install: async () => AVAILABLE,
      check: () => check.promise,
    });
    await waitFor(() => expect(field('status')).toBe('ready'));

    await user.click(screen.getByRole('button', { name: 'run install' }));
    await waitFor(() => expect(field('pending')).toBe('none'));

    expect(field('status')).toBe('available');
    expect(field('failure'), 'a clean install answer became a failure').toBe('none');
    expect(field('status-failure')).toBe('none');

    // The controller is still usable: a new action starts and ends on its own
    // token rather than being retired by the install's.
    await user.click(screen.getByRole('button', { name: 'run check' }));
    expect(field('pending')).toBe('check');
    await act(async () => {
      check.resolve(UP_TO_DATE);
      await check.promise;
    });
    expect(field('pending')).toBe('none');
    expect(field('status')).toBe('up-to-date');
  });

  it('keeps an install pending when a status that ends another action is pushed', async () => {
    const user = userEvent.setup();
    const install = deferred<boolean>();
    const { emit } = mount({
      initial: async () => READY,
      install: () => install.promise,
    });
    await waitFor(() => expect(field('status')).toBe('ready'));

    await user.click(screen.getByRole('button', { name: 'run install' }));
    expect(field('pending')).toBe('install');

    // `available` is where a *check* answers and where a download starts, but
    // it says nothing about the install the user is waiting on. The install
    // row is empty because the call's boolean is its only ending; a push that
    // counted here would retire a running installer — and then the boolean
    // that follows would have no action left to settle.
    await emit(AVAILABLE);
    expect(field('status')).toBe('available');
    expect(field('pending'), 'a check-ending push retired the install').toBe('install');

    // The real ending: the call settles, with a boolean rather than a status.
    await act(async () => {
      install.resolve(true);
      await install.promise;
    });
    expect(field('pending')).toBe('none');
    expect(field('status')).toBe('available');
    expect(field('failure')).toBe('none');
  });

  it('does not hand a later error push to the install that already ended', async () => {
    const user = userEvent.setup();
    const { emit } = mount({
      initial: async () => READY,
      install: async () => true,
    });
    await waitFor(() => expect(field('status')).toBe('ready'));

    await user.click(screen.getByRole('button', { name: 'run install' }));
    await waitFor(() => expect(field('pending')).toBe('none'));

    // The install is over. A background check failing afterwards is a status,
    // not a failure of the click: there is no pending action left to own it,
    // and `failure` must stay empty so the banner does not blame the install.
    await emit(ERROR);
    expect(field('status')).toBe('error');
    expect(field('pending'), 'an error push revived the finished install action').toBe('none');
    expect(field('failure'), 'an error push was attributed to the finished install').toBe('none');
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
