import { describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '@renderer/App';
import { createFixtureApi } from '@renderer/dev/fixture-bridge';
import { createTranslator } from '../../apps/desktop/src/shared/i18n';
import type { UcadApi } from '@ucad/contracts';

/**
 * The main path, end to end, in a DOM.
 *
 * Each test here corresponds to a defect that actually shipped:
 *  - "no sessions" vs "could not read sessions"  → round 2
 *  - a menu command with no renderer handler       → round 1
 *  - a conversation that stays blank with no error → round 1
 *
 * The point is not coverage for its own sake. It is that these three
 * regressions cannot come back without a red run.
 */

type Fixture = ReturnType<typeof createFixtureApi>;

/** Mounts the real App against a fixture transport. */
function mount(scenario: Parameters<typeof createFixtureApi>[0] = 'default') {
  const fixture: Fixture = createFixtureApi(scenario);
  (window as unknown as Record<string, unknown>).ucad = fixture.api;
  const utils = render(<App />);
  return { ...utils, fixture, api: fixture.api as UcadApi };
}

/** Waits for the first data load to settle (the fixture resolves in ~120 ms). */
async function settle() {
  await waitFor(
    () => expect(screen.getAllByText(/jev-pi-agent/).length).toBeGreaterThan(0),
    { timeout: 5000 },
  );
}

describe('critical path', () => {
  it('mounts, loads the workspace, and shows the conversation', async () => {
    mount();
    await settle();

    // The session seeded by the fixture must be reachable from the rail.
    await waitFor(() =>
      expect(screen.getAllByText('修复注入哈希不一致').length).toBeGreaterThan(0),
    );
    // Its streamed assistant reply must be rendered, not just the user turn.
    await waitFor(() =>
      expect(screen.getAllByText(/renderContextPack/).length).toBeGreaterThan(0),
    );
  });

  it('does not show a phantom bridge error when the preload is absent', async () => {
    // `App` renders `BridgeMissing` when `window.ucad` is unset. The harness
    // always sets it, so that fallback must never appear — a screenshot of it
    // in CI would mean the harness silently stopped testing the real app.
    mount();
    await settle();
    expect(screen.queryByText(/UCAD bridge unavailable/i)).toBeNull();
  });

  it('creates and selects a new session when + is clicked with one already open', async () => {
    // The rail's "+" used to route through the same `ensureSession` the
    // composer sends through, which returns the *current* session when one is
    // selected — so the button labelled 新建会话 did nothing at all for
    // anyone with an open session, silently, with no feedback. That is the
    // "a button that does nothing" defect class the harness exists to catch.
    const user = userEvent.setup();
    const { api } = mount();
    await settle();

    const plus = screen.getByRole('button', { name: '新建会话' });
    await user.click(plus);

    // The write stuck: the fixture now holds a third session.
    await waitFor(async () => {
      const sessions = await api.sessions.list('ws-1');
      expect(sessions).toHaveLength(3);
    });
    // The created session is the one now selected in the rail.
    await waitFor(() => {
      const row = screen.getByText('新建会话').closest('.row-item');
      expect(row?.className).toContain('active');
    });
  });
});

describe('a sent turn completes — the live event path', () => {
  /**
   * The one path every earlier test skipped: a turn sent *now*, streamed live,
   * and completed live.
   *
   * Every replayed fixture (seed events, the permission scenario) arrives
   * through `events.since`, so the coalescing buffer in `useSessionEvents` was
   * never under test. Its flush used to mint a synthetic seq (`lastSeq + 1`)
   * that collided with the next real event's seq — the reducer dropped that
   * event as already folded. With the fixture completing a turn in one burst,
   * the dropped event was `turn.completed`: the transcript showed the full
   * reply while the composer sat on Stop forever, and the user could not send
   * anything again. The same collision would silently eat a live
   * `permission.requested` or `tool.started` after a streaming burst.
   */
  it('streams the reply and returns the composer to Send', async () => {
    const user = userEvent.setup();
    mount();
    await settle();

    const composer = screen.getByRole('textbox', {
      name: '任务描述',
    }) as HTMLTextAreaElement;
    await user.type(composer, '列出 README 的要点');

    // The composer's own send button, scoped so the rail's other buttons
    // cannot satisfy the lookup.
    const composerForm = composer.closest('.composer') ?? composer.parentElement!;
    const sendButton = within(composerForm as HTMLElement).getByRole('button', {
      name: '发送',
    });
    await user.click(sendButton);

    // The fixture echoes a fixed reply in chunks and completes the turn.
    // The reply arriving proves the live stream folded; the next assertions
    // prove the fold *finished*.
    await waitFor(() =>
      expect(screen.getAllByText(/fixture 回显的内容/).length).toBeGreaterThan(0),
    );

    // `turn.completed` must survive the coalescing buffer: the composer
    // returns to Send (it flips to Stop the moment the turn starts). Before
    // the fix this assertion timed out — status stayed RUNNING forever.
    await waitFor(() =>
      expect(
        within(composerForm as HTMLElement).getByRole('button', { name: '发送' }),
      ).toBeInTheDocument(),
      { timeout: 5000 },
    );
  });

  it('reports no gap the fixture did not fabricate', async () => {
    const user = userEvent.setup();
    mount();
    await settle();

    const composer = screen.getByRole('textbox', { name: '任务描述' });
    await user.type(composer, '再发一轮');
    await user.click(
      within((composer.closest('.composer') ?? composer.parentElement!) as HTMLElement).getByRole(
        'button',
        { name: '发送' },
      ),
    );

    await waitFor(() =>
      expect(screen.getAllByText(/fixture 回显的内容/).length).toBeGreaterThan(0),
    );

    // The fixture must continue the session's real seq. It used to restart
    // live turns at 101, which rendered the honesty banner on every turn —
    // the renderer faithfully reporting a hole only the harness had made.
    await waitFor(() => expect(screen.queryByText(/事件流有/)).toBeNull());
  });

  it('fills the preview column from the replayed stream and keeps it filled after a live turn', async () => {
    // The preview column is the product's reason to exist: what the agent
    // actually received, next to what it says. It reads `view.context`, which
    // only a folded `context.pack.built` can populate — the main context page
    // reads back by turn id, so it stays fed even when this chain is broken.
    // This is the assertion that watches the whole chain: event → reducer →
    // pane, on both paths the events arrive by.
    const user = userEvent.setup();
    mount();
    await settle();

    const preview = document.querySelector('.preview') as HTMLElement;
    // Replayed history carries an E-4 event, so the pack is visible before any
    // turn is sent — not behind the waiting copy. The item names arrive one
    // fetch later (the pack is read back by its id), so both get a wait.
    await waitFor(() => expect(within(preview).getByText('hybrid')).toBeTruthy());
    await waitFor(() =>
      expect(within(preview).getAllByText(/broker\.ts/).length).toBeGreaterThan(0),
    );

    const composer = screen.getByRole('textbox', {
      name: '任务描述',
    }) as HTMLTextAreaElement;
    await user.type(composer, '这轮实际收到了什么');
    await user.click(
      within((composer.closest('.composer') ?? composer.parentElement!) as HTMLElement).getByRole(
        'button',
        { name: '发送' },
      ),
    );

    // A live turn builds its own pack; the column must not fall back to the
    // waiting state once it has shown one.
    await waitFor(() =>
      expect(screen.getAllByText(/fixture 回显的内容/).length).toBeGreaterThan(0),
    );
    expect(within(preview).getByText('hybrid')).toBeTruthy();
    expect(within(preview).queryByText(/发送一轮指令后/)).toBeNull();
  });
});

describe('failures are reported, not disguised as state', () => {
  it('says the session list could not be read instead of "no sessions"', async () => {
    mount('partial');
    await settle();

    // The exact regression from round 2: a failed read rendered as an empty
    // list, so a project with unreadable history looked brand new.
    await waitFor(() =>
      expect(screen.getAllByText(/会话列表读取失败/).length).toBeGreaterThan(0),
    );
    // And the specific reason must be visible, not swallowed.
    expect(screen.getAllByText(/sessions\.list failed/).length).toBeGreaterThan(0);
    // The misleading copy must be gone. `queryByText` returns the element or
    // `null` (it is `queryAllByText` that returns an array).
    expect(screen.queryByText(/还没有会话/)).toBeNull();
  });

  it('shows a full-window error with recovery actions when the core load fails', async () => {
    mount('error');
    await waitFor(() => expect(screen.getAllByText('出错了').length).toBeGreaterThan(0));
    // Three ways out, not a dead end.
    expect(screen.getAllByRole('button', { name: /重试/ }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: /打开项目文件夹/ }).length).toBeGreaterThan(0);
  });

  it('says the permission rules could not be read instead of "no rules"', async () => {
    const user = userEvent.setup();
    mount('partial');
    await settle();

    // The rules list is its own fetch behind the settings surface, so a
    // readable workspace does not mean the rules were readable.
    await user.click(within(nav()).getByRole('button', { name: /更多/ }));
    await user.click(await screen.findByRole('menuitem', { name: '设置' }));

    await waitFor(() =>
      expect(screen.getAllByText(/permissions\.listRules failed/).length).toBeGreaterThan(0),
    );

    // This panel is where a grant is revoked. Rendering the failure as the
    // empty state would tell the user every persistent grant is gone when the
    // truth is that nobody knows — the same lie round 2 caught on the session
    // list, in the one place where the lie has security consequences.
    expect(screen.queryByText(/还没有任何规则/)).toBeNull();
    expect(screen.queryByText(/no rules yet/i)).toBeNull();
  });

  /**
   * The four reads that `refresh` guards individually, all of which used to
   * report a failure as an empty result.
   *
   * These four are one defect wearing four costumes, and the reason the
   * fixtures could not reproduce any of them is the part worth remembering:
   * `diagnostics.info` and `tools.list` were hard-wired to succeed, so the
   * states that mattered most — the ones you only reach when something is
   * already broken — were the two states no test could produce. A scenario
   * that cannot fail is a scenario that cannot prove anything.
   */
  async function openMore(user: ReturnType<typeof userEvent.setup>, label: string) {
    await user.click(within(nav()).getByRole('button', { name: /更多/ }));
    await user.click(await screen.findByRole('menuitem', { name: label }));
  }

  it('says the diagnostics could not be read, and claims nothing about the machine', async () => {
    const user = userEvent.setup();
    mount('partial');
    await settle();

    // This is the page a user opens *because* something is wrong. It is the
    // worst place in the app to answer with a confident false statement.
    await openMore(user, '诊断');

    await waitFor(() =>
      expect(screen.getAllByText(/诊断信息读取失败/).length).toBeGreaterThan(0),
    );
    // The reason travels with the claim.
    expect(screen.getAllByText(/diagnostics\.info failed/).length).toBeGreaterThan(0);

    // Every false statement the old code made here, one by one. The red
    // "not encrypted" badge is the important one: `null` meant the same thing
    // as `false` in that ternary, so an install that is encrypted correctly
    // was told its secrets sit on disk in the clear.
    expect(screen.queryByText('未加密')).toBeNull();
    expect(screen.queryByText(/本次会话还没有日志记录/)).toBeNull();
    // And the runtime card of em dashes is gone with it.
    expect(screen.queryByText('v—')).toBeNull();
  });

  it('shows at-rest encryption as unreadable, not as "not encrypted"', async () => {
    const user = userEvent.setup();
    mount('partial');
    await settle();

    await openMore(user, '设置');

    // Three states, and the middle one used to be missing: encrypted /
    // not encrypted were the only two the UI could express.
    await waitFor(() =>
      expect(screen.getAllByText(/未知：加密状态读取失败/).length).toBeGreaterThan(0),
    );
    expect(screen.queryByText('未加密')).toBeNull();
    expect(screen.queryByText('已加密')).toBeNull();
  });

  it('says the tool list could not be read instead of "none"', async () => {
    const user = userEvent.setup();
    mount('partial');
    await settle();

    await openMore(user, '设置');

    await waitFor(() => expect(screen.getAllByText(/工具列表读取失败/).length).toBeGreaterThan(0));
    // `common.none` is the false claim: it says the agent has no tools, which
    // is an operational fact somebody could act on.
    expect(screen.queryByText('无')).toBeNull();
  });

  it('says usage could not be read instead of "no usage yet"', async () => {
    const user = userEvent.setup();
    mount('partial');
    await settle();

    await openMore(user, '用量');

    await waitFor(() => expect(screen.getAllByText(/用量读取失败/).length).toBeGreaterThan(0));
    // A zero that is really an unreadable number is how a budget gets raised.
    expect(screen.queryByText(/尚无用量记录/)).toBeNull();
  });

  it('says "still loading" rather than "could not be read"', async () => {
    const user = userEvent.setup();
    // The `loading` scenario is the one that makes this reachable, and it is
    // the state most likely to be collapsed into its neighbours: `diagnostics`
    // is `null` here for exactly the same reason it is `null` after a failure,
    // so a `null` check alone cannot tell "not yet" from "never".
    mount('loading');

    await user.click(within(nav()).getByRole('button', { name: /更多/ }));
    await user.click(await screen.findByRole('menuitem', { name: '诊断' }));

    // Caught in self-review of the fix above: the failure branch announced a
    // failure during the ~120 ms before the first read came back.
    await waitFor(() => expect(screen.getAllByText(/加载中/).length).toBeGreaterThan(0));
    expect(screen.queryByText(/诊断信息读取失败/)).toBeNull();
    expect(screen.queryByText('未加密')).toBeNull();
  });
});

/** Reads the real heading text, so re-translating a title cannot break these tests. */
const t = createTranslator('zh-CN');

/** Destinations that live behind the More menu rather than the tab strip. */
const MORE_SURFACES = new Set([
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

/** The primary tab strip. Scoped because the rail reuses several of its labels. */
function nav(): HTMLElement {
  return screen.getAllByRole('navigation')[0]!;
}

async function openSurface(user: ReturnType<typeof userEvent.setup>, label: RegExp) {
  await user.click(within(nav()).getByRole('button', { name: label }));
}

describe('every surface renders', () => {
  /**
   * The sweep that should have existed from the start.
   *
   * The context panel white-screened the entire app for eight rounds while all
   * 22 tests were green, because no test ever opened it. Walking every surface
   * and asserting the crash fallback is absent turns "someone remembered to
   * click it" into a gate.
   *
   * The fallback text is the signal: `PanelBoundary` renders it instead of the
   * panel, so its presence means that surface is broken right now.
   */

  /**
   * Every surface, with the i18n key its own component uses for its `<h1>`.
   *
   * The heading is not decoration: asserting it *positively* is what lets this
   * test catch a crash. An earlier version only checked that the crash
   * fallback was absent, which passed while the panel was still loading — the
   * fixture resolves in ~120 ms, so the check ran before the data arrived and
   * the context white-screen sailed straight through.
   *
   * The expected text is read from the dictionary rather than pasted, so
   * re-translating a heading cannot silently break this test.
   */
  const t = createTranslator('zh-CN');
  const SURFACES: Array<{ label: string; titleKey: string | null }> = [
    { label: '对话', titleKey: null }, // the conversation has no h1
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

  const CRASHED = /面板无法显示|could not be displayed/;

  it('mounts every surface without tripping the crash boundary', async () => {
    const user = userEvent.setup();
    mount();
    await settle();

    const broken: string[] = [];

    for (const { label, titleKey } of SURFACES) {
      if (MORE_SURFACES.has(label)) {
        await user.click(within(nav()).getByRole('button', { name: /更多/ }));
        await user.click(await screen.findByRole('menuitem', { name: label }));
      } else {
        await user.click(within(nav()).getByRole('button', { name: new RegExp(`^${label}`) }));
      }

      if (titleKey) {
        await screen
          .findByRole('heading', { level: 1, name: t(titleKey) })
          .catch(() => broken.push(`${label} (no heading)`));
      } else {
        await screen
          .findByPlaceholderText(/描述任务/)
          .catch(() => broken.push(`${label} (no composer)`));
      }

      // The heading appears before the surface's data arrives, so checking
      // immediately only catches crashes that happen during the first render.
      // Most of these panels fetch on mount, and a crash inside the fetched
      // content would land after this point. The fixture resolves in ~120 ms,
      // so a short fixed wait is what turns "no crash yet" into "no crash".
      // This is the third version of this check; the first two missed the
      // context white-screen for exactly this reason.
      await new Promise((resolve) => setTimeout(resolve, 250));
      if (screen.queryAllByText(CRASHED).length > 0) broken.push(`${label} (crashed)`);
    }

    expect(broken, 'surfaces that did not render properly').toEqual([]);
  });

  it('keeps the conversation reachable after visiting every surface', async () => {
    // The reason the boundary is per-surface rather than global: the rail and
    // the composer are how the user gets out of a pane. If they ever stop
    // surviving, this is the test that says so.
    const user = userEvent.setup();
    mount();
    await settle();

    for (const label of ['文件', '变更', '上下文', '决策']) {
      await user.click(within(nav()).getByRole('button', { name: new RegExp(`^${label}`) }));
    }
    await user.click(within(nav()).getByRole('button', { name: /更多/ }));
    await user.click(await screen.findByRole('menuitem', { name: '设置' }));
    await user.click(within(nav()).getByRole('button', { name: /^对话/ }));

    // Back in the conversation, with the session list and status bar intact.
    expect(await screen.findByPlaceholderText(/描述任务/)).toBeTruthy();
    expect(screen.getAllByText('修复注入哈希不一致').length).toBeGreaterThan(0);
  });
});

describe('context', () => {
  it('shows the real injection plan, hash and rendered bytes', async () => {
    const user = userEvent.setup();
    mount();
    await settle();
    await openSurface(user, /^上下文/);

    // The whole point of the panel: the bytes the agent actually received,
    // and a hash the user can check. If the fixture stops supplying a real
    // plan this fails, which is what stopped the crash above from being
    // reproducible in the first place.
    await waitFor(() =>
      expect(screen.getAllByText(/^a3f19c7be2d8/)).toHaveLength(1),
    );
    expect(screen.getAllByText('prompt_prefix').length).toBeGreaterThan(0);
    expect(
      screen.getAllByText(/packages\/context\/src\/broker\.ts/).length,
    ).toBeGreaterThan(0);
  });
});

describe('layout structure', () => {
  /**
   * `.pane` is `flex: 1`, which is `flex-basis: 0`. Two `.pane` siblings under
   * `<main>` therefore each get exactly half the column's height, and the
   * first one's content is clipped inside a scroll box whose edges the user
   * cannot see. In the settings surface that silently swallowed five cards —
   * present in the DOM, unreachable on screen.
   *
   * The fix is to stack multiple panes inside a single scroll region, so the
   * defect is now a structural property rather than something only a screenshot
   * can reveal.
   */
  it('never puts two .pane elements directly under <main>', async () => {
    const user = userEvent.setup();
    mount();
    await settle();

    const surfaces: Array<{ label: string; titleKey: string }> = [
      { label: '文件', titleKey: 'tab.explorer' },
      { label: '变更', titleKey: 'tab.changes' },
      { label: '上下文', titleKey: 'context.title' },
      { label: '决策', titleKey: 'decision.title' },
      { label: '设置', titleKey: 'settings.title' },
      { label: '存储', titleKey: 'retention.title' },
      { label: 'MCP', titleKey: 'mcp.title' },
    ];

    for (const { label, titleKey } of surfaces) {
      if (MORE_SURFACES.has(label)) {
        await user.click(within(nav()).getByRole('button', { name: /更多/ }));
        await user.click(await screen.findByRole('menuitem', { name: label }));
      } else {
        await user.click(within(nav()).getByRole('button', { name: new RegExp(`^${label}`) }));
      }
      await screen.findByRole('heading', { level: 1, name: t(titleKey) });

      const main = document.querySelector('main')!;
      const panes = Array.from(main.children).filter(
        (el) => el.classList.contains('pane'),
      );
      expect(panes.length, `${label} renders ${panes.length} .pane children of <main>`)
        .toBeLessThanOrEqual(1);
    }
  });
});

describe('explorer', () => {
  it('marks the open file in both the surface tree and the rail tree', async () => {
    const user = userEvent.setup();
    mount();
    await settle();

    await openSurface(user, /^文件/);
    await screen.findByText('C:/work/jev-pi-agent');

    // Open a file from the *surface* tree, then check the rail agrees.
    // `findAllBy`, not `getAllBy`: the directory listing is a promise, and the
    // workspace path renders before the rows do.
    const rows = await screen.findAllByTitle('C:/work/jev-pi-agent/package.json');
    await user.click(rows[0]!);

    // Two identical-looking file lists used to disagree about which file was
    // open, which reads as two different applications.
    await waitFor(() => {
      for (const row of screen.getAllByTitle('C:/work/jev-pi-agent/package.json')) {
        expect(row.className).toContain('sel');
      }
    });
  });

  it('renders the file path in its real casing, not uppercased', async () => {
    const user = userEvent.setup();
    mount();
    await settle();

    await openSurface(user, /^文件/);
    await user.click(await screen.findByTitle('C:/work/jev-pi-agent/package.json'));

    // `.block-title` is a section-heading style with `text-transform: uppercase`.
    // Reusing it for a path turned `README.md` into `README.MD`, which does not
    // match the tree, reads wrong, and is the wrong string to copy on a
    // case-sensitive filesystem.
    const heading = await screen.findByText('C:/work/jev-pi-agent/package.json');
    expect(heading.closest('.is-path')).not.toBeNull();
  });
});

describe('changes', () => {
  it('speaks the UI language instead of hardcoded English', async () => {
    const user = userEvent.setup();
    mount();
    await settle();

    await openSurface(user, /^变更/);
    await waitFor(() => expect(screen.getAllByText('未暂存').length).toBeGreaterThan(0));

    // The whole surface used to read "staged / unstaged / git commit /
    // commit message / Commit" in a Chinese UI.
    expect(screen.getAllByText('已暂存').length).toBeGreaterThan(0);
    expect(screen.getAllByText('提交').length).toBeGreaterThan(0);
    // The input's label is a placeholder, not text content.
    expect(screen.getAllByPlaceholderText('提交信息').length).toBeGreaterThan(0);

    expect(screen.queryByText('unstaged')).toBeNull();
    expect(screen.queryByText('git commit')).toBeNull();
    expect(screen.queryByText('commit message')).toBeNull();
  });

  it('gives every action an accessible name, not just a bare glyph', async () => {
    const user = userEvent.setup();
    mount();
    await settle();
    await openSurface(user, /^变更/);
    await waitFor(() => expect(screen.getAllByText('未暂存').length).toBeGreaterThan(0));

    // The stage/unstage controls are "+" and "−". With no accessible name a
    // screen reader announces "plus", which tells the user nothing about what
    // it will do or to which file.
    expect(screen.getAllByRole('button', { name: /暂存这个文件: .+/ }).length).toBeGreaterThan(0);
    expect(
      screen.getAllByRole('button', { name: /取消暂存: .+/ }).length,
    ).toBeGreaterThan(0);
  });
});

describe('navigation', () => {
  it('reaches every surface through the primary row or the More menu', async () => {
    const user = userEvent.setup();
    mount();
    await settle();

    // Five primary tabs, not fourteen peer tabs.
    const nav = screen.getAllByRole('navigation')[0]!;
    const primary = within(nav).getAllByRole('button');
    expect(primary).toHaveLength(6); // 5 tabs + the More toggle

    await user.click(within(nav).getByRole('button', { name: /更多/ }));

    // Handoff is the surface round 1 added behind the overflow.
    const handoffItem = await screen.findByRole('menuitem', { name: '交接' });
    await user.click(handoffItem);

    await waitFor(() => expect(screen.getAllByText('交接摘要').length).toBeGreaterThan(0));
  });
});

describe('decision preview', () => {
  /**
   * The preview is the one interactive control on the Decision surface, and
   * its fixture used to resolve `{}` — the panel then read `outcome.kind` off
   * `undefined` and crashed into "「决策」面板无法显示" on every click. The
   * surface-mount test never clicked anything, so the dead interaction sailed
   * through. This one exercises the click and asserts the rendered outcome.
   */
  it('renders a preview result instead of crashing the panel', async () => {
    const user = userEvent.setup();
    mount();
    await settle();

    await openSurface(user, /^决策/);
    // The input's label is a placeholder, not text content — same pattern as
    // the commit-message box above.
    const objective = await screen.findByPlaceholderText('描述这次要判断的目标');
    await user.type(objective, '把这个任务交给哪个 agent');

    await user.click(screen.getByRole('button', { name: '运行决策预览' }));

    // The route outcome renders as "> <agentId>"; the crash boundary does not.
    await waitFor(() =>
      expect(screen.getAllByText('> universal').length).toBeGreaterThan(0),
    );
    expect(screen.queryByText(/面板无法显示/)).toBeNull();
  });
});

describe('handoff', () => {
  it('generates, renders and exports a readable record', async () => {
    const user = userEvent.setup();
    mount();
    await settle();

    await user.click(screen.getAllByRole('button', { name: /更多/ })[0]!);
    await user.click(await screen.findByRole('menuitem', { name: '交接' }));

    // Empty state offers the action rather than a dead panel.
    const generate = await screen.findByRole('button', { name: '生成交接摘要' });
    await user.click(generate);

    // Every section the next agent needs must actually be on screen.
    await waitFor(() => expect(screen.getAllByText('当前状态').length).toBeGreaterThan(0));
    for (const heading of [
      '目标',
      '相关文件',
      '已做的决定',
      '改动',
      '执行过的命令',
      '未完成的工作',
      '需要注意的坑',
    ]) {
      expect(screen.getAllByText(heading).length).toBeGreaterThan(0);
    }

    // And the export action exists, so the record can leave the app.
    expect(screen.getAllByRole('button', { name: /复制为 Markdown/ }).length).toBeGreaterThan(0);
  });
});

describe('permission dialog — the security loop', () => {
  it('shows what is being asked for before offering a choice', async () => {
    mount('permission');

    // A dialog that renders without WHAT is being requested is still a
    // security problem, so the content itself is asserted — not just presence.
    await waitFor(() => expect(screen.getAllByText('SHELL').length).toBeGreaterThan(0));
    expect(screen.getAllByText('high').length).toBeGreaterThan(0);
    expect(screen.getAllByText('rm -rf build').length).toBeGreaterThan(0);
    expect(screen.getAllByText('C:/work/jev-pi-agent').length).toBeGreaterThan(0);
  });

  it('offers all four decisions, with deny reachable', async () => {
    mount('permission');
    await waitFor(() => expect(screen.getAllByText('SHELL').length).toBeGreaterThan(0));

    // The complete decision set from PERMISSION_DECISION_LABELS. A missing
    // `deny` would be a severe regression, so it is named explicitly.
    for (const label of ['允许一次', '本次会话允许', '本项目允许', '拒绝']) {
      expect(screen.getAllByRole('button', { name: label }).length).toBeGreaterThan(0);
    }
  });

  it('sends exactly one decision for one request', async () => {
    const user = userEvent.setup();
    const { fixture } = mount('permission');
    await waitFor(() => expect(screen.getAllByText('SHELL').length).toBeGreaterThan(0));

    const seen: Array<[string, string]> = [];
    const api = fixture.api as unknown as {
      permissions: { respond: (id: string, decision: string) => Promise<void> };
    };
    api.permissions.respond = async (id: string, decision: string) => {
      seen.push([id, decision]);
    };

    await user.click(screen.getAllByRole('button', { name: '允许一次' })[0]!);

    await waitFor(() => expect(seen).toHaveLength(1));
    // A second response for one request is a protocol error, not a retry.
    expect(seen[0]![0]).toBe('req-1');
    expect(seen[0]![1]).toBe('allow_once');
  });

  it('reports a failed response instead of showing four dead buttons', async () => {
    const user = userEvent.setup();
    const { fixture } = mount('permission');
    await waitFor(() => expect(screen.getAllByText('SHELL').length).toBeGreaterThan(0));

    // §4.9: an unanswered request is rejected after a timeout. The dialog can
    // outlive its request, and clicking then used to reject into nothing —
    // four buttons that silently do nothing.
    const api = fixture.api as unknown as {
      permissions: { respond: (id: string, decision: string) => Promise<void> };
    };
    api.permissions.respond = async () => {
      throw new Error('permission request already expired');
    };

    await user.click(screen.getAllByRole('button', { name: '拒绝' })[0]!);

    await waitFor(() =>
      expect(screen.getAllByText(/permission request already expired/).length).toBeGreaterThan(0),
    );
  });

  it('announces itself as a modal, with an accessible name', async () => {
    mount('permission');

    // Without `role="dialog"` + `aria-modal`, a screen reader gives the user
    // no signal that the rest of the window is now inert — the prompt just
    // appears to be part of the page.
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    // An unnamed dialog is announced as just "dialog", which is useless.
    expect(dialog).toHaveAccessibleName(/权限/);
  });

  it('moves focus into the dialog on open', async () => {
    mount('permission');
    const dialog = await screen.findByRole('dialog');

    // Focus must land inside, or a keyboard user keeps driving the page behind
    // a prompt that is blocking their turn.
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
  });

  it('keeps Tab inside the dialog', async () => {
    const user = userEvent.setup();
    mount('permission');
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));

    const buttons = within(dialog).getAllByRole('button');
    // Tab past the last button: focus must wrap, not escape to the page.
    buttons[buttons.length - 1]!.focus();
    await user.tab();
    expect(dialog.contains(document.activeElement)).toBe(true);

    // And backwards past the first.
    buttons[0]!.focus();
    await user.tab({ shift: true });
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it('reads a rejected decision out loud, not just draws it', async () => {
    const user = userEvent.setup();
    const { fixture } = mount('permission');
    await waitFor(() => expect(screen.getAllByText('SHELL').length).toBeGreaterThan(0));

    const api = fixture.api as unknown as {
      permissions: { respond: (id: string, decision: string) => Promise<void> };
    };
    api.permissions.respond = async () => {
      throw new Error('nope');
    };
    await user.click(screen.getAllByRole('button', { name: '拒绝' })[0]!);

    // A rejection the user cannot hear is a rejection they will click again.
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/nope/);
  });
});
