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

import {
  RETENTION_DEPENDENCIES,
  UcadApp,
  type ContainerField,
} from '../../apps/desktop/src/main/app-container';
import type { AppPaths } from '../../apps/desktop/src/main/paths';

const here = path.dirname(fileURLToPath(import.meta.url));
const CONTAINER_SOURCE = path.join(here, '../../apps/desktop/src/main/app-container.ts');

/**
 * The scan that reads the container's promises.
 *
 * A line-based scan, on purpose. The claims are one per line in the class
 * body, and a scan that needed a parser would be a scan whose own bugs
 * would be indistinguishable from the defects it looks for.
 */
interface Claim {
  readonly name: string;
  /** whatever was written in front of the name: `private`, `readonly`, … */
  readonly modifiers: readonly string[];
}

/**
 * Every definite-assignment claim in a class body, with its modifiers.
 *
 * The trailing space the first version of this rule required is gone on
 * purpose. Prettier writes `db!: Database`, but `db!:Database` is the same
 * claim to the compiler and `!:` is what makes it one — the whitespace was
 * incidental. A field declared without the space was invisible to the scan,
 * which meant invisible to the checklist, which meant the one gate that says
 * "`start()` sets this" quietly did not cover it.
 *
 * The modifiers are kept rather than dropped so the claims the scan
 * *deliberately* skips can be named and asserted absent, instead of
 * disappearing (see `skippedClaims`).
 */
function claims(source: string): Claim[] {
  const out: Claim[] = [];
  for (const line of source.split('\n')) {
    const match = /^\s*((?:[A-Za-z_$][\w$]*\s+)*)([A-Za-z_$][\w$]*)\s*!:/.exec(line);
    const name = match?.[2];
    if (name === undefined) continue;
    out.push({
      name,
      modifiers: (match?.[1] ?? '').split(/\s+/).filter((modifier) => modifier !== ''),
    });
  }
  return out;
}

/**
 * The modifiers that leave the claim on the *instance*, where the run half
 * below can ask `start()` whether it kept its word. `private`/`readonly` are
 * allowed in front of the name: the claim is the `!`, not the visibility.
 */
const INSTANCE_MODIFIERS = new Set(['public', 'private', 'protected', 'readonly']);

/** The fields the container promises: `field!: T` declarations on the instance. */
function promisedFields(source: string): string[] {
  return claims(source)
    .filter((claim) => claim.modifiers.every((modifier) => INSTANCE_MODIFIERS.has(modifier)))
    .map((claim) => claim.name);
}

/**
 * The claims this scan leaves alone, as `modifier name` pairs.
 *
 * Two spellings are not container promises, and saying so here is the
 * difference between a decision and a blind spot:
 *
 *  - `static` — not reachable through an instance, so the run half (which
 *    reads `app[field]`) could never tell whether `start()` kept it. Counting
 *    it would only produce a checklist entry that can never pass;
 *  - `declare` — a type-only declaration with no runtime slot at all: there is
 *    nothing for `start()` to assign, so a "promise" would be about a property
 *    that never exists.
 *
 * Both are skipped, and the real container is then checked to declare neither.
 * That combination is what keeps this from being a hole: a field written this
 * way is a red test, not an unchecked field.
 */
function skippedClaims(source: string): string[] {
  return claims(source)
    .filter((claim) => claim.modifiers.some((modifier) => !INSTANCE_MODIFIERS.has(modifier)))
    .map((claim) => [...claim.modifiers, claim.name].join(' '));
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
 * Names on `RETENTION_DEPENDENCIES` that the checklist does not cover.
 *
 * The two lists are written down separately — one says "these fields the
 * retention service is built from", the other "these fields `start()` must
 * provide". Each is right on its own, and that is exactly the problem: a
 * retention dependency that is not on the checklist is a field the guard in
 * `requireStarted()` relies on and the scan-and-run gate does not cover, so
 * the container could hand retention an `undefined` that no test looks at.
 * A pure function (like the two above) so its failure mode can be pinned on
 * a fixture rather than assumed.
 */
function dependenciesOutsideTheChecklist(
  dependencies: readonly string[],
  checklist: readonly string[],
): string[] {
  const promised = new Set(checklist);
  return dependencies.filter((field) => !promised.has(field));
}

/**
 * Fields the guard was asked for more than once.
 *
 * The sorted comparison below is exact — a duplicate makes the two arrays
 * different lengths — but it reports that as "a different set of fields",
 * which points at the wrong fix: the bag has the right *names*, it just visits
 * one of them twice. Two visits is either a second dependency bag or a second
 * build of the service, and both are the duplicate-instance defect this
 * container already fixed once. A pure function, so a fixture can show it
 * answering something other than `[]`.
 */
function overCheckedFields(calls: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const field of calls) counts.set(field, (counts.get(field) ?? 0) + 1);
  return [...counts]
    .filter(([, count]) => count > 1)
    .map(([field]) => field)
    .sort();
}

/**
 * The claims, written out.
 *
 * The scan above finds whatever the container currently declares; this list
 * is what it is *allowed* to declare. A new subsystem has to be added here on
 * purpose, and a renamed one has to be renamed in both places — which is the
 * point: the promise is a decision, not a side effect of editing a class
 * body.
 *
 * `satisfies readonly ContainerField[]` puts the same rule on these names as
 * `RETENTION_DEPENDENCIES` has: an entry that is not a field of the container
 * — a rename carried through the class only, a typo — is reported at the line
 * instead of as a mismatch between two lists. Be precise about which gate that
 * is, though: `tests/` belongs to no tsc project (the contract suite carries
 * pre-existing type errors), so the `satisfies` is an editor / on-demand `tsc`
 * check. CI still catches the same mistake at runtime — a name the class does
 * not declare is reported by `checklistEntriesNotPromised`, and a name that is
 * not a field reads `undefined` after `start()` — later, and less directly
 * than the type would.
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
] as const satisfies readonly ContainerField[];

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

  it('counts a claim written without a space after the colon', () => {
    // `db!:Database` is the same claim as `db!: Database` to the compiler. The
    // first version of this rule required the space, so a field written this
    // way was found by nobody and therefore checked by nobody — the exact
    // failure mode a scan is supposed to make impossible.
    expect(promisedFields('class A {\n  db!:Database;\n}')).toEqual(['db']);
    expect(promisedFields('class A {\n  private pty!:PtyHost;\n}')).toEqual(['pty']);
  });

  it('ignores a static claim, which no instance can answer for', () => {
    // A static field is not reachable through `app`, so the run half below —
    // `app[field]` — could not tell whether it was ever assigned. Counting it
    // would add a checklist entry that can never pass; skipping it quietly
    // would be a hole. It is skipped *and* reported, and the real container
    // is asserted to declare none (see `skippedClaims`).
    expect(promisedFields('class A {\n  static db!: Database;\n}')).toEqual([]);
    expect(skippedClaims('class A {\n  static db!: Database;\n}')).toEqual(['static db']);
    expect(skippedClaims('class A {\n  static readonly db!:Database;\n}')).toEqual([
      'static readonly db',
    ]);
  });

  it('ignores a declare claim, which has no runtime slot at all', () => {
    // `declare db!: Database` is a type-only declaration: nothing is assigned
    // at runtime, so there is no promise for `start()` to keep. Same treatment
    // as `static` — skipped, reported, and absent from the real container.
    expect(promisedFields('class A {\n  declare db!: Database;\n}')).toEqual([]);
    expect(skippedClaims('class A {\n  declare db!: Database;\n}')).toEqual(['declare db']);
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

  it('reports a retention dependency the checklist does not cover', () => {
    // The cross-check below is a plain `filter`, so its "nothing to report"
    // answer is only worth something if a fixture shows it can answer
    // otherwise. `files` stands in for a field somebody added to the
    // retention bag without adding it to the promises.
    expect(dependenciesOutsideTheChecklist(['db', 'files'], ['db', 'logger'])).toEqual(['files']);
    expect(dependenciesOutsideTheChecklist(['db'], ['db', 'logger'])).toEqual([]);
  });

  it('reports a field the guard was asked for twice', () => {
    // `guards exactly the retention dependencies, once each` claims the bag
    // visits every field exactly once; this is the half of that claim the
    // sorted comparison cannot name.
    expect(overCheckedFields(['db', 'blobs', 'db'])).toEqual(['db']);
    expect(overCheckedFields(['db', 'blobs'])).toEqual([]);
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

  it('declares no claim the scan deliberately skips', () => {
    // The blind spot the fixture tests above make explicit. `static` and
    // `declare` claims are not on the checklist because the run half cannot
    // check them; if the container ever grew one, every gate here would stay
    // green while that field went unverified. Naming it as a failing test is
    // what turns "the scan skips these" into "the container may not use them".
    const skipped = skippedClaims(fs.readFileSync(CONTAINER_SOURCE, 'utf8'));
    expect(
      skipped,
      'the container declares a `static`/`declare` definite-assignment claim, which the scan-and-run gate cannot verify',
    ).toEqual([]);
  });

  it('covers every field the retention service is built from', () => {
    // `RETENTION_DEPENDENCIES` is the retention dependency bag's only source
    // of names, and `PROMISED_FIELDS` is what the scan-and-run gate checks.
    // Nothing used to connect the two: a dependency could sit in the bag, be
    // demanded of `start()` by `requireStarted()`, and still be missing from
    // the checklist — leaving the one field the service cannot work without
    // outside the gate that proves `start()` sets it.
    expect(
      RETENTION_DEPENDENCIES.length,
      'the retention dependency list is empty, so this assertion proves nothing',
    ).toBeGreaterThan(0);
    expect(
      dependenciesOutsideTheChecklist(RETENTION_DEPENDENCIES, PROMISED_FIELDS),
      'a field the retention service is built from is missing from PROMISED_FIELDS',
    ).toEqual([]);
  });

  it('guards exactly the retention dependencies, once each', async () => {
    // The bag is typed by `RETENTION_DEPENDENCIES`, so a *missing* field does
    // not compile — but a fifth field added by hand in `retentionDeps()`, or
    // one field asked for twice through a slightly different expression,
    // compiles fine. The calls are the contract, so record them: the guard is
    // the only thing between the retention service and an `undefined` `db`.
    const prototype = UcadApp.prototype as unknown as {
      requireStarted: (field: string, value: unknown) => unknown;
    };
    const guard = vi.spyOn(prototype, 'requireStarted');
    let guarded: string[];
    try {
      app = await startApp();
      // `start()` builds the service, so the calls above are the only ones
      // that can happen; a second build would be a second bag, which is the
      // duplicate-instance defect this container already fixed once.
      app.getRetention();
      // Read the calls before `mockRestore()`: restoring also clears them,
      // and an empty list would then compare unequal for the wrong reason.
      guarded = guard.mock.calls.map((call) => call[0]);
    } finally {
      guard.mockRestore();
    }

    // Two assertions, because the two ways this can be wrong have different
    // fixes: a field visited twice is a second bag / second build (named by
    // `overCheckedFields`), a different set is the bag having grown a field
    // `RETENTION_DEPENDENCIES` does not name.
    expect(
      overCheckedFields(guarded),
      'retentionDeps() asked the guard for the same field more than once',
    ).toEqual([]);
    expect(
      [...guarded].sort(),
      'retentionDeps() asked the guard for a different set of fields than RETENTION_DEPENDENCIES names',
    ).toEqual([...RETENTION_DEPENDENCIES].sort());
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

  it('releases the database when it is disposed', async () => {
    // The `afterEach` above is load-bearing: it closes the database and
    // removes the temporary directory. A `dispose()` that quietly stopped
    // closing SQLite would not fail any test — it would leak a file handle
    // per test and, on Windows, leave `fs.rmSync` fighting an open file, so
    // the failure would surface as a teardown error attributed to whichever
    // test ran last. Pinning the teardown keeps a broken one from looking
    // like a broken assertion somewhere else.
    const container = await startApp();
    const db = container.db;
    expect(db.schemaVersion).toBeGreaterThan(0);

    await container.dispose();
    // Deliberately not assigned to `app`: `afterEach` would dispose it a
    // second time, and a double close throws ("Database already closed"),
    // which is the same class of misattributed failure this test exists for.
    expect(() => db.schemaVersion, 'dispose() left the SQLite database open').toThrow();
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
