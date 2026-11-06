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
 * ## Who is on the hook, and by when
 *
 * A date says when the blocker was last measured. It says nothing about who is
 * supposed to close it, and that was the hole: every section said "waiting on a
 * token / a Windows machine / a person", which reads as three owners and is
 * three roles. A role does not run a command on a Tuesday afternoon, and the
 * sentence 「第一顺位是仓库所有者」 survived every round precisely because
 * nobody could be asked whether they had done it.
 *
 * So each section now carries `- **责任人**：<name> ｜ **截止**：YYYY-MM-DD` as
 * its first line, and this file refuses:
 *
 *  - a section with no owner line, or with two (one section, one owner);
 *  - an owner that is empty, a placeholder (`—`, `TBD`, `待定`), or a role
 *    rather than a name (`仓库所有者`, `the repo owner` — a name is one token);
 *  - a deadline that is missing, is not a real calendar day, or falls **before**
 *    the day the section was last re-checked — a deadline nobody could have met
 *    is a deadline that was written to look like one.
 *
 * The check is a pure function of `(document, today)`, so every red direction is
 * driven with a fixed date rather than by waiting for the calendar. The one
 * assertion that uses the real today is the one that matters to a contributor.
 *
 * ## The half a deadline was missing: how many days are left
 *
 * A deadline that is only checked for "has it passed" says nothing until it is
 * too late to act on it. `2026-11-19` sat on all three sections while the page
 * was green, and the gate had no opinion about it — the day was a wish with a
 * date on it.
 *
 * So the page is now read for the **countdown** as well: `deadlineCountdown()`
 * turns each 截止 into a number of days from a given today, and the real page is
 * asserted to carry three of them. `deadlinePressure()` is the same number as a
 * verdict — inside the window and still open is a failure — and it is driven
 * with fixed dates rather than applied to the real today, for the reason the
 * blockers page itself gives: a gate that is red for the last fortnight of every
 * deadline is answered by editing the date, not by closing the blocker. The
 * countdown is what makes the date a number today; the red is what proves the
 * rule can fire.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  blockerChecks,
  blockerSections,
  deadlineCountdown,
  deadlinePressure,
  isPlaceholderOwner,
  isRunnableCommand,
  ownerLines,
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

/**
 * Every way a section stops naming who is on the hook.
 *
 * Separate from {@link freshnessProblems} because the two answer different
 * questions and need different fixes: a stale date means "run the command
 * again", a missing owner means "decide who owns this". Collapsing them into
 * one list would leave the reader to work out which one moved.
 */
function ownerProblems(markdown: string, today: number): string[] {
  const sections = blockerSections(markdown);
  if (sections.length === 0) {
    return ['docs/blockers.md: no `## <n>. …` blocker sections, so nobody is named on any of them'];
  }

  const problems: string[] = [];
  for (const section of sections) {
    const owners = ownerLines(section.body);
    if (owners.length === 0) {
      problems.push(
        `docs/blockers.md: "${section.heading}" carries no **责任人** line, so the blocker has ` +
          'an owner in the sense that everyone does — which is to say nobody',
      );
      continue;
    }
    if (owners.length > 1) {
      problems.push(
        `docs/blockers.md: "${section.heading}" carries ${owners.length} **责任人** lines; one ` +
          'blocker has one owner, and two names mean neither is on the hook',
      );
      continue;
    }
    const [owner] = owners as [ReturnType<typeof ownerLines>[number]];
    if (isPlaceholderOwner(owner.owner)) {
      problems.push(
        `docs/blockers.md: "${section.heading}" names \`${owner.owner}\` as its 责任人, which is ` +
          'a role or a placeholder rather than a person — write the name of somebody who can be ' +
          'asked whether they have run the command',
      );
      continue;
    }
    if (owner.deadline.length === 0) {
      problems.push(
        `docs/blockers.md: "${section.heading}" names ${owner.owner} without a **截止** date, so ` +
          '"soon" is the only thing the reader can hold them to',
      );
      continue;
    }
    const deadline = utcDays(owner.deadline);
    if (deadline === null) {
      problems.push(
        `docs/blockers.md: "${section.heading}" writes 截止 as \`${owner.deadline}\`, which is ` +
          'not a real `YYYY-MM-DD` day on the calendar',
      );
      continue;
    }
    const [check] = blockerChecks(section) as ReturnType<typeof blockerChecks>;
    const measured = check === undefined ? null : utcDays(check.written);
    if (measured !== null && deadline < measured) {
      problems.push(
        `docs/blockers.md: "${section.heading}" has a 截止 of ${owner.deadline}, before the ` +
          `${check!.written} it was last re-checked — a deadline that had already passed when ` +
          'the page was written is not a deadline',
      );
      continue;
    }
    if (deadline < today) {
      // Not a failure of the page: a deadline that has passed while the blocker
      // is still open is information, and the page's own 交接记录 table is
      // where it gets recorded. Reported so the reader is not left to notice.
      problems.push(
        `docs/blockers.md: "${section.heading}" was due on ${owner.deadline}, which has passed ` +
          'and the blocker is still open — record what happened in 交接记录, or move the date ' +
          'and say why',
      );
    }
  }
  return problems;
}

/** One of the page's real lines, with its date rewritten. */
function dated(markdown: string, sectionNumber: string, date: string): string {
  // The owner line sits between the heading and the date, so the pattern allows
  // it rather than pinning the date to the first line of the body: a section
  // that gained a 责任人 line would otherwise make every driven case fail with
  // "the line was not found", which is a red gate about the test, not the page.
  const pattern = new RegExp(
    `(## ${sectionNumber}\\. [^\\n]*\\n\\n(?:- \\*\\*责任人\\*\\*：[^\\n]*\\n)?- \\*\\*最近核对\\*\\*：)\\S+`,
    'u',
  );
  const replaced = markdown.replace(pattern, `$1${date}`);
  expect(replaced, `the 最近核对 line of section ${sectionNumber} was not found`).not.toBe(markdown);
  return replaced;
}

/**
 * A fixed "today" for every driven case.
 *
 * Built with {@link utcDays} rather than `new Date(Date.UTC(…))` so the case
 * means the same on a UTC+8 box and a UTC−8 one: the arithmetic is day indices
 * either way.
 */
const TODAY = utcDays('2026-11-05')!;

/**
 * A day index back to the `YYYY-MM-DD` literal the page writes.
 *
 * The inverse of {@link utcDays}. The driven cases below pin dates **relative
 * to** the fixed "today" — one day ahead, thirty days back — and the page's
 * shape is a literal, not a number, so the offset has to be spelled back out.
 */
function dayString(day: number): string {
  return new Date(day * 86_400_000).toISOString().slice(0, 10);
}

/**
 * The live page with every 最近核对 date pinned exactly onto the fixed "today".
 *
 * This file used to spell the page's date beside the fixed "today" in four
 * places, and that made the honest act the page asks for — re-run a blocker's
 * command, move its date — turn the driven cases red for a reason that had
 * nothing to do with the rule: each case rewrites one section's date and leaves
 * the others alone, so once the live page moved past the day after "today",
 * every untouched section sat days in the future and read as a date written
 * forward. A gate that punishes the action it demands is a gate people learn
 * to route around.
 *
 * So every driven case runs on this copy: all three dates sit on `today`, the
 * literals below hold their offsets from it (thirty days stale, fifteen, one
 * ahead) for as long as the rule does, and the live page is exercised only
 * where the calendar is real — the first case — or where no date arithmetic
 * happens at all.
 */
const PINNED_DATE = dayString(TODAY);
const PINNED = BLOCKERS.replaceAll(/\*\*最近核对\*\*：\S+/gu, `**最近核对**：${PINNED_DATE}`);

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
    const problems = freshnessProblems(dated(PINNED, '1', '2026-10-06'), TODAY, MAX_AGE_DAYS);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('was last re-checked 30 days ago, over the 14');
    expect(problems[0]).toContain('node scripts/release-gate.mjs --simulate-missing-sha');
    expect(problems[0]).toContain('docs/manual-verification.md');
  });

  it('takes the boundary exactly, because a window nobody measured is a vibe', () => {
    // Both sides of the line, on the same document: 14 days old is the promise,
    // 15 is the failure. One-sided boundaries are where these windows rot.
    expect(freshnessProblems(dated(PINNED, '2', '2026-10-22'), TODAY, MAX_AGE_DAYS)).toEqual([]);
    const problems = freshnessProblems(dated(PINNED, '2', '2026-10-21'), TODAY, MAX_AGE_DAYS);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('last re-checked 15 days ago');
    expect(problems[0]).toContain('verify-main-chain.mjs --judge');
  });

  it('refuses a date in the future, which is the edit that would silence this gate', () => {
    const problems = freshnessProblems(dated(PINNED, '1', '2026-11-12'), TODAY, MAX_AGE_DAYS);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('7 day(s) from now');
    expect(problems[0]).toContain('not a re-check');

    // The slack, measured rather than asserted at zero: a page dated one day
    // ahead of the fixed "today" is two honest time zones, not a date written
    // forward. Computed from "today" rather than spelled, so the case keeps
    // meaning that for as long as the rule does.
    expect(
      freshnessProblems(dated(PINNED, '1', dayString(TODAY + 1)), TODAY, MAX_AGE_DAYS),
    ).toEqual([]);
  });

  it('refuses a placeholder and a day the calendar does not have', () => {
    // The template a contributor copies, and the date that quietly rolls into
    // March when `Date.UTC` is trusted instead of read back.
    expect(freshnessProblems(dated(PINNED, '3', 'YYYY-MM-DD'), TODAY, MAX_AGE_DAYS)).toEqual([
      expect.stringContaining('writes 最近核对 as `YYYY-MM-DD`, which is not a real'),
    ]);
    expect(freshnessProblems(dated(PINNED, '3', '2026-02-30'), TODAY, MAX_AGE_DAYS)).toEqual([
      expect.stringContaining('writes 最近核对 as `2026-02-30`, which is not a real'),
    ]);
  });

  it('reports a section whose line was deleted, and one that grew a second', () => {
    const second = blockerSections(PINNED)[1]!;
    const check = blockerChecks(second)[0]!;
    // The line and its own newline, not "the line and the blank line after it":
    // the page is free to put another bullet directly under this one, and a
    // mutation tied to the blank line would then fail to apply and report a red
    // gate about the test instead of about the page.
    const removed = PINNED.replace(`${check.line}\n`, '');
    expect(removed).not.toBe(PINNED);
    expect(freshnessProblems(removed, TODAY, MAX_AGE_DAYS)).toEqual([
      expect.stringContaining('carries no **最近核对** line'),
    ]);

    const doubled = PINNED.replace(check.line, `${check.line}\n${check.line}`);
    expect(freshnessProblems(doubled, TODAY, MAX_AGE_DAYS)).toEqual([
      expect.stringContaining('carries 2 **最近核对** lines'),
    ]);
  });

  it('insists the date travels with a command it can run', () => {
    const withoutCommand = PINNED.replace(
      new RegExp(`(\\*\\*最近核对\\*\\*：${PINNED_DATE}) ｜ \\*\\*重跑这一条\\*\\*：\`[^\`]+\``, 'u'),
      '$1',
    );
    expect(withoutCommand).not.toBe(PINNED);
    expect(freshnessProblems(withoutCommand, TODAY, MAX_AGE_DAYS)).toEqual([
      expect.stringContaining('gives a date without a **重跑这一条** command'),
    ]);

    // A section that names something this repository cannot run is the same
    // defect one word over: the reader cannot act on the failure.
    const prose = PINNED.replace('`node scripts/screenshot-sources.mjs --check`', '`请人看一眼`');
    expect(freshnessProblems(prose, TODAY, MAX_AGE_DAYS)).toEqual([
      expect.stringContaining('is neither `node scripts/…` nor `npm run …`'),
    ]);
  });

  it('is red when the page loses every section, not green over an empty list', () => {
    expect(
      freshnessProblems('# blockers\n\nnothing here\n', todayInUtcDays(), MAX_AGE_DAYS),
    ).toEqual([expect.stringContaining('no `## <n>. …` blocker sections')]);
  });

  it('names a person and a deadline on every blocker', () => {
    // The half a date cannot carry: a date says when the blocker was measured,
    // not who is supposed to close it. Every section has to name somebody a
    // reader could go and ask, and a day they committed to. The verdict runs on
    // the pinned copy — it reads the 最近核对 date — while the structure loop
    // below reads the live page.
    expect(ownerProblems(PINNED, TODAY)).toEqual([]);
    for (const section of blockerSections(BLOCKERS)) {
      const [owner] = ownerLines(section.body) as ReturnType<typeof ownerLines>;
      expect(owner, `"${section.heading}" has no 责任人 line`).toBeDefined();
      expect(isPlaceholderOwner(owner.owner), `"${section.heading}" names a role`).toBe(false);
      expect(utcDays(owner.deadline), `"${section.heading}" has no real 截止`).not.toBeNull();
    }
  });

  it('refuses a role where a name belongs, and says which section', () => {
    // The sentence this round replaced: 「第一顺位是仓库所有者」. It reads as an
    // owner and is not one — nobody can be asked whether they have done it.
    for (const role of ['仓库所有者', '—', 'TBD', '待定', 'the repo owner']) {
      const problems = ownerProblems(
        PINNED.replace('- **责任人**：castorhrio ｜', `- **责任人**：${role} ｜`),
        TODAY,
      );
      expect(problems, `\`${role}\` was accepted as a name`).toHaveLength(1);
      expect(problems[0]).toContain('is a role or a placeholder rather than a person');
      expect(problems[0]).toContain('1. 已发布');
    }
  });

  it('refuses a deadline that is missing, impossible, or already past when written', () => {
    const withoutDeadline = PINNED.replace(
      '- **责任人**：castorhrio ｜ **截止**：2026-11-19',
      '- **责任人**：castorhrio',
    );
    expect(withoutDeadline).not.toBe(PINNED);
    expect(ownerProblems(withoutDeadline, TODAY)).toEqual([
      expect.stringContaining('without a **截止** date'),
    ]);

    const impossible = PINNED.replace('**截止**：2026-11-19', '**截止**：2026-02-30');
    expect(ownerProblems(impossible, TODAY)).toEqual([
      expect.stringContaining('writes 截止 as `2026-02-30`'),
    ]);

    // A deadline earlier than the day the section was last re-checked is a
    // deadline that had already passed when it was written down.
    const backwards = PINNED.replace('**截止**：2026-11-19', '**截止**：2026-10-01');
    expect(ownerProblems(backwards, TODAY)).toEqual([
      expect.stringContaining(`before the ${PINNED_DATE} it was last re-checked`),
    ]);
  });

  it('reports a deadline that passed while the blocker stayed open', () => {
    // The pressure a deadline is for. Driven with a fixed "today" so the case
    // means the same on any machine: on 2026-11-20 the page above is red, and
    // the fix is a line in 交接记录 or a new date with a reason — not silence.
    const later = utcDays('2026-11-20')!;
    const problems = ownerProblems(PINNED, later);
    expect(problems).toHaveLength(3);
    expect(problems[0]).toContain('was due on 2026-11-19');
    expect(problems[0]).toContain('交接记录');
    // And the day before, the same page is green: the boundary is measured.
    expect(ownerProblems(PINNED, utcDays('2026-11-19')!)).toEqual([]);
  });

  it('reports a section whose owner line was deleted, and one that grew a second', () => {
    const second = blockerSections(PINNED)[1]!;
    const [owner] = ownerLines(second.body) as ReturnType<typeof ownerLines>;
    const removed = PINNED.replace(`${owner.line}\n`, '');
    expect(removed).not.toBe(PINNED);
    expect(ownerProblems(removed, TODAY)).toEqual([
      expect.stringContaining('carries no **责任人** line'),
    ]);

    const doubled = PINNED.replace(owner.line, `${owner.line}\n${owner.line}`);
    expect(ownerProblems(doubled, TODAY)).toEqual([
      expect.stringContaining('carries 2 **责任人** lines'),
    ]);
  });

  it('cannot tell a re-check from an edit, and says so in a failing case', () => {
    // The blind spot, stated as an assertion rather than a footnote. The same
    // document changed in one date cell only: red while nobody had looked, green
    // the moment that cell was edited — with nothing run in between. This gate
    // measures the age of a date; the command printed beside the failure is the
    // part that can actually be wrong.
    const stale = dated(PINNED, '1', '2026-10-06');
    expect(freshnessProblems(stale, TODAY, MAX_AGE_DAYS)).toHaveLength(1);
    expect(freshnessProblems(dated(stale, '1', PINNED_DATE), TODAY, MAX_AGE_DAYS)).toEqual([]);
  });
});

describe('a deadline is a number of days, not a wish', () => {
  it('counts the days left on every open blocker', () => {
    // The page's own dates against a fixed today: 2026-11-05 → 2026-11-19 is
    // fourteen days, on all three sections. Asserted as numbers rather than as
    // "the deadline exists", because a date nobody subtracts from is the thing
    // this describe exists to stop being enough.
    const countdown = deadlineCountdown(BLOCKERS, TODAY);
    expect(countdown).toHaveLength(3);
    expect(countdown.map((entry) => entry.daysLeft)).toEqual([14, 14, 14]);
    for (const entry of countdown) {
      expect(entry.owner, `"${entry.heading}" names no owner`).toBe('castorhrio');
      expect(entry.deadline, `"${entry.heading}" moved its deadline`).toBe('2026-11-19');
    }
  });

  it('reports a blocker inside the window, and stays quiet outside it', () => {
    // Both sides of the boundary on the same document: fourteen days left is
    // inside a fourteen-day window and outside a thirteen-day one.
    expect(deadlinePressure(BLOCKERS, TODAY, 14)).toHaveLength(3);
    expect(deadlinePressure(BLOCKERS, TODAY, 13)).toEqual([]);

    // A week out, the failure carries the number rather than the mood.
    const problems = deadlinePressure(BLOCKERS, utcDays('2026-11-12')!, 14);
    expect(problems).toHaveLength(3);
    expect(problems[0]).toContain('is due on 2026-11-19, 7 day(s) from now');
    expect(problems[0]).toContain('交接记录');
  });

  it('leaves a passed deadline to the rule that already reports it', () => {
    // One defect, one message. On 2026-11-20 the day has passed, and
    // `ownerProblems()` is the gate that says so — a countdown that also fired
    // there would report the same line twice in two different words.
    expect(deadlinePressure(BLOCKERS, utcDays('2026-11-20')!, 14)).toEqual([]);
    expect(ownerProblems(BLOCKERS, utcDays('2026-11-20')!)).toHaveLength(3);
  });

  it('counts from the page, so a moved deadline moves the number', () => {
    // The countdown is read from the document, not from a constant in this
    // file: moving the date forward by a fortnight empties the window.
    const moved = BLOCKERS.replaceAll('**截止**：2026-11-19', '**截止**：2026-12-03');
    expect(moved).not.toBe(BLOCKERS);
    expect(deadlineCountdown(moved, TODAY).map((entry) => entry.daysLeft)).toEqual([28, 28, 28]);
    expect(deadlinePressure(moved, TODAY, 14)).toEqual([]);
  });
});
