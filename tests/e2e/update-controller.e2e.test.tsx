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
      <button onClick={controller.dismissFailure}>dismiss</button>
    </div>
  );
}

interface MountOptions {
  readonly initial?: () => Promise<UpdateStatus | null>;
  readonly check?: () => Promise<UpdateStatus>;
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
});
