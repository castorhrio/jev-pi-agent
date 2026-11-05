/**
 * Where the app looks for its adapters, and what it says when one is not there.
 *
 * This used to be a function inside `bootstrap.ts`, where the search path list —
 * the part that actually breaks between a development tree and a packaged app —
 * could only be checked by booting Electron and reading a log line. A missing hop
 * does not throw and does not fail a build: it prints `adapter "<id>" could not
 * be resolved` into a log file nobody has open, and the app starts with no
 * adapter at all.
 *
 * So the mapping is a pure function over strings:
 *
 *  - {@link adapterSearchPaths} turns "where am I running from" into the list of
 *    directories Node will be asked about,
 *  - {@link resolveAdapterModules} walks the table, resolves each specifier
 *    against that list, and returns what it found **and** what it did not,
 *  - {@link resolveFromProcess} joins the two: it takes the three facts about the
 *    running process, derives the list, resolves, and hands back the report.
 *
 * ADR-017: no single adapter is required for the app to start, so a candidate
 * that fails to resolve is reported and skipped, never fatal. What is fatal is
 * silence, which is why the failure goes to the log with the search paths **and**
 * to stdout. Nothing here may import Electron — that is the whole point of the
 * move, and the contract gate asserts it on the source text.
 *
 * `tests/contract/adapter-resolution.test.ts` drives all three with a
 * packaged-shaped context, a development-shaped context and the real repository,
 * including the case that lands the upward hops inside the asar. It does not open
 * a real `.asar` archive: reading modules from inside one needs Electron's
 * patched `fs`, so that last step is
 * `npm run package` followed by `node scripts/verify-packaged-adapters.mjs`.
 * **No automated gate covers that launch** — `tests/contract/ci-shape.test.ts`
 * turns red if a workflow grows a packaging step — and both README languages say
 * so; do not restate it as if a gate existed.
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
 * The two upward hops from the compiled `dist/main` directory, as segments.
 *
 * A hop too many or too few does not throw: it resolves nothing in development
 * and only shows up in a packaged build. **If the directory layout changes,
 * three things change together:** these constants, the path and `length`
 * assertions in `tests/contract/adapter-resolution.test.ts`, and the numbered
 * list in {@link adapterSearchPaths}'s doc comment.
 */
export const MAIN_DIR_TO_WORKSPACE_ROOT = ['..', '..', '..', '..'] as const;
export const MAIN_DIR_TO_APPS = ['..', '..', '..'] as const;

/**
 * The directories Node is asked about, in the order they are asked. Each entry
 * covers a layout that really ships:
 *
 *  1. `appPath` — a packaged app. Electron resolves bare specifiers against the
 *     ASAR-appended app path, which is not the workspace root.
 *  2. four hops up from `dist/main` ({@link MAIN_DIR_TO_WORKSPACE_ROOT}) — the
 *     workspace root, where `node_modules` holds the `@ucad/*` symlinks a
 *     development run needs.
 *  3. three hops up ({@link MAIN_DIR_TO_APPS}) — the repository's `apps/`
 *     directory, for an app-local `node_modules` in a layout that does not hoist
 *     to the root.
 *  4. `cwd` — a process started from the repository root (`npm run dev`).
 *
 * The return type is a non-empty tuple, so "this list has at least one entry" is
 * a fact the compiler carries into `resolveAdapterModules`.
 */
export function adapterSearchPaths(
  context: AdapterSearchContext,
): readonly [string, ...string[]] {
  return [
    context.appPath,
    path.resolve(context.mainDir, ...MAIN_DIR_TO_WORKSPACE_ROOT),
    path.resolve(context.mainDir, ...MAIN_DIR_TO_APPS),
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
   * A non-empty tuple, not `string[]`: resolution anchors on `searchPaths[0]`, so
   * `[]` would silently anchor at `process.cwd()` and let Node fall back to its
   * own default paths. The tuple stops a caller at compile time; the assertion at
   * the top of {@link resolveAdapterModules} stops one that arrived through
   * `as any`.
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
   * The diagnostic channel for both lines this module prints — one per failure,
   * and one summary. Defaults to `console.error`, which is where a person who
   * launched the app from a terminal is already looking; injected by tests so a
   * passing run is quiet. The logger and this channel are both written on
   * purpose: the log file is opened after the app misbehaves, the terminal is
   * where the launch itself is watched.
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
  // for the caller that got here through `as any` or a spread. It throws before
  // the first resolve, because an empty list is not a resolution that found
  // nothing — reporting it as `(none)` would blame the adapters for a broken
  // caller. Coded, not a bare `Error`: §4.11 makes a refusal name a reason, and
  // `tests/contract/error-formatting.test.ts` scans `main/*.ts` for it.
  if (searchPaths.length === 0) {
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
      // Written to the diagnostic channel as well as the log: this failure is
      // the difference between "the product is broken" and "this vendor is not
      // installed", and that distinction has to survive a log nobody opened.
      options.log?.warn(message, {
        specifier,
        searched: searchPaths,
        error: failure.error,
      });
      write(`[ucad] ${message} ${specifier}`);
    }
  }

  options.log?.info('adapters resolved', { resolved: Object.keys(modules) });
  // The same summary on the diagnostic channel: `(none)` is the line that makes
  // an empty adapter list visible instead of an absent `adapters resolved:` line
  // nobody notices.
  write(`[ucad] adapters resolved: ${Object.keys(modules).join(', ') || '(none)'}`);

  return { modules, failures, searchPaths };
}

/**
 * Everything `resolveFromProcess` needs: the process facts, plus the seams
 * {@link resolveAdapterModules} already accepts.
 *
 * `searchPaths` is deliberately absent. The whole point of this function is that
 * the mapping from "where am I running from" to "which directories Node is
 * asked about" happens once, here — a caller that could pass its own list would
 * be free to reproduce the miscounted hop outside the gate.
 */
export interface ResolveFromProcessOptions extends AdapterSearchContext {
  /** the table; `ADAPTER_CANDIDATES` unless a test says otherwise */
  candidates?: Readonly<Record<string, string>>;
  /** the resolver, for a test that needs a failure without a missing package */
  resolve?: (specifier: string, searchPaths: readonly [string, ...string[]]) => string;
  /** where the structured per-failure warning and the summary record go */
  log?: Logger;
  /**
   * The diagnostic channel, passed straight through. Left unset by
   * `bootstrap.ts` on purpose, so the resolver's own default — `console.error` —
   * is what a person at a terminal sees. See {@link ResolveAdapterModulesOptions.write}.
   */
  write?: (line: string) => void;
}

/**
 * Resolve the adapters for a process described by its three facts.
 *
 * This is the composition `bootstrap.ts` used to perform inline. As a call site
 * the mapping could only be inspected as text, so a caller that swapped one
 * source for another (`mainDir: process.cwd()`) kept the identifiers the source
 * gate looked for and nothing went red. As a function over strings the arguments
 * are observable: the contract test passes a packaged-shaped context and reads
 * back the directories that were actually searched.
 *
 * The report is returned whole (`modules`, `failures`, `searchPaths`), so a
 * caller that wants to say something about the misses does not have to resolve
 * twice to find out what they were.
 */
export function resolveFromProcess(options: ResolveFromProcessOptions): AdapterResolution {
  return resolveAdapterModules({
    searchPaths: adapterSearchPaths({
      appPath: options.appPath,
      mainDir: options.mainDir,
      cwd: options.cwd,
    }),
    ...(options.candidates ? { candidates: options.candidates } : {}),
    ...(options.resolve ? { resolve: options.resolve } : {}),
    ...(options.log ? { log: options.log } : {}),
    ...(options.write ? { write: options.write } : {}),
  });
}
