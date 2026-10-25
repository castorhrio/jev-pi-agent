/**
 * The credential channel: the key the user saved in Settings reaches the
 * process that talks to the provider.
 *
 * ## Why this test is here
 *
 * The credential lives in Main's OS keychain. The request is sent by the
 * Agent Host — a *forked* child process — and it is used by the Universal
 * adapter, which runs inside that child. Every one of those three facts can
 * be true while the product is broken, and the breakage is invisible from the
 * outside:
 *
 *   - the Settings panel saves a key, `providers.probe` succeeds (Main reads
 *     the keychain itself), and the conversation still fails with a 401;
 *   - the Composer shows "DeepSeek" while the request goes to OpenAI;
 *   - the key is sent to a vendor the user never chose.
 *
 * A unit test cannot see any of that, because the seam that matters is a
 * process boundary. So this test forks a real Host and reads the answer on
 * Main's side of the protocol.
 *
 * ## What is asserted
 *
 * 1. The Host asks for a *reference*, never a value: the request frame
 *    carries `{ providerId, key }` and nothing else.
 * 2. Main answers from its resolver, and the answer reaches the adapter.
 * 3. A request Main cannot answer resolves to "no credential" instead of
 *    hanging the turn forever.
 * 4. The credential never appears in a frame that is not the answer, and never
 *    in a log line.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AgentHostProcess, resolveHostEntry } from '@ucad/agent-host';
import { AgentHostRunner } from '@ucad/agent-host';
import { createUniversalAdapter } from '@ucad/adapter-universal';
import { silentLogger } from '@ucad/observability';
import {
  appError,
  type AgentHostToMain,
  type MainToAgentHost,
  type SecretRef,
} from '@ucad/contracts';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const probeAdapter = path.join(repoRoot, 'tests', 'fixtures', 'credential-probe-adapter.cjs');

const REF: SecretRef = { providerId: 'openai', key: 'api-key' };

// ---------------------------------------------------------------------------
// the Host half: the runner asks, and waits with a bound
// ---------------------------------------------------------------------------

/** A transport pair that keeps both ends in this process. */
function memoryTransport(): {
  toHost: (msg: MainToAgentHost) => void;
  fromHost: (msg: AgentHostToMain) => void;
  sent: AgentHostToMain[];
} {
  const toHostListeners: Array<(msg: MainToAgentHost) => void> = [];
  const fromHostListeners: Array<(msg: AgentHostToMain) => void> = [];
  const sent: AgentHostToMain[] = [];
  return {
    sent,
    toHost: (msg) => {
      for (const listener of toHostListeners) listener(msg);
    },
    fromHost: (msg) => {
      sent.push(msg);
      for (const listener of fromHostListeners) listener(msg);
    },
    // The transport interface the runner expects.
    ...({
      send: (msg: AgentHostToMain) => {
        sent.push(msg);
        for (const listener of fromHostListeners) listener(msg);
      },
      onMessage: (cb: (msg: MainToAgentHost) => void) => {
        toHostListeners.push(cb);
        return () => {
          const index = toHostListeners.indexOf(cb);
          if (index >= 0) toHostListeners.splice(index, 1);
        };
      },
    } as never),
  };
}

describe('the Host asks Main for a credential', () => {
  it('sends a reference, and resolves with the answer', async () => {
    const transport = memoryTransport();
    const runner = new AgentHostRunner({
      adapter: {
        manifest: { id: 'probe' },
        initialize: async () => undefined,
        listModels: async () => [],
        createSession: async () => {
          throw new Error('not used');
        },
        resumeSession: async () => {
          throw new Error('not used');
        },
        dispose: async () => undefined,
      } as never,
      agentHostId: 'host_probe',
      logger: silentLogger('secret-channel'),
      transport: transport as never,
      secretTimeoutMs: 2_000,
    });

    runner.start();

    // The resolver the runner hands to the adapter is the one under test.
    let requested: SecretRef | undefined;
    const resolved = (async () => {
      const resolver = (
        runner as unknown as {
          secretResolver: (ref: SecretRef) => Promise<string | null>;
        }
      ).secretResolver;
      requested = REF;
      return resolver(REF);
    })();

    // Give the runner a tick to emit the request.
    await new Promise((resolve) => setTimeout(resolve, 10));

    const request = transport.sent.find((msg) => msg.op === 'secret_request');
    expect(request).toBeTruthy();
    const payload = (request as { payload: { requestId: string; ref: SecretRef } }).payload;
    expect(payload.ref).toEqual(REF);
    // The request carries a reference and nothing else — no value, no vault
    // path, no environment variable naming a secret.
    expect(Object.keys(payload).sort()).toEqual(['ref', 'requestId']);

    transport.toHost({
      op: 'secret_response',
      payload: { requestId: payload.requestId, value: 'sk-from-main' },
    });

    await expect(resolved).resolves.toBe('sk-from-main');
    expect(requested).toEqual(REF);
    await runner.dispose();
  });

  it('gives up instead of hanging when Main never answers', async () => {
    const transport = memoryTransport();
    const runner = new AgentHostRunner({
      adapter: {
        manifest: { id: 'probe' },
        initialize: async () => undefined,
        listModels: async () => [],
        createSession: async () => {
          throw new Error('not used');
        },
        resumeSession: async () => {
          throw new Error('not used');
        },
        dispose: async () => undefined,
      } as never,
      agentHostId: 'host_probe',
      logger: silentLogger('secret-channel'),
      transport: transport as never,
      secretTimeoutMs: 50,
    });
    runner.start();

    const resolver = (
      runner as unknown as { secretResolver: (ref: SecretRef) => Promise<string | null> }
    ).secretResolver;

    // The answer that never came is not the same as "Main holds no key".
    // Resolving both to `null` made the app blame the user's Settings for a
    // desktop process that had stopped answering, so the timeout rejects
    // with a code of its own.
    await expect(resolver(REF)).rejects.toMatchObject({
      code: 'HOST_UNRESPONSIVE',
      component: 'agent',
    });

    await runner.dispose();
  });

  it('says how long it waited, so the diagnosis is actionable', async () => {
    const transport = memoryTransport();
    const runner = new AgentHostRunner({
      adapter: {
        manifest: { id: 'probe' },
        initialize: async () => undefined,
        listModels: async () => [],
        createSession: async () => {
          throw new Error('not used');
        },
        resumeSession: async () => {
          throw new Error('not used');
        },
        dispose: async () => undefined,
      } as never,
      agentHostId: 'host_probe',
      logger: silentLogger('secret-channel'),
      transport: transport as never,
      secretTimeoutMs: 50,
    });
    runner.start();

    const resolver = (
      runner as unknown as { secretResolver: (ref: SecretRef) => Promise<string | null> }
    ).secretResolver;

    const failure = await resolver(REF).then(
      () => undefined,
      (error: unknown) => error,
    );
    const details = (failure as { details?: { waitedMs?: number } }).details;
    expect(details?.waitedMs).toBe(50);

    await runner.dispose();
  });
});

// ---------------------------------------------------------------------------
// the turn half: which failure the user is told about
// ---------------------------------------------------------------------------

/**
 * The two failures that used to look like one.
 *
 * "Main holds no key for this vendor" and "Main never answered" both ended
 * up as a 401-shaped complaint about a missing key, so a user whose key was
 * saved correctly was told to go and enter it again. The turn has to say
 * which one happened, because the two need different actions.
 */
describe('the turn tells the two credential failures apart', () => {
  async function turnError(
    resolve: (ref: SecretRef) => Promise<string | null>,
  ): Promise<{ code?: string; message?: string }> {
    const adapter = createUniversalAdapter({
      logger: silentLogger('secret-channel'),
      // A fetch that must never be reached: the turn has to fail on the
      // credential, before any request leaves the machine.
      fetchImpl: (async () => {
        throw new Error('the request must not be sent without a credential');
      }) as unknown as typeof fetch,
    });
    await adapter.initialize({
      agentHostId: 'host_probe',
      workspaceRoot: '/tmp/ucad-secret-channel',
      configDir: '/tmp/ucad-secret-channel',
      env: {},
      secretResolver: resolve,
      logger: silentLogger('secret-channel'),
    });

    const handle = await adapter.createSession({
      ucadSessionId: 'ses_probe',
      workspaceId: 'ws_probe',
      workspaceRoot: '/tmp/ucad-secret-channel',
      permissionMode: 'ask',
      trustState: 'trusted',
      providerId: 'openai',
    });

    const events = [];
    for await (const proposal of handle.send({
      turnId: 'turn_probe',
      objective: 'probe',
      injection: {
        turnId: 'turn_probe',
        packId: 'pack_probe',
        packRevision: 1,
        profile: 'universal',
        rendered: 'rendered',
        renderedHash: 'sha256:probe',
        index: [],
        omitted: [],
        estTokens: 1,
        estimateSource: 'computed',
      },
      permissionMode: 'ask',
    })) {
      events.push(proposal);
    }

    const failure = events.find((event) => event.type === 'error');
    return (failure?.payload ?? {}) as { code?: string; message?: string };
  }

  it('says the desktop did not answer, and does not blame the key', async () => {
    const error = await turnError(async () => {
      // Exactly what the Host's runner rejects with when Main is silent.
      throw appError('HOST_UNRESPONSIVE', 'Main did not answer', 'agent', {
        details: { providerId: 'openai', key: 'api-key', waitedMs: 5_000 },
      });
    });

    expect(error.code).toBe('HOST_UNRESPONSIVE');
    expect(error.message).toContain('主进程');
    // The sentence that sends the user to re-enter a key they already entered
    // must not be here: the key was never the problem.
    expect(error.message).not.toContain('No API key is stored');
  });

  it('says the credential is missing when Main answers that it has none', async () => {
    const error = await turnError(async () => null);

    expect(error.code).toBe('AUTH_REQUIRED');
    expect(error.message).toContain('No API key is stored');
  });
});

// ---------------------------------------------------------------------------
// the Main half: a real fork, a real keychain answer
// ---------------------------------------------------------------------------

let dir: string;
let host: AgentHostProcess | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucad-secret-channel-'));
});

afterEach(async () => {
  await host?.dispose(500).catch(() => undefined);
  host = undefined;
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Collects the frames Main receives from the Host. */
function collectFrames(
  target: AgentHostProcess,
): { frames: AgentHostToMain[]; texts: () => string[] } {
  const frames: AgentHostToMain[] = [];
  target.onMessage((msg) => frames.push(msg));
  return {
    frames,
    texts: () =>
      frames
        .filter((msg) => msg.op === 'event')
        .map((msg) => {
          const payload = msg.payload as { type: string; payload: { text?: string } };
          return payload.payload.text ?? '';
        }),
  };
}

describe('the credential reaches the forked Host', () => {
  it('answers a credential request from the keychain and delivers it to the adapter', async () => {
    const asked: SecretRef[] = [];
    host = new AgentHostProcess({
      adapterModule: probeAdapter,
      agentHostId: 'host_probe',
      logger: silentLogger('secret-channel'),
      cwd: dir,
      configDir: dir,
      hostEntry: resolveHostEntry(),
      secretResolver: async (ref) => {
        asked.push(ref);
        return 'sk-from-keychain';
      },
    });

    const manifest = await host.start();
    expect(manifest.id).toBe('credential-probe');

    const collected = collectFrames(host);
    host.send({
      op: 'create_session',
      payload: {
        ucadSessionId: 'ses_probe',
        workspaceId: 'ws_probe',
        workspaceRoot: dir,
        permissionMode: 'ask',
        trustState: 'trusted',
      },
    });
    host.send({
      op: 'send_turn',
      payload: {
        turnId: 'turn_probe',
        objective: 'probe',
        injection: {
          turnId: 'turn_probe',
          packId: 'pack_probe',
          packRevision: 1,
          profile: 'universal',
          rendered: 'rendered',
          renderedHash: 'sha256:probe',
          index: [],
          omitted: [],
          estTokens: 1,
          estimateSource: 'computed',
        },
        permissionMode: 'ask',
      },
    });

    // Wait for the answer to travel: Host → Main → Host → adapter.
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && collected.texts().length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    expect(asked).toEqual([REF]);
    expect(collected.texts()).toEqual(['sk-from-keychain']);
  }, 30_000);

  it('answers "no credential" when Main holds none, instead of leaving the turn waiting', async () => {
    host = new AgentHostProcess({
      adapterModule: probeAdapter,
      agentHostId: 'host_probe',
      logger: silentLogger('secret-channel'),
      cwd: dir,
      configDir: dir,
      hostEntry: resolveHostEntry(),
      secretResolver: async () => null,
    });
    await host.start();

    const collected = collectFrames(host);
    host.send({
      op: 'create_session',
      payload: {
        ucadSessionId: 'ses_probe',
        workspaceId: 'ws_probe',
        workspaceRoot: dir,
        permissionMode: 'ask',
        trustState: 'trusted',
      },
    });
    host.send({
      op: 'send_turn',
      payload: {
        turnId: 'turn_probe',
        objective: 'probe',
        injection: {
          turnId: 'turn_probe',
          packId: 'pack_probe',
          packRevision: 1,
          profile: 'universal',
          rendered: 'rendered',
          renderedHash: 'sha256:probe',
          index: [],
          omitted: [],
          estTokens: 1,
          estimateSource: 'computed',
        },
        permissionMode: 'ask',
      },
    });

    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && collected.texts().length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    expect(collected.texts()).toEqual(['<no-credential>']);
  }, 30_000);

  it('never carries the credential in the frame that travels to Main', async () => {
    host = new AgentHostProcess({
      adapterModule: probeAdapter,
      agentHostId: 'host_probe',
      logger: silentLogger('secret-channel'),
      cwd: dir,
      configDir: dir,
      hostEntry: resolveHostEntry(),
      secretResolver: async () => 'sk-from-keychain',
    });
    await host.start();

    const collected = collectFrames(host);
    host.send({
      op: 'create_session',
      payload: {
        ucadSessionId: 'ses_probe',
        workspaceId: 'ws_probe',
        workspaceRoot: dir,
        permissionMode: 'ask',
        trustState: 'trusted',
      },
    });
    host.send({
      op: 'send_turn',
      payload: {
        turnId: 'turn_probe',
        objective: 'probe',
        injection: {
          turnId: 'turn_probe',
          packId: 'pack_probe',
          packRevision: 1,
          profile: 'universal',
          rendered: 'rendered',
          renderedHash: 'sha256:probe',
          index: [],
          omitted: [],
          estTokens: 1,
          estimateSource: 'computed',
        },
        permissionMode: 'ask',
      },
    });

    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && collected.texts().length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    // The one frame that travels from the Host to Main names the credential it
    // wants. It must not carry it: this frame is the one Main logs, and a
    // value in a log line is a value the user cannot see and cannot revoke.
    const requests = collected.frames.filter((msg) => msg.op === 'secret_request');
    expect(requests).toHaveLength(1);
    const request = requests[0] as { payload: { requestId: string; ref: SecretRef } };
    expect(request.payload.ref).toEqual(REF);
    expect(JSON.stringify(request)).not.toContain('sk-from-keychain');

    // Outside the probe's own echo — which exists precisely to report what it
    // resolved — no frame Main receives carries the value.
    for (const frame of collected.frames) {
      if (frame.op === 'event') continue;
      expect(JSON.stringify(frame)).not.toContain('sk-from-keychain');
    }
  }, 30_000);
});
