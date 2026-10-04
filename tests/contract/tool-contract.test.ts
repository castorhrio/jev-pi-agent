/**
 * §4.7.2 anti shadow-privilege guard.
 *
 * The Tool Contract is the channel through which an Agent can call back into
 * UCAD. If it ever exposes file writes, command execution or git operations, it
 * becomes a way to bypass the vendor's own approval flow and UCAD's Permission
 * Engine. The design doc is explicit that this must not happen, so it gets a
 * test rather than a code comment.
 */

import { describe, it, expect } from 'vitest';
import {
  UCAD_TOOL_NAMES,
  UCAD_TOOL_FORBIDDEN_PATTERNS,
  type ToolAvailabilityContext,
  type AgentManifest,
} from '@ucad/contracts';

const baseManifest: AgentManifest = {
  id: 'mock',
  displayName: 'Mock',
  kind: 'mock',
  isDefaultRuntime: false,
  transport: 'child_process',
  providerBinding: 'both',
  pinned: [],
  capabilities: {
    streaming: true,
    sessionResume: true,
    modelSelection: true,
    fileTools: true,
    shellTools: true,
    permissionCallbacks: 'pre_execution',
    nativeSandbox: false,
    mcp: true,
    skills: false,
    subagents: false,
    usageReporting: 'full',
    injectionModes: ['prompt_prefix', 'ucad_tools'],
    toolContract: 'mcp',
  },
};

const basicCapabilities = {
  symbolSearch: true,
  definitions: true,
  callers: false,
  callees: false,
  dependencyGraph: false,
  trace: false,
  impact: false,
  persistentIndex: false,
  incrementalRefresh: false,
  machineReadableOutput: true,
  tokenizer: 'heuristic_chars_div_4' as const,
};

function availability(
  agent: Partial<AgentManifest> = {},
  caps: Partial<typeof basicCapabilities> = {},
): ToolAvailabilityContext {
  return {
    agent: { ...baseManifest, ...agent },
    intelligence: {
      providerId: 'basic',
      capabilities: { ...basicCapabilities, ...caps },
      status: {
        providerId: 'basic',
        state: 'not_indexed',
        stale: true,
        features: { ...basicCapabilities, ...caps },
      },
    },
    workspace: { trusted: true },
  };
}

// The concrete host is constructed here lazily so this file stays a pure
// contract test that fails for one reason only.
async function makeHost() {
  const { ToolContractHost } = await import('@ucad/context');
  const { silentLogger } = await import('@ucad/observability');
  const { HeuristicTokenEstimator, InjectionRenderer } = await import('@ucad/context');

  const logger = silentLogger('test');
  const estimator = new HeuristicTokenEstimator();

  const noop = () => undefined;
  const broker = {
    extend: async (input: unknown) => ({
      packId: 'cp_1',
      baseRevision: 1,
      revision: 2,
      addedItems: [],
      removedItemIds: [],
      budget: {
        packId: 'cp_1',
        revision: 2,
        limitTokens: 1000,
        usedTokens: 100,
        remainingTokens: 900,
        estimateSource: 'heuristic_chars_div_4' as const,
        truncated: false,
      },
      dropped: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      __input: input,
    }),
  } as never;

  const intelligence = {
    query: async (input: { kind: string }) => {
      if (input.kind === 'callers' || input.kind === 'impact') {
        return {
          status: 'unsupported' as const,
          result: null,
          freshness: { stale: true as const },
          durationMs: 1,
          providerId: 'basic',
          reason: 'basic provider does not implement this method',
        };
      }
      return {
        status: 'ok' as const,
        result: { items: [] },
        freshness: { stale: true as const },
        durationMs: 1,
        providerId: 'basic',
      };
    },
  } as never;

  const permissions = { evaluate: noop } as never;
  const sessionStore = { createHandoff: () => ({ schemaVersion: 2 }) } as never;

  return new ToolContractHost({
    broker,
    intelligence,
    permissions,
    sessionStore,
    logger,
    estimator,
    renderer: new InjectionRenderer({ estimator, logger }),
  });
}

describe('Tool Contract / §4.7.2', () => {
  it('the V1 tool set is exactly the eight specified tools', () => {
    expect([...UCAD_TOOL_NAMES].sort()).toEqual(
      [
        'ucad.context.extend',
        'ucad.context.list',
        'ucad.intelligence.callers',
        'ucad.intelligence.impact',
        'ucad.intelligence.locate',
        'ucad.intelligence.search',
        'ucad.permission.request',
        'ucad.session.handoff.get',
      ].sort(),
    );
  });

  it('never exposes a write, exec or git capability', async () => {
    const host = await makeHost();
    const tools = host.list(availability());

    for (const tool of tools) {
      for (const pattern of UCAD_TOOL_FORBIDDEN_PATTERNS) {
        expect(
          pattern.test(tool.name),
          `tool "${tool.name}" matches forbidden capability pattern ${pattern}`,
        ).toBe(false);
      }
    }
  });

  it('every exposed tool lives in the ucad.* namespace', async () => {
    const host = await makeHost();
    for (const tool of host.list(availability())) {
      expect(tool.name.startsWith('ucad.')).toBe(true);
    }
  });

  it('returns the tool list in a stable order', async () => {
    const host = await makeHost();
    const a = host.list(availability()).map((t) => t.name);
    const b = host.list(availability()).map((t) => t.name);
    expect(a).toEqual(b);
  });

  describe('availability gating', () => {
    it('hides intelligence search when the provider has no symbolSearch', async () => {
      const host = await makeHost();
      const names = host
        .list(availability({}, { symbolSearch: false }))
        .map((t) => t.name);
      expect(names).not.toContain('ucad.intelligence.search');
    });

    it('hides callers and impact on the basic provider (capability false)', async () => {
      const host = await makeHost();
      const names = host.list(availability()).map((t) => t.name);
      expect(names).not.toContain('ucad.intelligence.callers');
      expect(names).not.toContain('ucad.intelligence.impact');
    });

    it('exposes callers and impact when the provider declares those capabilities', async () => {
      const host = await makeHost();
      const names = host
        .list(availability({}, { callers: true, impact: true }))
        .map((t) => t.name);
      expect(names).toContain('ucad.intelligence.callers');
      expect(names).toContain('ucad.intelligence.impact');
    });

    it('context tools are always available', async () => {
      const host = await makeHost();
      const names = host.list(availability()).map((t) => t.name);
      expect(names).toContain('ucad.context.extend');
      expect(names).toContain('ucad.context.list');
    });

    it('permission.request is hidden when the agent can be intercepted pre-execution', async () => {
      const host = await makeHost();
      const names = host.list(availability()).map((t) => t.name);
      expect(names).not.toContain('ucad.permission.request');
    });

    it('permission.request appears when the agent cannot be intercepted', async () => {
      const host = await makeHost();
      const restricted: Partial<AgentManifest> = {
        capabilities: { ...baseManifest.capabilities, permissionCallbacks: 'post_hoc' },
      };
      const names = host.list(availability(restricted)).map((t) => t.name);
      expect(names).toContain('ucad.permission.request');
    });
  });

  describe('unsupported is distinct from error (C-5)', () => {
    it('returns unsupported rather than an empty result for callers on basic', async () => {
      const host = await makeHost();
      const result = await host.invoke(
        'ucad.intelligence.callers',
        { target: { path: 'a.ts', startLine: 1, endLine: 2 } },
        {
          sessionId: 'ses_1',
          turnId: 'turn_1',
          toolCallId: 'tc_1',
          signal: new AbortController().signal,
        },
      );
      expect(result.status).toBe('unsupported');
    });

    it('does not fabricate an empty callers list', async () => {
      const host = await makeHost();
      const result = await host.invoke(
        'ucad.intelligence.callers',
        { target: { path: 'a.ts', startLine: 1, endLine: 2 } },
        {
          sessionId: 'ses_1',
          turnId: 'turn_1',
          toolCallId: 'tc_2',
          signal: new AbortController().signal,
        },
      );
      // an empty array would read as "no callers exist" — that is a lie
      expect(result.output).toBeUndefined();
    });
  });

  it('reports an unknown tool as unsupported instead of throwing', async () => {
    const host = await makeHost();
    const result = await host.invoke('ucad.not.a.tool', {}, {
      sessionId: 'ses_1',
      turnId: 'turn_1',
      toolCallId: 'tc_3',
      signal: new AbortController().signal,
    });
    expect(result.status).toBe('unsupported');
  });

  it('declares no permission requirement for read-only context tools', async () => {
    const host = await makeHost();
    for (const tool of host.list(availability())) {
      if (tool.name.startsWith('ucad.context.') || tool.name.startsWith('ucad.intelligence.')) {
        expect(tool.permissionCategory).toBeNull();
      }
    }
  });
});
