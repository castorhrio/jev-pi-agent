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
import { existsSync } from 'node:fs';
import { join, sep } from 'node:path';
import { MemoryLogSink, Logger } from '@ucad/observability';
import { ADAPTER_CANDIDATES } from '../../apps/desktop/src/main/adapter-candidates';
import {
  adapterSearchPaths,
  resolveAdapterModules,
} from '../../apps/desktop/src/main/adapter-resolution';

const here = import.meta.dirname;
const REPO_ROOT = join(here, '..', '..');

/** The real compiled main entry, as Electron would see it. */
const MAIN_DIR = join(REPO_ROOT, 'apps', 'desktop', 'dist', 'main');

/** A logger whose lines can be read back, so "it was reported" is assertable. */
function recordingLogger(): { log: Logger; sink: MemoryLogSink } {
  const sink = new MemoryLogSink();
  return { log: new Logger({ scope: 'adapters', sink }), sink };
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
});

describe('resolution reports what it found and what it did not', () => {
  it('resolves every adapter in the table through the development search paths', () => {
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
    // `write` is left at its default (`console.error`) on purpose: the channel
    // the person at a terminal watches is the one that must stay quiet, and
    // injecting a `write` here would test the injection instead of the default.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    let caught: unknown;
    try {
      resolveAdapterModules({
        // `as unknown as …`: reaching this call is exactly what the assertion
        // is for, and a test cannot reach it through the type.
        searchPaths: [] as unknown as readonly [string, ...string[]],
        candidates: { ghost: '@ucad/adapter-ghost' },
        log,
      });
    } catch (error) {
      caught = error;
    } finally {
      consoleError.mockRestore();
    }

    expect(caught, 'the empty list was accepted').toBeInstanceOf(Error);
    // §4.11: a refusal names a code. A bare `Error` here would reach the log as
    // `UNKNOWN`, which is indistinguishable from a crash — and this is the one
    // failure that must read as "the caller is broken", not "an adapter is".
    expect((caught as { code?: unknown }).code).toBe('INVALID_INPUT');
    expect((caught as Error).message).toMatch(/at least one search path/u);

    // It fails before it resolves anything and before it says anything: a
    // half-walked table reported as `(none)` would look like a successful run
    // that found no adapters.
    expect(consoleError).not.toHaveBeenCalled();
    expect(sink.records).toEqual([]);
  });

  it('uses Node resolution when no resolver is injected, and finds a real package', () => {
    // The default is the one production uses; a test that only ever injects a
    // fake resolver would pin the seam and not the app.
    const resolution = resolveAdapterModules({
      candidates: { mock: ADAPTER_CANDIDATES.mock },
      searchPaths: adapterSearchPaths({ appPath: REPO_ROOT, mainDir: MAIN_DIR, cwd: REPO_ROOT }),
      write: () => undefined,
    });

    expect(resolution.failures).toEqual([]);
    expect(resolution.modules['mock']).toContain(join('packages', 'adapter-mock'));
  });
});
