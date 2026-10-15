import { describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '@renderer/App';
import { createFixtureApi } from '@renderer/dev/fixture-bridge';

/**
 * Explorer reads that fail — said out loud, not rendered as an empty directory.
 *
 * `ReadFailure` was introduced precisely for this: its doc comment says the
 * four places it first appeared "all failed the same way: the value came back
 * empty and the panel said so as if it were a fact". The Explorer's three reads
 * were never moved onto it, so:
 *
 *   - a permission error on the workspace directory rendered the list column as
 *     `选择左侧的文件查看内容` with nothing in it, and
 *   - an unreadable file put *the same sentence* in the main pane — telling the
 *     user to select a file they had just selected.
 *
 * Both were measured in a real browser with the two reads rejecting: no notice,
 * no toast, and not even a console error, because the rejections were caught and
 * discarded.
 */

type Fixture = ReturnType<typeof createFixtureApi>;

function mount(scenario: Parameters<typeof createFixtureApi>[0] = 'default') {
  const fixture: Fixture = createFixtureApi(scenario);
  (window as unknown as Record<string, unknown>).ucad = fixture.api;
  return { ...render(<App />), fixture };
}

async function settle() {
  await waitFor(() => expect(screen.getAllByText(/jev-pi-agent/).length).toBeGreaterThan(0), {
    timeout: 5000,
  });
}

async function openExplorer(user: ReturnType<typeof userEvent.setup>) {
  const nav = screen.getAllByRole('navigation')[0]!;
  await user.click(within(nav).getByRole('button', { name: /^文件/ }));
  await screen.findByText('项目信任', { selector: 'h2' });
}

/**
 * A row in the split list that is a file, i.e. has no disclosure caret.
 *
 * Waits for the listing first: the panel's heading renders before `files.list`
 * resolves, so querying straight after it is a race.
 */
async function firstFileRow(): Promise<HTMLElement> {
  await waitFor(() =>
    expect(document.querySelector('.split-list .tree-row')).toBeTruthy(),
  );
  const rows = Array.from(document.querySelectorAll('.split-list .tree-row'));
  const file = rows.find((row) => (row.querySelector('.caret')?.textContent ?? '').trim() === '');
  expect(file, 'the fixture listed no file to open').toBeTruthy();
  return file as HTMLElement;
}

describe('explorer reads that fail', () => {
  it('reports an unreadable directory instead of showing an empty one', async () => {
    const user = userEvent.setup();
    const { fixture } = mount();
    await settle();

    (fixture.api.files as { list: unknown }).list = () =>
      Promise.reject(new Error('EACCES: permission denied, scandir /work/jev-pi-agent'));
    await openExplorer(user);

    // Named and reasoned, as an alert so a screen reader hears the change.
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('目录读取失败');
    expect(alert.textContent).toContain('EACCES: permission denied');

    // And the "select a file" copy is gone: an empty list and an unreadable
    // list are different facts and must not read the same.
    expect(within(document.querySelector('.split-list') as HTMLElement).queryByText(
      '选择左侧的文件查看内容。',
    )).toBeNull();
  });

  it('reports an unreadable file instead of asking the user to pick one', async () => {
    const user = userEvent.setup();
    const { fixture } = mount();
    await settle();

    // Only the read fails: the listing has to succeed for there to be a row to
    // click, which is what makes this the case a user actually hits.
    (fixture.api.files as { read: unknown }).read = () =>
      Promise.reject(new Error('ENOENT: no such file or directory'));
    await openExplorer(user);

    await user.click(await firstFileRow());

    const alerts = await screen.findAllByRole('alert');
    const alert = alerts.find((node) => node.textContent?.includes('文件读取失败'));
    expect(alert, 'the failed read was not reported').toBeTruthy();
    expect(alert?.textContent).toContain('ENOENT');

    // The main pane must not claim nothing is selected.
    const main = document.querySelector('.split-main') as HTMLElement;
    expect(within(main).queryByText('选择左侧的文件查看内容。')).toBeNull();
  });
});
