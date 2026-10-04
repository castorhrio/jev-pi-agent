/**
 * `decision.preview` must be a *question*, not a record.
 *
 * The bug this locks down: Main passed `turnId: session.id` for a decision asked
 * at the composer. `decisions.turn_id` REFERENCES `turns(id)` (§8.1), a session
 * id is not a turn id, so every single preview call failed with
 * `FOREIGN KEY constraint failed` — a feature that could never once succeed.
 * The same call would also have written a bogus `decisions` row and emitted a
 * `decision.made` event for a turn that does not exist, which is precisely what
 * the UI tells the user it does not do.
 *
 * NFR-16 still applies to a preview: it runs the same chain and still owes a
 * `rationale` and a `confidence`. What it does not do is persist.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Database, EventLog, SessionSequencer } from '@ucad/storage';
import { silentLogger, ulid } from '@ucad/observability';
import { SessionStore } from '@ucad/session';
import { DecisionChain, DecisionService, RuleDecisionEngine, buildDecisionFacts } from '@ucad/decision';
import type { DecisionMadeInput } from '@ucad/decision';
import type { DecisionFacts } from '@ucad/contracts';

function facts(): DecisionFacts {
  return buildDecisionFacts({
    workspace: { id: 'ws_preview', trusted: true },
    availableAgents: [
      {
        id: 'mock',
        kind: 'mock',
        isDefaultRuntime: true,
        capabilities: { streaming: true, modelSelection: false, usageReporting: true },
      },
    ],
    git: { dirty: true, changedFiles: 3, branch: 'main' },
    context: { itemCount: 4, estimatedTokens: 900, freshness: 'fresh' },
    signals: { consecutiveFailures: 0, permissionDenials: 0, elapsedMs: 0, turnIndex: 0 },
  });
}

describe('decision.preview is a dry run', () => {
  let dir: string;
  let db: Database;
  let store: SessionStore;
  let service: DecisionService;
  let emitted: DecisionMadeInput[];
  let sessionId: string;
  let turnId: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucad-preview-'));
    db = new Database({ dbPath: path.join(dir, 'ucad.db'), logger: silentLogger('preview') });
    db.migrate();

    const eventLog = new EventLog({ db, logger: silentLogger('preview') });
    store = new SessionStore({
      db,
      logger: silentLogger('preview'),
      eventLog,
      sequencer: new SessionSequencer(db),
    });

    const workspace = store.upsertWorkspace({ path: dir, name: 'preview', trustState: 'trusted' });
    const session = store.createSession({
      workspaceId: workspace.id,
      agentId: 'mock',
      permissionMode: 'ask',
      title: 'preview',
    });
    sessionId = session.id;

    emitted = [];
    service = new DecisionService({
      chain: new DecisionChain({ engines: [new RuleDecisionEngine()], logger: silentLogger('preview') }),
      db,
      logger: silentLogger('preview'),
      onDecision: (input) => emitted.push(input),
    });
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const countDecisions = (): number =>
    db.driver.get<{ n: number }>('SELECT COUNT(*) AS n FROM decisions')?.n ?? 0;

  it('answers with a rationale and a confidence, like any real decision (NFR-16)', async () => {
    const envelope = await service.decide({
      sessionId,
      objective: 'should I refactor this before shipping?',
      kind: 'risk',
      facts: facts(),
      preview: true,
    });

    expect(envelope.result.rationale.length).toBeGreaterThan(0);
    expect(envelope.result.confidence).toBeGreaterThan(0);
    expect(envelope.result.producedBy.engineId).toBe('rule');
  });

  it('writes no decisions row and emits no decision.made', async () => {
    expect(countDecisions()).toBe(0);

    await service.decide({
      sessionId,
      objective: 'route this',
      kind: 'route',
      facts: facts(),
      preview: true,
    });

    expect(countDecisions()).toBe(0);
    expect(emitted).toEqual([]);
  });

  it('succeeds with no turnId, where the old code hit the turn_id foreign key', async () => {
    // No turn exists in this session yet — the exact situation a composer-side
    // preview is in. The old implementation passed `sessionId` here and every
    // call died on `FOREIGN KEY constraint failed`.
    expect(store.listTurns(sessionId)).toEqual([]);

    await expect(
      service.decide({
        sessionId,
        objective: 'which agent should take this?',
        kind: 'route',
        facts: facts(),
        preview: true,
      }),
    ).resolves.toBeDefined();

    // And a non-preview decision with a fake turn id is still rejected, so the
    // preview path can never be "fixed" by quietly persisting it later.
    turnId = ulid('turn_fake_');
    await expect(
      service.decide({
        sessionId,
        turnId,
        objective: 'which agent should take this?',
        kind: 'route',
        facts: facts(),
      }),
    ).rejects.toBeDefined();
  });

  it('a real decision on a real turn still persists and still emits', async () => {
    turnId = store.beginTurn({ sessionId, objective: 'ship it' }).turnId;

    const envelope = await service.decide({
      sessionId,
      turnId,
      objective: 'ship it',
      kind: 'risk',
      facts: facts(),
    });

    expect(countDecisions()).toBe(1);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.turnId).toBe(turnId);
    expect(envelope.result.rationale.length).toBeGreaterThan(0);
  });
});
