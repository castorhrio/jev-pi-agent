/**
 * The container's `!` fields are a promise `start()` keeps.
 *
 * ## The claim this file turns into an assertion
 *
 * `app-container.ts` declares every subsystem as `field!: T`. The `!` is the
 * type system's way of saying "this is assigned somewhere else, trust me" —
 * and the somewhere else is `#initLogging()`, `#initStorage()`,
 * `#initServices()`, `#initPlanes()` and `#initRuntime()`, in that order. The
 * claim is worth nothing on its own: a step that forgets to assign a field
 * leaves `undefined` behind a type that says `Database`, and the first
 * caller that touches it fails somewhere else entirely — a storage-layer
 * error about SQLite, when the truth is that the container was never
 * finished.
 *
 * Nothing tested that. A container could lose half its subsystems and every
 * existing test would still pass, because each of them builds the container
 * by hand and fills in only the collaborators it needs.
 *
 * ## What this file does about it
 *
 * Two gates, because either one alone has a hole:
 *
 *  - the *scan* reads the source and finds the claims — every `field!: T`
 *    declaration — so a field that is added to the container is a field this
 *    file knows about. A list written by hand would go stale silently, and a
 *    field nobody lists is a field nobody checks;
 *  - the *run* starts a real container in a temporary directory and asks
 *    whether each of those claims is true afterwards.
 *
 * The scan is tested on fixtures first. A scanner that only ever runs over a
 * code base that passes is a scanner whose failure mode is unknown: if it
 * stopped recognising `!:` tomorrow, every source file would keep passing
 * and the guarantee would quietly disappear.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `app-container.ts` imports `safeStorage` at module load. The container
 * keeps a database key in the OS key store, and the mock below stands in for
 * it: the key it produces is empty, which is a *valid* key (the storage
 * layer derives a key from whatever it is given), so the container starts,
 * migrates and builds its retention service exactly as it does in
 * production — over a real SQLite file in a temporary directory.
 */
vi.mock('electron', () => ({
  safeStorage: {
    encryptString: () => Buffer.alloc(0),
    decryptString: () => '',
  },
}));

import { RetentionService } from '@ucad/session';

import { UcadApp } from '../../apps/desktop/src/main/app-container';
import type { AppPaths } from '../../apps/desktop/src/main/paths';

const here = path.dirname(fileURLToPath(import.meta.url));
const CONTAINER_SOURCE = path.join(here, '../../apps/desktop/src/main/app-container.ts');

/**
 * The fields the container promises: `field!: T` declarations.
 *
 * A line-based scan, on purpose. The claims are one per line in the class
 * body, and a scan that needed a parser would be a scan whose own bugs
 * would be indistinguishable from the defects it looks for.
 */
function promisedFields(source: string): string[] {
  const out: string[] = [];
  for (const line of source.split('\n')) {
    // `private`/`readonly` are allowed in front of the name: the claim is the
    // `!`, not the visibility.
    const match = /^\s*(?:(?:public|private|protected|readonly)\s+)*([A-Za-z_$][\w$]*)\s*!:\s/.exec(
      line,
    );
    if (match?.[1] !== undefined) out.push(match[1]);
  }
  return out;
}

/**
 * The two ways the scan and the checklist can disagree.
 *
 * Kept as pure functions so both directions can be tested on fixtures. The
 * real-container test used to assert the two sorted arrays were equal, which
 * is correct but says only "something differs" — and its failure mode is
 * exactly the one this file exists to catch, so it should be pinned rather
 * than trusted.
 */
function promisesMissingFromChecklist(
  found: readonly string[],
  checklist: readonly string[],
): string[] {
  const allowed = new Set(checklist);
  return found.filter((field) => !allowed.has(field));
}

function checklistEntriesNotPromised(
  found: readonly string[],
  checklist: readonly string[],
): string[] {
  const promised = new Set(found);
  return checklist.filter((field) => !promised.has(field));
}

/**
 * The claims, written out.
 *
 * The scan above finds whatever the container currently declares; this list
 * is what it is *allowed* to declare. A new subsystem has to be added here
 * on purpose, and a renamed one has to be renamed in both places — which is
 * the point: the promise is a decision, not a side effect of editing a class
 * body.
 */
const PROMISED_FIELDS = [
  'logger',
  'blobs',
  'memoryLog',
  'secrets',
  'db',
  'eventLog',
  'sequencer',
  'projector',
  'sessionStore',
  'permissions',
  'usage',
  'mcp',
  'intelligence',
  'files',
  'git',
  'terminal',
  'pty',
  'estimator',
  'ledger',
  'renderer',
  'broker',
  'tools',
  'decisions',
  'runtime',
  'providerClient',
  'modelRegistry',
  'skills',
] as const;

let dir: string;
let app: UcadApp | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucad-container-'));
});

afterEach(async () => {
  // The container owns a database file and a handful of watchers; leaving
  // them open would hold the temp directory (and the test process) longer
  // than the test needs.
  await app?.dispose();
  app = undefined;
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A real container, started in a temporary directory. */
async function startApp(): Promise<UcadApp> {
  const paths: AppPaths = {
    userData: dir,
    dbPath: path.join(dir, 'ucad.db'),
    blobDir: path.join(dir, 'blobs'),
    logDir: path.join(dir, 'logs'),
    cacheDir: path.join(dir, 'cache'),
    downloadDir: path.join(dir, 'downloads'),
  };
  const container = new UcadApp({ paths });
  await container.start();
  return container;
}

describe('the scan that reads the container’s promises', () => {
  it('recognises a definite-assignment declaration', () => {
    // The fixture first: a scanner that stops matching is a scanner whose
    // guarantee disappears without a single test turning red.
    expect(promisedFields('class A {\n  db!: Database;\n}')).toEqual(['db']);
  });

  it('reads a private or readonly claim as well', () => {
    expect(promisedFields('class A {\n  private pty!: PtyHost;\n  readonly id!: string;\n}')).toEqual([
      'pty',
      'id',
    ]);
  });

  it('ignores a field that admits undefined', () => {
    // `ptyAvailability: PtyAvailability | undefined` is not a promise — it
    // says so itself, and it is not something `start()` has to provide.
    expect(promisedFields('class A {\n  pty: PtyHost | undefined;\n}')).toEqual([]);
  });

  it('ignores a field that brings its own value', () => {
    expect(promisedFields('class A {\n  agents = new Map<string, Host>();\n}')).toEqual([]);
  });

  it('is not vacuous on the real container', () => {
    const found = promisedFields(fs.readFileSync(CONTAINER_SOURCE, 'utf8'));
    expect(found.length, 'the scan found no promises in the container at all').toBeGreaterThan(10);
  });

  it('reports a new promise the checklist does not cover', () => {
    // A negative fixture, because the guarantee is "a new `field!: T` must be
    // a red test until somebody adds it to the checklist". If this helper
    // ever started returning `[]` for an unlisted field, the real-container
    // test below would keep passing while the guarantee disappeared.
    const found = promisedFields(
      'class A {\n  db!: Database;\n  brandNew!: Service;\n}',
    );
    expect(promisesMissingFromChecklist(found, ['db'])).toEqual(['brandNew']);
  });

  it('reports a checklist entry the class no longer declares', () => {
    // The other direction: a renamed or deleted field must not leave a stale
    // checklist entry behind, or the `has every one of them after start()`
    // test would keep asserting a field nobody promises any more.
    expect(checklistEntriesNotPromised(['db'], ['db', 'removed'])).toEqual(['removed']);
  });
});

describe('the container keeps every promise start() made', () => {
  it('declares exactly the fields the checklist names', () => {
    const found = promisedFields(fs.readFileSync(CONTAINER_SOURCE, 'utf8'));
    // Split into the two directions so the failure names what to fix: an
    // unlisted declaration means "add it to PROMISED_FIELDS (and make it real
    // in start())", a stale entry means "the field was renamed or removed".
    expect(
      promisesMissingFromChecklist(found, PROMISED_FIELDS),
      'the container declares a `field!: T` the checklist does not name',
    ).toEqual([]);
    expect(
      checklistEntriesNotPromised(found, PROMISED_FIELDS),
      'the checklist names a field the container no longer declares',
    ).toEqual([]);
  });

  it('has every one of them after start()', async () => {
    app = await startApp();

    for (const field of PROMISED_FIELDS) {
      const value = (app as unknown as Record<string, unknown>)[field];
      // Both are checked: `undefined` and `null` are the two ways a field
      // can be "not there", and only the first one is what a forgotten
      // assignment leaves behind.
      expect(value, `start() left ${field} undefined`).toBeDefined();
      expect(value, `start() left ${field} null`).not.toBeNull();
    }
  });

  it('and none of them before start()', async () => {
    // The other half of the claim. `start()` is what makes the fields true,
    // so before it they are genuinely absent — the `!` is a promise about
    // the future, not a description of the present. A container whose fields
    // were already set would mean something else had initialised them, and
    // the ordering `start()` relies on would be a story.
    const container = new UcadApp({
      paths: {
        userData: dir,
        dbPath: path.join(dir, 'ucad.db'),
        blobDir: path.join(dir, 'blobs'),
        logDir: path.join(dir, 'logs'),
        cacheDir: path.join(dir, 'cache'),
        downloadDir: path.join(dir, 'downloads'),
      },
    });

    for (const field of PROMISED_FIELDS) {
      const value = (container as unknown as Record<string, unknown>)[field];
      expect(value, `${field} was already set before start()`).toBeUndefined();
    }
  });

  it('builds the retention service over those same fields', async () => {
    // The guard added last round is only as good as the fields it checks, so
    // this is where the two halves meet: a container that really started
    // passes the guard, because the fields it asks for are there.
    app = await startApp();
    expect(app.retention).toBeInstanceOf(RetentionService);
    expect(app.getRetention()).toBe(app.retention);
  });
});
