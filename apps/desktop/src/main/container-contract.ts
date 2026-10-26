/**
 * The container's contract, separated from the composition root that keeps it.
 *
 * `app-container.ts` is where every subsystem is constructed, in the order the
 * rest of the app depends on. This file is the *list* that construction is
 * checked against: which fields `start()` promises, which of them the
 * retention service is built from, and the compile-time proof that every value
 * member is on exactly one of those lists.
 *
 * The split is not cosmetic. A reader asking "what does this container
 * promise?" no longer has to hold a 1 300-line composition root in their head,
 * and a change to the lists has one place to land. The declarations still
 * belong to `apps/desktop/tsconfig.main.json` (both files are under
 * `src/main`), so `npm run typecheck` checks them — moving a list into a test
 * would make its `satisfies` an editor-only check, which this repository has
 * paid for before.
 *
 * ## When to add a field here
 *
 * Only when adding a subsystem. The sequence is deliberate:
 *
 *  1. declare it on `UcadApp` as `field!: T`;
 *  2. assign it in the `start()` step that owns it;
 *  3. add the name to `STARTED_FIELDS`, next to that step;
 *  4. if it is not built by `start()` at all (a constructor field, an
 *     always-present map, a getter), add it to `FieldsNotBuiltByStart`
 *     instead — with a sentence saying which of those it is.
 *
 * Step 3 or 4 is not optional: `_everyFieldIsStarted` is a conditional type
 * that stops compiling when a value member is on neither list. That is the
 * point — a forgotten checklist entry is a build failure, not a field that
 * silently reaches a caller as `undefined`.
 *
 * ## When to hesitate
 *
 * If the new name is a *getter*, it is not a promise `start()` makes; it reads
 * fields that `start()` builds. If it is a helper method, it is not a value
 * member at all (`ContainerField` excludes functions). Neither belongs on
 * `STARTED_FIELDS`, and adding one there weakens the check for the fields that
 * do. The lists are exhaustive, not a place to quiet an error.
 */

import type { UcadApp } from './app-container';

/**
 * The mark a checked field carries.
 *
 * `requireStarted()` is the only thing that hands one out, so a dependency
 * that reaches a service without passing the guard is a compile error rather
 * than a runtime surprise: `eventLog: this.eventLog` does not type-check
 * where a `Started<…>` is expected, and
 * `eventLog: this.requireStarted('eventLog', this.eventLog)` does.
 *
 * The mark is a fiction the type system believes — at runtime the field is
 * the same object it always was.
 *
 * **Scope.** The guard protects the dependencies of lazily built services
 * (today only `retentionDeps()`). It is deliberately not a blanket wrapper
 * around every `!` field: callers of the other subsystems only exist after
 * `start()`. Those fields are covered instead by `STARTED_FIELDS`, which
 * `start()` itself checks once it is done (`#assertStartComplete()`) and which
 * the scanner in `tests/contract/app-container-started.test.ts` requires every
 * `field!: T` to be on. Adding a field to the guard's scope therefore means
 * widening `retentionDeps()`, not assuming this mark already reaches it.
 *
 * That scope is a test, not a promise: `tests/contract/app-container-started.test.ts`
 * reads the sources and fails when the guard is asked for a field outside
 * `retentionDeps()`, for a field the retention list does not name, or from any
 * other file under `src/main`. A wider guard is therefore a red test with this
 * paragraph named in it, rather than a sentence that quietly stopped being true.
 */
const STARTED = Symbol('ucad.container.started');

/** A field `requireStarted()` has vouched for. */
export type Started<T> = T & { readonly [STARTED]: true };

/**
 * The container's *value* field names, as a type.
 *
 * Every list of container fields is written against this, so a name that is
 * not a field — a rename that was not carried through, a typo — does not
 * compile instead of being discovered at runtime.
 *
 * Methods are excluded on purpose, and the exclusion is what makes the name
 * mean "a field `start()` is responsible for": `start`/`dispose`/`activateWorkspace`
 * are functions the class always has, so putting one on a list of things to
 * check after start-up would be a checklist entry that can never be wrong.
 * `keyof UcadApp` alone would have accepted it.
 *
 * The type lives in this file, which belongs to
 * `apps/desktop/tsconfig.main.json`, so a bad name fails `npm run typecheck`.
 */
export type ContainerField = {
  [K in keyof UcadApp]-?: UcadApp[K] extends (...args: never[]) => unknown ? never : K;
}[keyof UcadApp];

/**
 * The container fields the retention service is built from (§8.4).
 *
 * The list is the contract, and it is deliberately the *only* place the names
 * are written down:
 *
 *  - it is checked against the container (`keyof UcadApp`), so a name on it
 *    that is not a real field does not compile;
 *  - the bag is typed by it, so a name on it has to be supplied — and
 *    supplied *through the guard*, because the bag holds `Started<…>` values;
 *  - the contract test walks it one field at a time, so a field the guard
 *    forgot is a test that fails.
 */
export const RETENTION_DEPENDENCIES = [
  'db',
  'sessionStore',
  'blobs',
  'logger',
] as const satisfies readonly ContainerField[];

/**
 * The bag the retention service is built from: one *checked* field per name
 * on the list.
 *
 * If the service gains a dependency, `retentionDeps()` stops satisfying the
 * service's own options until the dependency is on the list above — and until
 * it goes through `requireStarted()`. A dependency nobody checks is a
 * dependency that reaches a subsystem as `undefined`.
 */
export type RetentionDeps = {
  readonly [F in (typeof RETENTION_DEPENDENCIES)[number]]: Started<UcadApp[F]>;
};

/**
 * Every field `start()` is responsible for — the list the `field!: T`
 * declarations on `UcadApp` are a promise about.
 *
 * The container declares its subsystems with `!` because `start()` builds them
 * in order; the `!` is a claim, and this is the list of claims. Two things read
 * it, and they answer different questions:
 *
 *  - `start()` itself, as its last act (`#assertStartComplete()`): a field that
 *    is still missing is a container that was never finished, and it is
 *    reported as *that* — with the field's name — instead of as a SQLite error
 *    three layers down. Before this, a forgotten assignment surfaced as
 *    `undefined` behind a type that said `Database`, and the first caller to
 *    touch it failed somewhere else entirely.
 *  - the scanner in `tests/contract/app-container-started.test.ts`, which reads
 *    the class body and fails when a `field!: T` is not named here. A list
 *    nobody maintains goes stale silently; a list the source is checked
 *    against goes red.
 *
 * A new subsystem is added here on purpose, next to `start()` assigning it.
 * `satisfies readonly ContainerField[]` (checked by `npm run typecheck`, since
 * this file is part of the main-process project) rejects a name that is not a
 * field, so a rename carried through the class alone does not compile.
 */
export const STARTED_FIELDS = [
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

/**
 * The container's value members that are true without `start()` having run.
 *
 * `STARTED_FIELDS` answers "which fields does `start()` promise"; the scanner
 * in `tests/contract/app-container-started.test.ts` answers the reverse by
 * reading the class body for `field!: T`. This list is the third fact the
 * *compiler* needs for that reverse direction, and the exclusion has to be
 * written down somewhere: `ContainerField` is `keyof UcadApp` minus the
 * methods, so it also holds everything that is already there before start-up.
 *
 *  - `paths` — set by the constructor, from the options the caller passed;
 *  - `agents` — an always-present map, filled by `registerAgent()` long after
 *    start-up;
 *  - `retention`, `encryptionEnabled`, `currentWorkspaceId` — getters. A getter
 *    is not a promise `start()` makes; these three *read* fields that
 *    `start()` builds (`retentionService`, `db`, `activeWorkspaceId`), which is
 *    the opposite relationship.
 *
 * **A name here is a decision, not a way to silence an error.** The guarantee
 * below says every value member is either on `STARTED_FIELDS` or here, so a
 * field forgotten from the checklist fails to compile — and the source scanner
 * in the contract suite still requires every `field!: T` to be on
 * `STARTED_FIELDS`, so a *started* field moved down here does not buy silence:
 * that gate stays red. This list can therefore not become the place a
 * forgotten field goes to hide; a new getter is one line of deliberate
 * thinking instead.
 */
type FieldsNotBuiltByStart =
  | 'paths'
  | 'agents'
  | 'retention'
  | 'encryptionEnabled'
  | 'currentWorkspaceId';

/**
 * The line below `npm run typecheck` refuses to compile when a name above is
 * not a container member at all.
 *
 * The `satisfies readonly ContainerField[]` that guards `STARTED_FIELDS` cannot
 * guard a type, so the same check is written as the same shape of conditional:
 * a typo or a rename that was not carried through makes the annotation below
 * unsatisfiable, and the failure names the offending string rather than saying
 * only that something is wrong.
 */
const _fieldsNotBuiltByStartAreFields: [
  Exclude<FieldsNotBuiltByStart, ContainerField>,
] extends [never]
  ? true
  : { readonly notAContainerField: Exclude<FieldsNotBuiltByStart, ContainerField> } = true;

/**
 * A container field that is neither started nor self-made — `never` while the
 * two lists together cover the class.
 *
 * `satisfies readonly ContainerField[]` on `STARTED_FIELDS` answers "is every
 * name on the list a field"; this answers the direction a hand-written
 * checklist actually gets wrong: "is every field on a list". Before it, a new
 * subsystem declared as `field!: T` and forgotten here was caught only by the
 * contract suite — a test, which runs when somebody runs it, in a project
 * whose type-check is what CI runs on every push.
 */
type FieldNeitherStartedNorSelfMade = Exclude<
  ContainerField,
  (typeof STARTED_FIELDS)[number] | FieldsNotBuiltByStart
>;

/**
 * The line below `npm run typecheck` refuses to compile when a field is on
 * neither list.
 *
 * The mechanism is the one `_retentionDependenciesAreStarted` uses — a
 * conditional annotation that only holds while the exclusion is empty, so the
 * error lands on this declaration rather than at whichever use site the
 * compiler happened to reach first. The failure branch differs on purpose:
 *
 * ```ts
 * true is not assignable to type '{ readonly missingFromStartList: "brandNew"; }'
 * ```
 *
 * names the field somebody forgot, while the sibling's `never` says only that
 * something is wrong. That is worth the asymmetry: this check's whole job is to
 * send a reader to one missing line, and a field name in the message is the
 * difference between a one-minute fix and a search.
 */
const _everyFieldIsStarted: [FieldNeitherStartedNorSelfMade] extends [never]
  ? true
  : { readonly missingFromStartList: FieldNeitherStartedNorSelfMade } = true;

/**
 * A retention dependency that is not a started field — `never` when the two
 * lists agree.
 *
 * `RETENTION_DEPENDENCIES` is a subset of `STARTED_FIELDS`, and it is not an
 * accident: retention is built from container fields (`db`, `sessionStore`,
 * `blobs`, `logger`), and those are exactly the fields `start()` promises.
 * The runtime test in `tests/contract/app-container-started.test.ts` asserts
 * the inclusion, but a test runs only when somebody runs it — and the two
 * lists are written down separately, one field at a time, so the day one of
 * them gains a name the other does not have is the day a field escapes
 * `start()`'s own completeness check while `requireStarted()` keeps vouching
 * for it. This alias makes that a `tsc` error instead: the assertion below
 * only compiles while the exclusion is empty.
 */
type RetentionDependencyOutsideStartedFields = Exclude<
  (typeof RETENTION_DEPENDENCIES)[number],
  (typeof STARTED_FIELDS)[number]
>;

/**
 * The line above `npm run typecheck` refuses to compile when the two lists
 * disagree.
 *
 * The annotation is `true` while every dependency is a started field, and
 * `never` the moment one is not — and `true` is not assignable to `never`, so
 * the error names this declaration. A type alias alone would not do it: an
 * unused alias that evaluates to something unpleasant is still a valid alias,
 * and nothing would report it. The `_` prefix is what keeps the linter's
 * unused-variable rule quiet about a value that exists only to be checked.
 */
const _retentionDependenciesAreStarted: [RetentionDependencyOutsideStartedFields] extends [never]
  ? true
  : never = true;
