/**
 * §6.4: extending a Context Pack must actually extend it.
 *
 * ## The defect
 *
 * `context.extend` reached the broker with a session id taken from
 * `listSessions()[0]` and a turn id minted on the spot
 * (`turn_preview_<now>`). No ledger had ever been opened for that turn, so
 * `remaining()` answered 0, every candidate was dropped as `budget`, and the
 * drawer reported a successful extend that had added nothing at all. The
 * button worked; the feature did not.
 *
 * A second defect sat behind it: the fallback that reports the budget when
 * there is no live ledger added the pack's own item tokens to a number that
 * already contained them, so the reported usage doubled on every extend and
 * the remaining allowance collapsed towards zero.
 *
 * ## What is asserted here
 *
 * Over a real SQLite file, a real budget ledger, a real intelligence provider
 * and a real workspace on disk:
 *
 *  1. a preview pack can be extended, and the items it gains are real;
 *  2. a turn that has already ended can still be extended — "no ledger" is
 *     not "no allowance";
 *  3. a live turn is charged to its ledger, and the ledger is the authority;
 *  4. the reported usage grows by exactly the tokens of the items that were
 *     added — never more;
 *  5. an extend never pushes a pack past its limit, and what did not fit is
 *     reported as `budget` rather than vanishing.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { Database, EventLog, SessionSequencer } from '@ucad/storage';
import { SessionStore } from '@ucad/session';
import { BlobStore, silentLogger } from '@ucad/observability';
import { BasicIntelligenceProvider, IntelligenceManager } from '@ucad/code-intelligence';
import {
  ContextBroker,
  HeuristicTokenEstimator,
  InjectionRenderer,
  TurnBudgetLedger,
} from '@ucad/context';

import type { AgentManifest, ContextPack } from '@ucad/contracts';

let dir: string;
let workspaceRoot: string;
let db: Database;
let blobs: BlobStore;
let sessionStore: SessionStore;
let broker: ContextBroker;
let ledger: TurnBudgetLedger;

let workspaceId = '';
let sessionId = '';

/**
 * A real turn, because `context_packs.turn_id` is a foreign key onto `turns`.
 */
function beginTurn(objective: string): string {
  return sessionStore.beginTurn({ sessionId, objective }).turnId;
}

const AGENT: AgentManifest = {
  id: 'mock',
  displayName: 'Mock',
  kind: 'native',
  isDefaultRuntime: true,
  transport: 'child_process',
  providerBinding: 'both',
  pinned: [],
  capabilities: {
    streaming: true,
    sessionResume: false,
    modelSelection: true,
    fileTools: false,
    shellTools: false,
    permissionCallbacks: 'none',
    nativeSandbox: false,
    mcp: false,
    skills: false,
    subagents: false,
    usageReporting: 'none',
    injectionModes: ['prompt_prefix'],
    toolContract: 'none',
  },
  contextWindowTokens: 32_000,
} as AgentManifest;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucad-extend-'));
  workspaceRoot = path.join(dir, 'workspace');
  fs.mkdirSync(path.join(workspaceRoot, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(workspaceRoot, 'src', 'auth.ts'),
    ['export function login(user: string) {', '  return validate(user);', '}', ''].join('\n'),
    'utf8',
  );
  fs.writeFileSync(
    path.join(workspaceRoot, 'src', 'session.ts'),
    ['export function startSession(token: string) {', '  return renew(token);', '}', ''].join('\n'),
    'utf8',
  );

  blobs = new BlobStore({ root: path.join(dir, 'blobs') });
  db = new Database({ dbPath: path.join(dir, 'ucad.db'), logger: silentLogger('extend') });
  db.migrate();
  const eventLog = new EventLog({ db, logger: silentLogger('extend'), blobs });
  const sequencer = new SessionSequencer(db);

  sessionStore = new SessionStore({
    db,
    logger: silentLogger('extend'),
    eventLog,
    sequencer,
  });

  const intelligence = new IntelligenceManager({ db, logger: silentLogger('extend') });
  intelligence.register(new BasicIntelligenceProvider({ logger: silentLogger('extend'), blobs }));

  const workspace = sessionStore.upsertWorkspace({
    path: workspaceRoot,
    name: 'fixture',
    trustState: 'trusted',
  });
  workspaceId = workspace.id;
  const session = sessionStore.createSession({
    workspaceId,
    agentId: AGENT.id,
    permissionMode: 'ask',
    title: 'extend',
  });
  sessionId = session.id;

  await intelligence.initializeProvider('basic', {
    workspaceId,
    workspaceRoot,
    configDir: path.join(dir, 'config'),
    cacheDir: path.join(dir, 'cache'),
    trustState: 'trusted',
    logger: silentLogger('extend'),
  });

  const estimator = new HeuristicTokenEstimator();
  ledger = new TurnBudgetLedger({ db, logger: silentLogger('extend') });
  broker = new ContextBroker({
    db,
    logger: silentLogger('extend'),
    ledger,
    estimator,
    renderer: new InjectionRenderer({ estimator, logger: silentLogger('extend') }),
    intelligence,
    blobs,
    git: {
      status: async () => ({ dirty: false, head: '0'.repeat(40), changedFiles: 0 }),
      diffSummary: async () => [],
    },
    sessionStore,
    resolveAgent: (agentId) => (agentId === AGENT.id ? AGENT : null),
  });
}, 60_000);

afterAll(() => {
  db?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** The tokens of the items an extend added. */
function tokensOf(items: Array<{ estimatedTokens: number }>): number {
  return items.reduce((sum, item) => sum + item.estimatedTokens, 0);
}

describe('extending a preview pack (no turn ledger exists)', () => {
  it('adds the items the request matched', async () => {
    const preview = await broker.preview({
      workspaceId,
      sessionId,
      objective: '分析登录失败的原因',
      agentId: AGENT.id,
    });
    expect(preview.id).toMatch(/^preview_/);
    expect(preview.turnId).toMatch(/^preview_/);

    const delta = await broker.extend({
      packId: preview.id,
      sessionId: preview.sessionId,
      turnId: preview.turnId,
      trigger: 'user_action',
      request: 'login validate',
    });

    // The defect: every candidate was dropped as `budget` because the turn
    // id the caller invented had no ledger, and `remaining()` said 0.
    expect(
      delta.addedItems.length,
      `the extend added nothing; dropped: ${JSON.stringify(delta.dropped)}`,
    ).toBeGreaterThan(0);
    expect(delta.addedItems.every((item) => item.estimatedTokens > 0)).toBe(true);
  });

  it('reports which budget governed it', async () => {
    const preview = await broker.preview({
      workspaceId,
      sessionId,
      objective: '分析登录失败的原因',
      agentId: AGENT.id,
    });

    const delta = await broker.extend({
      packId: preview.id,
      sessionId: preview.sessionId,
      turnId: preview.turnId,
      trigger: 'user_action',
      request: 'login',
    });

    expect(delta.budgetSource).toBe('pack');
  });

  it('grows the usage by exactly the tokens it added', async () => {
    const preview = await broker.preview({
      workspaceId,
      sessionId,
      objective: '分析登录失败的原因',
      agentId: AGENT.id,
    });
    const before = broker.getPack(preview.id)!;

    const delta = await broker.extend({
      packId: preview.id,
      sessionId: preview.sessionId,
      turnId: preview.turnId,
      trigger: 'user_action',
      request: 'login validate',
    });

    // The defect: the fallback added the pack's own item tokens to a
    // `usedTokens` that already contained them, so the usage doubled.
    expect(delta.budget.usedTokens).toBe(before.budget.usedTokens + tokensOf(delta.addedItems));
    expect(delta.budget.remainingTokens).toBe(
      delta.budget.limitTokens - delta.budget.usedTokens,
    );
  });
});

describe('extending a turn that is still running', () => {
  it('charges the turn ledger and reports it as the budget', async () => {
    const turnId = beginTurn('分析登录失败的原因');
    const pack = await broker.build({
      workspaceId,
      sessionId,
      turnId,
      objective: '分析登录失败的原因',
      agent: AGENT,
      budget: { maxInputTokens: 32_000, reservedOutputTokens: 0, estimateSource: 'unknown' },
    });

    const chargedBefore = ledger.state(turnId)!.usedTokens;

    const delta = await broker.extend({
      packId: pack.id,
      sessionId,
      turnId,
      trigger: 'agent_tool',
      request: 'login validate',
    });

    expect(delta.budgetSource).toBe('turn_ledger');
    expect(delta.addedItems.length).toBeGreaterThan(0);
    // The ledger is the authority while the turn runs, and it was charged.
    expect(ledger.state(turnId)!.usedTokens).toBe(chargedBefore + tokensOf(delta.addedItems));
    expect(delta.budget.usedTokens).toBe(ledger.state(turnId)!.usedTokens);
  });
});

describe('extending a turn that has already ended', () => {
  it('still adds items — a released ledger is not an empty allowance', async () => {
    const turnId = beginTurn('分析登录失败的原因');
    const pack = await broker.build({
      workspaceId,
      sessionId,
      turnId,
      objective: '分析登录失败的原因',
      agent: AGENT,
      budget: { maxInputTokens: 32_000, reservedOutputTokens: 0, estimateSource: 'unknown' },
    });

    await broker.release({ turnId });
    expect(ledger.state(turnId)).toBeNull();

    const delta = await broker.extend({
      packId: pack.id,
      sessionId,
      turnId,
      trigger: 'user_action',
      request: 'login validate',
    });

    expect(
      delta.addedItems.length,
      `the extend added nothing after the turn ended; dropped: ${JSON.stringify(delta.dropped)}`,
    ).toBeGreaterThan(0);
    expect(delta.budgetSource).toBe('pack');
  });

  it('does not count the pack twice', async () => {
    const turnId = beginTurn('分析登录失败的原因');
    const pack = await broker.build({
      workspaceId,
      sessionId,
      turnId,
      objective: '分析登录失败的原因',
      agent: AGENT,
      budget: { maxInputTokens: 32_000, reservedOutputTokens: 0, estimateSource: 'unknown' },
    });

    await broker.release({ turnId });

    const first = await broker.extend({
      packId: pack.id,
      sessionId,
      turnId,
      trigger: 'user_action',
      request: 'login validate',
    });
    const afterFirst = broker.getPack(pack.id)!;

    const second = await broker.extend({
      packId: pack.id,
      sessionId,
      turnId,
      trigger: 'user_action',
      request: 'startSession renew',
    });

    // Each extend adds its own tokens and only its own tokens.
    expect(first.budget.usedTokens).toBe(pack.budget.usedTokens + tokensOf(first.addedItems));
    expect(second.budget.usedTokens).toBe(
      afterFirst.budget.usedTokens + tokensOf(second.addedItems),
    );
    expect(second.budget.remainingTokens).toBe(
      second.budget.limitTokens - second.budget.usedTokens,
    );
  });
});

describe('the budget is still a budget', () => {
  it('never goes past the limit, and says what did not fit', async () => {
    const turnId = beginTurn('分析登录失败的原因');
    // A limit that leaves no room for anything: the pack fills up, and every
    // candidate has to be reported as `budget` rather than quietly dropped.
    const pack = await broker.build({
      workspaceId,
      sessionId,
      turnId,
      objective: '分析登录失败的原因',
      agent: AGENT,
      budget: { maxInputTokens: 120, reservedOutputTokens: 0, estimateSource: 'unknown' },
    });
    expect(pack.budget.usedTokens).toBeLessThanOrEqual(pack.budget.limitTokens);

    await broker.release({ turnId });

    const delta = await broker.extend({
      packId: pack.id,
      sessionId,
      turnId,
      trigger: 'user_action',
      request: 'login validate startSession renew',
    });

    expect(delta.budget.usedTokens).toBeLessThanOrEqual(delta.budget.limitTokens);
    expect(delta.budget.remainingTokens).toBeGreaterThanOrEqual(0);
    // Whatever did not fit is named, not vanished.
    if (delta.addedItems.length === 0) {
      expect(
        delta.dropped.some((entry) => entry.why === 'budget'),
        `nothing was added and nothing was reported as over-budget: ${JSON.stringify(delta.dropped)}`,
      ).toBe(true);
    }
  });
});

describe('the pack a drawer reads back', () => {
  it('agrees with the delta about how much was used', async () => {
    const turnId = beginTurn('分析登录失败的原因');
    const pack = await broker.build({
      workspaceId,
      sessionId,
      turnId,
      objective: '分析登录失败的原因',
      agent: AGENT,
      budget: { maxInputTokens: 32_000, reservedOutputTokens: 0, estimateSource: 'unknown' },
    });

    const delta = await broker.extend({
      packId: pack.id,
      sessionId,
      turnId,
      trigger: 'agent_tool',
      request: 'login validate',
    });

    const readBack: ContextPack = broker.getPack(pack.id)!;
    expect(readBack.revision).toBe(delta.revision);
    expect(readBack.budget.usedTokens).toBe(delta.budget.usedTokens);
    expect(readBack.items.length).toBe(pack.items.length + delta.addedItems.length);
  });
});
