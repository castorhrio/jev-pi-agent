/**
 * The Universal adapter against a real socket.
 *
 * ## Why this file exists
 *
 * Every other test of this adapter replaces `fetch` with a function that
 * answers from a string literal. That proves the request body is assembled and
 * the frame parser is wired up; it does not prove that a turn survives an HTTP
 * connection. The distance between the two is where the product's main chain
 * lives: `ProviderClient` builds headers, Node opens a socket, the server writes
 * chunks in whatever sizes the network chose, and the adapter turns the
 * resulting bytes into `text.delta` proposals. A stub `fetch` short-circuits
 * every one of those steps.
 *
 * So this file starts a real `node:http` server on loopback and lets the
 * adapter make a real `fetch` to it. Nothing is mocked except the *address*:
 * the catalogue's `https://api.openai.com/v1` is rewritten to the ephemeral
 * loopback port, so the URL composition, transport invariant, header assembly
 * and credential seam all run exactly as they do in the product.
 *
 * No external resource is touched: the server is created and closed inside the
 * file, and the run is offline.
 *
 * ## What it pins
 *
 *  - the request the vendor would receive: path, model, `stream`, and the two
 *    messages in order;
 *  - the injection is byte-for-byte `injection.rendered` (I-3/NFR-13), in the
 *    system message, with newlines and non-ASCII text intact;
 *  - the frames arrive in order and are surfaced as `text.delta` in that order;
 *  - vendor usage survives the wire and is reported as `source: 'vendor'`;
 *  - a 401 is a classified failure with an `error` event, not a silent success;
 *  - the credential never appears in any event the Renderer could see.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createUniversalAdapter } from '@ucad/adapter-universal';
import { silentLogger } from '@ucad/observability';
import type {
  AgentSessionHandle,
  AgentTurnInput,
  CreateAgentSessionInput,
  InboundEventProposal,
} from '@ucad/contracts';

/** A rendered injection with a newline and non-ASCII text, so "verbatim" is testable. */
const RENDERED = 'UCAD-CONTEXT-PACK\n系统提示：逐字注入，不得重写。\nfile: src/index.ts\n';

const OBJECTIVE = '改一下 src/index.ts';
const API_KEY = 'sk-loopback-stub-key';

interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: IncomingMessage['headers'];
  readonly body: Record<string, unknown>;
}

/** What the stub server should answer with. */
interface StubReply {
  status: number;
  headers: Record<string, string>;
  /** SSE frames, written one `res.write()` at a time. */
  chunks?: readonly string[];
  /** a single JSON body, for the failure case */
  json?: unknown;
}

const OPENAI_COMPAT_REPLY: StubReply = {
  status: 200,
  headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
  chunks: [
    'data: {"id":"chatcmpl-stub","model":"gpt-4o-mini","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{"content":"你好"}}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{"content":"，世界"}}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":42,"completion_tokens":7}}\n\n',
    'data: [DONE]\n\n',
  ],
};

/**
 * A real HTTP server that records one request and answers with `reply`.
 *
 * `reply` is read per request, so a test can hand the same server a healthy
 * answer and then a 401 without restarting it.
 */
class StubVendor {
  readonly requests: RecordedRequest[] = [];
  reply: StubReply = OPENAI_COMPAT_REPLY;
  private server: Server | undefined;
  private port = 0;

  async start(): Promise<void> {
    this.server = createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(0, '127.0.0.1', () => {
        const address = this.server!.address();
        if (address === null || typeof address === 'string') {
          reject(new Error('the stub server did not report a loopback port'));
          return;
        }
        this.port = address.port;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (this.server === undefined) return;
    const server = this.server;
    this.server = undefined;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  get baseUrl(): string {
    return `127.0.0.1:${this.port}`;
  }

  /** The transport seam: real `fetch`, catalogue URL, loopback address. */
  readonly fetchImpl: typeof fetch = (input, init) => {
    const url = new URL(String(input));
    url.protocol = 'http:';
    url.host = this.baseUrl;
    return fetch(url, init);
  };

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      this.requests.push({
        method: req.method ?? '',
        path: req.url ?? '',
        headers: req.headers,
        body: raw === '' ? {} : (JSON.parse(raw) as Record<string, unknown>),
      });
      void this.respond(res);
    });
  }

  private async respond(res: ServerResponse): Promise<void> {
    const reply = this.reply;
    res.writeHead(reply.status, reply.headers);
    if (reply.json !== undefined) {
      res.end(JSON.stringify(reply.json));
      return;
    }
    for (const chunk of reply.chunks ?? []) {
      res.write(chunk);
      // One frame per turn of the event loop: the client's reader then has to
      // reassemble a stream that really arrived in pieces, which is the only
      // way the incremental parser is exercised.
      await new Promise((resolve) => setImmediate(resolve));
    }
    res.end();
  }
}

const vendor = new StubVendor();

beforeAll(async () => {
  await vendor.start();
});

afterAll(async () => {
  await vendor.stop();
});

function sessionInput(overrides: Partial<CreateAgentSessionInput> = {}): CreateAgentSessionInput {
  return {
    ucadSessionId: 'ses_universal_e2e',
    workspaceId: 'ws_universal_e2e',
    workspaceRoot: '/tmp/ucad-universal-e2e',
    permissionMode: 'ask',
    trustState: 'trusted',
    ...overrides,
  };
}

function turnInput(overrides: Partial<AgentTurnInput> = {}): AgentTurnInput {
  return {
    turnId: 'turn_universal_e2e',
    objective: OBJECTIVE,
    injection: {
      turnId: 'turn_universal_e2e',
      packId: 'pack_universal_e2e',
      packRevision: 1,
      profile: 'universal',
      rendered: RENDERED,
      renderedHash: 'sha256:universal-e2e',
      index: [],
      omitted: [],
      estTokens: 12,
      estimateSource: 'computed',
    },
    permissionMode: 'ask',
    ...overrides,
  };
}

async function collect(
  stream: AsyncIterable<InboundEventProposal>,
): Promise<InboundEventProposal[]> {
  const out: InboundEventProposal[] = [];
  for await (const proposal of stream) out.push(proposal);
  return out;
}

async function newAdapter(): Promise<ReturnType<typeof createUniversalAdapter>> {
  const adapter = createUniversalAdapter({
    logger: silentLogger('universal-e2e'),
    fetchImpl: vendor.fetchImpl,
    defaultProviderId: 'openai',
    defaultModelId: 'gpt-4o-mini',
  });
  await adapter.initialize({
    agentHostId: 'host_universal_e2e',
    workspaceRoot: '/tmp/ucad-universal-e2e',
    configDir: '/tmp/ucad-universal-e2e',
    env: {},
    // This is the channel Main opens: the key the user saved in Settings. The
    // adapter must put it in one header and nowhere else.
    secretResolver: async () => API_KEY,
    logger: silentLogger('universal-e2e'),
  });
  return adapter;
}

async function runTurn(
  adapter: ReturnType<typeof createUniversalAdapter>,
): Promise<{ events: InboundEventProposal[]; handle: AgentSessionHandle }> {
  const handle = await adapter.createSession(sessionInput());
  const events = await collect(handle.send(turnInput()));
  return { events, handle };
}

describe('Universal adapter over a real socket', () => {
  it('sends the request the vendor would receive, and reads the stream back', async () => {
    vendor.requests.length = 0;
    vendor.reply = OPENAI_COMPAT_REPLY;
    const adapter = await newAdapter();
    try {
      const { events, handle } = await runTurn(adapter);
      await handle.dispose();

      // The server — not a stub function — saw exactly one request.
      expect(vendor.requests).toHaveLength(1);
      const request = vendor.requests[0]!;
      expect(request.method).toBe('POST');
      expect(request.path).toBe('/v1/chat/completions');
      expect(request.headers['authorization']).toBe(`Bearer ${API_KEY}`);
      expect(request.headers['content-type']).toBe('application/json');
      expect(request.headers['accept']).toBe('text/event-stream');

      // The OpenAI-compatible shape, with the vendor's own model.
      expect(request.body['model']).toBe('gpt-4o-mini');
      expect(request.body['stream']).toBe(true);
      expect(request.body['messages']).toEqual([
        { role: 'system', content: RENDERED },
        { role: 'user', content: OBJECTIVE },
      ]);

      // The frames arrived in order, as deltas, with no empty prefix.
      const deltas = events
        .filter((event) => event.type === 'text.delta')
        .map((event) => (event.payload as { text: string }).text);
      expect(deltas).toEqual(['你好', '，世界']);

      // Vendor usage crossed the wire and is labelled as the vendor's.
      const usage = events.find((event) => event.type === 'usage');
      const record = (usage?.payload as { record: Record<string, unknown> }).record;
      expect(record['providerId']).toBe('openai');
      expect(record['modelId']).toBe('gpt-4o-mini');
      expect(record['inputTokens']).toBe(42);
      expect(record['outputTokens']).toBe(7);
      expect(record['source']).toBe('vendor');

      const completed = events.find((event) => event.type === 'turn.completed');
      expect((completed?.payload as { status?: string }).status).toBe('completed');

      // Nothing the Renderer sees can carry the credential.
      expect(JSON.stringify(events)).not.toContain(API_KEY);
    } finally {
      await adapter.dispose();
    }
  });

  it('turns a 401 from a real response into a classified failure', async () => {
    vendor.requests.length = 0;
    vendor.reply = {
      status: 401,
      headers: { 'content-type': 'application/json' },
      json: { error: { message: `invalid key ${API_KEY}`, type: 'invalid_request_error' } },
    };
    const adapter = await newAdapter();
    try {
      const { events, handle } = await runTurn(adapter);
      await handle.dispose();

      expect(vendor.requests).toHaveLength(1);
      // The adapter reported a failure rather than an empty answer.
      const error = events.find((event) => event.type === 'error');
      expect(error, 'a rejected credential produced no error event').toBeDefined();
      const payload = error!.payload as { code: string; message: string };
      expect(payload.code).toBe('AUTH_REQUIRED');
      // The sentence names the provider and the status; the vendor's body (which
      // echoed the key) is not read on failure, so it cannot reach the screen.
      expect(payload.message).toContain('OpenAI');
      expect(payload.message).toContain('401');
      expect(payload.message).not.toContain(API_KEY);
      expect(JSON.stringify(events)).not.toContain(API_KEY);

      const completed = events.find((event) => event.type === 'turn.completed');
      expect((completed?.payload as { status?: string }).status).toBe('failed');
      expect(events.filter((event) => event.type === 'text.delta')).toEqual([]);
    } finally {
      await adapter.dispose();
    }
  });

  it('keeps the injection byte-for-byte, including newlines', async () => {
    vendor.requests.length = 0;
    vendor.reply = OPENAI_COMPAT_REPLY;
    const adapter = await newAdapter();
    try {
      const { handle } = await runTurn(adapter);
      await handle.dispose();

      const system = (vendor.requests[0]!.body['messages'] as Array<{
        role: string;
        content: string;
      }>)[0]!;
      // `toEqual` on the whole string, not `toContain`: a trim, a re-wrap or a
      // newline normalisation must fail here.
      expect(system.content).toBe(RENDERED);
      expect(system.content.length).toBe(RENDERED.length);
    } finally {
      await adapter.dispose();
    }
  });
});
