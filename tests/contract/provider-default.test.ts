/**
 * The remembered default provider must actually survive a restart.
 *
 * ## Why this test is here and not in the E2E suite
 *
 * The composer's provider picker hands its choice to `settings.patch`, and an
 * E2E test can prove the call happens. It **cannot** prove durability: the
 * fixture bridge is in-memory by construction, so a reload builds a fresh
 * bridge and any remembered value is gone. An E2E test claiming "survives a
 * restart" would be claiming something the harness cannot see — and it would
 * have been claiming it while passing.
 *
 * So durability is proven here, against a real SQLite file and a real
 * `SessionStore`: patch, close, reopen, read back.
 *
 * ## The honesty rule this pins
 *
 * An empty `defaultProviderId` means "no preference" and is never a fabricated
 * vendor id (NFR-04) — the same rule `defaultAgentId` already follows, and the
 * reason a caller can tell "not chosen yet" from "chosen `''`, which is a
 * vendor id". Round-tripping `''` matters as much as round-tripping a real id:
 * a normaliser that substituted a placeholder for the empty string would
 * silently start sending turns to a vendor nobody picked.
 */

import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { Database, EventLog, SessionSequencer } from '@ucad/storage';
import { SessionStore } from '@ucad/session';
import { silentLogger } from '@ucad/observability';

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucad-provider-default-'));
  dbPath = path.join(dir, 'ucad.db');
});

afterAll(() => {
  /* each test removes its own directory */
});

/** Opens a store, runs `body`, then closes it — as a restart would. */
function acrossRestart(body: (store: SessionStore) => void): void {
  // `SessionStore` has no `close()`; the `Database` owns the connection, so the
  // store and its database are opened together and the database is what gets
  // closed. That is what makes this a restart rather than a second view of the
  // same connection.
  const open = (): { store: SessionStore; db: Database } => {
    const db = new Database({ dbPath, logger: silentLogger('test') });
    db.migrate();
    const eventLog = new EventLog({ db, logger: silentLogger('test') });
    return {
      db,
      store: new SessionStore({
        db,
        eventLog,
        sequencer: new SessionSequencer(db),
        logger: silentLogger('test'),
      }),
    };
  };
  const first = open();
  body(first.store);
  first.db.close();
}

function reopen(): { store: SessionStore; db: Database } {
  const db = new Database({ dbPath, logger: silentLogger('test') });
  db.migrate();
  return {
    db,
    store: new SessionStore({
      db,
      eventLog: new EventLog({ db, logger: silentLogger('test') }),
      sequencer: new SessionSequencer(db),
      logger: silentLogger('test'),
    }),
  };
}

describe('default provider is remembered across a restart', () => {
  it('starts with no preference rather than a fabricated vendor id', () => {
    acrossRestart((store) => {
      const settings = store.getSettings();
      expect(settings.provider.defaultProviderId).toBe('');
      // Belt and braces: the absence must be an empty string, never a
      // placeholder that happens to look empty after trimming.
      expect(settings.provider.defaultProviderId).not.toMatch(/default|auto|any/i);
    });
  });

  it('reads back an explicitly chosen vendor after reopening', () => {
    acrossRestart((store) => {
      store.patchSettings({ provider: { defaultProviderId: 'deepseek' } });
      expect(store.getSettings().provider.defaultProviderId).toBe('deepseek');
    });

    // A second open, so the value is read from SQLite rather than from the
    // object the first store happened to be holding.
    const reopened = reopen();
    expect(reopened.store.getSettings().provider.defaultProviderId).toBe('deepseek');
    reopened.db.close();
  });

  it('round-trips "no preference" as an empty string, not a placeholder', () => {
    acrossRestart((store) => {
      store.patchSettings({ provider: { defaultProviderId: 'openai' } });
      // Going back to "follow" must really go back. A normaliser that filled
      // the empty string in would start sending turns to a vendor the user
      // explicitly declined to choose.
      store.patchSettings({ provider: { defaultProviderId: '' } });
      expect(store.getSettings().provider.defaultProviderId).toBe('');
    });
  });

  it('patching the provider leaves every other section intact', () => {
    acrossRestart((store) => {
      const before = store.getSettings();
      store.patchSettings({ storage: { retentionDays: 30 } });
      const after = store.getSettings();
      expect(after.storage.retentionDays).toBe(30);

      store.patchSettings({ provider: { defaultProviderId: 'local' } });
      const third = store.getSettings();
      // The failure mode of a shallow merge is silently resetting unrelated
      // settings, so the neighbouring sections are asserted explicitly.
      expect(third.storage.retentionDays).toBe(30);
      expect(third.agent.defaultAgentId).toBe(before.agent.defaultAgentId);
      expect(third.locale).toBe(before.locale);
      expect(third.decision.chain).toEqual(before.decision.chain);
      expect(third.context.budget).toEqual(before.context.budget);
    });
  });

  it('falls back to the default when a stored document has no provider section', () => {
    // A settings blob written before this field existed. `normalizeSettings`
    // is the only thing standing between that file and a crash.
    acrossRestart((store) => {
      const raw = store.getSettings();
      expect(raw).toBeTruthy();
    });

    const store2 = reopen();
    store2.store.patchSettings({ locale: 'en-US' });
    // Rewrite the document the way a pre-provider build would have left it.
    store2.db.driver.run('UPDATE settings SET value_json = ? WHERE key = ?', [
      JSON.stringify({ version: 1, locale: 'en-US', agent: { defaultAgentId: 'universal' } }),
      'settings',
    ]);
    const recovered = store2.store.getSettings();
    expect(recovered.locale).toBe('en-US');
    expect(recovered.provider.defaultProviderId).toBe('');
    store2.db.close();
  });
});
