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
 * Three gates, because either of the first two alone has a hole:
 *
 *  - the *scan* reads the source and finds the claims — every `field!: T`
 *    declaration — so a field that is added to the container is a field this
 *    file knows about. A list written by hand would go stale silently, and a
 *    field nobody lists is a field nobody checks;
 *  - the *run* starts a real container in a temporary directory and asks
 *    whether each of those claims is true afterwards;
 *  - the *guard's scope* is read from the sources rather than from the comment
 *    that describes it: `requireStarted()` is asked for `retentionDeps()`'s
 *    fields and nothing else, in the container and under all of `src/main`.
 *    `STARTED`'s note says widening the guard means widening `retentionDeps()`;
 *    a comment cannot be wrong, so the note has a failing test behind it.
 *
 * The scan is tested on fixtures first. A scanner that only ever runs over a
 * code base that passes is a scanner whose failure mode is unknown: if it
 * stopped recognising `!:` tomorrow, every source file would keep passing
 * and the guarantee would quietly disappear. The same is true of the scope
 * check: a call in a helper method and a call in another file are both red,
 * and the fixtures below pin which message each one produces, so a failure
 * names the fix rather than merely reporting that two lists differ.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { blankComments } from './source-scan';

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
  STARTED_FIELDS,
  UcadApp,
  assertStartComplete,
  missingStartedFields,
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

/** The one line shape a definite-assignment claim is written as. */
const CLAIM_LINE = /^\s*((?:[A-Za-z_$][\w$]*\s+)*)([A-Za-z_$][\w$]*)\s*!:/;

/**
 * A definite assignment, however it is spaced: the character pair that says
 * "assigned elsewhere", allowing the space the compiler also allows.
 *
 * `CLAIM_LINE` is the shape the scan can read; this is the shape it must not
 * walk past. `db! : Database` is the same claim to tsc and is not the same line
 * to the scan — which is the whole reason the two patterns are separate.
 */
const DEFINITE_ASSIGNMENT = /!\s*:/;

/** The words that may stand in front of the claimed name. */
const MODIFIER_WORDS = new Set([
  'public',
  'private',
  'protected',
  'readonly',
  'static',
  'declare',
  'abstract',
  'override',
  'accessor',
]);

/**
 * The modifiers written on the line before a claim, if that is all it holds.
 *
 * Prettier wraps a member declaration when it gets long, and the wrap can land
 * between the modifiers and the name:
 *
 * ```ts
 *   private readonly
 *     db!: Database;
 * ```
 *
 * Read line by line, that claim has no modifiers — which used to be harmless
 * and is not any more: `skippedClaims()` decides what the scan may leave alone
 * from the modifiers, so a wrapped `static` would silently move from "skipped
 * and asserted absent" to "on the checklist", i.e. from a named refusal to a
 * checklist entry `app[field]` cannot ever satisfy. A previous line counts only
 * when every word on it is a modifier word: `}` from the method above is not
 * one, and neither is a decorator.
 */
function modifiersFromPreviousLine(lines: readonly string[], index: number): string[] {
  for (let previous = index - 1; previous >= 0; previous -= 1) {
    const text = lines[previous]!.trim();
    if (text === '') continue;
    const words = text.split(/\s+/);
    return words.every((word) => MODIFIER_WORDS.has(word)) ? words : [];
  }
  return [];
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
 * disappearing (see `skippedClaims`), and a declaration Prettier wrapped
 * between its modifiers and its name is read the same as an unwrapped one.
 *
 * What this cannot do is notice a claim it did not understand — `db! : T`, a
 * `#`-private field, a shape added later. That is what `unreadableClaims()`
 * below is for: a `!:` the line rule does not parse is a red test, not an
 * unchecked field.
 */
function claims(source: string): Claim[] {
  const lines = source.split('\n');
  const out: Claim[] = [];
  lines.forEach((line, index) => {
    const match = CLAIM_LINE.exec(line);
    const name = match?.[2];
    if (name === undefined) return;
    const written = (match?.[1] ?? '').split(/\s+/).filter((modifier) => modifier !== '');
    out.push({
      name,
      modifiers: written.length > 0 ? written : modifiersFromPreviousLine(lines, index),
    });
  });
  return out;
}

/**
 * `!:` lines the claim rule does not understand, as `line: text`.
 *
 * The fail-closed half of `claims()`. The scan is line-based on purpose (it is
 * the check on the checklist, and a parser would have bugs indistinguishable
 * from the defects it looks for), so it has a known shape it can read and
 * everything else is *not read*. Silence there is the dangerous answer: a field
 * written `db! : Database` — a spacing Prettier does not produce but a person
 * can, and the compiler accepts — would simply not be a claim, so it would
 * neither be on the checklist nor be reported as skipped, and the gate would
 * keep passing about a field nobody checks.
 *
 * So the count of `!:` lines is compared with the count of *understood* ones,
 * and a line in between is named. Comments are blanked first, because the
 * container's doc comments quote `field!: T` by name (which is prose, not a
 * claim) — and blanking keeps the line numbers, so the report points at the
 * line a reader would open.
 *
 * The cost is that a tricky-but-readable spelling could be refused. That is the
 * right direction: a red test with a line number is a fix, and an unread claim
 * is a promise nobody checks.
 */
function unreadableClaims(source: string): string[] {
  const original = source.split('\n');
  const out: string[] = [];
  blankComments(source)
    .split('\n')
    .forEach((line, index) => {
      if (!DEFINITE_ASSIGNMENT.test(line)) return;
      if (CLAIM_LINE.test(line)) return;
      out.push(`${index + 1}: ${original[index]?.trim() ?? ''}`);
    });
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
 * The body of `start()`, as a text slice.
 *
 * Same call as `methodBody()` above and for the same reason: what is being
 * asserted is *where* one line sits relative to the steps it checks, and that
 * is a fact about the source. `start()` is `async start(): Promise<void> {`,
 * so it needs its own signature rather than `methodBody()`'s `private` one.
 *
 * `''` is the answer when either anchor is missing — see `requiredSlice()`.
 */
function startBody(source: string): string {
  const start = source.indexOf('\n  async start(): Promise<void> {');
  if (start === -1) return '';
  const end = source.indexOf('\n  }\n', start);
  return end === -1 ? '' : source.slice(start, end);
}

/**
 * The body of a `#`-private method at class-member indent, or `''`.
 *
 * `methodBody()` above finds `private name(`, which is what the retention bag
 * is written as. `#assertStartComplete` is a `#`-private method instead, and
 * the source gate needs to read it for the same reason: what is asserted is
 * that the method delegates to the exported decision rather than carrying a
 * second copy of it.
 *
 * `''` when either anchor is missing — see `requiredSlice()`.
 */
function privateHashBody(source: string, name: string): string {
  const start = source.indexOf(`\n  #${name}(`);
  if (start === -1) return '';
  const end = source.indexOf('\n  }\n', start);
  return end === -1 ? '' : source.slice(start, end);
}

/**
 * A slice, or a failure that says which anchor is missing instead of `''`.
 *
 * This is the difference between a gate and a gate-shaped hole. `startBody()`
 * and `privateHashBody()` answer `''` when the source is not the shape they
 * slice, and `''` is a value every assertion can be written against and fail
 * *somewhere else*: `toContain('this.#assertStartComplete();')` on `''` fails
 * with "expected '' to contain …", which reads as "`start()` lost the call" —
 * the very defect the gate reports — while the truth is that the anchor moved
 * and nothing was read at all. Worse, a check made of *negative* assertions
 * (`not.toContain('this.#initRuntime()')`) would pass on `''` and the gate would
 * go green on a source it never saw.
 *
 * So the slice is handed to this before it is asserted on, and an empty slice
 * is a failure in the shape of the fix: the anchors are printed, and the reader
 * is told that the assertion below is not what broke. The exact-anchor slices
 * stay pure functions of the source, so the truncation itself can be pinned by
 * a fixture (`a source that is not the shape it slices is a failed read`).
 */
function requiredSlice(body: string, what: string, anchors: string): string {
  if (body === '') {
    throw new Error(
      `the source gate could not slice ${what} out of app-container.ts: expected to find ` +
        `${anchors}, and one of them is gone. Nothing below this point was checked — fix the ` +
        `scan (or the declaration form it anchors on) rather than the assertion that follows.`,
    );
  }
  return body;
}

/** `start()`'s body, or a failure naming the anchors it could not find. */
function startBodyOrFail(source: string): string {
  return requiredSlice(
    startBody(source),
    'start()',
    '`\n  async start(): Promise<void> {` and its closing `\n  }\n`',
  );
}

/** A `#`-private method's body, or a failure naming the anchors it could not find. */
function privateHashBodyOrFail(source: string, name: string): string {
  return requiredSlice(
    privateHashBody(source, name),
    `#${name}()`,
    `\`\n  #${name}(\` and its closing \`\n  }\n\``,
  );
}

/** The main-process sources the guard's scope is read from. */
const MAIN_SOURCE = path.join(here, '../../apps/desktop/src/main');
/** Repo root, so the paths in a failure message are the ones a reader types. */
const REPO_ROOT = path.join(here, '../..');
/** The container's path in the shape `mainSources()` returns. */
const CONTAINER_REL = path.relative(REPO_ROOT, CONTAINER_SOURCE).split(path.sep).join('/');

/**
 * The fields a file asks the guard for, in source order.
 *
 * A *call* is what counts — `x.requireStarted('field', …)`. The declaration is
 * `private requireStarted<K …>(` and has no receiver, so it is not matched, and
 * prose is gone by the time this runs (`blankComments`). Every receiver counts,
 * not only `this`: the claim being checked is "nothing outside `retentionDeps()`
 * asks the guard", and a call through a parameter or a destructured value
 * (`app.requireStarted(…)`, `app?.requireStarted(…)`) is exactly the shape a
 * `this`-only rule would miss. Both quotes and a wrapped call are read, because
 * Prettier wraps a long call and the field name then lands on the next line.
 *
 * The blanking is `source-scan.ts`'s walk, shared with the update-channel
 * scan rather than copied. This file's copy used to say that a regex literal
 * containing two adjacent slashes would be read as the start of a comment, and
 * that the loss would be loud because the count below would disagree. That was
 * true *here* — and the same walk in `update-integrity.test.ts` loses a
 * `new UpdateService({ beforeLaunch })` silently, which is why the walk is now
 * one implementation with regex literals recognised, and why the fixture below
 * drives the shape the old copy lost.
 *
 * One spelling is still outside the rule, and it is pinned below: a space
 * between the receiver and the dot (`this . requireStarted`, valid TypeScript,
 * not a match). That is a blind spot, not a claim that the shape does not
 * occur — and unlike the regex one it costs nothing to read, which is why it
 * is left as a documented refusal rather than a parser.
 */
function guardCalls(source: string): string[] {
  return [...blankComments(source).matchAll(/\.requireStarted\(\s*(['"])([^'"]+)\1/g)].map(
    (match) => match[2]!,
  );
}

/**
 * The body of a method declared at class-member indent, or `''`.
 *
 * Deliberately a text slice, not a parser (the same call the file makes
 * everywhere else): the end of a method is the next `\n  }\n`, which is what
 * this codebase writes for every method. A method written with a different
 * indent reads as missing, and the test using it says so by name.
 */
function methodBody(source: string, name: string): string {
  const start = source.indexOf(`\n  private ${name}(`);
  if (start === -1) return '';
  const end = source.indexOf('\n  }\n', start);
  return end === -1 ? '' : source.slice(start, end);
}

/** One source the guard's scope is read from: a repo-relative path and its text. */
interface GuardSource {
  readonly path: string;
  readonly source: string;
}

/**
 * The first thing wrong with the guard's scope, in the words the failure
 * should use, or `null` when it is exactly the retention bag and nothing else.
 *
 * A pure function so each way the sources can drift has a fixture that pins
 * the *message* it produces. The order is deliberate:
 *
 *  - a call in another file is named before any arithmetic, because "which
 *    file" is the fix;
 *  - a second call in the container is reported as a count mismatch, not as
 *    "a different set of fields": the bag still names the right fields, it
 *    just visits one of them more than once, and the two need different fixes
 *    (a second dependency bag versus a field added to the bag);
 *  - a bag that delegates to a helper passes the count but not the set, which
 *    is why the set check is not redundant with the count check.
 */
function scopeViolation(
  files: readonly GuardSource[],
  containerPath: string,
  dependencies: readonly string[],
): string | null {
  const container = files.find((file) => file.path === containerPath);
  if (container === undefined) return 'the container source is missing from the scan';
  const body = methodBody(container.source, 'retentionDeps');
  if (body === '') {
    return 'retentionDeps() is gone or is no longer a `private` method at class-member indent, so the scope cannot be read';
  }

  const callers = files
    .map((file) => ({ path: file.path, fields: guardCalls(file.source) }))
    .filter((caller) => caller.fields.length > 0);
  if (callers.some((caller) => caller.path !== containerPath)) {
    return 'requireStarted() has a caller outside the container';
  }

  const total = callers.reduce((sum, caller) => sum + caller.fields.length, 0);
  if (total !== dependencies.length) {
    return 'the number of guarded fields is not the number of retention dependencies';
  }

  const expected = [...dependencies].sort();
  const bag = [...guardCalls(body)].sort();
  if (bag.length !== expected.length || bag.some((field, index) => field !== expected[index])) {
    return 'retentionDeps() asks the guard for a different set of fields than RETENTION_DEPENDENCIES names';
  }
  return null;
}

/** Every `.ts` file under `apps/desktop/src/main`, as repo-relative path + source. */
function mainSources(dir: string = MAIN_SOURCE): { path: string; source: string }[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return mainSources(full);
      if (!entry.name.endsWith('.ts')) return [];
      return [
        {
          path: path.relative(REPO_ROOT, full).split(path.sep).join('/'),
          source: fs.readFileSync(full, 'utf8'),
        },
      ];
    });
}

/**
 * The claims, as the container writes them.
 *
 * The scan above finds whatever the container currently declares; this list is
 * what it is *allowed* to declare, and it now lives in `app-container.ts` —
 * next to `start()`, which is the only thing that can make it true. That move
 * is the whole point of this paragraph: the list used to be written here, and
 * `tests/` belongs to no tsc project (the contract suite carries pre-existing
 * type errors), so its `satisfies readonly ContainerField[]` was an editor
 * check while CI ran only the runtime assertions. In the product file it is
 * part of `apps/desktop/tsconfig.main.json`, so a name that is not a field —
 * a rename carried through the class only, a typo — fails
 * `npm run typecheck`. Same rule, a gate that is actually run.
 *
 * Nothing about the contract changed by moving it. The list is still
 * hand-written and still has to be extended on purpose when a subsystem is
 * added, and the scan below still fails when a `field!: T` is not on it. What
 * changed is that `start()` now checks the same list before it returns
 * (`#assertStartComplete()`), so a forgotten assignment is refused by the
 * container instead of being discovered by a test — or by a user.
 *
 * Read as the local name below (`PROMISED_FIELDS`) everywhere in this file,
 * because that is what the assertion messages say: these are the fields
 * `start()` promises.
 */
const PROMISED_FIELDS = STARTED_FIELDS;

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

  it('reads a declaration Prettier wrapped between the modifiers and the name', () => {
    // The reformat this scan has to survive: a member long enough that the
    // printer puts the modifiers on one line and the name on the next. Read
    // line by line, that claim has no modifiers — and the modifiers are what
    // `skippedClaims()` decides with, so a wrapped `static` would move from
    // "skipped and asserted absent" to "on the checklist", where the run half
    // (`app[field]`) can never satisfy it.
    const wrappedStatic = ['class A {', '  static', '    db!: Database;', '}'].join('\n');
    expect(promisedFields(wrappedStatic)).toEqual([]);
    expect(skippedClaims(wrappedStatic)).toEqual(['static db']);

    // The instance case, which must stay a promise: the name is what makes it
    // one, and the wrapping does not change that.
    const wrappedInstance = ['class A {', '  private readonly', '    db!: Database;', '}'].join('\n');
    expect(promisedFields(wrappedInstance)).toEqual(['db']);
    expect(skippedClaims(wrappedInstance)).toEqual([]);

    // And the type may be on the next line instead; the claim is the `!:`.
    expect(promisedFields(['class A {', '  db!:', '    Database;', '}'].join('\n'))).toEqual(['db']);
  });

  it('reports a `!:` line it cannot read, instead of not seeing it', () => {
    // The fail-closed half. A line rule has a shape it understands, and every
    // other spelling of the same claim is *not read* — which used to be silent
    // in both directions: the field was not on the checklist and not reported
    // as skipped, so the gate kept passing about a field nobody checked.
    // `unreadableClaims()` makes that difference visible, and the assertion
    // below is the fixture that keeps it from answering `[]` unconditionally.
    const spacedColon = ['class A {', '  db! : Database;', '}'].join('\n');
    expect(promisedFields(spacedColon), 'the scan reads a shape it does not understand').toEqual([]);
    expect(unreadableClaims(spacedColon)).toEqual(['2: db! : Database;']);

    // A `#`-private claim is another shape it cannot read. Skipping it silently
    // would be a hole: `app[field]` cannot reach it, so the run half could
    // never check it, and nobody would be told.
    const privateField = ['class A {', '  #db!: Database;', '}'].join('\n');
    expect(unreadableClaims(privateField)).toEqual(['2: #db!: Database;']);

    // The readable shapes answer `[]`, and so does prose — the container's doc
    // comments quote `field!: T` by name, and a scan that called its own
    // documentation unreadable would be red about itself rather than the code.
    expect(unreadableClaims('class A {\n  db!: Database;\n  static x!: T;\n}')).toEqual([]);
    expect(unreadableClaims('/** A `field!: T` claim, quoted in prose. */\nclass A {}')).toEqual(
      [],
    );
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

    // And against the checklist the container actually ships, so the fixture
    // is the failure a reader would see rather than a two-element list the
    // test made up: one field the scan finds and the real checklist does not
    // name is one red test, by name.
    expect(
      promisesMissingFromChecklist(promisedFields('class A {\n  foo!: Thing;\n}'), PROMISED_FIELDS),
      'a `field!: T` that is not on the shipped checklist has to be reported by name',
    ).toEqual(['foo']);
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

describe('the guard’s scope, as the sources write it', () => {
  it('drops comments but keeps a slash inside a string', () => {
    // The doc comments in `app-container.ts` quote the guard by name, so a
    // scan over raw text counts prose as call sites. And `//` in a string is
    // not a comment — a log line with a URL is the shape that would otherwise
    // eat the rest of its line, including a call.
    const source = [
      '// this.requireStarted(\'db\', this.db) in a comment',
      '/* and a block one */',
      "logger.info('see https://example.com/docs'); this.requireStarted('db', this.db);",
    ].join('\n');
    expect(guardCalls(source)).toEqual(['db']);
    // And the blanking keeps positions, which is what every line number in a
    // failure message depends on: a walk that deleted a comment would shift
    // the whole file by a few characters and still look right.
    const blanked = blankComments('a // b');
    expect(blanked).toBe('a     ');
    expect(blanked.split('\n').length).toBe('a // b'.split('\n').length);
  });

  it('reads a call that follows a regex literal containing two slashes', () => {
    // The shape this scan used to lose. `/[//]/` is a valid regex — a `/`
    // needs no escape inside a character class — and a walk that reads `//` as
    // the start of a comment blanks the rest of the line, call included. The
    // old note here said that loss would be *loud* (the count would disagree)
    // and the same walk in `update-integrity.test.ts` loses a constructor
    // silently; both are now the shared, regex-aware walk in `source-scan.ts`.
    //
    // Pinned as a fixture rather than described, because "the scan reads this"
    // is the only thing that makes the count below mean anything.
    expect(guardCalls("const re = /[//]/; this.requireStarted('db', this.db);")).toEqual(['db']);
    expect(guardCalls("const re = /a[/]b/g; this.requireStarted('db', this.db);")).toEqual(['db']);
    // The escaped spelling is the one the old walk *did* read, kept here so a
    // future rewrite cannot trade one blind spot for the other.
    expect(guardCalls("const re = /\\/\\//; this.requireStarted('db', this.db);")).toEqual(['db']);
    // Division is not a regex literal, and the call after it is still a call.
    expect(guardCalls("const half = total / 2; this.requireStarted('db', this.db);")).toEqual([
      'db',
    ]);
  });

  it('reads a wrapped call and a double-quoted field name', () => {
    // Prettier wraps a long call rather than the argument, so the field name
    // can sit on the next line; a rule anchored to one line misses it and the
    // count below then reports a call that is plainly in the source as gone.
    expect(guardCalls("this.requireStarted(\n        'db',\n        this.db,\n      );")).toEqual([
      'db',
    ]);
    expect(guardCalls('this.requireStarted("logger", this.logger);')).toEqual(['logger']);
    // A call through another receiver is still a call — that is the shape
    // "nothing outside retentionDeps()" has to catch. The declaration, which
    // has no receiver, is the only `.requireStarted(` that is not one.
    expect(guardCalls("other.requireStarted('db', other.db);")).toEqual(['db']);
    expect(guardCalls('private requireStarted<K extends keyof UcadApp>(')).toEqual([]);
    // Optional chaining still ends in `.requireStarted(`: the receiver is a
    // parameter here, and a rule keyed to `this.` would miss it. Pinned so
    // that narrowing the receiver later is a red test rather than a quiet
    // loss of coverage.
    expect(guardCalls("app?.requireStarted('db', app.db);")).toEqual(['db']);
  });

  it('does not read a receiver split from the method name', () => {
    // `this . requireStarted(…)` is valid TypeScript and not a match: the
    // regex has no whitespace between the dot and the name. The blind spot is
    // pinned rather than left to be discovered when somebody formats a call
    // this way; the fixture above shows the spellings that *are* read.
    expect(guardCalls("this . requireStarted('db', this.db);")).toEqual([]);
  });

  it('slices a method body, and reports one it cannot find', () => {
    const source = [
      'class A {',
      '  private retentionDeps(): X {',
      "    return { db: this.requireStarted('db', this.db) };",
      '  }',
      '',
      '  other() {}',
      '}',
    ].join('\n');
    expect(methodBody(source, 'retentionDeps')).toContain("this.requireStarted('db'");
    expect(methodBody(source, 'retentionDeps')).not.toContain('other()');
    // A method written at another indent is not found; the test that uses this
    // says so instead of comparing two empty lists.
    expect(methodBody('class A {\n    private retentionDeps(): X {\n    }\n}', 'retentionDeps')).toBe(
      '',
    );
  });

  it('a source that is not the shape it slices is a failed read, not an empty body', () => {
    // `startBody()`/`privateHashBody()` answer `''` when the anchors are gone,
    // and `''` is the value every assertion below can fail *about something
    // else*: a `toContain('this.#assertStartComplete();')` on `''` reports
    // exactly the defect the gate exists to name ("`start()` lost the call"),
    // while a negative assertion would pass and leave the gate green on a
    // source it never read. So the truncation is pinned here, and the caller
    // above goes through `…OrFail()`, which turns `''` into a message naming
    // the anchors.
    const noStart = ['class A {', '  other() {}', '}'].join('\n');
    expect(startBody(noStart)).toBe('');
    expect(privateHashBody(noStart, 'assertStartComplete')).toBe('');
    expect(() => startBodyOrFail(noStart), 'an unreadable start() body passed silently').toThrow(
      /async start\(\): Promise<void> \{/,
    );
    expect(() => privateHashBodyOrFail(noStart, 'assertStartComplete')).toThrow(
      /#assertStartComplete\(/,
    );

    // The other truncation: the opening anchor is there and the closing one is
    // not, which is what a re-indented or re-wrapped `start()` looks like. The
    // slice is still `''` — not "everything from the anchor to the end of the
    // file", which is how a text slice turns into a scan of unrelated code.
    const unterminated = [
      'class A {',
      '  async start(): Promise<void> {',
      '    await this.#initLogging();',
      '  }',
      '}',
    ]
      .join('\n')
      .replace('\n  }\n', '\n    }\n');
    expect(startBody(unterminated)).toBe('');
    expect(() => startBodyOrFail(unterminated)).toThrow(/closing/);

    // And the message is about the *scan*, not about the assertion that
    // follows it: the reader of a red gate should not be sent to the line that
    // is merely downstream of the missing anchor.
    let message = '';
    try {
      startBodyOrFail(noStart);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('app-container.ts');
    expect(message).toContain('Nothing below this point was checked');

    // The positive control: the real body slices, so the fixtures above are
    // about a scanner that can answer and not about one that always refuses.
    expect(startBodyOrFail(fs.readFileSync(CONTAINER_SOURCE, 'utf8'))).toContain(
      'this.#assertStartComplete();',
    );
  });

  it('guards nothing outside retentionDeps()', () => {
    // `STARTED`'s scope note says the guard is not a blanket wrapper and that
    // "adding a field to the guard's scope means widening `retentionDeps()`".
    // That is a claim about the source, and nothing checked it: a call added
    // anywhere else in the class — or in another main-process file — kept the
    // comment true-looking while the scope had quietly grown.
    const container = fs.readFileSync(CONTAINER_SOURCE, 'utf8');
    expect(
      scopeViolation([{ path: CONTAINER_REL, source: container }], CONTAINER_REL, RETENTION_DEPENDENCIES),
      'the container calls requireStarted() outside retentionDeps(), or for a different set of fields than RETENTION_DEPENDENCIES names',
    ).toBeNull();
  });

  it('is called from no other file under src/main', () => {
    // The other half of the scope note: the guard is the retention bag's, not
    // the container's general start-up check. A second caller in another file
    // would be a second dependency path nobody's scan covers.
    const files = mainSources();
    // Non-vacuous: a walk that found no container would report no callers,
    // and "no callers outside the container" would be true for the wrong
    // reason.
    const container = files.find((file) => file.path === CONTAINER_REL);
    expect(container, 'the container is not in the main-process scan').toBeDefined();
    expect(
      guardCalls(container!.source).length,
      'the main-process scan found no guarded field in the container at all',
    ).toBeGreaterThan(0);
    expect(
      scopeViolation(files, CONTAINER_REL, RETENTION_DEPENDENCIES),
      'a file outside the container asks the guard, or the call count differs from the retention dependencies',
    ).toBeNull();
  });
});

/**
 * The scope check's failure modes, on fixtures.
 *
 * Each shape that has broken this gate — or could break it silently — gets a
 * source string and the message a real failure should print. A check whose
 * failure messages have never been read outside production is a check whose
 * next red test may name the wrong fix.
 */
describe('the guard’s scope check, on fixtures', () => {
  const CONTAINER_PATH = 'apps/desktop/src/main/app-container.ts';

  /** The shape the scan is meant to find: one call inside the bag. */
  const inTheBag = [
    'class A {',
    '  private retentionDeps(): Deps {',
    "    return { db: this.requireStarted('db', this.db) };",
    '  }',
    '}',
  ].join('\n');

  it('accepts a bag that holds exactly the dependencies', () => {
    // The positive fixture: without it every negative below could be passing
    // for an unrelated reason.
    expect(
      scopeViolation([{ path: CONTAINER_PATH, source: inTheBag }], CONTAINER_PATH, ['db']),
    ).toBeNull();
  });

  it('reports a call in another file by name', () => {
    // The failure that commit 5f5be1c claims to have measured: a second entry
    // point in `src/main`. The other file has to be the one named — a count
    // mismatch would send the reader looking in the container, where nothing
    // changed.
    const other = 'apps/desktop/src/main/helper.ts';
    expect(
      scopeViolation(
        [
          { path: CONTAINER_PATH, source: inTheBag },
          {
            path: other,
            source: "export const remember = (app: UcadApp) => app.requireStarted('db', app.db);",
          },
        ],
        CONTAINER_PATH,
        ['db'],
      ),
      'a second file calling the guard must be named as the caller',
    ).toBe('requireStarted() has a caller outside the container');
  });

  it('reports a helper method that asks the guard again as a count mismatch', () => {
    // The bag still names exactly the dependency list, so the *set* check
    // passes — but the container now visits `db` twice. That is a second
    // dependency bag (or a second build of the service), a different defect
    // from a field added to the bag, and the message has to say "count".
    const split = [
      'class A {',
      '  private retentionDeps(): Deps {',
      "    return { db: this.requireStarted('db', this.db) };",
      '  }',
      '',
      '  private buildDeps(): Deps {',
      "    return { db: this.requireStarted('db', this.db) };",
      '  }',
      '}',
    ].join('\n');

    expect([...guardCalls(methodBody(split, 'retentionDeps'))].sort()).toEqual(['db']);
    expect(
      scopeViolation([{ path: CONTAINER_PATH, source: split }], CONTAINER_PATH, ['db']),
      'a second call site in the same file must be reported as a count mismatch',
    ).toBe('the number of guarded fields is not the number of retention dependencies');
  });

  it('reports a bag that delegates to a helper as a different set of fields', () => {
    // The other shape of "moved into a helper": `retentionDeps()` keeps its
    // name but no longer contains the calls, so the count is still one and
    // only the set check can see that the bag is empty. This is why the two
    // checks are both needed rather than one being an implication of the
    // other.
    const delegated = [
      'class A {',
      '  private retentionDeps(): Deps {',
      '    return this.buildDeps();',
      '  }',
      '',
      '  private buildDeps(): Deps {',
      "    return { db: this.requireStarted('db', this.db) };",
      '  }',
      '}',
    ].join('\n');

    expect(
      scopeViolation([{ path: CONTAINER_PATH, source: delegated }], CONTAINER_PATH, ['db']),
      'a bag that delegates must be reported as a field-set mismatch',
    ).toBe(
      'retentionDeps() asks the guard for a different set of fields than RETENTION_DEPENDENCIES names',
    );
  });

  it('reports the count mismatch a call the scan cannot see would cause', () => {
    // The count check is the half of the scope gate that catches a hidden
    // call, and a check whose failure has never been produced is a check
    // nobody knows the shape of. The call below sits in a comment, so the
    // blanking removes it: the bag is then empty while the dependency list
    // still names one field, and the failure has to be the count — not the
    // silence the old regex-literal blind spot produced.
    const commented = [
      'class A {',
      '  private retentionDeps(): Deps {',
      "    // return { db: this.requireStarted('db', this.db) };",
      '    return {};',
      '  }',
      '}',
    ].join('\n');

    expect(guardCalls(commented), 'a commented-out call was counted as a call').toEqual([]);
    expect(
      scopeViolation([{ path: CONTAINER_PATH, source: commented }], CONTAINER_PATH, ['db']),
      'a hidden call left the count check green',
    ).toBe('the number of guarded fields is not the number of retention dependencies');

    // And the same source with the call live: the count is right, and the
    // fixture above is therefore about the hidden call rather than about the
    // fixture being malformed.
    const live = commented.replace("    // return { db: this.requireStarted('db', this.db) };", "    return { db: this.requireStarted('db', this.db) };");
    expect(
      scopeViolation([{ path: CONTAINER_PATH, source: live }], CONTAINER_PATH, ['db']),
    ).toBeNull();
  });

  it('walks every file under the scanned root, not just the container', () => {
    // `mainSources()` is what makes the "no other file" claim cover the
    // directory rather than one path. A walk that skipped a subdirectory
    // would leave the second caller invisible, so the walk itself is fed a
    // tree with a call one level down.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ucad-main-scan-'));
    try {
      fs.mkdirSync(path.join(root, 'nested'));
      fs.writeFileSync(path.join(root, 'container.ts'), "a.requireStarted('db', a.db);");
      fs.writeFileSync(path.join(root, 'nested', 'helper.ts'), "b.requireStarted('blobs', b.blobs);");
      fs.writeFileSync(path.join(root, 'notes.md'), "not-scanned.requireStarted('ignored', x);");

      const found = mainSources(root);
      const walked = found.map((file) =>
        path.relative(root, path.resolve(REPO_ROOT, file.path)).split(path.sep).join('/'),
      );
      expect(walked, 'the walk skipped a nested source or read a non-source file').toEqual([
        'container.ts',
        'nested/helper.ts',
      ]);
      expect(found.flatMap((file) => guardCalls(file.source))).toEqual(['db', 'blobs']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
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

  it('declares no claim the scan cannot read', () => {
    // The fail-closed half of the declaration scan, asserted on the source this
    // whole file is about. `skippedClaims` covers the shapes the scan reads and
    // deliberately leaves alone; this covers the ones it does not read at all,
    // which used to be the silent case: not on the checklist, not reported as
    // skipped, and the gate green about a field nobody checks.
    expect(
      unreadableClaims(fs.readFileSync(CONTAINER_SOURCE, 'utf8')),
      'a `!:` in the container is written in a shape the claim scan cannot read, so it is neither checked nor reported',
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

  it('names every promised field before start(), and none after', async () => {
    // `missingStartedFields()` is the function `start()` refuses to finish
    // with, so it is asserted from both ends. A check that can only ever answer
    // "nothing is missing" proves nothing — a fresh container has none of the
    // fields, and the answer has to say so, field by field.
    const fresh = new UcadApp({
      paths: {
        userData: dir,
        dbPath: path.join(dir, 'ucad.db'),
        blobDir: path.join(dir, 'blobs'),
        logDir: path.join(dir, 'logs'),
        cacheDir: path.join(dir, 'cache'),
        downloadDir: path.join(dir, 'downloads'),
      },
    });
    expect(missingStartedFields(fresh), 'a fresh container reported nothing missing').toEqual([
      ...PROMISED_FIELDS,
    ]);

    app = await startApp();
    expect(missingStartedFields(app), 'start() finished with a field still missing').toEqual([]);
  });

  it('refuses a container that lost a field, naming it', async () => {
    // The refusal, not the detector. `missingStartedFields()` says *which*
    // fields are missing; `#assertStartComplete()` is what turns that answer
    // into the error a half-started app dies on — and while it was a
    // `#`-private method, nothing could drive it: the only gate was a source
    // scan that said the call exists, which is not the same claim as "a
    // missing field is refused with its name".
    //
    // A real started container with one assignment undone is the shape a
    // `start()` that forgot a step leaves behind: every other subsystem is
    // there, so the failure has to be reported as *this field*, not as the
    // first subsystem that trips over it.
    app = await startApp();
    const field = 'files';
    const original = (app as unknown as Record<string, unknown>)[field];
    expect(original, 'the container no longer starts with ' + field).toBeDefined();
    delete (app as unknown as Record<string, unknown>)[field];

    let thrown: unknown;
    try {
      assertStartComplete(app);
    } catch (error) {
      thrown = error;
    } finally {
      (app as unknown as Record<string, unknown>)[field] = original;
    }

    expect(thrown, 'a container with a missing field was accepted as complete').toBeInstanceOf(Error);
    const failure = thrown as Error & { code?: string; component?: string };
    // The field's name is the one fact a support report needs, and the code
    // is what tells a reader this is the container's lifecycle rather than
    // the subsystem the next caller would have touched.
    expect(failure.message, 'the refusal did not name the missing field').toContain(field);
    expect(failure.code).toBe('CONTAINER_NOT_STARTED');
    expect(failure.component).toBe('container');
    // Restored before the assertion above, so a failing expectation cannot
    // leave `afterEach` disposing a half-container and attributing the error
    // to teardown.
    expect(assertStartComplete.bind(null, app), 'the restored container is still refused').not.toThrow();
  });

  it('accepts a container start() finished, and names every field of a fresh one', async () => {
    // Both ends of the same function. Without the first half the refusal would
    // be indistinguishable from a check that always throws; without the second,
    // a `start()` that assigned everything but still got refused could only be
    // seen as a `start()` failure.
    app = await startApp();
    expect(() => assertStartComplete(app!), 'start() finished but was refused').not.toThrow();

    const fresh = new UcadApp({
      paths: {
        userData: dir,
        dbPath: path.join(dir, 'ucad.db'),
        blobDir: path.join(dir, 'blobs'),
        logDir: path.join(dir, 'logs'),
        cacheDir: path.join(dir, 'cache'),
        downloadDir: path.join(dir, 'downloads'),
      },
    });
    let thrown: unknown;
    try {
      assertStartComplete(fresh);
    } catch (error) {
      thrown = error;
    }
    const failure = thrown as Error & { code?: string };
    expect(failure, 'a container that never started was accepted as complete').toBeInstanceOf(
      Error,
    );
    expect(failure.code).toBe('CONTAINER_NOT_STARTED');
    for (const field of PROMISED_FIELDS) {
      expect(failure.message, `the refusal left ${field} out`).toContain(field);
    }
  });

  it('checks its own promises as the last thing start() does', () => {
    // The runtime half of the promise is only a guarantee while `start()`
    // actually calls it, and it is only *correct* while it runs after every
    // step: a check placed before `#initRuntime()` would report the fields that
    // step assigns. Both halves are read from the source, because there is no
    // way to make a real `start()` skip a step.
    //
    // `startBodyOrFail()` rather than `startBody()`: an empty slice would make
    // the assertion below report `start()` as having lost the call, which is
    // the defect the gate exists to name — so a moved anchor would be
    // indistinguishable from that defect. The failure now names the anchor.
    const body = startBodyOrFail(fs.readFileSync(CONTAINER_SOURCE, 'utf8'));
    expect(body, 'start() no longer runs #assertStartComplete()').toContain(
      'this.#assertStartComplete();',
    );
    expect(
      body.indexOf('this.#assertStartComplete();'),
      'the completeness check runs before the steps it is checking',
    ).toBeGreaterThan(body.indexOf('this.#initRuntime();'));

    // And the method the body calls has to be the decision the gate above
    // drives: `#assertStartComplete()` delegating to `assertStartComplete()`
    // is what makes "a missing field is refused, by name" a fact about
    // `start()` rather than about a function beside it. A body that grew its
    // own copy of the check would leave the gate testing a path production no
    // longer takes.
    const check = privateHashBodyOrFail(
      fs.readFileSync(CONTAINER_SOURCE, 'utf8'),
      'assertStartComplete',
    );
    expect(
      check,
      '#assertStartComplete() no longer delegates to assertStartComplete(), so the gate drives a path start() does not take',
    ).toContain('assertStartComplete(this);');
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
