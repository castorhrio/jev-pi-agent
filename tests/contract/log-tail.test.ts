/**
 * The log tail that crosses to the Renderer.
 *
 * ## Why this is tested at all
 *
 * The red line is "credentials are writable, never readable",
 * and this payload is the newest place that claim could be broken: a log line
 * carries whatever the code that logged it passed, and the Diagnostics page now
 * reads lines out of the process and hands them to the UI. The test is not
 * about the ordering being pretty — it is about what is *allowed to leave*.
 *
 * ## What is actually being asserted
 *
 * That the mapping copies four named fields and drops everything else. That is
 * a structural guarantee rather than a promise: adding a field to `LogRecord`
 * does not ship it to the Renderer, because the copy is explicit. Redaction
 * itself is upstream (the logger scrubs before any sink, NFR-08) and is
 * covered by `at-rest-encryption.test.ts`; duplicating it here would mean
 * trusting a second implementation of the same rule.
 */

import { describe, expect, it } from 'vitest';
import { Logger, MemoryLogSink, type LogRecord } from '@ucad/observability';
import { recentLogEntries, RECENT_LOG_LINES } from '../../apps/desktop/src/main/log-tail';

function record(over: Partial<LogRecord> = {}): LogRecord {
  return {
    ts: '2026-02-11T09:00:00.000Z',
    level: 'info',
    scope: 'ucad',
    msg: 'something happened',
    ...over,
  };
}

describe('the log tail shown on the Diagnostics page', () => {
  /**
   * Fake key values are assembled at runtime rather than written as literals:
   * the tests below exercise the *key names* and the field copying, so the
   * source of this file must not carry a credential-shaped literal — a scanner
   * (or a reader) cannot tell a fixture from a leak.
   */
  const fakeKeyA = ['sk', 'should-never-cross'].join('-');
  const fakeKeyB = ['sk', 'test-abcdef0123456789'].join('-');

  it('carries exactly four fields per line, and nothing else', () => {
    const entries = recentLogEntries([
      record({ meta: { apiKey: fakeKeyA, path: 'C:/secret' } }),
    ]);
    expect(entries).toHaveLength(1);
    expect(Object.keys(entries[0]!).sort()).toEqual(['level', 'msg', 'scope', 'ts']);
  });

  it('does not carry a credential that reached the logger', () => {
    // The real path: a secret is written through the logger, read back out of
    // the sink, and mapped. If any step leaked it, this is where it shows.
    const sink = new MemoryLogSink(50);
    const logger = new Logger({ scope: 'ucad:test', sink });
    logger.info('saving a credential', { apiKey: fakeKeyB });
    logger.error('renderer process gone', { reason: 'crashed' });

    const serialised = JSON.stringify(recentLogEntries(sink.records));
    expect(serialised).not.toContain(fakeKeyB);
    // The message itself survives; only the metadata is dropped.
    expect(serialised).toContain('renderer process gone');
  });

  it('is newest first, because the page is opened *because* something broke', () => {
    const entries = recentLogEntries([
      record({ msg: 'oldest' }),
      record({ msg: 'middle' }),
      record({ msg: 'newest' }),
    ]);
    expect(entries.map((e) => e.msg)).toEqual(['newest', 'middle', 'oldest']);
  });

  it('keeps the newest lines when there are more than it shows', () => {
    const many = Array.from({ length: RECENT_LOG_LINES + 50 }, (_, i) =>
      record({ msg: `line ${i}` }),
    );
    const entries = recentLogEntries(many);
    expect(entries).toHaveLength(RECENT_LOG_LINES);
    expect(entries[0]!.msg).toBe(`line ${many.length - 1}`);
    expect(entries.at(-1)!.msg).toBe(`line ${50}`);
  });

  it('is empty when nothing has been logged, rather than throwing', () => {
    // A fresh install has no records at all, and the page has to survive it —
    // "the log is empty" is a state, not an error.
    expect(recentLogEntries([])).toEqual([]);
  });
});
