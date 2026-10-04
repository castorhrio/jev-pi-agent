/**
 * §12.1 "连接测试" — the real connection attempt.
 *
 * The rule this file exists to keep: **a connection test may only say
 * "connected" when it actually connected.** Everything else is a guess, and a
 * guess rendered as a green badge is the single most damaging thing this
 * surface can ship (§12.1 / NFR-15 honesty).
 *
 * The repo vendors no MCP client library, and adding one is out of scope, so
 * the probe speaks the protocol itself over the two transports the design
 * allows (`§7.1`):
 *
 *  - `stdio` — spawn the command, then `initialize` → `notifications/initialized`
 *    → `tools/list` as newline-delimited JSON-RPC 2.0 on stdin/stdout.
 *  - `http`  — Streamable HTTP: `POST` the same three messages, accepting both
 *    `application/json` and `text/event-stream` responses, and echoing
 *    `mcp-session-id` when the server issues one.
 *
 * Three outcomes, and `ok: true` belongs to exactly one of them:
 *
 *  - `handshake`   — `tools/list` answered with a real `tools` array. Only then
 *                    is `ok: true` and `toolCount` an observed number.
 *  - `unverified`  — the transport was reached and something answered, but the
 *                    MCP protocol was not confirmed. `ok` is **false**: we do
 *                    not know that the server works, and saying otherwise is a
 *                    guess.
 *  - `unreachable` — nothing answered. `ok` is false and `reason` says what
 *                    actually happened (ENOENT, exit code, HTTP status, …).
 *
 * Every path is bounded by one deadline (default 5s) and every failure path
 * returns a non-empty `reason`: a hung server must not be able to wedge the UI.
 */

import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { McpTestResult } from '@ucad/contracts';

export type McpTransport = 'stdio' | 'http';

/**
 * What the user configured. Only the endpoint travels here — a `secretRef` is
 * resolved by the caller in Main, never a plaintext value (NFR-01).
 */
export interface McpProbeTarget {
  id: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
}

export interface McpProbeOptions {
  /** hard ceiling on the whole probe; the UI can never be wedged by a hung server */
  timeoutMs?: number;
}

export type McpProbeOutcome =
  /** a real `tools/list` round trip completed; `toolCount` was observed */
  | 'handshake'
  /** the transport answered, but the MCP protocol was not confirmed */
  | 'unverified'
  /** nothing answered; `reason` says what happened */
  | 'unreachable';

export interface McpProbeResult extends McpTestResult {
  outcome: McpProbeOutcome;
  /** the checks that actually ran, shown verbatim in the UI */
  checks: string[];
  /** what was NOT established; empty only for a completed handshake */
  notVerified: string;
  /** `name@version` as reported by the server's own `initialize` reply */
  serverInfo?: string;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const PROTOCOL_VERSION = '2025-06-18';
const CLIENT_INFO = { name: 'ucad', version: '0.1.0' } as const;
/** Cap on captured stderr so a chatty process cannot grow the failure reason. */
const STDERR_TAIL_LINES = 8;
const BODY_SNIPPET = 200;

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

/**
 * Attempt a real connection to one MCP server.
 *
 * Never rejects: a probe that throws is a probe that failed, and the UI must
 * still receive a reason it can show.
 */
export async function probeMcpServer(
  target: McpProbeTarget,
  options: McpProbeOptions = {},
): Promise<McpProbeResult> {
  const budgetMs = Math.max(1, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const startedAt = Date.now();
  const done = (partial: Omit<McpProbeResult, 'latencyMs'>): McpProbeResult => ({
    ...partial,
    latencyMs: Math.max(0, Date.now() - startedAt),
  });

  try {
    return target.transport === 'http'
      ? await probeHttp(target, budgetMs)
      : await probeStdio(target, budgetMs);
  } catch (error) {
    return done({
      id: target.id,
      ok: false,
      toolCount: 0,
      outcome: 'unreachable',
      checks: [],
      notVerified: 'nothing — the probe threw before any check completed',
      reason: describeError(error),
    });
  }
}

// ---------------------------------------------------------------------------
// stdio
// ---------------------------------------------------------------------------

async function probeStdio(target: McpProbeTarget, budgetMs: number): Promise<McpProbeResult> {
  const command = target.command?.trim() ?? '';
  const checks: string[] = [];
  if (!command) {
    return unreachable(target, 'no command is configured for this stdio server', checks);
  }

  const deadline = new Deadline(budgetMs);
  const box = new MessageBox();
  const stderr: string[] = [];

  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(command, target.args ?? [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...(target.env ?? {}) },
      windowsHide: true,
    });
  } catch (error) {
    checks.push(`attempted to spawn ${command}`);
    return unreachable(target, `could not start ${command}: ${describeError(error)}`, checks);
  }

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => box.push(chunk));
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    if (stderr.length < STDERR_TAIL_LINES) stderr.push(chunk);
  });
  // ENOENT arrives asynchronously, so the reason for a missing binary is only
  // knowable here — never from `spawn()` itself.
  child.on('error', (error: Error) => {
    box.fail(`the process could not be started: ${describeError(error)}`);
  });
  child.on('exit', (code, signal) => {
    box.fail(
      `the process exited${signal ? ` on ${signal}` : ` with code ${code ?? 'null'}`}${tail(stderr)}`,
    );
  });

  const hardStop = setTimeout(() => {
    box.fail(`no MCP response within ${budgetMs}ms`);
    child.kill();
  }, budgetMs);
  unref(hardStop);

  try {
    checks.push(`spawned ${command} and spoke JSON-RPC 2.0 on its stdio`);
    write(child, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO },
    });

    const initialized = await box.take(1, deadline.remaining());
    if (!initialized) {
      // A pipe that is still open means the process started and simply did not
      // answer; that is a real, different fact from "the command is missing".
      if (box.reason === null) {
        return unverified(
          target,
          `the process started and stayed alive for ${budgetMs}ms but never answered initialize`,
          checks,
          'the MCP protocol was never spoken to, so the tool list and its size are unknown',
          tail(stderr),
        );
      }
      return unreachable(target, `${box.reason}; tools/list was never reached`, checks, tail(stderr));
    }
    if (initialized.error) {
      return unreachable(
        target,
        `the server rejected initialize: ${initialized.error.message ?? 'no message'}`,
        checks,
        tail(stderr),
      );
    }

    const peer = initialized.result;
    const serverInfo = readServerInfo(peer);
    checks.push(`initialize accepted${serverInfo ? ` by ${serverInfo}` : ''}`);

    // The spec requires this notification before any other request.
    write(child, { jsonrpc: '2.0', method: 'notifications/initialized' });

    write(child, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    checks.push('tools/list requested');

    const listed = await box.take(2, deadline.remaining());
    if (!listed) {
      return unverified(
        target,
        box.reason ?? `the process stayed alive but tools/list did not answer within ${budgetMs}ms`,
        checks,
        'the tool list and its size are unknown',
        tail(stderr),
      );
    }
    if (listed.error) {
      return unverified(
        target,
        `the server answered tools/list with an error: ${listed.error.message ?? 'no message'}`,
        checks,
        'the tool list is unknown',
        tail(stderr),
      );
    }

    const tools = readTools(listed.result);
    if (tools === null) {
      return unverified(
        target,
        'tools/list answered but the result contained no `tools` array, so this is not the MCP protocol we can verify',
        checks,
        'the tool list is unknown',
        tail(stderr),
      );
    }

    checks.push(`tools/list returned ${tools.length} tool(s)`);
    return {
      id: target.id,
      ok: true,
      toolCount: tools.length,
      outcome: 'handshake',
      checks,
      notVerified: '',
      reason: undefined,
      serverInfo,
      latencyMs: 0,
    };
  } finally {
    clearTimeout(hardStop);
    child.stdin.end();
    child.kill();
  }
}

// ---------------------------------------------------------------------------
// http (Streamable HTTP)
// ---------------------------------------------------------------------------

async function probeHttp(target: McpProbeTarget, budgetMs: number): Promise<McpProbeResult> {
  const url = target.url?.trim() ?? '';
  const checks: string[] = [];
  if (!url) {
    return unreachable(target, 'no URL is configured for this http server', checks);
  }

  let endpoint: URL;
  try {
    endpoint = new URL(url);
  } catch {
    return unreachable(target, `"${url}" is not a valid URL`, checks);
  }

  const deadline = new Deadline(budgetMs);
  let sessionId: string | null = null;

  const post = async (message: unknown, timeoutMs: number): Promise<JsonRpcMessage | null> => {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      // Streamable HTTP servers may answer either way; we have to take both.
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': PROTOCOL_VERSION,
    };
    if (sessionId) headers['mcp-session-id'] = sessionId;

    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
    });
    const issued = response.headers.get('mcp-session-id');
    if (issued) sessionId = issued;

    if (!response.ok) {
      const body = (await readBody(response, deadline.remaining())).trim();
      throw new Error(
        `HTTP ${response.status} ${response.statusText}`.trim() +
          (body ? `: ${body.slice(0, BODY_SNIPPET)}` : ''),
      );
    }
    return readJsonRpc(await readBody(response, deadline.remaining()));
  };

  checks.push(`POST initialize to ${endpoint.origin}${endpoint.pathname}`);
  let initialized: JsonRpcMessage | null;
  try {
    initialized = await post(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO },
      },
      deadline.remaining(),
    );
  } catch (error) {
    return unreachable(target, describeError(error), checks);
  }
  if (!initialized) {
    return unverified(
      target,
      `the server accepted the connection but returned no JSON-RPC body to initialize`,
      checks,
      'the MCP protocol was never confirmed',
    );
  }
  if (initialized.error) {
    return unreachable(
      target,
      `the server rejected initialize: ${initialized.error.message ?? 'no message'}`,
      checks,
    );
  }

  const serverInfo = readServerInfo(initialized.result);
  checks.push(`initialize accepted${serverInfo ? ` by ${serverInfo}` : ''}`);

  // Best-effort notification: 202 Accepted with an empty body is the normal
  // answer, and a server that dislikes it must not fail the whole test.
  try {
    await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, deadline.remaining());
  } catch {
    // Ignored on purpose — see above.
  }

  checks.push('tools/list requested');
  let listed: JsonRpcMessage | null;
  try {
    listed = await post(
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      deadline.remaining(),
    );
  } catch (error) {
    return unverified(target, describeError(error), checks, 'the tool list is unknown');
  }
  if (!listed) {
    return unverified(
      target,
      `tools/list returned no JSON-RPC body within ${budgetMs}ms`,
      checks,
      'the tool list is unknown',
    );
  }
  if (listed.error) {
    return unverified(
      target,
      `the server answered tools/list with an error: ${listed.error.message ?? 'no message'}`,
      checks,
      'the tool list is unknown',
    );
  }

  const tools = readTools(listed.result);
  if (tools === null) {
    return unverified(
      target,
      'tools/list answered but the result contained no `tools` array, so this is not the MCP protocol we can verify',
      checks,
      'the tool list is unknown',
    );
  }
  checks.push(`tools/list returned ${tools.length} tool(s)`);
  return {
    id: target.id,
    ok: true,
    toolCount: tools.length,
    outcome: 'handshake',
    checks,
    notVerified: '',
    reason: undefined,
    serverInfo,
    latencyMs: 0,
  };
}

// ---------------------------------------------------------------------------
// result builders
// ---------------------------------------------------------------------------

function unreachable(
  target: McpProbeTarget,
  reason: string,
  checks: string[],
  stderrTail = '',
): McpProbeResult {
  const full = `${reason}${stderrTail}`.trim();
  return {
    id: target.id,
    ok: false,
    toolCount: 0,
    outcome: 'unreachable',
    checks,
    notVerified: 'the server was never reached, so nothing about it is known',
    reason: full.length > 0 ? full : 'the probe ended without reaching the server',
    latencyMs: 0,
  };
}

function unverified(
  target: McpProbeTarget,
  reason: string,
  checks: string[],
  notVerified: string,
  stderrTail = '',
): McpProbeResult {
  const full = `${reason}${stderrTail}`.trim();
  return {
    id: target.id,
    ok: false,
    // Never a number we did not observe: an unknown count stays 0 and says so.
    toolCount: 0,
    outcome: 'unverified',
    checks,
    notVerified,
    reason: full.length > 0 ? full : 'the probe could not confirm the MCP protocol',
    latencyMs: 0,
  };
}

// ---------------------------------------------------------------------------
// JSON-RPC plumbing
// ---------------------------------------------------------------------------

interface JsonRpcMessage {
  id?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string };
}

interface Waiter {
  id: number;
  resolve: (message: JsonRpcMessage | null) => void;
  timer: NodeJS.Timeout;
}

/**
 * A newline-delimited JSON-RPC reader over a child process' stdout.
 *
 * Non-JSON lines are skipped rather than treated as an error: plenty of real
 * servers print a banner on stdout, and refusing to start over that would be a
 * false negative on a server that is working.
 */
class MessageBox {
  private buffer = '';
  private readonly messages: JsonRpcMessage[] = [];
  private readonly waiters: Waiter[] = [];
  private failure: string | null = null;

  /** why the pipe died, if it did; `null` while it is still alive */
  get reason(): string | null {
    return this.failure;
  }

  push(text: string): void {
    this.buffer += text;
    for (let index = this.buffer.indexOf('\n'); index >= 0; index = this.buffer.indexOf('\n')) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (typeof parsed === 'object' && parsed !== null) {
          this.deliver(parsed as JsonRpcMessage);
        }
      } catch {
        // Not a JSON-RPC frame; see the class comment.
      }
    }
  }

  fail(reason: string): void {
    if (this.failure === null) {
      this.failure = reason;
    }
    for (const waiter of this.waiters.splice(0)) settle(waiter, null);
    this.messages.length = 0;
  }

  async take(id: number, timeoutMs: number): Promise<JsonRpcMessage | null> {
    const queued = this.messages.findIndex((message) => message.id === id);
    const hit = queued >= 0 ? this.messages.splice(queued, 1)[0] : undefined;
    if (hit) return hit;
    if (this.failure !== null || timeoutMs <= 0) return null;

    return new Promise<JsonRpcMessage | null>((resolve) => {
      const waiter: Waiter = { id, resolve, timer: setTimeout(() => {
        const at = this.waiters.indexOf(waiter);
        if (at >= 0) this.waiters.splice(at, 1);
        resolve(null);
      }, timeoutMs) };
      unref(waiter.timer);
      this.waiters.push(waiter);
    });
  }

  private deliver(message: JsonRpcMessage): void {
    for (let i = 0; i < this.waiters.length; i += 1) {
      const waiter = this.waiters[i];
      if (waiter && waiter.id === message.id) {
        this.waiters.splice(i, 1);
        settle(waiter, message);
        return;
      }
    }
    this.messages.push(message);
  }
}

function settle(waiter: Waiter, message: JsonRpcMessage | null): void {
  clearTimeout(waiter.timer);
  waiter.resolve(message);
}

function write(child: ChildProcessWithoutNullStreams, message: unknown): void {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

class Deadline {
  private readonly endAt: number;

  constructor(budgetMs: number) {
    this.endAt = Date.now() + budgetMs;
  }

  remaining(): number {
    return Math.max(0, this.endAt - Date.now());
  }
}

// ---------------------------------------------------------------------------
// response reading
// ---------------------------------------------------------------------------

/** Bounded so a server that streams an SSE body forever cannot hang the probe. */
async function readBody(response: Response, timeoutMs: number): Promise<string> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      response.text(),
      new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve(''), Math.max(1, timeoutMs));
        unref(timer);
      }),
    ]);
  } catch {
    return '';
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Accepts a plain JSON body and an SSE `data:` frame, as Streamable HTTP allows both. */
function readJsonRpc(body: string): JsonRpcMessage | null {
  const trimmed = body.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return asMessage(parseJson(trimmed));
  }
  for (const line of trimmed.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const parsed = asMessage(parseJson(line.slice(5).trim()));
    if (parsed) return parsed;
  }
  return null;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function asMessage(value: unknown): JsonRpcMessage | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  // Only a response carries the members we asked for.
  if (!('id' in record) && !('error' in record) && !('result' in record)) return null;
  return record as JsonRpcMessage;
}

function readTools(result: unknown): unknown[] | null {
  if (typeof result !== 'object' || result === null) return null;
  const tools = (result as Record<string, unknown>)['tools'];
  return Array.isArray(tools) ? tools : null;
}

function readServerInfo(result: unknown): string | undefined {
  if (typeof result !== 'object' || result === null) return undefined;
  const info = (result as Record<string, unknown>)['serverInfo'];
  if (typeof info !== 'object' || info === null) return undefined;
  const record = info as Record<string, unknown>;
  const name = typeof record['name'] === 'string' ? record['name'] : null;
  const version = typeof record['version'] === 'string' ? record['version'] : null;
  if (name === null) return undefined;
  return version ? `${name}@${version}` : name;
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function tail(stderr: string[]): string {
  const text = stderr.join('').trim();
  return text ? ` — stderr: ${text.slice(0, BODY_SNIPPET)}` : '';
}

function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const code = (error as NodeJS.ErrnoException).code;
  const cause = error.cause instanceof Error ? describeError(error.cause) : null;
  // `spawn` already puts ENOENT in the message; do not say it twice.
  const head = code && !error.message.includes(code) ? `${error.message} (${code})` : error.message;
  const parts = [head];
  if (cause && cause !== head) parts.push(cause);
  return parts.join(' / ');
}

/** A pending probe must never be the reason the process stays alive. */
function unref(timer: NodeJS.Timeout): void {
  timer.unref?.();
}
