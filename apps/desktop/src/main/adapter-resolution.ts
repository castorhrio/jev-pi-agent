/**
 * Where the app looks for its adapters, and what it says when one is not there.
 *
 * ## Why this file exists
 *
 * It used to be a function inside `bootstrap.ts`, next to the Electron app
 * lifecycle, and that placement had one visible cost: the *search path list* —
 * the part that actually breaks between a development tree and a packaged app —
 * could only be checked by booting Electron and reading a log line afterwards.
 * A missing hop does not throw, it does not fail a build, and it does not fail
 * any test: it prints `adapter "<id>" could not be resolved` into a log
 * file nobody has open, and the app starts with no adapter at all. That is two
 * different layouts, four candidate directories, and no gate.
 *
 * So the two facts are separated from Electron:
 *
 *  - {@link adapterSearchPaths} turns "where am I running from" into the list
 *    of directories Node will be asked about, and
 *  - {@link resolveAdapterModules} walks the table, resolves each specifier
 *    against that list, and returns what it found **and** what it did not.
 *
 * Both are plain functions over strings. `tests/contract/adapter-resolution.test.ts`
 * drives them with a packaged-shaped context, a development-shaped context and
 * the real repository, so "the search paths cover both layouts" is an
 * assertion rather than a hope — and with a table entry that cannot resolve,
 * so "a missing adapter is reported, not swallowed" is asserted too.
 *
 * ## What must not drift
 *
 * ADR-017: no single adapter is required for the app to start. A candidate that
 * fails to resolve is therefore *reported* and skipped, never fatal. What is
 * fatal is silence — a silently absent adapter is indistinguishable from a
 * broken product, which is why the failure is written to the log with the
 * search paths **and** to stdout (the distinction "this vendor is not
 * installed" vs "the product is broken" has to survive a log file nobody
 * opened).
 *
 * Nothing here may import Electron: that is the whole point of the move, and
 * the contract gate asserts it on the source text.
 *
 * ## Where the packaged gate stops
 *
 * `tests/contract/adapter-resolution.test.ts` builds a throwaway package under
 * an asar-shaped `appPath` (`resources/app.asar/node_modules/…`) and resolves
 * it from `paths[0]`, with a control run that moves `appPath` away while the
 * development hops stay put. That pins the part that actually drifts: the app
 * root is a real search root, not a string the resolver carries and ignores.
 *
 * It does not open a real `.asar` archive. Node resolves a bare specifier by
 * treating the app path as a directory root — the behaviour the test exercises
 * — but reading modules from inside the archive needs Electron's patched `fs`,
 * which only a packaged launch provides.
 *
 * **No automated gate covers that last step.** There is no packaging job in
 * `.github/workflows/ci.yml`: the check is `npm run package`, launch the build,
 * read the `adapters resolved:` line it prints. The README states the same
 * boundary in both languages, and `tests/contract/readme-parity.test.ts` keeps
 * the two saying it — "verified by hand, CI does not cover it" is the claim, so
 * do not restate it as if a gate existed.
 */

import { createRequire } from 'node:module';
import * as path from 'node:path';
import { codedError, describeError } from '@ucad/contracts';
import type { Logger } from '@ucad/observability';
import { ADAPTER_CANDIDATES } from './adapter-candidates';

/**
 * The three facts about the running process that decide where adapters may be.
 *
 * Passed in rather than read here, so the same function can be asked about a
 * packaged app and a development tree from a Node test — with a `mainDir` that
 * is not this process's `__dirname`.
 */
export interface AdapterSearchContext {
  /** `app.getAppPath()`: the asar-appended app root once packaged. */
  appPath: string;
  /** `__dirname` of the compiled main entry — `apps/desktop/dist/main`. */
  mainDir: string;
  /** `process.cwd()`: whatever directory the app was launched from. */
  cwd: string;
}

/**
 * The directories Node is asked about, in the order they are asked.
 *
 * The order is deliberate and each entry covers a layout that really ships:
 *
 *  1. `appPath` — a packaged app. Electron resolves bare specifiers against
 *     the ASAR-appended app path, which is *not* the workspace root, so a bare
 *     `require.resolve` would only ever see what the packaged app contains.
 *  2. four hops up from `dist/main` — the workspace root, where `node_modules`
 *     holds the `@ucad/*` symlinks a development run needs.
 *  3. three hops up — the repository's `apps/` directory, for an app-local
 *     `node_modules` in a layout that does not hoist to the root.
 *  4. `cwd` — a process started from the repository root (`npm run dev`).
 *
 * `path.resolve` with segments rather than a `../../../..` string: the same
 * path, but a reader can count the hops, and the mapping is what the gate
 * asserts.
 *
 * The return type is a non-empty tuple, so "this list has at least one entry" is
 * a fact the compiler carries into `resolveAdapterModules` rather than something
 * that function has to hope for. Every layout above is therefore always asked,
 * including a packaged one.
 */
export function adapterSearchPaths(
  context: AdapterSearchContext,
): readonly [string, ...string[]] {
  return [
    context.appPath,
    path.resolve(context.mainDir, '..', '..', '..', '..'),
    path.resolve(context.mainDir, '..', '..', '..'),
    context.cwd,
  ];
}

/**
 * A candidate that was attempted and could not be resolved.
 *
 * Read through `AdapterResolution`, which is what `resolveAdapterModules`
 * returns; nothing outside builds one.
 */
interface AdapterFailure {
  /** the id from the table */
  id: string;
  /** the package name it pointed at */
  specifier: string;
  /** the resolver's message, for the log line and for a test */
  error: string;
}

export interface AdapterResolution {
  /** id → resolved absolute path, in the table's attempt order */
  modules: Record<string, string>;
  /** the candidates that were not found, in the table's order */
  failures: AdapterFailure[];
  /** the directories the resolver was given — part of the report */
  searchPaths: readonly string[];
}

export interface ResolveAdapterModulesOptions {
  /**
   * The directories to resolve against, from {@link adapterSearchPaths}.
   *
   * A non-empty tuple, not `string[]`: an empty list is not a weaker version of
   * this argument, it is an undefined one. Resolution anchors on
   * `searchPaths[0]` and hands the whole list to `require.resolve`, so `[]`
   * would silently anchor at `process.cwd()` and let Node fall back to its own
   * default paths — the resolution would then depend on the directory the app
   * happened to be launched from, which is the class of bug this module exists
   * to remove (see {@link nodeResolve}). The tuple stops a future caller at
   * compile time; the assertion at the top of {@link resolveAdapterModules}
   * stops one that arrived through `as any`.
   */
  searchPaths: readonly [string, ...string[]];
  /** the table; `ADAPTER_CANDIDATES` unless a test says otherwise */
  candidates?: Readonly<Record<string, string>>;
  /**
   * The resolver. Defaults to Node's `require.resolve` against `searchPaths`;
   * injected by tests so a failure path can be produced without inventing a
   * missing package.
   */
  resolve?: (specifier: string, searchPaths: readonly [string, ...string[]]) => string;
  /** where the per-failure warning and the summary line go */
  log?: Logger;
  /**
   * The diagnostic channel for both lines this module prints — one per
   * failure, and one summary. Defaults to `console.error`, which is where a
   * person who launched the app from a terminal is already looking; injected
   * by tests so a passing run is quiet.
   *
   * The logger and this channel are both written on purpose. They reach
   * different readers: the log file is opened *after* the app misbehaves, and
   * the terminal is where the launch itself is watched.
   */
  write?: (line: string) => void;
}

/**
 * Node's own resolution, anchored at the first search path.
 *
 * `createRequire` rather than a bare `require.resolve` so this module works
 * unchanged whether it is compiled to CommonJS (the desktop build) or
 * transformed to ESM (the test run). The anchor filename only sets the base
 * directory, and every call passes `paths` explicitly, so the anchor itself
 * never has to exist.
 *
 * The first path is read without a `?? process.cwd()` fallback: that fallback
 * was the one way an empty list could still "work", anchored wherever the
 * process was started, and it made the promise of this module — "the search
 * paths are the list you passed" — untrue exactly when the list was empty. The
 * tuple type and the assertion in {@link resolveAdapterModules} are what make
 * the fallback unnecessary.
 */
function nodeResolve(
  specifier: string,
  searchPaths: readonly [string, ...string[]],
): string {
  const anchor = path.join(searchPaths[0], 'adapter-resolution-probe.cjs');
  return createRequire(anchor).resolve(specifier, { paths: [...searchPaths] });
}

/**
 * Resolve every candidate in the table, and report the ones that failed.
 *
 * Returns what was found *and* what was missed, because the caller needs both:
 * the app starts either way (ADR-017), but "adapters resolved: (none)" is a
 * fact somebody has to be able to act on, and a function that only returns the
 * successes makes it invisible in the code as well as in the log.
 */
export function resolveAdapterModules(
  options: ResolveAdapterModulesOptions,
): AdapterResolution {
  const searchPaths = options.searchPaths;
  // The tuple in the options type already refuses this at compile time; this is
  // for the caller that got here through `as any` or through a spread. It
  // throws *before* the first resolve and before anything is written, because
  // an empty list is not a resolution that found nothing — it is a question
  // that was never asked, and reporting it as `(none)` would blame the adapters
  // for a broken caller.
  if (searchPaths.length === 0) {
    // Coded, not a bare `Error`: §4.11 makes a refusal name a reason, and the
    // gate in `tests/contract/error-formatting.test.ts` scans `main/*.ts` for
    // exactly this. `INVALID_INPUT` is the honest code — the *caller* passed a
    // list that cannot be resolved against, which is not an adapter being
    // unavailable and must not read like one in a support report.
    throw codedError(
      'INVALID_INPUT',
      'adapter resolution needs at least one search path',
      'container',
    );
  }

  const candidates = options.candidates ?? ADAPTER_CANDIDATES;
  const resolve = options.resolve ?? nodeResolve;
  const write = options.write ?? ((line: string) => console.error(line));

  const modules: Record<string, string> = {};
  const failures: AdapterFailure[] = [];

  for (const [id, specifier] of Object.entries(candidates)) {
    try {
      modules[id] = resolve(specifier, searchPaths);
    } catch (error) {
      // A missing adapter must not stop the app from starting (ADR-017), but it
      // MUST be visible: a silently absent adapter is indistinguishable from a
      // broken product.
      const message = `adapter "${id}" could not be resolved`;
      const failure: AdapterFailure = {
        id,
        specifier,
        error: describeError(error),
      };
      failures.push(failure);
      // Written to the diagnostic channel as well as the log: adapter
      // resolution failing is the difference between "the product is broken"
      // and "this vendor is not installed", and that distinction has to
      // survive a log file nobody opened.
      options.log?.warn(message, {
        specifier,
        searched: searchPaths,
        error: failure.error,
      });
      write(`[ucad] ${message} ${specifier}`);
    }
  }

  options.log?.info('adapters resolved', { resolved: Object.keys(modules) });
  // The same summary on the diagnostic channel, because the log file is not
  // where a person looks when the app starts with no adapter at all — and
  // `(none)` is the line that makes an empty adapter list visible instead of
  // an absent `adapters resolved:` line nobody notices.
  write(`[ucad] adapters resolved: ${Object.keys(modules).join(', ') || '(none)'}`);

  return { modules, failures, searchPaths };
}
