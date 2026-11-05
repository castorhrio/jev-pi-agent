/**
 * The three external blockers, on the page and on the screen.
 *
 * ## Why this file exists
 *
 * `docs/demo-script.md` answers "did you run it on a real machine?" with three
 * commands that run offline and print one line each — one per external blocker.
 * That section is written for someone reading the page *before* the demo.
 *
 * On stage nobody reads the page. The app is open, the reviewer asks the
 * question, and the answer has to be on screen — so the same three blocks are
 * rendered in Help → 本次演示的边界. Two copies of one fact is exactly the shape
 * this repository keeps finding and removing: the page gets a reworded command,
 * the panel keeps showing the old one, and the person on stage points at a line
 * that will never appear. Every gate stays green, because each copy is
 * internally consistent.
 *
 * So the panel does not carry its own copy. `apps/desktop/src/shared/
 * demo-boundaries.ts` is the one list, the panel renders it, and this file
 * compares it against the page:
 *
 *  - every block on the page has an entry here, in the page's order, with the
 *    same command — a renamed command is a red run, not a stale panel;
 *  - the expected first line is compared **whole**, elisions included. The page
 *    quotes the line the script prints; a panel that shows a paraphrase is a
 *    panel that shows something nobody will see;
 *  - the sentence introducing each block is the page's bold heading, word for
 *    word, with the markdown markers stripped (the page bolds it and code-spans
 *    the field name; the panel renders plain text). The Chinese half of the
 *    dictionary is pinned to the page; the English half is a translation and is
 *    only required to exist, because the page is Chinese and the panel is
 *    bilingual;
 *  - and the panel really renders the list: it imports `DEMO_BOUNDARIES`, maps
 *    over it, and shows `command`, `expected` and the per-id dictionary key. A
 *    list nobody renders is a list that cannot go stale — and cannot help
 *    anyone either.
 *
 * ## What is deliberately not asserted
 *
 * Layout, wording of the English translation, or that the three commands still
 * *work* — `demo-script.test.ts` checks each quoted line against the script
 * that prints it, and `blocker-closing.test.ts` counts the three lists. This
 * file only keeps the page and the panel talking about the same three blocks.
 *
 * The checks are pure functions of `(page, boundaries, dictionary, panelSource)`
 * so every red direction is driven on a mutated copy instead of argued about.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { DEMO_BOUNDARIES, type DemoBoundary } from '../../apps/desktop/src/shared/demo-boundaries';
import { dictionaryFor } from '../../apps/desktop/src/shared/i18n';
import { DEGRADED_COMMANDS, DEGRADED_SECTION_HEADING, degradedBlocks, degradedSection } from './degraded-commands.ts';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const DEMO_PATH = join(REPO_ROOT, 'docs', 'demo-script.md');
const HELP_PATH = join(REPO_ROOT, 'apps', 'desktop', 'src', 'renderer', 'src', 'components', 'Help.tsx');

/** The dictionary the panel reads its sentences from. */
const ZH = dictionaryFor('zh-CN');
const EN = dictionaryFor('en-US');

/** The key a boundary's sentence lives under. */
const claimKey = (id: string): string => `help.boundary.${id}`;

/**
 * The page's bold heading for a block, with the markdown markers removed.
 *
 * The page writes `**一、feed 缺 \`sha256\`：让发布闸门自己说「不许发」。**`; the
 * panel renders plain text, so the bold markers and the code spans are dropped
 * before comparing. What has to be identical is the words, not the markup.
 */
function plainHeading(line: string): string {
  return line
    .trim()
    .replace(/^\*\*/, '')
    .replace(/\*\*$/, '')
    .replace(/`/g, '')
    .trim();
}

/** The bold headings of the degraded section, in document order. */
function headingsIn(section: string): string[] {
  return section
    .split('\n')
    .filter((line) => /^\*\*.+\*\*$/.test(line.trim()))
    .map(plainHeading);
}

/**
 * Every way the page, the shared list and the panel disagree.
 *
 * Empty means the three agree. `dictionary` is passed in rather than read here
 * so a case can hand the check a dictionary that lost one sentence and watch
 * the panel's claim go red — the same shape `state-walkthrough.test.ts` uses
 * for the criteria.
 */
function boundaryProblems(
  page: string,
  boundaries: readonly DemoBoundary[],
  dictionary: Record<string, string>,
  panelSource: string,
): string[] {
  const problems: string[] = [];
  const section = degradedSection(page);
  if (section === undefined) {
    return [
      `docs/demo-script.md: no \`${DEGRADED_SECTION_HEADING}\` section, so the panel has ` +
        'nothing to be the same as',
    ];
  }

  const blocks = degradedBlocks(section);
  const headings = headingsIn(section);

  if (boundaries.length === 0) {
    problems.push(
      'apps/desktop/src/shared/demo-boundaries.ts: carries no boundary, so the panel shows ' +
        'an empty card while the page still answers three questions',
    );
  }
  if (blocks.length !== boundaries.length) {
    problems.push(
      `docs/demo-script.md: shows ${blocks.length} degraded-path block(s) and ` +
        `demo-boundaries.ts carries ${boundaries.length} — the panel and the page have to ` +
        'answer the same number of questions',
    );
  }
  if (headings.length !== boundaries.length) {
    problems.push(
      `docs/demo-script.md: introduces ${headings.length} block(s) with a bold heading and ` +
        `demo-boundaries.ts carries ${boundaries.length} — every block needs the sentence the ` +
        'panel shows above its command',
    );
  }

  const ids = new Set<string>();
  boundaries.forEach((boundary, index) => {
    if (ids.has(boundary.id)) {
      problems.push(
        `apps/desktop/src/shared/demo-boundaries.ts: \`${boundary.id}\` appears twice, so two ` +
          'blocks share one dictionary key and one of them shows the other one’s sentence',
      );
    }
    ids.add(boundary.id);

    const block = blocks[index];
    if (block === undefined) {
      problems.push(
        `docs/demo-script.md: has no block at position ${index + 1}, where the panel shows ` +
          `\`${boundary.command}\``,
      );
    } else if (block.command !== boundary.command) {
      problems.push(
        `docs/demo-script.md: block ${index + 1} runs \`${block.command}\` and the panel shows ` +
          `\`${boundary.command}\` — the person on stage would type one command and point at ` +
          'another',
      );
    } else if (block.firstLine !== boundary.expected) {
      problems.push(
        `docs/demo-script.md: the expected first line of \`${boundary.command}\` is ` +
          `"${block.firstLine}" and the panel shows "${boundary.expected}" — the panel has to ` +
          'quote the line the script prints, not a paraphrase of it',
      );
    }

    const heading = headings[index];
    const claim = dictionary[claimKey(boundary.id)];
    if (claim === undefined) {
      problems.push(
        `apps/desktop/src/shared/i18n.ts: has no \`${claimKey(boundary.id)}\`, so the panel ` +
          'renders the raw key above that command',
      );
    } else if (heading !== undefined && claim !== heading) {
      problems.push(
        `docs/demo-script.md: introduces block ${index + 1} with "${heading}" and the panel ` +
          `says "${claim}" — the sentence above the command has to be the page's sentence`,
      );
    }
  });

  // The panel has to render the list, not merely import it. A card that shows
  // the title and the footnote but no commands is a card that answers nothing,
  // and every comparison above would still be green about a list nobody reads.
  for (const [what, marker] of [
    ['the shared list', 'DEMO_BOUNDARIES'],
    ['the command', 'boundary.command'],
    ['the expected line', 'boundary.expected'],
    ['the per-block sentence', 'help.boundary.${boundary.id}'],
  ] as const) {
    if (!panelSource.includes(marker)) {
      problems.push(
        `apps/desktop/src/renderer/src/components/Help.tsx: does not render ${what} ` +
          `(\`${marker}\`), so the three blocks are on the page and not on the screen`,
      );
    }
  }
  if (!/DEMO_BOUNDARIES\s*\.\s*map\s*\(/.test(panelSource)) {
    problems.push(
      'apps/desktop/src/renderer/src/components/Help.tsx: does not map over ' +
        '`DEMO_BOUNDARIES`, so the card cannot show one block per blocker',
    );
  }

  return problems;
}

const page = existsSync(DEMO_PATH) ? readFileSync(DEMO_PATH, 'utf8') : '';
const panel = existsSync(HELP_PATH) ? readFileSync(HELP_PATH, 'utf8') : '';

describe('the three blockers are on the page and on the screen', () => {
  it('the page and the panel agree about every block', () => {
    const problems = boundaryProblems(page, DEMO_BOUNDARIES, ZH, panel);
    expect(
      problems,
      `the demo page and the Help panel disagree:\n  ${problems.join('\n  ')}`,
    ).toEqual([]);
  });

  it('is not vacuous: three blocks, three commands, three sentences', () => {
    // A check that compares two empty lists is green and worthless. The counts
    // are stated here so a page that lost its section, or a list that lost an
    // entry, cannot pass by both being empty.
    expect(DEMO_BOUNDARIES).toHaveLength(3);
    expect(new Set(DEMO_BOUNDARIES.map((boundary) => boundary.id)).size).toBe(3);
    for (const boundary of DEMO_BOUNDARIES) {
      expect(boundary.command.length, `${boundary.id} has no command`).toBeGreaterThan(0);
      expect(boundary.expected.length, `${boundary.id} has no expected line`).toBeGreaterThan(0);
      expect(ZH[claimKey(boundary.id)], `${boundary.id} has no Chinese sentence`).toBeTruthy();
      expect(EN[claimKey(boundary.id)], `${boundary.id} has no English sentence`).toBeTruthy();
    }
  });

  it('the count gate and the panel count the same list', () => {
    // `degraded-commands.ts` derives its list from the shared module, so this is
    // the check that the derivation still holds: a copy in the test helper would
    // let the panel show three blockers while the count gate counted two.
    expect(DEGRADED_COMMANDS).toEqual(DEMO_BOUNDARIES.map((boundary) => boundary.command));
  });

  it('reports a page whose expected line was reworded', () => {
    // The failure this file is for: a `REFUSED` sentence is reworded, the page
    // keeps quoting the old one, and the panel — which reads the shared list —
    // shows a line the script no longer prints.
    const broken = page.replace(
      'a red report is a result, and the row stays open',
      'a red report is a claim, and the row stays open',
    );
    expect(broken, 'the quote this case rewrites is gone').not.toBe(page);
    const problems = boundaryProblems(broken, DEMO_BOUNDARIES, ZH, panel);
    expect(problems.some((problem) => problem.includes('the panel has to quote the line'))).toBe(
      true,
    );
  });

  it('reports a page whose command was renamed', () => {
    const broken = page.replace(
      '$ node scripts/screenshot-sources.mjs --check',
      '$ node scripts/screenshot-sources.mjs --verify',
    );
    expect(broken, 'the command this case renames is gone').not.toBe(page);
    const problems = boundaryProblems(broken, DEMO_BOUNDARIES, ZH, panel);
    expect(problems.some((problem) => problem.includes('would type one command'))).toBe(true);
  });

  it('reports a sentence that drifted from the page', () => {
    // The panel's sentence is the page's heading. Renaming one and not the
    // other is a one-word edit that leaves the person on stage reading a
    // sentence the page does not carry.
    const drifted = { ...ZH, 'help.boundary.windows': '二、Windows 未跑：报告是文档。' };
    const problems = boundaryProblems(page, DEMO_BOUNDARIES, drifted, panel);
    expect(problems.some((problem) => problem.includes("has to be the page's sentence"))).toBe(
      true,
    );
  });

  it('reports a dictionary that lost a sentence', () => {
    const missing = { ...ZH };
    delete missing['help.boundary.states'];
    const problems = boundaryProblems(page, DEMO_BOUNDARIES, missing, panel);
    expect(problems.some((problem) => problem.includes('renders the raw key'))).toBe(true);
  });

  it('reports a panel that stopped rendering the commands', () => {
    // The card can keep its title and its footnote and lose the list, and every
    // comparison above would still be green — about a list nobody reads.
    const stripped = panel.replace('{boundary.command}', '');
    expect(stripped, 'the panel no longer renders `boundary.command`').not.toBe(panel);
    const problems = boundaryProblems(page, DEMO_BOUNDARIES, ZH, stripped);
    expect(problems.some((problem) => problem.includes('does not render the command'))).toBe(true);
  });

  it('reports a shared list that lost a block', () => {
    const problems = boundaryProblems(page, DEMO_BOUNDARIES.slice(0, 2), ZH, panel);
    expect(problems.some((problem) => problem.includes('shows 3 degraded-path block(s)'))).toBe(
      true,
    );
  });
});
