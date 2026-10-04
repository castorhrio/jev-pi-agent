import { describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '@renderer/App';
import { createFixtureApi } from '@renderer/dev/fixture-bridge';
import type { UcadApi } from '@ucad/contracts';

/**
 * The provider card's status and quota columns, in a DOM.
 *
 * RESEARCH §1 says to copy one thing from CC Switch: put the vendor's health
 * and quota **on the card**, at the moment the user decides which vendor to
 * use, instead of behind a click in a settings page. §V-3 requires the second
 * half of that to be honest — when the vendor does not expose a number, the
 * card says so instead of showing a blank that reads as zero.
 *
 * These are the states that can only be checked by rendering them, and they map
 * one-to-one onto a defect that shipped: the card used to show the main
 * process's English sentence verbatim inside a Chinese interface, and a bad
 * credential looked exactly like an unreachable host.
 */

type Fixture = ReturnType<typeof createFixtureApi>;

function mount(scenario: Parameters<typeof createFixtureApi>[0] = 'default') {
  const fixture: Fixture = createFixtureApi(scenario);
  (window as unknown as Record<string, unknown>).ucad = fixture.api;
  return { ...render(<App />), fixture, api: fixture.api as UcadApi };
}

async function settle() {
  await waitFor(() => expect(screen.getAllByText(/jev-pi-agent/).length).toBeGreaterThan(0), {
    timeout: 5000,
  });
}

function nav() {
  // Two `<nav>` elements exist (the rail and the preview's own), so the first
  // is the one carrying the surface buttons.
  return screen.getAllByRole('navigation')[0]!;
}

/**
 * Opens the settings surface through the real More menu.
 *
 * The wait is on a *row*, not on the card heading: the table's `<thead>` is
 * static markup and is on screen the instant the surface mounts, so waiting for
 * it proves nothing about the data. The fixture resolves in ~120 ms, and
 * asserting row contents before that lands fails for a reason that has
 * nothing to do with what is being tested.
 */
async function openSettings(user: ReturnType<typeof userEvent.setup>) {
  await user.click(within(nav()).getByRole('button', { name: /更多/ }));
  await user.click(await screen.findByRole('menuitem', { name: '设置' }));
  await waitFor(() => expect(screen.getAllByText('OpenAI').length).toBeGreaterThan(0), {
    timeout: 5000,
  });
}

/** The provider table, located by its heading so row lookups stay scoped. */
function providerTable(): HTMLElement {
  const heading = screen.getAllByText('模型供应商')[0]!;
  const card = heading.closest('.card');
  if (card === null) throw new Error('provider card not found');
  return card as HTMLElement;
}

/**
 * One provider's summary row, found by display name.
 *
 * Scoping to the summary row (and not the whole table) is what lets a test
 * assert "this row is fully localized" without tripping over another row that
 * has not been probed yet.
 */
function rowByName(name: string): HTMLElement {
  const row = within(providerTable())
    .getAllByRole('row')
    .find((r) => within(r).queryByText(name));
  if (row === undefined) throw new Error(`provider row not found: ${name}`);
  return row;
}

/**
 * One cell of a row, located **by its column header**.
 *
 * Several columns legitimately hold the same text — the model count and the
 * status cell are both "—" for an unwired provider — so asserting on the row's
 * text alone cannot say which column regressed. This walks the header row for
 * the index, which is why a column can be renamed or reordered without
 * silently moving every assertion onto a different cell.
 */
function cellIn(row: HTMLElement, columnHeader: string): HTMLElement {
  const headers = within(providerTable().querySelector('thead')!).getAllByRole('columnheader');
  const index = headers.findIndex((h) => h.textContent?.trim() === columnHeader);
  if (index < 0) throw new Error(`column not found: ${columnHeader}`);
  const cells = within(row).getAllByRole('cell');
  const cell = cells[index];
  if (cell === undefined) throw new Error(`no cell at ${columnHeader} in row`);
  return cell;
}

describe('provider status and quota (RESEARCH §1, V-3)', () => {
  it('shows status and quota columns on every row', async () => {
    const user = userEvent.setup();
    mount();
    await settle();
    await openSettings(user);

    const table = providerTable();
    // Both columns exist as headers, so the values are not unlabelled text.
    expect(within(table).getByRole('columnheader', { name: '状态' })).toBeTruthy();
    expect(within(table).getByRole('columnheader', { name: '额度' })).toBeTruthy();
  });

  it('starts every row at "not probed" rather than claiming health', async () => {
    const user = userEvent.setup();
    mount();
    await settle();
    await openSettings(user);

    const table = providerTable();
    // The three supported fixture rows have not been probed. A row that has
    // not been probed must not render a green badge: silence that reads as
    // "fine" is the V-3 failure mode.
    expect(within(table).getAllByText('未探测')).toHaveLength(3);
    expect(within(table).queryByText('可用')).toBeNull();
    // And nothing claims a quota it does not have.
    expect(within(table).queryByText('已耗尽')).toBeNull();
  });

  it('renders a healthy probe with its latency, and says the quota is not provided', async () => {
    const user = userEvent.setup();
    mount();
    await settle();
    await openSettings(user);

    const openaiRow = rowByName('OpenAI');
    await user.click(within(openaiRow).getByRole('button', { name: '探测' }));

    const status = cellIn(openaiRow, '状态');
    await waitFor(() => expect(status.textContent).toContain('可用'));
    expect(status.textContent).toMatch(/\d+ms/);
    // Reachable is not the same as funded: the protocol exposes no balance,
    // and the card says so rather than leaving a cell a user reads as zero.
    expect(cellIn(openaiRow, '额度').textContent?.trim()).toBe('未提供');
  });

  it('distinguishes an exhausted quota from a credential problem', async () => {
    const user = userEvent.setup();
    mount();
    await settle();
    await openSettings(user);

    const rowFor = (name: string) => rowByName(name);

    // 402: the one case where the product genuinely knows about the balance.
    const deepseek = rowFor('DeepSeek');
    await user.click(within(deepseek).getByRole('button', { name: '探测' }));
    const deepseekStatus = cellIn(deepseek, '状态');
    await waitFor(() => expect(deepseekStatus.textContent).toContain('额度已耗尽'));
    // The vendor refused for billing, so the quota cell reports that rather
    // than falling back to "not provided".
    expect(cellIn(deepseek, '额度').textContent?.trim()).toBe('已耗尽');

    // A missing credential is a different problem with a different fix, and
    // it must not be rendered as a quota verdict.
    const local = rowFor('Local (Ollama / LM Studio)');
    await user.click(within(local).getByRole('button', { name: '探测' }));
    const localStatus = cellIn(local, '状态');
    await waitFor(() => expect(localStatus.textContent).toContain('凭据无效或缺失'));
    expect(cellIn(local, '额度').textContent?.trim()).toBe('未提供');
  });

  it('never renders the main process English sentence on the collapsed card', async () => {
    const user = userEvent.setup();
    mount();
    await settle();
    await openSettings(user);

    const deepseek = rowByName('DeepSeek');
    await user.click(within(deepseek).getByRole('button', { name: '探测' }));
    await waitFor(() => expect(within(deepseek).getByText('已耗尽')).toBeTruthy());

    // The whole collapsed row must be readable without knowing English. The
    // assertion is on the row rather than on the status cell alone: `已耗尽`
    // also appears in the quota column, so a cell-scoped lookup would happily
    // pass while the status cell regressed back to the English sentence.
    // (That is not hypothetical — this test passed a broken build exactly
    // once before it was scoped to the row.)
    //
    // Only the probe *verdict* is asserted here. `notes` is vendor-supplied
    // documentation shown verbatim by design, and a vendor that documents
    // itself in English is not a localization bug.
    expect(deepseek.textContent ?? '').not.toMatch(/refused the request for billing/i);
    expect(deepseek.textContent ?? '').not.toMatch(/Check the account balance/i);
  });

  it('says plainly that an unwired provider was never probed', async () => {
    const user = userEvent.setup();
    mount();
    await settle();
    await openSettings(user);

    const anthropic = rowByName('Anthropic');
    const status = cellIn(anthropic, '状态');

    // No green badge and no "unreachable": no request was ever attempted, so
    // there is no health verdict to report. The status cell is an em dash —
    // the same convention the model count uses for "we do not have this" —
    // and the 未接入 badge beside the name is what tells the user why.
    expect(status.textContent?.trim()).toBe('—');
    expect(within(anthropic).getByText('未接入')).toBeTruthy();
    expect(status.textContent).not.toContain('可用');
    expect(status.textContent).not.toContain('未探测');

    // The probe button stays disabled — there is no transport to probe with.
    expect(within(anthropic).getByRole('button', { name: '探测' })).toHaveProperty(
      'disabled',
      true,
    );
  });
});
