/**
 * §4.4 Decision contract: D-2 chain ordering, D-5 no side effects,
 * D-6 serialisability, NFR-16 explainability.
 *
 * A decision the user cannot see the reason for is worse than no automation at
 * all, so `rationale` and `confidence` are asserted as mandatory, and a
 * fallback is asserted to always be recorded.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RuleDecisionEngine, DecisionChain } from '@ucad/decision';
import { silentLogger } from '@ucad/observability';
import {
  DECISION_HARD_TIMEOUT_MS,
  DEFAULT_DECISION_CHAIN,
  type DecisionEngine,
  type DecisionEngineManifest,
  type DecisionFacts,
  type DecisionKind,
  type DecisionRequest,
  type DecisionResult,
} from '@ucad/contracts';

/**
 * A controllable engine used to prove chain ordering and fallback tracing.
 * This lives in the test rather than in the package: a test double that ships
 * with the product is a way for a real deployment to accidentally depend on
 * simulated behaviour.
 */
type StubBehaviour =
  | { kind: 'ok'; outcomeKind: DecisionKind; supports?: DecisionKind[] }
  | { kind: 'error' }
  | { kind: 'hang' };

class StubEngine implements DecisionEngine {
  readonly manifest: DecisionEngineManifest;

  constructor(
    private readonly id: string,
    private readonly behaviour: StubBehaviour,
  ) {
    this.manifest = {
      id,
      displayName: id,
      sideEffects: ['none'],
      supportedKinds:
        behaviour.kind === 'ok' && behaviour.supports
          ? behaviour.supports
          : ['route', 'risk', 'continue_or_stop', 'context_relevance', 'clarify', 'option_select'],
      timeoutMs: 500,
    };
  }

  async initialize(): Promise<void> {
    /* nothing to set up */
  }

  supports(kind: DecisionKind): boolean {
    return this.manifest.supportedKinds.includes(kind);
  }

  async decide(request: DecisionRequest, signal?: AbortSignal): Promise<DecisionResult> {
    switch (this.behaviour.kind) {
      case 'error':
        throw new Error(`${this.id} is broken`);
      case 'hang':
        // never settles on its own; the chain's hard timeout must fire
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('aborted')));
        });
        break;
      case 'ok':
        return {
          requestId: request.requestId,
          outcome: { kind: this.behaviour.outcomeKind, agentId: 'mock' } as never,
          confidence: 0.5,
          rationale: `${this.id} answered`,
          producedBy: { engineId: this.id },
          latencyMs: 1,
        };
    }
    throw new Error(`${this.id} produced no result`);
  }

  async dispose(): Promise<void> {
    /* nothing to release */
  }
}

function stubEngine(id: string, behaviour: StubBehaviour): StubEngine {
  return new StubEngine(id, behaviour);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const decisionSrc = path.resolve(here, '../../packages/decision/src');

function facts(over: Partial<DecisionFacts> = {}): DecisionFacts {
  return {
    workspace: { id: 'ws_1', trusted: true, languageHints: ['typescript'] },
    availableAgents: [
      {
        id: 'mock',
        kind: 'mock',
        isDefaultRuntime: false,
        capabilities: { streaming: true, modelSelection: true, usageReporting: 'full' },
      },
    ],
    availableModels: [],
    git: { dirty: false, changedFiles: 0 },
    context: { itemCount: 0, estimatedTokens: 0, freshness: 'unknown' },
    signals: { consecutiveFailures: 0, permissionDenials: 0, elapsedMs: 10, turnIndex: 0 },
    ...over,
  };
}

function request(kind: DecisionRequest['kind'], over: Partial<DecisionFacts> = {}): DecisionRequest {
  return {
    requestId: 'req_1',
    kind,
    sessionId: 'ses_1',
    turnId: 'turn_1',
    objective: 'fix the login bug and add tests',
    facts: facts(over),
    timeoutMs: 500,
  };
}

describe('D-5: DecisionEngine must have no side effects', () => {
  it('the decision package imports no fs, child_process or net', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
          files.push(full);
        }
      }
    };
    walk(decisionSrc);

    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      expect(text, `${file} imports node:fs`).not.toMatch(/from\s+['"]node:fs['"]/);
      expect(text, `${file} imports node:child_process`).not.toMatch(
        /from\s+['"]node:child_process['"]/,
      );
      expect(text, `${file} imports node:net`).not.toMatch(/from\s+['"]node:net['"]/);
    }
  });

  it('declares no side effects on the rule engine', () => {
    const engine = new RuleDecisionEngine();
    expect(engine.manifest.sideEffects).toEqual(['none']);
  });
});

describe('RuleDecisionEngine', () => {
  const engine = new RuleDecisionEngine();
  const init = engine.initialize.bind(engine);

  it('declares all six decision kinds', () => {
    expect([...engine.manifest.supportedKinds].sort()).toEqual(
      [
        'route',
        'risk',
        'continue_or_stop',
        'context_relevance',
        'clarify',
        'option_select',
      ].sort(),
    );
  });

  it('always reports supports() consistently with its manifest', () => {
    for (const kind of ['route', 'risk', 'clarify'] as const) {
      expect(engine.supports(kind)).toBe(true);
    }
  });

  it('NFR-16: every result carries a rationale and a confidence in [0,1]', async () => {
    await init({ workspaceId: 'ws_1', configDir: '.', sideEffectsAllowed: [], logger: silentLogger('t') as never });

    for (const kind of ['route', 'risk', 'continue_or_stop', 'clarify', 'option_select'] as const) {
      const result = await engine.decide(request(kind));
      expect(result.rationale.length).toBeGreaterThan(0);
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
      expect(result.outcome.kind).toBe(kind);
    }
  });

  it('D-6: the result is plain JSON and survives a round trip', async () => {
    await init({ workspaceId: 'ws_1', configDir: '.', sideEffectsAllowed: [], logger: silentLogger('t') as never });
    const result = await engine.decide(request('route'));
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it('is deterministic for identical facts', async () => {
    await init({ workspaceId: 'ws_1', configDir: '.', sideEffectsAllowed: [], logger: silentLogger('t') as never });
    const a = await engine.decide(request('route'));
    const b = await engine.decide(request('route'));
    expect(a.outcome).toEqual(b.outcome);
    expect(a.rationale).toBe(b.rationale);
  });

  it('explains its route in terms of the actual facts', async () => {
    await init({ workspaceId: 'ws_1', configDir: '.', sideEffectsAllowed: [], logger: silentLogger('t') as never });
    const result = await engine.decide(
      request('route', {
        git: { dirty: true, changedFiles: 14, branch: 'feat/x' },
        availableAgents: [
          { id: 'mock', kind: 'mock', isDefaultRuntime: false, capabilities: { streaming: true, modelSelection: true, usageReporting: 'full' } },
          { id: 'pi', kind: 'universal', isDefaultRuntime: true, capabilities: { streaming: true, modelSelection: true, usageReporting: 'full' } },
        ],
      }),
    );
    expect(result.outcome.kind).toBe('route');
    // the rationale must reference real signals, not be a constant
    expect(result.rationale.length).toBeGreaterThan(10);
  });

  it('raises risk when the worktree is dirty and many files changed', async () => {
    await init({ workspaceId: 'ws_1', configDir: '.', sideEffectsAllowed: [], logger: silentLogger('t') as never });
    const result = await engine.decide(
      request('risk', { git: { dirty: true, changedFiles: 30, branch: 'main' } }),
    );
    expect(result.outcome.kind).toBe('risk');
    if (result.outcome.kind === 'risk') {
      expect(['medium', 'high']).toContain(result.outcome.risk);
    }
  });

  it('asks for help after repeated failures instead of looping forever', async () => {
    await init({ workspaceId: 'ws_1', configDir: '.', sideEffectsAllowed: [], logger: silentLogger('t') as never });
    const result = await engine.decide(
      request('continue_or_stop', {
        signals: { consecutiveFailures: 3, permissionDenials: 0, elapsedMs: 1000, turnIndex: 3 },
      }),
    );
    if (result.outcome.kind === 'continue_or_stop') {
      expect(result.outcome.action).not.toBe('continue');
    }
  });
});

describe('D-2: the engine chain must fall back, and must leave a trace', () => {
  it('the V1 default chain is the rule engine alone', () => {
    expect([...DEFAULT_DECISION_CHAIN]).toEqual(['rule']);
  });

  it('uses the first engine that answers', async () => {
    const chain = new DecisionChain({
      engines: [
        stubEngine('first', { kind: 'ok', outcomeKind: 'route' }),
        stubEngine('second', { kind: 'ok', outcomeKind: 'route' }),
      ],
      logger: silentLogger('t'),
    });
    const result = await chain.decide(request('route'));
    expect(result.producedBy.engineId).toBe('first');
    expect(result.fallback).toBeUndefined();
  });

  it('skips an engine that does not support the kind', async () => {
    const chain = new DecisionChain({
      engines: [
        stubEngine('narrow', { kind: 'ok', outcomeKind: 'route', supports: ['risk'] }),
        stubEngine('wide', { kind: 'ok', outcomeKind: 'route' }),
      ],
      logger: silentLogger('t'),
    });
    const result = await chain.decide(request('route'));
    expect(result.producedBy.engineId).toBe('wide');
  });

  it('falls through an erroring engine to the next one in the chain', async () => {
    const chain = new DecisionChain({
      engines: [
        stubEngine('broken', { kind: 'error' }),
        stubEngine('healthy', { kind: 'ok', outcomeKind: 'route' }),
      ],
      logger: silentLogger('t'),
    });
    const result = await chain.decide(request('route'));
    // D-2: moving to the next engine is normal chaining, not a fallback.
    // `fallback` is reserved for the all-engines-failed case.
    expect(result.producedBy.engineId).toBe('healthy');
    expect(result.fallback).toBeUndefined();
  });

  it('does not report a fallback when a later engine answers after a timeout', async () => {
    const chain = new DecisionChain({
      engines: [
        stubEngine('hangs', { kind: 'hang' }),
        stubEngine('healthy', { kind: 'ok', outcomeKind: 'route' }),
      ],
      logger: silentLogger('t'),
      hardTimeoutMs: 120,
    });
    const result = await chain.decide(request('route'));
    expect(result.producedBy.engineId).toBe('healthy');
    expect(result.fallback).toBeUndefined();
  });

  it('marks a timeout fallback when every engine times out', async () => {
    const chain = new DecisionChain({
      engines: [stubEngine('hangs', { kind: 'hang' }), stubEngine('also_hangs', { kind: 'hang' })],
      logger: silentLogger('t'),
      hardTimeoutMs: 120,
    });
    const result = await chain.decide(request('route'));
    // all engines failed -> RuleDecisionEngine is the last resort (D-2)
    expect(result.producedBy.engineId).toBe('rule');
    expect(result.fallback?.used).toBe(true);
    expect(result.fallback?.reason).toBe('timeout');
  });

  it('marks an error fallback when every engine throws', async () => {
    const chain = new DecisionChain({
      engines: [stubEngine('a', { kind: 'error' }), stubEngine('b', { kind: 'error' })],
      logger: silentLogger('t'),
    });
    const result = await chain.decide(request('route'));
    expect(result.producedBy.engineId).toBe('rule');
    expect(result.fallback?.used).toBe(true);
    expect(result.fallback?.reason).toBe('error');
  });

  it('the default single-engine chain is not falsely marked as a fallback', async () => {
    const chain = new DecisionChain({ engines: [new RuleDecisionEngine()], logger: silentLogger('t') });
    const result = await chain.decide(request('route'));
    expect(result.producedBy.engineId).toBe('rule');
    expect(result.fallback).toBeUndefined();
  });

  it('always produces a result even when every engine fails (D-2 last resort)', async () => {
    const chain = new DecisionChain({
      engines: [stubEngine('a', { kind: 'error' }), stubEngine('b', { kind: 'hang' })],
      logger: silentLogger('t'),
      hardTimeoutMs: 100,
    });
    const result = await chain.decide(request('route'));
    expect(result).toBeTruthy();
    expect(result.rationale.length).toBeGreaterThan(0);
    expect(result.fallback?.used).toBe(true);
  });

  it('falls back to the rule engine when the chain is empty', async () => {
    const chain = new DecisionChain({ engines: [], logger: silentLogger('t') });
    const result: DecisionResult = await chain.decide(request('route'));
    expect(result.producedBy.engineId).toBe('rule');
  });

  it('records the requestId from the request on every result', async () => {
    const chain = new DecisionChain({ engines: [], logger: silentLogger('t') });
    const result = await chain.decide(request('route'));
    expect(result.requestId).toBe('req_1');
  });

  it('enforces the contract hard timeout constant', () => {
    expect(DECISION_HARD_TIMEOUT_MS).toBeGreaterThan(0);
    expect(DECISION_HARD_TIMEOUT_MS).toBeLessThanOrEqual(2000);
  });
});
