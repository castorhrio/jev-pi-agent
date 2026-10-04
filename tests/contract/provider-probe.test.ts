/**
 * The provider probe's honesty contract.
 *
 * The MCP probe already has one of these (`mcp-contract.test.ts`); the
 * *provider* probe — the one that decides whether a vendor can be used at all
 * — had none. It is the surface most able to lie quietly:
 *
 *  - a bad key, an unreachable host and an exhausted quota all look like
 *    "failed", and the user cannot tell which one to go fix;
 *  - `reason` is an English sentence written in the main process, so before
 *    `code` existed the Chinese provider card rendered it verbatim.
 *
 * So the contract is: **every failure carries a stable `code` the Renderer can
 * localise, and an English `reason` for the log.** A failure with no code
 * would silently fall back to a generic string, which is exactly the drift
 * this file exists to prevent.
 *
 * The module is imported from source, so the test exercises the real
 * implementation rather than a built artifact.
 */

import { describe, expect, it } from 'vitest';
import type { AppErrorCode, SecretRef } from '@ucad/contracts';
import { ProviderClient, assertTransportInvariant } from '../../packages/providers/src/client';
import type { SecretLike } from '../../packages/providers/src/client';
import { listProviders } from '../../packages/providers/src/descriptors';

/** A vault holding one key, so `requiresApiKey` providers get past `hasKey`. */
const vaultWith = (value: string | null): SecretLike => ({
  get: async (_ref: SecretRef) => value,
  exists: async (_ref: SecretRef) => value !== null,
});

/** A vault that always throws — the "credential store is broken" case. */
const brokenVault: SecretLike = {
  get: async () => {
    throw new Error('vault unavailable');
  },
  exists: async () => {
    throw new Error('vault unavailable');
  },
};

const silentLogger = {
  child: () => silentLogger,
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as never;

/** A fetch that answers every request with `status` and an empty model list. */
const respondWith = (status: number): typeof fetch =>
  (async () =>
    new Response(JSON.stringify({ data: [] }), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;

/** A fetch that never gets a socket — DNS failure, refused connection, CORS. */
const unreachable: typeof fetch = (async () => {
  throw new TypeError('fetch failed');
}) as typeof fetch;

function clientWith(fetchImpl: typeof fetch, secrets: SecretLike = vaultWith('sk-test')) {
  return new ProviderClient({ logger: silentLogger, secrets, fetchImpl, defaultTimeoutMs: 2000 });
}

describe('provider probe / honesty contract', () => {
  it('a reachable provider is ok and carries no failure code', async () => {
    const result = await clientWith(respondWith(200)).probe('openai');

    expect(result.ok).toBe(true);
    // A success must not smuggle a code: the card would render a healthy
    // badge and a stale reason at the same time.
    expect(result.code).toBeUndefined();
    expect(result.reason).toBeUndefined();
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('401 and 403 are reported as a credential problem, not a network problem', async () => {
    for (const status of [401, 403]) {
      const result = await clientWith(respondWith(status)).probe('openai');
      expect(result.ok, `HTTP ${status}`).toBe(false);
      expect(result.code, `HTTP ${status}`).toBe('AUTH_REQUIRED');
      expect(result.reason, `HTTP ${status}`).toBeTruthy();
    }
  });

  /**
   * 402 is the one case where the product genuinely learns something about
   * quota, so it is pinned separately: it is the value the card turns into
   * "exhausted" instead of "not provided".
   */
  it('402 is reported as an exhausted quota', async () => {
    const result = await clientWith(respondWith(402)).probe('openai');

    expect(result.ok).toBe(false);
    expect(result.code).toBe('BUDGET_EXCEEDED');
  });

  it('429 keeps the rate-limit code distinct from an auth failure', async () => {
    const result = await clientWith(respondWith(429)).probe('openai');

    expect(result.ok).toBe(false);
    // Collapsing 429 into AUTH_REQUIRED would send the user to fix their API
    // key, which cannot fix a rate limit.
    expect(result.code).not.toBe('AUTH_REQUIRED');
    expect(result.code).toBeTruthy();
  });

  it('a transport failure is a network error, not a status', async () => {
    const result = await clientWith(unreachable).probe('openai');

    expect(result.ok).toBe(false);
    expect(result.code).toBe('NETWORK_ERROR');
    expect(result.reason).toBeTruthy();
  });

  it('a missing credential never reaches the network', async () => {
    let called = false;
    const countingFetch: typeof fetch = (async () => {
      called = true;
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    const result = await clientWith(countingFetch, vaultWith(null)).probe('openai');

    expect(result.ok).toBe(false);
    expect(result.code).toBe('AUTH_REQUIRED');
    expect(called).toBe(false);
  });

  it('an unreadable vault is a storage error, not a missing key', async () => {
    const result = await clientWith(respondWith(200), brokenVault).probe('openai');

    expect(result.ok).toBe(false);
    // Telling the user to add an API key when the vault is on fire would send
    // them to re-enter a credential that is already stored and fine.
    expect(result.code).toBe('STORAGE_ERROR');
  });

  it('a provider this build cannot speak is not reported as unreachable', async () => {
    // `anthropic` is `transport: 'unsupported'`. Reporting a network failure
    // would be a lie: no request was attempted.
    const result = await clientWith(respondWith(200)).probe('anthropic');

    expect(result.ok).toBe(false);
    expect(result.code).toBe('ADAPTER_NOT_AVAILABLE');
    expect(result.latencyMs).toBe(0);
  });

  it('an unregistered provider id is refused without inventing a reason', async () => {
    const result = await clientWith(respondWith(200)).probe('ucad-not-a-vendor-9f2a');

    expect(result.ok).toBe(false);
    expect(result.code).toBe('UNKNOWN');
    expect(result.reason).toContain('ucad-not-a-vendor-9f2a');
  });

  /**
   * The blanket rule the individual cases above are instances of. If a new
   * failure path is added without a code, this is what catches it.
   */
  it('every failure carries a code the Renderer can localise', async () => {
    const known: AppErrorCode[] = [
      'AUTH_REQUIRED',
      'BUDGET_EXCEEDED',
      'NETWORK_ERROR',
      'STORAGE_ERROR',
      'ADAPTER_NOT_AVAILABLE',
      'RATE_LIMITED',
      'UNKNOWN',
    ];

    const failures = [
      await clientWith(respondWith(401)).probe('openai'),
      await clientWith(respondWith(402)).probe('openai'),
      await clientWith(respondWith(429)).probe('openai'),
      await clientWith(unreachable).probe('openai'),
      await clientWith(respondWith(200), vaultWith(null)).probe('openai'),
      await clientWith(respondWith(200), brokenVault).probe('openai'),
      await clientWith(respondWith(200)).probe('anthropic'),
      await clientWith(respondWith(200)).probe('ucad-not-a-vendor-9f2a'),
    ];

    for (const result of failures) {
      expect(result.ok).toBe(false);
      expect(result.code, `failure with no code: ${result.reason}`).toBeTruthy();
      expect(known, `unmapped code: ${result.code}`).toContain(result.code as AppErrorCode);
      // The reason is what goes in the log and the diagnostic line, so it must
      // still be a sentence and must never contain the credential.
      expect((result.reason ?? '').length).toBeGreaterThan(0);
      expect(result.reason).not.toContain('sk-test');
    }
  });
});

describe('the transport invariant on provider baseUrls', () => {
  // Mirrors `assertEndpoint` for MCP servers: remote traffic is https,
  // plaintext http only for loopback (the catalogue's Ollama endpoint is
  // exactly that shape). The catalogue itself is asserted against, so a
  // descriptor that drifts off this rule turns the suite red instead of
  // shipping a new network sink.
  it('accepts every baseUrl in the catalogue — https remote, http loopback only', () => {
    // Every entry, no filtering: a descriptor that drifts off the invariant
    // fails here, it does not quietly skip an else-branch.
    for (const p of listProviders()) {
      expect(() => assertTransportInvariant(p.baseUrl, p.id), `${p.id}: ${p.baseUrl}`)
        .not.toThrow();
    }
  });

  it('accepts plaintext http only for loopback, and says no to the rest', () => {
    expect(() => assertTransportInvariant('http://127.0.0.1:11434/v1', 'ollama')).not.toThrow();
    expect(() => assertTransportInvariant('http://localhost:8080/v1', 'local')).not.toThrow();
    expect(() => assertTransportInvariant('http://evil.example.com/v1', 'remote')).toThrow();
    expect(() => assertTransportInvariant('https://api.openai.com/v1', 'openai')).not.toThrow();
  });
});
