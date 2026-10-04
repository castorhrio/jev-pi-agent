import { describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { App } from '@renderer/App';
import { createFixtureApi } from '@renderer/dev/fixture-bridge';
import { createTranslator } from '../../apps/desktop/src/shared/i18n';

/**
 * Accessibility, as a gate.
 *
 * The permission dialog got a real `role="dialog"`, `aria-modal`, focus trap
 * and `role="alert"` in round 5 — and the other fourteen surfaces got nothing,
 * because nothing checked. This scans every surface with axe-core.
 *
 * axe is deliberately a floor, not a ceiling: it catches missing names, broken
 * roles and colour-independent structural problems. It cannot judge whether a
 * layout reads well, so it does not replace looking at the app.
 */

declare global {
  interface Window {
    __axeCleaned: boolean;
  }
}

const t = createTranslator('zh-CN');

function mount(scenario: Parameters<typeof createFixtureApi>[0] = 'default') {
  const fixture = createFixtureApi(scenario);
  (window as unknown as Record<string, unknown>).ucad = fixture.api;
  return render(<App />);
}

async function settle() {
  await waitFor(() => expect(screen.getAllByText(/jev-pi-agent/).length).toBeGreaterThan(0), {
    timeout: 5000,
  });
}

interface Violation {
  id: string;
  impact: string | null;
  help: string;
  nodes: Array<{ html: string; target: string[] }>;
}

async function scan(label: string, sink: Violation[]): Promise<void> {
  const results = await axe.run(document.body, {
    // The renderer is a single page with no iframes; running the full rule set
    // is affordable at this scale.
    resultTypes: ['violations'],
  });
  for (const v of results.violations as unknown as Violation[]) {
    sink.push({
      id: v.id,
      impact: v.impact ?? null,
      help: v.help,
      nodes: v.nodes.map((n) => ({ html: n.html.slice(0, 160), target: n.target })),
    });
  }
  void label;
}

const format = (list: Violation[]): string =>
  list
    .map(
      (v) =>
        `  [${v.impact ?? 'unknown'}] ${v.id} — ${v.help}\n` +
        v.nodes.map((n) => `      ${n.target.join(' ')}\n      ${n.html}`).join('\n'),
    )
    .join('\n');

const MORE = new Set([
  '交接',
  '用量',
  '终端',
  '代码理解',
  'MCP',
  '存储',
  '项目',
  '设置',
  '诊断',
  '帮助',
]);

function nav(): HTMLElement {
  return screen.getAllByRole('navigation')[0]!;
}

describe('accessibility — the scan must actually cover the app', () => {
  it('renders the preview column during the scan', async () => {
    /*
     * The scan reports "no violations" about whatever is *in the document*. If
     * a media query has hidden half the app, the honest result and the useless
     * result are identical — and this file once produced the useless one for
     * weeks: the viewport silently stayed at 1024px, the preview column is
     * `display: none` below 1180px, happy-dom applies media queries, so an
     * entire column was never scanned while the report said clean.
     *
     * So the coverage is asserted rather than assumed. If someone lowers the
     * viewport, or a new breakpoint starts hiding a column, this goes red
     * before the "clean" result becomes a lie.
     */
    mount();
    await settle();

    const preview = document.querySelector('.preview');
    expect(preview, 'the preview column is missing from the DOM entirely').not.toBeNull();
    const display = getComputedStyle(preview as Element).display;
    expect(
      display,
      `the preview column is display:${display} at ${window.innerWidth}px, so the ` +
        'accessibility scan is not covering it',
    ).not.toBe('none');
  });

  it('has no automatically detectable violations', async () => {
    const user = userEvent.setup();
    mount();
    await settle();

    const violations: Violation[] = [];
    await scan('shell', violations);

    const surfaces: Array<{ label: string; titleKey: string | null }> = [
      { label: '文件', titleKey: 'tab.explorer' },
      { label: '变更', titleKey: 'tab.changes' },
      { label: '上下文', titleKey: 'context.title' },
      { label: '决策', titleKey: 'decision.title' },
      { label: '交接', titleKey: 'handoff.title' },
      { label: '用量', titleKey: 'usage.title' },
      { label: '终端', titleKey: 'terminal.title' },
      { label: '代码理解', titleKey: 'intel.title' },
      { label: 'MCP', titleKey: 'mcp.title' },
      { label: '存储', titleKey: 'retention.title' },
      { label: '项目', titleKey: 'recent.title' },
      { label: '设置', titleKey: 'settings.title' },
      { label: '诊断', titleKey: 'diagnostics.title' },
      { label: '帮助', titleKey: 'help.title' },
    ];

    for (const { label, titleKey } of surfaces) {
      if (MORE.has(label)) {
        await user.click(within(nav()).getByRole('button', { name: /更多/ }));
        await user.click(await screen.findByRole('menuitem', { name: label }));
      } else {
        await user.click(within(nav()).getByRole('button', { name: new RegExp(`^${label}`) }));
      }
      if (titleKey) await screen.findByRole('heading', { level: 1, name: t(titleKey) });
      // Let the surface's own data arrive, or its a11y state is not the real one.
      await new Promise((resolve) => setTimeout(resolve, 250));
      await scan(label, violations);
    }

    expect(violations, `accessibility violations:\n${format(violations)}`).toEqual([]);
  });

  it('names every interactive control', async () => {
    // A control with no accessible name is announced as "button" or "plus",
    // which tells a screen-reader user nothing about what it does.
    mount();
    await settle();

    const unnamed: string[] = [];
    const controls = document.querySelectorAll('button, [role="button"], select, input');
    for (const el of Array.from(controls)) {
      const html = (el as HTMLElement).outerHTML.slice(0, 120);
      const name =
        el.getAttribute('aria-label') ??
        el.getAttribute('title') ??
        (el as HTMLElement).innerText?.trim() ??
        '';
      // A labelled-by or a wrapping label counts too.
      const labelled =
        (el.getAttribute('aria-labelledby') !== null) ||
        (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`) !== null) ||
        el.closest('label') !== null;
      if (!name && !labelled) unnamed.push(html);
    }

    expect(unnamed, 'controls with no accessible name').toEqual([]);
  });
});
