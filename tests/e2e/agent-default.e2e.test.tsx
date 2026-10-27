import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '@renderer/App';
import { createFixtureApi } from '@renderer/dev/fixture-bridge';
import type { UcadApi } from '@ucad/contracts';

/**
 * The agent picker follows the user, not the last settings refresh.
 *
 * The effect that seeds it from `settings.agent.defaultAgentId` used to run on
 * every settings change with no guard on the current value. Saving anything —
 * a provider preference, a window behaviour — produced a new snapshot and put
 * the remembered default back under the user, mid-session. The picker then
 * named a different agent from the one they had chosen for the turn.
 *
 * These tests pin both halves: the default still seeds an untouched picker,
 * and a change to it leaves an explicit choice alone.
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

async function agentPicker(): Promise<HTMLSelectElement> {
  return (await screen.findByRole('combobox', { name: 'Agent' })) as HTMLSelectElement;
}

describe('agent default', () => {
  it('seeds the picker from the remembered default', async () => {
    mount();
    await settle();

    const picker = await agentPicker();
    await waitFor(() => expect(picker.value).toBe('universal'));
  });

  it('falls back to the first catalogued agent when no default is remembered', async () => {
    const fixture = createFixtureApi('default');
    // An empty `defaultAgentId` means "not chosen yet"; it is never sent as an
    // agent id, and the catalogue's first entry is the honest fallback.
    await fixture.api.settings.patch({ agent: { defaultAgentId: '' } });
    (window as unknown as Record<string, unknown>).ucad = fixture.api;

    render(<App />);
    await settle();

    const picker = await agentPicker();
    await waitFor(() => expect(picker.value).toBe('universal'));
  });

  it('does not overwrite an explicit choice when settings change', async () => {
    const user = userEvent.setup();
    const { api } = mount();
    await settle();

    const picker = await agentPicker();
    await waitFor(() => expect(picker.value).toBe('universal'));

    await user.selectOptions(picker, 'mock');
    expect(picker.value).toBe('mock');

    // A settings write produces a new snapshot; the next data refresh is the
    // moment the unguarded effect used to reset the picker. The permission
    // mode rides the same snapshot, so waiting for its picker to change is how
    // this test knows that render landed — not merely that the write returned.
    await api.settings.patch({
      agent: { defaultAgentId: 'universal', permissionMode: 'workspace_write' },
    });
    await user.click(screen.getByRole('button', { name: '新建会话' }));

    const permission = (await screen.findByRole('combobox', {
      name: '权限模式',
    })) as HTMLSelectElement;
    await waitFor(() => expect(permission.value).toBe('workspace_write'));

    expect(picker.value, 'a settings refresh overwrote the agent the user chose').toBe('mock');
  });
});
