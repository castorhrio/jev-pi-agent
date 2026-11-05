/**
 * The hash on screen must be the hash of the bytes on screen.
 *
 * `docs/PRODUCT-DOD.md` 的第一条是「可证明注入」：Context Pack 纯函数 + 内容哈希，
 * 界面可展示上一轮注入原文，改一字节哈希失配。前两句已经有门禁
 * （`tests/contract/injection-contract.test.ts` 证明 `render` 是纯函数、改内容哈希会变），
 * 但**没有一条断言把「屏幕上的 hash」和「屏幕上的原文」绑在一起**。
 *
 * 这个缺口不是理论上的。`dev/fixture-bridge.ts` 里的注入计划把 `renderedHash` 写成了
 * 一个字面量，而它下面那段 `rendered` 的 sha256 是另一个值——也就是说，演示截图
 * `docs/screenshots/context.png` 上，用户照着面板抄下原文、自己算一遍 sha256，
 * 得到的结果与面板上印着的 hash 不一致。产品唯一「别人抄不走」的那句话，
 * 在演示屏上当场就能被证伪，而所有门禁都是绿的。
 *
 * 所以这里判两件事，两件都是用户自己会做的那一步：
 *
 *   1. 真实渲染器产出的 `renderedHash` 就是 `sha256(rendered)`（不是「稳定」、不是「会变」，
 *      而是**等于**），改一个字节之后，新的 hash 也等于新的字节的 sha256；
 *   2. 夹具（也就是 `dev:web` 与截图看到的那一屏）交给界面的计划，同样满足这一条，
 *      并且事件流里 `context.pack.built` 的 `renderedHash` 与抽屉读回的注入计划一致——
 *      预览列和抽屉不能各说一个 hash。
 *
 * 为什么用 node 的 `createHash` 而不是产品里的 `sha256Hex`：这一条要证明的正是
 * 「用户拿任何工具算一遍都对得上」，用产品自己的实现去核对产品自己的输出，
 * 会把「实现和它自己一致」当成「字节和 hash 一致」。
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { InjectionRenderer, HeuristicTokenEstimator } from '@ucad/context';
import { silentLogger } from '@ucad/observability';
import type { ContextInjectionPlan } from '@ucad/contracts';
import { createFixtureApi } from '../../apps/desktop/src/renderer/src/dev/fixture-bridge';
import { item, pack, profile } from '../fixtures/context-fixtures';

/** What a user does with the bytes the drawer shows them. */
function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

const renderer = new InjectionRenderer({
  estimator: new HeuristicTokenEstimator(),
  logger: silentLogger('test'),
});

/**
 * The one sentence this file exists for, applied to any plan from anywhere.
 *
 * `rendered` is what the drawer prints in its `<div class="code">` block and
 * `renderedHash` is what it prints above it; a user can copy the first and hash
 * it. If these two disagree, the panel is decoration.
 */
function expectHashMatchesBytes(plan: ContextInjectionPlan, where: string): void {
  expect(plan.rendered, `${where}: the plan carries no rendered bytes, so there is nothing to check`).toBeTruthy();
  expect(
    plan.renderedHash,
    `${where}: the hash shown is not sha256 of the bytes shown — copy the panel's 原文, ` +
      'hash it, and you get a different value than the one printed above it',
  ).toBe(sha256(plan.rendered));
}

describe('the hash on screen is the hash of the bytes on screen', () => {
  it('holds for the real renderer, and still holds after one byte changes', () => {
    const before = renderer.render(
      pack([item('ci_1', 'symbol', { reference: 'src/auth/AuthService.ts:42', text: 'a' })]),
      profile(),
    );
    expectHashMatchesBytes(before, 'real renderer');

    // One byte in the item body. The bytes change, the hash changes, and the
    // new hash is again the sha256 of the new bytes — the three facts a user
    // checks in that order.
    const after = renderer.render(
      pack([item('ci_1', 'symbol', { reference: 'src/auth/AuthService.ts:42', text: 'b' })]),
      profile(),
    );
    expect(after.rendered).not.toBe(before.rendered);
    expect(after.renderedHash).not.toBe(before.renderedHash);
    expectHashMatchesBytes(after, 'real renderer, one byte later');
  });

  it('holds for the plan the fixture hands the drawer', async () => {
    const { api } = createFixtureApi('default');
    const plan = await api.context.getInjection('turn-1');
    expectHashMatchesBytes(plan, 'fixture context.getInjection');
  });

  it('holds for the plan the fixture hands the preview', async () => {
    const { api } = createFixtureApi('default');
    const preview = await api.context.preview({
      workspaceId: 'ws-1',
      sessionId: 'sess-1',
      objective: '修复注入哈希不一致',
      agentId: 'universal',
    });
    // The preview may legitimately carry no injection plan (the drawer renders
    // one only when it does), but when it does, the same sentence applies.
    if (preview.injection) expectHashMatchesBytes(preview.injection, 'fixture context.preview');
  });

  it('does not let the preview column and the drawer disagree about the hash', async () => {
    /*
     * Two surfaces show the same turn's hash: the preview column reads it off
     * the `context.pack.built` event, the drawer reads it back through
     * `context.getInjection`. A fixture that hard-codes the event payload and
     * the plan separately can drift them apart, and then the app shows two
     * different hashes for one turn — which reads as "the hash is decorative".
     */
    const { api } = createFixtureApi('default');
    const events = await api.events.since({ sessionId: 'sess-1', afterSeq: 0 });
    const built = events.find((event) => event.type === 'context.pack.built');
    expect(built, 'the fixture no longer emits context.pack.built, so the preview column is empty').toBeTruthy();

    const fromEvent = (built!.payload as { renderedHash?: string }).renderedHash;
    const plan = await api.context.getInjection('turn-1');
    expect(fromEvent, 'the event carries no renderedHash').toBeTruthy();
    expect(
      fromEvent,
      'the preview column and the Context drawer show different hashes for the same turn',
    ).toBe(plan.renderedHash);
  });
});
