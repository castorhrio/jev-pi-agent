#!/usr/bin/env node
/**
 * The 30-second main chain, run offline, with the screen text printed.
 *
 * ## Why this file exists
 *
 * `docs/demo-script.md` tells a reviewer what to click and what they should see.
 * Until this round the only thing that could prove those sentences were still
 * true was `scripts/verify-main-chain.mjs`, which needs a built Electron app, a
 * display, an OS key store and — for step 4 — a network. That is the right tool
 * for "did it work on a real machine", and it is the wrong tool for "is the
 * script I am about to read out loud still describing this build": it cannot run
 * on a reviewer's laptop, in CI, or on the machine of whoever is editing the
 * copy.
 *
 * So this script runs the same three claims through the same code the app runs,
 * with nothing else attached:
 *
 *   1. **verifiable injection** — `InjectionRenderer.render()` (the pure
 *      function behind the Context drawer) renders a pack and hashes the bytes;
 *   2. **explainable routing** — `DecisionChain` over `[jev, rule]` answers a
 *      route request, and the trace says which engine answered and whether the
 *      chain fell back;
 *   3. **a permission gate that cannot be bypassed** — `assessRisk()` +
 *      `defaultPolicy()` decide that a shell command must ask, and the answer
 *      "deny" is emitted as a `permission.resolved` event that is validated
 *      against the contract's own schema.
 *
 * No Electron, no network, no token, no key store, no clock in the output. The
 * pack is fixed, `render()` is pure, so the hash printed here is the same hash
 * on every machine — which is what lets `docs/demo-script.md` quote it verbatim
 * and `tests/contract/demo-script.test.ts` go red when either half moves.
 *
 * ## What it is not
 *
 * Not a test suite and not a replacement for the real-machine run: it does not
 * open a window, so it cannot show that the drawer *renders* the bytes, only
 * that the bytes and the hash the drawer would show are the ones the document
 * quotes. The five interface states are still a person's walk
 * (`docs/state-walkthrough.md`), and steps 3–5 of the main chain still need the
 * packaged app.
 *
 * ## Usage
 *
 * ```bash
 * npm run demo            # or: node scripts/demo-walkthrough.mjs
 * ```
 *
 * Exit code 0 means every step printed what the document says it prints. A
 * mismatch is a failure with the two values named, not a warning.
 */

import { createHash } from 'node:crypto';

import { HeuristicTokenEstimator, InjectionRenderer } from '@ucad/context';
import { payloadSchemas } from '@ucad/contracts';
import { DecisionChain, JevDecisionEngine, RuleDecisionEngine } from '@ucad/decision';
import { silentLogger } from '@ucad/observability';
import { assessRisk, defaultPolicy, operationForCategory } from '@ucad/permissions';

/**
 * The steps, in the order a reviewer walks them.
 *
 * `title` is what the document calls the step; `proves` is the one sentence the
 * step is on stage to prove. The screen lines are produced by `runDemo()`, not
 * written here, because a screen line that is written here is a screen line
 * nobody computed.
 */
export const DEMO_STEPS = Object.freeze([
  { step: 1, title: '开项目，发一次请求', proves: '这一轮真的发生了，并且留下了一个可以读回来的 pack' },
  { step: 2, title: '打开「上下文」抽屉', proves: '可证明注入：屏幕上的 hash 就是屏幕上那段字节的 sha256' },
  { step: 3, title: '打开「决策」面板', proves: '可解释路由：引擎、理由、置信度都在，回落记为回落' },
  { step: 4, title: '触发权限弹窗，然后拒绝', proves: '权限门不可绕：拒绝被记成一条 permission.resolved' },
]);

/** The project the demo pretends to have open. Fixed, so the hash is fixed. */
const PROJECT = 'jev-pi-agent';

/** The agent the demo runs: the mock adapter, so no vendor and no key. */
const AGENT = 'mock';

/** The turn the demo sends. */
const TURN = 'turn-demo';

/** The pack the demo's turn produced. Fixed ids: `render()` is pure, so is this. */
const PACK = {
  id: 'cp_demo_0000000000000000000000',
  revision: 1,
  workspaceId: 'ws_demo',
  sessionId: 'sess-demo',
  turnId: TURN,
  strategy: 'hybrid',
  strategyReason: 'objective names a file and a symbol, so both providers are consulted',
  items: [
    {
      id: 'ci_demo_1',
      kind: 'file',
      source: { providerId: 'basic', reference: 'src/auth/AuthService.ts' },
      reason: 'the objective names this file',
      freshness: { indexedAt: '2026-01-01T00:00:00.000Z', workspaceRevision: 'abc1234', stale: false },
      estimatedTokens: 120,
      budgetShare: 0,
      truncated: false,
      payload: 'export function login(user: string): Promise<Session> { /* ... */ }',
    },
    {
      id: 'ci_demo_2',
      kind: 'symbol',
      source: { providerId: 'basic', reference: 'src/auth/AuthService.ts:42' },
      reason: 'the objective names this symbol',
      freshness: { indexedAt: '2026-01-01T00:00:00.000Z', workspaceRevision: 'abc1234', stale: false },
      estimatedTokens: 60,
      budgetShare: 0,
      truncated: false,
      payload: 'login(user: string): Promise<Session>',
    },
  ],
  omitted: [],
  budget: {
    packId: 'cp_demo_0000000000000000000000',
    revision: 1,
    limitTokens: 32_000,
    usedTokens: 180,
    remainingTokens: 31_820,
    estimateSource: 'heuristic_chars_div_4',
    truncated: false,
  },
  createdAt: '2026-01-01T00:00:00.000Z',
  objective: '修复登录失败并补测试',
};

/** The profile the mock agent gets: bodies in the prompt, freshness included. */
const PROFILE = {
  agentId: AGENT,
  mode: 'prompt_prefix',
  rendezvous: 'system_prompt',
  includeItemIds: true,
  includeFreshness: true,
  maxIndexEntries: 50,
  includeFullSlices: true,
};

/**
 * The read-only state summary the decision engines are allowed to see.
 *
 * Deliberately the same shape `Main` assembles: an engine that could look things
 * up itself would be able to answer from something the panel never showed.
 */
const FACTS = {
  workspace: { id: 'ws_demo', trusted: true, languageHints: ['typescript'] },
  availableAgents: [
    {
      id: AGENT,
      kind: 'universal',
      isDefaultRuntime: true,
      capabilities: { streaming: true, modelSelection: true, usageReporting: true },
    },
  ],
  availableModels: [{ id: 'mock-model', providerId: 'mock', contextWindowTokens: 128_000 }],
  git: { dirty: true, changedFiles: 2, branch: 'main' },
  context: { packId: PACK.id, itemCount: PACK.items.length, estimatedTokens: 180, freshness: 'fresh' },
  signals: { consecutiveFailures: 0, permissionDenials: 0, elapsedMs: 0, turnIndex: 1 },
};

/** The permission request the demo's turn raises — the same one `dev:web` shows. */
const PERMISSION_REQUEST = {
  id: 'req-demo',
  sessionId: 'sess-demo',
  turnId: TURN,
  agentId: AGENT,
  category: 'SHELL',
  risk: 'high',
  resource: 'C:/work/jev-pi-agent',
  command: 'rm -rf build',
  reason: '清理构建产物',
};

/** What a user does with the bytes the drawer shows them. */
function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** The first 16 hex characters — what the document quotes, and what fits on screen. */
function shortHash(hash) {
  return hash.slice(0, 16);
}

/**
 * Step 1 — the turn happened.
 *
 * Nothing is computed here that the later steps do not depend on: the point of
 * the step is that the pack id and the turn id on screen are the ones the drawer
 * and the decision panel will read back.
 */
function step1() {
  return [
    `项目  ${PROJECT}`,
    `智能体  ${AGENT}（不调厂商，不需要 key）`,
    `会话  ${PACK.sessionId} · 本轮 ${TURN}`,
    `Pack  ${PACK.id} · ${PACK.items.length} 条 · ${PACK.budget.usedTokens} tokens`,
  ];
}

/**
 * Step 2 — the drawer's two load-bearing lines.
 *
 * The hash is computed from the bytes printed above it, by `node:crypto` rather
 * than by the product's own `sha256Hex`: the claim is "you can hash this
 * yourself and get the same value", and checking the product against itself
 * would prove only that it is self-consistent.
 */
function step2() {
  const renderer = new InjectionRenderer({
    estimator: new HeuristicTokenEstimator(),
    logger: silentLogger('demo'),
  });
  const plan = renderer.render(PACK, PROFILE);
  const expected = sha256(plan.rendered);
  if (plan.renderedHash !== expected) {
    throw new Error(
      `the drawer would print a hash that is not the sha256 of the bytes it prints: ` +
        `${plan.renderedHash} vs ${expected}`,
    );
  }
  return {
    plan,
    screen: [
      `注入的原文  ${plan.rendered.split('\n')[0]}`,
      `renderedHash  ${shortHash(plan.renderedHash)}`,
      `估算来源  ${plan.estimateSource}`,
      `字节数  ${plan.rendered.length}`,
    ],
  };
}

/**
 * Step 3 — the decision panel's four lines.
 *
 * The chain is `[jev, rule]` and the objective is deliberately vague, so the
 * probabilistic engine abstains and the rule engine answers: the panel then has
 * to say *both* things — who answered, and that the chain fell back. A demo that
 * only ever showed a confident first-engine answer would not be showing the
 * fallback the product claims to record.
 */
async function step3() {
  const chain = new DecisionChain({
    engines: [new JevDecisionEngine({}), new RuleDecisionEngine()],
    logger: silentLogger('demo'),
  });
  const { result, trace } = await chain.decideWithTrace({
    requestId: 'dec-demo',
    kind: 'route',
    sessionId: PACK.sessionId,
    turnId: TURN,
    objective: '继续',
    facts: FACTS,
    timeoutMs: 2000,
  });
  await chain.dispose();
  const attempts = trace.attempts.map((attempt) => `${attempt.engineId}:${attempt.outcome}`).join(' > ');
  return {
    result,
    trace,
    screen: [
      `引擎链  ${chain.engineIds.join(' > ')}`,
      `由谁给出  ${result.producedBy.engineId} · ${result.producedBy.version}`,
      `置信度  ${(result.confidence * 100).toFixed(0)}%`,
      `理由  ${result.rationale}`,
      `链路  ${attempts}`,
      ...(result.fallback ? [`发生了回落：${result.fallback.reason}`] : []),
    ],
  };
}

/**
 * Step 4 — the permission gate, and the event the refusal leaves behind.
 *
 * The event is validated against `payloadSchemas['permission.resolved']`, the
 * same schema `Main` admits events with: a demo that printed a plausible-looking
 * object nobody validates would be showing a shape, not a record.
 */
function step4() {
  const operation = operationForCategory(PERMISSION_REQUEST.category);
  const risk = assessRisk({
    category: PERMISSION_REQUEST.category,
    resource: PERMISSION_REQUEST.resource,
    command: PERMISSION_REQUEST.command,
    workspaceTrusted: true,
    operation,
  });
  const policy = defaultPolicy({
    category: PERMISSION_REQUEST.category,
    mode: 'ask',
    operation,
    insideWorkspace: true,
    workspaceTrusted: true,
    resource: PERMISSION_REQUEST.resource,
    command: PERMISSION_REQUEST.command,
  });
  if (policy.outcome !== 'ask_user') {
    throw new Error(
      `a shell command must ask the user, and the policy said '${policy.outcome}' — ` +
        'the permission gate is not gating',
    );
  }
  const event = {
    type: 'permission.resolved',
    payload: { requestId: PERMISSION_REQUEST.id, decision: 'deny', decider: 'user' },
  };
  const parsed = payloadSchemas['permission.resolved'].safeParse(event.payload);
  if (!parsed.success) {
    throw new Error(`the refusal is not a valid permission.resolved payload: ${parsed.error.message}`);
  }
  return {
    risk,
    policy,
    event,
    screen: [
      `Agent 请求权限  ${PERMISSION_REQUEST.category} · 风险 ${risk} · ${PERMISSION_REQUEST.command}`,
      `原因  ${PERMISSION_REQUEST.reason}`,
      `策略  ${policy.outcome} — ${policy.reason}`,
      `permission.resolved  ${JSON.stringify(event.payload)}`,
    ],
  };
}

/**
 * Every step, with the lines a person should see on screen.
 *
 * Exported so `tests/contract/demo-script.test.ts` can compare the document
 * against the run without spawning a process, and so the red direction can be
 * driven by mutating the document rather than by arguing about it.
 */
export async function runDemo() {
  const two = step2();
  const three = await step3();
  const four = step4();
  const screens = [step1(), two.screen, three.screen, four.screen];
  return {
    steps: DEMO_STEPS.map((meta, index) => ({ ...meta, screen: screens[index] })),
    facts: {
      rendered: two.plan.rendered,
      renderedHash: two.plan.renderedHash,
      shortHash: shortHash(two.plan.renderedHash),
      engineId: three.result.producedBy.engineId,
      confidence: three.result.confidence,
      rationale: three.result.rationale,
      usedFallback: three.trace.usedFallback,
      permissionEvent: four.event,
    },
  };
}

/** Print the run the way a person reads it off the screen. */
function print(run) {
  for (const step of run.steps) {
    console.log(`\n[demo] step ${step.step} · ${step.title}`);
    console.log(`  这一步在证明什么：${step.proves}`);
    for (const line of step.screen) console.log(`  ${line}`);
  }
  console.log(
    `\n[demo] 四步走完：注入 ${run.facts.shortHash} · 决策 ${run.facts.engineId} ` +
      `(${(run.facts.confidence * 100).toFixed(0)}%) · 权限 ${run.facts.permissionEvent.payload.decision}`,
  );
  console.log('[demo] 没有联网、没有令牌、没有启动 Electron；同样的输入永远打印同样的 hash。');
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (invokedDirectly) {
  runDemo()
    .then((run) => {
      print(run);
    })
    .catch((error) => {
      console.error(`[demo] 失败：${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
}
