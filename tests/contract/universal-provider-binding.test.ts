/**
 * The vendor the user picked is the vendor the request goes to.
 *
 * ## Why this test is here
 *
 * The Composer's provider picker and the request that leaves the machine used
 * to be two unrelated things. The picker wrote a preference, the Renderer sent
 * it, the IPC layer's schema did not know the field — and `z.object` strips
 * what it does not know — so the turn ran against whatever the adapter's
 * default happened to be. The card said "DeepSeek"; the request went to
 * OpenAI, with OpenAI's key.
 *
 * That is worse than a cosmetic mismatch: it sends one vendor's credential to
 * another vendor, and it bills the wrong account.
 *
 * So this test drives the Universal adapter against a recording `fetch` and
 * asserts three things about the request that is actually made: the host it
 * goes to, the model it names, and the credential it carries.
 */

import { describe, expect, it } from 'vitest';

import { createUniversalAdapter } from '@ucad/adapter-universal';
import { silentLogger } from '@ucad/observability';
import type {
  AgentTurnInput,
  CreateAgentSessionInput,
  InboundEventProposal,
  SecretRef,
} from '@ucad/contracts';

interface Recorded {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** A fetch that records the request and answers with one SSE frame. */
function recordingFetch(recorded: Recorded[]): typeof fetch {
  return (async (input: unknown, init?: { headers?: unknown; body?: unknown }) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    recorded.push({ url: String(input), headers, body });
    const sse = [
      'data: {"choices":[{"delta":{"content":"ok"}}]}',
      '',
      'data: [DONE]',
      '',
      '',
    ].join('\n');
    return new Response(sse, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  }) as typeof fetch;
}

function sessionInput(overrides: Partial<CreateAgentSessionInput> = {}): CreateAgentSessionInput {
  return {
    ucadSessionId: 'ses_binding',
    workspaceId: 'ws_binding',
    workspaceRoot: '/tmp/ucad-binding',
    permissionMode: 'ask',
    trustState: 'trusted',
    ...overrides,
  };
}

function turnInput(): AgentTurnInput {
  return {
    turnId: 'turn_binding',
    objective: '问一个问题',
    injection: {
      turnId: 'turn_binding',
      packId: 'pack_binding',
      packRevision: 1,
      profile: 'universal',
      rendered: 'RENDERED-CONTEXT',
      renderedHash: 'sha256:binding',
      index: [],
      omitted: [],
      estTokens: 1,
      estimateSource: 'computed',
    },
    permissionMode: 'ask',
  };
}

async function collect(stream: AsyncIterable<InboundEventProposal>): Promise<InboundEventProposal[]> {
  const out: InboundEventProposal[] = [];
  for await (const proposal of stream) out.push(proposal);
  return out;
}

describe('the Universal adapter calls the vendor the session names', () => {
  it('sends the request to that vendor, with that model and that credential', async () => {
    const recorded: Recorded[] = [];
    const asked: SecretRef[] = [];
    // The transport is injected, not the client: the client is where the
    // credential seam lives, and replacing it would replace the thing under
    // test.
    const adapter = createUniversalAdapter({
      logger: silentLogger('binding'),
      fetchImpl: recordingFetch(recorded),
    });
    await adapter.initialize({
      agentHostId: 'host_binding',
      workspaceRoot: '/tmp/ucad-binding',
      configDir: '/tmp/ucad-binding',
      env: {},
      // This is the channel Main opens: the key the user saved in Settings.
      secretResolver: async (ref) => {
        asked.push(ref);
        return 'sk-deepseek-key';
      },
      logger: silentLogger('binding'),
    });

    const handle = await adapter.createSession(
      sessionInput({ providerId: 'deepseek', modelId: 'deepseek-chat' }),
    );
    const events = await collect(handle.send(turnInput()));

    expect(recorded).toHaveLength(1);
    const request = recorded[0]!;
    // The host is the chosen vendor's, not the adapter default's.
    expect(request.url).toBe('https://api.deepseek.com/v1/chat/completions');
    // The model is the chosen one.
    expect(request.body['model']).toBe('deepseek-chat');
    // The credential is the one the channel answered with.
    expect(request.headers['authorization']).toBe('Bearer sk-deepseek-key');
    // And it was asked for by reference, against the chosen vendor's own key.
    expect(asked).toEqual([{ providerId: 'deepseek', key: 'api-key' }]);

    // The turn completed rather than failing on the way.
    const types = events.map((e) => e.type);
    expect(types).toContain('text.delta');
    expect(types).toContain('turn.completed');
    const completed = events.find((e) => e.type === 'turn.completed');
    expect((completed?.payload as { status?: string }).status).toBe('completed');

    // The credential is never part of what the user sees.
    expect(JSON.stringify(events)).not.toContain('sk-deepseek-key');
  });

  it('falls back to the adapter default when the session names no vendor', async () => {
    const recorded: Recorded[] = [];
    const adapter = createUniversalAdapter({
      logger: silentLogger('binding'),
      fetchImpl: recordingFetch(recorded),
      defaultProviderId: 'openai',
      defaultModelId: 'gpt-4o-mini',
    });
    await adapter.initialize({
      agentHostId: 'host_binding',
      workspaceRoot: '/tmp/ucad-binding',
      configDir: '/tmp/ucad-binding',
      env: {},
      secretResolver: async () => 'sk-openai-key',
      logger: silentLogger('binding'),
    });

    const handle = await adapter.createSession(sessionInput());
    await collect(handle.send(turnInput()));

    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(recorded[0]!.body['model']).toBe('gpt-4o-mini');
  });

  /**
   * A model id belongs to a vendor. Carrying the default provider's model to
   * another one produces a request the vendor rejects with a 400 about the
   * model — which reads as a broken product rather than a wrong pairing.
   */
  it('pairs the model with the vendor, even when the session names only the vendor', async () => {
    const recorded: Recorded[] = [];
    const adapter = createUniversalAdapter({
      logger: silentLogger('binding'),
      fetchImpl: recordingFetch(recorded),
      defaultProviderId: 'openai',
      defaultModelId: 'gpt-4o-mini',
    });
    await adapter.initialize({
      agentHostId: 'host_binding',
      workspaceRoot: '/tmp/ucad-binding',
      configDir: '/tmp/ucad-binding',
      env: {},
      secretResolver: async () => 'sk-deepseek-key',
      logger: silentLogger('binding'),
    });

    const handle = await adapter.createSession(sessionInput({ providerId: 'deepseek' }));
    await collect(handle.send(turnInput()));

    expect(recorded[0]!.url).toBe('https://api.deepseek.com/v1/chat/completions');
    expect(recorded[0]!.body['model']).toBe('deepseek-chat');
  });

  it('uses the credential channel before the adapter’s own fallback', async () => {
    const recorded: Recorded[] = [];
    const adapter = createUniversalAdapter({
      logger: silentLogger('binding'),
      fetchImpl: recordingFetch(recorded),
      // The fallback the environment would provide for development.
      secrets: { get: async () => 'sk-from-environment', exists: async () => true },
    });
    await adapter.initialize({
      agentHostId: 'host_binding',
      workspaceRoot: '/tmp/ucad-binding',
      configDir: '/tmp/ucad-binding',
      env: {},
      secretResolver: async () => 'sk-from-settings',
      logger: silentLogger('binding'),
    });

    const handle = await adapter.createSession(sessionInput({ providerId: 'openai' }));
    await collect(handle.send(turnInput()));

    // The key the user saved wins over the shell's — otherwise Settings would
    // look like it works while the request used somebody else's key.
    expect(recorded[0]!.headers['authorization']).toBe('Bearer sk-from-settings');
  });
});
