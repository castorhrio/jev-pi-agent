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
 *    be all 通过 — the two documents are not allowed to disagree;
 *  - and the two documents are joined by a mapping table: every blocker section
 *    names the DoD row it lands on, every row that is 未过 or 外部阻塞 is named
 *    by some blocker section, and a blocker with **no** DoD sentence says so and
 *    says why. That last row is the point — a blocker nothing in the standard
 *    answers is exactly the item a table-shaped reading of the DoD loses.
 *
 * The same document carries a second table this file reads: 已知残留（不修，登记）,
 * one row per non-fix somebody argued for and decided against. It is compared
 * with the tree in **both** directions — a row must name a file that exists and
 * still carries the `KNOWN RESIDUAL` marker, and a marker-bearing file must have
 * a row. A register nobody checks against the code is how a decided non-fix
 * becomes next round's "newly found defect", and code with no row is a branch
 * whose argument only the person who left it there remembers.
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

import { existsSync, readdirSync, readFileSync } from 'node:fs';
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

/**
 * The residual register: a decided non-fix, checked in both directions.
 *
 * ## Why this half exists
 *
 * `43dcde2` removed four silent `if (!RULES_BUILT) return;` branches and left a
 * fifth one in `replay-feed-local.test.ts`, on purpose, with a reason. A reason
 * that lives in a commit message is not a record: the next review reads the
 * branch as a newly found defect and either removes it without the argument or
 * leaves it and never says again why. This repository has already decided what
 * to do about that shape — 「同法两轮不过应停并记入文档」 — and a document nobody
 * compares against the tree is the same defect one level up.
 *
 * So the register is a table, and the table is read both ways:
 *
 *  - a row has to name a file that exists, and that file has to carry the
 *    `KNOWN RESIDUAL` marker where the argument lives;
 *  - a file that carries the marker has to have a row.
 *
 * Either half alone is defeatable. Rows without code become a list of things
 * somebody once intended; code without rows becomes an undocumented branch that
 * the next round "discovers" and half-removes. Together they mean the only way
 * to lose the record is to delete both, in the same edit, on purpose.
 */

/** The heading the register lives under. */
const RESIDUAL_HEADING = '## 已知残留（不修，登记）';

/** The sentence the registered file has to carry, in the file itself. */
const RESIDUAL_MARKER = 'KNOWN RESIDUAL';

/** The columns every residual row declares, in order. */
const RESIDUAL_COLUMNS = ['残留', '为什么不修', '什么时候该修', '位置'];

/**
 * Where a residual may be registered, and where this scan therefore looks.
 *
 * The boundary is asserted rather than assumed: a row pointing outside these
 * roots is reported, because a residual filed at `apps/…` would otherwise pass
 * the reverse check while nothing read that directory.
 */
const RESIDUAL_SCAN_ROOTS = ['tests', 'scripts'];

/**
 * The one file the reverse scan skips: this gate, whose own source declares the
 * marker constant and would otherwise register itself.
 */
const RESIDUAL_GATE_FILE = 'tests/contract/dod-status.test.ts';

/** The section of the register, heading included; empty when it is gone. */
function residualSection(markdown: string): string {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => line.trim() === RESIDUAL_HEADING);
  if (start === -1) return '';
  const body: string[] = [lines[start]!];
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^## /.test(lines[index]!)) break;
    body.push(lines[index]!);
  }
  return body.join('\n');
}

/** The rows of that table, header and rule rows dropped. */
function residualRows(section: string): string[][] {
  const rows: string[][] = [];
  for (const line of section.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) continue;
    const cells = trimmed
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((cell) => cell.trim());
    if (cells.every((cell) => /^:?-{3,}:?$/.test(cell))) continue;
    if (cells[0] === RESIDUAL_COLUMNS[0]) continue;
    rows.push(cells);
  }
  return rows;
}

/** What the register is compared against: the tree, as two questions. */
interface ResidualTree {
  /** The repository text at this path, or null when the file is not there. */
  read: (relativePath: string) => string | null;
  /** Files under {@link RESIDUAL_SCAN_ROOTS} that carry the marker. */
  markerBearing: () => string[];
}

/** A file walk over the scan roots, keeping source files that carry the marker. */
function markerBearingFiles(): string[] {
  const found: string[] = [];
  const walk = (relative: string): void => {
    for (const entry of readdirSync(join(REPO_ROOT, relative), { withFileTypes: true })) {
      const child = relative.length === 0 ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(child);
        continue;
      }
      if (!/\.(?:ts|tsx|mjs|cjs|js)$/u.test(entry.name)) continue;
      const text = readFileSync(join(REPO_ROOT, child), 'utf8');
      if (text.includes(RESIDUAL_MARKER)) found.push(child);
    }
  };
  for (const root of RESIDUAL_SCAN_ROOTS) walk(root);
  return found.sort();
}

const RESIDUAL_TREE: ResidualTree = {
  read: (relativePath) => {
    const absolute = join(REPO_ROOT, relativePath);
    return existsSync(absolute) ? readFileSync(absolute, 'utf8') : null;
  },
  markerBearing: markerBearingFiles,
};

/** Every line of the section that {@link residualRows} reads as a data row. */
function residualDataLines(section: string): string[] {
  return section
    .split('\n')
    .filter((line) => line.trim().startsWith('|'))
    .filter((line) => residualRows(line).length > 0);
}

/** The same line with one column rewritten. */
function residualRowWith(line: string, column: number, cell: string): string {
  const cells = residualRows(line)[0]!;
  cells[column] = cell;
  return `| ${cells.join(' | ')} |`;
}

/** Every backticked path in a row's 位置 cell. */
function residualPointers(cell: string): string[] {
  return [...cell.matchAll(/`([^`]+)`/gu)].map((match) => match[1]!.trim());
}

/**
 * Every way the residual register can have stopped describing the tree.
 *
 * Empty means the section exists, has at least one row, and each row's four
 * cells say something while its named files both exist and carry the marker —
 * and no marker-bearing file under the scan roots is missing a row.
 */
function residualProblems(status: string, tree: ResidualTree): string[] {
  const section = residualSection(status);
  if (section.length === 0) {
    return [
      'docs/dod-status.md: no `## 已知残留（不修，登记）` section, so a non-fix that was argued ' +
        'for has nowhere to be written and gets rediscovered as a defect next round',
    ];
  }
  const rows = residualRows(section);
  if (rows.length === 0) {
    return ['docs/dod-status.md: the residual register has no rows, so nothing is registered'];
  }

  const problems: string[] = [];
  const registered = new Set<string>();

  for (const row of rows) {
    const label = row[0] ?? '<empty row>';
    if (row.length !== RESIDUAL_COLUMNS.length) {
      problems.push(
        `docs/dod-status.md: the residual "${label}" has ${row.length} cell(s), not the ` +
          `${RESIDUAL_COLUMNS.length} the register declares (${RESIDUAL_COLUMNS.join(' / ')})`,
      );
      continue;
    }
    const [, why, when, where] = row as [string, string, string, string];
    for (const [column, cell] of [
      ['为什么不修', why],
      ['什么时候该修', when],
    ] as const) {
      if (/^(—|-|)$/u.test(cell.trim())) {
        problems.push(
          `docs/dod-status.md: the residual "${label}" leaves ${column} empty — a residue ` +
            'without a reason is a TODO, and a TODO is what this section is not',
        );
      }
    }

    const pointers = residualPointers(where);
    if (pointers.length === 0) {
      problems.push(
        `docs/dod-status.md: the residual "${label}" names no file, so nothing can be checked ` +
          'against it and the row is a sentence about a defect rather than a pointer to one',
      );
    }
    for (const pointer of pointers) {
      registered.add(pointer);
      if (!RESIDUAL_SCAN_ROOTS.some((root) => pointer.startsWith(`${root}/`))) {
        problems.push(
          `docs/dod-status.md: the residual "${label}" points at \`${pointer}\`, outside the ` +
            `roots this scan reads (${RESIDUAL_SCAN_ROOTS.join(' / ')}), so the reverse check cannot see it`,
        );
        continue;
      }
      const text = tree.read(pointer);
      if (text === null) {
        problems.push(
          `docs/dod-status.md: the residual "${label}" points at \`${pointer}\`, which is not in ` +
            'the tree — the row describes a file that is not there',
        );
        continue;
      }
      if (!text.includes(RESIDUAL_MARKER)) {
        problems.push(
          `docs/dod-status.md: the residual "${label}" registers \`${pointer}\`, but that file ` +
          `does not carry "${RESIDUAL_MARKER}", so the argument lives only in this table`,
        );
      }
    }
  }

  for (const file of tree.markerBearing()) {
    if (file === RESIDUAL_GATE_FILE) continue;
    if (registered.has(file)) continue;
    problems.push(
      `docs/dod-status.md: \`${file}\` carries "${RESIDUAL_MARKER}" but the register has no row ` +
        'for it — an undocumented residue is what the next round rediscovers and half-removes',
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
    // The number is read out of the document and decremented rather than written
    // here: a hard-coded count turns into a passing no-op the first round the
    // real total changes, and a gate that silently stops asserting is the
    // failure this whole file is about. `1` is the floor — a total of zero
    // 通过 would make the replacement ambiguous.
    const declared = /四态合计：通过 (\d+) \//u.exec(statusSection(STATUS));
    expect(declared, 'the section states no 四态合计').not.toBeNull();
    const pass = Number(declared![1]);
    expect(pass).toBeGreaterThan(1);
    const broken = STATUS.replace(`四态合计：通过 ${pass} /`, `四态合计：通过 ${pass - 1} /`);
    const problems = dodProblems({ dod: DOD, status: broken, blockers: BLOCKERS });
    expect(problems.join('\n')).toContain(`四态合计 says 通过 ${pass - 1}`);
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

/** The one residual this round registers, as the file the marker must be in. */
const RESIDUAL_FILE = 'tests/contract/replay-feed-local.test.ts';

describe('a decided non-fix stays registered', () => {
  it('reads the register against the tree, both ways, and finds nothing missing', () => {
    expect(residualProblems(STATUS, RESIDUAL_TREE)).toEqual([]);
  });

  it('finds a section, a row, and the marker in the file it registers', () => {
    // Without these the green above could mean the register is empty and no
    // file carries the marker — two sets with nothing in them agree perfectly.
    const section = residualSection(STATUS);
    expect(section.length, 'the residual section is gone').toBeGreaterThan(0);
    expect(residualRows(section).length, 'the residual register has no rows').toBeGreaterThan(0);
    expect(RESIDUAL_TREE.read(RESIDUAL_FILE)).toContain(RESIDUAL_MARKER);
    expect(RESIDUAL_TREE.markerBearing()).toEqual(
      expect.arrayContaining([RESIDUAL_FILE, RESIDUAL_GATE_FILE]),
    );
  });

  it('reports a register whose section was deleted', () => {
    const broken = STATUS.replace(residualSection(STATUS), '');
    expect(broken).not.toBe(STATUS);
    expect(residualProblems(broken, RESIDUAL_TREE)).toEqual([
      expect.stringContaining('no `## 已知残留（不修，登记）` section'),
    ]);
  });

  it('reports a register whose only row was deleted', () => {
    const line = residualDataLines(residualSection(STATUS))[0]!;
    const broken = STATUS.replace(`${line}\n`, '');
    expect(broken).not.toBe(STATUS);
    expect(residualProblems(broken, RESIDUAL_TREE)).toEqual([
      expect.stringContaining('the residual register has no rows'),
    ]);
  });

  it('reports a row whose reason became a shrug', () => {
    // The row is still there and still names a real file; only the argument
    // disappeared. A register of things nobody justified is a TODO list wearing
    // the shape of a decision.
    const line = residualDataLines(residualSection(STATUS))[0]!;
    const broken = STATUS.replace(line, residualRowWith(line, 1, '—'));
    expect(broken).not.toBe(STATUS);
    expect(residualProblems(broken, RESIDUAL_TREE)).toEqual([
      expect.stringContaining('leaves 为什么不修 empty — a residue without a reason is a TODO'),
    ]);
  });

  it('reports a row that points at a file the tree does not have', () => {
    const broken = STATUS.replaceAll(RESIDUAL_FILE, 'tests/contract/no-such-residual.test.ts');
    const problems = residualProblems(broken, RESIDUAL_TREE).join('\n');
    expect(problems).toContain('which is not in the tree');
  });

  it('reports a registered file whose marker was stripped out of the code', () => {
    // The row survives and reads perfectly; only the argument in the source is
    // gone. That is the half the table alone cannot see.
    const stripped: ResidualTree = {
      read: (relativePath) =>
        (RESIDUAL_TREE.read(relativePath) ?? '').replaceAll(RESIDUAL_MARKER, 'heading'),
      markerBearing: () => [],
    };
    expect(stripped.read(RESIDUAL_FILE)).not.toContain(RESIDUAL_MARKER);
    expect(residualProblems(STATUS, stripped)).toEqual([
      expect.stringContaining(`registers \`${RESIDUAL_FILE}\`, but that file does not carry`),
    ]);
  });

  it('reports a marker in the code that the table never registered', () => {
    // The other direction: somebody wrote the argument into a source file and
    // did not file it. Undocumented residue is what the next round "discovers".
    const stray: ResidualTree = {
      read: (relativePath) => RESIDUAL_TREE.read(relativePath),
      markerBearing: () => [...RESIDUAL_TREE.markerBearing(), 'tests/contract/unregistered.ts'],
    };
    expect(residualProblems(STATUS, stray)).toEqual([
      expect.stringContaining(
        '`tests/contract/unregistered.ts` carries "KNOWN RESIDUAL" but the register has no row',
      ),
    ]);
  });

  it('skips exactly one file in the reverse scan, and says which', () => {
    // The gate's own source declares the marker constant, so it would register
    // itself. That exemption is one file named here, and this case is what keeps
    // it one file: a second marker-bearing file that is not in the table is red
    // above, and a scan root that stops being read is named there too.
    const exempted = RESIDUAL_TREE.markerBearing().filter((file) => file !== RESIDUAL_GATE_FILE);
    const row = residualRows(residualSection(STATUS))[0]!;
    expect(residualPointers(row[3]!)).toEqual(expect.arrayContaining(exempted));
  });

  it('names a row that points outside the roots the reverse scan reads', () => {
    // The boundary of `RESIDUAL_SCAN_ROOTS`, stated as a case rather than as a
    // comment: a residual filed at `apps/…` would pass the reverse check only
    // because nothing walked that directory.
    const broken = STATUS.replace(`\`${RESIDUAL_FILE}\` |`, '`apps/desktop/src/main/tray-icon.ts` |');
    expect(broken).not.toBe(STATUS);
    // More than one problem is expected here: moving the pointer also leaves the
    // file that really carries the marker unregistered. The complaint this case
    // is about is the one that names the unscanned root.
    expect(residualProblems(broken, RESIDUAL_TREE).join('\n')).toContain(
      'outside the roots this scan reads',
    );
  });
});

// ---------------------------------------------------------------------------
// The blockers page and the four-state table, joined
// ---------------------------------------------------------------------------

/**
 * ## Why this block exists
 *
 * The four-state table answers "which DoD sentence is not met", and
 * `docs/blockers.md` answers "what do I type to close it". Nothing joined them:
 * a reader who wanted to know which row a blocker lands on had to read both
 * documents and match them by subject, and a blocker with **no** DoD sentence
 * behind it was invisible from the table — the table said 未过 1 / 外部阻塞 1
 * while the blockers page carried three sections, and both documents were
 * internally consistent.
 *
 * So the status document carries a mapping table, and this block reads it in
 * both directions:
 *
 *  - every `## N.` section of the blockers page has exactly one row, and the
 *    label after `第 N 节 ·` is the beginning of that section's heading — a
 *    renumbered or retitled section is a red run, not a reader sent to the
 *    wrong place;
 *  - every row that is 未过 or 外部阻塞 is named by some row of the mapping —
 *    a blocked DoD sentence with no closing recipe is a row nobody can act on;
 *  - a target that is a `DOD-x.y` id has to be a row of the four-state table;
 *  - and a target of `无对应 DoD 句子` has to say why, because that is the one
 *    case the table cannot express and the one a reader will otherwise assume
 *    away.
 *
 * The checks are a pure function of the two documents, so the red direction is
 * driven on mutated copies rather than argued about.
 */

/** The heading of the mapping section. */
const MAPPING_HEADING = '## 三条外部阻塞落在哪一行';

/** The target a blocker uses when the DoD has no sentence for it. */
const NO_DOD_ROW = '无对应 DoD 句子';

/** One row of the mapping table. */
interface MappingRow {
  /** The blocker section number, as written after `第 `. */
  readonly section: number;
  /** The label after `第 N 节 ·`, which has to start the section's heading. */
  readonly label: string;
  /** A `DOD-x.y` id, or {@link NO_DOD_ROW}. */
  readonly target: string;
  /** Why, for the rows the table cannot express as an id. */
  readonly reason: string;
}

/** The mapping section, heading included; empty when it is gone. */
function mappingSection(markdown: string): string {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => line.trim() === MAPPING_HEADING);
  if (start === -1) return '';
  const body: string[] = [lines[start]!];
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^## /.test(lines[index]!)) break;
    body.push(lines[index]!);
  }
  return body.join('\n');
}

/** The rows of the mapping table, header and rule rows dropped. */
function mappingRows(section: string): MappingRow[] {
  const rows: MappingRow[] = [];
  for (const line of section.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) continue;
    const cells = trimmed
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((cell) => cell.trim());
    if (cells.every((cell) => /^:?-{3,}:?$/.test(cell))) continue;
    if (cells[0] === '阻塞（`docs/blockers.md`）') continue;
    const head = /^第\s*(\d+)\s*节\s*·\s*(.+)$/u.exec(cells[0] ?? '');
    if (head === null) {
      rows.push({ section: Number.NaN, label: cells[0] ?? '<empty>', target: '', reason: '' });
      continue;
    }
    rows.push({
      section: Number(head[1]),
      label: head[2]!.trim(),
      target: cells[1] ?? '',
      reason: cells[2] ?? '',
    });
  }
  return rows;
}

/**
 * Every way the mapping table and the two documents disagree.
 *
 * Empty means each blocker section is mapped once, to a row that exists or to a
 * justified "no DoD sentence", and every blocked DoD row is mapped from.
 */
function mappingProblems(documents: { status: string; blockers: string }): string[] {
  const section = mappingSection(documents.status);
  if (section.length === 0) {
    return [
      `docs/dod-status.md: no \`${MAPPING_HEADING}\` section, so nothing joins the four-state ` +
        'table to the blockers page and a blocker with no DoD sentence is invisible from the table',
    ];
  }
  const rows = mappingRows(section);
  if (rows.length === 0) {
    return [`docs/dod-status.md: the \`${MAPPING_HEADING}\` section has no rows`];
  }

  const problems: string[] = [];
  const blockerHeadings = [...documents.blockers.matchAll(/^## (\d+)\. (.+)$/gm)].map((match) => ({
    number: Number(match[1]),
    heading: match[2]!.trim(),
  }));
  const dodTable = dodRows(statusSection(documents.status));
  const dodIds = new Set(dodTable.map((row) => row.id));

  for (const blocker of blockerHeadings) {
    const mapped = rows.filter((row) => row.section === blocker.number);
    if (mapped.length === 0) {
      problems.push(
        `docs/dod-status.md: \`docs/blockers.md\` 第 ${blocker.number} 节 (${blocker.heading}) ` +
          'has no row in the mapping table, so a reader of the four-state table never learns ' +
          'which DoD sentence it blocks',
      );
      continue;
    }
    if (mapped.length > 1) {
      problems.push(
        `docs/dod-status.md: \`docs/blockers.md\` 第 ${blocker.number} 节 is mapped ${mapped.length} ` +
          'times — one blocker, one row',
      );
    }
    const [row] = mapped as [MappingRow];
    if (!blocker.heading.startsWith(row.label)) {
      problems.push(
        `docs/dod-status.md: the mapping row for 第 ${blocker.number} 节 says "${row.label}" and ` +
          `\`docs/blockers.md\` calls that section "${blocker.heading}" — the row is about a ` +
          'different blocker now',
      );
    }
  }

  for (const row of rows) {
    if (Number.isNaN(row.section)) {
      problems.push(
        `docs/dod-status.md: the mapping row "${row.label}" does not start with \`第 N 节 ·\`, ` +
          'so it cannot be matched to a blocker section',
      );
      continue;
    }
    if (!blockerHeadings.some((blocker) => blocker.number === row.section)) {
      problems.push(
        `docs/dod-status.md: the mapping table names 第 ${row.section} 节, and ` +
          '`docs/blockers.md` has no such section',
      );
      continue;
    }
    if (row.target === NO_DOD_ROW) {
      if (/^(—|-|)$/u.test(row.reason.trim()) || row.reason.trim().length < 10) {
        problems.push(
          `docs/dod-status.md: 第 ${row.section} 节 is mapped to "${NO_DOD_ROW}" with no reason — ` +
            'a blocker the standard does not answer has to say where its result lands instead',
        );
      }
      continue;
    }
    if (!dodIds.has(row.target)) {
      problems.push(
        `docs/dod-status.md: 第 ${row.section} 节 is mapped to \`${row.target}\`, which is not a ` +
          'row of the four-state table',
      );
    }
  }

  for (const row of dodTable) {
    if (row.state !== '未过' && row.state !== '外部阻塞') continue;
    if (!rows.some((mapping) => mapping.target === row.id)) {
      problems.push(
        `docs/dod-status.md: ${row.id} is "${row.state}" and no blocker section is mapped to it, ` +
          'so the row says something is missing and nothing says where to close it',
      );
    }
  }

  return problems;
}

describe('the blockers page and the four-state table are joined', () => {
  it('maps every blocker section to a row, and every blocked row from a section', () => {
    const problems = mappingProblems({ status: STATUS, blockers: BLOCKERS });
    expect(
      problems,
      `the mapping table and the two documents disagree:\n  ${problems.join('\n  ')}`,
    ).toEqual([]);
  });

  it('is not vacuous: three sections, three rows, two blocked DoD rows', () => {
    // Without this, a parser that stopped matching would leave the case above
    // green over an empty table — the shape of a gate that stopped looking.
    const rows = mappingRows(mappingSection(STATUS));
    expect(rows.length).toBe(3);
    expect(rows.filter((row) => row.target === NO_DOD_ROW).length).toBe(1);
    const blocked = dodRows(statusSection(STATUS)).filter(
      (row) => row.state === '未过' || row.state === '外部阻塞',
    );
    expect(blocked.length).toBe(2);
    for (const row of blocked) {
      expect(rows.map((mapping) => mapping.target)).toContain(row.id);
    }
  });

  it('reports a blocker section the mapping table never mentions', () => {
    const line = mappingSection(STATUS)
      .split('\n')
      .find((candidate) => candidate.startsWith('| 第 2 节'));
    expect(line, 'the 第 2 节 mapping row is gone').toBeDefined();
    const broken = STATUS.replace(`${line!}\n`, '');
    const problems = mappingProblems({ status: broken, blockers: BLOCKERS });
    expect(problems.join('\n')).toContain('第 2 节');
    expect(problems.join('\n')).toContain('has no row in the mapping table');
  });

  it('reports a mapping row that points at a DoD id the table does not have', () => {
    const broken = STATUS.replace('| 第 1 节 · 已发布的 v1.0.0 feed 缺 `sha256` | DOD-4.2 |', '| 第 1 节 · 已发布的 v1.0.0 feed 缺 `sha256` | DOD-9.9 |');
    expect(broken, 'the mapping row this case rewrites is gone').not.toBe(STATUS);
    const problems = mappingProblems({ status: broken, blockers: BLOCKERS });
    expect(problems.join('\n')).toContain('`DOD-9.9`');
    expect(problems.join('\n')).toContain('not a row of the four-state table');
  });

  it('reports a blocked DoD row that no blocker section is mapped to', () => {
    // The direction that used to be invisible: the row says 未过, the blockers
    // page has the recipe, and nothing says they are the same thing.
    const broken = STATUS.replace(
      '| 第 1 节 · 已发布的 v1.0.0 feed 缺 `sha256` | DOD-4.2 |',
      '| 第 1 节 · 已发布的 v1.0.0 feed 缺 `sha256` | 无对应 DoD 句子 |',
    );
    expect(broken, 'the mapping row this case rewrites is gone').not.toBe(STATUS);
    const problems = mappingProblems({ status: broken, blockers: BLOCKERS });
    expect(problems.join('\n')).toContain('DOD-4.2 is "未过"');
  });

  it('reports a "no DoD sentence" row that gives no reason', () => {
    const line = mappingSection(STATUS)
      .split('\n')
      .find((candidate) => candidate.startsWith('| 第 3 节'));
    expect(line, 'the 第 3 节 mapping row is gone').toBeDefined();
    const cells = line!.trim().replace(/^\|/, '').replace(/\|$/, '').split('|');
    cells[2] = ' — ';
    const broken = STATUS.replace(line!, `| ${cells.map((cell) => cell.trim()).join(' | ')} |`);
    expect(broken, 'the reason this case empties is gone').not.toBe(STATUS);
    const problems = mappingProblems({ status: broken, blockers: BLOCKERS });
    expect(problems.join('\n')).toContain('with no reason');
  });

  it('reports a mapping row whose label no longer matches the section heading', () => {
    const broken = STATUS.replace(
      '| 第 2 节 · Windows 桌面六步 |',
      '| 第 2 节 · 更新检查 |',
    );
    expect(broken, 'the label this case rewrites is gone').not.toBe(STATUS);
    const problems = mappingProblems({ status: broken, blockers: BLOCKERS });
    expect(problems.join('\n')).toContain('the row is about a different blocker now');
  });

  it('reports a status document that lost the mapping section', () => {
    const broken = STATUS.replace(mappingSection(STATUS), '');
    expect(broken).not.toBe(STATUS);
    expect(mappingProblems({ status: broken, blockers: BLOCKERS })).toEqual([
      expect.stringContaining('no `## 三条外部阻塞落在哪一行` section'),
    ]);
  });
});

// ---------------------------------------------------------------------------
// Closing a blocker moves the total, not only the section
// ---------------------------------------------------------------------------

/**
 * ## Why this block exists
 *
 * The mapping table above joins each blocker section to the DoD row it blocks,
 * and it is read in both directions. What it does **not** read is the number at
 * the top of the four-state section: `未过 1 / 外部阻塞 1`. That number is a
 * sentence a person wrote, and the only thing comparing it with the table is
 * the table's own row count — so the day a blocker is closed, three edits have
 * to happen together and only two of them are gated:
 *
 *  1. the blocker section is deleted from `docs/blockers.md` (gated: the
 *     mapping table names a section that no longer exists);
 *  2. the DoD row moves from 未过 to 通过 (gated: the mapping table's reverse
 *     direction wants a blocked row to be mapped from);
 *  3. the total at the top of the section is rewritten (gated by nothing).
 *
 * Edit 1 and 2 without 3 leaves a page that says `未过 1` above a table with no
 * 未过 row, and every existing assertion stays green. That is the same shape as
 * the defects this repository has been closing for three rounds: a number that
 * is only ever compared with itself.
 *
 * So the identity is asserted across the two documents:
 *
 *     未过 + 外部阻塞  ==  blockers 节数 − 映射到「无对应 DoD 句子」的节数
 *
 * The right-hand side is what the blockers page claims is blocked; the left is
 * what the table says is blocked. Closing a blocker moves both, and moving one
 * is a red run that names the row and the section.
 *
 * The second half is the sentence in the page itself. Each `### 解除时` section
 * ends by saying the total moves with it, because the reader who closes a
 * blocker is reading that section and not this test file. A gate that only
 * lives in the test is a gate the person doing the edit never sees.
 */

/** The sentence every `### 解除时` section has to carry. */
const TOTAL_SENTENCE = '四态合计也要一起改';

/** Each `### 解除时` section of the blockers page, heading line included. */
function closingSections(markdown: string): string[] {
  const lines = markdown.split('\n');
  const sections: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index]!.startsWith('### 解除时')) continue;
    const body: string[] = [lines[index]!];
    for (let next = index + 1; next < lines.length; next += 1) {
      if (/^#{2,3} /.test(lines[next]!)) break;
      body.push(lines[next]!);
    }
    sections.push(body.join('\n'));
  }
  return sections;
}

/** Every way the four-state total and the blockers page can disagree. */
function blockerTotalProblems(documents: { status: string; blockers: string }): string[] {
  const section = mappingSection(documents.status);
  if (section.length === 0) {
    return [
      `docs/dod-status.md: no \`${MAPPING_HEADING}\` section, so nothing joins the four-state ` +
        'table to the blockers page and the total cannot be checked against it',
    ];
  }
  const rows = mappingRows(section);
  const blockerNumbers = [...documents.blockers.matchAll(/^## (\d+)\. /gm)].map((match) =>
    Number(match[1]),
  );
  const dodTable = dodRows(statusSection(documents.status));
  const blocked = dodTable.filter((row) => row.state === '未过' || row.state === '外部阻塞');
  const noDod = rows.filter((row) => row.target === NO_DOD_ROW);
  const problems: string[] = [];

  const expected = blockerNumbers.length - noDod.length;
  if (blocked.length !== expected) {
    problems.push(
      `docs/dod-status.md: 未过 + 外部阻塞 = ${blocked.length} row(s) ` +
        `(${blocked.map((row) => row.id).join(', ') || 'none'}), but \`docs/blockers.md\` has ` +
        `${blockerNumbers.length} section(s) and ${noDod.length} of them map to ` +
        `"${NO_DOD_ROW}", so ${expected} DoD row(s) should be blocked — closing a blocker ` +
        'moves the total, not only the section',
    );
  }

  // The named half: a row that is still blocked while the section that said how
  // to close it is gone. The count above catches the arithmetic; this catches
  // the reader who is sent to a section number that no longer exists.
  for (const row of blocked) {
    const targets = rows.filter((mapping) => mapping.target === row.id);
    if (targets.length === 0) continue; // `mappingProblems` names this one
    if (targets.some((mapping) => blockerNumbers.includes(mapping.section))) continue;
    problems.push(
      `docs/dod-status.md: ${row.id} is still "${row.state}", but \`docs/blockers.md\` no ` +
        `longer has 第 ${targets.map((mapping) => mapping.section).join(' / ')} 节 — the row ` +
        'says something is missing and the page that said how to close it is gone',
    );
  }

  return problems;
}

/** Every `### 解除时` section that stopped saying the total moves with it. */
function closingSentenceProblems(blockers: string): string[] {
  const sections = closingSections(blockers);
  if (sections.length === 0) {
    return [
      'docs/blockers.md: no `### 解除时` section, so nothing tells the reader who closes a ' +
        'blocker that the four-state total moves with it',
    ];
  }
  return sections
    .filter((section) => !section.includes(TOTAL_SENTENCE))
    .map((section) => {
      const heading = section.split('\n')[0]!.trim();
      return (
        `docs/blockers.md: \`${heading}\` does not say \`${TOTAL_SENTENCE}\`, so the reader who ` +
        'closes this blocker edits the section and leaves the total behind — the two documents ' +
        'then disagree and only the count gate notices'
      );
    });
}

describe('closing a blocker moves the total, not only the section', () => {
  it('reads both documents, so the identity is not computed over nothing', () => {
    const rows = mappingRows(mappingSection(STATUS));
    const sections = [...BLOCKERS.matchAll(/^## \d+\. /gm)].length;
    const blocked = dodRows(statusSection(STATUS)).filter(
      (row) => row.state === '未过' || row.state === '外部阻塞',
    );
    expect(sections, 'docs/blockers.md lists no blocker section').toBeGreaterThan(0);
    expect(blocked.length, 'the four-state table has no blocked row').toBeGreaterThan(0);
    expect(
      rows.filter((row) => row.target === NO_DOD_ROW).length,
      'no blocker is mapped to "no DoD sentence", so the subtraction is untested',
    ).toBeGreaterThan(0);
  });

  it('keeps 未过 + 外部阻塞 equal to the blocker sections that have a DoD sentence', () => {
    const problems = blockerTotalProblems({ status: STATUS, blockers: BLOCKERS });
    expect(
      problems,
      `the four-state total and the blockers page disagree:\n  ${problems.join('\n  ')}`,
    ).toEqual([]);
  });

  it('reports a blocker section deleted while its DoD row is still blocked', () => {
    // The edit that closes a blocker, half done: the section is gone and the
    // row still says 未过. Nothing else in this file names DOD-4.2 here.
    const lines = BLOCKERS.split('\n');
    const start = lines.findIndex((line) => line.startsWith('## 1. '));
    expect(start, 'docs/blockers.md has no 第 1 节').toBeGreaterThanOrEqual(0);
    let end = lines.length;
    for (let index = start + 1; index < lines.length; index += 1) {
      if (lines[index]!.startsWith('## ')) {
        end = index;
        break;
      }
    }
    const broken = [...lines.slice(0, start), ...lines.slice(end)].join('\n');
    expect(broken).not.toBe(BLOCKERS);
    const problems = blockerTotalProblems({ status: STATUS, blockers: broken }).join('\n');
    expect(problems).toContain('DOD-4.2 is still "未过"');
    expect(problems).toContain('no longer has 第 1 节');
  });

  it('reports a total that was moved without deleting the section', () => {
    // The other half: the row is closed in the table and the total is rewritten,
    // and the blockers page still carries the recipe. The mapping table alone
    // stays green here — it only asks that blocked rows are mapped from.
    const line = STATUS.split('\n').find((row) => row.startsWith('| DOD-4.2 '));
    expect(line, 'DOD-4.2 is not in the table any more').toBeDefined();
    const cells = line!
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((cell) => cell.trim());
    cells[2] = '通过';
    cells[4] = '—';
    const closed = `| ${cells.join(' | ')} |`;
    const declared = /四态合计：通过 (\d+) \/ 未过 (\d+) \/ 外部阻塞 (\d+) \/ 不适用 (\d+)/u.exec(
      statusSection(STATUS),
    );
    expect(declared, 'the section states no 四态合计').not.toBeNull();
    const [, pass, fail, blockedCount, notApplicable] = declared!;
    const moved =
      `四态合计：通过 ${Number(pass) + 1} / 未过 ${Number(fail) - 1} / ` +
      `外部阻塞 ${blockedCount} / 不适用 ${notApplicable}`;
    const broken = STATUS.replace(line!, closed).replace(declared![0], moved);
    expect(broken).not.toBe(STATUS);
    const problems = blockerTotalProblems({ status: broken, blockers: BLOCKERS }).join('\n');
    expect(problems).toContain('closing a blocker moves the total, not only the section');
  });

  it('says in every closing section that the total moves with it', () => {
    expect(closingSentenceProblems(BLOCKERS)).toEqual([]);
  });

  it('reports a closing section that stopped saying the total moves with it', () => {
    const sections = closingSections(BLOCKERS);
    expect(sections.length, 'docs/blockers.md has no `### 解除时` section').toBeGreaterThan(0);
    const broken = BLOCKERS.replace(
      sections[0]!,
      sections[0]!.replace(TOTAL_SENTENCE, '记得改文档'),
    );
    expect(broken).not.toBe(BLOCKERS);
    const problems = closingSentenceProblems(broken).join('\n');
    expect(problems).toContain(TOTAL_SENTENCE);
    expect(problems).toContain('### 解除时');
  });
});
