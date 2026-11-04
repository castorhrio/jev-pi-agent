/**
 * The review has to be able to find the DoD, and the blockers have to be on one page.
 *
 * ## Why this file exists
 *
 * Two statements that were true in isolated documents but nowhere a reader would
 * meet them:
 *
 *  - `docs/PRODUCT-DOD.md` is the locked standard this product is scored
 *    against, and `docs/dod-status.md` walks it item by item. Nothing said, in
 *    either of those documents or in the README, that a review of a round
 *    **must load the DoD first**. A reviewer who starts from the status table
 *    alone can read a row as "not done yet" and never learn that a DoD item was
 *    missing from the table altogether — which is exactly how an unchecked item
 *    gets skipped for rounds in a row.
 *  - the three external blockers (a write-access token, a Windows machine, a
 *    person) each had a command and a place to put its result, spread over the
 *    README, the status table and the manual checklist. Someone picking one up
 *    had to assemble the instruction from three documents before knowing whether
 *    they could do it at all.
 *
 * `docs/blockers.md` is that single page; the README and the status table point
 * at it, and the status table now says out loud that the DoD is read first. This
 * file keeps those pointers from quietly rotting:
 *
 *  - both language halves of the README name the DoD and the blockers page, and
 *    say the DoD is loaded first;
 *  - `docs/dod-status.md` says the same thing **near the top**, because a
 *    sentence at the bottom of a long history is a sentence nobody reaches
 *    before judging;
 *  - `docs/blockers.md` has exactly three blocker sections, and each one carries
 *    all three of its parts (the command, the expected output, where the result
 *    goes) — a section that lost one is a page a reader follows halfway.
 *
 * The checks are pure functions of the documents, so the red direction is shown
 * with a mutated copy rather than argued about: a gate whose failure path has
 * never run is a gate that might be reporting `[]` whatever it is handed.
 *
 * Deliberately not asserted: wording, ordering of the blockers, or that the
 * commands actually work — the commands' flags are pinned by
 * `manual-check-docs.test.ts`, and `replay-feed-local.test.ts` runs the one
 * blocker that can be exercised on this machine.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const README_PATH = join(REPO_ROOT, 'README.md');
const STATUS_PATH = join(REPO_ROOT, 'docs', 'dod-status.md');
const BLOCKERS_PATH = join(REPO_ROOT, 'docs', 'blockers.md');

const read = (path: string): string => (existsSync(path) ? readFileSync(path, 'utf8') : '');

const README = read(README_PATH);
const STATUS = read(STATUS_PATH);
const BLOCKERS = read(BLOCKERS_PATH);

/** The two language halves of the README, split at their own headings. */
function languageHalves(markdown: string): { en: string; zh: string } | undefined {
  const en = markdown.indexOf('## English');
  const zh = markdown.indexOf('## 中文');
  if (en === -1 || zh === -1 || zh < en) return undefined;
  return { en: markdown.slice(en, zh), zh: markdown.slice(zh) };
}

/** What each half of the README has to say about where to start. */
const HALVES: readonly { readonly lang: 'en' | 'zh'; readonly keywords: readonly string[] }[] = [
  // English: the two pointers, plus the sentence that makes the DoD a step
  // rather than a suggestion.
  { lang: 'en', keywords: ['docs/PRODUCT-DOD.md', 'docs/blockers.md', 'must load it first'] },
  { lang: 'zh', keywords: ['docs/PRODUCT-DOD.md', 'docs/blockers.md', '必须先读'] },
];

/** How far into `docs/dod-status.md` the "read the DoD first" line must be. */
const STATUS_HEAD_LINES = 12;

/** The words that make the status document say the DoD is read first. */
const STATUS_KEYWORDS = ['docs/PRODUCT-DOD.md', '审查', '下一轮', '先读'];

/** The three parts every blocker section has to carry. */
const BLOCKER_PARTS = ['**解除命令**', '**期望输出**', '**结果放到哪个路径**'];

/** The number of external blockers this repository has, and says it has. */
const BLOCKER_COUNT = 3;

/**
 * Every way the pointers a reviewer depends on can be missing.
 *
 * Empty means both language halves send the reader to the DoD first and the
 * blockers page exists as a page; the status document says the same near its
 * top.
 */
function routingProblems(documents: {
  readme: string;
  status: string;
  blockers: string;
}): string[] {
  const problems: string[] = [];

  const halves = languageHalves(documents.readme);
  if (halves === undefined) {
    problems.push('README.md no longer has both `## English` and `## 中文`');
  } else {
    for (const half of HALVES) {
      for (const keyword of half.keywords) {
        if (!halves[half.lang].includes(keyword)) {
          problems.push(`README.md (${half.lang}): does not say "${keyword}" where a reader starts`);
        }
      }
    }
  }

  const head = documents.status.split('\n').slice(0, STATUS_HEAD_LINES).join('\n');
  for (const keyword of STATUS_KEYWORDS) {
    if (!head.includes(keyword)) {
      problems.push(
        `docs/dod-status.md: the first ${STATUS_HEAD_LINES} lines do not say "${keyword}", so a ` +
          'reviewer reads the table without loading the standard it is a table of',
      );
    }
  }

  if (documents.blockers.trim().length === 0) {
    problems.push('docs/blockers.md: is missing or empty, so the README points at nothing');
  } else {
    const sections = blockerSections(documents.blockers);
    if (sections.length !== BLOCKER_COUNT) {
      problems.push(
        `docs/blockers.md: has ${sections.length} blocker section(s) and this repository has ` +
          `${BLOCKER_COUNT} — a merged or dropped section is a blocker nobody is told to close`,
      );
    }
    for (const section of sections) {
      for (const part of BLOCKER_PARTS) {
        if (!section.body.includes(part)) {
          problems.push(
            `docs/blockers.md: "${section.heading}" does not carry ${part}, so a reader is sent ` +
              'there and has to go elsewhere for it',
          );
        }
      }
      // A blocker is closed by running something. Either shape counts: the
      // token and Windows rows are `node scripts/…` commands, and the
      // walkthrough is `npm run dev:web` plus five images — a page that only
      // described the work would be the thing this file exists to replace.
      if (!/(node\s+scripts[\\/][\w.-]+\.(?:mjs|cjs|js|ts))|(npm run [\w:.-]+)/u.test(section.body)) {
        problems.push(
          `docs/blockers.md: "${section.heading}" names no \`node scripts/…\` or \`npm run …\` command`,
        );
      }
    }
  }

  return problems;
}

/** The `## 1. …` sections of the blockers page, heading and body. */
function blockerSections(markdown: string): { heading: string; body: string }[] {
  const sections: { heading: string; body: string }[] = [];
  const lines = markdown.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const heading = lines[index]!;
    if (!/^## \d+\. /.test(heading)) continue;
    const body: string[] = [];
    for (let next = index + 1; next < lines.length; next += 1) {
      const line = lines[next]!;
      if (/^## /.test(line)) break;
      body.push(line);
    }
    sections.push({ heading: heading.slice(3), body: body.join('\n') });
  }
  return sections;
}

describe('a review can find the standard before it judges a round', () => {
  it('finds all three documents, so the checks below are not vacuous', () => {
    expect(existsSync(README_PATH), `README.md is missing (${README_PATH})`).toBe(true);
    expect(existsSync(STATUS_PATH), `docs/dod-status.md is missing (${STATUS_PATH})`).toBe(true);
    expect(existsSync(BLOCKERS_PATH), `docs/blockers.md is missing (${BLOCKERS_PATH})`).toBe(true);
    expect(existsSync(join(REPO_ROOT, 'docs', 'PRODUCT-DOD.md')), 'docs/PRODUCT-DOD.md is missing').toBe(
      true,
    );
    // The blockers page is a page, not a paragraph: without sections, the count
    // check below would pass on an empty list only by accident.
    expect(blockerSections(BLOCKERS).length, 'docs/blockers.md has no `## 1. …` sections').toBeGreaterThan(0);
  });

  it('says it in both README halves, in the status document, and on the blockers page', () => {
    const problems = routingProblems({ readme: README, status: STATUS, blockers: BLOCKERS });
    expect(problems, `the pointers a reviewer needs disagree:\n  ${problems.join('\n  ')}`).toEqual(
      [],
    );
  });

  it('reports a README half that stopped sending the reader to the DoD', () => {
    const broken = README.replaceAll('docs/PRODUCT-DOD.md', 'the standard');
    const problems = routingProblems({ readme: broken, status: STATUS, blockers: BLOCKERS });

    // Both halves, named: one language losing the pointer is the defect
    // `readme-parity.test.ts` exists for, one level up.
    expect(problems).toEqual([
      'README.md (en): does not say "docs/PRODUCT-DOD.md" where a reader starts',
      'README.md (zh): does not say "docs/PRODUCT-DOD.md" where a reader starts',
    ]);
  });

  it('reports a status document that buried the instruction below the fold', () => {
    // The same words, moved far enough down that a reviewer who reads the table
    // never meets them.
    const sentence = STATUS.split('\n')
      .find((line) => line.includes('审查与下一轮必须先读'))
      ?.trim();
    expect(sentence, 'docs/dod-status.md no longer has the "read the DoD first" line').toBeDefined();
    const buried = `${STATUS.replace(sentence!, '')}\n${'\n'.repeat(STATUS_HEAD_LINES)}${sentence}`;
    const problems = routingProblems({ readme: README, status: buried, blockers: BLOCKERS });

    expect(problems.some((problem) => problem.startsWith('docs/dod-status.md:'))).toBe(true);
    expect(problems.join('\n')).toContain('docs/PRODUCT-DOD.md');
  });

  it('reports a blocker section that lost one of its three parts', () => {
    // One section edited, the other two left alone: the failure names the
    // section, not the page.
    //
    // Edited *inside* the section, and every occurrence of the part replaced:
    // blocker 1 answers the same three questions for two readers (someone with
    // a write token, someone without), so it carries `**期望输出**` twice and
    // removing one of them leaves the section still carrying the part. A
    // mutation that cannot fail is the shape this file exists to prevent.
    const [first] = blockerSections(BLOCKERS) as [{ heading: string; body: string }];
    const brokenBody = first.body.replaceAll('**期望输出**', '**应该看到什么**');
    const broken = BLOCKERS.replace(first.body, brokenBody);
    expect(broken).not.toBe(BLOCKERS);
    const problems = routingProblems({ readme: README, status: STATUS, blockers: broken });

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('does not carry **期望输出**');
  });

  it('reports a blockers page that quietly lost a blocker', () => {
    const [first, second] = blockerSections(BLOCKERS) as [
      { heading: string; body: string },
      { heading: string; body: string },
    ];
    const merged = `# blockers\n\n## 1. ${first.heading}\n${first.body}\n## 2. ${second.heading}\n${second.body}\n`;
    const problems = routingProblems({ readme: README, status: STATUS, blockers: merged });

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('has 2 blocker section(s)');
  });
});
