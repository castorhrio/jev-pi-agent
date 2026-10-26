/**
 * Adapter resolution: where the app looks, what it says when it fails.
 *
 * ## Why this file exists
 *
 * Resolution used to be a function inside `bootstrap.ts`, next to the Electron
 * lifecycle, and the consequence was measurable: the *search path list* — four
 * directories, two layouts — had no gate at all. A missing hop does not throw:
 * `require.resolve` fails per candidate, the failure is logged, and the app
 * starts with the remaining adapters (ADR-017: no single adapter is required).
 * So the only way to learn that a packaged build looked in the wrong place was
 * to install the build and read a log line — and a log line nobody reads is
 * indistinguishable from a working feature.
 *
 * The list now lives in `adapter-resolution.ts`, free of Electron, so these
 * cases can ask it the two questions that matter:
 *
 *  - **does the list cover both layouts that ship?** a packaged app (whose
 *    `node_modules` sits beside the asar) and a development tree (whose
 *    `@ucad/*` packages are symlinked into the workspace root), and
 *  - **is a candidate that cannot resolve reported, and skipped, rather than
 *    either fatal or silent?**
 *
 * The real repository is used for the success case, because "these two
 * specifiers resolve from these paths" is a fact about *this* tree: it fails if
 * an adapter package is renamed, if the workspace symlinks disappear, or if a
 * hop in the list is miscounted. `npm test` builds the packages first
 * (`pretest`), so `dist/index.js` — what `package.json#main` points at — is
 * there to be found.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { MemoryLogSink, Logger } from '@ucad/observability';
import { ADAPTER_CANDIDATES } from '../../apps/desktop/src/main/adapter-candidates';
import {
  MAIN_DIR_TO_APPS,
  MAIN_DIR_TO_WORKSPACE_ROOT,
  adapterSearchPaths,
  resolveAdapterModules,
  resolveFromProcess,
} from '../../apps/desktop/src/main/adapter-resolution';
import { readWorkflowFiles, workflowsPackageTheApp, type WorkflowFile } from './ci-shape';

const here = import.meta.dirname;
const REPO_ROOT = join(here, '..', '..');
const BOOTSTRAP_PATH = join(REPO_ROOT, 'apps', 'desktop', 'src', 'main', 'bootstrap.ts');

/** The real compiled main entry, as Electron would see it. */
const MAIN_DIR = join(REPO_ROOT, 'apps', 'desktop', 'dist', 'main');

/** A logger whose lines can be read back, so "it was reported" is assertable. */
function recordingLogger(): { log: Logger; sink: MemoryLogSink } {
  const sink = new MemoryLogSink();
  return { log: new Logger({ scope: 'adapters', sink }), sink };
}

/**
 * "The adapter resolved" only means something once the adapter is built.
 *
 * The success cases below resolve `@ucad/adapter-*` through `package.json#main`,
 * which points at `dist/index.js` — a file `npm test` produces in `pretest`. A
 * run that skips that step (vitest invoked directly, or a `clean` left behind by
 * the CI job's clean-build step) fails on the *assertion* instead, and the
 * message then reads like a resolution bug in `adapter-resolution.ts` while the
 * actual fix is one command. Checked here, before the interesting assertion, so
 * the failure names the command.
 */
function assertAdapterPackagesBuilt(): void {
  const missing = Object.keys(ADAPTER_CANDIDATES)
    .map((id) => join(REPO_ROOT, 'packages', `adapter-${id}`, 'dist', 'index.js'))
    .filter((dist) => !existsSync(dist));
  expect(
    missing,
    `these adapter builds are missing, so nothing can resolve them:\n  ${missing.join('\n  ')}\n` +
      'run `npm run build:packages` first (`npm test` does it in `pretest`).',
  ).toEqual([]);
}

describe('the search paths cover the layouts that ship', () => {
  it('asks the packaged app root, the workspace root, the desktop package and the cwd', () => {
    // A packaged-shaped context. `dist/main` is where the compiled entry lives
    // in both layouts, which is why the same hop count works for each.
    const paths = adapterSearchPaths({
      appPath: '/opt/UCAD/resources/app.asar',
      mainDir: '/opt/repo/apps/desktop/dist/main',
      cwd: '/opt/repo',
    });

    // Order matters: the packaged app root is asked first, because that is the
    // one directory that exists in a release and not in a clone.
    expect(paths[0]).toBe('/opt/UCAD/resources/app.asar');
    // Four hops up from `dist/main` is the workspace root — where the
    // `@ucad/*` symlinks live in development.
    expect(paths[1]).toBe(join('/opt/repo'));
    // Three hops up is `apps/`, for a layout whose `node_modules` is not
    // hoisted to the root.
    expect(paths[2]).toBe(join('/opt/repo', 'apps'));
    expect(paths[3]).toBe('/opt/repo');
  });

  it('keeps every entry absolute, so a resolve cannot depend on the cwd', () => {
    // A relative entry would be resolved against whatever directory the app
    // happened to start in — the same class of bug as the relative `../..` hop
    // this list replaced.
    const paths = adapterSearchPaths({
      appPath: '/opt/UCAD/resources/app.asar',
      mainDir: '/opt/repo/apps/desktop/dist/main',
      cwd: '/opt/repo',
    });
    for (const candidate of paths) {
      expect(candidate.startsWith(sep), `${candidate} is not absolute`).toBe(true);
    }
  });

  it('names the real workspace root when given the real main directory', () => {
    // The counting check, on this machine: if `dist/main` moved, or a hop was
    // added to the wrong entry, the development tree would resolve nothing and
    // this is where it shows up — with the path in the message.
    const paths = adapterSearchPaths({ appPath: REPO_ROOT, mainDir: MAIN_DIR, cwd: REPO_ROOT });

    expect(paths).toContain(REPO_ROOT);
    expect(existsSync(join(REPO_ROOT, 'node_modules', '@ucad'))).toBe(true);
  });

  it('pins the hop counts themselves, so a layout change cannot skip them', () => {
    // The path assertions above would notice a *wrong* current layout, but not
    // a layout change made together with a matching fixture edit: both would
    // agree on, say, five hops and the development tree would still resolve.
    // The counts are the third fact in the contract — constants, fixture and
    // doc comment — and this is the assertion that makes forgetting one red.
    expect(MAIN_DIR_TO_WORKSPACE_ROOT).toHaveLength(4);
    expect(MAIN_DIR_TO_APPS).toHaveLength(3);
    // Every segment is a parent hop; an absolute or named segment here would be
    // a different mapping wearing the same length.
    expect(MAIN_DIR_TO_WORKSPACE_ROOT.every((segment) => segment === '..')).toBe(true);
    expect(MAIN_DIR_TO_APPS.every((segment) => segment === '..')).toBe(true);
  });
});

/**
 * A bare package in a throwaway `node_modules`, and the directory it lives in.
 *
 * The specifier is scoped so it is split into `@scope` and `name` the same way
 * a real adapter package is. `main` is written explicitly: `require.resolve`
 * then returns the file, and the assertion can name it instead of accepting
 * "something inside the temp directory".
 */
function writeFakeAdapter(root: string, specifier: string): string {
  const packageDir = join(root, 'node_modules', ...specifier.split('/'));
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(
    join(packageDir, 'package.json'),
    JSON.stringify({ name: specifier, version: '0.0.0', main: 'index.js' }),
  );
  writeFileSync(join(packageDir, 'index.js'), 'module.exports = {};\n');
  return packageDir;
}

/**
 * `appPath` is the *first* search root, not decoration.
 *
 * In development every path in the list points into the same checkout, so an
 * assertion that a candidate resolved cannot tell which hop found it — and a
 * resolver that quietly ignored `appPath` and anchored on `cwd` would pass. A
 * packaged app is the layout where that matters: `app.getAppPath()` is the only
 * root that exists in a release, and the asar suffix is attached to it.
 *
 * The two cases below put a package only under an asar-shaped `appPath` and
 * then move `appPath` away while keeping the development hops unchanged. The
 * package resolves in the first case and is reported missing in the second, so
 * both directions are pinned without inventing a failure in a fixture.
 *
 * What this does **not** cover: opening a real `.asar` archive. Node's
 * `require.resolve` treats the app path as a directory root, and a directory
 * named `app.asar` exercises exactly that step; reading modules from inside
 * the archive needs Electron's patched `fs`, so it is checked by hand — a local
 * `npm run package` followed by `scripts/verify-packaged-adapters.mjs`, whose
 * judgement `verify-packaged-adapters.test.ts` covers; only the launch needs a
 * built app, and there is no CI job for it. `adapter-resolution.ts` and both
 * README sections say the same thing, and `readme-parity.test.ts` keeps the two
 * languages saying it.
 */
describe('the packaged app root is a search root in its own right', () => {
  const PACKAGED_ID = 'packaged';
  const PACKAGED_SPECIFIER = '@ucad/adapter-resolution-fixture';

  it('resolves a bare specifier from an asar-shaped `appPath`', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'ucad-adapter-apppath-'));
    try {
      // `resources/app.asar` is the shape of a packaged app root. Here it is a
      // plain directory — which is precisely the part of asar handling Node
      // itself provides: the path is treated as a directory that may contain
      // `node_modules`.
      const appPath = join(tempRoot, 'resources', 'app.asar');
      const packageDir = writeFakeAdapter(appPath, PACKAGED_SPECIFIER);

      const searchPaths = adapterSearchPaths({ appPath, mainDir: MAIN_DIR, cwd: REPO_ROOT });
      expect(searchPaths[0]).toBe(appPath);

      const resolution = resolveAdapterModules({
        candidates: { [PACKAGED_ID]: PACKAGED_SPECIFIER },
        searchPaths,
        write: () => undefined,
      });

      expect(resolution.failures).toEqual([]);
      // The file, not merely "a path": a resolver that looked somewhere else
      // and found a package with the same name would fail here.
      expect(resolution.modules[PACKAGED_ID]).toBe(join(packageDir, 'index.js'));
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('does not find the same package once `appPath` stops naming its root', () => {
    // The control for the case above. `mainDir` and `cwd` still point at the
    // real checkout, which is where a resolver that ignored `paths[0]` would
    // look; the package does not exist there, so success can only have come
    // from `appPath` in the previous test.
    const tempRoot = mkdtempSync(join(tmpdir(), 'ucad-adapter-apppath-'));
    try {
      const appPath = join(tempRoot, 'resources', 'app.asar');
      writeFakeAdapter(appPath, PACKAGED_SPECIFIER);
      const emptyAppPath = join(tempRoot, 'no-app-here');
      mkdirSync(emptyAppPath);

      const resolution = resolveAdapterModules({
        candidates: { [PACKAGED_ID]: PACKAGED_SPECIFIER },
        searchPaths: adapterSearchPaths({ appPath: emptyAppPath, mainDir: MAIN_DIR, cwd: REPO_ROOT }),
        write: () => undefined,
      });

      expect(resolution.modules).toEqual({});
      expect(resolution.failures.map((failure) => failure.id)).toEqual([PACKAGED_ID]);
      expect(resolution.searchPaths[0]).toBe(emptyAppPath);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

describe('resolution reports what it found and what it did not', () => {
  it('resolves every adapter in the table through the development search paths', () => {
    // Before "it resolved": the packages have to be built. Without this, CI
    // ordering (or a direct `vitest run`) reports a missing `dist` as a broken
    // search path, which is the opposite of what happened.
    assertAdapterPackagesBuilt();
    const { log } = recordingLogger();
    const written: string[] = [];

    const resolution = resolveAdapterModules({
      searchPaths: adapterSearchPaths({ appPath: REPO_ROOT, mainDir: MAIN_DIR, cwd: REPO_ROOT }),
      log,
      write: (line) => written.push(line),
    });

    // Both adapters, in the table's order — the same order `ADAPTER_LOAD_ORDER`
    // states and `bootstrap.ts` starts them in.
    expect(Object.keys(resolution.modules)).toEqual(Object.keys(ADAPTER_CANDIDATES));
    expect(resolution.failures).toEqual([]);
    // Resolved to the real package inside this workspace, not to something that
    // merely exists: a path outside `packages/` means the search found a
    // stranger with the same name.
    for (const [id, modulePath] of Object.entries(resolution.modules)) {
      expect(existsSync(modulePath), `${id} resolved to a path that does not exist`).toBe(true);
      expect(modulePath).toContain(join('packages', `adapter-${id}`));
    }
    // The one summary line, and no failure lines: a passing start is quiet.
    expect(written).toEqual([
      `[ucad] adapters resolved: ${Object.keys(ADAPTER_CANDIDATES).join(', ')}`,
    ]);
  });

  it('reports a candidate that cannot resolve, names its search paths, and keeps going', () => {
    // ADR-017: a missing adapter must not stop the app from starting. It must
    // also not stop the *next* adapter from being looked at — the loop used to
    // be a single `Object.entries` walk and still is, which is what this pins.
    const { log, sink } = recordingLogger();
    const written: string[] = [];

    const resolution = resolveAdapterModules({
      candidates: {
        universal: '@ucad/adapter-universal',
        missing: '@ucad/adapter-nobody-ships',
        mock: '@ucad/adapter-mock',
      },
      searchPaths: adapterSearchPaths({ appPath: REPO_ROOT, mainDir: MAIN_DIR, cwd: REPO_ROOT }),
      log,
      write: (line) => written.push(line),
    });

    expect(Object.keys(resolution.modules)).toEqual(['universal', 'mock']);
    expect(resolution.failures).toEqual([
      {
        id: 'missing',
        specifier: '@ucad/adapter-nobody-ships',
        error: expect.stringContaining('@ucad/adapter-nobody-ships'),
      },
    ]);

    const warning = sink.records.find((record) =>
      String(record.msg).includes('adapter "missing" could not be resolved'),
    );
    expect(warning, 'the failure was not logged').toBeDefined();
    expect(warning?.level).toBe('warn');
    // The specifier and the directories: without them the reader cannot tell
    // "this vendor is not installed" from "the build looks in the wrong place",
    // which is the whole reason the line exists.
    expect(warning?.meta?.['specifier']).toBe('@ucad/adapter-nobody-ships');
    expect(warning?.meta?.['searched']).toEqual(resolution.searchPaths);
    expect(String(warning?.meta?.['error']).length).toBeGreaterThan(0);

    // …and the same fact reaches the diagnostic channel, because the log file
    // is opened after the app misbehaves, not during the launch.
    expect(written).toEqual([
      '[ucad] adapter "missing" could not be resolved @ucad/adapter-nobody-ships',
      '[ucad] adapters resolved: universal, mock',
    ]);
  });

  it('says `(none)` rather than nothing when no adapter could be resolved', () => {
    // The state that must be loud: `adapters resolved:` with an empty list is a
    // line a reader skips, `adapters resolved: (none)` is a broken build.
    const written: string[] = [];
    const resolution = resolveAdapterModules({
      candidates: { ghost: '@ucad/adapter-ghost' },
      searchPaths: [REPO_ROOT],
      write: (line) => written.push(line),
    });

    expect(resolution.modules).toEqual({});
    expect(resolution.failures.map((failure) => failure.id)).toEqual(['ghost']);
    expect(written[written.length - 1]).toBe('[ucad] adapters resolved: (none)');
  });

  it('reports failures in the table order, not in whatever order they failed', () => {
    // `Object.entries` walks the table, so a failure list is a *table*-ordered
    // list: the first line of a bug report names the adapter the app tried
    // first. Nothing else pins that, and "the order they are tried" is stated in
    // `adapter-candidates.ts` as behaviour rather than presentation — the same
    // claim the resolved list is already checked against.
    const written: string[] = [];
    const resolution = resolveAdapterModules({
      candidates: {
        first: '@ucad/adapter-nobody-ships',
        second: '@ucad/adapter-nobody-either',
      },
      searchPaths: [REPO_ROOT],
      write: (line) => written.push(line),
    });

    expect(resolution.failures.map((failure) => failure.id)).toEqual(['first', 'second']);
    expect(resolution.failures.map((failure) => failure.specifier)).toEqual([
      '@ucad/adapter-nobody-ships',
      '@ucad/adapter-nobody-either',
    ]);
    expect(written).toEqual([
      '[ucad] adapter "first" could not be resolved @ucad/adapter-nobody-ships',
      '[ucad] adapter "second" could not be resolved @ucad/adapter-nobody-either',
      '[ucad] adapters resolved: (none)',
    ]);
  });

  it('refuses an empty search path list instead of resolving against the cwd', () => {
    // The one input the type forbids but a runtime can still receive: `[]`
    // used to anchor `nodeResolve` at `process.cwd()` and let Node fall back to
    // its own default paths, so "the directories in this list are the only ones
    // asked" quietly stopped being true — and the caller was told
    // `adapters resolved: (none)`, as if the adapters were at fault.
    const { log, sink } = recordingLogger();
    const written: string[] = [];

    let caught: unknown;
    try {
      resolveAdapterModules({
        // `as unknown as …`: reaching this call is exactly what the assertion
        // is for, and a test cannot reach it through the type.
        searchPaths: [] as unknown as readonly [string, ...string[]],
        candidates: { ghost: '@ucad/adapter-ghost' },
        log,
        write: (line) => written.push(line),
      });
    } catch (error) {
      caught = error;
    }

    expect(caught, 'the empty list was accepted').toBeInstanceOf(Error);
    // §4.11: a refusal names a code and a component. A bare `Error` here would
    // reach the log as `UNKNOWN`, which is indistinguishable from a crash — and
    // this is the one failure that must read as "the caller is broken", not
    // "an adapter is". The code/component pair is checked rather than the
    // message text, so a wording edit cannot silently drop the classification.
    expect((caught as { code?: unknown }).code).toBe('INVALID_INPUT');
    expect((caught as { component?: unknown }).component).toBe('container');

    // It fails before it resolves anything and before it says anything, on
    // either channel: a half-walked table reported as `(none)` would look like
    // a successful run that found no adapters, and a `warn` would blame the
    // adapter for the caller's list.
    expect(sink.records, 'the refusal was also written to the log').toEqual([]);
    expect(written, 'the refusal was also written to the console channel').toEqual([]);
  });

  it('treats a non-empty list that resolves nothing as a failed adapter, not a broken caller', () => {
    // The control for the case above. An empty list is a caller error; a list
    // that names no package is the ordinary "this vendor is not installed"
    // state, which must stay non-fatal and visible. Without this pairing, a
    // guard that rejected every list it could not resolve against would still
    // pass the test above.
    const { log, sink } = recordingLogger();
    const written: string[] = [];

    const resolution = resolveAdapterModules({
      candidates: { ghost: '@ucad/adapter-ghost' },
      searchPaths: ['/nonexistent'] as const,
      log,
      write: (line) => written.push(line),
    });

    expect(resolution.failures.map((failure) => failure.id)).toEqual(['ghost']);
    expect(sink.records.filter((record) => record.level === 'warn')).toHaveLength(1);
    expect(written).toEqual([
      '[ucad] adapter "ghost" could not be resolved @ucad/adapter-ghost',
      '[ucad] adapters resolved: (none)',
    ]);
  });

  it('defaults the diagnostic channel to console.error, not to the injected log', () => {
    // `bootstrap.ts` deliberately omits `write` (the source gate below keeps it
    // that way). This is what that omission buys: with no `write`, both the
    // per-failure line and the summary reach `console.error`, while the log
    // still receives the structured warning. Swapping the default to `log`
    // would leave an app that starts with no adapter silent at the terminal.
    const { log, sink } = recordingLogger();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    let written: string[] = [];
    try {
      const resolution = resolveAdapterModules({
        candidates: { ghost: '@ucad/adapter-ghost' },
        searchPaths: adapterSearchPaths({ appPath: REPO_ROOT, mainDir: MAIN_DIR, cwd: REPO_ROOT }),
        log,
        // no `write`: the production call shape from `bootstrap.ts`.
      });
      expect(resolution.failures.map((failure) => failure.id)).toEqual(['ghost']);
      written = consoleError.mock.calls.map((call) => String(call[0]));
    } finally {
      consoleError.mockRestore();
    }

    expect(written).toEqual([
      '[ucad] adapter "ghost" could not be resolved @ucad/adapter-ghost',
      '[ucad] adapters resolved: (none)',
    ]);
    // The log file is not the only outlet: the failure is also a `warn` record.
    expect(sink.records.filter((record) => record.level === 'warn')).toHaveLength(1);
  });

  it('uses Node resolution when no resolver is injected, and finds a real package', () => {
    // The default is the one production uses; a test that only ever injects a
    // fake resolver would pin the seam and not the app.
    assertAdapterPackagesBuilt();
    const resolution = resolveAdapterModules({
      candidates: { mock: ADAPTER_CANDIDATES.mock },
      searchPaths: adapterSearchPaths({ appPath: REPO_ROOT, mainDir: MAIN_DIR, cwd: REPO_ROOT }),
      write: () => undefined,
    });

    expect(resolution.failures).toEqual([]);
    expect(resolution.modules['mock']).toContain(join('packages', 'adapter-mock'));
  });
});

/**
 * `resolveFromProcess` is the composition, so it is checked as behaviour.
 *
 * ## Why the call site moved out of the source-text gate
 *
 * The seam this pins used to live inline in `bootstrap.ts`: three getters,
 * `adapterSearchPaths`, `resolveAdapterModules`. The only gate on it was a scan
 * of that file's *text*, and a text scan cannot tell `mainDir: __dirname` from
 * `mainDir: process.cwd()` sitting one line below a comment that still spells
 * the first one — the identifiers are all still in the file, and the drift is
 * invisible in development, where both point into the same checkout. The one
 * layout where it matters is a packaged build, which no test here can boot.
 *
 * As a function over strings the composition is observable: the cases below
 * hand it a packaged-shaped context and read back the directories that were
 * actually searched, and the resolution that came out of them.
 */
describe('resolveFromProcess turns the process facts into a resolution', () => {
  const ID = 'packaged';
  const SPECIFIER = '@ucad/adapter-resolution-fixture';

  it('searches exactly the paths adapterSearchPaths derives from the context', () => {
    const context = {
      appPath: '/opt/UCAD/resources/app.asar',
      mainDir: '/opt/repo/apps/desktop/dist/main',
      cwd: '/opt/repo',
    };
    const seen: { specifier: string; paths: readonly string[] }[] = [];

    const resolution = resolveFromProcess({
      ...context,
      candidates: { one: SPECIFIER },
      resolve: (specifier, searchPaths) => {
        seen.push({ specifier, paths: searchPaths });
        return '/resolved/index.js';
      },
      write: () => undefined,
    });

    // The list the resolver was handed is the list the mapping derives — not a
    // second, hand-built one. A caller that "fixed" a hop by passing its own
    // `searchPaths` cannot do that here: the option does not exist.
    expect(seen).toEqual([{ specifier: SPECIFIER, paths: adapterSearchPaths(context) }]);
    expect(resolution.searchPaths).toEqual(adapterSearchPaths(context));
    expect(resolution.modules).toEqual({ one: '/resolved/index.js' });
    expect(resolution.failures).toEqual([]);
  });

  it('treats the appPath it was given as the packaged root', () => {
    // The packaged layout, driven end to end through the composition: a package
    // under an asar-shaped `appPath` resolves with that `appPath`, and is
    // reported missing when it is moved — while `mainDir`/`cwd` still point at
    // the real checkout. A composition that dropped `appPath` (or filled it from
    // `cwd`) would stay green in development and fail here.
    const tempRoot = mkdtempSync(join(tmpdir(), 'ucad-adapter-from-process-'));
    try {
      const appPath = join(tempRoot, 'resources', 'app.asar');
      const packageDir = writeFakeAdapter(appPath, SPECIFIER);

      const found = resolveFromProcess({
        appPath,
        mainDir: MAIN_DIR,
        cwd: REPO_ROOT,
        candidates: { [ID]: SPECIFIER },
        write: () => undefined,
      });
      expect(found.failures).toEqual([]);
      expect(found.modules[ID]).toBe(join(packageDir, 'index.js'));

      const moved = resolveFromProcess({
        appPath: join(tempRoot, 'no-app-here'),
        mainDir: MAIN_DIR,
        cwd: REPO_ROOT,
        candidates: { [ID]: SPECIFIER },
        write: () => undefined,
      });
      expect(moved.failures.map((failure) => failure.id)).toEqual([ID]);
      // The report still names the root it used, so a support report says which
      // directory was looked in rather than "the adapter is missing".
      expect(moved.searchPaths[0]).toBe(join(tempRoot, 'no-app-here'));
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('passes log and write through, so neither channel is lost in the join', () => {
    // The two channels reach different readers (a log file opened afterwards, a
    // terminal watched during launch). A composition that accepted them and
    // dropped one would look correct here at the call site and be silent in the
    // one situation the lines exist for.
    const { log, sink } = recordingLogger();
    const written: string[] = [];

    const resolution = resolveFromProcess({
      appPath: REPO_ROOT,
      mainDir: MAIN_DIR,
      cwd: REPO_ROOT,
      candidates: { ghost: '@ucad/adapter-nobody-ships' },
      log,
      write: (line) => written.push(line),
    });

    expect(resolution.failures.map((failure) => failure.id)).toEqual(['ghost']);
    expect(sink.records.filter((record) => record.level === 'warn')).toHaveLength(1);
    expect(written).toEqual([
      '[ucad] adapter "ghost" could not be resolved @ucad/adapter-nobody-ships',
      '[ucad] adapters resolved: (none)',
    ]);
  });

  it('prints to console.error when the caller leaves `write` unset', () => {
    // The production call shape: `bootstrap.ts` passes the three facts and a
    // file-backed logger, and *nothing else*. Until now that omission was
    // checked by scanning bootstrap.ts for `write:` — text, which pins the
    // spelling and not the consequence. This is the consequence: with no
    // `write`, both lines still reach the terminal, which is the one channel
    // that survives an app that starts with no adapter at all (the log file is
    // opened after the app misbehaves, not during the launch).
    const { log, sink } = recordingLogger();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let failures: string[] = [];
    let written: string[] = [];
    try {
      const resolution = resolveFromProcess({
        appPath: REPO_ROOT,
        mainDir: MAIN_DIR,
        cwd: REPO_ROOT,
        candidates: { ghost: '@ucad/adapter-nobody-ships' },
        log,
        // no `write` — bootstrap.ts's shape, asserted below by the source gate.
      });
      failures = resolution.failures.map((failure) => failure.id);
      written = consoleError.mock.calls.map((call) => String(call[0]));
    } finally {
      consoleError.mockRestore();
    }

    expect(failures).toEqual(['ghost']);
    expect(written).toEqual([
      '[ucad] adapter "ghost" could not be resolved @ucad/adapter-nobody-ships',
      '[ucad] adapters resolved: (none)',
    ]);
    // The structured channel is still written as well: the two reach different
    // readers and one is not a substitute for the other.
    expect(sink.records.filter((record) => record.level === 'warn')).toHaveLength(1);
  });

  it('leaves console.error alone when the caller supplies its own channel', () => {
    // The control for the case above: a composition that always wrote to
    // `console.error` (ignoring `write`) would pass it, and would double-print
    // in a packaged app whose stdout is a terminal that is also being logged.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const written: string[] = [];
      resolveFromProcess({
        appPath: REPO_ROOT,
        mainDir: MAIN_DIR,
        cwd: REPO_ROOT,
        candidates: { ghost: '@ucad/adapter-nobody-ships' },
        write: (line) => written.push(line),
      });
      expect(written).toHaveLength(2);
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });
});

/**
 * `bootstrap.ts` supplies the three process facts — and deliberately no
 * `write` — and that is now all it does.
 *
 * ## Why this file still reads source text
 *
 * The composition itself is behaviour now (above), but the three *getters* are
 * still only answerable inside Electron: `app.getAppPath()`, `__dirname`,
 * `process.cwd()`. What is left to drift is exactly that mapping, so the
 * loader's body is read as text and its `resolveFromProcess(...)` arguments are
 * asserted verbatim — `mainDir: __dirname` is not satisfied by
 * `mainDir: process.cwd()`, and the loader may not build its own search paths
 * or call the resolver directly.
 *
 * The problems are produced by a pure function so the fixtures below can show
 * it answering something other than `[]` — a gate that has never gone red is
 * indistinguishable from one that does nothing.
 */

/**
 * The argument text of the first `callee(` call in `source`, with parentheses
 * matched.
 *
 * A regex cannot do this: the arguments are an object literal whose values
 * contain calls (`app.getAppPath()`), and a lazy `\)` would stop at the inner
 * call's closing paren.
 */
function callArguments(source: string, callee: string): string | undefined {
  const start = source.indexOf(`${callee}(`);
  if (start === -1) return undefined;
  const open = start + callee.length;
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, index);
    }
  }
  return undefined;
}

/**
 * The body of `function <name>(…) { … }`, with braces matched.
 *
 * Body-scoped on purpose: a check for "does not call `adapterSearchPaths`" run
 * against the whole file would read every other function in `bootstrap.ts`,
 * and a loader that lost its own call could still be reported green by one
 * added further down. The fixtures below contain no braces inside strings, so
 * brace counting without a tokenizer is enough; the real file's loader is the
 * same shape.
 */
function functionBody(source: string, name: string): string | undefined {
  const declaration = source.indexOf(`function ${name}(`);
  if (declaration === -1) return undefined;
  const open = source.indexOf('{', declaration);
  if (open === -1) return undefined;
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, index);
    }
  }
  return undefined;
}

/**
 * The three facts `resolveFromProcess` requires, spelled as the call passes
 * them.
 *
 * Exact text, not "mentions `getAppPath`": each of these is a *source* of the
 * running process, and the drift this catches is one source being swapped for
 * another (`__dirname` → `process.cwd()` in both slots looks fine to a
 * substring check on the field names).
 */
const REQUIRED_PROCESS_FACTS = [
  'appPath: app.getAppPath()',
  'mainDir: __dirname',
  'cwd: process.cwd()',
] as const;

/** Every way `loadAdapterModules` can stop naming the real sources, or start writing. */
function loaderCallProblems(source: string): string[] {
  const body = functionBody(source, 'loadAdapterModules');
  if (body === undefined) return ['bootstrap.ts no longer defines loadAdapterModules'];

  const problems: string[] = [];
  const args = callArguments(body, 'resolveFromProcess');
  if (args === undefined) {
    problems.push('loadAdapterModules no longer calls resolveFromProcess');
  } else {
    for (const expected of REQUIRED_PROCESS_FACTS) {
      if (!args.includes(expected)) {
        problems.push(`resolveFromProcess is no longer given \`${expected}\``);
      }
    }
    // The deliberate omission, made a gate. `write` unset means the resolver
    // prints to `console.error`, the one channel that survives an app which
    // starts with no adapter at all; passing it here (from `log`, most likely,
    // as a tidy-up) would leave the failure in a log file nobody opened.
    if (/[\s{,;]write\s*:/.test(args)) {
      problems.push(
        'loadAdapterModules passes `write`; leave it unset so the failure reaches console.error',
      );
    }
  }

  // The mapping and the resolution belong to `adapter-resolution.ts`. Doing
  // either here would put the drift back where no Node test can see it — and it
  // is the shape this loader had before the extraction.
  if (body.includes('adapterSearchPaths(')) {
    problems.push(
      'loadAdapterModules maps its own search paths; adapterSearchPaths is called inside resolveFromProcess',
    );
  }
  if (body.includes('resolveAdapterModules(')) {
    problems.push(
      'loadAdapterModules calls resolveAdapterModules directly; resolveFromProcess is the one composition point',
    );
  }

  return problems;
}

describe('bootstrap.ts names the real search roots and stays off the `write` channel', () => {
  it('reads a bootstrap it can actually parse, so the checks below are not vacuous', () => {
    expect(
      existsSync(BOOTSTRAP_PATH),
      `bootstrap.ts is missing (${BOOTSTRAP_PATH})`,
    ).toBe(true);
    const source = readFileSync(BOOTSTRAP_PATH, 'utf8');
    const body = functionBody(source, 'loadAdapterModules');
    expect(body, 'bootstrap.ts no longer defines loadAdapterModules').toBeDefined();
    // The parser is the gate's eyes: a call it cannot find would be reported as
    // "no longer calls resolveFromProcess", which sends the editor to a call
    // that is right there.
    expect(callArguments(body ?? '', 'resolveFromProcess')).toBeDefined();
  });

  it('passes app.getAppPath(), __dirname and process.cwd(), and no write', () => {
    const source = readFileSync(BOOTSTRAP_PATH, 'utf8');
    const problems = loaderCallProblems(source);
    expect(
      problems,
      `bootstrap.ts and adapter-resolution.ts disagree about the call:\n  ${problems.join('\n  ')}`,
    ).toEqual([]);
  });

  it('reports a unified logging outlet that hands the resolver a `write`', () => {
    // The edit this exists for: "one logging outlet" is a reasonable-sounding
    // refactor that removes the only channel a person at a terminal sees.
    const withWrite = [
      'function loadAdapterModules(log?: Logger): Record<string, string> {',
      '  return resolveFromProcess({',
      '    appPath: app.getAppPath(),',
      '    mainDir: __dirname,',
      '    cwd: process.cwd(),',
      '    log,',
      '    write: (line) => log?.error(line),',
      '  }).modules;',
      '}',
    ].join('\n');
    expect(loaderCallProblems(withWrite)).toEqual([
      'loadAdapterModules passes `write`; leave it unset so the failure reaches console.error',
    ]);
  });

  it('reports a process fact that stopped naming the running process', () => {
    // `cwd` standing in for `__dirname` resolves in development (both point
    // into the checkout when the app is launched from its root) and looks
    // wrong only in a packaged build — the drift is invisible without this.
    const swapped = [
      'function loadAdapterModules(log?: Logger): Record<string, string> {',
      '  return resolveFromProcess({',
      '    appPath: app.getAppPath(),',
      '    mainDir: process.cwd(),',
      '    cwd: process.cwd(),',
      '    log,',
      '  }).modules;',
      '}',
    ].join('\n');
    expect(loaderCallProblems(swapped)).toEqual([
      'resolveFromProcess is no longer given `mainDir: __dirname`',
    ]);
  });

  it('reports a loader that took the mapping or the resolution back', () => {
    // The pre-extraction shape, which is what a "simplify the indirection"
    // edit would restore: correct-looking in development, and once again
    // checkable only by packaging the app.
    const inlined = [
      'function loadAdapterModules(log?: Logger): Record<string, string> {',
      '  return resolveAdapterModules({',
      '    searchPaths: adapterSearchPaths({',
      '      appPath: app.getAppPath(),',
      '      mainDir: __dirname,',
      '      cwd: process.cwd(),',
      '    }),',
      '    log,',
      '  }).modules;',
      '}',
    ].join('\n');
    expect(loaderCallProblems(inlined)).toEqual([
      'loadAdapterModules no longer calls resolveFromProcess',
      'loadAdapterModules maps its own search paths; adapterSearchPaths is called inside resolveFromProcess',
      'loadAdapterModules calls resolveAdapterModules directly; resolveFromProcess is the one composition point',
    ]);
  });

  it('reports a renamed or removed loader instead of passing over it', () => {
    // A gate whose subject disappeared must be red: `indexOf` returning -1
    // would otherwise make every check above vacuously true.
    expect(loaderCallProblems('function loadAdapters() {}\n')).toEqual([
      'bootstrap.ts no longer defines loadAdapterModules',
    ]);
  });
});

/**
 * The "CI does not cover it" claim is checked against `ci.yml`.
 *
 * The README bullet and the header of `adapter-resolution.ts` both state that
 * the packaged check is manual. A statement about CI that nothing compares with
 * CI is exactly the kind of sentence that rots: the previous wording said the
 * step was "covered by the packaged smoke run" while `.github/workflows/ci.yml`
 * had no packaging job at all — a promise of a gate that did not exist, which is
 * worse than naming the gap.
 *
 * So the two directions are both red:
 *
 *  - the prose says CI does not cover it, and CI has since gained a packaging
 *    job → the README now understates what is checked; and
 *  - CI has no such job and the prose does not say so → the README is back to
 *    implying coverage it does not have.
 *
 * A workflow that *does* package makes the claim merely unnecessary rather than
 * false, so it stays green — the check is about the sentence and the file
 * agreeing, not about how the packaging is done.
 */

/**
 * "CI does not cover it", as the README bullet states it.
 *
 * "Does CI package the app" is answered by `workflowsPackageTheApp` in
 * `ci-shape.ts`, which names all three commands that build an artifact. This
 * file used to answer it with a narrower private regex, so a `npm run dist`
 * step would have passed here while the README went on saying CI does not cover
 * the packaged check. `ci-shape.test.ts` pins the shared vocabulary against the
 * real workflows.
 *
 * It takes the *set* of workflow files, not one file's text — the shared
 * reader was widened because the claim is about CI, and CI is everything under
 * `.github/workflows/`. A `release.yml` with an `electron-builder` step is the
 * same defect as one in `ci.yml`: the sentence stops being true, and the gates
 * here are what make that a red test rather than a stale paragraph.
 */
const CI_NOT_COVERED = /\bci does not cover\b/iu;

/** A workflow set as `readWorkflowFiles` returns it, for the fixtures below. */
function workflowFiles(name: string, text: string): WorkflowFile[] {
  return [{ name, text }];
}

function ciClaimProblems(input: {
  readonly bullet: string | undefined;
  readonly workflows: readonly WorkflowFile[];
}): string[] {
  if (input.bullet === undefined) {
    return ['the asar limitation bullet is missing, so its CI claim is unchecked'];
  }
  const claimsManual = CI_NOT_COVERED.test(input.bullet);
  const ciPackages = workflowsPackageTheApp(input.workflows);
  if (claimsManual && ciPackages) {
    return [
      'the README says CI does not cover the packaged asar check, but a workflow under .github/workflows/ runs one; ' +
        'update the bullet, adapter-resolution.ts and readme-parity.test.ts to say what CI checks',
    ];
  }
  if (!claimsManual && !ciPackages) {
    return [
      'no CI job packages the app, and the README does not say the asar check is manual; ' +
        'state the gap instead of implying a gate',
    ];
  }
  return [];
}

describe('the README’s asar/CI claim matches what CI actually does', () => {
  const WORKFLOWS_DIR = join(REPO_ROOT, '.github', 'workflows');
  const readme = existsSync(join(REPO_ROOT, 'README.md'))
    ? readFileSync(join(REPO_ROOT, 'README.md'), 'utf8')
    : '';

  /** The English "Current limitations" bullets, joined, or `undefined`. */
  function enLimitationBullets(markdown: string): string[] | undefined {
    const lines = markdown.split('\n');
    const start = lines.findIndex((line) => line.trim() === '### Current limitations');
    if (start === -1) return undefined;
    const end = lines.findIndex((line, index) => index > start && /^#{1,3} /.test(line));
    const body = lines.slice(start + 1, end === -1 ? undefined : end);
    const out: string[] = [];
    for (const line of body) {
      if (/^- /.test(line)) out.push(line.slice(2).trim());
      else if (out.length > 0 && /^\s+\S/.test(line)) out[out.length - 1] += ' ' + line.trim();
    }
    return out;
  }

  it('reads both the workflows and the bullet, so the check is not vacuous', () => {
    expect(existsSync(WORKFLOWS_DIR), `the workflows directory is missing (${WORKFLOWS_DIR})`).toBe(
      true,
    );
    expect(
      readWorkflowFiles(WORKFLOWS_DIR).length,
      `no workflow was read from ${WORKFLOWS_DIR}`,
    ).toBeGreaterThan(0);
    const bullets = enLimitationBullets(readme);
    expect(bullets, 'the README no longer has a "### Current limitations" section').toBeDefined();
    // The bullet this reads has to be the asar one: reading another limitation
    // would report "the claim is missing" about a sentence that never made it.
    const asarBullet = bullets!.find((bullet) => bullet.toLowerCase().includes('asar'));
    expect(asarBullet, 'no limitation bullet talks about asar').toBeDefined();
  });

  it('does not promise a CI gate CI does not have, and does not understate one it does', () => {
    const bullet = enLimitationBullets(readme)?.find((text) =>
      text.toLowerCase().includes('asar'),
    );
    const problems = ciClaimProblems({
      bullet,
      workflows: readWorkflowFiles(WORKFLOWS_DIR),
    });
    expect(problems, problems.join('\n')).toEqual([]);
  });

  it('reports each direction of the disagreement', () => {
    // The historical defect: the prose says the step is covered by a packaged
    // run, and the workflow has no such job.
    expect(
      ciClaimProblems({
        bullet: '**Adapter resolution inside a real `.asar` archive is verified by the packaged smoke run.**',
        workflows: workflowFiles('ci.yml', 'jobs:\n  gates:\n    steps:\n      - run: npm test\n'),
      }),
    ).toEqual([
      'no CI job packages the app, and the README does not say the asar check is manual; ' +
        'state the gap instead of implying a gate',
    ]);
    // …and the other direction: a packaging job appeared and the README still
    // tells the reader nothing checks it.
    expect(
      ciClaimProblems({
        bullet: '**Adapter resolution inside a real `.asar` archive is verified by hand; CI does not cover it.**',
        workflows: workflowFiles('ci.yml', 'steps:\n  - run: npm run package\n'),
      }),
    ).toHaveLength(1);
    // …including when the packaging step is in a *different* file. This is the
    // blind spot the shared reader was widened for: `ci.yml` still runs only
    // the gates, so a reader that took one file's text would report agreement
    // while CI packages the app.
    expect(
      ciClaimProblems({
        bullet:
          '**Adapter resolution inside a real `.asar` archive is verified by hand; CI does not cover it.**',
        workflows: [
          ...workflowFiles('ci.yml', 'steps:\n  - run: npm test\n'),
          ...workflowFiles('release.yml', 'steps:\n  - run: npx electron-builder --dir\n'),
        ],
      }),
    ).toHaveLength(1);
    // Either claim is fine beside a workflow that really packages.
    expect(
      ciClaimProblems({
        bullet: '**Adapter resolution inside a real `.asar` archive is verified from the packaged build.**',
        workflows: workflowFiles('ci.yml', 'steps:\n  - run: npm run package\n'),
      }),
    ).toEqual([]);
    // A missing bullet is reported rather than treated as agreement.
    expect(ciClaimProblems({ bullet: undefined, workflows: [] })).toEqual([
      'the asar limitation bullet is missing, so its CI claim is unchecked',
    ]);
  });
});
