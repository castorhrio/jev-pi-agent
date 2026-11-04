import { describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import { App } from '@renderer/App';
import { createFixtureApi } from '@renderer/dev/fixture-bridge';
import { createTranslator } from '../../apps/desktop/src/shared/i18n';

/**
 * One request, one answer — even when the click arrives twice in one frame.
 *
 * ## The defect this pins
 *
 * `usePermissionQueue` guarded `respond` with the `busy` *state*:
 *
 *     if (busy) return;
 *     setBusy(true);
 *
 * That guard does not hold inside a single frame. `setBusy(true)` is a state
 * update, so a second click dispatched before React commits the re-render reads
 * the `busy` captured by the render still on screen — `false` — and sends a
 * second `permissions.respond` for the same request. The host answers the first
 * and rejects the second as a protocol error, so the user gets a failure notice
 * for a decision that actually went through. A real double click, a trackpad tap
 * that fires twice and a key repeat all reach it; `userEvent.click()` twice does
 * not, because each awaited click flushes a render in between, which is why the
 * existing permission test in `scenarios.e2e.test.tsx` never saw it.
 *
 * The fix is a ref written before the first `await`, so the second handler sees
 * it whatever React has or has not committed. This file drives the frame the
 * state guard could not cover: two clicks in one tick.
 *
 * ## Why the count is the assertion
 *
 * "The dialog closed" is true after one response and after two — the second
 * response is rejected by the host, not by the UI. The thing that is wrong is
 * the *number of requests*, so the number is what is asserted: one `respond`
 * call, one `permission.resolved` in the log. The log is read through
 * `events.since`, i.e. the same replay a restarted renderer would see, so a
 * duplicate that only existed in the UI's own state would still be caught.
 */

const t = createTranslator('zh-CN');

/**
 * Mounts the real App on the permission scenario, with `respond` counted.
 *
 * The fixture's own `respond` is wrapped rather than replaced: the dialog closes
 * because the fixture emits `permission.resolved`, and a stub that only counted
 * calls would leave the prompt on screen and turn this into a test about the
 * stub.
 */
function mount() {
  const fixture = createFixtureApi('permission');
  const respond = vi.fn(fixture.api.permissions.respond);
  const api = { ...fixture.api, permissions: { ...fixture.api.permissions, respond } };
  (window as unknown as Record<string, unknown>).ucad = api;
  return { ...render(<App />), fixture, respond };
}

/** The decisions the log carries for the fixture's one request. */
async function resolvedDecisions(fixture: ReturnType<typeof createFixtureApi>) {
  const log = await fixture.api.events.since({ sessionId: 'sess-1', afterSeq: 0 });
  return log
    .filter((event) => event.type === 'permission.resolved')
    .map((event) => (event.payload as { decision: string }).decision);
}

describe('the permission prompt answers once per request', () => {
  it('sends one response when 拒绝 is clicked twice in the same frame', async () => {
    const { fixture, respond } = mount();
    const dialog = await screen.findByRole('dialog');
    const deny = within(dialog).getByRole('button', { name: t('permission.deny') });

    // One tick, two clicks: the frame the `busy` state guard could not see.
    act(() => {
      deny.click();
      deny.click();
    });

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(respond.mock.calls.length, 'two clicks sent two responses').toBe(1);
    expect(await resolvedDecisions(fixture), 'the log carries two decisions').toEqual(['deny']);
  });

  it('still answers the next request after the first one settles', async () => {
    // The guard is a ref, and a ref that is never released is a prompt nobody
    // can answer again. This is the other half of the same change: the release
    // has to happen on the path that ends the response, not only on the path
    // that starts it.
    const { respond } = mount();
    const dialog = await screen.findByRole('dialog');
    await act(async () => {
      within(dialog).getByRole('button', { name: t('permission.deny') }).click();
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(respond.mock.calls.length).toBe(1);

    // A second request arrives on the same session; the prompt must be
    // answerable again rather than silently refusing every click.
    await act(async () => {
      await respond('req-1', 'allow_once');
    });
    expect(respond.mock.calls.length, 'the guard never released').toBe(2);
  });
});
