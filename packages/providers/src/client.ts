/**
 * `ProviderClient` — the only place in UCAD that speaks a vendor wire protocol.
 *
 * Design constraints that shaped this file:
 *
 *  - **No new dependencies.** Node 22's global `fetch` is the whole transport;
 *    an injectable `fetchImpl` exists so the contract tests can drive a local
 *    mock server (NFR-12: an untested provider is an unverified provider).
 *  - **A credential is read at call time and goes nowhere else.** It is read
 *    from the injected vault (`SecretLike`, satisfied by `SafeStorageSecretStore`
 *    from `@ucad/secrets`), put in one `Authorization` header, and never
 *    logged, never returned, never embedded in an error. Every string that
 *    reaches a user is composed here from a status code and the provider's
 *    display name — vendor response bodies are deliberately not read on
 *    failure, because a body can echo the key back.
 *  - **A stream always ends.** The `for await` loop terminates when the socket
 *    ends, when `[DONE]` arrives, or when no bytes arrive within the idle
 *    budget — a provider that never sends `[DONE]` must not wedge the UI
 *    forever. The final `done: true` chunk is emitted on all three paths.
 *  - **Cancellation is a clean stop, not an error** (§8.2). Aborting ends
 *    iteration and releases the reader; it does not throw at the consumer.
 */

import type { AppError, AppErrorCode, ModelDescriptor, SecretRef } from '@ucad/contracts';
import { appError } from '@ucad/contracts';
import type { Logger } from '@ucad/observability';
import { redactText, ulid } from '@ucad/observability';
import { getProvider, listProviders } from './descriptors';
import type { ProviderDescriptor } from './descriptors';

/**
 * The slice of the §4.10 `SecretStore` this package needs. Declared
 * structurally so `@ucad/providers` does not depend on Electron `safeStorage`;
 * `SafeStorageSecretStore` satisfies it as-is.
 */
export interface SecretLike {
  /** Main / Agent Host only. There is no IPC read channel (NFR-01). */
  get(ref: SecretRef): Promise<string | null>;
  exists(ref: SecretRef): Promise<boolean>;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId?: string;
}

export interface ChatRequest {
  providerId: string;
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxOutputTokens?: number;
  /** defaults to true; `false` forces a single JSON response */
  stream?: boolean;
  signal?: AbortSignal;
}

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  source: 'vendor' | 'computed' | 'unknown';
}

export interface ChatChunk {
  delta: string;
  done: boolean;
  usage?: TokenUsage;
  finishReason?: string;
}

export interface ChatResult {
  text: string;
  usage: TokenUsage;
  model: string;
  finishReason?: string;
  raw?: unknown;
}

export interface ProbeResult {
  ok: boolean;
  reason?: string;
  /**
   * Stable, localisable failure classification. `reason` is an English
   * sentence written for logs; the Renderer must branch on this, not on
   * `reason`, or every probe failure shows up in a Chinese UI as English.
   */
  code?: AppErrorCode;
  latencyMs: number;
}

export interface ProviderClientOptions {
  logger: Logger;
  secrets: SecretLike;
  /**
   * Defaults to the global fetch (Node 22). This is also the seam the contract
   * tests use to point a provider at a local mock server — rewrite the URL
   * here and the catalogue's baseUrls stay untouched:
   * `const fetchImpl: typeof fetch = (i, init) => fetch(String(i).replace(/^https?:\/\/[^/]+/, base), init)`.
   */
  fetchImpl?: typeof fetch;
  /** whole-request ceiling for non-streaming calls. Default 30_000. */
  defaultTimeoutMs?: number;
  /**
   * Ceiling on the gap between two stream events, in ms. Default 60_000 —
   * generous because reasoning models legitimately think silently for a while.
   * A stall aborts the socket and ends the stream instead of hanging the UI.
   */
  streamIdleTimeoutMs?: number;
  /**
   * Send `stream_options: { include_usage: true }`. Default false: not every
   * OpenAI-compatible server accepts the field, and a 400 on every turn is
   * worse than occasionally missing a usage block. Usage that arrives anyway
   * is parsed regardless of this flag.
   */
  includeUsageInStream?: boolean;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 60_000;
const CHAT_PATH = '/chat/completions';
const MODELS_PATH = '/models';

// ---------------------------------------------------------------------------
// small parsing helpers — every vendor field is treated as untrusted
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isAppErrorLike(value: unknown): value is AppError {
  return (
    value !== null &&
    typeof value === 'object' &&
    'code' in value &&
    'component' in value &&
    typeof (value as { message?: unknown }).message === 'string'
  );
}

/**
 * Transport invariant, mirroring `assertEndpoint` for MCP servers: remote
 * traffic is `https:`, plaintext `http:` only for a loopback host (the
 * catalogue's Ollama endpoint is exactly that shape). The baseUrls come from
 * the compiled-in catalogue — this assertion keeps the rule true even if a
 * descriptor ever changes under it, and it is exported so a contract test can
 * prove the rule rejects what it claims to reject.
 */
export function assertTransportInvariant(url: string, providerId: string): void {
  const parsed = new URL(url);
  const loopback =
    parsed.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !loopback) {
    throw appError('ADAPTER_NOT_AVAILABLE', `不允许的供应商地址：${parsed.protocol}//${parsed.host}`, 'agent', {
      details: { providerId, protocol: parsed.protocol },
    });
  }
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}${path}`;
}

/** Let the socket go without reading a body we have decided not to surface. */
async function discardBody(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    /* the connection is being dropped anyway */
  }
}

/** Merged caller / timeout signal. Owns listener cleanup for the caller. */
interface MergedSignal {
  signal: AbortSignal;
  abort(reason: string): void;
  dispose(): void;
}

function mergeSignals(caller: AbortSignal | undefined, timeoutMs: number): MergedSignal {
  const controller = new AbortController();
  const onCallerAbort = (): void => controller.abort(caller?.reason);
  if (caller) {
    if (caller.aborted) onCallerAbort();
    else caller.addEventListener('abort', onCallerAbort, { once: true });
  }
  let timer: NodeJS.Timeout | null = null;
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
    timer.unref();
  }
  return {
    signal: controller.signal,
    abort: (reason: string) => {
      controller.abort(new Error(reason));
    },
    dispose: () => {
      if (timer) clearTimeout(timer);
      if (caller) caller.removeEventListener('abort', onCallerAbort);
    },
  };
}

/**
 * Status → user-safe sentence. One source of truth so `probe()` and the
 * request paths cannot drift into disagreeing about what a 401 means.
 */
function describeStatus(
  provider: ProviderDescriptor,
  status: number,
): { code: AppErrorCode; message: string } {
  if (status === 401 || status === 403) {
    return {
      code: 'AUTH_REQUIRED',
      message:
        `${provider.displayName} rejected the credential (HTTP ${status}). ` +
        'Check the API key in Settings → Providers.',
    };
  }
  if (status === 402) {
    return {
      code: 'BUDGET_EXCEEDED',
      message: `${provider.displayName} refused the request for billing (HTTP 402). Check the account balance.`,
    };
  }
  if (status === 404) {
    return {
      code: 'ADAPTER_NOT_AVAILABLE',
      message:
        `${provider.displayName} has no endpoint at the configured base URL (HTTP 404). ` +
        'Check the base URL and the model id.',
    };
  }
  if (status === 408 || status === 504) {
    return {
      code: 'NETWORK_ERROR',
      message: `${provider.displayName} timed out (HTTP ${status}).`,
    };
  }
  if (status === 429) {
    return {
      code: 'RATE_LIMITED',
      message: `${provider.displayName} is rate limiting this account (HTTP 429). Try again shortly.`,
    };
  }
  if (status >= 500) {
    return {
      code: 'NETWORK_ERROR',
      message: `${provider.displayName} reported a server error (HTTP ${status}).`,
    };
  }
  return {
    code: 'UNKNOWN',
    message: `${provider.displayName} refused the request (HTTP ${status}).`,
  };
}

function statusError(provider: ProviderDescriptor, status: number, endpoint: string): AppError {
  const described = describeStatus(provider, status);
  return appError(described.code, described.message, 'agent', {
    // status + endpoint only. The response body is intentionally absent.
    details: { providerId: provider.id, status, endpoint },
    vendor: { name: provider.id, code: String(status) },
  });
}

/**
 * Transport failure. The underlying error's own message is dropped on purpose:
 * an undici `TypeError` embeds the request URL and a vendor URL can carry a
 * query string, so the message is rebuilt from the provider name only.
 */
function transportError(provider: ProviderDescriptor): AppError {
  return appError('NETWORK_ERROR', `Could not reach ${provider.displayName}.`, 'agent', {
    details: { providerId: provider.id },
    vendor: { name: provider.id },
  });
}

/** §4.11 has no cancellation code; a cancelled turn is reported as a retryable network stop. */
function cancelledError(provider: ProviderDescriptor): AppError {
  return appError(
    'NETWORK_ERROR',
    `The request to ${provider.displayName} was cancelled before it completed.`,
    'agent',
    { details: { providerId: provider.id, cancelled: true }, vendor: { name: provider.id } },
  );
}

/** A vendor usage block, or an honest "I do not know". */
function usageFrom(raw: unknown): TokenUsage {
  const usage = asRecord(raw);
  if (!usage) return { source: 'unknown' };
  const input = asFiniteNumber(usage['prompt_tokens']) ?? asFiniteNumber(usage['input_tokens']);
  const output =
    asFiniteNumber(usage['completion_tokens']) ?? asFiniteNumber(usage['output_tokens']);
  // Partial vendor usage is still vendor usage: keep the half we were given
  // and leave the other side absent rather than deriving a total.
  if (input === undefined && output === undefined) return { source: 'unknown' };
  const out: TokenUsage = { source: 'vendor' };
  if (input !== undefined) out.inputTokens = input;
  if (output !== undefined) out.outputTokens = output;
  return out;
}

const USAGE_UNKNOWN: TokenUsage = { source: 'unknown' };

interface StreamState {
  usage: TokenUsage;
  finishReason?: string;
  done: boolean;
  frames: number;
  deltas: number;
}

type ParsedEvent =
  | { type: 'skip' }
  | { type: 'done' }
  | { type: 'data'; payload: string };

// ---------------------------------------------------------------------------

export class ProviderClient {
  private readonly logger: Logger;
  private readonly secrets: SecretLike;
  private readonly fetchImpl: typeof fetch;
  private readonly defaultTimeoutMs: number;
  private readonly streamIdleTimeoutMs: number;
  private readonly includeUsageInStream: boolean;

  constructor(opts: ProviderClientOptions) {
    this.logger = opts.logger.child('providers');
    this.secrets = opts.secrets;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.streamIdleTimeoutMs = opts.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
    this.includeUsageInStream = opts.includeUsageInStream ?? false;
    if (typeof this.fetchImpl !== 'function') {
      throw new Error('ProviderClient requires a fetch implementation (Node 22 global fetch)');
    }
  }

  /** Every registered provider, including the ones this build cannot call. */
  describeProviders(): ProviderDescriptor[] {
    return listProviders();
  }

  // -------------------------------------------------------------------------
  // models
  // -------------------------------------------------------------------------

  /**
   * `GET {baseUrl}/models` — the cheapest authenticated call a provider
   * offers. Used both for the catalogue and by `probe()`.
   */
  async listModels(providerId: string, signal?: AbortSignal): Promise<ModelDescriptor[]> {
    const callId = ulid('prv_');
    const provider = this.requireProvider(providerId);
    const merged = mergeSignals(signal, this.defaultTimeoutMs);
    try {
      const res = await this.send(provider, 'GET', MODELS_PATH, undefined, false, merged.signal);
      if (!res.ok) {
        await discardBody(res);
        throw statusError(provider, res.status, MODELS_PATH);
      }
      const json = await this.readJson(res, provider, MODELS_PATH);
      const data = asRecord(json)?.['data'];
      if (!Array.isArray(data)) {
        this.logger.warn('provider model list had no data array', { callId, providerId });
        return [];
      }
      const out: ModelDescriptor[] = [];
      for (const entry of data) {
        const id = asString(asRecord(entry)?.['id']);
        if (id === undefined) continue;
        out.push({ id, providerId: provider.id, displayName: id });
      }
      this.logger.info('provider models listed', { callId, providerId, count: out.length });
      return out;
    } finally {
      merged.dispose();
    }
  }

  /**
   * Reachability without spending tokens. Deliberately *not* a completion:
   * "it answers `/models`" and "it can write code" are different claims, and
   * conflating them is how a misconfigured provider looks healthy until the
   * first real turn.
   */
  async probe(providerId: string, signal?: AbortSignal): Promise<ProbeResult> {
    const provider = getProvider(providerId);
    if (provider === undefined) {
      return {
        ok: false,
        code: 'UNKNOWN',
        reason: `No provider named '${providerId}' is registered.`,
        latencyMs: 0,
      };
    }
    if (provider.transport === 'unsupported') {
      // Not probed: there is no wire protocol to probe with. Reporting a
      // network failure here would be a lie, so this is a configuration
      // verdict with zero latency.
      return {
        ok: false,
        code: 'ADAPTER_NOT_AVAILABLE',
        reason:
          `${provider.displayName} cannot be called from this build. ` +
          (provider.unsupportedReason ?? 'No transport is implemented for it.'),
        latencyMs: 0,
      };
    }
    if (provider.requiresApiKey) {
      const configured = await this.hasKey(provider);
      if (!configured.ok) {
        return { ok: false, code: configured.code, reason: configured.reason, latencyMs: 0 };
      }
    }

    const started = Date.now();
    const merged = mergeSignals(signal, this.defaultTimeoutMs);
    try {
      const res = await this.send(provider, 'GET', MODELS_PATH, undefined, false, merged.signal);
      const latencyMs = Date.now() - started;
      if (!res.ok) {
        await discardBody(res);
        // The sentence is built from the status code only — no body, no key.
        const described = describeStatus(provider, res.status);
        this.logger.warn('provider probe failed', { providerId, status: res.status, latencyMs });
        return { ok: false, code: described.code, reason: described.message, latencyMs };
      }
      await discardBody(res);
      this.logger.info('provider probe ok', { providerId, latencyMs });
      return { ok: true, latencyMs };
    } catch (error) {
      const latencyMs = Date.now() - started;
      const appErr = isAppErrorLike(error) ? error : undefined;
      const reason = appErr
        ? appErr.message
        : `Could not reach ${provider.displayName}.`;
      this.logger.warn('provider probe unreachable', { providerId, latencyMs });
      // A classified AppError keeps its own code; anything else is a transport
      // failure by elimination — the request never produced a status line.
      return {
        ok: false,
        code: appErr ? appErr.code : 'NETWORK_ERROR',
        reason,
        latencyMs,
      };
    } finally {
      merged.dispose();
    }
  }

  // -------------------------------------------------------------------------
  // chat
  // -------------------------------------------------------------------------

  /**
   * Async generator so the Renderer can stream (§8.2 events). Argument
   * validation happens on the first `next()`, not at call time.
   *
   * Terminates on: `[DONE]`, end of body, idle budget, or `signal` abort —
   * always with a final `done: true` chunk. Throws an `AppError` for a
   * non-200 or an unparseable body.
   */
  async *stream(req: ChatRequest): AsyncIterable<ChatChunk> {
    const callId = ulid('prv_');
    const provider = this.requireProvider(req.providerId);
    this.assertRequest(req, provider);

    if (req.stream === false) {
      const merged = mergeSignals(req.signal, this.defaultTimeoutMs);
      try {
        const result = await this.requestOnce(req, provider, merged.signal, callId);
        yield {
          delta: result.text,
          done: true,
          usage: result.usage,
          ...(result.finishReason !== undefined ? { finishReason: result.finishReason } : {}),
        };
      } finally {
        merged.dispose();
      }
      return;
    }

    const merged = mergeSignals(req.signal, this.streamIdleTimeoutMs);
    const state: StreamState = { usage: USAGE_UNKNOWN, done: false, frames: 0, deltas: 0 };
    let stalled = false;
    let idleTimer: NodeJS.Timeout | null = null;
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

    const clearIdle = (): void => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = null;
    };
    const armIdle = (): void => {
      clearIdle();
      idleTimer = setTimeout(() => {
        stalled = true;
        merged.abort('stream idle');
      }, this.streamIdleTimeoutMs);
      idleTimer.unref();
    };

    try {
      armIdle();
      const body = this.buildBody(req, true);
      const res = await this.send(
        provider,
        'POST',
        CHAT_PATH,
        body,
        true,
        merged.signal,
        callId,
      );
      if (!res.ok) {
        await discardBody(res);
        throw statusError(provider, res.status, CHAT_PATH);
      }
      const resBody = res.body;
      if (resBody === null) {
        // No body at all: an empty completion is still a completion.
        yield { delta: '', done: true, usage: state.usage };
        return;
      }

      const bodyReader = resBody.getReader();
      reader = bodyReader;
      const decoder = new TextDecoder();
      let buffer = '';

      while (!state.done) {
        let step: Awaited<ReturnType<typeof bodyReader.read>>;
        try {
          step = await bodyReader.read();
        } catch (error) {
          if (stalled || merged.signal.aborted) break;
          throw this.asStreamError(provider, error);
        }
        if (step.done) break;
        if (step.value === undefined) continue;
        armIdle();
        buffer += decoder.decode(step.value, { stream: true });

        let newline = buffer.indexOf('\n');
        while (newline >= 0 && !state.done) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf('\n');
          const event = parseEventLine(line);
          if (event === undefined) continue;
          if (event.type === 'done') {
            state.done = true;
            break;
          }
          if (event.type === 'skip') continue;
          const frame = this.parseJson(event.payload, callId, provider.id);
          if (frame === undefined) continue;
          const delta = this.applyFrame(frame, provider, state, callId);
          if (delta.length > 0) {
            state.deltas += 1;
            yield { delta, done: false };
          }
        }
      }

      // A body that ended without a trailing newline still carries a last frame.
      if (!state.done && buffer.length > 0) {
        const event = parseEventLine(buffer);
        if (event !== undefined && event.type === 'data') {
          const frame = this.parseJson(event.payload, callId, provider.id);
          if (frame !== undefined) {
            const delta = this.applyFrame(frame, provider, state, callId);
            if (delta.length > 0) {
              state.deltas += 1;
              yield { delta, done: false };
            }
          }
        }
      }
    } catch (error) {
      // An abort is a cancellation, not a failure: end cleanly so the UI is
      // not shown a scary error for a turn the user themselves stopped.
      if (stalled || merged.signal.aborted) {
        this.logger.warn('provider stream stopped early', {
          callId,
          providerId: provider.id,
          model: req.model,
          reason: stalled ? 'idle' : 'aborted',
          frames: state.frames,
        });
      } else {
        throw isAppErrorLike(error) ? error : this.asStreamError(provider, error);
      }
    } finally {
      clearIdle();
      if (reader !== null) {
        try {
          await reader.cancel();
        } catch {
          /* the socket is going away regardless */
        }
      }
      merged.dispose();
    }

    if (!state.done) {
      this.logger.warn('provider stream ended without a [DONE] marker', {
        callId,
        providerId: provider.id,
        model: req.model,
        frames: state.frames,
      });
    }
    this.logger.info('provider stream finished', {
      callId,
      providerId: provider.id,
      model: req.model,
      frames: state.frames,
      deltas: state.deltas,
    });
    yield {
      delta: '',
      done: true,
      usage: state.usage,
      ...(state.finishReason !== undefined ? { finishReason: state.finishReason } : {}),
    };
  }

  /** Single JSON round trip. Same errors, same redaction, no SSE. */
  async complete(req: ChatRequest): Promise<ChatResult> {
    const callId = ulid('prv_');
    const provider = this.requireProvider(req.providerId);
    this.assertRequest(req, provider);
    const merged = mergeSignals(req.signal, this.defaultTimeoutMs);
    try {
      return await this.requestOnce(req, provider, merged.signal, callId);
    } finally {
      merged.dispose();
    }
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  private async requestOnce(
    req: ChatRequest,
    provider: ProviderDescriptor,
    signal: AbortSignal,
    callId: string,
  ): Promise<ChatResult> {
    const started = Date.now();
    const res = await this.send(
      provider,
      'POST',
      CHAT_PATH,
      this.buildBody(req, false),
      false,
      signal,
      callId,
    );
    if (!res.ok) {
      await discardBody(res);
      throw statusError(provider, res.status, CHAT_PATH);
    }
    const json = await this.readJson(res, provider, CHAT_PATH);
    const root = asRecord(json);
    const choices = root?.['choices'];
    const first = Array.isArray(choices) ? asRecord(choices[0]) : undefined;
    const message = asRecord(first?.['message']);
    const text = asString(message?.['content']) ?? '';
    const usage = usageFrom(root?.['usage']);
    const finishReason = asString(first?.['finish_reason']);
    const model = asString(root?.['model']) ?? req.model;
    this.logger.info('provider completion finished', {
      callId,
      providerId: provider.id,
      model,
      durationMs: Date.now() - started,
      usageSource: usage.source,
    });
    return {
      text,
      usage,
      model,
      ...(finishReason !== undefined ? { finishReason } : {}),
      raw: json,
    };
  }

  /** One HTTP call. Every rejection is already an `AppError`. */
  private async send(
    provider: ProviderDescriptor,
    method: 'GET' | 'POST',
    path: string,
    body: Record<string, unknown> | undefined,
    streaming: boolean,
    signal: AbortSignal,
    callId?: string,
  ): Promise<Response> {
    const url = joinUrl(provider.baseUrl, path);
    assertTransportInvariant(url, provider.id);
    const headers = await this.authHeaders(provider, streaming);
    try {
      return await this.fetchImpl(url, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal,
      });
    } catch (error) {
      if (callId !== undefined) {
        this.logger.warn('provider request failed', {
          callId,
          providerId: provider.id,
          method,
          path,
        });
      }
      if (signal.aborted) throw cancelledError(provider);
      throw transportError(provider);
    }
  }

  /**
   * The credential enters here and leaves as one header. `requiresApiKey`
   * decides whether it is read at all, so a key stored against a local endpoint
   * is never forwarded to a process on the user's own machine.
   */
  private async authHeaders(
    provider: ProviderDescriptor,
    streaming: boolean,
  ): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: streaming ? 'text/event-stream' : 'application/json',
    };
    if (provider.requiresApiKey) {
      const key = await this.readApiKey(provider);
      headers['authorization'] = `Bearer ${key}`;
    }
    return headers;
  }

  private async readApiKey(provider: ProviderDescriptor): Promise<string> {
    let stored: string | null;
    try {
      stored = await this.secrets.get({ providerId: provider.id, key: provider.secretKey });
    } catch {
      throw appError(
        'STORAGE_ERROR',
        `The credential vault could not be read for ${provider.displayName}.`,
        'storage',
        { details: { providerId: provider.id } },
      );
    }
    const value = (stored ?? '').trim();
    if (value.length === 0) {
      throw appError(
        'AUTH_REQUIRED',
        `No API key is stored for ${provider.displayName}. Add one in Settings → Providers.`,
        'agent',
        { details: { providerId: provider.id, secretKey: provider.secretKey }, vendor: { name: provider.id } },
      );
    }
    return value;
  }

  private async hasKey(
    provider: ProviderDescriptor,
  ): Promise<{ ok: true } | { ok: false; reason: string; code: AppErrorCode }> {
    try {
      const stored = await this.secrets.get({ providerId: provider.id, key: provider.secretKey });
      if ((stored ?? '').trim().length > 0) return { ok: true };
    } catch {
      return {
        ok: false,
        code: 'STORAGE_ERROR',
        reason: `The credential vault could not be read for ${provider.displayName}.`,
      };
    }
    return {
      ok: false,
      code: 'AUTH_REQUIRED',
      reason: `No API key is stored for ${provider.displayName}. Add one in Settings → Providers.`,
    };
  }

  /**
   * The body. Only fields every OpenAI-compatible server accepts are sent:
   * `max_tokens` (not the newer `max_completion_tokens`) and no `tools`,
   * `response_format` or content parts, matching the capability flags.
   */
  private buildBody(req: ChatRequest, streaming: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages.map((message) => {
        const out: Record<string, unknown> = { role: message.role, content: message.content };
        if (message.toolCallId !== undefined) out['toolCallId'] = message.toolCallId;
        return out;
      }),
      stream: streaming,
    };
    if (req.temperature !== undefined) body['temperature'] = req.temperature;
    if (req.maxOutputTokens !== undefined) body['max_tokens'] = req.maxOutputTokens;
    if (streaming && this.includeUsageInStream) {
      body['stream_options'] = { include_usage: true };
    }
    return body;
  }

  /** Parse a response body without ever surfacing the body itself. */
  private async readJson(
    res: Response,
    provider: ProviderDescriptor,
    endpoint: string,
  ): Promise<unknown> {
    let text: string;
    try {
      text = await res.text();
    } catch {
      throw appError(
        'NETWORK_ERROR',
        `The response from ${provider.displayName} could not be read.`,
        'agent',
        { details: { providerId: provider.id, endpoint }, vendor: { name: provider.id } },
      );
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw appError(
        'UNKNOWN',
        `${provider.displayName} returned a response UCAD could not parse.`,
        'agent',
        {
          // byte count only. A vendor error page can contain the request that
          // produced it, and a request carries the key.
          details: { providerId: provider.id, endpoint, bytes: text.length },
          vendor: { name: provider.id },
        },
      );
    }
  }

  /**
   * One SSE frame → the text delta it carries, updating usage / finish reason
   * in place. Throws for an error frame.
   *
   * Only the vendor's machine-readable code is carried into the `AppError`.
   * Its free-text message is deliberately dropped: §4.11 requires `details` to
   * be sanitized and free of raw vendor payloads, and a vendor message is
   * prose that can quote the request that produced it. The code is what the
   * UI matches on anyway ("overloaded_error" ≠ "context length exceeded").
   */
  private applyFrame(
    frame: unknown,
    provider: ProviderDescriptor,
    state: StreamState,
    callId: string,
  ): string {
    state.frames += 1;
    const root = asRecord(frame);
    if (root === undefined) return '';

    const errorNode = asRecord(root['error']);
    if (errorNode !== undefined) {
      const code = asString(errorNode['code']) ?? asString(errorNode['type']);
      const safeCode = code === undefined ? undefined : redactText(code).slice(0, 64);
      this.logger.warn('provider stream error frame', {
        callId,
        providerId: provider.id,
        vendorCode: safeCode,
      });
      throw appError(
        'NETWORK_ERROR',
        `${provider.displayName} ended the stream with an error.`,
        'agent',
        {
          details: {
            providerId: provider.id,
            midStream: true,
            ...(safeCode !== undefined ? { vendorCode: safeCode } : {}),
          },
          vendor: { name: provider.id, ...(safeCode !== undefined ? { code: safeCode } : {}) },
        },
      );
    }

    const usage = usageFrom(root['usage']);
    if (usage.source === 'vendor') state.usage = usage;

    const choices = root['choices'];
    const first = Array.isArray(choices) ? asRecord(choices[0]) : undefined;
    const finishReason = asString(first?.['finish_reason']);
    if (finishReason !== undefined) state.finishReason = finishReason;

    const delta = asRecord(first?.['delta']);
    const text = asString(delta?.['content']) ?? asString(first?.['text']) ?? '';
    return text;
  }

  /** A malformed frame is logged and skipped, never guessed at. */
  private parseJson(payload: string, callId: string, providerId: string): unknown | undefined {
    try {
      return JSON.parse(payload) as unknown;
    } catch {
      this.logger.warn('skipping malformed stream frame', {
        callId,
        providerId,
        bytes: payload.length,
        preview: redactText(payload).slice(0, 120),
      });
      return undefined;
    }
  }

  private asStreamError(provider: ProviderDescriptor, error: unknown): AppError {
    if (isAppErrorLike(error)) return error;
    this.logger.warn('provider stream transport failure', { providerId: provider.id });
    return transportError(provider);
  }

  private requireProvider(providerId: string): ProviderDescriptor {
    const provider = getProvider(providerId);
    if (provider === undefined) {
      throw appError('ADAPTER_NOT_AVAILABLE', `No provider named '${providerId}' is registered.`, 'agent', {
        details: { providerId },
      });
    }
    if (provider.transport === 'unsupported') {
      // Refuse before any socket is opened. Posting an OpenAI-shaped body to
      // a foreign protocol produces a confusing 404 and, on some gateways, a
      // billed but useless request.
      throw appError(
        'ADAPTER_NOT_AVAILABLE',
        `${provider.displayName} is not supported by this build of UCAD. ` +
          (provider.unsupportedReason ?? 'No transport is implemented for it.'),
        'agent',
        { details: { providerId, transport: provider.transport }, vendor: { name: provider.id } },
      );
    }
    return provider;
  }

  private assertRequest(req: ChatRequest, provider: ProviderDescriptor): void {
    if (typeof req.model !== 'string' || req.model.trim().length === 0) {
      throw appError('UNKNOWN', 'A chat request needs a model id.', 'agent');
    }
    if (!Array.isArray(req.messages) || req.messages.length === 0) {
      throw appError('UNKNOWN', 'A chat request needs at least one message.', 'agent');
    }
    if (req.signal?.aborted === true) {
      throw cancelledError(provider);
    }
  }
}

/**
 * SSE line → payload. Handles the `data:` prefix, the optional single space
 * after the colon, `\r\n` line endings, and `: keepalive` comments.
 */
function parseEventLine(line: string): ParsedEvent | undefined {
  const trimmed = line.replace(/\r$/, '');
  if (trimmed.length === 0) return undefined;
  if (trimmed.startsWith(':')) return undefined;
  if (!trimmed.startsWith('data:')) return undefined; // event: / id: / retry:
  const payload = trimmed.slice('data:'.length).trim();
  if (payload.length === 0) return { type: 'skip' };
  if (payload === '[DONE]') return { type: 'done' };
  return { type: 'data', payload };
}
