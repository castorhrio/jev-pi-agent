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

**Running the gates on Linux.** The layout gate launches a real Electron. On a
rootless Linux box (CI runners, most containers) there is no setuid
`chrome-sandbox` and Chromium aborts at startup rather than run without one —
the probe then produces no result at all. CI sets `ELECTRON_DISABLE_SANDBOX=1`
for the unit step for exactly this reason; a local Linux run needs the same
env var in front of `npm test`. The gate measures geometry, not the sandbox.

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

## Commit messages

Explain what was wrong and why the fix is that shape. A diff already shows what changed; the
message should carry the reasoning that is not in the diff.
