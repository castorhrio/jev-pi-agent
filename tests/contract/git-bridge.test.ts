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
import { GitLikeBridge } from '../../apps/desktop/src/main/git-bridge';
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
  diffConcurrency?: number;
  diffDeadlineMs?: number;
}): Harness {
  const diffs: DiffCall[] = [];
  const logs: Array<{ event: string; fields?: Record<string, unknown> }> = [];
  let inFlight = 0;
  let peak = 0;

  const status = async () => {
    if (options.statusFails) throw new Error('fatal: not a git repository');
    const staged = (options.staged ?? []).map((path) => ({ path, status: 'M' }));
    const unstaged = (options.unstaged ?? []).map((path) => ({ path, status: 'M' }));
    const untracked = options.untracked ?? [];
    return {
      branch: 'main',
      head: 'deadbee',
      dirty: staged.length + unstaged.length + untracked.length > 0,
      staged,
      unstaged,
      untracked,
    };
  };

  const git = {
    status,
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

  return { bridge, diffs, logs, maxInFlight: () => peak };
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
    expect(stopped!.fields?.abandoned).toBe(1);
    expect(stopped!.fields?.inFlight).toBe(1);
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
