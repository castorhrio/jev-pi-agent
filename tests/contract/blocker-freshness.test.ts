/**
 * An external blocker nobody has re-read is not a blocker — it is a rumour.
 *
 * ## Why this file exists
 *
 * `docs/blockers.md` is the single page that says what this repository is
 * waiting on: a `contents: write` token, a Windows machine, a person. All three
 * have been on that page for several rounds, and every round has honestly
 * written 「仍阻塞」. But the page cannot tell two very different states apart:
 *
 *  - *somebody ran the check last week and the blocker is still there*, and
 *  - *nobody has looked since it was written, and it may have been closed by
 *    someone else three rounds ago.*
 *
 * The difference is not cosmetic. The second one is how a repository goes on
 * refusing to publish because of a defect that stopped existing, and how a
 * reviewer reports an open blocker that has been closed. The commands that
 * answer the question already exist and already run offline
 * (`--simulate-missing-sha`, `--judge`, `screenshot-sources --check`) — what was
 * missing was anything that asks whether anybody has *run* them lately.
 *
 * ## What is asserted
 *
 * Each `## <n>. …` section carries one line of the shape
 * `- **最近核对**：YYYY-MM-DD ｜ **重跑这一条**：\`node scripts/…\``. This gate
 * reads that line and fails when:
 *
 *  - the page has no sections at all, or a section lost its line;
 *  - the line names no command, or a command this repository cannot run — the
 *    date is only worth having if the failure can say what to do about it;
 *  - the literal is not `YYYY-MM-DD`, is a placeholder like `YYYY-MM-DD`, or is
 *    a day the calendar does not have (`2026-02-30`);
 *  - the date is in the future;
 *  - the date is older than {@link MAX_AGE_DAYS}.
 *
 * ## What it deliberately cannot see, said here rather than found later
 *
 * It checks the **freshness of the date**, not the **fact of the re-check**. A
 * reader who edits the date without running anything gets a green gate; nothing
 * in this repository can prove that a person typed a command, without a network
 * call the suite is not allowed to make. That is why every date on that page
 * travels with the command it came from, and why the page says the same thing in
 * its own words: the verdict lives in the command's exit code, and a date that
 * got newer while the output stayed the same means the blocker is still there —
 * which is information, not noise.
 *
 * The check is a pure function of `(document, today)`, so every red direction is
 * driven with a fixed date rather than by waiting for the calendar. The one
 * assertion that uses the real today is the one that matters to a contributor.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  blockerChecks,
  blockerSections,
  isRunnableCommand,
  todayInUtcDays,
  utcDays,
} from './blockers-doc.ts';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const BLOCKERS_PATH = join(REPO_ROOT, 'docs', 'blockers.md');
const BLOCKERS = existsSync(BLOCKERS_PATH) ? readFileSync(BLOCKERS_PATH, 'utf8') : '';

/**
 * How stale a 最近核对 line may get before it is reported.
 *
 * Fourteen days, not "a round": the three blockers here are checked by humans in
 * other time zones, and a window shorter than a fortnight would go red between
 * two ordinary reviews without anything having changed. Longer, and the page has
 * been unread for a release cycle.
 */
const MAX_AGE_DAYS = 14;

/**
 * How far ahead of this machine's calendar a date may sit before it is refused.
 *
 * One day, not zero: a blocker is dated with the **local** civil date the author
 * was living in, and civil time zones span UTC−12 to UTC+14, so two honest
 * machines can disagree about which day it is. Zero tolerance would make a
 * correctly dated page red for a reader west of the author, which is a red gate
 * about the time zone rather than about the blocker. A date ahead by more than a
 * day is not a time zone — it is the page being dated forward, which is the one
 * edit that would make this gate mean nothing.
 */
const MAX_FUTURE_DAYS = 1;

/**
 * Every way the blockers page can have stopped being a current statement.
 *
 * Empty means each section says when it was last re-checked, names a command it
 * can actually run, and that date is real, not in the future, and no older than
 * {@link MAX_AGE_DAYS}.
 */
function freshnessProblems(markdown: string, today: number, maxAge: number): string[] {
  const sections = blockerSections(markdown);
  if (sections.length === 0) {
    return ['docs/blockers.md: no `## <n>. …` blocker sections, so there is nothing to age'];
  }

  const problems: string[] = [];
  for (const section of sections) {
    const checks = blockerChecks(section);
    if (checks.length === 0) {
      problems.push(
        `docs/blockers.md: "${section.heading}" carries no **最近核对** line, so nobody can tell ` +
          'when this was last measured — or whether it is still true',
      );
      continue;
    }
    if (checks.length > 1) {
      problems.push(
        `docs/blockers.md: "${section.heading}" carries ${checks.length} **最近核对** lines; one ` +
          'section can only have one last-checked date, and two say the reader should choose',
      );
      continue;
    }
    const [check] = checks as [ReturnType<typeof blockerChecks>[number]];
    const stamped = utcDays(check.written);
    if (stamped === null) {
      problems.push(
        `docs/blockers.md: "${section.heading}" writes 最近核对 as \`${check.written}\`, which is ` +
          'not a real `YYYY-MM-DD` day on the calendar',
      );
      continue;
    }
    if (check.command === null) {
      problems.push(
        `docs/blockers.md: "${section.heading}" gives a date without a **重跑这一条** command, so ` +
          'a stale date cannot tell the reader what to run to make it true again',
      );
      continue;
    }
    if (!isRunnableCommand(check.command)) {
      problems.push(
        `docs/blockers.md: "${section.heading}" names \`${check.command}\` as its re-check, which ` +
          'is neither `node scripts/…` nor `npm run …` — nothing in this repository runs it',
      );
      continue;
    }

    const age = today - stamped;
    if (age < -MAX_FUTURE_DAYS) {
      problems.push(
        `docs/blockers.md: "${section.heading}" was last re-checked ${-age} day(s) from now, past ` +
          `the ${MAX_FUTURE_DAYS}-day slack that separates two honest time zones from a date ` +
          'written forward. A re-check that has not happened yet is not a re-check',
      );
    } else if (age > maxAge) {
      problems.push(
        `docs/blockers.md: "${section.heading}" was last re-checked ${age} days ago, over the ` +
          `${maxAge} this gate allows. Run \`${check.command}\`, put what it printed in ` +
          `\`docs/manual-verification.md\`, and then update that date`,
      );
    }
  }
  return problems;
}

/** One of the page's real lines, with its date rewritten. */
function dated(markdown: string, sectionNumber: string, date: string): string {
  const pattern = new RegExp(`(## ${sectionNumber}\\. [^\\n]*\\n\\n- \\*\\*最近核对\\*\\*：)\\S+`, 'u');
  const replaced = markdown.replace(pattern, `$1${date}`);
  expect(replaced, `the 最近核对 line of section ${sectionNumber} was not found`).not.toBe(markdown);
  return replaced;
}

/**
 * A fixed "today" for every driven case.
 *
 * Built with {@link utcDays} rather than `new Date(Date.UTC(…))` so the case
 * means the same on a UTC+8 box and a UTC−8 one: the document is dated
 * `2026-11-05`, and the arithmetic is day indices either way.
 */
const TODAY = utcDays('2026-11-05')!;

describe('a blocker says when it was last measured', () => {
  it('finds every blocker freshly re-checked, by a command it names', () => {
    expect(freshnessProblems(BLOCKERS, todayInUtcDays(), MAX_AGE_DAYS)).toEqual([]);
  });

  it('reads the real page, so the checks above are not vacuous', () => {
    const sections = blockerSections(BLOCKERS);
    expect(sections.length, 'docs/blockers.md lost its numbered sections').toBe(3);
    for (const section of sections) {
      const [check] = blockerChecks(section) as ReturnType<typeof blockerChecks>;
      expect(check, `"${section.heading}" has no 最近核对 line`).toBeDefined();
      expect(check.command, `"${section.heading}" has no re-check command`).not.toBeNull();
      // And the command is one this repository owns, not a sentence about one.
      expect(isRunnableCommand(check.command!)).toBe(true);
    }
  });

  it('ages a blocker out, and names the command that would make the date true again', () => {
    // 2026-10-06 against a "today" of 2026-11-05: exactly thirty days. Both
    // dates are held fixed, so the window is measured rather than assumed from
    // whenever this file happens to run.
    const problems = freshnessProblems(dated(BLOCKERS, '1', '2026-10-06'), TODAY, MAX_AGE_DAYS);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('was last re-checked 30 days ago, over the 14');
    expect(problems[0]).toContain('node scripts/release-gate.mjs --simulate-missing-sha');
    expect(problems[0]).toContain('docs/manual-verification.md');
  });

  it('takes the boundary exactly, because a window nobody measured is a vibe', () => {
    // Both sides of the line, on the same document: 14 days old is the promise,
    // 15 is the failure. One-sided boundaries are where these windows rot.
    expect(freshnessProblems(dated(BLOCKERS, '2', '2026-10-22'), TODAY, MAX_AGE_DAYS)).toEqual([]);
    const problems = freshnessProblems(dated(BLOCKERS, '2', '2026-10-21'), TODAY, MAX_AGE_DAYS);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('last re-checked 15 days ago');
    expect(problems[0]).toContain('verify-main-chain.mjs --judge');
  });

  it('refuses a date in the future, which is the edit that would silence this gate', () => {
    const problems = freshnessProblems(dated(BLOCKERS, '1', '2026-11-12'), TODAY, MAX_AGE_DAYS);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('7 day(s) from now');
    expect(problems[0]).toContain('not a re-check');

    // The slack, measured rather than asserted at zero: a page dated one day
    // ahead is two honest time zones, not a date written forward.
    expect(freshnessProblems(dated(BLOCKERS, '1', '2026-11-06'), TODAY, MAX_AGE_DAYS)).toEqual([]);
  });

  it('refuses a placeholder and a day the calendar does not have', () => {
    // The template a contributor copies, and the date that quietly rolls into
    // March when `Date.UTC` is trusted instead of read back.
    expect(freshnessProblems(dated(BLOCKERS, '3', 'YYYY-MM-DD'), TODAY, MAX_AGE_DAYS)).toEqual([
      expect.stringContaining('writes 最近核对 as `YYYY-MM-DD`, which is not a real'),
    ]);
    expect(freshnessProblems(dated(BLOCKERS, '3', '2026-02-30'), TODAY, MAX_AGE_DAYS)).toEqual([
      expect.stringContaining('writes 最近核对 as `2026-02-30`, which is not a real'),
    ]);
  });

  it('reports a section whose line was deleted, and one that grew a second', () => {
    const second = blockerSections(BLOCKERS)[1]!;
    const check = blockerChecks(second)[0]!;
    const removed = BLOCKERS.replace(`${check.line}\n\n`, '\n');
    expect(removed).not.toBe(BLOCKERS);
    expect(freshnessProblems(removed, TODAY, MAX_AGE_DAYS)).toEqual([
      expect.stringContaining('carries no **最近核对** line'),
    ]);

    const doubled = BLOCKERS.replace(check.line, `${check.line}\n${check.line}`);
    expect(freshnessProblems(doubled, TODAY, MAX_AGE_DAYS)).toEqual([
      expect.stringContaining('carries 2 **最近核对** lines'),
    ]);
  });

  it('insists the date travels with a command it can run', () => {
    const withoutCommand = BLOCKERS.replace(
      /(\*\*最近核对\*\*：2026-11-05) ｜ \*\*重跑这一条\*\*：`[^`]+`/u,
      '$1',
    );
    expect(withoutCommand).not.toBe(BLOCKERS);
    expect(freshnessProblems(withoutCommand, TODAY, MAX_AGE_DAYS)).toEqual([
      expect.stringContaining('gives a date without a **重跑这一条** command'),
    ]);

    // A section that names something this repository cannot run is the same
    // defect one word over: the reader cannot act on the failure.
    const prose = BLOCKERS.replace('`node scripts/screenshot-sources.mjs --check`', '`请人看一眼`');
    expect(freshnessProblems(prose, TODAY, MAX_AGE_DAYS)).toEqual([
      expect.stringContaining('is neither `node scripts/…` nor `npm run …`'),
    ]);
  });

  it('is red when the page loses every section, not green over an empty list', () => {
    expect(
      freshnessProblems('# blockers\n\nnothing here\n', todayInUtcDays(), MAX_AGE_DAYS),
    ).toEqual([expect.stringContaining('no `## <n>. …` blocker sections')]);
  });

  it('cannot tell a re-check from an edit, and says so in a failing case', () => {
    // The blind spot, stated as an assertion rather than a footnote. The same
    // document changed in one date cell only: red while nobody had looked, green
    // the moment that cell was edited — with nothing run in between. This gate
    // measures the age of a date; the command printed beside the failure is the
    // part that can actually be wrong.
    const stale = dated(BLOCKERS, '1', '2026-10-06');
    expect(freshnessProblems(stale, TODAY, MAX_AGE_DAYS)).toHaveLength(1);
    expect(freshnessProblems(dated(stale, '1', '2026-11-05'), TODAY, MAX_AGE_DAYS)).toEqual([]);
  });
});
