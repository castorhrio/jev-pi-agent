import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nProvider } from '@renderer/i18n-context';
import { PanelBoundary } from '@renderer/components/PanelBoundary';
import { createFixtureApi } from '@renderer/dev/fixture-bridge';
import type { ReactNode } from 'react';

/**
 * The boundary is the difference between "one panel is broken" and "the app is
 * a blank window". It is easy to write and easy to delete by accident, and
 * nothing else in the suite would notice: the other tests only ever render
 * panels that work, so removing the boundary would not fail a single one of
 * them. It therefore gets tested directly, by throwing on purpose.
 */

function Boom({ message }: { message: string }): ReactNode {
  throw new Error(message);
}

function Host({ children }: { children: ReactNode }): JSX.Element {
  const { api } = createFixtureApi('default');
  (window as unknown as Record<string, unknown>).ucad = api;
  return <I18nProvider api={api}>{children}</I18nProvider>;
}

describe('PanelBoundary', () => {
  it('renders its children when they are healthy', () => {
    render(
      <Host>
        <PanelBoundary label="Panel">
          <div>panel content</div>
        </PanelBoundary>
      </Host>,
    );
    expect(screen.getByText('panel content')).toBeTruthy();
  });

  it('shows a readable failure instead of unmounting the tree', async () => {
    // React logs the caught error; silence it so the run stays legible. The
    // behaviour under test is the fallback, not the console.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    render(
      <Host>
        <div>sibling that must survive</div>
        <PanelBoundary label="Context">
          <Boom message="plan.profile is undefined" />
        </PanelBoundary>
      </Host>,
    );

    // The whole point: what is *outside* the boundary is still on screen.
    // Before the boundary existed, this string vanished too — along with the
    // session list, the composer and the status bar.
    expect(screen.getByText('sibling that must survive')).toBeTruthy();

    // The reason is stated, not hidden. A failure the user cannot read is the
    // same silent degradation this repo keeps removing elsewhere.
    // It appears twice by design: once in the notice, once inside the
    // collapsed stack for a bug report.
    await waitFor(() => {
      expect(screen.getAllByText(/plan\.profile is undefined/).length).toBeGreaterThan(0);
    });
    expect(screen.getByText(/Context/)).toBeTruthy();

    spy.mockRestore();
  });

  it('records the failure so it can be quoted in a bug report', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(
      <Host>
        <PanelBoundary label="Storage">
          <Boom message="db closed" />
        </PanelBoundary>
      </Host>,
    );

    // Main has no view of a renderer stack, so this log is the only record.
    await waitFor(() => {
      expect(spy).toHaveBeenCalledWith(
        '[ucad] panel render failed',
        'Storage',
        expect.any(Error),
        expect.anything(),
      );
    });
    spy.mockRestore();
  });

  it('can be retried, and the retry button is reachable by name', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const user = userEvent.setup();

    let shouldThrow = true;
    function Flaky(): ReactNode {
      if (shouldThrow) throw new Error('first attempt failed');
      return <div>recovered</div>;
    }

    render(
      <Host>
        <PanelBoundary label="MCP" resetKey={shouldThrow}>
          <Flaky />
        </PanelBoundary>
      </Host>,
    );

    await waitFor(() => expect(screen.getByRole('button', { name: /重试|Retry/ })).toBeTruthy());

    shouldThrow = false;
    await user.click(screen.getByRole('button', { name: /重试|Retry/ }));

    await waitFor(() => expect(screen.getByText('recovered')).toBeTruthy());
    spy.mockRestore();
  });
});
