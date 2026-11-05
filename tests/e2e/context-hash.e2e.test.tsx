import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '@renderer/App';
import { createFixtureApi } from '@renderer/dev/fixture-bridge';
import type { ContextInjectionPlan } from '@ucad/contracts';

/**
 * The one screen the product is built around, driven the way a user drives it.
 *
 * `docs/PRODUCT-DOD.md` 的第一条是「可证明注入」：Context Pack 纯函数 + 内容哈希；
 * 界面可展示上一轮注入原文；改一字节哈希失配。三句话各自都有门禁，但**没有一条
 * 门禁把这三句话放在同一块屏幕上走一遍**：
 *
 *  - `tests/contract/injection-contract.test.ts` 证明 `render` 是纯函数、改内容哈希会变；
 *  - `tests/contract/injection-hash-consistency.test.ts` 证明交给界面的计划里
 *    `renderedHash === sha256(rendered)`；
 *  - `docs/dod-status.md` 的 DOD-1.2 一行把证据指向 `critical-path.e2e.test.tsx`，
 *    而那个文件从头到尾没有打开过 Context 抽屉——它证明的是「预览列有内容」。
 *
 * 于是「屏幕上那个 hash 就是屏幕上那段字节的 sha256」这句话，在真实渲染出来的
 * 抽屉里从来没有被量过。这一条补的就是它，而且用的是用户自己的动作：
 *
 *   1. 打开「上下文」，读出面板上印着的 hash；
 *   2. 点「复制原文」，把剪贴板里的字节用 Node 的 `createHash` 算一遍；
 *   3. 两者必须相等——不是「稳定」，不是「看起来像」，是**相等**；
 *   4. 下一轮注入的字节多一个空格，面板上的 hash 必须跟着变，并且仍然等于新字节的 sha256。
 *
 * 第 4 步是这一条真正的价值：抽屉如果缓存、记忆化或者自己算 hash，前三步全绿而
 * 第 4 步会红。用户问「改一个字节会怎样」时，答案必须来自这一屏，而不是来自
 * `packages/context` 的单元测试。
 *
 * 为什么用 Node 的 `createHash` 而不是产品里的 `sha256Hex`：这一条要证明的正是
 * 「用户拿任何工具算一遍都对得上」。用产品自己的实现去核对产品自己的输出，会把
 * 「实现和它自己一致」当成「字节和 hash 一致」。
 */

/** What a user does with the bytes the drawer hands them. */
function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

type Fixture = ReturnType<typeof createFixtureApi>;

/**
 * Mounts the real App against the fixture transport.
 *
 * `mutate` is the only thing this file adds to the harness: it wraps
 * `context.getInjection` so that a turn *after* the seeded one comes back with
 * one byte more in the rendered text and the hash that byte sequence really
 * hashes to. That is what Main does on the next turn — the bytes are rebuilt
 * from the pack, and the hash is `sha256` of whatever came out. The wrapper
 * lives here rather than in `fixture-bridge.ts` because the fixture runs in a
 * plain browser (`dev:web`), where `node:crypto` does not exist and a hash
 * cannot be computed at all.
 */
function mount(options: { mutate?: boolean } = {}) {
  const fixture: Fixture = createFixtureApi('default');

  if (options.mutate) {
    const original = fixture.api.context.getInjection;
    fixture.api.context.getInjection = async (turnId: string): Promise<ContextInjectionPlan> => {
      const plan = await original(turnId);
      // The seeded turn is the "before" picture; every later turn is the
      // "after" one. One space is one byte, and it is enough.
      if (turnId === 'turn-1') return plan;
      const rendered = `${plan.rendered} `;
      return { ...plan, rendered, renderedHash: sha256(rendered) };
    };
  }

  (window as unknown as Record<string, unknown>).ucad = fixture.api;
  const utils = render(<App />);
  return { ...utils, fixture, api: fixture.api };
}

/** Waits for the first data load to settle (the fixture resolves in ~120 ms). */
async function settle() {
  await waitFor(
    () => expect(screen.getAllByText(/jev-pi-agent/).length).toBeGreaterThan(0),
    { timeout: 5000 },
  );
}

/**
 * The drawer, as a user reads it: the hash printed in the panel, and the bytes
 * printed under it.
 *
 * Both are read off the DOM rather than off the transport, because the claim
 * is about the screen. The hash is the 64-hex block; the bytes are the `<div
 * class="code">` that follows the 注入的原文 heading.
 */
async function readDrawer(): Promise<{ hash: string; bytes: string }> {
  const hashBlock = await waitFor(
    () => {
      const found = screen
        .getAllByText(/^[0-9a-f]{64}$/)
        .find((node) => node.className.includes('code'));
      expect(
        found,
        'the Context drawer printed no renderedHash — the panel that exists to make injection ' +
          'verifiable is showing nothing to verify',
      ).toBeTruthy();
      return found as HTMLElement;
    },
    { timeout: 5000 },
  );

  const heading = screen.getByText('注入的原文');
  const bytesBlock = heading.parentElement?.nextElementSibling as HTMLElement | null;
  expect(
    bytesBlock,
    'the drawer printed a hash but no 原文 under it — a hash with nothing to hash is decoration',
  ).toBeTruthy();

  return { hash: hashBlock.textContent ?? '', bytes: bytesBlock.textContent ?? '' };
}

/** Opens the 上下文 surface from the tab strip. */
async function openContext(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: '上下文' }));
  await waitFor(() => expect(screen.getByText('上一轮实际注入的内容')).toBeTruthy());
}

/** Sends one turn from the composer, which is only mounted on the chat surface. */
async function sendTurn(user: ReturnType<typeof userEvent.setup>, text: string) {
  await user.click(screen.getByRole('button', { name: '对话' }));
  const composer = (await waitFor(() =>
    screen.getByRole('textbox', { name: '任务描述' }),
  )) as HTMLTextAreaElement;
  await user.type(composer, text);
  const form = (composer.closest('.composer') ?? composer.parentElement!) as HTMLElement;
  await user.click(within(form).getByRole('button', { name: '发送' }));
  await waitFor(() =>
    expect(screen.getAllByText(/fixture 回显的内容/).length).toBeGreaterThan(0),
  );
}

describe('the hash on screen is the hash of the bytes on screen', () => {
  it('lets a user copy the bytes, hash them, and get the printed hash', async () => {
    const user = userEvent.setup();
    mount();
    await settle();
    await openContext(user);

    const { hash, bytes } = await readDrawer();

    // The bytes are real bytes, not a placeholder: a panel that prints "—" and
    // a hash would pass a weaker check and prove nothing.
    expect(bytes.length, 'the 原文 block is empty, so there is nothing to hash').toBeGreaterThan(0);
    expect(
      sha256(bytes),
      'the hash printed above the 原文 is not sha256 of that 原文 — copy the panel’s bytes, ' +
        'hash them with any tool, and you get a different value than the one printed above them',
    ).toBe(hash);
  });

  it('copies exactly the bytes it printed, so the user’s own check is one click', async () => {
    const user = userEvent.setup();
    mount();
    await settle();
    await openContext(user);

    const { hash, bytes } = await readDrawer();

    /*
     * The 原文 sits in a `max-height: 280px; overflow: auto` block. Selecting
     * it by hand across a scroll container is how a user ends up hashing a
     * truncated copy and concluding the product lies. The button exists so
     * that the clipboard holds `plan.rendered` and nothing else.
     */
    await user.click(screen.getByRole('button', { name: '复制原文' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '已复制' })).toBeTruthy());

    const copied = await navigator.clipboard.readText();
    expect(
      copied,
      'the 复制原文 button did not put the printed bytes on the clipboard — a copy that copies ' +
        'something else is worse than no button, because it looks like a verification',
    ).toBe(bytes);
    expect(sha256(copied), 'the copied bytes do not hash to the printed hash').toBe(hash);
  });

  it('copies the hash it printed, so the two halves can be compared elsewhere', async () => {
    const user = userEvent.setup();
    mount();
    await settle();
    await openContext(user);

    const { hash } = await readDrawer();
    await user.click(screen.getByRole('button', { name: '复制 hash' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '已复制' })).toBeTruthy());
    expect(await navigator.clipboard.readText()).toBe(hash);
  });

  it('shows a different hash once one byte of the injected text changes', async () => {
    const user = userEvent.setup();
    mount({ mutate: true });
    await settle();
    await openContext(user);

    const before = await readDrawer();
    expect(sha256(before.bytes)).toBe(before.hash);

    // A second turn. Main rebuilds the pack, the rendered bytes gain one space,
    // and the drawer re-reads the injection for the new turn.
    await sendTurn(user, '再跑一轮，看看 hash 会不会变');
    await openContext(user);

    const after = await readDrawer();

    expect(
      after.bytes,
      'the drawer is still showing the previous turn’s bytes after a new turn ran',
    ).not.toBe(before.bytes);
    expect(
      after.hash,
      'one byte changed in the injected text and the hash on screen did not — the panel is ' +
        'showing a cached or recomputed value, which is exactly what makes it useless as evidence',
    ).not.toBe(before.hash);
    expect(
      sha256(after.bytes),
      'after the byte change the printed hash is no longer sha256 of the printed bytes',
    ).toBe(after.hash);
  });
});
