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
import {
  DROP_REASON,
  DecisionFacade,
  ENGINE_CHAIN_DROP_REASONS,
  SIDE_EFFECT_REFUSAL_EXPLANATION,
  SIDE_EFFECT_REFUSALS,
} from '../../apps/desktop/src/main/decision-facade';
import type {
  EngineChainDropReason,
  SideEffectRefusal,
} from '../../apps/desktop/src/main/decision-facade';

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
      (record) => record.msg === 'engine chain: dropping an engine whose effects may not run',
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

  /**
   * The two refusals are not the same event.
   *
   * They used to share one line — "an engine whose effects are not authorised"
   * — and that sentence is false of one of them. `['none', 'network']` was not
   * refused because the network was unauthorised: it was refused because the
   * manifest says two contradictory things, and no setting could have made it
   * runnable. The person who has to fix it needs to know which they are
   * looking at — a manifest to correct, or a setting to switch — and the two
   * need different fixes.
   *
   * The reason is therefore a field of its own, and it is the same field on
   * every drop line, so a report can count the reasons without reading the
   * event strings.
   */
  it('says which kind of refusal it was, so the two are not one event', () => {
    const sink = new MemoryLogSink();
    const logger = new Logger({ scope: 'chain', sink });
    const { facade } = makeFacade({
      engines: [
        // Says "no effects" and "network" at once: it contradicts itself, and
        // no setting can make that declaration true.
        stubEngine('confused', { sideEffects: ['none', 'network'] }),
        // Says the same effect twice: the same contradiction, one element on.
        stubEngine('repeated', { sideEffects: ['network', 'network'] }),
        // Asks for an effect no setting permits. Not a contradiction — a plain
        // request the user never agreed to.
        stubEngine('proc', { sideEffects: ['process'] }),
        // The network, with the network authorised: allowed, so not on the
        // list at all.
        stubEngine('net', { sideEffects: ['network'] }),
      ],
      logger,
      allowNetworkEngines: true,
    });

    expect(facade.setChain(['confused', 'repeated', 'proc', 'net'])).toEqual(['net']);

    const refusals = sink.records.filter(
      (record) => record.msg === 'engine chain: dropping an engine whose effects may not run',
    );

    // The reason, per engine. A repeated element is a contradiction and not a
    // wider permission — the contract says so, and the log now says it too.
    // The list is typed, so a reason misspelled here fails `npm run typecheck`
    // rather than quietly failing to match the log.
    const expected: EngineChainDropReason[] = ['contradiction', 'contradiction', 'unauthorized'];
    expect(refusals.map((record) => record.meta?.['reason'])).toEqual(expected);
    // The engine that was allowed produced no line at all: a reason that is
    // written for an engine nobody refused would be a claim about the chain.
    expect(refusals.map((record) => record.meta?.['engineId'])).toEqual([
      'confused',
      'repeated',
      'proc',
    ]);
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
    expect(lines).toContain('effects may not run');
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
      'engine chain: dropping an engine whose effects may not run',
      'engine chain pruned',
    ]);

    // Each line names the entry it is about, so the reasons can be told
    // apart without reading the message.
    const [unknown, duplicate, unauthorised] = sink.records;
    expect(unknown?.meta?.engineId).toBe('unknown');
    expect(duplicate?.meta?.engineId).toBe('dup');
    expect(unauthorised?.meta?.engineId).toBe('process-only');
    // And the same field says *why*, on every one of the three lines — so a
    // report can count the reasons without matching on the event strings.
    expect(unknown?.meta?.reason).toBe('unknown');
    expect(duplicate?.meta?.reason).toBe('duplicate');
    expect(unauthorised?.meta?.reason).toBe('unauthorized');
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
      'engine chain: dropping an engine whose effects may not run',
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

  it('calls a self-contradicting engine a contradiction, both times, and never a duplicate', () => {
    // The one combination the three-reason test above cannot reach: the same id
    // twice *and* a manifest that may not run. Two questions apply to the
    // second entry — "is it allowed to run?" and "is it already in the chain?"
    // — and this product answers the first one, twice.
    //
    // What makes that a decision rather than an accident is that the duplicate
    // check consults the ids *kept so far* (`ids.includes`), not a `seen` set
    // of the requested ids. Swap that for the usual `seen` set and the first
    // copy is still refused, but the second becomes a `duplicate` — which
    // tells the user to delete a line from Settings when the engine is the
    // thing that is broken. That is the edit this test catches.
    const sink = new MemoryLogSink();
    const logger = new Logger({ scope: 'chain', sink });
    const { facade } = makeFacade({
      engines: [stubEngine('jev', { sideEffects: ['none', 'network'] })],
      logger,
    });

    const running = facade.setChain(['jev', 'jev']);

    // Nothing may run, so the rule engine is the last resort (D-2).
    expect(running).toEqual([RULE_ENGINE_ID]);
    expect(facade.chain).toEqual([RULE_ENGINE_ID]);

    // One line per dropped entry — the chain has two entries, and a reader of
    // the log can match each line to a line in Settings.
    const refused = sink.records.filter(
      (record) => record.msg === 'engine chain: dropping an engine whose effects may not run',
    );
    expect(refused).toHaveLength(2);
    expect(refused.map((record) => record.meta?.reason)).toEqual([
      'contradiction',
      'contradiction',
    ]);
    expect(refused.map((record) => record.meta?.engineId)).toEqual(['jev', 'jev']);
    // Every line is a warning and each explains itself: a reader who has never
    // opened `decision-facade.ts` must not have to look up the token.
    for (const record of refused) {
      expect(record.level).toBe('warn');
      expect(record.meta?.reasonExplanation).toBe(SIDE_EFFECT_REFUSAL_EXPLANATION.contradiction);
    }

    // And no duplicate line exists at all. This is the assertion that fails if
    // the duplicate check is ever rewritten to a `seen` set built from the
    // request: the first copy is still refused, but the second would arrive as
    // `duplicate`, and the user would be told to delete a line instead of to
    // fix an engine.
    expect(sink.records.some((record) => record.meta?.reason === 'duplicate')).toBe(false);
    expect(sink.records.map((record) => record.msg)).toEqual([
      'engine chain: dropping an engine whose effects may not run',
      'engine chain: dropping an engine whose effects may not run',
      'engine chain: nothing may run from the requested chain; using the rule engine',
    ]);
  });
});

/**
 * Every refusal has a case that produces it — and says what it means.
 *
 * The refusals above are pinned one shape at a time, and each of them asserts
 * *its own* reason. What none of them asks is whether the reasons they name
 * are all the reasons there are: a third member added to `SideEffectRefusal`
 * (with `refusalReason` returning it) would have kept every one of those tests
 * green, because a test cannot enumerate the members of a type at runtime any
 * more than it can typecheck them.
 *
 * The table in `decision-facade.ts` is what makes the type growable only on
 * purpose: `Record<SideEffectRefusal, string>` fails `tsc` for a member with no
 * explanation. A test run cannot enumerate a type — types are erased — so the
 * vocabulary is a *value*: `SIDE_EFFECT_REFUSALS` is the array the type is
 * derived from, the same role `ZOD_ISSUE_CODES` plays for
 * `ZOD_REASON_BY_CODE` in `ipc-errors.test.ts`. It is compared with the table
 * in both directions, and every member is asked for a declaration that
 * produces it: an entry nothing can confirm is indistinguishable from an entry
 * that is right.
 *
 * The array is imported rather than restated on purpose. A hand list here was
 * a second spelling of the vocabulary, related to the type as a subset: a third
 * refusal added to the union left this file green while it compared a table
 * with a list of two. Imported, a member added to `SIDE_EFFECT_REFUSALS` is a
 * `tsc` error at the `Record` and a real case in the loop below, with nothing
 * to remember.
 */

describe('every side-effect refusal has a case, and an explanation', () => {
  /**
   * One declaration that produces each refusal.
   *
   * Typed `Record<SideEffectRefusal, …>` so a member with no sample is a
   * `tsc` error here too, and matched against `ALL_REFUSALS` below so that a
   * sample left behind for a deleted member fails as well.
   */
  const SAMPLES: Record<SideEffectRefusal, DecisionEngineManifest['sideEffects']> = {
    // Says "no effects" and "network" at once — the manifest contradicts
    // itself, and no setting can make that declaration true.
    contradiction: ['none', 'network'],
    // An effect this build has a checkbox for nowhere: a plain request the
    // user never agreed to, which is not the same thing as a contradiction.
    unauthorized: ['process'],
  };

  it('produces each refusal exactly as its sample declares, and explains it', () => {
    // The network is authorised, so no sample is refused for want of a setting:
    // what the lines record is the declaration, not the checkbox.
    const ids = Object.keys(SAMPLES) as SideEffectRefusal[];
    const sink = new MemoryLogSink();
    const logger = new Logger({ scope: 'chain', sink });
    const { facade } = makeFacade({
      engines: ids.map((id) => stubEngine(id, { sideEffects: SAMPLES[id] })),
      logger,
      allowNetworkEngines: true,
    });

    // Every sample is refused, so nothing but the rule engine may run.
    expect(facade.setChain(ids)).toEqual([RULE_ENGINE_ID]);

    const refusals = sink.records.filter(
      (record) => record.msg === 'engine chain: dropping an engine whose effects may not run',
    );

    // One line per member, and the engine id is the reason it was refused — so
    // a sample that produced the *other* refusal is visible rather than
    // silently accepted.
    expect(refusals.map((record) => record.meta?.['engineId'])).toEqual(ids);
    expect(refusals.map((record) => record.meta?.['reason'])).toEqual(ids);

    // And the line carries the explanation the table holds, not the bare token.
    // A member whose sentence was forgotten would have logged `undefined`
    // before `tsc` had a chance to run.
    for (const record of refusals) {
      const reason = record.meta?.['reason'] as SideEffectRefusal;
      const explanation = record.meta?.['reasonExplanation'];

      expect(explanation, `${reason}: the line has no explanation`).toBe(
        SIDE_EFFECT_REFUSAL_EXPLANATION[reason],
      );
      expect(String(explanation).length, `${reason}: the explanation is empty`).toBeGreaterThan(0);
    }

    // The two explanations are not one sentence reused: the refusals need
    // different fixes, which is why they are told apart at all.
    expect(new Set(Object.values(SIDE_EFFECT_REFUSAL_EXPLANATION)).size).toBe(ids.length);
  });

  it('has an explanation for every refusal, and no explanation for a refusal that is gone', () => {
    // The runtime half of `Record<SideEffectRefusal, string>`, in both
    // directions: a member with no row would log `undefined` as the sentence,
    // and a row for a member the union no longer has is a sentence nobody can
    // ever see. The suite transpiles without typechecking, so without this the
    // `Record` annotation would be the only check — and it is not run by
    // `npm test`.
    expect([...SIDE_EFFECT_REFUSALS].sort()).toEqual(
      Object.keys(SIDE_EFFECT_REFUSAL_EXPLANATION).sort(),
    );
  });

  it('has a sample for every refusal, and no sample for a refusal that is gone', () => {
    // The same question for the sample map above: its `Record` type catches a
    // missing member only under `tsc`, so compare it with the array. A member
    // with no sample would shrink the loop in the case above; a sample left
    // behind for a deleted member is a test that no longer tests anything.
    expect(Object.keys(SAMPLES).sort()).toEqual([...SIDE_EFFECT_REFUSALS].sort());
  });
});

/**
 * The drop reasons, as the log writes them — enumerated at runtime.
 *
 * `DROP_REASON` is the table every drop line reads its `reason` field from, and
 * until this block existed it was checked by `tsc` alone. That check was worth
 * having but was not the claim the comment above the table made: `satisfies
 * Record<EngineChainDropReason, EngineChainDropReason>` is the cross product,
 * so `unknown: 'duplicate'` compiled — every key a reason, every value a
 * reason, and the two spellings free to disagree. The table's annotation is a
 * mapped type now, so that particular lie is a compile error (verified by
 * editing the table and watching `npm run typecheck` refuse it). What the
 * compiler still cannot do is tell whether the union has members the table has
 * forgotten, or whether the tokens here are the ones the refusal table
 * explains: `tests/` is transpiled without typechecking, and a test cannot
 * enumerate a type.
 *
 * So the union has a runtime stand-in — `ENGINE_CHAIN_DROP_REASONS`, the array
 * the type is derived from, the same role `SIDE_EFFECT_REFUSALS` plays for
 * {@link SideEffectRefusal} — and the two tables are compared against each
 * other, because they write the same log field. A report that counts `reason`
 * values sees one vocabulary; two tables drifting into two vocabularies is the
 * drift with no reader to notice it.
 */

describe('every drop reason is a token the log can be read back by', () => {
  it('writes each reason as its own name, once each', () => {
    // The runtime half of the mapped type in `decision-facade.ts`, which
    // `npm test` never runs: the values are the keys, so a report keyed on the
    // token and a report keyed on the name count the same lines.
    expect(
      [...new Set(Object.values(DROP_REASON))],
      'a drop reason is written under a token that is not its own name',
    ).toEqual(Object.keys(DROP_REASON));
  });

  it('names every reason the union has, and no reason it does not', () => {
    // The other direction, against the array the type is derived from: a fifth
    // reason with no row here would leave the log writing a token this file
    // cannot enumerate, and a row left behind for a deleted member is a
    // promise about a line nothing can produce.
    expect(
      Object.keys(DROP_REASON).sort(),
      'DROP_REASON and EngineChainDropReason disagree about which reasons exist',
    ).toEqual([...ENGINE_CHAIN_DROP_REASONS].sort());
    // Non-vacuous: an empty table would satisfy both directions above.
    expect(ENGINE_CHAIN_DROP_REASONS.length).toBeGreaterThan(2);
  });

  it('uses one vocabulary for the refusals the log explains', () => {
    // The refusals are written into the same `reason` field as `unknown` and
    // `duplicate`, so their tokens have to be drop reasons — and the *same*
    // ones: `reasonExplanation` is looked up with the token, so a refusal whose
    // table key and log token differed would make the sentence unreachable.
    const refusals = Object.keys(SIDE_EFFECT_REFUSAL_EXPLANATION) as SideEffectRefusal[];
    expect(refusals.length, 'the refusal table is empty, so this proves nothing').toBeGreaterThan(
      0,
    );

    expect(
      refusals.filter((refusal) => !(refusal in DROP_REASON)),
      'a refusal is logged under a token a reader of drop reasons has never been told about',
    ).toEqual([]);
    for (const refusal of refusals) {
      expect(
        DROP_REASON[refusal],
        `${refusal}: the refusal table's key and the token the log writes differ`,
      ).toBe(refusal);
    }

    // And the split is deliberate rather than an oversight: the reasons the
    // refusal table does not explain are exactly the two about the *chain*.
    // A refusal added to the union without an explanation would show up here,
    // which is the runtime half of `Record<SideEffectRefusal, string>`.
    expect(
      Object.keys(DROP_REASON).filter((reason) => !refusals.includes(reason as SideEffectRefusal)),
      'a drop reason has no explanation, or a refusal reached the log without one',
    ).toEqual(['unknown', 'duplicate']);
  });
});
