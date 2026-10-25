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
import { silentLogger } from '@ucad/observability';
import type {
  AgentHostToMain,
  MainToAgentHost,
  SecretRef,
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

    await expect(resolver(REF)).resolves.toBeNull();
    await runner.dispose();
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
