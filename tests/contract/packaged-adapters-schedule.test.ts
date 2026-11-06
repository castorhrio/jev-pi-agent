/**
 * The one manual step that had a date but no owner — and now has both.
 *
 * ## Why this file exists
 *
 * `README.md` (both languages) says the packaged-adapter check is manual: no CI
 * job packages the app, so a reader runs `npm run package` and then
 * `node scripts/verify-packaged-adapters.mjs` themselves. It also records the
 * one run that happened — Linux x64, 2026-11-02 — and says the Windows run is
 * still owed.
 *
 * That last sentence was the whole treatment. It is a *declaration* of a gap,
 * not a schedule: nothing said who would run it, by when, or where the result
 * goes. The other three external blockers had already been through that
 * correction (`b211b02`: 「等一个角色」 became 「等一个人 + 一个日子」), and this
 * one had not — so it read like a closed item with a footnote, which is the
 * shape this repository keeps having to remove.
 *
 * The fix is not a fourth `## N.` section. This step needs the *same* machine as
 * the Windows checklist, so it belongs inside that section, under the same
 * owner and the same deadline. What was missing was anything that noticed when
 * the schedule was dropped: a paragraph in `docs/blockers.md` and a sentence in
 * the README can both be deleted without a single gate going red, because every
 * other gate reads the section's *first* command and its *first* closing line.
 *
 * ## What is asserted
 *
 *  - `docs/blockers.md` §2 names the manual command, the packaging command that
 *    produces the build it launches, and the line that says it passed;
 *  - that line is the one the script actually prints for its default
 *    requirement — read out of `scripts/verify-packaged-adapters.mjs`, so a
 *    changed default is a red gate rather than a document that quotes a line
 *    nobody prints any more;
 *  - §2 carries an owner line with a name and a real deadline, which is what
 *    makes the asar step *scheduled* rather than *mentioned*;
 *  - the README's asar bullet, in both languages, points at that section and
 *    repeats the owner and the deadline — a reader who only reads the front
 *    door still learns who owes the run and when.
 *
 * ## What it deliberately cannot see
 *
 * Whether anybody runs it. A date and a name are a promise; the verdict lives in
 * the command's exit code, and `docs/blockers.md` says so in its own words. This
 * gate only refuses the shape where the promise is not written down at all.
 *
 * The checks are pure functions of three texts, so every red direction below is
 * driven on a mutated copy of the real documents.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// The same readers the other blockers gates use: a second definition of "what a
// `## N. …` section is", or of "who owns it and by when", would drift, and the
// drift would show up as this gate quietly reading nothing while the others
// stayed green.
import {
  blockerSections,
  isPlaceholderOwner,
  ownerLines,
  utcDays,
} from './blockers-doc.ts';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const BLOCKERS_PATH = join(REPO_ROOT, 'docs', 'blockers.md');
const README_PATH = join(REPO_ROOT, 'README.md');
const SCRIPT_PATH = join(REPO_ROOT, 'scripts', 'verify-packaged-adapters.mjs');

const read = (path: string): string => (existsSync(path) ? readFileSync(path, 'utf8') : '');

const BLOCKERS = read(BLOCKERS_PATH);
const README = read(README_PATH);
const SCRIPT = read(SCRIPT_PATH);

/** The section the asar step is scheduled in: the Windows checklist. */
const WINDOWS_SECTION = 2;

/** The command a reader types on Windows, in either separator. */
const MANUAL_COMMAND = /node\s+scripts[\\/]verify-packaged-adapters\.mjs/u;

/** The command that writes the build the manual check launches. */
const PACKAGING_COMMAND = 'npm run package';

/** The line the script prints when the default requirement is met. */
const EXPECTED_LINE = 'adapters resolved: universal';

/** The owner and the deadline the README repeats, as the runbook writes them. */
const OWNER = 'castorhrio';
const DEADLINE = '2026-11-19';

/** The three texts this gate compares. */
interface Documents {
  readonly blockers: string;
  readonly readme: string;
  readonly script: string;
}

/** The README's two halves, or `undefined` when the split is gone. */
function readmeHalves(markdown: string): { en: string; zh: string } | undefined {
  const en = markdown.indexOf('## English');
  const zh = markdown.indexOf('## 中文');
  if (en === -1 || zh === -1 || zh < en) return undefined;
  return { en: markdown.slice(en, zh), zh: markdown.slice(zh) };
}

/**
 * The bullet that talks about the asar check, as one block of text.
 *
 * A README bullet is a `- **…**` line plus its indented continuation lines, and
 * it ends at the first blank line. Reading the whole half instead would let the
 * 「外部阻塞」 section below supply the pointer and the deadline for a bullet that
 * had lost them — the same "one of two readers counted for both" defect the
 * blockers parity gate names.
 */
function asarBullet(half: string): string | undefined {
  const lines = half.split('\n');
  const start = lines.findIndex((line) => line.startsWith('- ') && line.includes('asar'));
  if (start === -1) return undefined;
  const block: string[] = [lines[start]!];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.trim().length === 0) break;
    if (!/^\s{2,}\S/u.test(line)) break;
    block.push(line);
  }
  return block.join('\n');
}

/**
 * `markdown` with the first `from` that appears after the `## 2. …` heading
 * replaced by `to`.
 *
 * The owner line is byte-identical in all three sections, so a plain
 * `replace()` would edit §1 and leave §2 — the section under test — untouched,
 * and the case would pass while measuring nothing.
 */
function replaceInWindowsSection(markdown: string, from: string, to: string): string {
  const heading = markdown.indexOf('## 2. ');
  if (heading === -1) return markdown;
  const at = markdown.indexOf(from, heading);
  if (at === -1) return markdown;
  return markdown.slice(0, at) + to + markdown.slice(at + from.length);
}

/** The `## 2. …` section, or `undefined` when the page lost it. */
function windowsSection(markdown: string): { heading: string; body: string } | undefined {
  return blockerSections(markdown).find((section) => /^2\./u.test(section.heading));
}

/**
 * Every way the packaged-adapter step has stopped being scheduled.
 *
 * Empty means the runbook names the command, the build it needs and the line it
 * prints; the section carries an owner and a deadline; and both README halves
 * point at that section with the same owner and deadline.
 */
function scheduleProblems(documents: Documents): string[] {
  const problems: string[] = [];

  const section = windowsSection(documents.blockers);
  if (section === undefined) {
    return [
      `docs/blockers.md: no \`## ${WINDOWS_SECTION}. …\` section, so the packaged-adapter ` +
        'check has nowhere to be scheduled — it is a paragraph in the README again',
    ];
  }
  const where = `docs/blockers.md: "${section.heading}"`;

  if (!MANUAL_COMMAND.test(section.body)) {
    problems.push(
      `${where}: does not name \`node scripts/verify-packaged-adapters.mjs\`, so the asar ` +
        'step is scheduled in a section that never says what to run',
    );
  }
  if (!section.body.includes(PACKAGING_COMMAND)) {
    problems.push(
      `${where}: names the packaged-adapter check without \`${PACKAGING_COMMAND}\`, which is ` +
        'what produces the build it launches',
    );
  }
  // An exact line, not a substring: `adapters resolved: universal, mock` is a
  // different result (two adapters, one of them not required), and a substring
  // check would let it stand in for the default requirement's line.
  const quoted = section.body.split('\n').some((line) => line.trim() === EXPECTED_LINE);
  if (!quoted) {
    problems.push(
      `${where}: does not quote \`${EXPECTED_LINE}\` as a line of its own, so "it passed" is ` +
        'described rather than measured — the reader has no line to look for',
    );
  }

  // The quoted line has to be one the script prints for its default
  // requirement. A document that quotes a line nobody prints is the defect this
  // whole file is about, one level down.
  if (!documents.script.includes('adapters resolved: ')) {
    problems.push(
      'scripts/verify-packaged-adapters.mjs: no longer prints an `adapters resolved:` line, ' +
        `so the \`${EXPECTED_LINE}\` the runbook quotes is a line nobody prints`,
    );
  }
  if (!documents.script.includes('default: universal')) {
    problems.push(
      'scripts/verify-packaged-adapters.mjs: no longer documents `default: universal`, so the ' +
        `runbook's \`${EXPECTED_LINE}\` is not the default requirement any more`,
    );
  }

  // Scheduled, not mentioned: the section's owner line is what turns a date into
  // a promise. `blocker-freshness` checks the same line for the section as a
  // whole; this case exists so the asar step cannot be moved to a section that
  // has none.
  const owners = ownerLines(section.body);
  if (owners.length === 0) {
    problems.push(
      `${where}: carries no \`**责任人**\` line, so the asar step is scheduled for nobody`,
    );
  } else {
    const [owner] = owners;
    if (owner === undefined || isPlaceholderOwner(owner.owner)) {
      problems.push(
        `${where}: the owner is "${owner?.owner ?? ''}", which is a role or a placeholder — ` +
          'the asar step needs a person, the same one the Windows checklist names',
      );
    }
    if (owner === undefined || utcDays(owner.deadline) === null) {
      problems.push(
        `${where}: the deadline is "${owner?.deadline ?? ''}", which is not a calendar day — ` +
          'a date nobody can miss is not a schedule',
      );
    }
  }

  const halves = readmeHalves(documents.readme);
  if (halves === undefined) {
    problems.push('README.md: no `## English` / `## 中文` split, so neither half can be read');
    return problems;
  }

  for (const [language, half] of Object.entries(halves)) {
    const bullet = asarBullet(half);
    if (bullet === undefined) {
      problems.push(
        `README.md (${language}): has no bullet about the asar check, so the front door no ` +
          'longer says the Windows run is owed',
      );
      continue;
    }
    if (!bullet.includes('docs/blockers.md')) {
      problems.push(
        `README.md (${language}): the asar bullet does not point at \`docs/blockers.md\`, so ` +
          'the schedule is only findable by someone who already knows where to look',
      );
    }
    if (!bullet.includes(OWNER)) {
      problems.push(
        `README.md (${language}): the asar bullet does not name the owner \`${OWNER}\`, so ` +
          'the Windows run is owed by nobody in particular',
      );
    }
    if (!bullet.includes(DEADLINE)) {
      problems.push(
        `README.md (${language}): the asar bullet does not carry the deadline \`${DEADLINE}\`, ` +
          'so "still owed" reads the same as "nobody is coming back to it"',
      );
    }
  }

  return problems;
}

describe('the packaged-adapter check is scheduled, not just declared', () => {
  it('finds the three documents, so the checks below are not vacuous', () => {
    expect(existsSync(BLOCKERS_PATH), `docs/blockers.md is missing (${BLOCKERS_PATH})`).toBe(true);
    expect(existsSync(README_PATH), `README.md is missing (${README_PATH})`).toBe(true);
    expect(existsSync(SCRIPT_PATH), `the manual check is missing (${SCRIPT_PATH})`).toBe(true);
    expect(windowsSection(BLOCKERS), 'docs/blockers.md has no `## 2. …` section').toBeDefined();
    const halves = readmeHalves(README);
    expect(halves, 'README.md no longer has both `## English` and `## 中文`').toBeDefined();
    for (const [language, half] of Object.entries(halves!)) {
      expect(asarBullet(half), `the ${language} half has no asar bullet`).toBeDefined();
    }
  });

  it('schedules the Windows run in the section that owns the Windows machine', () => {
    const problems = scheduleProblems({ blockers: BLOCKERS, readme: README, script: SCRIPT });
    expect(
      problems,
      `the packaged-adapter step is no longer scheduled:\n  ${problems.join('\n  ')}`,
    ).toEqual([]);
  });

  it('reports a runbook that stopped naming the command', () => {
    const broken = BLOCKERS.replaceAll(
      'node scripts\\verify-packaged-adapters.mjs',
      'the packaged check',
    );
    expect(broken, 'the command this case removes is gone').not.toBe(BLOCKERS);
    const problems = scheduleProblems({ blockers: broken, readme: README, script: SCRIPT });
    expect(problems.some((problem) => problem.includes('does not name'))).toBe(true);
    expect(problems.join('\n')).toContain('verify-packaged-adapters.mjs');
  });

  it('reports a runbook that quotes a line the script no longer prints', () => {
    const broken = replaceInWindowsSection(
      BLOCKERS,
      `  ${EXPECTED_LINE}`,
      '  adapters resolved: (none)',
    );
    expect(broken, 'the expected line this case rewrites is gone').not.toBe(BLOCKERS);
    const problems = scheduleProblems({ blockers: broken, readme: README, script: SCRIPT });
    expect(problems.some((problem) => problem.includes(EXPECTED_LINE))).toBe(true);
  });

  it('reports a section that lost its owner line', () => {
    const section = windowsSection(BLOCKERS)!;
    const ownerLine = ownerLines(section.body)[0]!.line;
    const broken = replaceInWindowsSection(BLOCKERS, ownerLine, '');
    expect(broken, 'the owner line this case removes is gone').not.toBe(BLOCKERS);
    const problems = scheduleProblems({ blockers: broken, readme: README, script: SCRIPT });
    expect(problems.some((problem) => problem.includes('scheduled for nobody'))).toBe(true);
  });

  it('reports a README half that dropped the schedule', () => {
    const halves = readmeHalves(README)!;
    const bullet = asarBullet(halves.en)!;
    const broken = README.replace(bullet, bullet.replaceAll(DEADLINE, 'soon'));
    expect(broken, 'the deadline this case rewrites is gone').not.toBe(README);
    const problems = scheduleProblems({ blockers: BLOCKERS, readme: broken, script: SCRIPT });
    expect(problems.some((problem) => problem.includes('README.md (en)'))).toBe(true);
    expect(problems.join('\n')).toContain(DEADLINE);
  });

  it('reports a README half that stopped pointing at the runbook', () => {
    const halves = readmeHalves(README)!;
    const bullet = asarBullet(halves.zh)!;
    const broken = README.replace(bullet, bullet.replaceAll('docs/blockers.md', 'the docs'));
    expect(broken, 'the pointer this case removes is gone').not.toBe(README);
    const problems = scheduleProblems({ blockers: BLOCKERS, readme: broken, script: SCRIPT });
    expect(problems.some((problem) => problem.includes('README.md (zh)'))).toBe(true);
    expect(problems.join('\n')).toContain('docs/blockers.md');
  });
});
