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
import type { IntelligenceQueryKind } from '@ucad/contracts';

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
  input: z.unknown(),
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
 * The provider needs the workspace id next to whatever the panel asked for.
 * A non-object payload (a bare string, say) is passed through untouched
 * rather than spread — spreading a string spreads its characters.
 */
function mergeInput(workspaceId: string, payload: unknown): unknown {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return payload;
  }
  return { workspaceId, ...(payload as Record<string, unknown>) };
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
