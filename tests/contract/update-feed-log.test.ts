/**
 * The update feed is announced once, and the refusal says which refusal it was.
 *
 * ## Why this file exists
 *
 * `readUpdateFeed()` runs on every update check, so both lines it can produce
 * are meant to appear once per process. That rule used to live entirely inside
 * `bootstrap.ts`, as two module-level `let` flags beside the code that read
 * them, and it was described in a comment and asserted nowhere: `bootstrap.ts`
 * imports Electron at load, so a contract test cannot import it, and the only
 * way to reach the flags would have been `vi.resetModules()` plus a fake
 * Electron — a test of the harness, not of the rule.
 *
 * The rule is a value now (`update-feed-log.ts`), so this file drives it
 * directly: a recording logger, the real `resolveUpdateFeed()`, and the claims
 * a user could actually notice —
 *
 *  - two checks, one resolved-feed line;
 *  - two checks that refuse the override, one warning — and the warning is the
 *    one that matches *why* it was refused, because "not a URL" is a typo and
 *    "not https" is a downgrade attempt;
 *  - a build with no feed says nothing at all;
 *  - a line that had nowhere to go (the feed can be read before the container's
 *    logger exists) is not marked as said, so it is not lost;
 *  - and the two lines are independent, because a build can resolve its feed
 *    and later be told its override is unusable.
 *
 * ## The refusal table, checked in both directions
 *
 * `UPDATE_FEED_REFUSAL_MESSAGE` is a `Record<ChannelUrlRejection, string>`, so
 * `npm run typecheck` refuses a reason with no sentence. That is one direction,
 * and it is not the one that goes stale: a reason added to the table but never
 * produced by `resolveUpdateFeed()` is a sentence about a line nothing can
 * print. So every reason is produced through the real function below (an
 * override that is not a URL, an override that is not https) and the sentence
 * is looked up with the token the resolver returned — the same key the log line
 * carries as `reason`, which is what a support report filters on.
 *
 * The keys are also compared with a hand list, for the reason
 * `tests/contract/decision-chain.test.ts` keeps one for the drop reasons: this
 * suite is transpiled without typechecking, so nothing here can enumerate a
 * type. Without the list, a fourth reason would leave a row nobody notices —
 * `Record` would demand it, and this file would still pass while checking
 * nothing about it.
 *
 * ## And the wiring, because a rule nobody calls is not a rule
 *
 * The last block reads `bootstrap.ts` as text and asserts that the flags did not
 * grow back, that the announcer is the thing being called, and that the file
 * still resolves the feed through `resolveUpdateFeed()` rather than assembling
 * its own answer. `/opt/jev-pi-agent` cannot import that file, so a scan is the
 * only available check — and the flags are exactly the sort of local state that
 * reappears because it is two lines shorter than passing an instance.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  UPDATE_FEED_REFUSAL_MESSAGE,
  UPDATE_FEED_RESOLVED_MESSAGE,
  createUpdateFeedAnnouncer,
  type UpdateFeedLogTarget,
} from '../../apps/desktop/src/main/update-feed-log';
import {
  resolveUpdateFeed,
  type ChannelUrlRejection,
  type ResolvedUpdateFeed,
} from '../../apps/desktop/src/main/update-feed';

const here = import.meta.dirname;
const REPO_ROOT = join(here, '..', '..');
const BOOTSTRAP_PATH = join(REPO_ROOT, 'apps', 'desktop', 'src', 'main', 'bootstrap.ts');

/** One line the announcer wrote, kept with the level it was written at. */
interface LoggedLine {
  readonly level: 'info' | 'warn';
  readonly message: string;
  readonly meta: Record<string, unknown> | undefined;
}

/**
 * A logger that keeps what it was told.
 *
 * An object literal rather than a `vi.fn()` mock: the assertion here is about
 * *which* lines were said once, and a list of them fails with the lines
 * printed, while `toHaveBeenCalledTimes(1)` says only that something was
 * called once.
 */
function recorder(): { lines: LoggedLine[]; target: UpdateFeedLogTarget } {
  const lines: LoggedLine[] = [];
  return {
    lines,
    target: {
      info(message, meta) {
        lines.push({ level: 'info', message, meta });
      },
      warn(message, meta) {
        lines.push({ level: 'warn', message, meta });
      },
    },
  };
}

/**
 * A feed resolution that carries a URL, without touching the disk.
 *
 * The real sizes and sources come from `resolveUpdateFeed()` below; this is the
 * shape a resolved check has, for the tests that are about the announcing
 * rather than about the resolving.
 */
const RESOLVED: ResolvedUpdateFeed = {
  url: 'https://example.test/update-feed.json',
  source: 'env',
};

/** A build with nothing configured: no feed, and nothing refused. */
const NOT_CONFIGURED: ResolvedUpdateFeed = { url: null, source: 'none' };

/**
 * The rejection reasons, as runtime values.
 *
 * The stand-in for `ChannelUrlRejection` that the type cannot provide here;
 * `produce()` below turns each one into the real resolution a user would hit,
 * so a name on this list that the resolver no longer produces is red rather
 * than merely stale.
 */
const ALL_REFUSALS = ['invalid-url', 'not-https'] as const satisfies readonly ChannelUrlRejection[];

/** How each refusal is produced by the product, not by a hand-built object. */
const PRODUCTIONS: Record<ChannelUrlRejection, { envValue: string }> = {
  // A value that parses as nothing: the typo case.
  'invalid-url': { envValue: 'not a url at all' },
  // A value that parses and is refused for its scheme: the downgrade case.
  'not-https': { envValue: 'http://example.test/update-feed.json' },
};

describe('the update feed is announced once per process', () => {
  it('writes the resolved-feed line on the first check and not on the second', () => {
    const announcer = createUpdateFeedAnnouncer();
    const { lines, target } = recorder();

    announcer.announce(RESOLVED, target);
    announcer.announce(RESOLVED, target);
    announcer.announce(RESOLVED, target);

    // One line, at info, naming the source: the source is the part a reader
    // cannot recover from the URL, and it is why the line is worth writing.
    expect(lines, 'three checks of the same feed produced more than one line').toEqual([
      { level: 'info', message: UPDATE_FEED_RESOLVED_MESSAGE, meta: { source: 'env' } },
    ]);
  });

  it('keeps the "already said" state per announcer, not per module', () => {
    // The counter-example to the assertion above, and the reason the state is
    // not a module-level flag: a second announcer is a second process's worth
    // of "once", so it says the line again. A module-level flag would make this
    // the one test in the file that could never pass — and would also make two
    // test files silence each other.
    const first = recorder();
    createUpdateFeedAnnouncer().announce(RESOLVED, first.target);
    const second = recorder();
    createUpdateFeedAnnouncer().announce(RESOLVED, second.target);

    expect(first.lines).toHaveLength(1);
    expect(second.lines, 'a second announcer inherited the first one\'s state').toHaveLength(1);
  });

  it('says nothing for a build with no feed configured', () => {
    // A development build has no `update-config.json` and no override, and that
    // is not a problem to report every check. Silence is the observation: an
    // empty list is the answer, not a line about nothing being configured.
    const announcer = createUpdateFeedAnnouncer();
    const { lines, target } = recorder();

    announcer.announce(NOT_CONFIGURED, target);
    announcer.announce(NOT_CONFIGURED, target);

    expect(lines, 'a build with no feed logged a line about it').toEqual([]);
  });

  it('does not count a line as said when there was nowhere to say it', () => {
    // `bootstrap.ts` reads the feed after `start()`, but the announcer is
    // written to be safe before that, and the old flags were not: they were set
    // *before* the write, so a line produced while the container's logger did
    // not yet exist was dropped and recorded as delivered. The line a user
    // needs — where the feed came from — was then never printed.
    const announcer = createUpdateFeedAnnouncer();

    announcer.announce(RESOLVED, undefined);
    announcer.announce(RESOLVED, null);

    const { lines, target } = recorder();
    announcer.announce(RESOLVED, target);
    announcer.announce(RESOLVED, target);

    expect(
      lines,
      'a line dropped before the logger existed was marked as said, so it was never printed',
    ).toEqual([{ level: 'info', message: UPDATE_FEED_RESOLVED_MESSAGE, meta: { source: 'env' } }]);
  });

  it('keeps the two lines independent of each other', () => {
    // They cannot both happen for one process today — the override is read from
    // the environment once — but a shared flag would make the first line said
    // silence the second, and that is a defect nobody would see until a build
    // did both. Asserted rather than assumed so the two flags stay two.
    const announcer = createUpdateFeedAnnouncer();
    const { lines, target } = recorder();

    announcer.announce(resolveUpdateFeed(PRODUCTIONS['not-https']), target);
    announcer.announce(RESOLVED, target);

    expect(
      lines.map((line) => line.level),
      'one line silenced the other; the two announcements share a flag',
    ).toEqual(['warn', 'info']);
  });
});

describe('a refused override is reported as the refusal it was', () => {
  it('writes the sentence that matches the reason the resolver gave', () => {
    for (const reason of ALL_REFUSALS) {
      const announcer = createUpdateFeedAnnouncer();
      const { lines, target } = recorder();
      const resolved = resolveUpdateFeed(PRODUCTIONS[reason]);

      // The table is keyed by the token the resolver produces, so this is what
      // keeps the two from drifting: a row for a reason the resolver never
      // returns would be a sentence about a line nothing can print.
      expect(resolved.rejected, `${reason}: resolveUpdateFeed() did not produce this reason`).toBe(
        reason,
      );
      // Refused, not resolved: the override that was refused must not be
      // reported as a feed the build is using.
      expect(resolved.url, `${reason}: a refused override produced a feed URL`).toBeNull();

      announcer.announce(resolved, target);
      announcer.announce(resolved, target);

      expect(lines, `${reason}: the warning was written more than once`).toEqual([
        {
          level: 'warn',
          message: UPDATE_FEED_REFUSAL_MESSAGE[reason],
          // The reason travels with the line, so a report can filter on it —
          // the sentence is for the person reading the log, the token is for
          // whoever greps it.
          meta: { reason },
        },
      ]);
    }
  });

  it('does not report a typo as a downgrade attempt', () => {
    // The defect the `if`/`else` had: it paired the sentences by position, so
    // any reason that was not `invalid-url` got the https sentence. Two
    // reasons, two sentences, and neither one is the other.
    const typo = UPDATE_FEED_REFUSAL_MESSAGE['invalid-url'];
    const downgrade = UPDATE_FEED_REFUSAL_MESSAGE['not-https'];

    expect(typo, 'the two refusals share a sentence, so the log cannot name the fix').not.toBe(
      downgrade,
    );
    for (const reason of ALL_REFUSALS) {
      expect(
        UPDATE_FEED_REFUSAL_MESSAGE[reason],
        `${reason}: the sentence does not name the variable the operator has to change`,
      ).toContain('UCAD_UPDATE_FEED');
      expect(
        UPDATE_FEED_REFUSAL_MESSAGE[reason].trim(),
        `${reason}: the sentence is empty, so the warning says nothing`,
      ).not.toBe('');
    }
  });

  it('names every reason, once each, in a table a reader can count', () => {
    // The other direction, against the hand list: a row for a reason the union
    // does not have would be a sentence nothing can produce, and a duplicated
    // sentence would make two different problems look like one.
    const keys = Object.keys(UPDATE_FEED_REFUSAL_MESSAGE);
    expect(keys.sort(), 'the refusal table and ChannelUrlRejection disagree').toEqual(
      [...ALL_REFUSALS].sort(),
    );
    expect(ALL_REFUSALS.length, 'the hand list is too short to prove anything').toBeGreaterThan(1);
    expect(
      new Set(Object.values(UPDATE_FEED_REFUSAL_MESSAGE)).size,
      'two refusal reasons share one sentence',
    ).toBe(keys.length);
  });
});

describe('bootstrap keeps no announcement state of its own', () => {
  const bootstrap = existsSync(BOOTSTRAP_PATH) ? readFileSync(BOOTSTRAP_PATH, 'utf8') : '';

  it('is the file this gate is reading', () => {
    expect(bootstrap, `bootstrap.ts is missing (${BOOTSTRAP_PATH})`).not.toBe('');
    expect(bootstrap).toContain('createUpdateFeedAnnouncer');
  });

  it('has no "already logged" flags left in it', () => {
    // The two flags this module replaced. A `let …Logged = false` reappearing
    // beside the call means somebody re-derived the rule locally, where no test
    // can reach it — which is the situation this file exists to end.
    expect(
      bootstrap.match(/\blet\s+\w*Logged\w*\s*=/g) ?? [],
      'a module-level "already logged" flag is back in bootstrap.ts; keep the state in ' +
        'update-feed-log.ts, where the contract suite can drive it',
    ).toEqual([]);
    // The announcement itself, not a lookalike: the announcer is created once
    // and the resolved feed is handed to it.
    expect(
      /const\s+announceUpdateFeed\s*=\s*createUpdateFeedAnnouncer\(\)/.test(bootstrap),
      'bootstrap.ts no longer holds one announcer for the process',
    ).toBe(true);
    expect(
      /announceUpdateFeed\.announce\(/.test(bootstrap),
      'bootstrap.ts creates the announcer but never announces anything through it',
    ).toBe(true);
  });

  it('still resolves the feed through the one resolver', () => {
    // The announcement is worth nothing if the answer it announces came from
    // somewhere else: a second read of the environment or of the config file
    // in `bootstrap.ts` would produce a line that disagrees with what the
    // updater is actually checking.
    expect(
      /resolveUpdateFeed\(/.test(bootstrap),
      'bootstrap.ts does not call resolveUpdateFeed(); its announcement is about its own answer',
    ).toBe(true);
    expect(
      /process\.env\.UCAD_UPDATE_FEED/.test(bootstrap),
      'the override is read outside the resolver, so the https rule is not the one applied',
    ).toBe(true);
  });

  it('reports the feed a packaged build really writes', () => {
    // The sentence is grepped by the packaged-build smoke test, so a rename
    // here is a manual step that silently stops matching. `verify-packaged-adapters.test.ts`
    // carries the expected output verbatim; the constant and that fixture have
    // to agree, and this pins the constant.
    expect(UPDATE_FEED_RESOLVED_MESSAGE).toBe('update feed resolved');
  });
});

/**
 * The configuration-file path, exercised once end to end.
 *
 * Everything above announces a resolution this file built or the resolver
 * produced from the environment. A released build resolves from
 * `update-config.json` instead, and the source it reports is the difference a
 * reader needs — so one check goes through a real file, with the temp directory
 * removed afterwards.
 */
describe('a feed resolved from the configuration file is announced as such', () => {
  it('reports `config` as the source', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ucad-feed-log-'));
    try {
      const configPath = join(dir, 'update-config.json');
      writeFileSync(configPath, JSON.stringify({ feedUrl: 'https://example.test/feed.json' }));
      const resolved = resolveUpdateFeed({ envValue: '', configPaths: [configPath] });
      expect(resolved).toEqual({ url: 'https://example.test/feed.json', source: 'config' });

      const { lines, target } = recorder();
      createUpdateFeedAnnouncer().announce(resolved, target);
      expect(lines).toEqual([
        { level: 'info', message: UPDATE_FEED_RESOLVED_MESSAGE, meta: { source: 'config' } },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
