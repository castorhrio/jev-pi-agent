import { describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '@renderer/App';
import { createFixtureApi } from '@renderer/dev/fixture-bridge';
import type { UcadApi } from '@ucad/contracts';

/**
 * Choosing a vendor per turn (RESEARCH §1, "切换成本降到一次点击").
 *
 * Until this existed the app could not pick a vendor at all: the composer chose
 * an *agent* and nothing chose a provider, so `sendTurn` always fell through to
 * `session.providerId`. A user with two vendors configured had no way to say
 * which one this turn should use without leaving the surface.
 *
 * Two properties are worth pinning, and one of them is a decision rather than a
 * feature:
 *
 *  - unsupported providers are not offered. Listing a vendor this build cannot
 *    speak is offering something that cannot work.
 *  - "no override" is the default and the first option. A picker that always
 *    has a value would silently change behaviour for anyone who never touched
 *    it, which is the worst kind of default.
 */

type Fixture = ReturnType<typeof createFixtureApi>;

function mount() {
  const fixture: Fixture = createFixtureApi('default');
  (window as unknown as Record<string, unknown>).ucad = fixture.api;
  return { ...render(<App />), api: fixture.api as UcadApi };
}

async function settle() {
  await waitFor(() => expect(screen.getAllByText(/jev-pi-agent/).length).toBeGreaterThan(0), {
    timeout: 5000,
  });
}

/** The composer's vendor picker, located by its accessible name. */
async function providerPicker(): Promise<HTMLSelectElement> {
  return (await screen.findByRole('combobox', { name: '供应商' })) as HTMLSelectElement;
}

describe('provider picker (RESEARCH §1 one-click switching)', () => {
  it('offers a no-override option first and selects it by default', async () => {
    mount();
    await settle();

    const picker = await providerPicker();
    const options = within(picker).getAllByRole('option') as HTMLOptionElement[];

    // Absent a choice, a turn must behave exactly as it did before the picker
    // existed. The runtime resolves `input.providerId ?? session.providerId`,
    // so an empty string would name a provider that does not exist.
    expect(options[0]!.value).toBe('');
    expect(options[0]!.textContent).toBe('跟随 Agent / 会话');
    expect(picker.value).toBe('');
  });

  it('never offers a provider this build cannot speak', async () => {
    mount();
    await settle();

    const picker = await providerPicker();
    const values = (within(picker).getAllByRole('option') as HTMLOptionElement[]).map((o) => o.value);

    // `anthropic` is `transport: 'unsupported'` in the fixture. Offering it
    // would be offering a selection that cannot succeed.
    expect(values).not.toContain('anthropic');
    // …and the ones that can be called are offered.
    expect(values).toContain('openai');
    expect(values).toContain('deepseek');
    expect(values).toContain('local');
  });

  it('sends the chosen provider with the turn', async () => {
    const user = userEvent.setup();
    const { api } = mount();
    await settle();

    const sent: Array<{ providerId?: string }> = [];
    const real = api.sessions.send;
    (api.sessions as { send: unknown }).send = (input: { providerId?: string }) => {
      sent.push(input);
      return real(input as never);
    };

    const picker = await providerPicker();
    await user.selectOptions(picker, 'deepseek');
    // An empty objective is dropped before it reaches the transport, so the
    // picker could look broken when in fact nothing was sent.
    await user.type(screen.getByPlaceholderText(/描述任务/), 'ship it');
    await user.click(screen.getByRole('button', { name: '发送' }));

    await waitFor(() => expect(sent.length).toBeGreaterThan(0));
    expect(sent[0]!.providerId).toBe('deepseek');
  });

  it('omits providerId entirely when the user expresses no preference', async () => {
    const user = userEvent.setup();
    const { api } = mount();
    await settle();

    const sent: Array<{ providerId?: string; hasProviderKey: boolean }> = [];
    const real = api.sessions.send;
    (api.sessions as { send: unknown }).send = (input: Record<string, unknown>) => {
      sent.push({
        providerId: input.providerId as string | undefined,
        hasProviderKey: 'providerId' in input,
      });
      return real(input as never);
    };

    await user.type(screen.getByPlaceholderText(/描述任务/), 'ship it');
    await user.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(sent.length).toBeGreaterThan(0));

    // Not `providerId: ''` — the key must be absent, so the runtime falls
    // through to the session's own provider.
    expect(sent[0]!.hasProviderKey).toBe(false);
  });

  it('sends an explicit choice to settings so it can be remembered', async () => {
    const user = userEvent.setup();
    const { api } = mount();
    await settle();

    const patches: unknown[] = [];
    const realPatch = api.settings.patch;
    (api.settings as { patch: unknown }).patch = (next: unknown) => {
      patches.push(next);
      return realPatch(next as never);
    };

    const picker = await providerPicker();
    await user.selectOptions(picker, 'openai');

    // This asserts the preference is *handed to settings*, not that it
    // survives a restart. The fixture bridge is in-memory by construction, so
    // durability is unobservable here — a reload builds a fresh bridge. The
    // round trip through a real store is proven in
    // `tests/integration/storage-migration.test.ts`'s settings sibling instead.
    // Claiming more here would be claiming something this harness cannot see.
    await waitFor(() => expect(patches.length).toBeGreaterThan(0));
    expect(patches[0]).toEqual({ provider: { defaultProviderId: 'openai' } });
  });

  it('records "no preference" as an empty id, never a made-up vendor', async () => {
    const user = userEvent.setup();
    const { api } = mount();
    await settle();

    const patches: Array<{ provider?: { defaultProviderId?: string } }> = [];
    const realPatch = api.settings.patch;
    (api.settings as { patch: unknown }).patch = (next: unknown) => {
      patches.push(next as never);
      return realPatch(next as never);
    };

    const picker = await providerPicker();
    await user.selectOptions(picker, 'openai');
    await user.selectOptions(picker, '');

    await waitFor(() => expect(patches.length).toBeGreaterThanOrEqual(2));
    // An empty string is the honest encoding of "no preference" and mirrors
    // `defaultAgentId`. Inventing a placeholder vendor id would be exactly the
    // kind of fabrication NFR-04 forbids.
    expect(patches.at(-1)).toEqual({ provider: { defaultProviderId: '' } });
  });

  it('marks the provider the session will use on its settings card', async () => {
    const user = userEvent.setup();
    mount();
    await settle();

    const picker = await providerPicker();
    await user.selectOptions(picker, 'deepseek');

    await user.click(within(screen.getAllByRole('navigation')[0]!).getByRole('button', { name: /更多/ }));
    await user.click(await screen.findByRole('menuitem', { name: '设置' }));
    // Wait for a *row*, not the card heading. The heading is static markup and
    // is on screen the instant the surface mounts, while the rows arrive after
    // the provider list resolves — so waiting on the heading and then asserting
    // on row content is a race. (This is the third time this session that
    // "waited for the wrong thing" has cost a red test; the shape is now
    // recognisable enough to be worth naming.)
    await screen.findByText('DeepSeek');

    // The marker is derived from the same value the send path uses, so it
    // cannot describe something other than what a turn would really do.
    const inUse = screen.getAllByText('本会话正在用');
    expect(inUse).toHaveLength(1);
    const row = inUse[0]!.closest('tr') as HTMLElement;
    expect(within(row).getByText('DeepSeek')).toBeTruthy();
  });
});
