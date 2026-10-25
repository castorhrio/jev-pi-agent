/**
 * The engine chain the user sets in Settings must be the chain that runs.
 *
 * ## Why this file exists
 *
 * `DecisionFacade.buildService()` used to end in `void chain`: the chain was
 * accepted, echoed back to the Renderer, saved into the settings — and then
 * thrown away, because the service was always built around a single rule
 * engine. The Settings panel showed a chain, the user could reorder it, and
 * the app answered with the same engine whatever they picked. A setting that
 * silently does nothing is worse than no setting at all: it is a promise the
 * product does not keep.
 *
 * These tests pin the three states that must hold after the fix:
 *
 * - the chain that runs is the chain that was asked for;
 * - an engine this build does not know is dropped, and the chain falls back to
 *   the rule engine rather than to nothing;
 * - an engine the user did not authorise (NFR-14: a declared side effect) is
 *   dropped too — and that check lives in Main, not only in the UI.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Database } from '@ucad/storage';
import { silentLogger } from '@ucad/observability';
import { buildDecisionFacts } from '@ucad/decision';
import type {
  DecisionEngine,
  DecisionEngineManifest,
  DecisionFacts,
  DecisionKind,
  DecisionRequest,
  DecisionResult,
} from '@ucad/contracts';
import { DecisionFacade } from '../../apps/desktop/src/main/decision-facade';

/**
 * An engine that answers with its own id, so a decision says which engine
 * produced it. It lives in the test rather than in the product: a test double
 * that ships with the product is a way for a real deployment to depend on
 * simulated behaviour.
 */
function stubEngine(
  id: string,
  options: { sideEffects?: DecisionEngineManifest['sideEffects']; kinds?: DecisionKind[] } = {},
): DecisionEngine {
  const manifest: DecisionEngineManifest = {
    id,
    displayName: id,
    version: '1.0.0',
    sideEffects: options.sideEffects ?? ['none'],
    supportedKinds: options.kinds ?? ['route'],
    timeoutMs: 500,
  };

  return {
    manifest,
    initialize: async () => undefined,
    supports: (kind) => manifest.supportedKinds.includes(kind),
    decide: async (request: DecisionRequest): Promise<DecisionResult> => ({
      requestId: request.requestId,
      outcome: { kind: 'route', agentId: 'mock' },
      confidence: 0.9,
      rationale: `answered by ${id}`,
      producedBy: { engineId: id, version: manifest.version },
      latencyMs: 1,
    }),
    dispose: async () => undefined,
  };
}

function makeFacade(options: {
  engines?: DecisionEngine[];
  chain?: string[];
  allowNetworkEngines?: boolean;
} = {}): { facade: DecisionFacade; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucad-chain-'));
  const db = new Database({ dbPath: path.join(dir, 'ucad.db'), logger: silentLogger('chain') });
  db.migrate();

  const facade = new DecisionFacade({
    db,
    logger: silentLogger('chain'),
    chain: options.chain ?? ['rule'],
    timeoutMs: 2000,
    allowNetworkEngines: options.allowNetworkEngines ?? false,
    engines: options.engines ?? [],
    admit: () => undefined,
  });

  return { facade, dir };
}

function facts(): DecisionFacts {
  return buildDecisionFacts({
    workspace: { id: 'ws_chain', trusted: true },
    availableAgents: [
      {
        id: 'mock',
        kind: 'mock',
        isDefaultRuntime: true,
        capabilities: { streaming: true, modelSelection: false, usageReporting: true },
      },
    ],
    context: { itemCount: 1, estimatedTokens: 100, freshness: 'fresh' },
    signals: { consecutiveFailures: 0, permissionDenials: 0, elapsedMs: 0, turnIndex: 0 },
  });
}

describe('the decision chain is the one that runs', () => {
  it('runs the chain the user set', () => {
    const { facade } = makeFacade();

    expect(facade.setChain(['rule'])).toEqual(['rule']);
    expect(facade.chain).toEqual(['rule']);
  });

  it('drops an engine this build does not know', () => {
    const { facade } = makeFacade();

    // An id from a newer build, or a typo. It must not reach the chain.
    expect(facade.setChain(['nope'])).toEqual(['rule']);
    expect(facade.chain).toEqual(['rule']);
  });

  it('falls back to the rule engine when the chain is empty', () => {
    const { facade } = makeFacade();

    expect(facade.setChain([])).toEqual(['rule']);
    expect(facade.chain).toEqual(['rule']);
  });

  it('keeps the order the user chose', () => {
    const { facade } = makeFacade({ engines: [stubEngine('jev')] });

    expect(facade.setChain(['jev', 'rule'])).toEqual(['jev', 'rule']);
    expect(facade.chain).toEqual(['jev', 'rule']);
  });

  it('lets the engine the user picked answer', async () => {
    const { facade } = makeFacade({ engines: [stubEngine('jev')] });

    facade.setChain(['jev', 'rule']);
    const result = await facade.preview({
      sessionId: 'sess_1',
      objective: 'route this',
      kind: 'route',
      facts: facts(),
    });

    // Not "the chain is ordered" but "the engine that answered is the one the
    // user put in front".
    expect(result.producedBy.engineId).toBe('jev');
  });

  it('falls back to the rule engine when the picked engine cannot answer', async () => {
    // The picked engine does not support `risk`, so the chain moves on and
    // the rule engine answers — recorded as a fallback, never silently.
    const { facade } = makeFacade({ engines: [stubEngine('jev', { kinds: ['route'] })] });

    facade.setChain(['jev', 'rule']);
    const result = await facade.preview({
      sessionId: 'sess_1',
      objective: 'how risky is this',
      kind: 'risk',
      facts: facts(),
    });

    expect(result.producedBy.engineId).toBe('rule');
    expect(result.fallback?.used).toBe(true);
  });

  it('refuses an engine whose side effect the user did not authorise', () => {
    const networked = stubEngine('net', { sideEffects: ['network'] });
    const { facade } = makeFacade({ engines: [networked] });

    // NFR-14: "it has a side effect" and "the user authorised that side
    // effect" are two facts, and only one of them is true by default.
    expect(facade.setChain(['net'])).toEqual(['rule']);
    expect(facade.chain).toEqual(['rule']);
  });

  it('accepts a network engine once the user authorises it', () => {
    const networked = stubEngine('net', { sideEffects: ['network'] });
    const { facade } = makeFacade({ engines: [networked], allowNetworkEngines: true });

    expect(facade.setChain(['net'])).toEqual(['net']);
  });

  it('lists the engines the user can pick from', () => {
    const { facade } = makeFacade({ engines: [stubEngine('jev')] });

    expect(facade.listEngines().map((engine) => engine.id)).toEqual(['rule', 'jev']);
  });

  it('calls a duplicated engine once', () => {
    const { facade } = makeFacade({ engines: [stubEngine('jev')] });

    // A repeated id would compute the same answer twice and make the trace
    // claim two attempts where there was one.
    expect(facade.setChain(['jev', 'jev'])).toEqual(['jev']);
  });
});
