# Contributing

## Before you start

The test suite is the definition of done, not a formality. A change is finished when the
gates are green, not when the code compiles.

## The gate suite

The suite is the definition of done, not a formality. Each gate is expected to
be able to fail, and a gate that has never gone red is indistinguishable from a
test that does nothing.

**Unit, contract and integration** — `tests/contract`, run by `npm test`:

| Area | What it pins down |
|---|---|
| Contracts | Adapter, decision, injection, tool, MCP, host-entry and intelligence conformance |
| Injection | The rendered pack is deterministic and hash-stable |
| Handoff | Append-only chain, one-claim-per-handoff, schema-checked bodies |
| Permissions | Deterministic risk, scoped rules, audit trail written on every outcome |
| Credentials | A write that cannot be persisted must not report itself as saved; an unreadable vault is never overwritten |
| Retention | One retention service: the figures the Storage pane reports are measured on the instance that purges, the start-up sweep is that same instance, and a container that has not started refuses to build one over `undefined` — over a dependency list `tsc` checks, not a comment |
| Container | Every subsystem the container promises (`field!: T`) is on a checklist — typed against the container's own field names, so a misspelt or renamed entry is reported at the line — and is really there after `start()`: a step that forgets to assign one is a failing test. The scan is fed fixtures for the spellings that matter (`db!:Database`, `static`, `declare`), and the container is asserted to declare no form the scan deliberately skips. The lazy retention service's dependency bag also goes through a compile-time start-up guard — scoped to that bag, not to the whole container; the bag's field names are cross-checked against the checklist and its guard calls are recorded, exactly once each, and `dispose()` closing the database is asserted because the tests' own teardown depends on it |
| Build graph | Every `@ucad/*` dependency is a project reference, and the solution lists each package once |
| Copy and a11y | No hard-coded UI strings, locale parity, contrast, focus indicators |
| Menu | Every command Main registers has a renderer handler |
| Versions | Shipped manifests pin exact versions; the installed engine matches what is declared |
| Updates | The shipped feed is `https`; an override that is not `https` is refused without falling back; every feed URL — override, packaged file and the service's own wiring — is judged by one function, and the three entry points are asserted to accept and refuse the same values with the same reason; a download is made against the document the check read, never a second read of the feed, so a feed that changes between the check and the download cannot point at a different file than the one the user was shown, and a download whose checked document is gone is refused rather than re-fetched; an unusable configuration candidate is skipped while a refused override stops the search, and the asymmetry is a contract rather than an accident; a feed with no `sha256` installs nothing; a mismatch deletes the staged file instead of launching it; every download redirect must stay `https`; a download follows at most five redirects — the fifth succeeds, the sixth is refused before a seventh request; the production wiring is scanned to prove it never passes the launch test seam (`beforeLaunch`), which exists only for the post-verify window; and the residual window between the last staged-file check and the launcher resolving the same path is *asserted*, not just written down: a file substituted inside the launcher after the check is launched, so closing that window turns the test red instead of leaving a bounded claim to be mistaken for a closed one; and the feed's two log lines — resolved, refused — are said once per process by a value the suite drives directly, rather than by flags inside a file no test can import, with the refusal's sentence chosen from a table keyed on the reason the resolver returns, so a typo in the variable is never reported as a downgrade attempt and a reason with no sentence does not compile |

**Interface** — `tests/e2e`, run by `npm run test:e2e`: the real `App` in a DOM
against the real fixture bridge, covering the conversation, navigation, the
permission dialog, handoff history, provider selection and every surface's crash
boundary.

**Layout** — `tests/contract/layout.test.ts` measures geometry in a real
Chromium window rather than a DOM approximation. It walks every surface at seven
widths plus the tightest window, and asserts that nothing overflows, collapses,
overlaps, falls outside its scroll container, or gets cut off. It also runs axe
at two layouts and writes screenshots to `.run-logs/layout/`.

**Running only the layout gate.** It launches a real Electron, so it needs a
display; a machine with none fails in about half a second, and the failure is not
about your change. This is the line for that machine:

```bash
npm run build:packages
ELECTRON_DISABLE_SANDBOX=1 xvfb-run --auto-servernum --server-args="-screen 0 1920x1080x24" npx vitest run tests/contract/layout.test.ts
```

Two parts of it are load-bearing, and `tests/contract/layout-gate-command.test.ts`
compares both with what `.github/workflows/ci.yml` runs for the same gate, so this
line cannot rot into advice that fails:

- **`--server-args`.** `xvfb-run`'s own default screen is 1280 wide, and a window
  larger than the display is clamped to it. The gate then measures 1280 where it
  asked for 1440 and fails on the one assertion whose job is to prove the
  measurement is the size it claims — a red gate about the display, not about the
  interface. The virtual display is part of the test environment, so it is sized
  here instead of left to a default.
- **`npm run build:packages` first.** `npm test` runs it as `pretest`; `npx vitest`
  does not, and the suite resolves `@ucad/*` to `packages/*/dist`. Without that
  build the gate measures whatever the last build left on disk.

With no display at all — on Linux, the platform where Chromium looks for `$DISPLAY` — what
the run prints is `Error: the layout probe produced no result` with
`Missing X server or $DISPLAY` under it. That sentence is pinned by driving a real Electron
launch with `DISPLAY` removed, so the symptom written here is the symptom the machine produces
rather than a description of one. Where the failure instead reads
`The platform failed to initialize`, the host has no usable Chromium sandbox:
`ELECTRON_DISABLE_SANDBOX=1` above is the same setting CI puts in that step's
`env:`, and the gate measures geometry, not the sandbox.

```bash
npm run typecheck && npm run lint && npm run knip && npm test && npm run test:e2e
```

`npm test` builds the packages first on purpose — the unit suite resolves
`@ucad/*` to `packages/*/dist`, not `src`. Running vitest directly bypasses that,
which is the same trap that once let a red-proof run come back green.

**The feed gates judge a built module, so the build is a precondition, not a
branch.** `scripts/verify-release-feed.mjs` decides with the app's *own* rules
(`checkChannelUrl` / `normalizeSha256`), imported from `apps/desktop/dist/main/` —
re-implementing them in a test would make the test a second opinion instead of a
check. That output is not built by `pretest`, so `vitest.config.ts` runs
`tests/global-setup.ts`, which builds it once in the parent process before any
file loads. The alternative — a `if (!built) return;` in each consumer — was tried,
and it produced a suite that reported **passed** while asserting nothing on a
fresh clone. `tests/contract/app-rules-build.test.ts` keeps that wiring from
rotting, and `tests/contract/replay-feed-local.test.ts` is the one file that still
carries its own missing-build branch: its end-to-end case spawns a child process
that additionally needs `openssl` and (for the green branch) the release host, so
its precondition set is not the one a global setup can promise. That is a
**registered** residue, not an oversight — see 已知残留（不修，登记）in
`docs/dod-status.md`, which `tests/contract/dod-status.test.ts` compares with that
file's `KNOWN RESIDUAL` section in both directions.

CI runs exactly this sequence, plus a clean rebuild at the end: an incremental
build cannot catch a wrong build order, because a stale `dist` satisfies any
import.

`npm run verify:gates` runs those same steps locally, and it reads them out of
`.github/workflows/ci.yml` instead of carrying a copy of them: same commands,
same `xvfb-run` wrappers and screen size, same `env:`, same `bash -eo pipefail`,
in the same order, stopping at the first failure the way a CI job does. `--list`
prints the plan without running anything, `--only <id>` runs one step, and
`--json <path>` writes a record of what ran. A workflow step it cannot classify
(`./scripts/check.sh` and friends) is refused **before** anything runs, because a
step this command skipped in silence would still print the same green line. So
"CI equivalent" is a command somebody can re-run, not a transcript somebody
remembers.

**The lock file and npm majors move together.** `package-lock.json` is written
by npm 11, and CI pins the same version before `npm ci`. npm 10 materialises
optional peer entries (`@emnapi/*`) that npm 11 prunes, so one lock file cannot
validate under both — if a machine with a different npm major refreshes the
lock, bump the pinned version in `.github/workflows/ci.yml` in the same commit.

**Running the gates where Chromium has no sandbox.** The layout gate launches a
real Electron. On a rootless Linux box (CI runners, most containers) there is no
setuid `chrome-sandbox` and Chromium aborts at startup rather than run without
one. The same happens on some Windows machines. CI sets
`ELECTRON_DISABLE_SANDBOX=1` for the unit step for exactly this reason; a local
run needs the same env var in front of `npm test`. The gate measures geometry,
not the sandbox, so disabling it costs the gate nothing.

The symptom is worth recognising, because the error does not name it. With no
usable sandbox the renderer never starts, so `loadURL` returns `ERR_FAILED (-2)`
**even for a `data:` URL** and the GPU process dies with an access violation
(`exit_code=-1073741819`). The probe still writes its result file, so the gate
used to report that as "the sweep did not visit every surface" — a symptom four
assertions away from the cause — while the geometry checks above it passed over
an empty list. The gate now asserts that it measured something, first, and says
so by name.

**A full temp directory is reported as a broken test.** Several contract gates
write a throwaway file under `os.tmpdir()` — a saved verifier run, a feed
pipeline fixture, a copied script tree. On a host whose `/tmp` is a quota-limited
tmpfs the write fails with `Unknown system error -122: …, write` inside a test
helper, which reads like a defect in the gate rather than in the disk. Give the
run somewhere with room:

```bash
mkdir -p .run-logs/tmp && TMPDIR=$PWD/.run-logs/tmp npm test
```

(`.run-logs/` is ignored.) This is not a workaround to encode in the tests: the
suite writes temp files because a check that shares one path between two runs
cannot tell whose run corrupted it.

## Upgrading zod or Electron

An upgrade of either one is an **explicit decision**, not a version bump: both
change behaviour the suite pins, and both fail in a way that looks like
something else. These are the gates that decide the upgrade for you.

**zod** — `npm i zod@<version>`, then:

| Gate | What it decides |
|---|---|
| `tests/contract/ipc-errors.test.ts` | Every issue code the *new* Zod can raise has a Chinese reason of its own. The list is taken from the running Zod's own enum, so a new code fails here rather than silently answering 「不符合要求」. |
| `tests/contract/ipc-errors.test.ts` — wordings | `ZOD_OWN_OPENINGS` is the list of sentences Zod writes *itself*, and the only thing that tells a library message from one this app wrote. That test makes the installed Zod raise one issue per code and checks every message it wrote starts with an entry, so a reworded message fails there and names the message. Without it a Zod upgrade silently turns a library sentence into an "app sentence" and shows it to a person in English. |
| `tests/contract/ipc-error-bridge.test.ts` | The exact set of codes that answer with the generic reason, the sentence that crosses the bridge, and the `reasonSource` that says whether the reason came from the schema or from the table — so a schema whose own message was swallowed cannot pass as a wording change. |
| `tests/contract/zod-custom-messages.test.ts` | The “no English custom message” scan, and the shapes it is known *not* to judge: a schema reached through a renamed or destructured `z`, and a positional message after a regex literal containing a comma (`/a,b/`). Each blind spot is an assertion, so teaching the scan to see one fails there instead of quietly changing what the gate covers. The same file asks the *repository* which source roots it has — at any depth — and fails on one the scan does not read. |
| `npm run typecheck` | The reason table is `Record<z.ZodIssueCode, string>`, so a new code fails the build before the app can ship a generic sentence for it. |

A new code is not finished until it is **translated**. Adding it to
`ZOD_REASON_BY_CODE` with the generic reason is a decision to record — the
bridge test names the codes that are allowed to answer 「不符合要求」, and adding
one is a change to that list, not a way to get the gate green.

**Electron** — `npm i -D electron@<version>`, then:

| Gate | What it decides |
|---|---|
| `tests/contract/layout.test.ts` | Geometry in a real Chromium window at seven widths: nothing overflows, collapses, overlaps, falls outside its scroll container, or gets cut off. A new Chromium moves fonts and default box metrics, so this is the gate that says whether the interface still fits. |
| `tests/contract/layout-scripts.test.ts` | The page scripts the layout gate runs in the browser still parse, and no script body contains a backtick — the mistake that has broken the probe three times. |
| `npm run test:e2e` | The real `App` in a DOM against the fixture bridge, including every surface's crash boundary. |

Both upgrades want a **clean** run of the whole suite. An incremental
`tsc --build` can satisfy a stale `dist` and hide a broken import — the same
trap the clean rebuild at the end of CI exists to catch.

## House rules

These are the ones this codebase actually enforces, rather than preferences.

**A failure must not look like a fact.** A read that fails and a read that returns nothing
are different states and must render differently. This has been the single most repeated
defect in this repository, across the session list, the permission rules, the diagnostics
page and the credential store. When you add a read, carry the reason alongside the value.

**A gate that cannot fail is not a gate.** If a test's subject no longer exists, delete the
test rather than leaving it to skip forever. It looks like coverage and protects nothing.

**Prove a gate can go red.** A test you have never seen fail is indistinguishable from a
test that does nothing. Break the thing on purpose, watch it fail, put it back.

**A scripted test double that runs out fails the expectation, not a throw.** When a
stand-in such as `feedFetchSteps` or `scriptedGet` receives a request the test did not
script, it calls `expect.fail(…)` with the count and the request. A bare `throw` is caught
by the product code under test and surfaces as a plausible product error — the test's own
bug wearing the app's clothes. Any new scripted double follows the same rule, and
`the scripted helpers fail the test that outruns them` keeps the rule red-able.

**Prefer a mechanism to a reminder.** A rule in a document is skipped. A check in the suite
is not. If a mistake has been made twice, the answer is a gate, not a better note.

**Do not state a number that can rot.** Prose counts go stale silently; link to the gate
instead.

**Do not widen the scope.** Unrelated cleanup in a change is how a review turns into an
archaeology dig. File it separately.

## How the source scans are written

Several gates read source text rather than execute it. Each one is a small, deliberately
unambitious parser, so its blind spots are the price of not carrying a real parser in a
contract test. Two rules apply to all of them:

- **Test the scan on fixtures first.** A scanner that has only ever run over a passing
  code base has an unknown failure mode. Every file below feeds its scanner the spellings
  a real call site takes — and the spellings it is known to miss.
- **When the scan misses a spelling, fix the scanner and add a fixture.** Do not fix only
  the source line that was missed; the next one will be written the same way. If the scan
  is going to *keep* missing a spelling, assert that shape's absence instead, so the blind
  spot is a red test rather than a comment.

| Scanner | Lives in | What it reads |
|---|---|---|
| Comment blanking | `tests/contract/source-scan.ts`, driven by `source-scan.test.ts` | Comments vs. code: strings, template literals and their `${…}` interpolations, regex literals, division |
| Comment blanking (oracle) | `tests/contract/source-scan.ts`, driven by `source-scan.oracle.test.ts` | The same text read by the TypeScript parser: comment ranges must be blanked in place, and every other byte kept |
| Container claims | `tests/contract/app-container-started.test.ts` | `field!: T` declarations in `app-container.ts`; the checklists live in `container-contract.ts` |
| Zod messages | `tests/contract/zod-message-scan.ts`, driven by `zod-custom-messages.test.ts` | Custom-message positions inside Zod schema expressions |
| Bare throws | `tests/contract/bare-throw-scan.ts`, driven by `error-formatting.test.ts` | `throw new Error(…)` / `throw appError(…)` under `apps/desktop/src/main` |
| Page scripts | `tests/contract/layout-scripts.test.ts` | The scripts in `scripts/layout-page-scripts.mjs` |
| Renderer markup | `tests/contract/ui-copy.test.ts`, `layout.test.ts` | Hard-coded copy, unnamed controls, inline spacing/type sizes |

**The table is itself a gate.** `tests/contract/scanner-registry.test.ts` compares it with the
scanners it knows about in both directions, resolves every path in the *Lives in* column on
disk, requires a row for every `-scan.ts` module in `tests/contract`, and checks that each
row's driving test still imports its scanner and keeps the fixture block named below. Adding a
scan without a row, or renaming a file in one place only, fails there — the map is read by
people who are already lost. The block name it looks for is a **quoted** string literal, first
argument to `describe(`, `it(` or `test(` (`test` is vitest's alias for `it`) — whitespace after the
paren is fine, so a long name wrapped onto the next line still counts. A backticked name does not:
the gate then reports the block as deleted. That blind spot is asserted, not just noted:
`tests/contract/scanner-registry.test.ts` pins that a template literal is *not* recognised, so
teaching the scan about backticks fails there first. The wrappings that *are* recognised have
fixtures of their own, so a false "block deleted" on a wrapped or `test(`-written block would have
shown up there rather than at whoever next wrapped a long name.

**Comment blanking.** Every scanner below that asks a question about *code* reads
`blankComments()` rather than its own walk. The module is tested where its states are decided
(`source-scan.test.ts`), not only through the gates that consume it: a shape it misreads is a
shape every gate misreads. The states are strings, template literals — whose `${…}` is code,
so its comments are blanked and its quotes and regex literals are read again — and regex
literals, judged by the operand heuristic (a value before the `/` means division). The
heuristic is biased so that a mistake can only make a gate *find* something, never lose code.
If a scan needs a different reading of a shape, add it here with a fixture; a second copy of
this walk in a gate is the bug this module exists to prevent.

**Comment blanking has an oracle.** Fixtures pin the shapes this walk is known to read;
`source-scan.oracle.test.ts` asks `@typescript-eslint/typescript-estree` — a parser that knows
nothing about this heuristic — for the comment ranges in every `.ts`/`.tsx` the repository ships,
and compares the two readings byte for byte. A disagreement fails with the file, line and column.
That is how the *next* unanticipated spelling is found on purpose rather than by a downstream gate
losing a call. A deliberate refusal (the `}` case above) is recorded in `KNOWN_DIFFERENCES` in that
file, with a reason; the list is checked in both directions, so an entry that no longer differs is
also a failure. An entry is a *pinned pattern* (`shape`, matched against the byte-level detail the
comparison prints) as well as a file name, so it excuses the construct somebody decided about and
nothing else: a second misread in the same file still fails, and an entry whose pattern matches
nothing is reported as stale instead of staying live. An empty list is the strongest setting — it
means no difference is acceptable at all. Do not add an entry to get green, and do not widen a
pattern to cover the next failure: either fix the walk and add a fixture, or write down why the
refusal is deliberate.

**Container claims.** The rule matches `!:`, not `!: ` — `db!:Database` is the same claim
as `db!: Database` to the compiler, so requiring the space silently skipped a field. It
reads the modifiers in front of the name (`private`, `readonly`, …) because `static` and
`declare` claims are skipped on purpose: neither exists on an instance `start()` can
answer for. The container is separately asserted to declare neither, so a field written
that way fails loudly. If a new declaration spelling appears (a decorator, a generic, a
different modifier), add it to the fixture block `the scan that reads the container’s
promises`; if the scan should keep skipping it, add an assertion under `declares no claim
the scan deliberately skips` rather than an explanatory comment.

**Adding a subsystem is four steps, and moving a name between lists is a decision.**
Declare it as `field!: T`, assign it in the `start()` step that owns it, and add the name
to `STARTED_FIELDS` next to that step. Only a field `start()` does *not* build — a
constructor field, an always-present map, a getter — goes in `FIELDS_NOT_BUILT_BY_START`,
with a sentence saying which of those it is. The two lists are answers to one question
asked from two sides, so `npm run typecheck` guarantees both coverage (every value member
is on one of them) and disjointness (a name on both does not compile). Coverage alone
cannot tell a genuinely self-made name from a **real** `field!: T` field moved onto the
self-made list to quiet an error, so that direction is a red test instead: the scan fails
if a name on `FIELDS_NOT_BUILT_BY_START` is declared `field!: T` in the class body, and
the running container is asked *why* each name is on the list (`assigned` / `accessor`) —
an entry that looks like an unassigned claim fails both gates. A new name therefore means
adding it to that test's pinned expectations, which is the point.

**Zod messages.** The scan reads `message` / `required_error` / `invalid_type_error` in
schema options, a positional second argument (`min`, `max`, `regex`, `refine`, …), the
first argument of `.strict(…)`, and a same-file `const` reference. It reports anything
else in a message position as `unresolved` (`template-with-expression`,
`concatenated-literal`, `unknown-constant`, `not-a-literal`), and the app-wide test
requires that list to be empty. The accepted blind spots are pinned in
`zod-custom-messages.test.ts`: a renamed or destructured Zod namespace, and a positional
message after a regex literal containing a comma (`/a,b/`), where the comma reads as an
argument separator. Write the sentence as one Chinese literal, or as a `const` beside the
schema; if a new spelling must be read, add it to the scanner's fixture block **and** to
the scanner (`customMessages()` / `scanZodMessages()`) — an unreadable shape is not
acceptable unless it lands in `unresolved` with a reason. The scan's roots are
`packages/*/src` and `apps/*/src`; a source root the rule does not reach is a failing
test, and the fix is `EXTRA_SCAN_ROOTS` in `zod-message-scan.ts` (see "Adding a workspace
package").

**Bare throws.** The scan strips comments (including a trailing `//`) before matching,
and matches over the whole text rather than line by line, so a `throw` whose argument
wraps onto the next line is still counted and is reported where `throw` starts. String
literals are deliberately not stripped: stripping them would also hide the messages the
gate is about, so a quoted example fails loudly instead of passing silently. Add a new
allowed call site to the `ALLOWED` ledger in `error-formatting.test.ts` — the comparison
is equality, so a fixed entry must leave the ledger — and add its spelling to the
fixture block `the bare-throw scan`.

**Page scripts.** Every entry in `PAGE_SCRIPTS` must parse as a *script* (compiled with
`vm.Script`, not `new Function`) and must contain no backtick, even in a comment: a
backtick ends the template literal and the rest is parsed as the host module, which
surfaces as an error naming an unrelated identifier. New page scripts go in
`scripts/layout-page-scripts.mjs` and get a name in `PAGE_SCRIPTS`; write `'quoted'`
rather than a backtick anywhere in the body.

**Renderer markup.** These scans read `.tsx` under `apps/desktop/src/renderer/src` and
look for hard-coded user-visible strings, controls with no accessible name, and inline
`marginTop` / `marginBottom` / `marginLeft` / `fontSize` / `lineHeight`. Their fixture is
the renderer itself: a false positive is a source line that should use the i18n table or
the spacing scale. Do not add an allowlist entry for a one-off string; name the control
or move the copy into the locale files.

### Which facts get a behaviour test, and which fall back to source text

**Run the code when the fact is about what the code does.** A gate that executes the thing it
describes survives a refactor; a gate that reads its text does not. The move this repository
keeps making is taking a piece of logic out of a file that can only be scanned and into a
function that can be called, then asserting on the call: adapter search paths, the composition
that turns process facts into a resolution, the parse/tail/release-directory helpers behind the
manual packaged check and its `spawn`/`kill` seams all live on that side of the line. Those
gates read as statements about behaviour — "this specifier resolves from these directories",
"an empty search path list is refused with this code", "a launch that never prints the line is
a failure" — and they keep working after a rename.

**Scan the source only when the fact *is* about the source.** Some promises are not
observable from a test process at all, and pretending otherwise is how a gate becomes a
comment:

- *Absence of a thing nobody wrote yet* — an adapter id list re-inlined in the boot path, a
  bare `throw` in `apps/desktop/src/main`, a packaging step in a workflow. There is no call to
  make; the fact is the shape of the file.
- *Electron-only call sites* — three getters that need a real `app` and `__dirname` inside an
  asar. The composition around them is testable (that is the point of moving it), but the
  getters themselves can only be read.
- *CI's own configuration* — `electron-builder` appearing in a workflow is a property of a YAML
  file, and the honest gate is a scan of that file, not a simulation of GitHub.

**Then say where the scan is blind.** Every text-scanning gate here names its own boundary in
its module doc, and records it with a failing-case fixture where one can exist — a scan whose
blind spot has no test drifts silently the moment somebody edits the pattern. The boundaries you
will meet, and where each is written down:

- **Comments count as matches.** `tests/contract/ci-shape.ts` matches the raw text of a workflow,
  so a comment that spells out a packaging command trips the gate. That is deliberate: a false
  alarm is reworded in a minute, while a missed step makes this document lie. Do not narrow the
  pattern to remove the false alarm — the failure (`packagingProblem`) names the file **and line**
  it matched, and says both fixes: reword the comment, or, if it is a real step, update README.md
  in both languages, this file and `adapter-resolution.ts` to describe what CI now checks.
- **A scan that proves a step is *present* reads `run:` entries, not raw text.**
  `tests/contract/ci-typecheck.test.ts` asserts that a workflow runs `npm run typecheck`, which is
  the only thing enforcing every compile-time assertion here (`npm test` erases types through
  esbuild). It deliberately does **not** reuse the raw-text reader above, and the asymmetry is the
  reason: for packaging a false alarm is cheap, while for the typecheck a *commented-out*
  `# - run: npm run typecheck` must not count as CI running it. The reader therefore reads `run:`
  lines only (including a block-scalar body), and the case *does not count a commented-out step*
  pins the difference. Its own blind spot — a command hidden behind `run: ./scripts/check.sh` — is
  asserted too, like every other scan here.
- **A workflow file reached through a symlink is followed, not skipped.** The reader
  resolves the link and reads the target's text, so a `release.yml` that points at a
  packaging job is still a red gate. A `.yml` / `.yaml` entry that does not resolve to a
  regular file (a broken link, or a link to a directory) throws with both fixes in the
  message: materialise the workflow, or extend the reader. `ci-shape.ts` records the
  rule, and `ci-shape.test.ts` pins it in *follows a symlinked workflow file, so a link
  cannot hide a packaging step* and *refuses a workflow entry it cannot read, instead
  of skipping it*.
- **Composite actions, and reusable workflows in *other* repositories, are not read** — they are
  not files in `.github/workflows/`, so a packaging step that lives there is invisible. The gap
  is asserted twice in `tests/contract/ci-shape.test.ts` (*what this reader deliberately does not
  see*): once with a fixture showing the `npm run dist` present in an action and the reader
  answering `[]`, and once with an assertion that this repository installs neither shape — so the
  commit that moves a step into `.github/actions/` or calls a remote reusable workflow is a red
  test whose message names the reader to extend, not a paragraph nobody reads. A reusable
  workflow in *this* repository is a file here and is read, which is why the bullet says "other
  repositories".
- **A command hidden behind a script is not recognised** — `run: ./scripts/package.sh` names a
  file, and no text match can read what that file does. `ci-shape.test.ts` pins that boundary
  (*cannot see a command hidden behind a script*); the fix if it ever matters is to make the step
  call a named command, not to trust the gate.
- **Template-literal block names are not recognised** by `tests/contract/scanner-registry.test.ts`,
  and that miss is itself asserted.
- **String literals are not stripped** by the bare-throw scan, so a quoted example fails loudly
  instead of passing quietly.

The rule of thumb: if you cannot write a fixture that makes the scan fail, the scan is not yet a
gate — either widen it, or assert the shape's absence instead and say in the doc which of the two
you did.

## Working on the interface

```bash
npm run dev:web
```

Runs the renderer in a browser against an in-memory fixture — no Electron, no credentials.
`?scenario=default|empty|loading|error|partial|permission` selects the state. The E2E suite
drives the same fixture, so what you see there is what the tests see.

For layout work, `tests/contract/layout.test.ts` measures a real Chromium window and writes
screenshots to `.run-logs/layout/`. Geometry is judged automatically; whether it *looks*
right is still a human call.

### The layout language

Three rules keep the interface legible; each is enforced by a gate, so a change that breaks
one fails in CI rather than in a screenshot review.

- **One scale for rhythm.** Gaps between siblings are `--sp-1..5` (4/8/12/16/24px), reached
  from markup as `.mt-*` / `.mb-*` / `.ml-2` / `.gap-1`. Type roles are `--fs-body/note/fine`
  as `.fs-note` / `.fs-fine`; the numbers themselves live in `docs/DESIGN.md`, which is the
  register for every type size, radius, edge width and colour token, and
  `tests/contract/design-tokens.test.ts` fails if the register and `styles.css` disagree.
  Inline `marginTop`, `marginBottom`,
  `marginLeft`, `fontSize` and `lineHeight` are rejected by
  `tests/contract/layout.test.ts` ("adds no spacing or type size from markup"): a value
  chosen at the call site is exactly how the rhythm drifted to eleven different gaps in the
  first place. One-off geometry — a table column's width, a positioned menu's coordinates —
  stays inline and stays legal.
- **One measure per page.** `.pane` centres a `--page-w` (960px) column and every block in it
  is left-aligned to that column's edge. A block that declares its own `max-width` gives the
  page a second right edge; the conversation is the one narrower column (780px) and it owns
  both the transcript and the composer.
- **Colour carries meaning, prose is sans, identifiers are mono.** Blue interactive, green
  success, amber attention, red failure, nothing else coloured; a path or hash in a sentence
  wears `--mono` so it never reads as a word.

## Packaging on Windows

`npm run package` and `npm run dist` can fail on Windows with a cryptic
`ERROR: Cannot create symbolic link : 客户端没有所需的特权` while electron-builder unpacks
its `winCodeSign` cache. The cache archive contains macOS symlinks (`libcrypto.dylib`,
`libssl.dylib`), and creating symlinks on Windows needs a privilege a plain user token does
not have. It is not a defect in the build config, and it hits `--dir` (unpacked) builds too.

Two fixes, either is enough:

- enable Windows **Developer Mode** (Settings → System → For developers), which grants the
  symlink privilege without elevation; or
- run the packaging command once from an elevated shell — the extracted cache persists in
  `%LOCALAPPDATA%\electron-builder\Cache`, so later runs do not need the privilege again.

Do not disable `signAndEditExecutable` to get past this: it also writes the asar integrity
resource, and weakening the shipped artifact so a dev machine can build is the wrong trade.

**Packaging is not a CI gate, so it is a manual check — with a command.** `npm run package`
writes `release/`; then run

```bash
node scripts/verify-packaged-adapters.mjs
```

which launches the unpacked build, captures its stdout and stderr, and fails unless the
`adapters resolved:` summary line names `universal`. Three outcomes are told apart, because
they send you to different places: no build at all (says to run `npm run package`), a launch
that never printed the line (prints the tail of what the app said), and a launch that resolved
nothing or the wrong adapters (`adapters resolved: (none)` fails — it looks like success and is
not). On a headless machine: `xvfb-run node scripts/verify-packaged-adapters.mjs`.

The build is stopped again once the line appears, and what is stopped is the whole tree rather
than the app alone — a packaged UCAD runs Chromium children, and leaving those behind would
mean every smoke run leaves a process behind. The stop is `SIGTERM` to the process group, and
`SIGKILL` to the same group if it is still there after a 5-second grace period: the build
that needs the second signal is the wedged one (no display, a hung renderer), which is exactly
the smoke run that would otherwise leave a tray process behind. `Ctrl+C` stops it the same way
and exits 130, so an interrupted check is not reported as a broken build.

The line is only judged once its newline has arrived. A pipe read boundary can fall anywhere,
and a chunk ending in the middle of `adapters resolved: universal, mock` parses as the shorter
list `universal, mo` — a truncated answer that looks like a real one.

Reading a module from *inside* the asar needs Electron's patched `fs`, so it is the one
adapter-resolution step `npm test` cannot reach — the README states the same boundary, and
`tests/contract/adapter-resolution.test.ts` keeps that statement true of every workflow under
`.github/workflows/`, in **both** README languages: the English and Chinese bullets are each
compared with the workflows, so one language cannot go on promising a manual step beside an
automated one. (`readme-parity.test.ts` only keeps the two sections carrying the same keywords —
words-to-words cannot see that drift.) The script's judgement is covered by
`tests/contract/verify-packaged-adapters.test.ts`; only the launch needs a built app.

### The main chain, on a real desktop — also a command

`docs/manual-verification.md` asks whether the six things UCAD exists for actually work on an
installed build. That needs an OS key store, a display, and (for one of them) the vendor network,
so it is not a CI job — but it was, until now, a document with no way to re-run it. So:

```bash
npm run package
xvfb-run -a node scripts/verify-main-chain.mjs          # Linux, on a session bus that answers
```

It launches the built app, drives the same surfaces a person would over the DevTools protocol, and
prints the evidence the document asks for: the `renderedHash` of a real turn and the bytes it was
computed over, the decision rows with their rationale and confidence, the generated handoff and its
history, the update check against the **real** feed plus the two refused feeds and a failing one,
and what closing the window does under each setting. `--steps 1,3` runs a subset; on Windows pass
`--exec release\win-unpacked\UCAD.exe`.

Two things it cannot do, and says so in its own output rather than hiding: the project is opened by
writing the `workspaces` row (no DevTools method reaches the native folder picker, so the trust
prompt is not on screen), and an Xvfb display has no tray indicator host, so the tray is observed as
a process lifetime, not as a menu.

The key store is the precondition people trip over. On Linux Chromium picks its key store backend
from the **declared** desktop environment, so a session bus where `secret-tool` works is not enough:
without `XDG_CURRENT_DESKTOP` the app stops before a window exists. The script declares one for the
child, and stops the run with that sentence when the key store still refuses — a machine problem
reported as such, not a product defect.

The decisions the script makes — the environment the child gets, the sentence each refused feed must
produce, the columns it writes — are pinned by `tests/contract/verify-main-chain.test.ts`, which
reads the wording from `update-service.ts` and the column list from `session-store.ts`, so a
reworded screen or a renamed column turns this check red in CI instead of three weeks later in
someone's terminal. Only the launch still needs a built app and a desktop.

### Release preflight

Run these on the machine that produces the artifact, in this order:

- [ ] `git switch main` (or the release branch) — **not** a detached HEAD. `git status` says
      "HEAD detached at …" in one line, and it is the line people skim past: the build is then
      traceable to no branch, and the version tag lands on a commit the changelog does not
      describe. Switch first, then start the checklist; switching later means rebuilding.
- [ ] `npm ci && npm run build && npm test` — the gates CI runs, on the platform that will ship.
- [ ] `npm run package` — writes `release/`; a failure here is usually the Windows symlink trap
      above, not the app.
- [ ] `node scripts/verify-packaged-adapters.mjs` — exits 0, and its summary names `universal`.
- [ ] `node scripts/verify-main-chain.mjs --steps 1,4` — on a desktop with a working key store: one
      real turn whose `renderedHash` and bytes are read back, and one update check over the real
      network. Append what it printed to the table in `docs/manual-verification.md`; a row left at
      "未跑" or "阻塞" belongs in the release notes, not in a quiet file.
- [ ] run it once more and press `Ctrl+C` while the build is starting: the command exits `130`
      and leaves no UCAD process behind. The paragraph above makes that claim, and only a real
      signal checks it: the unit tests pin `interruptRun`'s exit codes, not the terminal's own
      `SIGINT` reaching the script.
- [ ] install the artifact on a machine that has never run UCAD, launch it, and complete one
      turn — the parts no gate here can reach (`node-pty`, signing, the asar reads).
- [ ] say in the release notes which adapter the packaged build resolved: no CI job covered it,
      so the note is the only record that the check happened.

## Adding a workspace package

`tsconfig.build.json` lists the package, **and** the package's own `tsconfig.json` must
declare a `references` entry for every `@ucad/*` dependency in its `package.json`. The
build graph is checked by `tests/contract/build-graph.test.ts`. Without the reference,
`tsc --build` may compile a package before its dependency exists — which fails only on a
clean build, never on an incremental one.

A package under `packages/` or `apps/` is covered by the source scans without being
named anywhere. Two shapes are not:

- a **top-level** workspace — a new directory beside `packages/`;
- a workspace **nested deeper** than the rule reaches — `apps/<name>/src` is a
  root, `apps/desktop/worker/src` is not, and neither is anything under it.

Either one has to be added to `EXTRA_SCAN_ROOTS` in
`tests/contract/zod-message-scan.ts`, or its schemas are never read by the
"no English custom message" scan. `tests/contract/zod-custom-messages.test.ts`
fails when the repository holds a source root the scan does not read, and names
it: the walk it uses looks for `src` directories at **any** depth, so a root
the rule misses cannot slip through unnoticed.

## Commit messages

Explain what was wrong and why the fix is that shape. A diff already shows what changed; the
message should carry the reasoning that is not in the diff.
