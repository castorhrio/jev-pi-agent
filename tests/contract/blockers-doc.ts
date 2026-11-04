/**
 * The blockers page, read as sections — one parser for the gates that walk it.
 *
 * ## Why this is a module and not two functions
 *
 * `docs/blockers.md` is now judged by two gates that ask different questions
 * about the same document shape:
 *
 *  - `doc-routing.test.ts` asks whether every blocker still carries its three
 *    parts (the command, the expected output, where the result goes);
 *  - `blocker-freshness.test.ts` asks whether every blocker says **when** it was
 *    last re-checked, and how long ago that was.
 *
 * Both need "what a `## 1. …` section is". Written twice, the two definitions
 * can drift — and the drift is invisible in the worst direction: a gate whose
 * section regex stops matching reads an empty list and reports nothing, so one
 * gate goes quiet while the other keeps printing green beside it. This repository
 * has removed that shape before (`findingLine()` shared between two commands,
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
