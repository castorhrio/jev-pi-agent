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
import { Logger, MemoryLogSink, silentLogger } from '@ucad/observability';
import { buildDecisionFacts, RULE_ENGINE_ID } from '@ucad/decision';
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
  options: {
    sideEffects?: DecisionEngineManifest['sideEffects'];
    /**
     * Build the manifest with no `sideEffects` field at all.
     *
     * The contract requires the field, so this is a manifest written by code
     * rather than by the contract — which is exactly the case the facade
     * defends against with `?? []`.
     */
    withoutSideEffects?: boolean;
    kinds?: DecisionKind[];
  } = {},
): DecisionEngine {
  const manifest = {
    id,
    displayName: id,
    version: '1.0.0',
    ...(options.withoutSideEffects
      ? {}
      : { sideEffects: options.sideEffects ?? ['none'] }),
    supportedKinds: options.kinds ?? ['route'],
    timeoutMs: 500,
  } as DecisionEngineManifest;

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
  logger?: Logger;
} = {}): { facade: DecisionFacade; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucad-chain-'));
  const db = new Database({ dbPath: path.join(dir, 'ucad.db'), logger: silentLogger('chain') });
  db.migrate();

  const facade = new DecisionFacade({
    db,
    logger: options.logger ?? silentLogger('chain'),
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

/**
 * What a manifest's `sideEffects` means, case by case.
 *
 * The gate used to be two `every()` calls in a row, and `[].every(…)` is
 * vacuously `true` — so an empty declaration was allowed, a mixed one was not,
 * and nothing in the code said which of those was intended. These cases are
 * the intention written down: a manifest author can now read what their
 * declaration will do, and a future edit that changes it fails here.
 */
describe('a declared side effect is a permission question, answered one case at a time', () => {
  it('allows an engine that declares no side effects at all', () => {
    // `[]` says "I do nothing beyond answering". Nothing to authorise.
    const { facade } = makeFacade({ engines: [stubEngine('plain', { sideEffects: [] })] });

    expect(facade.setChain(['plain'])).toEqual(['plain']);
  });

  it('allows an engine that declares `none`', () => {
    const { facade } = makeFacade({ engines: [stubEngine('plain', { sideEffects: ['none'] })] });

    expect(facade.setChain(['plain'])).toEqual(['plain']);
  });

  it('refuses a manifest that repeats `none`', () => {
    // Not a permission question — there is nothing to authorise — but the case
    // list says a declaration has exactly one way to say "no side effects", and
    // `['none']` is refused-compared-to `['none','none']` only because of that
    // rule. Pinned here so a later "be lenient about duplicates" edit has to
    // change the documented intent first.
    const repeated = stubEngine('repeated', { sideEffects: ['none', 'none'] });
    const { facade } = makeFacade({ engines: [repeated], allowNetworkEngines: true });

    expect(facade.setChain(['repeated'])).toEqual(['rule']);
  });

  it('refuses a manifest that repeats a real effect', () => {
    // The same rule as `['none', 'none']`, applied to the other branch: a
    // declaration states one thing. This case used to pass — `every()` asks
    // about each element, and two `network`s are two elements that each pass —
    // so the case list's "the manifest has to say one thing" was true of
    // `none` and false of `network`, with nothing saying which was intended.
    const repeated = stubEngine('repeated-net', { sideEffects: ['network', 'network'] });
    const { facade } = makeFacade({ engines: [repeated], allowNetworkEngines: true });

    expect(facade.setChain(['repeated-net'])).toEqual(['rule']);
  });

  it('refuses a manifest that says `none` and a real effect at once', () => {
    // A contradiction is not a permission — not even when the real effect
    // (here `network`) is authorised. The manifest has to say one thing.
    const confused = stubEngine('confused', { sideEffects: ['none', 'network'] });
    const { facade } = makeFacade({ engines: [confused], allowNetworkEngines: true });

    expect(facade.setChain(['confused'])).toEqual(['rule']);
  });

  it('refuses `process` even when network engines are authorised', () => {
    // `allowNetworkEngines` is a setting about the network. It says nothing
    // about starting a process, and a broader permission is not a substitute
    // for a missing one.
    const local = stubEngine('proc', { sideEffects: ['process'] });
    const { facade } = makeFacade({ engines: [local], allowNetworkEngines: true });

    expect(facade.setChain(['proc'])).toEqual(['rule']);
  });

  it('refuses a mix of an authorised and an unauthorised effect', () => {
    // "Mostly authorised" is not authorised: the engine would still do the
    // part nobody agreed to.
    const mixed = stubEngine('mixed', { sideEffects: ['network', 'process'] });
    const { facade } = makeFacade({ engines: [mixed], allowNetworkEngines: true });

    expect(facade.setChain(['mixed'])).toEqual(['rule']);
  });

  it('says which engine was refused, and which chain asked for it', () => {
    // The verdict is in the chain, but the *reason* is only in the log — and a
    // log line that says "an engine was dropped" without naming the engine or
    // the chain cannot tell a person which setting to change. Three shapes are
    // refused for three different reasons: a contradiction (`none` beside a
    // real effect), an authorised effect beside an unauthorised one, and an
    // effect this build has no setting for at all. Each has its own case
    // above; what this one pins is the line they share.
    const sink = new MemoryLogSink();
    const logger = new Logger({ scope: 'chain', sink });
    const shapes: Array<{ id: string; sideEffects: DecisionEngineManifest['sideEffects'] }> = [
      { id: 'confused', sideEffects: ['none', 'network'] },
      { id: 'mixed', sideEffects: ['network', 'process'] },
      { id: 'proc', sideEffects: ['process'] },
    ];
    const { facade } = makeFacade({
      engines: shapes.map((shape) => stubEngine(shape.id, { sideEffects: shape.sideEffects })),
      logger,
      // Authorised on purpose: none of the three is refused for want of the
      // network checkbox, so what the line records is the manifest, not the
      // setting.
      allowNetworkEngines: true,
    });

    expect(facade.setChain(shapes.map((shape) => shape.id))).toEqual(['rule']);

    const refusals = sink.records.filter(
      (record) => record.msg === 'engine chain: dropping an engine whose effects are not authorised',
    );
    // One line per engine, in the order the chain asked for them, and none for
    // a shape that was allowed — the count is how a reader knows nothing was
    // dropped silently.
    expect(refusals.map((record) => record.meta?.['engineId'])).toEqual(['confused', 'mixed', 'proc']);
    for (const record of refusals) {
      // The chain the user set, not only the engine: the same engine may be
      // authorised in one chain and not another (the setting is per build, the
      // chain is per user), so "who asked for it" is part of the record.
      expect(record.meta?.['requested']).toEqual(['confused', 'mixed', 'proc']);
      // The setting that was in force when the refusal happened. Without it a
      // later reader cannot tell "the user never authorised the network" from
      // "the network was authorised and the manifest still did not match".
      expect(record.meta?.['allowNetworkEngines']).toBe(true);
    }
    expect(refusals.map((record) => record.meta?.['sideEffects'])).toEqual([
      ['none', 'network'],
      ['network', 'process'],
      ['process'],
    ]);
    // And the chain falls back, once, with the reason on record.
    const fallback = sink.records.find(
      (record) => record.msg === 'engine chain: nothing may run from the requested chain; using the rule engine',
    );
    expect(fallback?.meta?.['requested']).toEqual(['confused', 'mixed', 'proc']);
  });

  it('refuses an effect this build has no setting for', () => {
    // A manifest from a newer build naming an effect this one cannot offer a
    // checkbox for. Fail closed: it is not run, and it does not crash the app.
    const future = stubEngine('future', {
      sideEffects: ['filesystem'] as unknown as DecisionEngineManifest['sideEffects'],
    });
    const { facade } = makeFacade({ engines: [future], allowNetworkEngines: true });

    expect(facade.setChain(['future'])).toEqual(['rule']);
  });
});

/**
 * The rule table, executable.
 *
 * The facade's own comment lists the cases its permission check asks about —
 * nothing declared, `['none']`, `['network']`, `['none', …]` mixed in, and
 * anything else. The cases above explain *why* each branch exists; this one
 * states *what* each branch does, one row per branch, so the comment and the
 * code cannot drift apart without a test going red.
 *
 * Two rows had no case of their own: a manifest with no `sideEffects` field
 * at all (the contract requires the field, so only code can produce it) and
 * the network pair with the authorisation switched both ways.
 */
describe('a side-effect declaration is judged one branch at a time', () => {
  interface Branch {
    /** the declaration, as a manifest author would write it */
    what: string;
    sideEffects?: DecisionEngineManifest['sideEffects'];
    /** the manifest carries no `sideEffects` field at all */
    withoutField?: boolean;
    /** the user switched "allow network engines" on in Settings */
    authorised: boolean;
    verdict: 'allowed' | 'refused';
  }

  const branches: Branch[] = [
    {
      what: 'no `sideEffects` field at all',
      withoutField: true,
      authorised: false,
      verdict: 'allowed',
    },
    { what: 'an empty declaration', sideEffects: [], authorised: false, verdict: 'allowed' },
    { what: '`none`', sideEffects: ['none'], authorised: false, verdict: 'allowed' },
    { what: '`none` twice', sideEffects: ['none', 'none'], authorised: true, verdict: 'refused' },
    {
      what: '`none` and `network`',
      sideEffects: ['none', 'network'],
      authorised: true,
      verdict: 'refused',
    },
    { what: '`network`, not authorised', sideEffects: ['network'], authorised: false, verdict: 'refused' },
    { what: '`network`, authorised', sideEffects: ['network'], authorised: true, verdict: 'allowed' },
    // A repeated effect is a malformed declaration, not a wider permission —
    // the same verdict as `none` twice, whichever way the setting is switched.
    { what: '`network` twice', sideEffects: ['network', 'network'], authorised: true, verdict: 'refused' },
    { what: '`process`', sideEffects: ['process'], authorised: true, verdict: 'refused' },
  ];

  it.each(branches)('$what is $verdict', (branch) => {
    const engine = stubEngine('probe', {
      ...(branch.withoutField ? { withoutSideEffects: true } : {}),
      ...(branch.sideEffects ? { sideEffects: branch.sideEffects } : {}),
    });
    const { facade } = makeFacade({ engines: [engine], allowNetworkEngines: branch.authorised });

    // The verdict is read off the chain, because that is all a caller can
    // see: an engine that may not run is not in the chain, and the chain
    // falls back to the rule engine.
    const chain = facade.setChain(['probe']);

    if (branch.verdict === 'allowed') {
      expect(chain).toEqual(['probe']);
    } else {
      expect(chain).toEqual(['rule']);
    }
  });
});

/**
 * The chain shown is the chain that runs — for the two ids `resolveChainIds`
 * drops, not only for the ones it keeps.
 *
 * `setChain` returning the resolved list is an echo; an echo can be right while
 * the run is wrong (that is exactly what `void chain` was). So each case also
 * asks who answered.
 */
describe('the chain echoed back is the chain that runs', () => {
  it('runs a duplicated engine once', async () => {
    const base = stubEngine('jev');
    let calls = 0;
    const counting: DecisionEngine = {
      ...base,
      decide: async (request) => {
        calls += 1;
        return base.decide(request);
      },
    };
    const { facade } = makeFacade({ engines: [counting] });

    expect(facade.setChain(['jev', 'jev'])).toEqual(['jev']);
    const result = await facade.preview({
      sessionId: 'sess_dup',
      objective: 'route this',
      kind: 'route',
      facts: facts(),
    });

    // Not "the echo has one entry" but "one entry ran": the second copy was
    // dropped before the chain was built, so it was never called.
    expect(calls).toBe(1);
    expect(result.producedBy.engineId).toBe('jev');
  });

  it('runs the fallback that the echo names when the only id is unknown', async () => {
    const { facade } = makeFacade();

    expect(facade.setChain(['nope'])).toEqual(['rule']);
    const result = await facade.preview({
      sessionId: 'sess_unknown',
      objective: 'route this',
      kind: 'route',
      facts: facts(),
    });

    expect(result.producedBy.engineId).toBe('rule');
    // The rule engine is the chain's last resort, so this is not a fallback
    // trace: the unknown id never entered the chain to fall back from.
    expect(result.fallback).toBeUndefined();
  });
});

/**
 * Why the running chain differs from the one in Settings.
 *
 * Pruning is the right behaviour — an unknown id, an unauthorised effect and a
 * duplicate must not run — but it used to be silent. The Settings panel showed
 * one chain, the app ran another, and nothing anywhere said which entry was
 * dropped or why, so the only way to find out was to read this file. A pruned
 * chain now has a cause on record.
 */
describe('a pruned chain says what it dropped and why', () => {
  it('records each reason an entry was dropped', () => {
    const sink = new MemoryLogSink();
    const logger = new Logger({ scope: 'chain', sink });
    const { facade } = makeFacade({
      engines: [
        stubEngine('jev'),
        stubEngine('proc', { sideEffects: ['process'] }),
        stubEngine('net', { sideEffects: ['network'] }),
      ],
      logger,
    });

    const running = facade.setChain(['nope', 'jev', 'jev', 'proc', 'net']);

    // The echo is still the running chain...
    expect(running).toEqual(['jev']);
    expect(facade.chain).toEqual(['jev']);

    // ...and every entry that did not make it has a recorded reason.
    const lines = sink.records.map((record) => record.msg).join('\n');
    expect(lines).toContain('unknown engine id');
    expect(lines).toContain('duplicate engine id');
    expect(lines).toContain('effects are not authorised');
    // The summary names both sides, so the difference is not something the
    // reader has to reconstruct from the individual lines.
    const pruned = sink.records.find((record) => record.msg === 'engine chain pruned');
    expect(pruned?.meta?.requested).toEqual(['nope', 'jev', 'jev', 'proc', 'net']);
    expect(pruned?.meta?.running).toEqual(['jev']);
  });

  it('records the fallback when nothing from the requested chain may run', () => {
    const sink = new MemoryLogSink();
    const logger = new Logger({ scope: 'chain', sink });
    const { facade } = makeFacade({ engines: [stubEngine('jev')], logger });

    expect(facade.setChain(['nope', 'jev', 'jev'])).toEqual(['jev']);
    expect(facade.setChain(['nope'])).toEqual(['rule']);

    const fallback = sink.records.find(
      (record) => record.msg === 'engine chain: nothing may run from the requested chain; using the rule engine',
    );
    // "Settings shows no usable engine, the rule engine answers" is a fact the
    // user can act on — but only if it is written down.
    expect(fallback).toBeDefined();
    expect(fallback?.meta?.requested).toEqual(['nope']);
  });
});

/**
 * A combination chain, entry by entry.
 *
 * ## Why this file exists
 *
 * The three reasons `resolveChainIds` drops an entry are tested one at a time
 * above, and each of them on a chain of its own. What a reader actually meets
 * is a chain with *several* problems in it, and the log for that chain is a
 * sequence of lines: the order they arrive in, and which reason each one
 * carries, are the two things that make the difference between "the app
 * dropped three engines" and "the app dropped the one I did not recognise,
 * kept the second copy of the one I listed twice, and refused the one that
 * starts processes".
 *
 * So this file pins the combination, not the reasons: the exact sequence of
 * log lines, the id each line names, and the chain that is left running.
 *
 * The chain is `['unknown', 'dup', 'dup', 'process-only']` — three of the
 * four entries dropped, each for a different reason. The one thing the
 * outcome depends on is whether this build knows `dup`, and both answers are
 * pinned below: an engine that is known and may run is kept, and the *second*
 * copy of it is the duplicate; an id this build does not know is dropped as
 * unknown, twice.
 */
describe('a combination chain: every entry, its reason, and the order', () => {
  it('names each dropped entry with its own reason, in the order the chain was written', () => {
    const sink = new MemoryLogSink();
    const logger = new Logger({ scope: 'chain', sink });
    const { facade } = makeFacade({
      engines: [
        // Known, and allowed to run: this is what makes the *second* copy
        // the duplicate rather than an unknown id.
        stubEngine('dup'),
        stubEngine('process-only', { sideEffects: ['process'] }),
      ],
      logger,
    });

    const running = facade.setChain(['unknown', 'dup', 'dup', 'process-only']);

    // `dup` is kept, so the chain is not empty and the rule engine is not the
    // fallback here — the first copy of a known, allowed engine.
    expect(running).toEqual(['dup']);
    expect(facade.chain).toEqual(['dup']);

    // The lines, in the order they were written. Each of the three drop
    // reasons appears once, and they are three different reasons — a chain
    // like this is the only place all three can appear at once.
    expect(sink.records.map((record) => record.msg)).toEqual([
      'engine chain: dropping an unknown engine id',
      'engine chain: dropping a duplicate engine id',
      'engine chain: dropping an engine whose effects are not authorised',
      'engine chain pruned',
    ]);

    // Each line names the entry it is about, so the reasons can be told
    // apart without reading the message.
    const [unknown, duplicate, unauthorised] = sink.records;
    expect(unknown?.meta?.engineId).toBe('unknown');
    expect(duplicate?.meta?.engineId).toBe('dup');
    expect(unauthorised?.meta?.engineId).toBe('process-only');
    // A refusal is a warning; a duplicate is a tidiness problem, and the
    // level says so.
    expect(unknown?.level).toBe('warn');
    expect(unauthorised?.level).toBe('warn');
    expect(duplicate?.level).toBe('info');

    // And the summary names both sides, so the difference between the chain
    // in Settings and the chain that runs is stated rather than reconstructed.
    const pruned = sink.records.find((record) => record.msg === 'engine chain pruned');
    expect(pruned?.meta?.requested).toEqual(['unknown', 'dup', 'dup', 'process-only']);
    expect(pruned?.meta?.running).toEqual(['dup']);
  });

  it('falls back to the rule engine when the same chain has nothing left to run', () => {
    // The same four ids, on a build that does not know `dup` either. Then the
    // second copy of it is unknown as well, nothing in the chain may run, and
    // the rule engine is the documented last resort (D-2) — said out loud,
    // because "Settings shows a chain, another one runs" has to have a cause
    // on record.
    const sink = new MemoryLogSink();
    const logger = new Logger({ scope: 'chain', sink });
    const { facade } = makeFacade({
      engines: [stubEngine('process-only', { sideEffects: ['process'] })],
      logger,
    });

    const running = facade.setChain(['unknown', 'dup', 'dup', 'process-only']);

    expect(running).toEqual([RULE_ENGINE_ID]);
    expect(facade.chain).toEqual([RULE_ENGINE_ID]);

    expect(sink.records.map((record) => record.msg)).toEqual([
      'engine chain: dropping an unknown engine id',
      'engine chain: dropping an unknown engine id',
      'engine chain: dropping an unknown engine id',
      'engine chain: dropping an engine whose effects are not authorised',
      'engine chain: nothing may run from the requested chain; using the rule engine',
    ]);

    // The last line is the one that explains the fallback, and it names the
    // chain that was asked for.
    const fallback = sink.records[sink.records.length - 1];
    expect(fallback?.meta?.requested).toEqual(['unknown', 'dup', 'dup', 'process-only']);
    // And the "pruned" summary is not written as well: the chain was not
    // pruned to something, it was emptied.
    expect(sink.records.some((record) => record.msg === 'engine chain pruned')).toBe(false);
  });
});
