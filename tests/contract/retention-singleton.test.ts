/**
 * §8.4 — there is one retention service, and Main owns it.
 *
 * ## The failure this file pins
 *
 * The storage IPC layer used to build a retention service of its own, lazily,
 * on first use — a *second* instance over the same database. Nothing crashed:
 * `storage:usage` answered from one instance and the start-up sweep ran in the
 * other, so a purge and a retention sweep could each believe they had the last
 * word about what was left on disk, and the Settings pane could keep reporting
 * sessions that had already been deleted.
 *
 * That was fixed once by making the container hand out `getRetention()`. A fix
 * with no test is the same defect waiting for its next refactor: `new
 * RetentionService(...)` inside `ipc-storage.ts` type-checks, passes every
 * existing storage test (they inject a fake `ucad`), and reintroduces exactly
 * the two-views-of-one-database bug. So the assertions below are about
 * *identity*, not behaviour — identity is the whole contract.
 *
 * ## Why identity and not "both sides see the same rows"
 *
 * Two instances over the same SQLite file agree about the rows; that is
 * precisely why the defect was invisible. What they do not share is anything
 * held in the instance — and the next cached count, cached window or in-flight
 * sweep is what turns two instances into two answers. `spy.mock.instances`
 * names the object the real IPC handler called, so the test fails the moment
 * the handler builds its own.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * `app-container.ts` imports `safeStorage` at module load. Nothing here reaches
 * the OS key store — the container is built with its storage fields injected —
 * but the import has to resolve.
 */
vi.mock('electron', () => ({
  safeStorage: {
    encryptString: () => Buffer.alloc(0),
    decryptString: () => '',
  },
}));

import { IPC_CHANNELS } from '@ucad/contracts';
import { RetentionService } from '@ucad/session';
import type { StoragePurgeResult, StorageUsageDto } from '@ucad/contracts';
import { silentLogger } from '@ucad/observability';

import { UcadApp, RETENTION_DEPENDENCIES } from '../../apps/desktop/src/main/app-container';
import { registerStorageIpc } from '../../apps/desktop/src/main/ipc-storage';
import type { AppPaths } from '../../apps/desktop/src/main/paths';

/**
 * The fields the retention service is built from.
 *
 * Written out here as well as in the product, and the two are compared
 * below. The product's list is what the guard is *typed* by; this one is what
 * a rename has to change as well — so `sessionStore` becoming `sessions`
 * fails the build and the suite, instead of leaving a guard that checks a
 * field nothing reads any more.
 */
const GUARDED_FIELDS = ['db', 'sessionStore', 'blobs', 'logger'] as const;

const PATHS: AppPaths = {
  userData: '/ucad-test/userData',
  dbPath: '/ucad-test/userData/ucad.db',
  blobDir: '/ucad-test/userData/blobs',
  logDir: '/ucad-test/userData/logs',
  cacheDir: '/ucad-test/userData/cache',
  downloadDir: '/ucad-test/userData/downloads',
};

const PURGED: StoragePurgeResult = {
  scope: 'expired',
  sessionsRemoved: 0,
  eventsRemoved: 0,
  blobFilesRemoved: 0,
  bytesReclaimed: 0,
};

/**
 * The real `UcadApp`, with only the storage collaborators replaced.
 *
 * Deliberately the real container: a hand-written `{ getRetention: () => instance }`
 * double is what the existing storage tests use, and it is exactly the shape
 * that cannot catch the bug — it *is* the singleton, so the test asserts what
 * it injected.
 */
function makeApp(): UcadApp {
  const app = new UcadApp({ paths: PATHS });
  // Exactly the collaborators `getRetention()` reads — no more, no less. The
  // guard added to the container checks precisely these four, so a hand-built
  // container is still the real code path into the service: a fake that
  // satisfied fewer of them would be testing a container that cannot exist.
  app.db = {} as UcadApp['db'];
  app.sessionStore = {} as UcadApp['sessionStore'];
  app.blobs = {} as UcadApp['blobs'];
  app.logger = silentLogger('container');
  return app;
}

/** The storage IPC handlers, registered against a real container. */
function registerHandlers(ucad: UcadApp): Map<string, (...args: unknown[]) => unknown> {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  registerStorageIpc({
    handle: (channel, fn) => handlers.set(channel, fn),
    ucad,
    getWindow: () => null,
  });
  return handlers;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the container owns one retention service (§8.4)', () => {
  it('answers every request with the same instance', () => {
    const app = makeApp();

    const first = app.getRetention();

    // Two calls, one instance. This is what "the container hands out the one
    // instance" means, and it fails if the guard (`retentionService === null`)
    // is ever dropped or the field is reset between calls.
    expect(app.getRetention()).toBe(first);
    // The `retention` getter exists so `applyRetentionOnStart` does not have to
    // remember to call the method; a getter that built its own would be a
    // second answer to the same question.
    expect(app.retention).toBe(first);
  });

  it('refuses to build a service on a container that has not started', () => {
    // `db`/`sessionStore`/`blobs`/`logger` are `field!: T` declarations whose
    // order is a promise `start()` keeps. Before that call they are
    // `undefined` at runtime while the type system still calls them a
    // `Database`, so the service used to be constructed *over* `undefined`.
    // Nothing threw: the first `usage()` or `purge()` failed somewhere inside
    // the storage layer with a message about SQLite, and the report named the
    // wrong layer entirely.
    const app = new UcadApp({ paths: PATHS });

    let thrown: unknown;
    try {
      app.getRetention();
    } catch (error) {
      thrown = error;
    }

    expect(thrown, 'an unstarted container handed out a retention service').toBeInstanceOf(Error);
    // The code is the one a support report filters on; without it the refusal
    // is `UNKNOWN`, which is indistinguishable from a crash. It also names the
    // lifecycle rather than storage: the old `STORAGE_ERROR` sent a report to
    // SQLite when the container had simply never been started.
    expect((thrown as { code?: string }).code).toBe('CONTAINER_NOT_STARTED');
    // And the component names the container, not the layer the caller would
    // have used. The code was split from `STORAGE_ERROR` first; leaving the
    // component as `storage` kept pointing the same report at SQLite.
    expect((thrown as { component?: string }).component).toBe('container');
    expect((thrown as { component?: string }).component).not.toBe('storage');
    // The message names *which* field was missing, so "call start() first" is
    // actionable rather than a guess about the container's whole state.
    expect((thrown as Error).message).toContain('db');
    expect((thrown as Error).message).toContain('start()');
  });

  it('does not cache the refusal once the container has its storage', () => {
    // A guard that threw *after* assigning a half-built service, or that left
    // the field set to a placeholder, would make the second call return the
    // broken instance — the failure would then be permanent for a container
    // that is perfectly usable a moment later.
    const app = new UcadApp({ paths: PATHS });
    // The same refusal as above, not some incidental `TypeError`: without the
    // guard the service is built over `undefined` and the throw comes from
    // inside the constructor, which would make this test pass for the wrong
    // reason.
    expect(() => app.getRetention()).toThrow(/尚未初始化/);

    app.db = {} as UcadApp['db'];
    app.sessionStore = {} as UcadApp['sessionStore'];
    app.blobs = {} as UcadApp['blobs'];
    app.logger = silentLogger('container');

    const first = app.getRetention();
    expect(first).toBeInstanceOf(RetentionService);
    expect(app.getRetention()).toBe(first);
  });

  it('names the field that is missing — one field at a time', () => {
    // The guard checked four fields and the suite only ever exercised `db`,
    // so three of the four could have been dropped from the guard — or
    // renamed in the product — and every test here would still have passed.
    // Each field is now missing on its own, and the refusal has to name
    // *that* field: a guard that says "not initialised" without saying which
    // one is a support report that starts with a guess.
    for (const field of GUARDED_FIELDS) {
      const app = makeApp();
      // Only this one is missing: the other three are the real collaborators
      // `makeApp()` installs, so the refusal cannot come from a neighbour.
      (app as unknown as Record<string, unknown>)[field] = undefined;

      let thrown: unknown;
      try {
        app.getRetention();
      } catch (error) {
        thrown = error;
      }

      expect(thrown, `a container missing only ${field} handed out a retention service`)
        .toBeInstanceOf(Error);
      // The same code as the blanket refusal, and the same distinction from a
      // storage fault: the missing field is the symptom, the unstarted
      // container is the cause.
      expect((thrown as { code?: string }).code).toBe('CONTAINER_NOT_STARTED');
      expect((thrown as { component?: string }).component).toBe('container');
      // And the field itself, so the message is actionable.
      expect((thrown as Error).message, `the refusal did not name ${field}`).toContain(field);
    }
  });

  it('guards exactly the fields the retention service is built from', () => {
    // The product's list is the contract the guard is typed by; this is the
    // same list written out, so a field added on one side and forgotten on
    // the other is a failing test rather than a guard that quietly covers
    // less than the service needs.
    expect([...RETENTION_DEPENDENCIES]).toEqual([...GUARDED_FIELDS]);
  });

  it('builds one per container, not one per process', () => {
    // Two containers are two databases in the tests, so sharing one service
    // across them would be the *opposite* bug (a purge against the wrong file).
    const a = makeApp();
    const b = makeApp();
    expect(a.getRetention()).not.toBe(b.getRetention());
  });
});

describe('the storage IPC layer purges through that instance', () => {
  it('runs the user’s purge on the container’s service, not one of its own', async () => {
    const app = makeApp();
    const purge = vi
      .spyOn(RetentionService.prototype, 'purge')
      .mockResolvedValue(PURGED);

    const handlers = registerHandlers(app);
    const run =
      handlers.get(IPC_CHANNELS.storage.purge) ??
      (() => {
        throw new Error('storage:purge is not registered');
      });

    // Twice: a second call must not be an excuse to build a second service.
    const first = await run({ scope: 'expired', confirm: true });
    const second = await run({ scope: 'all', confirm: true });

    expect(first).toEqual(PURGED);
    expect(second).toEqual(PURGED);
    expect(purge).toHaveBeenCalledTimes(2);

    // The object the handler called is the object the container hands out.
    // This is the assertion that fails if `ipc-storage.ts` ever writes
    // `new RetentionService(...)`: that instance is still *a* retention
    // service, still purges, still returns the same rows — and is not this one.
    const container = app.getRetention();
    for (const self of purge.mock.instances) {
      expect(self).toBe(container);
    }
    expect(purge.mock.instances).toHaveLength(2);
  });

  it('reads usage from the same instance it purges from', async () => {
    const app = makeApp();
    const usage = vi
      .spyOn(RetentionService.prototype, 'usage')
      .mockResolvedValue({
        dbBytes: 0,
        blobBytes: 0,
        sessions: 0,
        turns: 0,
        events: 0,
        messages: 0,
        blobFiles: 0,
        retentionDays: 90,
        expiredSessions: 0,
        encryptionEnabled: false,
      } satisfies StorageUsageDto);
    const purge = vi
      .spyOn(RetentionService.prototype, 'purge')
      .mockResolvedValue(PURGED);

    const handlers = registerHandlers(app);
    await handlers.get(IPC_CHANNELS.storage.usage)!();
    await handlers.get(IPC_CHANNELS.storage.purge)!({ scope: 'expired', confirm: true });

    // Both channels, one instance: what the user was shown is measured on the
    // service that then deleted the rows, so the numbers cannot describe a
    // database nobody purged.
    const container = app.getRetention();
    expect(usage.mock.instances).toHaveLength(1);
    expect(purge.mock.instances).toHaveLength(1);
    expect(usage.mock.instances[0]).toBe(container);
    expect(purge.mock.instances[0]).toBe(container);
  });

  it('and so does the start-up sweep', async () => {
    const app = makeApp();
    const applied = vi
      .spyOn(RetentionService.prototype, 'applyRetention')
      .mockResolvedValue(PURGED);
    const purge = vi
      .spyOn(RetentionService.prototype, 'purge')
      .mockResolvedValue(PURGED);

    // Main's own path, the one that runs before any window exists.
    await app.applyRetentionOnStart();

    const handlers = registerHandlers(app);
    await handlers.get(IPC_CHANNELS.storage.purge)!({ scope: 'expired', confirm: true });

    const container = app.getRetention();
    // The sweep and the user's purge are the same object: this is what makes
    // "the window is only a promise if something applies it" true for the
    // sessions the pane reports.
    expect(applied.mock.instances).toEqual([container]);
    expect(purge.mock.instances).toEqual([container]);
  });
});
