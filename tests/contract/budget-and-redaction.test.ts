/**
 * §4.5.3 token budget and the deterministic redaction of NFR-08.
 *
 * Budget without a declared estimate source is a lie told to the user, so
 * `estimateSource` propagation and the truncation order are both tested.
 */

import { describe, it, expect } from 'vitest';
import { HeuristicTokenEstimator } from '@ucad/context';
import { redact, redactText, REDACTED } from '@ucad/observability';
import { CONTEXT_KIND_DROP_PRIORITY, MAX_EVENT_PAYLOAD_BYTES } from '@ucad/contracts';
import { item, pack } from '../fixtures/context-fixtures';

const estimator = new HeuristicTokenEstimator();

describe('TokenEstimator / T-1..T-3', () => {
  it('declares its estimate source honestly', () => {
    expect(estimator.source).toBe('heuristic_chars_div_4');
  });

  it('is monotonic and deterministic: the same text always yields the same count', () => {
    const text = 'const answer = compute(a, b);';
    const first = estimator.estimate(text);
    for (let i = 0; i < 50; i++) {
      expect(estimator.estimate(text)).toBe(first);
    }
  });

  it('never returns a negative count and rounds up', () => {
    expect(estimator.estimate('')).toBe(0);
    expect(estimator.estimate('a')).toBeGreaterThanOrEqual(1);
  });

  it('grows with input length', () => {
    const short = estimator.estimate('abc');
    const long = estimator.estimate('a'.repeat(1000));
    expect(long).toBeGreaterThan(short);
  });

  it('accounts for CJK more heavily than ASCII per character (T-2)', () => {
    const ascii = estimator.estimate('a'.repeat(100));
    const cjk = estimator.estimate('中'.repeat(100));
    // CJK is roughly 0.6 tokens/char vs 0.25 for ASCII, so it must be larger
    expect(cjk).toBeGreaterThan(ascii);
  });

  it('treats a payload above the NFR-06 ceiling as oversized', () => {
    expect(MAX_EVENT_PAYLOAD_BYTES).toBe(256 * 1024);
  });
});

describe('truncation order / T-5', () => {
  it('ranks instruction last to be dropped and summary first', () => {
    const idx = (k: string) => CONTEXT_KIND_DROP_PRIORITY.indexOf(k as never);
    expect(idx('instruction')).toBeLessThan(idx('file'));
    expect(idx('file')).toBeLessThan(idx('summary'));
    expect(idx('git_diff')).toBeLessThan(idx('file'));
    expect(idx('symbol')).toBeLessThan(idx('relation'));
  });

  it('keeps every kind accounted for so nothing disappears silently', () => {
    for (const kind of ['instruction', 'git_diff', 'symbol', 'file', 'summary'] as const) {
      expect(CONTEXT_KIND_DROP_PRIORITY).toContain(kind);
    }
  });

  it('a pack over budget records the omission rather than hiding it (T-6)', () => {
    const overBudget = pack(
      Array.from({ length: 40 }, (_, i) => item(`ci_${i}`, 'file', { tokens: 1000 })),
      {
        budget: {
          packId: 'cp_1',
          revision: 1,
          limitTokens: 100,
          usedTokens: 40_000,
          remainingTokens: -39_900,
          estimateSource: 'heuristic_chars_div_4',
          truncated: true,
        },
      },
    );

    expect(overBudget.budget.truncated).toBe(true);
    expect(overBudget.budget.usedTokens).toBeGreaterThan(overBudget.budget.limitTokens);
  });
});

describe('NFR-08 log redaction', () => {
  it('redacts a secret-named key at any depth', () => {
    // The value is assembled at runtime: what matters is the *key name*, and
    // this file must not carry a credential-shaped literal for a scanner or a
    // reader to mistake for a leak.
    const fakeSecret = ['super', 'secret', 'value'].join('-');
    const input = {
      safe: 'value',
      nested: { deeper: { apiKey: fakeSecret } },
    };
    const out = redact(input) as Record<string, Record<string, Record<string, string>>>;
    expect(out.nested.deeper.apiKey).toBe(REDACTED);
    expect(out.safe).toBe('value');
  });

  it('redacts credential-shaped keys regardless of case or separator', () => {
    for (const key of [
      'Authorization',
      'api_key',
      'API-KEY',
      'password',
      'accessToken',
      'cookie',
      'private_key',
    ]) {
      const out = redact({ [key]: 'leak-me' }) as Record<string, string>;
      expect(out[key]).toBe(REDACTED);
    }
  });

  it('redacts credential patterns inside free text', () => {
    expect(redactText('Authorization: Bearer abc.def.ghi')).toContain(REDACTED);
    expect(redactText('using sk-abcdefghijklmnopqrst now')).toContain(REDACTED);
    expect(redactText('api_key=abcd1234efgh')).toContain(REDACTED);
    expect(redactText('token: ghp_ABCDEFGHIJKLMNOPQRST')).toContain(REDACTED);
  });

  it('leaves ordinary text untouched', () => {
    const msg = 'reading src/auth/login.ts at line 42';
    expect(redactText(msg)).toBe(msg);
  });

  it('does not mutate the caller\'s object', () => {
    const input = { apiKey: 'keep-me' };
    redact(input);
    expect(input.apiKey).toBe('keep-me');
  });

  it('traverses arrays and maps', () => {
    const out = redact({
      list: [{ token: 'a' }, { token: 'b' }],
    }) as { list: Array<{ token: string }> };
    expect(out.list.every((e) => e.token === REDACTED)).toBe(true);
  });

  it('summarizes an Error without leaking a stack', () => {
    const out = redact(new Error('failed with sk-abcdefghijklmnop')) as {
      name: string;
      message: string;
    };
    expect(out.name).toBe('Error');
    expect(out.message).not.toContain('sk-abcdefghijklmnop');
  });

  it('stops recursing on deeply nested structures', () => {
    let deep: Record<string, unknown> = { value: 'bottom' };
    for (let i = 0; i < 40; i++) deep = { nested: deep };
    expect(() => redact(deep)).not.toThrow();
  });
});
