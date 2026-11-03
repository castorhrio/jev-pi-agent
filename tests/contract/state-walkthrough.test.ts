/**
 * The five interface states have criteria a person can answer, and a record
 * table that has to be signed before the README stops saying nobody looked.
 *
 * ## Why this file exists
 *
 * `docs/manual-verification.md` step 6 has carried the same sentence for several
 * rounds: the five states are asserted, measured and photographed, and nobody
 * has looked at them and said they read as a first run, a failure, a permission
 * prompt. The sentence was honest and it was also stuck, because "go and look"
 * is not something one person can hand to another — there was no list of
 * questions, no place to write the answers, and no consequence for either
 * answering or not.
 *
 * `docs/state-walkthrough.md` is that handover: three yes/no criteria per state,
 * and a record table where a dated row *is* the signature. This file keeps the
 * two halves of that promise from drifting apart:
 *
 *  - every walkable state has a section, and every section has criteria that
 *    name something a person can actually find on screen (a backticked literal
 *    from `i18n.ts`, or the screenshot the section points at);
 *  - every screenshot a section names exists, so the remote path — "send the
 *    images to someone who has not installed the app" — cannot rot into a 404;
 *  - and the README and the record table agree about whether anyone has looked.
 *    While the table has no dated row, both language halves of the README must
 *    still say the states have not been walked by eye; once a row is dated, the
 *    README must carry that date. Either half alone is the failure this
 *    repository keeps finding: a green gate over an unwalked screen, or a
 *    README apologising for a walkthrough that already happened.
 *
 * ## Why the criteria are checked for a literal, not for quality
 *
 * "Is the guidance prominent enough" cannot be judged by a machine, and a gate
 * that pretended to would be the worst kind of green. What *can* be checked is
 * that each criterion points at something specific: a criterion that names no
 * on-screen text is a criterion a walker can answer from memory, which is how
 * "looks fine" gets written into a record. The literal is the anchor, not the
 * judgement.
 *
 * ## What is deliberately not asserted
 *
 * How many criteria a state has beyond the floor of three, what they say, or
 * whether a signed row's conclusion is true. A record is a person's statement;
 * this file only makes sure the statement has somewhere to live and that the
 * README cannot quietly disagree with it.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { STATE_SCENARIOS } from '../../apps/desktop/src/renderer/src/dev/scenarios';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const WALKTHROUGH_PATH = join(REPO_ROOT, 'docs', 'state-walkthrough.md');
const README_PATH = join(REPO_ROOT, 'README.md');

/** The fewest criteria a state may carry and still be a walkthrough. */
const MIN_CRITERIA = 3;

/** A screenshot a section points at, e.g. `docs/screenshots/states/loading.png`. */
const SCREENSHOT = /docs\/screenshots\/[\w./-]+\.png/g;

/** A backticked literal: the on-screen text a criterion is anchored to. */
const LITERAL = /`[^`\n]+`/;

/** A dated record row, i.e. a signature. */
const SIGNED_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** What the checks compare the document against. */
interface Repository {
  readonly fileExists: (relativePath: string) => boolean;
}

/**
 * The `### <name>` sections of the document, by name.
 *
 * A level-1/2 heading ends the current section, so the record table and the
 * closing notes are not read as part of the last state.
 */
function sections(markdown: string): Map<string, string> {
  const out = new Map<string, string>();
  let name: string | null = null;
  let body: string[] = [];
  const flush = (): void => {
    if (name !== null) out.set(name, body.join('\n'));
  };
  for (const line of markdown.split('\n')) {
    const heading = line.match(/^### (\S+)\s*$/);
    if (heading) {
      flush();
      name = heading[1]!;
      body = [];
      continue;
    }
    if (/^#{1,3} /.test(line)) {
      flush();
      name = null;
      body = [];
      continue;
    }
    if (name !== null) body.push(line);
  }
  flush();
  return out;
}

/**
 * The `- [ ]` items of a section, with their wrapped continuation lines joined.
 *
 * The criteria are prose and markdown wraps them; reading only the first line
 * would report a criterion as unanchored when its literal is on the next line.
 */
function checklistItems(section: string): string[] {
  const items: string[] = [];
  let current: string | null = null;
  for (const line of section.split('\n')) {
    const start = line.match(/^\s*- \[ \] (.*)$/);
    if (start) {
      if (current !== null) items.push(current);
      current = start[1]!;
      continue;
    }
    if (current === null) continue;
    if (/^\s{2,}\S/.test(line) && !/^\s*- /.test(line)) {
      current = `${current} ${line.trim()}`;
      continue;
    }
    items.push(current);
    current = null;
  }
  if (current !== null) items.push(current);
  return items;
}

/** Every screenshot path a section names. */
function screenshotsIn(section: string): string[] {
  return [...section.matchAll(SCREENSHOT)].map((match) => match[0]);
}

/**
 * The dates of the record table's signed rows.
 *
 * A row is signed when its first cell is a date. The placeholder row the
 * document ships with has `—` there, which is the point: an unsigned table and
 * a signed one must not look the same to this gate.
 */
function signedDates(markdown: string): string[] {
  const dates: string[] = [];
  for (const line of markdown.split('\n')) {
    if (!line.trim().startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
    if (cells.length === 0) continue;
    if (SIGNED_DATE.test(cells[0]!)) dates.push(cells[0]!);
  }
  return dates;
}

/** Whether the record table has the columns a signer needs. */
function hasRecordColumns(markdown: string): boolean {
  return markdown
    .split('\n')
    .some(
      (line) =>
        line.trim().startsWith('|') &&
        line.includes('日期') &&
        line.includes('走查人') &&
        line.includes('结论'),
    );
}

/** The two language halves of the README, or `undefined` when the split is gone. */
function languageHalves(markdown: string): { en: string; zh: string } | undefined {
  const en = markdown.indexOf('## English');
  const zh = markdown.indexOf('## 中文');
  if (en === -1 || zh === -1 || zh < en) return undefined;
  return { en: markdown.slice(en, zh), zh: markdown.slice(zh) };
}

/**
 * Every way the walkthrough document, the repository and the README disagree.
 *
 * Empty means the handover is intact. Pure in `(walkthrough, readme, repository)`
 * so the interesting cases — a state with no section, a criterion anchored to
 * nothing, a signed table next to a README that still says nobody looked — can
 * be shown producing a failure instead of being argued about.
 */
function walkthroughProblems(
  walkthrough: string,
  readme: string,
  repository: Repository,
): string[] {
  const problems: string[] = [];
  const found = sections(walkthrough);

  for (const state of STATE_SCENARIOS) {
    const section = found.get(state);
    if (section === undefined) {
      problems.push(`docs/state-walkthrough.md: no \`### ${state}\` section, so nobody can walk it`);
      continue;
    }

    const items = checklistItems(section);
    if (items.length < MIN_CRITERIA) {
      problems.push(
        `docs/state-walkthrough.md: \`${state}\` has ${items.length} criteria, ` +
          `fewer than the ${MIN_CRITERIA} a walkthrough needs`,
      );
    }
    for (const item of items) {
      if (LITERAL.test(item)) continue;
      problems.push(
        `docs/state-walkthrough.md: a \`${state}\` criterion names nothing on screen ` +
          `(${JSON.stringify(item.slice(0, 48))}); anchor it to a literal a walker can find`,
      );
    }

    const shots = screenshotsIn(section);
    if (shots.length === 0) {
      problems.push(
        `docs/state-walkthrough.md: \`${state}\` names no screenshot, so the remote ` +
          'walkthrough has nothing to look at',
      );
    }
    for (const shot of new Set(shots)) {
      if (repository.fileExists(shot)) continue;
      problems.push(`docs/state-walkthrough.md: \`${state}\` shows \`${shot}\`, which is not in the repository`);
    }
  }

  if (!hasRecordColumns(walkthrough)) {
    problems.push(
      'docs/state-walkthrough.md: the record table has no 日期 / 走查人 / 结论 columns, ' +
        'so a walkthrough has nowhere to be signed',
    );
  }

  const halves = languageHalves(readme);
  if (halves === undefined) {
    problems.push('README.md: no `## English` / `## 中文` split, so the two halves cannot be compared');
    return problems;
  }

  const dates = signedDates(walkthrough);
  if (dates.length === 0) {
    // Nobody has looked. Both halves have to say so: a limitation stated in one
    // language and dropped in the other is the defect `readme-parity.test.ts`
    // exists for, one document out.
    if (!halves.en.includes('by eye')) {
      problems.push(
        'README.md: the walkthrough table has no dated row, but the English half no longer ' +
          'says the five states have not been walked through by eye',
      );
    }
    if (!halves.zh.includes('人眼')) {
      problems.push(
        'README.md: the walkthrough table has no dated row, but the Chinese half no longer ' +
          'says the five states have not been walked through by eye',
      );
    }
    return problems;
  }

  // Someone signed. The README has to carry the date, in both halves, or the
  // document keeps apologising for a walkthrough that already happened.
  const latest = [...dates].sort().at(-1)!;
  for (const [language, half] of Object.entries(halves)) {
    if (half.includes(latest)) continue;
    problems.push(
      `README.md: the walkthrough was signed on ${latest}, but the ${language} half ` +
        'does not carry that date',
    );
  }

  return problems;
}

const walkthrough = existsSync(WALKTHROUGH_PATH) ? readFileSync(WALKTHROUGH_PATH, 'utf8') : '';
const readme = existsSync(README_PATH) ? readFileSync(README_PATH, 'utf8') : '';
const REPOSITORY: Repository = {
  fileExists: (relativePath) => existsSync(join(REPO_ROOT, relativePath)),
};

describe('the five states have criteria a person can answer', () => {
  it('the walkthrough document is present, so the checks below have a subject', () => {
    // Unconditional: a missing document is a red run, not a skip. This
    // repository has removed `skipIf` guards twice for exactly this reason.
    expect(existsSync(WALKTHROUGH_PATH), `docs/state-walkthrough.md is missing`).toBe(true);
    expect(walkthrough.length, 'docs/state-walkthrough.md is empty').toBeGreaterThan(0);
  });

  it('every walkable state has a section, criteria and a screenshot', () => {
    const problems = walkthroughProblems(walkthrough, readme, REPOSITORY);
    expect(
      problems,
      `the walkthrough and the repository disagree:\n  ${problems.join('\n  ')}`,
    ).toEqual([]);
  });

  it('covers exactly the states the harness can install', () => {
    // The list is imported rather than restated: a sixth state added to
    // `scenarios.ts` must arrive here with criteria, and a state removed from
    // the harness must not leave a section nobody can reach.
    const found = sections(walkthrough);
    for (const state of STATE_SCENARIOS) {
      expect([...found.keys()], `no section for ${state}`).toContain(state);
    }
    expect(STATE_SCENARIOS.length, 'the walkable list is empty').toBeGreaterThan(0);
  });

  it('the record table is unsigned, and the README says so in both languages', () => {
    // The state of the repository today: criteria written, nobody has looked.
    // If this case fails because a row was signed, the fix is the README — see
    // the case below, which is the other half of the same rule.
    expect(signedDates(walkthrough), 'a walkthrough row is dated').toEqual([]);
    const halves = languageHalves(readme)!;
    expect(halves.en).toContain('by eye');
    expect(halves.zh).toContain('人眼');
  });

  it('reports a state with no section', () => {
    const problems = walkthroughProblems(
      '# 走查\n\n## 判据\n\n### empty\n\n- 图：`docs/screenshots/empty.png`\n',
      readme,
      { fileExists: () => true },
    );
    expect(problems).toContain(
      'docs/state-walkthrough.md: no `### loading` section, so nobody can walk it',
    );
  });

  it('reports a criterion that names nothing on screen', () => {
    const doc = [
      '### empty',
      '- 图：`docs/screenshots/empty.png`',
      '- [ ] 引导语够醒目。',
      '- [ ] 三步可数。',
      '- [ ] 没有加载中。',
      '',
    ].join('\n');
    const problems = walkthroughProblems(doc, readme, { fileExists: () => true });
    expect(problems.filter((problem) => problem.includes('names nothing on screen'))).toHaveLength(3);
  });

  it('reports a screenshot that is not in the repository', () => {
    const doc = [
      '### empty',
      '- 图：`docs/screenshots/gone.png`',
      '- [ ] 有 `还没有对话` 引导语。',
      '- [ ] 有 `发送之后会发生什么` 三步。',
      '- [ ] 没有 `加载中…`。',
      '',
    ].join('\n');
    const problems = walkthroughProblems(doc, readme, { fileExists: () => false });
    expect(problems).toContain(
      'docs/state-walkthrough.md: `empty` shows `docs/screenshots/gone.png`, which is not in the repository',
    );
  });

  it('reports a README that stopped admitting nobody has looked', () => {
    // The overclaim this file exists for: the table is empty, the README has
    // been reworded into "the states are covered".
    const problems = walkthroughProblems(walkthrough, readme.replace(/by eye/g, 'in the gate'), {
      fileExists: () => true,
    });
    expect(problems.some((problem) => problem.includes('English half'))).toBe(true);
  });

  it('reports a signed table the README does not carry', () => {
    // The other direction: someone walked it and signed, and the README still
    // apologises. Both halves are checked, because one of them is always the
    // one that gets forgotten.
    const signed = walkthrough.replace(
      '| — | — | — | — | — | **未走查**：判据已就位，等一个人按上面五节逐条回答 |',
      '| 2026-11-05 | 张三 | 五张 | 全满足 | 无 | 五条判据全满足 |',
    );
    const problems = walkthroughProblems(signed, readme, { fileExists: () => true });
    expect(problems.some((problem) => problem.includes('signed on 2026-11-05'))).toBe(true);
    expect(problems.filter((problem) => problem.includes('signed on 2026-11-05'))).toHaveLength(2);
  });

  it('accepts a signed table once the README carries the date', () => {
    // The green direction of the same rule, so the case above is not satisfied
    // by a check that always fails.
    const signed = walkthrough.replace(
      '| — | — | — | — | — | **未走查**：判据已就位，等一个人按上面五节逐条回答 |',
      '| 2026-11-05 | 张三 | 五张 | 全满足 | 无 | 五条判据全满足 |',
    );
    const dated = readme.replace(/by eye/g, 'by eye on 2026-11-05').replace(/人眼/g, '人眼（2026-11-05）');
    expect(walkthroughProblems(signed, dated, { fileExists: () => true })).toEqual([]);
  });
});
