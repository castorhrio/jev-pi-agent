/**
 * The blockers page, read as sections — one parser for the gates that walk it.
 *
 * ## Why this is a module and not two functions
 *
 * `docs/blockers.md` is now judged by four gates that ask different questions
 * about the same document shape:
 *
 *  - `doc-routing.test.ts` asks whether every blocker still carries its three
 *    parts (the command, the expected output, where the result goes);
 *  - `blocker-freshness.test.ts` asks whether every blocker says **when** it was
 *    last re-checked, and how long ago that was;
 *  - `blocker-closing.test.ts` asks whether every blocker says what to do the
 *    moment it lifts — the command, the line it prints, the documents to edit;
 *  - `blocker-parity.test.ts` asks whether the two other copies of each blocker
 *    (`README.md` and `docs/dod-status.md`) say the **same** command, the same
 *    「需要…」 and the same expected first line.
 *
 * All four need "what a `## 1. …` section is", and the last two need "what the
 * first line under this marker is". Written twice, the two definitions can drift
 * — and the drift is invisible in the worst direction: a gate whose section regex
 * stops matching reads an empty list and reports nothing, so one gate goes quiet
 * while the other keeps printing green beside it. This repository has removed
 * that shape before (`findingLine()` shared between two commands,
 * `app-rules-build.ts` shared between four tests); a shared reader is the same
 * move one level down.
 */

/** One `## 1. …` section: its heading text (without the number) and its body. */
export interface BlockerSection {
  readonly heading: string;
  readonly body: string;
}

/**
 * The freshness line every blocker section carries, as written.
 *
 * `written` keeps the literal rather than a parsed date on purpose: when the
 * date is a `YYYY-MM-DD` placeholder or an impossible day, the failure has to
 * quote what the document says instead of reporting `NaN`.
 */
export interface BlockerCheck {
  readonly written: string;
  /** The command the section names to re-check it, or null when the line lost it. */
  readonly command: string | null;
  /** The whole line, so a failure can point at it. */
  readonly line: string;
}

/**
 * The line that names who owns a blocker and by when.
 *
 * A blocker page that says "waiting on a person" is a page where every row has
 * an owner and no row has a name: a role does not run a command on a Tuesday
 * afternoon. The owner is kept as written so a failure can quote it, and the
 * deadline is kept as a literal for the same reason the 最近核对 date is — a
 * placeholder has to be reported as the text the document carries, not as
 * `NaN`.
 */
export interface OwnerLine {
  /** The person's name or handle, as written. */
  readonly owner: string;
  /** The `YYYY-MM-DD` the owner committed to, as written. */
  readonly deadline: string;
  /** The whole line, so a failure can point at it. */
  readonly line: string;
}

/** The marker an owner line starts from. */
const OWNER_MARKER = '**责任人**：';

/** The marker the deadline half of that line starts from. */
const DEADLINE_MARKER = '**截止**：';

/**
 * Words that name a role rather than a person.
 *
 * The page used to say "第一顺位是仓库所有者", which reads as an owner and is
 * not one: nobody is on the hook, and the sentence survives every round. These
 * are the shapes a placeholder takes in this repository's documents, plus the
 * em dash the record tables use for "nobody yet".
 */
const PLACEHOLDER_OWNERS = new Set([
  '—',
  '-',
  '–',
  'TBD',
  'TODO',
  'tbd',
  'todo',
  '待定',
  '某人',
  '负责人',
  '仓库所有者',
  'n/a',
  'N/A',
]);

/**
 * Every owner line in a section body, in the order they appear.
 *
 * Read from the body rather than from the whole page so the same parser serves
 * `docs/blockers.md` and the walkthrough's "nobody has signed" section: both
 * ask "who is on the hook, and by when", and two parsers would let one document
 * drift into a shape the other gate cannot read.
 */
export function ownerLines(text: string): OwnerLine[] {
  const lines: OwnerLine[] = [];
  for (const line of text.split('\n')) {
    const at = line.indexOf(OWNER_MARKER);
    if (at === -1) continue;
    const after = line.slice(at + OWNER_MARKER.length);
    const owner = (after.split('｜')[0] ?? '').trim();
    const deadlineAt = line.indexOf(DEADLINE_MARKER);
    const deadline =
      deadlineAt === -1
        ? ''
        : (/^\S+/u.exec(line.slice(deadlineAt + DEADLINE_MARKER.length))?.[0] ?? '').replace(
            /[）)。，,]+$/u,
            '',
          );
    lines.push({ owner, deadline, line });
  }
  return lines;
}

/**
 * Whether an owner cell names a role, a placeholder, or nobody at all.
 *
 * A name is one token: `castorhrio` and `张三` pass, `仓库所有者 castorhrio` and
 * `the repo owner` do not. That is the whole rule, and it is deliberately about
 * shape rather than about a list of people — the gate cannot know who is
 * available, only that the page named someone a reader could go and ask.
 */
export function isPlaceholderOwner(owner: string): boolean {
  const trimmed = owner.trim();
  if (trimmed.length === 0) return true;
  if (PLACEHOLDER_OWNERS.has(trimmed)) return true;
  // A role is a phrase; a name is a word. Whitespace is what separates them.
  return /\s/u.test(trimmed);
}

/** The heading of each external blocker: `## <number>. <title>`. */
const BLOCKER_HEADING = /^## \d+\. /;

/** A `## ` heading that is not a blocker still ends a blocker's section. */
const ANY_HEADING = /^## /;

/** The marker a section's freshness line starts from. */
const CHECKED_ON = '**最近核对**：';

/** The command that line has to name. */
const RECHECK_PREFIX = '**重跑这一条**：';

/**
 * The `## 1. …` sections of the blockers page, heading and body.
 *
 * A body runs to the next `## ` of any kind, so a section that grew an
 * unnumbered heading beside it does not swallow the page.
 */
export function blockerSections(markdown: string): BlockerSection[] {
  const sections: BlockerSection[] = [];
  const lines = markdown.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const heading = lines[index]!;
    if (!BLOCKER_HEADING.test(heading)) continue;
    const body: string[] = [];
    for (let next = index + 1; next < lines.length; next += 1) {
      const line = lines[next]!;
      if (ANY_HEADING.test(line)) break;
      body.push(line);
    }
    sections.push({ heading: heading.slice(3), body: body.join('\n') });
  }
  return sections;
}

/** Every freshness line in a section, in the order they appear. */
export function blockerChecks(section: BlockerSection): BlockerCheck[] {
  const checks: BlockerCheck[] = [];
  for (const line of section.body.split('\n')) {
    const at = line.indexOf(CHECKED_ON);
    if (at === -1) continue;
    const after = line.slice(at + CHECKED_ON.length);
    const written = /^\S+/u.exec(after)?.[0] ?? '';
    const commandAt = line.indexOf(RECHECK_PREFIX);
    const command =
      commandAt === -1
        ? null
        : (/`([^`]+)`/u.exec(line.slice(commandAt + RECHECK_PREFIX.length))?.[0] ?? null);
    checks.push({
      written: written.replace(/[）)。，,]+$/u, ''),
      command: command === null ? null : command.replace(/^`|`$/gu, ''),
      line,
    });
  }
  return checks;
}

/** A `YYYY-MM-DD` as UTC day indices, or null when it is not a real calendar day. */
export function utcDays(date: string): number | null {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(date);
  if (parts === null) return null;
  const [year, month, day] = [Number(parts[1]), Number(parts[2]), Number(parts[3])] as const;
  const stamped = Date.UTC(year, month - 1, day);
  if (Number.isNaN(stamped)) return null;
  // A date the calendar does not have (`2026-02-30`) rolls over into March
  // instead of failing, so it is read back and compared rather than trusted.
  const read = new Date(stamped);
  if (
    read.getUTCFullYear() !== year ||
    read.getUTCMonth() !== month - 1 ||
    read.getUTCDate() !== day
  ) {
    return null;
  }
  return Math.floor(stamped / 86_400_000);
}

/**
 * Today, as a UTC day index, on the calendar the person running the gate sees.
 *
 * Read from the machine's **local** date components, not from
 * `floor(Date.now() / 86_400_000)`. A document is dated with the day its author
 * wrote it, and that author is in some civil time zone: on a UTC+8 box, a line
 * legitimately written today (2026-11-05) is still 20:xx UTC of the previous
 * day, so a UTC-based "today" reports it as a date from the future and the gate
 * goes red for nobody's defect. The comparison stays exact because both sides
 * are indices of UTC midnights once the local date is converted — no daylight
 * saving, no fractional days.
 */
export function todayInUtcDays(now: Date = new Date()): number {
  const pad = (value: number): string => String(value).padStart(2, '0');
  const written = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const day = utcDays(written);
  if (day === null) {
    throw new Error(`the machine reported a local date the calendar does not have: ${written}`);
  }
  return day;
}

/** Whether a re-check line names something this repository can actually run. */
export function isRunnableCommand(command: string): boolean {
  return /^(node\s+scripts[\\/][\w.-]+\.(?:mjs|cjs|js|ts)\b|npm run [\w:.-]+\b)/u.test(command.trim());
}

/**
 * One blocker's deadline, as a number of days from a given "today".
 *
 * `daysLeft` is negative once the day has passed, which is the state
 * `ownerProblems()` reports as "due on … and still open". Kept as a separate
 * reader because the two questions are different: *has the day passed* is a
 * verdict, *how many days are left* is a countdown, and a page that only
 * answers the first one says nothing until it is too late to act.
 */
export interface DeadlineCountdown {
  readonly heading: string;
  /** The person on the hook, as written. */
  readonly owner: string;
  /** The `YYYY-MM-DD` the owner committed to, as written. */
  readonly deadline: string;
  /** Days from `today` to the deadline; negative once it has passed. */
  readonly daysLeft: number;
}

/**
 * Every blocker that names a real deadline, with the days left on it.
 *
 * Sections whose owner line is missing or whose deadline is not a calendar day
 * are skipped rather than reported: `ownerProblems()` already fails on those,
 * and a countdown computed from `NaN` would be a second, quieter verdict about
 * the same line.
 */
export function deadlineCountdown(markdown: string, today: number): DeadlineCountdown[] {
  const countdown: DeadlineCountdown[] = [];
  for (const section of blockerSections(markdown)) {
    const [owner] = ownerLines(section.body) as [OwnerLine?];
    if (owner === undefined) continue;
    const deadline = utcDays(owner.deadline);
    if (deadline === null) continue;
    countdown.push({
      heading: section.heading,
      owner: owner.owner,
      deadline: owner.deadline,
      daysLeft: deadline - today,
    });
  }
  return countdown;
}

/**
 * Every blocker whose deadline is inside `windowDays` and has not passed yet.
 *
 * This is the countdown as a verdict. It is deliberately **not** applied to the
 * real page with the real today: a gate that is red for the last fortnight of
 * every deadline is answered by editing the date, not by closing the blocker,
 * and this repository has already written down why that is the wrong trade
 * (`docs/blockers.md`: 「日期变新而命令的输出照旧，说的是这条阻塞还在原地」).
 * What the real page gets instead is {@link deadlineCountdown} — the number of
 * days left, asserted on every run — and this rule is driven with fixed dates,
 * so the red direction is measured rather than waited for.
 */
export function deadlinePressure(
  markdown: string,
  today: number,
  windowDays: number,
): string[] {
  const problems: string[] = [];
  for (const entry of deadlineCountdown(markdown, today)) {
    if (entry.daysLeft < 0 || entry.daysLeft > windowDays) continue;
    problems.push(
      `docs/blockers.md: "${entry.heading}" is due on ${entry.deadline}, ${entry.daysLeft} ` +
        `day(s) from now — inside the ${windowDays}-day window this gate watches, and the ` +
        'blocker is still open. Close it, or move the date and say why in 交接记录',
    );
  }
  return problems;
}

/** The heading a closing recipe starts at. */
export const CLOSING_HEADING = '### 解除时';

/** One blocker's closing recipe: which section it belongs to, and its text. */
export interface ClosingRecipe {
  readonly heading: string;
  /** From the line after `### 解除时` to the next heading of either level. */
  readonly body: string;
}

/**
 * The `### 解除时` subsection of a blocker section, or undefined when it has none.
 *
 * Read from a section body rather than the whole page, so a recipe cannot be
 * matched to the wrong blocker when one section loses its subsection and the
 * next one keeps its own.
 */
export function closingRecipe(section: BlockerSection): ClosingRecipe | undefined {
  const lines = section.body.split('\n');
  const start = lines.findIndex((line) => line.startsWith(CLOSING_HEADING));
  if (start === -1) return undefined;
  const body: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.startsWith('## ') || line.startsWith('### ')) break;
    body.push(line);
  }
  return { heading: section.heading, body: body.join('\n') };
}

/** The marker a closing recipe's command sits under. */
export const RUN_MARKER = '**跑这一条**';

/** The marker a closing recipe's expected first line sits under. */
export const FIRST_LINE_MARKER = '**屏幕上第一行**';

/**
 * The first non-empty line of the first fenced block after `marker`.
 *
 * The opening fence carries a language tag on the same line (```bash), so the
 * block starts after that line rather than after the three backticks — otherwise
 * `bash` reads as the command and every recipe fails the same way.
 */
export function blockAfter(body: string, marker: string): string | undefined {
  const at = body.indexOf(marker);
  if (at === -1) return undefined;
  const rest = body.slice(at + marker.length);
  const fence = rest.indexOf('```');
  if (fence === -1) return undefined;
  const afterFence = rest.slice(fence + 3);
  const firstBreak = afterFence.indexOf('\n');
  if (firstBreak === -1) return undefined;
  const fenced = afterFence.slice(firstBreak + 1);
  const close = fenced.indexOf('```');
  const block = close === -1 ? fenced : fenced.slice(0, close);
  return block
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);
}
