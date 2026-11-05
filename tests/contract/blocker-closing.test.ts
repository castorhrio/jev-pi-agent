/**
 * A blocker's closing recipe is a checklist, and a checklist nobody checks is a wish.
 *
 * ## Why this file exists
 *
 * `docs/blockers.md` says, for each of the three external blockers, what to run
 * while the blocker is still there. That half is pinned: `blocker-freshness`
 * reads the date and the command, `doc-routing` reads the three parts, and
 * `release-gate-simulation` / `judge-samples` compare the pasted output with the
 * scripts that print it.
 *
 * The other half — **what to do the moment the blocker lifts** — was added later
 * and had nothing reading it. Each section now ends with a `### 解除时` block:
 * one command, the first line it prints, and a numbered list of the places in
 * this repository that start lying if they are not edited. That list is the part
 * that rots. It names files and `describe()` blocks by hand, and a renamed test
 * file, a deleted `describe`, or a count that says 四处 over five items all read
 * exactly like a correct list. The first draft of these sections proved it: one
 * of them told the reader to edit an assertion in `blocker-freshness.test.ts`
 * that has never existed, and nothing went red.
 *
 * So the recipe is read the way a reader reads it, and each claim is checked
 * against the tree:
 *
 *  - every blocker section has a `### 解除时` subsection at all;
 *  - it carries a command that this repository can run, and a first line that is
 *    not a placeholder — the two things a person needs at the moment of closing;
 *  - the number in `**解除后要改的 N 处**` equals the number of items below it,
 *    and the items are numbered 1..N — a list that lost an item still reads fine;
 *  - every repository path the items name exists — a renamed document is a
 *    reader sent to a file that is not there;
 *  - every `describe('…')` the section points at is really in the test file the
 *    sentence names before it — this is the claim that was wrong, and it is the
 *    one a reader cannot check without opening two files.
 *
 * ## The count, which is the one thing a closing recipe cannot check itself
 *
 * Closing a blocker is three edits in three files: delete the section here,
 * delete the block from `docs/demo-script.md`, delete the entry from
 * `DEGRADED_COMMANDS`. Each of those lists is read by a gate that **iterates**
 * it, so deleting an entry makes the loop shorter and every assertion stays
 * green — the recipe's own instruction ("`DEGRADED_COMMANDS` 同步删掉") was the
 * only thing holding the three together, and it was prose. The last block in
 * this file makes the three counts one fact: the number of `## N.` sections, the
 * number of `$ ` blocks on the demo page, and the length of the command list
 * have to be the same number, and a failure names which of the three is off.
 *
 * ## What it deliberately cannot see
 *
 * Whether the list is **complete**. It can prove that the four places a section
 * names exist; it cannot prove that a fifth place does not also need editing.
 * That is a judgement about the change being made, and the honest form of it is
 * the sentence each section already carries: the gates named there go red when
 * the document and the code stop agreeing, so a missing place shows up as a red
 * run rather than as a silent omission.
 *
 * The checks are pure functions of the document plus a file reader, so every red
 * direction is driven on a mutated copy instead of argued about.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// The same reader the other two blockers gates use: a second definition of "what
// a `## 1. …` section is" would drift, and the drift would show up as one gate
// quietly reading nothing while the others stayed green.
import { blockerSections } from './blockers-doc.ts';
// The demo page's three blocks and the command list they are checked against,
// from the module both gates read: a copy of the list in each file would let one
// gate be edited while the other kept counting the old length.
import { DEGRADED_COMMANDS, degradedBlocks, degradedSection } from './degraded-commands.ts';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const BLOCKERS_PATH = join(REPO_ROOT, 'docs', 'blockers.md');
const DEMO_PATH = join(REPO_ROOT, 'docs', 'demo-script.md');

const read = (path: string): string => (existsSync(path) ? readFileSync(path, 'utf8') : '');

const BLOCKERS = read(BLOCKERS_PATH);
const DEMO = read(DEMO_PATH);

/** The heading a closing recipe starts at. */
const CLOSING_HEADING = '### 解除时';

/** The three markers a closing recipe is built from, in the order they appear. */
const RUN_MARKER = '**跑这一条**';
const FIRST_LINE_MARKER = '**屏幕上第一行**';
const COUNT_MARKER = /^\*\*解除后要改的([一二三四五六七八九十]|\d+)处\*\*/u;

/** Chinese numerals as used in these headings, so `四处` can be compared with 4. */
const NUMERALS: Readonly<Record<string, number>> = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
};

/** One blocker's closing recipe, as the page writes it. */
interface Closing {
  /** The blocker section it belongs to, for failure messages. */
  readonly blocker: string;
  /** The subsection text, from `### 解除时` to the next heading. */
  readonly body: string;
}

/** The `### 解除时` subsection of a blocker section, or undefined when it has none. */
function closingOf(section: { heading: string; body: string }): Closing | undefined {
  const lines = section.body.split('\n');
  const start = lines.findIndex((line) => line.startsWith(CLOSING_HEADING));
  if (start === -1) return undefined;
  const body: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.startsWith('## ') || line.startsWith('### ')) break;
    body.push(line);
  }
  return { blocker: section.heading, body: body.join('\n') };
}

/** The first non-empty line of the first fenced block after `marker`. */
function blockAfter(body: string, marker: string): string | undefined {
  const at = body.indexOf(marker);
  if (at === -1) return undefined;
  const rest = body.slice(at + marker.length);
  const fence = rest.indexOf('```');
  if (fence === -1) return undefined;
  // The opening fence carries a language tag on the same line (` ```bash `), so
  // the block starts after that line rather than after the three backticks —
  // otherwise `bash` reads as the command and every recipe fails the same way.
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

/**
 * Whether a closing command is something this repository can actually run.
 *
 * Wider than `isRunnableCommand()` in `blockers-doc.ts`, which reads the
 * `**重跑这一条**` line: that line always names a script, while a closing recipe
 * may legitimately be a gate (`npx vitest run …`) or carry an environment
 * variable in front of the command (`GITHUB_TOKEN=… node scripts/…`). The
 * variable is stripped before the shape is judged, because `GITHUB_TOKEN=…` is
 * the part a reader substitutes, not the part they type.
 */
function isClosingCommand(command: string): boolean {
  const withoutEnv = command.replace(/^(?:[A-Z][A-Z0-9_]*=\S*\s+)+/u, '').trim();
  return /^(?:node\s+scripts[\\/][\w.-]+\.(?:mjs|cjs|js|ts)\b|npm run [\w:.-]+\b|npx vitest run \S+)/u.test(
    withoutEnv,
  );
}

/** The numbered items under `**解除后要改的 N 处**`, with the N the heading claims. */
function closingItems(body: string): { claimed: number; items: string[] } | undefined {
  const lines = body.split('\n');
  const at = lines.findIndex((line) => COUNT_MARKER.test(line));
  if (at === -1) return undefined;
  const claimed = NUMERALS[COUNT_MARKER.exec(lines[at]!)![1]!]!;
  const items: string[] = [];
  for (let index = at + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (/^\d+\. /u.test(line)) {
      items.push(line);
      continue;
    }
    // A continuation line belongs to the item above it; anything else ends the list.
    if (items.length > 0 && /^\s+\S/u.test(line)) {
      items[items.length - 1] += `\n${line}`;
      continue;
    }
    if (line.trim().length === 0) continue;
    break;
  }
  return { claimed, items };
}

/** A repository path a closing item names, as written in backticks. */
const REPO_PATH = /^(?:README\.md|docs\/[\w./-]+\.md|tests\/[\w./-]+\.ts|scripts\/[\w.-]+\.mjs|apps\/[\w./-]+\.ts)$/u;

/** Every repository path the items name, in order, without duplicates. */
function namedPaths(items: readonly string[]): string[] {
  const paths = new Set<string>();
  for (const item of items) {
    for (const match of item.matchAll(/`([^`]+)`/gu)) {
      const candidate = match[1]!.trim();
      if (REPO_PATH.test(candidate)) paths.add(candidate);
    }
  }
  return [...paths];
}

/** A `describe('…')` the section points at, and the test file named before it. */
interface DescribeClaim {
  readonly name: string;
  readonly file: string | undefined;
}

/**
 * The `describe()` names a closing recipe points at, each with the test file the
 * sentence names before it.
 *
 * The name is matched with `describe\('([^']*)'\)` rather than by splitting on
 * backticks, because one of these names contains backticks of its own
 * (``the `--judge` samples in the Windows pack``) and a backtick-delimited read
 * would cut it in half. The file is the nearest `tests/…test.ts` mentioned
 * before the name, which is how the sentences are written: path, then 的, then
 * the name.
 */
function describeClaims(body: string): DescribeClaim[] {
  const claims: DescribeClaim[] = [];
  for (const match of body.matchAll(/describe\('([^']*)'\)/gu)) {
    const before = body.slice(0, match.index);
    const file = [...before.matchAll(/tests\/[\w./-]+\.test\.ts/gu)].at(-1)?.[0];
    claims.push({ name: match[1]!, file });
  }
  return claims;
}

/**
 * Every way a closing recipe fails to be a checklist a reader can follow.
 *
 * Empty means each blocker has a recipe, the recipe has a runnable command and a
 * first line, its count matches its items, every path it names exists, and every
 * `describe()` it points at is in the file it names.
 */
function closingProblems(
  markdown: string,
  readFile: (relativePath: string) => string | null,
): string[] {
  const sections = blockerSections(markdown);
  if (sections.length === 0) {
    return ['docs/blockers.md: has no `## <n>. …` blocker sections, so there is no recipe to read'];
  }
  const problems: string[] = [];
  for (const section of sections) {
    const closing = closingOf(section);
    if (closing === undefined) {
      problems.push(
        `docs/blockers.md: "${section.heading}" has no \`${CLOSING_HEADING}\` subsection, so the ` +
          'moment the blocker lifts is a moment nobody wrote down',
      );
      continue;
    }
    const where = `docs/blockers.md: "${section.heading}"`;

    const command = blockAfter(closing.body, RUN_MARKER);
    if (command === undefined) {
      problems.push(`${where}: the closing recipe names no command under ${RUN_MARKER}`);
    } else if (!isClosingCommand(command)) {
      problems.push(
        `${where}: the closing command \`${command}\` is not something this repository can run — ` +
          'a recipe whose first step is prose is not a recipe',
      );
    }

    const firstLine = blockAfter(closing.body, FIRST_LINE_MARKER);
    if (firstLine === undefined || firstLine.length < 8) {
      problems.push(
        `${where}: the closing recipe gives no first line under ${FIRST_LINE_MARKER}, so a reader ` +
          'cannot tell a pass from a failure',
      );
    }

    const list = closingItems(closing.body);
    if (list === undefined) {
      problems.push(
        `${where}: the closing recipe has no \`**解除后要改的 N 处**\` list, so nothing says which ` +
          'documents start lying once the blocker is gone',
      );
      continue;
    }
    if (list.items.length !== list.claimed) {
      problems.push(
        `${where}: says ${list.claimed} place(s) to edit and lists ${list.items.length} — a list ` +
          'that lost an item still reads like a complete one',
      );
    }
    list.items.forEach((item, index) => {
      const numbered = /^(\d+)\. /u.exec(item)?.[1];
      if (numbered !== String(index + 1)) {
        problems.push(
          `${where}: item ${index + 1} is numbered ${numbered ?? 'not at all'} — a reader ` +
            'following the numbers skips or repeats a place',
        );
      }
    });

    for (const path of namedPaths(list.items)) {
      if (readFile(path) === null) {
        problems.push(
          `${where}: tells the reader to edit \`${path}\`, which is not in the tree — the recipe ` +
            'outlived the file it was written for',
        );
      }
    }

    for (const claim of describeClaims(closing.body)) {
      if (claim.file === undefined) {
        problems.push(
          `${where}: points at \`describe('${claim.name}')\` without naming the test file it is in, ` +
            'so the reader has to search for it',
        );
        continue;
      }
      const source = readFile(claim.file);
      if (source === null) {
        problems.push(`${where}: points at \`${claim.file}\`, which is not in the tree`);
        continue;
      }
      if (!source.includes(`describe('${claim.name}'`)) {
        problems.push(
          `${where}: says \`${claim.file}\` carries \`describe('${claim.name}')\`, and it does not — ` +
            'the reader is sent to an assertion that is not there',
        );
      }
    }
  }
  return problems;
}

/** The repository text at a path, or `null` when the file is not there. */
function readRepoFile(relativePath: string): string | null {
  const absolute = join(REPO_ROOT, relativePath);
  return existsSync(absolute) ? readFileSync(absolute, 'utf8') : null;
}

describe('every blocker says what to do the moment it lifts', () => {
  it('gives each blocker a recipe whose command, count, paths and assertions are real', () => {
    const problems = closingProblems(BLOCKERS, readRepoFile);
    expect(
      problems,
      `the closing recipes and the tree disagree:\n  ${problems.join('\n  ')}`,
    ).toEqual([]);
  });

  it('is not vacuous: three blockers, three recipes, three commands', () => {
    // Without this, a parser that stopped matching would leave the case above
    // green over an empty list — the shape of a gate that stopped looking.
    const sections = blockerSections(BLOCKERS);
    expect(sections.length).toBe(3);
    const closings = sections.map((section) => closingOf(section));
    for (const closing of closings) {
      expect(closing, 'a blocker section has no closing recipe').toBeDefined();
      const command = blockAfter(closing!.body, RUN_MARKER);
      expect(command, 'a closing recipe names no command').toBeDefined();
      expect(isClosingCommand(command!)).toBe(true);
    }
    // And the two shapes the reader is asked to substitute really are in the
    // page, so the env-prefix rule above is a decision about this document
    // rather than a branch that never fires.
    expect(BLOCKERS).toContain('GITHUB_TOKEN=… node scripts/publish-feed.mjs');
    expect(BLOCKERS).toContain('npx vitest run tests/contract/state-walkthrough.test.ts');
  });

  it('reports a blocker with no closing recipe', () => {
    const broken = BLOCKERS.replace(`${CLOSING_HEADING}：令牌到手之后`, '### 令牌到手之后');
    const problems = closingProblems(broken, readRepoFile);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('has no `### 解除时` subsection');
  });

  it('reports a count that does not match the items below it', () => {
    const broken = BLOCKERS.replace('**解除后要改的四处**：\n\n1. `docs/demo-script.md`', '**解除后要改的六处**：\n\n1. `docs/demo-script.md`');
    const problems = closingProblems(broken, readRepoFile);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('says 6 place(s) to edit and lists 4');
  });

  it('reports a place that is not in the tree', () => {
    const broken = BLOCKERS.replace(
      '`tests/contract/readme-parity.test.ts` 的 `LIMITATIONS` 表。\n\n**这一节的断言在哪**：`tests/contract/release-gate-simulation.test.ts`',
      '`tests/contract/readme-parity.test.ts` 的 `LIMITATIONS` 表，以及 `docs/feed-notes.md`。\n\n**这一节的断言在哪**：`tests/contract/release-gate-simulation.test.ts`',
    );
    const problems = closingProblems(broken, readRepoFile);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('`docs/feed-notes.md`, which is not in the tree');
  });

  it('reports a `describe()` the named file does not carry', () => {
    // The defect this gate was written for: a recipe sent the reader to an
    // assertion in a file that never had it, and every other gate stayed green.
    const broken = BLOCKERS.replace(
      "`describe('the blockers page shows the refusal instead of describing it')`",
      "`describe('the blockers page prints the refusal')`",
    );
    const problems = closingProblems(broken, readRepoFile);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("describe('the blockers page prints the refusal')");
    expect(problems[0]).toContain('tests/contract/release-gate-simulation.test.ts');
  });

  it('reports a closing command that is not runnable', () => {
    // The whole block, not just the command line: the same command appears in the
    // section's "while the blocker is still there" half, and replacing the first
    // occurrence would leave the closing recipe untouched — a red case that
    // passes for the wrong reason.
    const broken = BLOCKERS.replace(
      '**跑这一条**（需要 `castorhrio/jev-pi-agent` 的 `contents: write`）：\n\n```bash\n' +
        'GITHUB_TOKEN=… node scripts/publish-feed.mjs --apply --verify\n```',
      '**跑这一条**：\n\n```bash\n在 GitHub 网页上把 update-feed.json 换掉\n```',
    );
    const problems = closingProblems(broken, readRepoFile);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('is not something this repository can run');
  });
});

// ---------------------------------------------------------------------------
// The three counts that have to be one number
// ---------------------------------------------------------------------------

/**
 * Every way the three lists of blockers disagree about how many there are.
 *
 * Empty means `docs/blockers.md` has as many `## N.` sections as
 * `docs/demo-script.md` has `$ ` blocks in its degraded-path subsection, and as
 * many commands as `DEGRADED_COMMANDS` carries. Pure in its three inputs so the
 * red direction is driven on a mutated copy rather than argued about.
 */
function blockerCountProblems(
  blockers: string,
  demo: string,
  commands: readonly string[],
): string[] {
  const sections = blockerSections(blockers).length;
  const section = degradedSection(demo);
  if (section === undefined) {
    return [
      'docs/demo-script.md: has no `### 三条阻塞的现场降级路径` subsection, so the demo page ' +
        'and the blockers page cannot be counted against each other',
    ];
  }
  const blocks = degradedBlocks(section).length;
  const problems: string[] = [];
  if (sections !== blocks) {
    problems.push(
      `docs/blockers.md has ${sections} blocker section(s) and docs/demo-script.md shows ` +
        `${blocks} degraded-path block(s) — closing one blocker means deleting one of each, and ` +
        'one of the two pages was not edited',
    );
  }
  if (sections !== commands.length) {
    problems.push(
      `docs/blockers.md has ${sections} blocker section(s) and DEGRADED_COMMANDS carries ` +
        `${commands.length} command(s) — the list is iterated, so a deleted entry makes the loop ` +
        'shorter and every other assertion stays green',
    );
  }
  if (blocks !== commands.length) {
    problems.push(
      `docs/demo-script.md shows ${blocks} degraded-path block(s) and DEGRADED_COMMANDS carries ` +
        `${commands.length} command(s) — a block with no command in the list is a block nothing ` +
        'checks the output of',
    );
  }
  return problems;
}

describe('the three lists of blockers are the same length', () => {
  it('counts the same number of blockers on the page, on the demo page and in the list', () => {
    const problems = blockerCountProblems(BLOCKERS, DEMO, DEGRADED_COMMANDS);
    expect(
      problems,
      `the three lists disagree about how many blockers there are:\n  ${problems.join('\n  ')}`,
    ).toEqual([]);
  });

  it('is not vacuous: all three counts are the number this repository has', () => {
    // Without this, three parsers that all stopped matching would agree on zero
    // and the case above would be green over nothing at all.
    expect(blockerSections(BLOCKERS).length).toBe(3);
    expect(degradedBlocks(degradedSection(DEMO) ?? '').length).toBe(3);
    expect(DEGRADED_COMMANDS.length).toBe(3);
  });

  it('reports a blocker section deleted without the other two edits', () => {
    // The recipe's own instruction, made checkable: delete section 1 here and
    // leave the demo page and the list alone, and the failure names both.
    const [first] = blockerSections(BLOCKERS) as [{ heading: string; body: string }];
    // The whole section, heading and body: renaming the heading would leave the
    // count at three and this case would pass for the wrong reason.
    const withoutFirst = BLOCKERS.replace(`## ${first.heading}\n${first.body}`, '');
    expect(withoutFirst, 'the section this case renames is gone').not.toBe(BLOCKERS);
    const problems = blockerCountProblems(withoutFirst, DEMO, DEGRADED_COMMANDS);
    expect(problems.some((problem) => problem.includes('docs/blockers.md has 2'))).toBe(true);
    expect(problems.some((problem) => problem.includes('DEGRADED_COMMANDS carries 3'))).toBe(true);
  });

  it('reports a demo block deleted without the other two edits', () => {
    const withoutBlock = DEMO.replace(
      '$ node scripts/screenshot-sources.mjs --check\n',
      '',
    );
    expect(withoutBlock, 'the block this case removes is gone').not.toBe(DEMO);
    const problems = blockerCountProblems(BLOCKERS, withoutBlock, DEGRADED_COMMANDS);
    expect(problems.some((problem) => problem.includes('shows 2 degraded-path block(s)'))).toBe(
      true,
    );
  });

  it('reports a command deleted from the list without the other two edits', () => {
    // The direction that used to be invisible: the list is iterated, so a
    // shorter list made every assertion in `demo-script.test.ts` pass over one
    // fewer command.
    const problems = blockerCountProblems(BLOCKERS, DEMO, DEGRADED_COMMANDS.slice(0, 2));
    expect(problems.some((problem) => problem.includes('DEGRADED_COMMANDS carries 2'))).toBe(true);
  });

  it('reports a demo page that lost the subsection altogether', () => {
    const problems = blockerCountProblems(
      BLOCKERS,
      DEMO.replace('### 三条阻塞的现场降级路径', '### 别的标题'),
      DEGRADED_COMMANDS,
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('cannot be counted against each other');
  });
});
