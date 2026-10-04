/**
 * §14 Integration: one complete turn, end to end, over real infrastructure.
 *
 * Real SQLite file, real Basic intelligence provider, real ContextBroker with a
 * real budget ledger, and a **forked** Agent Host running the mock adapter over
 * the §6.1 protocol. Nothing is faked except the secret store, because
 * `safeStorage` only exists inside Electron.
 *
 * This is the test that would fail if the wiring between the planes were wrong,
 * even when every package passes its own unit contract.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Database, EventLog, MessageProjector, SessionSequencer } from '@ucad/storage';
import { SessionStore } from '@ucad/session';
import { PermissionEngine } from '@ucad/permissions';
import { BlobStore, silentLogger } from '@ucad/observability';
import { BasicIntelligenceProvider, IntelligenceManager } from '@ucad/code-intelligence';
import {
  ContextBroker,
  HeuristicTokenEstimator,
  InjectionRenderer,
  ToolContractHost,
  TurnBudgetLedger,
} from '@ucad/context';
import { DecisionService, DecisionChain, RuleDecisionEngine } from '@ucad/decision';
import { AgentRuntimeManager } from '@ucad/agent-core';
import { AgentHostProcess, resolveHostEntry } from '@ucad/agent-host';
import { MOCK_LATENCY_ENV } from '@ucad/adapter-mock';

import type { TurnEvent } from '@ucad/contracts';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');

let dir: string;
let workspaceRoot: string;
let db: Database;
let blobs: BlobStore;
let eventLog: EventLog;
let sequencer: SessionSequencer;
let projector: MessageProjector;
let sessionStore: SessionStore;
let permissions: PermissionEngine;
let intelligence: IntelligenceManager;
let broker: ContextBroker;
let ledger: TurnBudgetLedger;
let estimator: HeuristicTokenEstimator;
let renderer: InjectionRenderer;
let tools: ToolContractHost;
let runtime: AgentRuntimeManager;
let host: AgentHostProcess;

const events: TurnEvent[] = [];
let workspaceId = '';
let sessionId = '';
let agentId = '';

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucad-e2e-'));
  workspaceRoot = path.join(dir, 'workspace');
  fs.mkdirSync(path.join(workspaceRoot, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(workspaceRoot, 'src', 'auth.ts'),
    [
      'export function login(user: string) {',
      '  return validate(user);',
      '}',
      '',
      'function validate(u: string) {',
      '  return u.length > 0;',
      '}',
    ].join('\n'),
    'utf8',
  );

  blobs = new BlobStore({ root: path.join(dir, 'blobs') });
  db = new Database({ dbPath: path.join(dir, 'ucad.db'), logger: silentLogger('e2e') });
  db.migrate();
  eventLog = new EventLog({ db, logger: silentLogger('e2e'), blobs });
  sequencer = new SessionSequencer(db);
  projector = new MessageProjector(db);

  sessionStore = new SessionStore({
    db,
    logger: silentLogger('e2e'),
    eventLog,
    sequencer,
  });
  permissions = new PermissionEngine({ db, logger: silentLogger('e2e') });

  intelligence = new IntelligenceManager({ db, logger: silentLogger('e2e') });
  intelligence.register(
    new BasicIntelligenceProvider({ logger: silentLogger('e2e'), blobs }),
  );

  estimator = new HeuristicTokenEstimator();
  ledger = new TurnBudgetLedger({ db, logger: silentLogger('e2e') });
  renderer = new InjectionRenderer({ estimator, logger: silentLogger('e2e') });

  const gitStub = {
    status: async () => ({ dirty: false, head: '0'.repeat(40), changedFiles: 0 }),
    diffSummary: async () => [],
  };

  broker = new ContextBroker({
    db,
    logger: silentLogger('e2e'),
    ledger,
    estimator,
    renderer,
    intelligence,
    blobs,
    git: gitStub,
    sessionStore,
  });

  tools = new ToolContractHost({
    broker,
    intelligence,
    permissions,
    sessionStore,
    logger: silentLogger('e2e'),
    estimator,
    renderer,
  });

  const decisionService = new DecisionService({
    chain: new DecisionChain({ engines: [new RuleDecisionEngine()], logger: silentLogger('e2e') }),
    db,
    logger: silentLogger('e2e'),
    onDecision: () => undefined,
  });

  // The mock adapter paces itself between proposals, and the host is a real
  // forked child that calls the adapter factory with no arguments — so the
  // only way to reach its `latencyMs` is the environment, which `fork()`
  // inherits. Set before `host.start()`.
  //
  // Why it is not left at the 5ms default: at 5ms a whole turn finishes in
  // well under 200ms, so "send a turn, then cancel it" is a race the test can
  // lose — and it did, roughly one run in six under full-suite load, reporting
  // `expected [ 'CANCELLED', 'INTERRUPTED' ] to include 'COMPLETED'`. That is
  // the mock being unrealistically fast, not a product defect: a turn that
  // genuinely finished before the stop request arrived *should* report
  // COMPLETED. 90ms per step keeps every assertion in this file meaningful
  // while leaving cancellation a wide, deterministic window.
  process.env[MOCK_LATENCY_ENV] = '90';

  host = new AgentHostProcess({
    adapterModule: path.join(repoRoot, 'packages', 'adapter-mock', 'dist', 'index.js'),
    agentHostId: 'host_mock',
    logger: silentLogger('e2e'),
    cwd: workspaceRoot,
    configDir: dir,
    hostEntry: resolveHostEntry(),
  });
  const manifest = await host.start();
  agentId = manifest.id;

  runtime = new AgentRuntimeManager({
    db,
    logger: silentLogger('e2e'),
    eventLog,
    sequencer,
    sessionStore,
    permissions,
    blobs,
    projector,
    hostFactory: () => host,
    onEvent: (event) => events.push(event),
    context: { broker, renderer, toolHost: tools },
    intelligence,
    decision: {
      decide: (input) =>
        decisionService
          .decide({
            sessionId: input.sessionId,
            turnId: input.turnId,
            kind: input.kind,
            objective: input.objective,
            facts: input.facts,
          })
          .then((envelope) => ({ result: envelope.result, requestId: '' })),
    },
  });
  runtime.registerHost(agentId, host);

  const workspace = sessionStore.upsertWorkspace({
    path: workspaceRoot,
    name: 'fixture',
    trustState: 'trusted',
  });
  workspaceId = workspace.id;
  const session = sessionStore.createSession({
    workspaceId,
    agentId,
    permissionMode: 'ask',
    title: 'e2e',
  });
  sessionId = session.id;
}, 60_000);

afterAll(async () => {
  await runtime?.dispose().catch(() => undefined);
  await host?.dispose(500).catch(() => undefined);
  db?.close();
  fs.rmSync(dir, { recursive: true, force: true });
}, 30_000);

describe('one complete turn over real infrastructure', () => {
  it('runs a turn and produces a gapless, monotonic event stream', async () => {
    const { turnId } = await runtime.sendTurn({
      sessionId,
      agentId,
      objective: '分析 auth.ts 中的 validate 函数',
    });
    expect(turnId).toMatch(/^turn_/);

    const outcome = await runtime.waitForTurn(turnId, 20_000);
    expect(outcome.state).toBe('COMPLETED');

    const seqs = events.map((e) => e.seq);
    expect(seqs.length).toBeGreaterThan(5);
    // SEQ-2: monotonic, gapless, one session -> one sequence (SEQ-3)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBe((seqs[i - 1] as number) + 1);
    }
    expect(new Set(seqs).size).toBe(seqs.length);
  }, 60_000);

  it('admitted every event through the sequencer, never the host', () => {
    // B6/E-1: the host cannot mint a seq, so no admitted event may carry one
    // that the sequencer did not allocate. Gaplessness above is the proof.
    for (const event of events) {
      expect(Number.isInteger(event.seq)).toBe(true);
      expect(event.seq).toBeGreaterThan(0);
    }
  });

  it('carries the turn lifecycle in order', () => {
    const types = events.map((e) => e.type);
    expect(types[0]).toBe('turn.started');
    expect(types).toContain('context.pack.built');
    expect(types).toContain('tool.started');
    expect(types).toContain('text.delta');
    expect(types[types.length - 1]).toBe('turn.completed');
  });

  it('built a Context Pack and injected a deterministic render (NFR-13)', () => {
    const built = events.find((e) => e.type === 'context.pack.built');
    expect(built).toBeTruthy();
    const payload = built!.payload as {
      packId: string;
      itemCount: number;
      estimatedTokens: number;
      estimateSource: string;
      renderedHash: string;
      injectionMode: string;
    };
    expect(payload.packId).toMatch(/^cp_/);
    expect(payload.itemCount).toBeGreaterThan(0);
    expect(payload.estimatedTokens).toBeGreaterThan(0);
    // T-3: the estimate source must be declared, never presented as exact
    expect(payload.estimateSource).toBe('heuristic_chars_div_4');
    expect(payload.renderedHash).toMatch(/^[0-9a-f]{64}$/);

    const pack = broker.getPack(payload.packId);
    expect(pack).toBeTruthy();
    expect(pack!.injection?.rendered).toBeTruthy();
    // I-2: the render is a projection of the pack, and the hash is of the bytes
    expect(pack!.injection!.renderedHash).toBe(payload.renderedHash);
  });

  it('the injection actually reached the Agent, byte for byte (I-3)', () => {
    const plan = broker.getInjection(
      events.find((e) => e.type === 'turn.started')!.turnId,
    );
    expect(plan).toBeTruthy();
    const firstDelta = events.find((e) => e.type === 'text.delta');
    expect(firstDelta).toBeTruthy();
    // The mock adapter echoes the rendered injection as the prefix of its first
    // text delta. If the injection had been rewritten or truncated, this fails.
    const text = (firstDelta!.payload as { text: string }).text;
    expect(text.startsWith(plan!.rendered)).toBe(true);
  });

  it('every context item carries provenance and budget metadata (NFR-10)', () => {
    const built = events.find((e) => e.type === 'context.pack.built')!;
    const pack = broker.getPack((built.payload as { packId: string }).packId)!;
    expect(pack.items.length).toBeGreaterThan(0);
    for (const item of pack.items) {
      expect(item.source.providerId).toBeTruthy();
      expect(item.reason.length).toBeGreaterThan(0);
      expect(item.freshness).toBeTruthy();
      expect(item.estimatedTokens).toBeGreaterThan(0);
      expect(item.budgetShare).toBeGreaterThanOrEqual(0);
      expect(typeof item.truncated).toBe('boolean');
    }
  });

  it('stays inside the turn budget (T-5)', () => {
    const built = events.find((e) => e.type === 'context.pack.built')!;
    const pack = broker.getPack((built.payload as { packId: string }).packId)!;
    expect(pack.budget.usedTokens).toBeLessThanOrEqual(pack.budget.limitTokens);
    expect(pack.budget.remainingTokens).toBeGreaterThanOrEqual(0);
  });

  it('projected a transcript from the event stream (§8.3)', () => {
    const messages = sessionStore.getMessages(sessionId);
    expect(messages.length).toBeGreaterThan(0);
    expect(messages.some((m) => m.role === 'assistant' && m.text.length > 0)).toBe(true);
  });

  it('persisted the UCAD-to-native session mapping (S-3)', () => {
    const agentSession = sessionStore.getAgentSession(sessionId);
    expect(agentSession).toBeTruthy();
    expect(agentSession!.nativeSessionId).toMatch(/^native_/);
    // S-3: the two ids are never the same value
    expect(agentSession!.nativeSessionId).not.toBe(sessionId);
  });

  it('replay through events.since reproduces the same view state (NFR-03)', () => {
    const latest = eventLog.latestSeq(sessionId);
    const replayed = eventLog.since({ sessionId, afterSeq: 0 });
    expect(replayed).toHaveLength(events.length);
    expect(replayed[replayed.length - 1]?.seq).toBe(latest);
    // the replay is identical to what the live stream delivered
    expect(replayed.map((e) => e.type)).toEqual(events.map((e) => e.type));
  });

  it('released the turn budget ledger (T-4)', () => {
    const turnId = events[0]!.turnId;
    expect(ledger.state(turnId)).toBeNull();
  });
});

describe('a second concurrent turn is rejected (S-1)', () => {
  it('refuses a second active turn on the same session', async () => {
    const session = sessionStore.createSession({
      workspaceId,
      agentId,
      permissionMode: 'ask',
      title: 'second',
    });
    const first = await runtime.sendTurn({
      sessionId: session.id,
      agentId,
      objective: '第一个任务',
    });
    await expect(
      runtime.sendTurn({ sessionId: session.id, agentId, objective: '第二个任务' }),
    ).rejects.toThrow();
    await runtime.waitForTurn(first.turnId, 20_000);
  }, 60_000);
});

describe('stop propagates to a running turn (NFR-05)', () => {
  it('cancels and reaches a terminal state with a terminal event', async () => {
    const session = sessionStore.createSession({
      workspaceId,
      agentId,
      permissionMode: 'ask',
      title: 'cancel',
    });
    const before = events.length;
    const { turnId } = await runtime.sendTurn({
      sessionId: session.id,
      agentId,
      objective: '一个会被停止的任务',
    });
    await runtime.cancelTurn(session.id, 'user requested stop');
    const outcome = await runtime.waitForTurn(turnId, 20_000);

    expect(['CANCELLED', 'INTERRUPTED']).toContain(outcome.state);

    // The state flips before the terminal event is fanned out to listeners, so
    // wait for the event rather than sampling the array at resolve time.
    const deadline = Date.now() + 5_000;
    let turnEvents = events.slice(before).filter((e) => e.turnId === turnId);
    while (
      Date.now() < deadline &&
      !['turn.completed', 'turn.interrupted'].includes(
        turnEvents[turnEvents.length - 1]?.type ?? '',
      )
    ) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      turnEvents = events.slice(before).filter((e) => e.turnId === turnId);
    }

    // whatever path cancellation took, the turn reached a terminal event
    //
    // `at(-1)` rather than `[length - 1]!`: the non-null assertion would turn
    // "no event for this turn ever arrived" into a `TypeError` on `undefined`
    // instead of a readable failure. A gate that reports a crash tells you
    // nothing about which invariant broke.
    const last = turnEvents.at(-1);
    expect(last, 'the turn produced no events at all').toBeDefined();
    expect(['turn.completed', 'turn.interrupted']).toContain(last?.type);
  }, 60_000);
});
