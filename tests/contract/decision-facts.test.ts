/**
 * The facts the Decision plane is asked to decide on.
 *
 * ## Why this file exists
 *
 * `DecisionFacade.facts()` is Main's half of the decision: it turns what the
 * app knows about the turn into the `DecisionFacts` the engines read. One
 * field in there is a promise about knowledge, not a measurement — the
 * freshness of the context pack.
 *
 * It had exactly one shape in the code and no shape at all in a test:
 *
 * ```ts
 * freshness: input.freshness ?? (input.packId === undefined ? 'unknown' : 'fresh'),
 * ```
 *
 * Three things ride on that one line, and none of them was pinned:
 *
 * - **A pack id means "fresh"** — the pack was built, so the context the
 *   engines reason about is the context the turn will use.
 * - **No pack id means "unknown"**, and *not* "fresh with zero items". A
 *   decision that believes the context is fresh and empty is worse than one
 *   that admits it does not know: the first one scores a missing pack as a
 *   good one.
 * - **An explicit freshness wins.** The caller that measured the pack knows
 *   more than the presence of an id does — a pack built three turns ago is
 *   `stale` even though it has an id, and the id cannot say so.
 *
 * An engine that reads `freshness` scores the turn on it, so a wrong value
 * here is a wrong decision, not a wrong label.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Database } from '@ucad/storage';
import { silentLogger } from '@ucad/observability';
import { DecisionFacade } from '../../apps/desktop/src/main/decision-facade';

/** A facade on a throwaway database — the facts never touch it. */
function makeFacade(): DecisionFacade {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucad-facts-'));
  const db = new Database({ dbPath: path.join(dir, 'ucad.db'), logger: silentLogger('facts') });
  db.migrate();

  return new DecisionFacade({
    db,
    logger: silentLogger('facts'),
    chain: ['rule'],
    timeoutMs: 2000,
    allowNetworkEngines: false,
    engines: [],
    admit: () => undefined,
  });
}

/** The facts of a turn, with everything but the context left out. */
function factsFor(
  facade: DecisionFacade,
  context: { packId?: string; freshness?: 'fresh' | 'stale' | 'unknown' | 'mixed' },
) {
  return facade.facts({
    workspaceId: 'ws_facts',
    trusted: true,
    agents: [],
    turnIndex: 0,
    ...context,
  });
}

describe('the freshness of the context pack', () => {
  it('is fresh when a pack was built for the turn', () => {
    const facade = makeFacade();

    const facts = factsFor(facade, { packId: 'p1' });

    expect(facts.context.freshness).toBe('fresh');
    // The pack id travels with the claim, so the two cannot disagree.
    expect(facts.context.packId).toBe('p1');
  });

  it('is unknown when no pack was built at all', () => {
    const facade = makeFacade();

    const facts = factsFor(facade, {});

    // Not "fresh", and not "fresh with zero items": the pack is missing, and
    // a decision that believes the context is fresh and empty scores a
    // missing pack as a good one.
    expect(facts.context.freshness).toBe('unknown');
    // And the id is absent rather than an empty string, so "no pack" cannot
    // be read as "a pack with no name".
    expect(facts.context.packId).toBeUndefined();
  });

  it('is what the caller measured, when the caller measured it', () => {
    const facade = makeFacade();

    // A pack id says a pack exists; it cannot say how old the pack is. The
    // caller that built it knows, so its answer wins over the id's.
    const facts = factsFor(facade, { packId: 'p1', freshness: 'stale' });

    expect(facts.context.freshness).toBe('stale');
    expect(facts.context.packId).toBe('p1');
  });

  it('carries every state the contract allows, unchanged', () => {
    const facade = makeFacade();

    // The explicit value is passed through, whatever it is — the facade
    // does not second-guess a measurement, and it does not narrow the
    // contract's states to the two it can derive from an id.
    for (const freshness of ['fresh', 'stale', 'unknown', 'mixed'] as const) {
      const facts = factsFor(facade, { packId: 'p1', freshness });
      expect(facts.context.freshness, `freshness: ${freshness} was not carried through`).toBe(freshness);
    }
  });
});
