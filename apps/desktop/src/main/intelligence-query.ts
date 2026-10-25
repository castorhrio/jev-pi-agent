/**
 * §4.8 — one code-intelligence query, from the bridge down to the provider.
 *
 * ## Why this file exists
 *
 * The bridge used to answer `intelligence.query` like this:
 *
 * ```ts
 * const result = await ucad.intelligence.query({ kind, providerId: 'basic', input });
 * return { operationId: result.providerId, result };
 * ```
 *
 * Three things were wrong with it, and all three were invisible from the
 * interface:
 *
 *  1. **`operationId` was the provider id.** The provider is called `basic`,
 *     so every query was reported as operation `basic` — and `cancel('basic')`
 *     never found anything, because no operation was registered under that
 *     name. The cancel button existed for `index` / `refresh` and did nothing
 *     for a query.
 *  2. **The provider was hard-coded.** The panel has a provider picker; the
 *     query ignored it and always asked `basic`. Picking another provider
 *     changed the table below and nothing else.
 *  3. **The id only appeared after the answer.** Even with a real id, a
 *     caller that waits for the result cannot cancel a query that is taking
 *     its time — the name of the operation arrives too late to use.
 *
 * So the id is allocated by the *caller* and travels with the request: the
 * panel knows the operation's name before it knows the answer, and can stop
 * it.
 *
 * ## Why it is a separate file
 *
 * `ipc.ts` imports Electron (`ipcMain`), so it cannot be exercised by a Node
 * test. This module takes its collaborators as parameters and imports nothing
 * from Electron, which lets "the query carries the id the caller can cancel,
 * and the provider the caller asked for" be tested against the real
 * `IntelligenceManager`.
 */

import { z } from 'zod';
import { codedError, type IntelligenceQueryKind } from '@ucad/contracts';

/** The query kinds the bridge accepts. */
const QUERY_KINDS = [
  'search',
  'locate',
  'overview',
  'callers',
  'callees',
  'trace',
  'impact',
] as const satisfies ReadonlyArray<IntelligenceQueryKind>;

const queryInputSchema = z.object({
  workspaceId: z.string().min(1),
  kind: z.enum(QUERY_KINDS),
  /**
   * The payload is an object, always.
   *
   * It used to be `z.unknown()`, so a bare string or an array was accepted
   * and passed straight through — which meant the provider never saw the
   * workspace id, could not resolve the project root, and answered with an
   * empty result. An empty result is indistinguishable from "there is
   * nothing to find", so the query looked like it ran and found nothing.
   *
   * Every provider input is an object (`{ query }`, `{ symbol }`,
   * `{ target }`) and every one of them needs the workspace id beside it. A
   * non-object payload has no meaning to any of them, so it is refused at
   * the boundary rather than handed on as a query that cannot work.
   */
  input: z.record(z.string(), z.unknown()).default({}),
  providerId: z.string().min(1).max(64).optional(),
  operationId: z.string().min(1).max(128).optional(),
});

/** The outcome shape the manager returns, narrowed to what the bridge reads. */
interface IntelligenceQueryResult {
  operationId: string;
  status: 'ok' | 'cancelled' | 'error' | 'unsupported';
  result: unknown;
  providerId: string;
  reason?: string;
  durationMs?: number;
  freshness?: unknown;
}

/** The collaborators a query needs. */
export interface IntelligenceQueryDeps {
  intelligence: {
    query(input: {
      kind: IntelligenceQueryKind;
      providerId: string;
      input: unknown;
      operationId?: string;
    }): Promise<IntelligenceQueryResult>;
  };
  /** the provider the app is configured to use; `basic` when unset */
  defaultProviderId?: string;
}

/** What the bridge resolves with. */
export interface IntelligenceQueryEnvelope {
  /** the id `cancel()` can reach */
  operationId: string;
  /** the provider that actually answered */
  providerId: string;
  /** the manager's outcome */
  result: IntelligenceQueryResult;
}

/**
 * Merges the caller's payload into the provider input.
 *
 * The provider needs the workspace id next to whatever the panel asked for,
 * and the *request's* workspace id is the authoritative one: the panel names
 * the project it is looking at, and a payload carrying a different id would
 * redirect the query at another project — or at a project that was never
 * initialised, which answers "no results" for a reason nobody can see.
 *
 * A conflicting id is therefore rejected, not silently replaced. Silently
 * replacing it made the mismatch unobservable: the provider answered for the
 * *request's* project while the caller believed it had asked for the payload's
 * one, and nothing in the result said which project it described.
 */
function mergeInput(
  workspaceId: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const claimed = payload['workspaceId'];
  // The request decides which project is queried, and a payload claiming a
  // different one is refused rather than overwritten. Overwriting was the old
  // behaviour: the query ran against a project the caller did not name and the
  // caller was never told, so the answer could describe another project's code
  // while looking like the right one. Fail closed (§4.8, NFR-14): a conflict
  // is a caller bug, and the safe answer is "no query ran", not "here are
  // some results".
  if (claimed !== undefined && claimed !== workspaceId) {
    throw codedError(
      'INVALID_INPUT',
      '查询载荷中的项目与请求不一致：一次查询只能针对一个项目，请重新发起查询。',
      'ipc',
    );
  }
  return { ...payload, workspaceId };
}

/**
 * Runs one query and reports it honestly.
 *
 * The returned `operationId` is the operation's real identity: the same id
 * `cancel()` can reach while the query is still running. The returned
 * `providerId` is the provider that *answered* — the manager falls back to
 * `basic` for an unknown id, and the caller should see the fallback rather
 * than the id it asked for.
 */
export async function runIntelligenceQuery(
  deps: IntelligenceQueryDeps,
  rawInput: unknown,
): Promise<IntelligenceQueryEnvelope> {
  const parsed = queryInputSchema.parse(rawInput);
  const providerId = parsed.providerId ?? deps.defaultProviderId ?? 'basic';

  const outcome = await deps.intelligence.query({
    kind: parsed.kind,
    providerId,
    input: mergeInput(parsed.workspaceId, parsed.input),
    ...(parsed.operationId === undefined ? {} : { operationId: parsed.operationId }),
  });

  return {
    operationId: outcome.operationId,
    providerId: outcome.providerId,
    result: outcome,
  };
}
