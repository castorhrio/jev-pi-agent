/**
 * `diffSummary` is on the turn boundary, so it has two budgets.
 *
 * ## Why this file exists
 *
 * The bridge turned `git status` into a serial loop of `git diff` calls, one
 * subprocess per dirty file, with nothing bounding the loop in time. Two things
 * followed from that, and neither showed up in a test:
 *
 *  - a slow file (a stale index lock, a workspace on a network drive, a huge
 *    binary) held the whole turn open until the git binary returned;
 *  - ten files meant ten spawns back to back, paid in full on every turn, in an
 *    app whose point is that several agents run turns on the same workspace at
 *    the same time.
 *
 * The bounds are the behaviour now: at most `diffConcurrency` diffs in flight,
 * at most `diffDeadlineMs` for the whole summary, and what arrived in time is
 * returned. Everything here asserts one of those, plus the cases that were
 * already right and must stay right: an empty worktree, the `limit`, and a
 * directory that is not a Git repository.
 *
 * The deadline is configurable, which is why these tests are fast: the *default*
 * is a product decision (2s) and the tests pin the mechanism, not the number.
 */

import { describe, it, expect } from 'vitest';
import { GIT_DIFF_STAGE, GitLikeBridge } from '../../apps/desktop/src/main/git-bridge';
import type { GitService } from '@ucad/git';
import type { HeuristicTokenEstimator } from '@ucad/context';
import type { Logger } from '@ucad/observability';

interface DiffCall {
  path: string;
  at: number;
}

interface Harness {
  bridge: GitLikeBridge;
  diffs: DiffCall[];
  logs: Array<{ event: string; fields?: Record<string, unknown> }>;
  maxInFlight: () => number;
  /** how many times `git status` was asked for the file list */
  statusCalls: () => number;
}

/**
 * A `GitService` whose only meaningful method is `diff`.
 *
 * `diff` is supplied per-path by the test — a promise, a delay, or one that
 * never settles — because the questions here are all about *when* a call
 * returns, not about what git printed.
 */
function harness(options: {
  staged?: string[];
  unstaged?: string[];
  untracked?: string[];
  /** per-path behaviour; defaults to a small patch */
  diffFor?: (path: string) => Promise<{ patch: string; binary: boolean }>;
  /** `status` throws, the way a non-repository does */
  statusFails?: boolean;
  /**
   * `status` throws *synchronously*, before returning a promise — the shape a
   * service that validates its input has, and the one path where a subprocess
   * was never spawned at all.
   */
  statusThrowsSynchronously?: boolean;
  /** `status` never returns, the way a stale index lock does */
  statusHangs?: boolean;
  /** `status` returns, but only after this many ms — the deadline may beat it */
  statusSlowMs?: number;
  /**
   * `status` is slow only from this 1-based call on; earlier calls answer
   * immediately. Lets one test hold a late status from one call and a late
   * diff from another in the same bridge's log.
   */
  statusSlowFromCall?: { call: number; ms: number };
  /**
   * `status` *fails*, but only after this many ms — the deadline may beat it.
   *
   * Slow is not hung, and a slow failure is not a fast one: `statusFails`
   * rejects before the deadline is anywhere near, so it is refused and never
   * reaches the late-status log; this option is the rejected promise that
   * lands after the summary was already returned.
   */
  statusSlowFailsMs?: number;
  diffConcurrency?: number;
  diffDeadlineMs?: number;
}): Harness {
  const diffs: DiffCall[] = [];
  const logs: Array<{ event: string; fields?: Record<string, unknown> }> = [];
  let inFlight = 0;
  let peak = 0;
  let statusCalls = 0;

  const status = async () => {
    statusCalls += 1;
    if (options.statusThrowsSynchronously) throw new Error('status called before resolveRoot');
    if (options.statusFails) throw new Error('fatal: not a git repository');
    if (options.statusHangs) return new Promise<never>(() => {});
    const staged = (options.staged ?? []).map((path) => ({ path, status: 'M' }));
    const unstaged = (options.unstaged ?? []).map((path) => ({ path, status: 'M' }));
    const untracked = options.untracked ?? [];
    const dto = {
      branch: 'main',
      head: 'deadbee',
      dirty: staged.length + unstaged.length + untracked.length > 0,
      staged,
      unstaged,
      untracked,
    };
    // Slow is not hung: the answer arrives, and arrives too late. That is a
    // different case from a lock that never lets go, and the log has to tell
    // them apart.
    const slowMs =
      options.statusSlowMs ??
      (options.statusSlowFromCall && statusCalls >= options.statusSlowFromCall.call
        ? options.statusSlowFromCall.ms
        : undefined);
    if (slowMs !== undefined) return after(slowMs, dto);
    // A rejection that arrives too late to be refused: the summary has already
    // returned, and there is no caller left to hand the error to.
    if (options.statusSlowFailsMs !== undefined) {
      return after(options.statusSlowFailsMs, undefined).then(() => {
        throw new Error('fatal: unable to read index.lock');
      });
    }
    return dto;
  };

  const git = {
    status: options.statusThrowsSynchronously
      ? () => {
          statusCalls += 1;
          throw new Error('status called before resolveRoot');
        }
      : status,
    diff: async (input: { path?: string }) => {
      const path = input.path ?? '';
      const startedAt = Date.now();
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      diffs.push({ path, at: startedAt });
      try {
        const result = options.diffFor
          ? await options.diffFor(path)
          : { patch: `--- a/${path}\n+++ b/${path}\n`, binary: false };
        return { ...result, path, staged: false, truncated: false };
      } finally {
        inFlight -= 1;
      }
    },
  } as unknown as GitService;

  // `estimate` is the contract the bridge charges against the turn budget; the
  // heuristic itself is tested in `budget.test.ts`, so four characters per token
  // is all this stub needs to be.
  const estimator = {
    source: 'heuristic_chars_div_4',
    estimate: (text: string) => Math.ceil(text.length / 4),
  } as unknown as HeuristicTokenEstimator;

  const logger = {
    debug: (event: string, fields?: Record<string, unknown>) => {
      logs.push({ event, fields });
    },
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => logger,
  } as unknown as Logger;

  const bridge = new GitLikeBridge({
    git,
    estimator,
    logger,
    resolveRoot: () => '/repo',
    ...(options.diffConcurrency !== undefined ? { diffConcurrency: options.diffConcurrency } : {}),
    ...(options.diffDeadlineMs !== undefined ? { diffDeadlineMs: options.diffDeadlineMs } : {}),
  });

  return { bridge, diffs, logs, maxInFlight: () => peak, statusCalls: () => statusCalls };
}

/** A diff that resolves after `ms`. */
function after<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

const patch = (path: string) => ({ patch: `--- a/${path}\n+++ b/${path}\n`, binary: false });

describe('git diffSummary — what it returns', () => {
  it('returns nothing for a clean worktree, without spawning a diff', async () => {
    const h = harness({});
    await expect(h.bridge.diffSummary({ workspaceId: 'ws_1' })).resolves.toEqual([]);
    expect(h.diffs).toEqual([]);
  });

  it('drops binary files and empty patches', async () => {
    const h = harness({
      unstaged: ['src/a.ts', 'assets/logo.bin', 'src/empty.ts'],
      diffFor: async (path) => {
        if (path === 'assets/logo.bin') return { patch: 'Binary files differ', binary: true };
        if (path === 'src/empty.ts') return { patch: '   ', binary: false };
        return patch(path);
      },
    });

    const summary = await h.bridge.diffSummary({ workspaceId: 'ws_1' });

    // A binary patch in a context pack is tokens spent on nothing a model can
    // read, and an empty one is a `git_diff` item that says "nothing", twice.
    expect(summary.map((item) => item.path)).toEqual(['src/a.ts']);
    expect(summary[0]?.tokens).toBeGreaterThan(0);
  });

  it('honours `limit` before spawning anything', async () => {
    const h = harness({
      staged: ['a.ts', 'b.ts'],
      unstaged: ['c.ts', 'd.ts'],
      untracked: ['e.ts'],
    });

    const summary = await h.bridge.diffSummary({ workspaceId: 'ws_1', limit: 2 });

    // Status order, not completion order: staged first, then unstaged, then
    // untracked — which is what the caller reads as "the work in progress".
    expect(summary.map((item) => item.path)).toEqual(['a.ts', 'b.ts']);
    expect(h.diffs.map((call) => call.path)).toEqual(['a.ts', 'b.ts']);
  });

  it('keeps status order even though the diffs finish out of order', async () => {
    const h = harness({
      unstaged: ['slow.ts', 'fast.ts', 'medium.ts'],
      diffFor: async (path) => {
        const delays: Record<string, number> = { 'slow.ts': 30, 'medium.ts': 15, 'fast.ts': 0 };
        return after(delays[path] ?? 0, patch(path));
      },
    });

    const summary = await h.bridge.diffSummary({ workspaceId: 'ws_1' });

    // Concurrency must not be visible in the answer. A summary that reshuffled
    // between turns would read as "the repository changed".
    expect(summary.map((item) => item.path)).toEqual(['slow.ts', 'fast.ts', 'medium.ts']);
  });
});

describe('git diffSummary — the bounds', () => {
  it('runs at most `diffConcurrency` diffs at once and still collects them all', async () => {
    const paths = Array.from({ length: 10 }, (_, i) => `src/f${i}.ts`);
    const h = harness({
      unstaged: paths,
      // Long enough that a serial loop would take 10 * 5ms and any worker
      // overlap is visible in the peak.
      diffFor: async (path) => after(5, patch(path)),
      diffConcurrency: 4,
    });

    const summary = await h.bridge.diffSummary({ workspaceId: 'ws_1', limit: 10 });

    expect(summary).toHaveLength(10);
    expect(h.maxInFlight(), 'the concurrency cap was not respected').toBeLessThanOrEqual(4);
    // Guard against a cap that is really "one at a time": the point of the
    // change was to overlap the spawns, not merely to count them.
    expect(h.maxInFlight()).toBeGreaterThan(1);
  });

  it('stops at the deadline and returns the part that arrived in time', async () => {
    const h = harness({
      unstaged: ['a.ts', 'b.ts', 'c.ts', 'c-hangs.ts'],
      diffFor: async (path) => {
        if (path === 'c-hangs.ts') return new Promise<never>(() => {});
        return after(1, patch(path));
      },
      diffConcurrency: 4,
      diffDeadlineMs: 25,
    });

    const startedAt = Date.now();
    const summary = await h.bridge.diffSummary({ workspaceId: 'ws_1' });

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    // The three that answered are in the answer; the hung one is not, and no
    // placeholder stands in for it.
    expect(summary.map((item) => item.path)).toEqual(['a.ts', 'b.ts', 'c.ts']);
    const stopped = h.logs.find((line) => line.event === 'git diff summary stopped at its deadline');
    expect(stopped, 'a short summary was returned with no log line explaining it').toBeDefined();
    expect(stopped!.fields?.collected).toBe(3);
    expect(stopped!.fields?.requested).toBe(4);
    // The number that was missing: three files answered, and `c-hangs.ts` was
    // still inside a subprocess when the deadline fired. Without it, a summary
    // truncated by a hang and a workspace with four dirty files where one was
    // binary read the same in the log.
    expect(stopped!.fields?.abandoned).toBe(1);
    expect(stopped!.fields?.inFlight).toBe(1);
  });

  it('does not call a binary patch that answered in time "abandoned"', async () => {
    const h = harness({
      unstaged: ['a.ts', 'assets/logo.bin', 'c-hangs.ts'],
      diffFor: async (path) => {
        if (path === 'c-hangs.ts') return new Promise<never>(() => {});
        if (path === 'assets/logo.bin') return { patch: 'Binary files differ', binary: true };
        return patch(path);
      },
      diffConcurrency: 4,
      diffDeadlineMs: 25,
    });

    await h.bridge.diffSummary({ workspaceId: 'ws_1' });

    const stopped = h.logs.find((line) => line.event === 'git diff summary stopped at its deadline');
    expect(stopped).toBeDefined();
    // One item collected, two paths answered (the binary came back and was
    // dropped on purpose), one path never answered. `requested - collected`
    // would say 2 abandoned; the subprocess count says 1.
    expect(stopped!.fields?.collected).toBe(1);
    expect(stopped!.fields?.answered).toBe(2);
    expect(stopped!.fields?.abandoned).toBe(1);
    expect(stopped!.fields?.inFlight).toBe(1);
    // The difference between "answered" and "collected" is named rather than
    // left for the reader to subtract. Here it is exactly the binary: it
    // answered in time and was dropped for a reason that is not a hang.
    expect(stopped!.fields?.droppedEmptyOrBinary).toBe(1);
    // And the closed form holds with the new field in it:
    // answered = collected + droppedEmptyOrBinary.
    expect(
      (stopped!.fields?.collected as number) + (stopped!.fields?.droppedEmptyOrBinary as number),
    ).toBe(stopped!.fields?.answered);
  });

  it('reaches the deadline when `git status` is the call that hangs', async () => {
    // `status` is the first subprocess of the summary, so it is the one a stale
    // index lock stops. The documented budget is for the whole summary; when
    // `status` sat outside the race the doc said "2s" and the call could hang
    // until the app was closed.
    const h = harness({ statusHangs: true, diffDeadlineMs: 25 });

    const startedAt = Date.now();
    const summary = await h.bridge.diffSummary({ workspaceId: 'ws_1' });

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    // Nothing was listed, so there is nothing to return — and no `git diff`
    // was spawned for a path nobody knows.
    expect(summary).toEqual([]);
    expect(h.diffs).toEqual([]);
    const stopped = h.logs.find((line) => line.event === 'git diff summary stopped at its deadline');
    expect(stopped, 'a hung `git status` returned an empty summary with no explanation').toBeDefined();
    // The stage is named: "the summary is empty" has two very different causes
    // (a clean worktree, a hung status) and this field tells them apart.
    expect(stopped!.fields?.stage).toBe('status');
    expect(stopped!.fields?.requested).toBe(0);
  });

  it('drops the answer of a `git status` that came back after the deadline', async () => {
    // Slow is not hung. The `git status` answers — it just answers too late,
    // after the summary was already returned empty. Three things have to hold:
    // the late answer changes nothing, the subprocess that is still out there
    // is visible, and the summary does not pretend the worktree was clean.
    const h = harness({ statusSlowMs: 60, diffDeadlineMs: 25 });

    const startedAt = Date.now();
    const summary = await h.bridge.diffSummary({ workspaceId: 'ws_1' });

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(summary).toEqual([]);
    // The status was asked once and no diff was spawned for a path nobody
    // listed — a late answer must not start the diff stage behind the
    // caller's back.
    expect(h.statusCalls()).toBe(1);
    expect(h.diffs).toEqual([]);

    const stopped = h.logs.find((line) => line.event === 'git diff summary stopped at its deadline');
    expect(stopped, 'a `git status` that missed the deadline returned an empty summary with no explanation')
      .toBeDefined();
    expect(stopped!.fields?.stage).toBe('status');
    expect(stopped!.fields?.requested).toBe(0);
    // The subprocess is still running and cannot be cancelled, so the log has
    // to say so. `inFlight: 0` here would claim the workspace was quiet while
    // a git process was still out there.
    expect(stopped!.fields?.statusInFlight).toBe(true);
    expect(stopped!.fields?.inFlight).toBe(1);

    // And when the late answer lands, it lands on nothing: no diff is
    // spawned, no second log line, and the answer already returned stays the
    // answer.
    await after(120, undefined);
    expect(h.diffs).toEqual([]);
    expect(h.logs.filter((line) => line.event.includes('deadline'))).toHaveLength(1);
  });

  it('records the `git status` that answered late, and says the process is gone', async () => {
    // The deadline line is a *snapshot*: `statusInFlight: true` says the
    // subprocess was still out there at that moment, which is true and also
    // the end of the story — nothing anywhere said what became of it. A git
    // process that finished a moment later and one that is still hanging on a
    // stale lock call for different reactions, and the log could not tell
    // them apart.
    const h = harness({ statusSlowMs: 60, diffDeadlineMs: 25 });

    await h.bridge.diffSummary({ workspaceId: 'ws_1' });

    const stopped = h.logs.find((line) => line.event === 'git diff summary stopped at its deadline');
    expect(stopped).toBeDefined();
    // The snapshot at the deadline: still running, and it cannot be
    // cancelled.
    expect(stopped!.fields?.statusInFlight).toBe(true);

    // Now the status answers, late.
    await after(120, undefined);

    const discarded = h.logs.find(
      (line) => line.event === 'git diff summary discarded a late status answer',
    );
    expect(discarded, 'the late status answer left no trace at all').toBeDefined();
    // Its own stage name: the deadline line is the snapshot of a summary that
    // gave up, this one is the same subprocess arriving after it, and a reader
    // (or a report counting `stage: 'status'`) must not read one hung
    // `git status` as two.
    expect(discarded!.fields?.stage).toBe('status-late');
    expect(discarded!.fields?.stage).not.toBe(stopped!.fields?.stage);
    // The subprocess has returned — that is the only reason the answer is
    // here at all — so nothing of it is still out there.
    expect(discarded!.fields?.statusInFlight).toBe(false);
    expect(discarded!.fields?.inFlight).toBe(0);
    // The summary is still the empty one it was. Every count is a number a
    // reader can add up, and on this path they are all zero *by construction*:
    // the status never listed a path, so nothing was requested, nothing was
    // collected, nothing was abandoned and nothing failed. Pinned rather than
    // left to the arithmetic, because "0" here is a claim about the summary
    // ("it requested nothing"), not a missing measurement.
    expect(discarded!.fields?.collected).toBe(0);
    expect(discarded!.fields?.requested).toBe(0);
    expect(discarded!.fields?.abandoned).toBe(0);
    expect(discarded!.fields?.failed).toBe(0);
    expect(discarded!.fields?.outcome).toBe('answered');
    // No `error` field on a late *answer*: there was nothing wrong with it
    // except its timing.
    expect(discarded!.fields && 'error' in discarded!.fields).toBe(false);

    // The deadline line is not rewritten. It was a snapshot, and the two
    // lines together are the whole story: still running at the deadline,
    // finished a moment later.
    expect(h.logs.filter((line) => line.event === 'git diff summary stopped at its deadline')).toHaveLength(1);
    // And in that order: a reader who finds the late line first must not read
    // it as the *cause* of an empty summary. The giving-up line is the one
    // that explains the summary; the late line is what became of the
    // subprocess afterwards.
    expect(
      h.logs.findIndex((line) => line.event === 'git diff summary stopped at its deadline'),
    ).toBeLessThan(
      h.logs.findIndex((line) => line.event === 'git diff summary discarded a late status answer'),
    );
    // And the late answer still changed nothing about the summary: no diff
    // was spawned for a path nobody listed.
    expect(h.diffs).toEqual([]);
  });

  it('records a `git status` that failed after the deadline, with the error', async () => {
    // The other ending of the same story. A `git status` that comes back late
    // and *fails* (a stale `index.lock`, a repository that went away, a git
    // binary that died) is not the same event as one that comes back late with
    // an answer: the first is a workspace that needs a person, the second is
    // just a slow machine. The `outcome` field is what tells them apart, and
    // before it existed both vanished — the rejection landed on a race nobody
    // was waiting on any more.
    const h = harness({ statusSlowFailsMs: 60, diffDeadlineMs: 25 });

    await expect(h.bridge.diffSummary({ workspaceId: 'ws_1' })).resolves.toEqual([]);

    const stopped = h.logs.find((line) => line.event === 'git diff summary stopped at its deadline');
    expect(stopped, 'the deadline line was not written').toBeDefined();
    expect(stopped!.fields?.stage).toBe('status');
    expect(stopped!.fields?.statusInFlight).toBe(true);

    // The rejection lands, late, and is written down instead of disappearing.
    await after(120, undefined);

    const discarded = h.logs.find(
      (line) => line.event === 'git diff summary discarded a late status answer',
    );
    expect(discarded, 'a late `git status` failure left no trace at all').toBeDefined();
    expect(discarded!.fields?.stage).toBe('status-late');
    expect(discarded!.fields?.outcome).toBe('failed');
    // The error is named, in one line: without it "failed" is a report that
    // something went wrong with no way to find out what.
    expect(discarded!.fields?.error).toBe('fatal: unable to read index.lock');
    // The subprocess is gone — the failure is its return — so the closed
    // counts hold here too, and all of them are zero because nothing was ever
    // listed.
    expect(discarded!.fields?.statusInFlight).toBe(false);
    expect(discarded!.fields?.inFlight).toBe(0);
    expect(discarded!.fields?.requested).toBe(0);
    expect(discarded!.fields?.collected).toBe(0);
    expect(discarded!.fields?.abandoned).toBe(0);
    expect(discarded!.fields?.failed).toBe(0);
    // Nothing was spawned for a path nobody listed, before or after the
    // failure.
    expect(h.diffs).toEqual([]);
    expect(h.statusCalls()).toBe(1);
    // Same order as the answering case: the summary gave up first, and the
    // subprocess reported afterwards.
    expect(
      h.logs.findIndex((line) => line.event === 'git diff summary stopped at its deadline'),
    ).toBeLessThan(
      h.logs.findIndex((line) => line.event === 'git diff summary discarded a late status answer'),
    );
  });

  it('does not let a late failure escape as an unhandled rejection', async () => {
    // The rejection handler of the race used to re-throw, which reads like an
    // error that travels: the summary had already been returned, so there was
    // nobody left to refuse it. What actually happened is milder — and worth
    // pinning, because "mild" is exactly the kind of thing a later edit
    // breaks without anybody noticing:
    //
    //  - `Promise.race` attaches a handler to *both* branches, so the
    //    rejection of the branch that lost is consumed by the race and never
    //    reaches the process;
    //  - the failure is recorded on the `status-late` line, so a git process
    //    that died on a stale lock is not the same as one that never ran.
    //
    // So a late failure is neither a crash nor an error the caller has to
    // handle: the caller gets an empty summary, and the failure is on the
    // record. The listener below is what turns "nothing reached the process"
    // from an assumption into an assertion.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);

    try {
      const h = harness({ statusSlowFailsMs: 60, diffDeadlineMs: 25 });

      // The answer the caller gets is an answer, not a failure: the deadline
      // had already decided the outcome of this summary.
      await expect(h.bridge.diffSummary({ workspaceId: 'ws_1' })).resolves.toEqual([]);

      // Now the status fails, late.
      await after(120, undefined);

      expect(
        unhandled,
        'the late failure escaped as an unhandled rejection',
      ).toEqual([]);

      // And it is on the record, with the stage of its own.
      const discarded = h.logs.find(
        (line) => line.event === 'git diff summary discarded a late status answer',
      );
      expect(discarded, 'the late failure left no trace at all').toBeDefined();
      expect(discarded!.fields?.stage).toBe('status-late');
      expect(discarded!.fields?.outcome).toBe('failed');
      expect(discarded!.fields?.error).toBe('fatal: unable to read index.lock');
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('writes the late-status line with the deadline line\'s fields, and a stage of its own', async () => {
    // The two lines are the same story told twice — a snapshot at the deadline,
    // and what became of the subprocess that snapshot left out there — so a
    // reader (or a support report) compares them field by field. Which fields
    // each one carries was only held together by a comment in `git-bridge.ts`
    // ("the same shape as the deadline line"): nothing failed if a field was
    // added to one and not the other, and the reader would then be comparing
    // `undefined` against a number and drawing a conclusion from it.
    //
    // So the sets are pinned exactly, not as a subset. The fields that
    // legitimately belong to one line only are named here, which is what makes
    // another one a decision someone has to make out loud:
    //  - `deadlineMs` is about the budget, which the late answer knows nothing
    //    about;
    //  - `outcome` is about the late answer, which the deadline does not have.
    //
    // `stage` is on both lines and differs by design (`'status'` /
    // `'status-late'`) — see the assertions after the field sets.
    const h = harness({ statusSlowMs: 60, diffDeadlineMs: 25 });

    await h.bridge.diffSummary({ workspaceId: 'ws_1' });
    await after(120, undefined);

    const stopped = h.logs.find((line) => line.event === 'git diff summary stopped at its deadline');
    const discarded = h.logs.find(
      (line) => line.event === 'git diff summary discarded a late status answer',
    );
    expect(stopped, 'the deadline line was not written').toBeDefined();
    expect(discarded, 'the late-status line was not written').toBeDefined();

    /** everything both lines must carry, sorted so a diff reads as a diff */
    const shared = [
      'abandoned',
      'collected',
      'failed',
      'inFlight',
      'requested',
      'statusInFlight',
      'workspaceId',
    ];
    // `stage` is on both lines and is *not* shared: it is the field that says
    // which of the two a line is (`'status'` vs `'status-late'`), so counting
    // one hung `git status` twice becomes impossible instead of improbable.
    expect(Object.keys(stopped!.fields ?? {}).sort()).toEqual(
      [...shared, 'deadlineMs', 'stage'].sort(),
    );
    expect(Object.keys(discarded!.fields ?? {}).sort()).toEqual(
      [...shared, 'outcome', 'stage'].sort(),
    );

    // The shared fields mean the same thing on both lines: a summary with
    // nothing in it. Only the subprocess counts and the stage may differ, and
    // they must.
    for (const key of shared) {
      if (key === 'inFlight' || key === 'statusInFlight') continue;
      expect(discarded!.fields?.[key], `${key} disagrees between the two lines`).toEqual(
        stopped!.fields?.[key],
      );
    }
    // The stage is the machine-readable difference between "gave up" and
    // "arrived afterwards": same subprocess, two different lines.
    expect(stopped!.fields?.stage).toBe('status');
    expect(discarded!.fields?.stage).toBe('status-late');
    // The one pair that is *supposed* to differ, and the whole reason the
    // second line exists: still out there at the deadline, gone by the time
    // the answer arrived.
    expect(stopped!.fields?.statusInFlight).toBe(true);
    expect(stopped!.fields?.inFlight).toBe(1);
    expect(discarded!.fields?.statusInFlight).toBe(false);
    expect(discarded!.fields?.inFlight).toBe(0);
  });

  it('accounts for every requested path in the deadline log', async () => {
    // The log used to carry `abandoned` as a number nobody could check. It is
    // an arithmetic claim — every requested path is in exactly one bucket —
    // so a reader must be able to add the numbers up.
    const h = harness({
      unstaged: ['a.ts', 'b.ts', 'goes-missing.ts', 'c-hangs.ts'],
      diffFor: async (path) => {
        if (path === 'c-hangs.ts') return new Promise<never>(() => {});
        if (path === 'goes-missing.ts') throw new Error('fatal: bad object');
        return after(1, patch(path));
      },
      diffConcurrency: 4,
      diffDeadlineMs: 25,
    });

    await h.bridge.diffSummary({ workspaceId: 'ws_1' });

    const stopped = h.logs.find((line) => line.event === 'git diff summary stopped at its deadline');
    expect(stopped).toBeDefined();
    const requested = stopped!.fields?.requested as number;
    const answered = stopped!.fields?.answered as number;
    const abandoned = stopped!.fields?.abandoned as number;
    const failed = stopped!.fields?.failed as number;
    const neverStarted = stopped!.fields?.neverStarted as number;
    const inFlight = stopped!.fields?.inFlight as number;

    // Every requested path is in exactly one bucket: it answered, it failed,
    // or it never answered. The three add up to what was asked for.
    expect(answered + abandoned + failed).toBe(requested);
    // The abandoned ones split again: one never became a subprocess, one is
    // still running. `abandoned` is the sum of the two.
    expect(neverStarted + inFlight).toBe(abandoned);
    // And the numbers say what happened, so a reader does not have to
    // reconstruct it: two answered, one failed, one never came back.
    expect(answered).toBe(2);
    expect(failed).toBe(1);
    expect(abandoned).toBe(1);
    expect(inFlight).toBe(1);
    expect(neverStarted).toBe(0);
  });

  it('tells the paths the deadline never let start apart from the ones still running', async () => {
    // `abandoned` counts the paths git never answered for — which includes
    // the ones that never became a subprocess at all, because the deadline
    // stopped the workers from claiming them. `inFlight` counts the ones
    // that are still running. They are different numbers, and the log has to
    // keep them apart.
    const paths = Array.from({ length: 6 }, (_, i) => `src/f${i}.ts`);
    const h = harness({
      unstaged: paths,
      // Every diff outlives the deadline, so nothing ever answers.
      diffFor: async (path) => after(60, patch(path)),
      diffConcurrency: 2,
      diffDeadlineMs: 25,
    });

    await h.bridge.diffSummary({ workspaceId: 'ws_1', limit: 6 });

    const stopped = h.logs.find((line) => line.event === 'git diff summary stopped at its deadline');
    expect(stopped).toBeDefined();
    const requested = stopped!.fields?.requested as number;
    const abandoned = stopped!.fields?.abandoned as number;
    const neverStarted = stopped!.fields?.neverStarted as number;
    const inFlight = stopped!.fields?.inFlight as number;

    const answered = stopped!.fields?.answered as number;
    const failed = stopped!.fields?.failed as number;
    const droppedEmptyOrBinary = stopped!.fields?.droppedEmptyOrBinary as number;

    expect(requested).toBe(6);
    // Two workers, two subprocesses out there...
    expect(inFlight).toBe(2);
    // ...and four paths the deadline stopped before they were ever spawned.
    expect(neverStarted).toBe(4);
    // So `abandoned` is six, not two: it is the sum, and a reader who took it
    // for "two subprocesses are hanging" would be wrong.
    expect(abandoned).toBe(6);
    expect(neverStarted + inFlight).toBe(abandoned);
    // The whole sum in one line, which is the claim the log makes: every
    // requested path is in exactly one bucket, and none of the buckets is
    // negative. Nothing answered here, so nothing was dropped either.
    expect(answered + failed + inFlight + neverStarted).toBe(requested);
    expect(droppedEmptyOrBinary).toBe(0);
    // The never-started bucket can only be counted if the deadline stopped the
    // workers from claiming paths — otherwise this test would pass with
    // `neverStarted: 0` and prove nothing.
    expect(neverStarted).toBeGreaterThan(0);
  });

  it('keeps the paths that answered when one `git diff` throws', async () => {
    // One unreadable path (removed between status and diff, a corrupt index
    // entry) used to reject the whole worker pool and hand back `[]`: a claim
    // about every file, made because one of them failed.
    const h = harness({
      unstaged: ['a.ts', 'b.ts', 'goes-missing.ts', 'd.ts'],
      diffFor: async (path) => {
        if (path === 'goes-missing.ts') throw new Error('fatal: bad object');
        return patch(path);
      },
    });

    const summary = await h.bridge.diffSummary({ workspaceId: 'ws_1' });

    expect(summary.map((item) => item.path)).toEqual(['a.ts', 'b.ts', 'd.ts']);
    const skipped = h.logs.find((line) => line.event === 'git diff skipped a path that failed');
    expect(skipped, 'a path was dropped without a log line naming it').toBeDefined();
    expect(skipped!.fields?.path).toBe('goes-missing.ts');
    expect(String(skipped!.fields?.error)).toContain('bad object');
  });

  it('spawns no new `git diff` after the deadline has fired', async () => {
    // The deadline stops the waiting, not only the claiming: once it fires, a
    // worker that finishes its current subprocess must not pick up the next
    // path. Otherwise a hung workspace would keep turning into a queue of git
    // processes after the turn had already moved on — the bound would be on
    // what the caller waits for, not on what git is asked to do.
    const paths = Array.from({ length: 8 }, (_, i) => `src/f${i}.ts`);
    let spawns = 0;
    const h = harness({
      unstaged: paths,
      // The first diff outlives the deadline; every later one would return at
      // once. That asymmetry is the point: a worker that keeps looping after
      // the deadline would drain the remaining seven paths instantly, so the
      // call count alone tells whether the guard is still there.
      diffFor: async (path) => {
        spawns += 1;
        return spawns === 1 ? after(120, patch(path)) : patch(path);
      },
      diffConcurrency: 1,
      diffDeadlineMs: 20,
    });

    const startedAt = Date.now();
    await h.bridge.diffSummary({ workspaceId: 'ws_1', limit: 8 });
    expect(Date.now() - startedAt).toBeLessThan(500);

    // One worker was already inside a subprocess when the deadline fired; at
    // most one more could have been claimed if the guard ran a hair late.
    // Anything beyond that means the loop kept spawning.
    expect(h.diffs.length, 'the deadline did not stop new subprocesses').toBeLessThanOrEqual(2);

    // Let the outstanding diff land and prove the worker retired rather than
    // claiming the next path once it returned. With the guard removed this
    // line sees all eight paths diffed.
    await after(150, undefined);
    expect(h.diffs.length, 'the worker kept spawning after the deadline').toBe(1);
    const started = new Set(h.diffs.map((call) => call.path));
    expect(started.size, 'the same path was diffed twice').toBe(h.diffs.length);
  });

  it('records a `git diff` that failed after the deadline, with the path and the error', async () => {
    // The other ending of the same story. A slow diff that comes back late
    // and *fails* (a path removed between status and diff, a corrupt index
    // entry) used to be written as an in-time "skipped a path" line, which
    // described work somebody was still waiting for. The summary had already
    // returned, so this is an ending for a path the deadline counted as
    // abandoned — and the error is the part a report needs to find out why.
    let failLate: ((error: Error) => void) | undefined;
    const late = new Promise<never>((_resolve, reject) => {
      failLate = reject;
    });
    const h = harness({
      unstaged: ['late.ts'],
      diffFor: async () => late,
      diffConcurrency: 1,
      diffDeadlineMs: 25,
    });

    await expect(h.bridge.diffSummary({ workspaceId: 'ws_1' })).resolves.toEqual([]);

    failLate!(new Error('fatal: bad object'));
    await after(60, undefined);

    const recorded = h.logs.find(
      (line) => line.event === 'git diff summary discarded a late diff answer',
    );
    expect(recorded, 'a late failure left no trace of which path it was').toBeDefined();
    expect(recorded!.fields?.stage).toBe('diff-late');
    expect(recorded!.fields?.path).toBe('late.ts');
    expect(recorded!.fields?.outcome).toBe('failed');
    expect(String(recorded!.fields?.error)).toContain('bad object');
    // One ending, not two: the in-time "skipped" line belongs to summaries
    // that still had a caller.
    expect(
      h.logs.some((line) => line.event === 'git diff skipped a path that failed'),
    ).toBe(false);
  });

  it('does not report an in-flight status when `git status` threw synchronously', async () => {
    // A `status` that throws before it returns never spawned a subprocess, so
    // there is nothing out there to account for. That path goes to the
    // "unavailable" log and must not carry an `inFlight` claim at all — the
    // field would be either a lie (1) or a reassurance nobody measured (0).
    const h = harness({ statusThrowsSynchronously: true });

    const summary = await h.bridge.diffSummary({ workspaceId: 'ws_1' });

    expect(summary).toEqual([]);
    expect(h.diffs).toEqual([]);
    // No deadline line: the failure was immediate, not a timeout.
    expect(h.logs.filter((line) => line.event.includes('deadline'))).toEqual([]);
    const unavailable = h.logs.find((line) => line.event === 'git diff summary unavailable');
    expect(unavailable, 'a synchronous `status` failure was swallowed').toBeDefined();
    expect(String(unavailable!.fields?.error)).toContain('resolveRoot');
    expect(unavailable!.fields).not.toHaveProperty('inFlight');
    expect(unavailable!.fields).not.toHaveProperty('statusInFlight');
  });

  it('defaults to four diffs in flight when the caller sets nothing', async () => {
    // 4 is a product decision, not an incidental constant (see the comment on
    // `DEFAULT_DIFF_CONCURRENCY`). Pinned here so raising it is a deliberate
    // change with a test to update rather than a quiet edit.
    const paths = Array.from({ length: 12 }, (_, i) => `src/f${i}.ts`);
    const h = harness({ unstaged: paths, diffFor: async (path) => after(2, patch(path)) });

    const summary = await h.bridge.diffSummary({ workspaceId: 'ws_1', limit: 12 });

    expect(summary).toHaveLength(12);
    expect(h.maxInFlight()).toBeLessThanOrEqual(4);
    expect(h.maxInFlight()).toBeGreaterThan(1);
  });

  it('does not stop early when everything answers in time', async () => {
    const h = harness({
      unstaged: ['a.ts', 'b.ts'],
      diffFor: async (path) => after(1, patch(path)),
      diffDeadlineMs: 50,
    });

    const summary = await h.bridge.diffSummary({ workspaceId: 'ws_1' });

    expect(summary).toHaveLength(2);
    // The deadline is a budget, not a schedule: a summary that finished must
    // not be reported as truncated.
    expect(h.logs.some((line) => line.event.includes('deadline'))).toBe(false);
  });
});

describe('git diffSummary — a directory that is not a repository', () => {
  it('returns no items and logs at debug, not as a failure', async () => {
    const h = harness({ statusFails: true });

    await expect(h.bridge.diffSummary({ workspaceId: 'ws_1' })).resolves.toEqual([]);
    // Not an error a person should see: the context pack simply has no
    // `git_diff` item, and the folder may well be what they intended to open.
    const logged = h.logs.find((line) => line.event === 'git diff summary unavailable');
    expect(logged).toBeDefined();
    expect(String(logged!.fields?.error)).toContain('not a git repository');
  });
});

/**
 * The three flags, as a table.
 *
 * `git-bridge.ts` used to describe this state machine in prose (and the prose
 * kept growing). The observable contract is small: given whether the deadline
 * fired, whether `status` settled before the snapshot, and whether a diff
 * settled before the snapshot, which late lines appear and with what outcome?
 *
 * Seven rows answer for the four reachable combinations of the three flags.
 * Two facts rule the other four out: without a deadline, `Promise.all`
 * settles before the snapshot, so nothing can be late; and a status-stage
 * deadline takes no snapshot at all — no path was listed, so no diff exists to
 * report late — which is why a hung status writes two deadline-side facts and
 * zero late lines. Those two facts are applied to the *declared* flags at the
 * bottom of this block, so a row for a combination the bridge cannot enter,
 * or a reachable combination with no row, fails here rather than reading as
 * coverage. A status that settles before the snapshot cannot produce a
 * `status-late` line for the same reason the no-deadline rows cannot.
 */
describe('git diffSummary — the three flags, as a table', () => {
  const statusLate = (h: Harness): unknown[] =>
    h.logs
      .filter((line) => line.event === 'git diff summary discarded a late status answer')
      .map((line) => line.fields?.outcome);
  const diffLate = (h: Harness): unknown[] =>
    h.logs
      .filter((line) => line.event === 'git diff summary discarded a late diff answer')
      .map((line) => line.fields?.outcome);

  /**
   * The three flags, named once so the table and the coverage checks below
   * agree by construction on what a combination is.
   */
  interface Flags {
    readonly deadlineFired: boolean;
    readonly statusSettledBeforeSnapshot: boolean;
    readonly diffSettledBeforeSnapshot: boolean;
  }

  interface Row extends Flags {
    name: string;
    expected: {
      items: string[];
      statusLate: Array<'answered' | 'failed'>;
      diffLate: Array<'answered' | 'failed'>;
    };
    run: () => Promise<{ h: Harness; items: string[] }>;
  }

  /** Runs one summary, then optionally lets the late answer land. */
  const runWith = async (
    options: Parameters<typeof harness>[0],
    finishLate?: () => Promise<void>,
  ): Promise<{ h: Harness; items: string[] }> => {
    const h = harness(options);
    const summary = await h.bridge.diffSummary({ workspaceId: 'ws_1' });
    if (finishLate) await finishLate();
    return { h, items: summary.map((item) => item.path) };
  };

  /** A diff held open by a gate the test releases by hand. */
  const gatedDiff = (settle: 'resolve' | 'reject') => {
    let open!: () => void;
    let fail!: (error: Error) => void;
    const gate = new Promise<void>((resolve, reject) => {
      open = resolve;
      fail = reject;
    });
    return {
      gate,
      finish: async (): Promise<void> => {
        if (settle === 'resolve') open();
        else fail(new Error('fatal: bad object'));
        await after(10, undefined);
      },
    };
  };

  const rows: Row[] = [
    {
      name: 'inside the budget: no late lines, and the deadline does not imply a snapshot',
      deadlineFired: false,
      statusSettledBeforeSnapshot: true,
      diffSettledBeforeSnapshot: true,
      expected: { items: ['a.ts'], statusLate: [], diffLate: [] },
      run: () => runWith({ unstaged: ['a.ts'], diffDeadlineMs: 100 }),
    },
    {
      name: 'status hangs: the deadline returns early, so there is no answer to record late',
      deadlineFired: true,
      statusSettledBeforeSnapshot: false,
      diffSettledBeforeSnapshot: false,
      expected: { items: [], statusLate: [], diffLate: [] },
      run: () => runWith({ statusHangs: true, diffDeadlineMs: 20 }),
    },
    {
      name: 'status answered after the deadline: one status-late line, and no diff was spawned',
      deadlineFired: true,
      statusSettledBeforeSnapshot: false,
      diffSettledBeforeSnapshot: false,
      expected: { items: [], statusLate: ['answered'], diffLate: [] },
      run: () =>
        runWith({ statusSlowMs: 60, diffDeadlineMs: 20 }, () => after(100, undefined)),
    },
    {
      name: 'status failed after the deadline: the same line, with outcome failed',
      deadlineFired: true,
      statusSettledBeforeSnapshot: false,
      diffSettledBeforeSnapshot: false,
      expected: { items: [], statusLate: ['failed'], diffLate: [] },
      run: () =>
        runWith({ statusSlowFailsMs: 60, diffDeadlineMs: 20 }, () => after(100, undefined)),
    },
    {
      name: 'diff answered after the snapshot: a diff-late line naming the dropped answer',
      deadlineFired: true,
      statusSettledBeforeSnapshot: true,
      diffSettledBeforeSnapshot: false,
      expected: { items: [], statusLate: [], diffLate: ['answered'] },
      run: () => {
        const held = gatedDiff('resolve');
        return runWith(
          {
            unstaged: ['late.ts'],
            diffFor: async (path) => {
              await held.gate;
              return patch(path);
            },
            diffConcurrency: 1,
            diffDeadlineMs: 20,
          },
          held.finish,
        );
      },
    },
    {
      name: 'diff failed after the snapshot: the same line, with outcome failed',
      deadlineFired: true,
      statusSettledBeforeSnapshot: true,
      diffSettledBeforeSnapshot: false,
      expected: { items: [], statusLate: [], diffLate: ['failed'] },
      run: () => {
        const held = gatedDiff('reject');
        return runWith(
          {
            unstaged: ['late.ts'],
            diffFor: async () => held.gate,
            diffConcurrency: 1,
            diffDeadlineMs: 20,
          },
          held.finish,
        );
      },
    },
    {
      name: 'diff settled before the snapshot: no late line, even though the deadline fired for another path',
      deadlineFired: true,
      statusSettledBeforeSnapshot: true,
      diffSettledBeforeSnapshot: true,
      expected: { items: ['fast.ts'], statusLate: [], diffLate: [] },
      run: () =>
        runWith({
          unstaged: ['fast.ts', 'hang.ts'],
          diffFor: async (path) =>
            path === 'hang.ts' ? new Promise<never>(() => {}) : patch(path),
          diffConcurrency: 2,
          diffDeadlineMs: 20,
        }),
    },
  ];

  it.each(rows)('$name', async (row) => {
    const { h, items } = await row.run();

    expect(items, 'the answer the caller received').toEqual(row.expected.items);
    expect(statusLate(h), 'status-late outcomes').toEqual(row.expected.statusLate);
    expect(diffLate(h), 'diff-late outcomes').toEqual(row.expected.diffLate);

    // The table's own invariants, independent of the expected values:
    if (!row.deadlineFired) {
      expect(statusLate(h), 'a late line without a deadline').toEqual([]);
      expect(diffLate(h), 'a late line without a deadline').toEqual([]);
    }
    if (row.statusSettledBeforeSnapshot) {
      expect(statusLate(h), 'a status that settled before the snapshot cannot be late').toEqual([]);
    }
    if (row.diffSettledBeforeSnapshot) {
      expect(diffLate(h), 'a diff that settled before the snapshot cannot be late').toEqual([]);
    }
    // Both late lines can share a log, but never one call: a late status means
    // no path was listed, so that call spawned no diff.
    expect(
      statusLate(h).length + diffLate(h).length,
      'a single call wrote both late lines',
    ).toBeLessThanOrEqual(1);
  });

  /**
   * The other half of "as a table": the rows above are a sample of the flag
   * cube, and nothing said which of its eight vertices they are missing.
   *
   * Seven rows, four reachable combinations — three flags make eight, and the
   * difference is not an oversight. Two facts about the state machine rule the
   * rest out:
   *
   *  - without a deadline, `Promise.all` settles before the snapshot, so both
   *    answers are in before the array is built. (F-T-F, F-F-T, F-F-F)
   *  - a deadline that fires while `git status` is still running returns early:
   *    no path was listed, so no diff was ever spawned. (T-F-T)
   *
   * Written down, they were still only prose, and prose is what this table
   * replaced. A row added for an impossible combination would have documented
   * a state the bridge cannot enter; a reachable combination losing its last
   * row would have left a behaviour described by nothing. Both are checks over
   * the table's own coverage, so they run here without touching git.
   *
   * The rules are applied to the *declared* flags, not to the log lines: a
   * rule that read the logs would agree with whatever the bridge did and pin
   * nothing. What the declared flags predict the logs to say is the per-row
   * `it.each` above.
   */
  const comboKey = (flags: Flags): string =>
    [flags.deadlineFired, flags.statusSettledBeforeSnapshot, flags.diffSettledBeforeSnapshot]
      .map((flag) => (flag ? 'T' : 'F'))
      .join('-');

  /** Why this vertex of the flag cube cannot happen, or `undefined` if it can. */
  const impossibleBecause = (flags: Flags): string | undefined => {
    if (
      !flags.deadlineFired &&
      (!flags.statusSettledBeforeSnapshot || !flags.diffSettledBeforeSnapshot)
    ) {
      return 'without a deadline `Promise.all` settles before the snapshot, so nothing can still be in flight';
    }
    if (
      flags.deadlineFired &&
      !flags.statusSettledBeforeSnapshot &&
      flags.diffSettledBeforeSnapshot
    ) {
      return 'a status-stage deadline returns before any diff is spawned, so no diff can have settled';
    }
    return undefined;
  };

  /** All eight flag combinations, in a fixed order. */
  const flagCube = (): Flags[] =>
    [false, true].flatMap((deadlineFired) =>
      [false, true].flatMap((statusSettledBeforeSnapshot) =>
        [false, true].map((diffSettledBeforeSnapshot) => ({
          deadlineFired,
          statusSettledBeforeSnapshot,
          diffSettledBeforeSnapshot,
        })),
      ),
    );

  /**
   * Every way the table can stop describing the flag cube.
   *
   * Pure over the declared flags so the fixtures below can show it answering.
   */
  const coverageProblems = (table: readonly Flags[]): string[] => {
    const problems: string[] = [];
    const seen = new Set<string>();
    for (const flags of table) {
      const why = impossibleBecause(flags);
      if (why !== undefined) problems.push(`the table has a row for ${comboKey(flags)}, which cannot happen: ${why}`);
      seen.add(comboKey(flags));
    }
    for (const flags of flagCube()) {
      if (impossibleBecause(flags) !== undefined) continue;
      if (!seen.has(comboKey(flags))) {
        problems.push(`no row states the reachable combination ${comboKey(flags)}`);
      }
    }
    return problems;
  };

  it('states every reachable combination of the three flags, and no impossible one', () => {
    const problems = coverageProblems(rows);
    expect(
      problems,
      `the flag table no longer covers the state machine:\n  ${problems.join('\n  ')}`,
    ).toEqual([]);
  });

  it('calls exactly four of the eight combinations impossible, each for a stated reason', () => {
    // The count is not decoration: two independent facts rule out four
    // vertices. If a rule above is loosened, this number changes and somebody
    // has to say why.
    const cube = flagCube();
    expect(cube.length).toBe(8);
    const impossible = cube.filter((flags) => impossibleBecause(flags) !== undefined);
    expect(impossible.map(comboKey).sort()).toEqual(['F-F-F', 'F-F-T', 'F-T-F', 'T-F-T']);
    for (const flags of impossible) {
      expect(impossibleBecause(flags), `${comboKey(flags)} has no explanation`).toBeTruthy();
    }
  });

  it('reports a row dropped from a reachable combination', () => {
    // The last row answers for T-T-T; without it the bridge could stop taking
    // a snapshot after a deadline and nothing here would miss it.
    const withoutSnapshotAfterDeadline = rows.filter(
      (row) => comboKey(row) !== 'T-T-T',
    );
    expect(coverageProblems(withoutSnapshotAfterDeadline)).toEqual([
      'no row states the reachable combination T-T-T',
    ]);
  });

  it('reports a row for a combination the bridge cannot enter', () => {
    const invented: Flags = {
      deadlineFired: false,
      statusSettledBeforeSnapshot: true,
      diffSettledBeforeSnapshot: false,
    };
    expect(coverageProblems([...rows, invented])).toEqual([
      'the table has a row for F-T-F, which cannot happen: without a deadline `Promise.all` settles before the snapshot, so nothing can still be in flight',
    ]);
  });
});

/**
 * The `stage` field, as a table.
 *
 * `git-bridge.ts` writes four stage names, and a support report groups lines by
 * that field. The four used to be bare string literals at four log sites: a
 * typo or a new spelling was invisible to `tsc` and to every test, and a report
 * counting `stage: 'status-late'` would silently miss a line that said
 * `'status_late'`. The table is typed; this is the runtime half, because the
 * contract suite transpiles without typechecking.
 */
describe('git diffSummary — the stage table', () => {
  it('names exactly the stages a log line can carry', () => {
    // Both directions, so the table cannot lose a stage or grow one the union
    // does not have. The `satisfies` in the product file catches the second
    // under `tsc`; this catches both under `npm test`. Key and value are the
    // same spelling (the `Record<…>` shape), so one expected list covers both.
    expect(Object.values(GIT_DIFF_STAGE).sort(), 'the table has a stage the log cannot write').toEqual(
      ['diff', 'diff-late', 'status', 'status-late'],
    );
    expect(Object.keys(GIT_DIFF_STAGE).sort(), 'the table has a key with no stage').toEqual([
      'diff',
      'diff-late',
      'status',
      'status-late',
    ]);
  });

  it('writes every stage the table names on some log path', async () => {
    // A table value nobody writes is a name a report can filter on forever and
    // never see. Each scenario below is the shortest path to one of the four;
    // if a log site stops writing its stage, the set here loses a member.
    const seen = new Set<unknown>();
    const collect = (h: Harness): void => {
      for (const line of h.logs) {
        if (line.fields?.stage !== undefined) seen.add(line.fields.stage);
      }
    };

    // `status`: the deadline fires while `git status` is still running.
    const status = harness({ statusHangs: true, diffDeadlineMs: 10 });
    await status.bridge.diffSummary({ workspaceId: 'ws_1' });
    collect(status);

    // `status-late`: that same status answers after the summary gave up.
    const statusLate = harness({ statusSlowMs: 40, diffDeadlineMs: 10 });
    await statusLate.bridge.diffSummary({ workspaceId: 'ws_1' });
    await after(80, undefined);
    collect(statusLate);

    // `diff`: status answered, but a diff outlives the deadline.
    const diff = harness({
      unstaged: ['hang.ts'],
      diffFor: async () => new Promise<never>(() => {}),
      diffDeadlineMs: 10,
    });
    await diff.bridge.diffSummary({ workspaceId: 'ws_1' });
    collect(diff);

    // `diff-late`: that diff answers after the snapshot was taken.
    const diffLate = harness({
      unstaged: ['late.ts'],
      diffFor: async (path) => after(40, patch(path)),
      diffDeadlineMs: 10,
    });
    await diffLate.bridge.diffSummary({ workspaceId: 'ws_1' });
    await after(80, undefined);
    collect(diffLate);

    expect(
      [...seen].sort(),
      'a stage in the table is never written, or a log path writes one outside it',
    ).toEqual(Object.values(GIT_DIFF_STAGE).sort());
  });
});

/**
 * One turn's late answer is not the next turn's answer.
 *
 * ## Why this file exists
 *
 * The bridge's counters — `collected`, `answered`, `abandoned`, `inFlight` —
 * are all local to one `diffSummary` call, and that is the whole reason a
 * second turn on the same workspace is safe. It was not pinned anywhere.
 *
 * The window is real and narrow: the deadline stops the *waiting*, not the
 * subprocesses that already started. So a `git diff` launched by the first
 * turn is still running when the first turn has already returned, and it
 * lands during the second turn — after the second turn's own diffs, possibly
 * after the second turn's own answer was built. Anything the bridge kept
 * between calls (a "collected" list, a counter, a pending result) would be
 * read by the second turn, and the second turn's context pack would carry
 * the first turn's patch.
 *
 * The two things this file asserts are the ones a reader cannot check by
 * reading the code: the second answer is built from the second call's own
 * subprocesses, and the late answer changes neither answer. It does leave one
 * line naming the path it belonged to — a dropped result must not read the
 * same as a subprocess that never returned.
 */
describe('git diffSummary — one call does not answer for the next', () => {
  it('keeps a late diff out of the next call, and names the path when it lands', async () => {
    // The first turn's `late.ts` diff is held open by a gate this test
    // releases by hand, so the late answer lands at a moment the test
    // chooses: after the second turn has already answered. No sleeping, no
    // race between two timers.
    let releaseLate: (() => void) | undefined;
    const lateGate = new Promise<void>((resolve) => {
      releaseLate = resolve;
    });

    let round = 0;
    const h = harness({
      unstaged: ['late.ts', 'quick.ts'],
      diffFor: async (path) => {
        // Each turn's patch says which turn produced it, so a mixed-up
        // answer is visible in the text and not only in the file list.
        const tag = round === 0 ? `TURN ONE${path === 'late.ts' ? ' LATE' : ''}` : 'TURN TWO';
        const body = { patch: `--- a/${path}\n+++ b/${path}\n${tag}\n`, binary: false };
        if (round === 0 && path === 'late.ts') {
          await lateGate;
          return body;
        }
        return body;
      },
      diffConcurrency: 2,
      diffDeadlineMs: 50,
    });

    // ---- first turn: stops at its deadline with the one file that answered
    const first = await h.bridge.diffSummary({ workspaceId: 'ws_1' });

    expect(first.map((item) => item.path)).toEqual(['quick.ts']);
    expect(first[0]!.patch).toContain('TURN ONE');
    expect(first[0]!.patch).not.toContain('TURN TWO');

    // ---- second turn: starts while the first turn's subprocess is still out
    round = 1;
    const second = await h.bridge.diffSummary({ workspaceId: 'ws_1' });

    expect(second.map((item) => item.path)).toEqual(['late.ts', 'quick.ts']);
    // The patch in the second answer is the *second* turn's own. A list
    // shared between the two calls would have put the first turn's late
    // patch here, and the file list alone would not have shown it.
    expect(second[0]!.patch).toContain('TURN TWO');
    expect(second[0]!.patch).not.toContain('TURN ONE LATE');

    // ---- the first turn's late answer finally lands
    const logsBefore = h.logs.length;
    releaseLate!();
    await after(60, undefined);

    // It writes exactly one line, and that line names the path. The deadline
    // line already counted `late.ts` as abandoned, but a count cannot tell a
    // slow file from a hung one once the summary has returned; without this
    // line the two endings were indistinguishable.
    const late = h.logs
      .slice(logsBefore)
      .filter((line) => line.event === 'git diff summary discarded a late diff answer');
    expect(late, 'the late answer left no trace of which path it was').toHaveLength(1);
    expect(late[0]!.fields?.stage).toBe('diff-late');
    expect(late[0]!.fields?.path).toBe('late.ts');
    expect(late[0]!.fields?.outcome).toBe('answered');
    // A deadline, not a fault: there is no `error` on an answer that was
    // merely too slow.
    expect(late[0]!.fields && 'error' in late[0]!.fields).toBe(false);
    // And it changes nothing: not the answer the second turn already
    // returned...
    expect(second.map((item) => item.path)).toEqual(['late.ts', 'quick.ts']);
    expect(second[0]!.patch).toContain('TURN TWO');
    // ...not the first turn's deadline line, which was a snapshot taken at
    // the deadline.
    const stopped = h.logs.filter((line) => line.event === 'git diff summary stopped at its deadline');
    expect(stopped).toHaveLength(1);
    expect(stopped[0]!.fields?.collected).toBe(1);
    expect(stopped[0]!.fields?.requested).toBe(2);

    // Both turns really did run their own `git diff` for `late.ts` — the late
    // answer was a real subprocess result, not a phantom of the test.
    expect(h.diffs.filter((call) => call.path === 'late.ts')).toHaveLength(2);
  });

  it('records a late status and a late diff from different calls, each with its own context', async () => {
    // The two late lines cannot come from the same call: a status that misses
    // the deadline never lists a path, so that call spawns no diff; a diff
    // that misses it means `status` answered in time. They can share a log
    // when two calls overlap, and then each line must keep its own call's
    // context — a status line that borrowed the other call's path, or a diff
    // line that named the other workspace, would describe the wrong turn.
    let releaseDiff: (() => void) | undefined;
    const lateDiff = new Promise<void>((resolve) => {
      releaseDiff = resolve;
    });
    const h = harness({
      unstaged: ['slow.ts'],
      // Only the second call's status is slow; the first call's answers in
      // time and starts its diff, which is the one that will be late.
      statusSlowFromCall: { call: 2, ms: 60 },
      diffFor: async () => {
        await lateDiff;
        return patch('slow.ts');
      },
      diffConcurrency: 1,
      diffDeadlineMs: 25,
    });

    // Call one: status answers, its only diff does not.
    await expect(h.bridge.diffSummary({ workspaceId: 'ws_first' })).resolves.toEqual([]);
    // Call two: status itself misses the deadline, so no diff is spawned.
    await expect(h.bridge.diffSummary({ workspaceId: 'ws_second' })).resolves.toEqual([]);
    expect(h.statusCalls()).toBe(2);
    expect(h.diffs.map((call) => call.path)).toEqual(['slow.ts']);

    // Both subprocesses finish after both summaries were built.
    releaseDiff!();
    await after(120, undefined);

    const lateStatus = h.logs.find(
      (line) => line.event === 'git diff summary discarded a late status answer',
    );
    const lateDiffLine = h.logs.find(
      (line) => line.event === 'git diff summary discarded a late diff answer',
    );
    expect(lateStatus, 'the late status left no trace').toBeDefined();
    expect(lateDiffLine, 'the late diff left no trace').toBeDefined();

    // The status belongs to the second call and has no path to name: it gave
    // up before `git status` listed anything.
    expect(lateStatus!.fields?.stage).toBe('status-late');
    expect(lateStatus!.fields?.workspaceId).toBe('ws_second');
    expect(lateStatus!.fields?.outcome).toBe('answered');
    expect(lateStatus!.fields).not.toHaveProperty('path');

    // The diff belongs to the first call, and names the path — the whole
    // reason the deadline line's count was not enough.
    expect(lateDiffLine!.fields?.stage).toBe('diff-late');
    expect(lateDiffLine!.fields?.workspaceId).toBe('ws_first');
    expect(lateDiffLine!.fields?.path).toBe('slow.ts');
    expect(lateDiffLine!.fields?.outcome).toBe('answered');

    // Two deadline lines, one per call, and neither late line duplicated.
    expect(
      h.logs.filter((line) => line.event === 'git diff summary stopped at its deadline'),
    ).toHaveLength(2);
    expect(
      h.logs.filter((line) => line.event === 'git diff summary discarded a late status answer'),
    ).toHaveLength(1);
    expect(
      h.logs.filter((line) => line.event === 'git diff summary discarded a late diff answer'),
    ).toHaveLength(1);
  });
});
