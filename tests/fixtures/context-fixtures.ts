/**
 * Shared fixtures for contract tests.
 *
 * These build the shape of a ContextPack by hand rather than going through the
 * broker, so a contract test fails for exactly one reason: the invariant it is
 * testing, not because some upstream provider misbehaved.
 */

import type {
  ContextPack,
  ContextItem,
  ContextItemKind,
  FreshnessState,
  InjectionProfile,
} from '@ucad/contracts';

const FRESH: FreshnessState = {
  indexedAt: '2026-01-01T00:00:00.000Z',
  workspaceRevision: 'abc1234',
  stale: false,
};

export const STALE: FreshnessState = {
  indexedAt: '2026-01-01T00:00:00.000Z',
  workspaceRevision: 'abc1234',
  stale: true,
  stalenessReason: 'provider_stale',
};

export function item(
  id: string,
  kind: ContextItemKind,
  opts: {
    text?: string;
    reference?: string;
    tokens?: number;
    stale?: FreshnessState;
    truncated?: boolean;
  } = {},
): ContextItem {
  return {
    id,
    kind,
    source: { providerId: 'basic', reference: opts.reference ?? `src/${id}.ts` },
    reason: `matched the objective for ${kind}`,
    freshness: opts.stale ?? FRESH,
    estimatedTokens: opts.tokens ?? 100,
    budgetShare: 0,
    truncated: opts.truncated ?? false,
    payload: opts.text ?? `content of ${id}`,
  };
}

export function pack(items: ContextItem[], opts: Partial<ContextPack> = {}): ContextPack {
  const usedTokens = items.reduce((sum, i) => sum + i.estimatedTokens, 0);
  return {
    id: 'cp_01HZZZZZZZZZZZZZZZZZZZZZZZ',
    revision: 1,
    workspaceId: 'ws_1',
    sessionId: 'ses_1',
    turnId: 'turn_1',
    strategy: 'hybrid',
    strategyReason: 'default for test',
    items,
    omitted: [],
    budget: {
      packId: 'cp_01HZZZZZZZZZZZZZZZZZZZZZZZ',
      revision: 1,
      limitTokens: 32_000,
      usedTokens,
      remainingTokens: 32_000 - usedTokens,
      estimateSource: 'heuristic_chars_div_4',
      truncated: false,
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    objective: '修复登录失败并补测试',
    ...opts,
  };
}

export function profile(overrides: Partial<InjectionProfile> = {}): InjectionProfile {  return {
    agentId: 'mock',
    mode: 'prompt_prefix',
    rendezvous: 'system_prompt',
    includeItemIds: true,
    includeFreshness: true,
    maxIndexEntries: 50,
    includeFullSlices: true,
    ...overrides,
  };
}
