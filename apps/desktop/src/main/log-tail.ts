/**
 * The log tail the Diagnostics page shows.
 *
 * Its own module for one reason: `ipc.ts` imports `electron`, so a Node test
 * cannot import the mapping from there. The mapping is the part with a claim to
 * uphold — that what crosses to the Renderer is redacted, narrow, and in a
 * useful order — so it has to be reachable by a test that can actually run.
 *
 * ## What "redacted" means here
 *
 * Nothing. That is the point, and it is worth being explicit rather than
 * reassuring: this function does no redaction, and adding any would be a
 * mistake, because the logger redacts every record *before* it reaches a sink
 * (NFR-08). Re-redacting here would mean trusting a second implementation of
 * the same rule, and the first one is the one that runs on every write. The
 * guarantee this function does make is structural: it copies four fields out of
 * each record and drops the rest, so a field added to `LogRecord` later is not
 * accidentally shipped to the Renderer just because someone extended this.
 */

import type { LogEntryDto } from '@ucad/contracts';
import type { LogRecord } from '@ucad/observability';

/**
 * How many lines the page shows.
 *
 * Enough to cover a launch and the failure that followed it, few enough that
 * the page stays readable and the IPC payload stays small. The sink holds
 * 2000; this is a view, not an archive — the file on disk is the archive, and
 * its path is on the same screen.
 */
export const RECENT_LOG_LINES = 200;

/**
 * The most recent records, newest first.
 *
 * Newest first because this is a page someone opens *because something just
 * happened*: the answer is at the top, not at the bottom of a scroll. The
 * underlying file grows downward, and a reader comparing the two should not
 * have to remember which end is which — the page says so where it renders.
 */
export function recentLogEntries(
  records: readonly LogRecord[],
  limit: number = RECENT_LOG_LINES,
): LogEntryDto[] {
  return records
    .slice(-limit)
    .reverse()
    .map((rec) => ({ ts: rec.ts, level: rec.level, scope: rec.scope, msg: rec.msg }));
}
