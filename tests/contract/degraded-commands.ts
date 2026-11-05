/**
 * The three degraded-path commands, read by two gates that must agree on them.
 *
 * ## Why this is a module and not a constant in one test file
 *
 * `docs/demo-script.md` answers "did you run it on a real machine?" with three
 * commands that run offline and print one line each — one per external blocker.
 * Two gates read that section:
 *
 *  - `demo-script.test.ts` asks whether each command's quoted first line is
 *    still printed by the script the command runs;
 *  - `blocker-closing.test.ts` asks whether the number of blocks on the page,
 *    the number of `## N.` sections in `docs/blockers.md`, and the number of
 *    commands in this list are the same number.
 *
 * The second question is only meaningful if both gates count the same list. A
 * copy of `DEGRADED_COMMANDS` in each file would let one of them be edited
 * while the other kept counting the old length — and the count gate would then
 * be green about a list nobody reads. This repository has removed that shape
 * before (`blockers-doc.ts`, `ci-shape.ts`, `app-rules-build.ts`); a shared
 * reader is the same move.
 *
 * ## What the count gate is for
 *
 * Closing a blocker means deleting its block from the demo page, its section
 * from the blockers page, and its entry from this list. Three edits, in three
 * files, and until now only the first two were read by anything: the list was
 * iterated, so deleting an entry made the loop shorter and every assertion
 * stayed green. The count gate makes the three edits one fact.
 */

import { DEMO_BOUNDARIES } from '../../apps/desktop/src/shared/demo-boundaries';

/** The subsection of `docs/demo-script.md` that carries the three blocks. */
export const DEGRADED_SECTION_HEADING = '### 三条阻塞的现场降级路径';

/**
 * The three commands, spelled the way the page gives them.
 *
 * Order is the page's order, which is the blockers page's order: feed, Windows,
 * five states. Nothing reads the order; it is kept so a diff of this list reads
 * like a diff of the page.
 *
 * Derived from `apps/desktop/src/shared/demo-boundaries.ts` rather than
 * restated, because the same three commands are now also **on screen**: the
 * Help panel renders them so the person on stage can point at one instead of
 * reciting the page. A second copy here would let the panel and the count gate
 * disagree about how many blockers there are — the panel showing three while
 * this list counts two, and every assertion in both gates staying green.
 * `tests/contract/demo-boundaries.test.ts` compares the list against the page's
 * blocks; this file only has to keep counting the same list the panel shows.
 */
export const DEGRADED_COMMANDS: readonly string[] = DEMO_BOUNDARIES.map(
  (boundary) => boundary.command,
);

/** One `$ command` + first-output-line block of the section. */
export interface DegradedBlock {
  readonly command: string;
  readonly firstLine: string;
}

/**
 * The body of the degraded-path subsection, or `undefined` when it is gone.
 *
 * `undefined` rather than `''` on purpose: a section that was renamed would
 * otherwise make "the section has no blocks" true of the whole document, which
 * is the shape of a gate that stopped looking.
 */
export function degradedSection(markdown: string): string | undefined {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => line.trim() === DEGRADED_SECTION_HEADING);
  if (start === -1) return undefined;
  const body: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.startsWith('## ') || line.startsWith('### ')) break;
    body.push(line);
  }
  return body.join('\n');
}

/**
 * The `$ command` blocks of a section, in document order.
 *
 * A block counts only when its first line starts with `$ `: the section also
 * carries prose and a `**这三条的断言在哪**` paragraph, and a fenced block
 * without a prompt is an output somebody pasted, not a command a reader types.
 */
export function degradedBlocks(section: string): DegradedBlock[] {
  const blocks: DegradedBlock[] = [];
  let inside = false;
  let lines: string[] = [];
  for (const line of section.split('\n')) {
    if (line.trim().startsWith('```')) {
      if (inside) {
        const [first, second] = lines;
        if (first !== undefined && first.startsWith('$ ')) {
          blocks.push({ command: first.slice(2).trim(), firstLine: (second ?? '').trim() });
        }
        lines = [];
      }
      inside = !inside;
      continue;
    }
    if (inside) lines.push(line);
  }
  return blocks;
}
