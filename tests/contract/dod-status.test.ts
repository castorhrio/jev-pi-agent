/**
 * The DoD is read item by item, and the reading is a gate.
 *
 * ## Why this file exists
 *
 * `docs/dod-status.md` has had a status table since the first round, and that
 * table is organised by **round**: one row per thing a round did, with a
 * paragraph of history under it. That is the right shape for a changelog and
 * the wrong shape for the question a review asks — *which of the six DoD
 * sentences is not met, and where is the evidence?* An unchecked DoD item can
 * go missing from a round-shaped table for rounds in a row without anyone
 * noticing, because nothing compares the table to the standard.
 *
 * So the status document now carries a second table, one row per **sentence of
 * `docs/PRODUCT-DOD.md`** (split on `；`), numbered `DOD-<item>.<clause>`, with
 * exactly one of four states: 通过 / 未过 / 外部阻塞 / 不适用. This file is what
 * makes that table a gate rather than a paragraph:
 *
 *  - every DoD sentence has a row, and the row's 判据 is **verbatim** the DoD
 *    sentence — renaming or resplitting the standard without updating the table
 *    fails here instead of silently leaving an item unmentioned;
 *  - the state is one of the four words;
 *  - every backticked pointer in the evidence column **resolves**: a path that
 *    exists in this repository, or an `npm run …` script this repository
 *    declares. A dead pointer is the same defect as a missing one — it reads as
 *    evidence and proves nothing;
 *  - a row that is not 通过 has to say what is missing (a named next step), and
 *  - the four-state total in prose equals the rows, so a dropped or added row
 *    cannot leave a comfortable summary behind;
 *  - while `docs/blockers.md` still lists external blockers, the table may not
 *    be all 通过 — the two documents are not allowed to disagree.
 *
 * ## What it deliberately does not assert
 *
 * Which state a row *should* have. That is a judgement about evidence, and a
 * test that encoded it would have to be rewritten every round; the gate pins
 * that the judgement was made, is spelled in the vocabulary, and points at
 * something real. It also does not claim the round has passed the DoD: passing
 * is decided by review, and this repository does not announce it on its own.
 *
 * The checks are a pure function of the documents, so the red direction is
 * driven with mutated copies of the real text rather than argued about.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const DOD_PATH = join(REPO_ROOT, 'docs', 'PRODUCT-DOD.md');
const STATUS_PATH = join(REPO_ROOT, 'docs', 'dod-status.md');
const BLOCKERS_PATH = join(REPO_ROOT, 'docs', 'blockers.md');

const DOD = readFileSync(DOD_PATH, 'utf8');
const STATUS = readFileSync(STATUS_PATH, 'utf8');
const BLOCKERS = existsSync(BLOCKERS_PATH) ? readFileSync(BLOCKERS_PATH, 'utf8') : '';

/** The four states a row may carry, in the order the section introduces them. */
const STATES = ['通过', '未过', '外部阻塞', '不适用'] as const;
type State = (typeof STATES)[number];

/** The scripts this repository declares, for validating `npm run …` pointers. */
const SCRIPTS: Record<string, string> = JSON.parse(
  readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'),
).scripts as Record<string, string>;

/** One `- [ ]` of the standard, split into its `；`-separated sentences. */
interface DodItem {
  id: string;
  label: string;
  clause: string;
}

interface DodRow {
  id: string;
  clause: string;
  state: string;
  evidence: string;
  remaining: string;
}

/** The `## Definition of Done` bullets, with a stable id per sentence. */
function dodItems(markdown: string): DodItem[] {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => /^## Definition of Done/.test(line));
  if (start === -1) return [];
  const items: DodItem[] = [];
  let bullet = 0;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (/^## /.test(line)) break;
    const match = /^- \[[ x]\] \*\*(.+?)\*\*[：:]\s*(.+)$/.exec(line.trim());
    if (!match) continue;
    bullet += 1;
    const label = match[1]!.trim();
    const clauses = match[2]!
      .split('；')
      .map((clause) => clause.trim())
      .filter((clause) => clause.length > 0);
    clauses.forEach((clause, position) => {
      items.push({ id: `DOD-${bullet}.${position + 1}`, label, clause });
    });
  }
  return items;
}

/** The `## DoD 逐项核对` section of the status document, heading line included. */
function statusSection(markdown: string): string {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => /^## DoD 逐项核对/.test(line));
  if (start === -1) return '';
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^## /.test(lines[index]!)) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

/** The rows of that section's table. */
function dodRows(section: string): DodRow[] {
  const rows: DodRow[] = [];
  for (const line of section.split('\n')) {
    if (!/^\|/.test(line.trim())) continue;
    const cells = line
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((cell) => cell.trim());
    if (cells.every((cell) => /^:?-{3,}:?$/.test(cell))) continue;
    if (cells[0] === '条目') continue;
    if (cells.length !== 5) {
      rows.push({ id: cells[0] ?? '<empty>', clause: '', state: '', evidence: '', remaining: '' });
      continue;
    }
    rows.push({
      id: cells[0]!,
      clause: cells[1]!,
      state: cells[2]!,
      evidence: cells[3]!,
      remaining: cells[4]!,
    });
  }
  return rows;
}

/** A pointer is real when the path exists or the script is declared. */
function pointerProblem(token: string): string | undefined {
  const npmRun = /^npm run ([\w:.-]+)$/.exec(token);
  if (npmRun !== null) {
    return SCRIPTS[npmRun[1]!] === undefined
      ? `\`${token}\` is not a script this repository declares`
      : undefined;
  }
  const nodeScript = /^node (scripts\/[\w.-]+\.(?:mjs|cjs|js|ts))$/.exec(token);
  if (nodeScript !== null) {
    return existsSync(join(REPO_ROOT, nodeScript[1]!))
      ? undefined
      : `\`${token}\` names a script that is not in the tree`;
  }
  if (/\s/.test(token)) {
    return `\`${token}\` is neither a repository path nor a command this gate can check`;
  }
  return existsSync(join(REPO_ROOT, token))
    ? undefined
    : `\`${token}\` does not exist, so the row points at nothing`;
}

/**
 * Everything wrong with reading the DoD against the status document.
 *
 * Empty means every DoD sentence has a row with a verbatim 判据, one of the four
 * states, at least one resolving evidence pointer, a next step when it is not
 * 通过, and a total that matches the rows.
 */
function dodProblems(documents: { dod: string; status: string; blockers: string }): string[] {
  const problems: string[] = [];
  const expected = dodItems(documents.dod);
  if (expected.length === 0) {
    return ['docs/PRODUCT-DOD.md: no `- [ ] **…**：…` bullets under `## Definition of Done`'];
  }

  const section = statusSection(documents.status);
  if (section.length === 0) {
    return ['docs/dod-status.md: no `## DoD 逐项核对` section'];
  }
  const rows = dodRows(section);
  if (rows.length === 0) {
    return ['docs/dod-status.md: the `## DoD 逐项核对` section has no table rows'];
  }

  const byId = new Map<string, DodRow>();
  for (const row of rows) {
    if (byId.has(row.id)) problems.push(`docs/dod-status.md: ${row.id} has more than one row`);
    byId.set(row.id, row);
  }

  for (const item of expected) {
    const row = byId.get(item.id);
    if (row === undefined) {
      problems.push(
        `docs/dod-status.md: no row for ${item.id} (${item.label} / ${item.clause}), so that ` +
          'sentence of the DoD is not answered anywhere',
      );
      continue;
    }
    if (row.clause !== item.clause) {
      problems.push(
        `docs/dod-status.md: ${item.id} answers "${row.clause}" but the DoD says ` +
          `"${item.clause}" — the row is about a different sentence now`,
      );
    }
    if (!(STATES as readonly string[]).includes(row.state)) {
      problems.push(
        `docs/dod-status.md: ${item.id} has state "${row.state}"; the four states are ` +
          `${STATES.join(' / ')}`,
      );
    }
    const tokens = [...row.evidence.matchAll(/`([^`]+)`/g)].map((match) => match[1]!.trim());
    if (tokens.length === 0) {
      problems.push(
        `docs/dod-status.md: ${item.id} names no evidence — a state without a pointer is an opinion`,
      );
    }
    for (const token of tokens) {
      const problem = pointerProblem(token);
      if (problem !== undefined) problems.push(`docs/dod-status.md: ${item.id}: ${problem}`);
    }
    if (row.state !== '通过' && /^(—|-|)$/.test(row.remaining)) {
      problems.push(
        `docs/dod-status.md: ${item.id} is "${row.state}" but says nothing about what is missing`,
      );
    }
  }

  for (const id of byId.keys()) {
    if (!expected.some((item) => item.id === id)) {
      problems.push(`docs/dod-status.md: ${id} is not a DoD sentence this standard has`);
    }
  }

  const counts: Record<State, number> = { 通过: 0, 未过: 0, 外部阻塞: 0, 不适用: 0 };
  for (const row of rows) {
    if ((STATES as readonly string[]).includes(row.state)) counts[row.state as State] += 1;
  }
  const total = /四态合计：通过 (\d+) \/ 未过 (\d+) \/ 外部阻塞 (\d+) \/ 不适用 (\d+)/.exec(section);
  if (total === null) {
    problems.push('docs/dod-status.md: the section does not state 四态合计 in the four-state order');
  } else {
    const declared: Record<State, number> = {
      通过: Number(total[1]),
      未过: Number(total[2]),
      外部阻塞: Number(total[3]),
      不适用: Number(total[4]),
    };
    for (const state of STATES) {
      if (declared[state] !== counts[state]) {
        problems.push(
          `docs/dod-status.md: 四态合计 says ${state} ${declared[state]} but the table has ` +
            `${counts[state]} row(s)`,
        );
      }
    }
  }

  // The two documents are not allowed to disagree: a blockers page with open
  // sections and a table where everything passed is the shape of a status page
  // that stopped reading one of them.
  const blockerSections = (documents.blockers.match(/^## \d+\. /gm) ?? []).length;
  if (blockerSections > 0 && counts.未过 + counts.外部阻塞 === 0) {
    problems.push(
      `docs/blockers.md: lists ${blockerSections} blocker(s) but every DoD sentence is 通过`,
    );
  }

  return problems;
}

describe('every DoD sentence has a state and a pointer that resolves', () => {
  it('finds the standard, the section and the rows, so the checks are not vacuous', () => {
    expect(dodItems(DOD).length, 'the DoD bullets could not be read').toBeGreaterThanOrEqual(6);
    expect(statusSection(STATUS).length, 'the four-state section is missing').toBeGreaterThan(0);
    expect(dodRows(statusSection(STATUS)).length, 'the four-state table has no rows').toBeGreaterThan(0);
  });

  it('answers every sentence, in the DoD vocabulary, with real evidence', () => {
    const problems = dodProblems({ dod: DOD, status: STATUS, blockers: BLOCKERS });
    expect(problems, `the DoD is not answered item by item:\n  ${problems.join('\n  ')}`).toEqual([]);
  });

  it('numbers the sentences from the DoD itself, so a dropped row is a named miss', () => {
    const ids = dodItems(DOD).map((item) => item.id);
    expect(ids[0]).toBe('DOD-1.1');
    expect(ids).toContain('DOD-4.2');
    expect(new Set(ids).size, 'two DoD sentences were given the same id').toBe(ids.length);
  });

  it('reports a row that quietly disappeared', () => {
    const section = statusSection(STATUS);
    const row = section.split('\n').find((line) => line.startsWith('| DOD-2.2 '));
    expect(row, 'DOD-2.2 is not in the table any more').toBeDefined();
    const broken = STATUS.replace(`${row!}\n`, '');
    const problems = dodProblems({ dod: DOD, status: broken, blockers: BLOCKERS });
    expect(problems.join('\n')).toContain('no row for DOD-2.2');
  });

  it('reports a row whose 判据 drifted from the standard', () => {
    const broken = STATUS.replace(
      '| DOD-2.2 | 回落记为回落 |',
      '| DOD-2.2 | 回落有记录 |',
    );
    const problems = dodProblems({ dod: DOD, status: broken, blockers: BLOCKERS });
    expect(problems.join('\n')).toContain('DOD-2.2 answers "回落有记录"');
  });

  it('reports a state outside the four words', () => {
    const broken = STATUS.replace('| DOD-3.2 | 审计可查 | 通过 |', '| DOD-3.2 | 审计可查 | 差不多 |');
    const problems = dodProblems({ dod: DOD, status: broken, blockers: BLOCKERS });
    expect(problems.join('\n')).toContain('DOD-3.2 has state "差不多"');
  });

  it('reports evidence that points at nothing', () => {
    const broken = STATUS.replace(
      '`packages/context/src/renderer.ts` `tests/contract/injection-contract.test.ts`',
      '`packages/context/src/no-such-file.ts`',
    );
    const problems = dodProblems({ dod: DOD, status: broken, blockers: BLOCKERS });
    expect(problems.join('\n')).toContain('`packages/context/src/no-such-file.ts` does not exist');
  });

  it('reports an `npm run` pointer this repository cannot run', () => {
    const broken = STATUS.replace('`tests/contract/ci-typecheck.test.ts`', '`npm run ci`');
    const problems = dodProblems({ dod: DOD, status: broken, blockers: BLOCKERS });
    expect(problems.join('\n')).toContain('`npm run ci` is not a script this repository declares');
  });

  it('reports a sentence that is not 通过 but names no next step', () => {
    const line = STATUS.split('\n').find((row) => row.startsWith('| DOD-4.1 '));
    expect(line, 'DOD-4.1 is not in the table any more').toBeDefined();
    const cells = line!.trim().replace(/^\|/, '').replace(/\|$/, '').split('|');
    cells[4] = ' — ';
    const withoutStep = `| ${cells.map((cell) => cell.trim()).join(' | ')} |`;
    const broken = STATUS.replace(line!, withoutStep);
    const problems = dodProblems({ dod: DOD, status: broken, blockers: BLOCKERS });
    expect(problems.join('\n')).toContain('DOD-4.1 is "外部阻塞" but says nothing about what is missing');
  });

  it('reports a total that no longer matches the rows', () => {
    const broken = STATUS.replace('四态合计：通过 13 /', '四态合计：通过 12 /');
    const problems = dodProblems({ dod: DOD, status: broken, blockers: BLOCKERS });
    expect(problems.join('\n')).toContain('四态合计 says 通过 12');
  });

  it('reports a table that is all green while the blockers page still lists blockers', () => {
    // The real case, driven by rewriting every state to 通过: the counts are
    // rewritten too, so the only thing left to catch it is the cross-document
    // rule.
    const section = statusSection(STATUS);
    let allPass = section;
    for (const state of ['未过', '外部阻塞'] as const) {
      allPass = allPass.replaceAll(`| ${state} |`, '| 通过 |');
    }
    allPass = allPass.replace(/四态合计：[^\n]*/u, '四态合计：通过 16 / 未过 0 / 外部阻塞 0 / 不适用 0');
    const broken = STATUS.replace(section, allPass);
    const problems = dodProblems({ dod: DOD, status: broken, blockers: BLOCKERS });
    expect(problems.join('\n')).toContain('every DoD sentence is 通过');
  });
});
