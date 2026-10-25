import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '@renderer/App';
import { createFixtureApi } from '@renderer/dev/fixture-bridge';

/**
 * Stopping a code-intelligence query that is taking its time.
 *
 * The panel used to have no way to stop a query at all: the bridge answered
 * with the *provider's* id as the operation id, so `cancel('basic')` found
 * nothing and reported a miss. And even with a real id, the id only arrived
 * together with the answer — too late to stop anything.
 *
 * So the panel allocates the id, sends it with the request, and offers a
 * cancel while the query is in flight. Two things have to hold, and only a
 * rendered panel can show them:
 *
 *  1. the cancel names the *same* operation the query was started under;
 *  2. a cancelled query says it was cancelled — it does not come back as a
 *     confident partial answer.
 */

type Fixture = ReturnType<typeof createFixtureApi>;

function mount(): { api: Fixture['api']; user: ReturnType<typeof userEvent.setup> } {
  const fixture: Fixture = createFixtureApi('default');
  (window as unknown as Record<string, unknown>).ucad = fixture.api;
  render(<App />);
  return { api: fixture.api, user: userEvent.setup() };
}

/** Opens the intelligence surface through the real "more" menu. */
async function openIntelligence(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  const nav = screen.getAllByRole('navigation')[0]!;
  await user.click(within(nav).getByRole('button', { name: /更多/ }));
  await user.click(await screen.findByRole('menuitem', { name: '代码理解' }));
  await waitFor(() => expect(screen.getByText('项目智能')).toBeTruthy(), { timeout: 5000 });
  /*
   * The panel refuses to query a workspace it has not got, and the workspace
   * arrives a moment after the surface does. Clicking "run" in that gap
   * would silently do nothing — which is exactly the sort of quiet failure
   * this suite exists to catch, so the test waits for the real state.
   */
  await waitFor(
    () => expect(screen.queryByText(/请先打开一个项目/)).toBeNull(),
    { timeout: 5000 },
  );
}

describe('cancelling a code-intelligence query', () => {
  it('cancels the query that is running, by the id it was started with', async () => {
    const { api, user } = mount();
    await openIntelligence(user);

    // The query never resolves on its own: the point is to cancel it while
    // it is still in flight.
    let started: { operationId?: string; providerId?: string } | null = null;
    let release: ((value: unknown) => void) | null = null;
    api.intelligence.query = ((input: { operationId?: string; providerId?: string }) => {
      started = input;
      return new Promise((resolve) => {
        release = resolve;
      });
    }) as never;

    const cancelledWith: string[] = [];
    api.intelligence.cancel = (async (operationId: string) => {
      cancelledWith.push(operationId);
      return { cancelled: true };
    }) as never;

    await user.type(screen.getByLabelText('查询内容'), 'renderContextPack');
    await user.click(screen.getByRole('button', { name: '执行' }));

    // While the query runs, the cancel is on screen.
    const cancelButton = await screen.findByRole('button', { name: '取消查询' });
    expect(started).not.toBeNull();
    expect(started!.operationId).toBeTruthy();

    await user.click(cancelButton);

    // The cancel must name the operation the query is running under. A
    // cancel that names anything else reports a miss and stops nothing.
    expect(cancelledWith).toEqual([started!.operationId]);

    // The query comes back as cancelled — and says so.
    release!({
      operationId: started!.operationId,
      providerId: 'basic',
      result: {
        status: 'cancelled',
        result: null,
        freshness: { stale: true, stalenessReason: 'unknown_revision' },
        durationMs: 4,
        providerId: 'basic',
        reason: `query 'search' was cancelled (${started!.operationId})`,
      },
    });

    await waitFor(() => expect(screen.getByText(/这次查询被取消了/)).toBeTruthy(), { timeout: 5000 });
  });

  it('runs the query against the provider the panel has selected', async () => {
    const { api, user } = mount();
    await openIntelligence(user);

    const querySpy = vi.fn(async () => ({
      operationId: 'uiq_test',
      providerId: 'basic',
      result: {
        status: 'ok',
        result: { items: [], truncated: false, freshness: { stale: true } },
        freshness: { stale: true, stalenessReason: 'unknown_revision' },
        durationMs: 1,
        providerId: 'basic',
      },
    }));
    api.intelligence.query = querySpy as never;

    await user.type(screen.getByLabelText('查询内容'), 'renderContextPack');
    await user.click(screen.getByRole('button', { name: '执行' }));

    await waitFor(() => expect(querySpy).toHaveBeenCalled(), { timeout: 5000 });
    // The panel's provider picker is not decoration: the query has to run
    // against the provider the user picked.
    expect(querySpy.mock.calls[0]![0]).toMatchObject({ providerId: 'basic' });
  });
});
