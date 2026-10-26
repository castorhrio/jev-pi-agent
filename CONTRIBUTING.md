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
| Container | Every subsystem the container promises (`field!: T`) is on a checklist and is really there after `start()`: a step that forgets to assign one is a failing test, and a dependency that skips the start-up guard does not compile |
| Build graph | Every `@ucad/*` dependency is a project reference, and the solution lists each package once |
| Copy and a11y | No hard-coded UI strings, locale parity, contrast, focus indicators |
| Menu | Every command Main registers has a renderer handler |
| Versions | Shipped manifests pin exact versions; the installed engine matches what is declared |

**Interface** — `tests/e2e`, run by `npm run test:e2e`: the real `App` in a DOM
against the real fixture bridge, covering the conversation, navigation, the
permission dialog, handoff history, provider selection and every surface's crash
boundary.

**Layout** — `tests/contract/layout.test.ts` measures geometry in a real
Chromium window rather than a DOM approximation. It walks every surface at seven
widths plus the tightest window, and asserts that nothing overflows, collapses,
overlaps, falls outside its scroll container, or gets cut off. It also runs axe
at two layouts and writes screenshots to `.run-logs/layout/`.

```bash
npm run typecheck && npm run lint && npm run knip && npm test && npm run test:e2e
```

`npm test` builds the packages first on purpose — the unit suite resolves
`@ucad/*` to `packages/*/dist`, not `src`. Running vitest directly bypasses that,
which is the same trap that once let a red-proof run come back green.

CI runs exactly this sequence, plus a clean rebuild at the end: an incremental
build cannot catch a wrong build order, because a stale `dist` satisfies any
import.

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

**Prefer a mechanism to a reminder.** A rule in a document is skipped. A check in the suite
is not. If a mistake has been made twice, the answer is a gate, not a better note.

**Do not state a number that can rot.** Prose counts go stale silently; link to the gate
instead.

**Do not widen the scope.** Unrelated cleanup in a change is how a review turns into an
archaeology dig. File it separately.

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
  (13/11.5/10.5px) as `.fs-note` / `.fs-fine`. Inline `marginTop`, `marginBottom`,
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
