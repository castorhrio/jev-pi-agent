/**
 * CONTRIBUTING's table of source scanners must stay true, and every scanner
 * must still have the gate that pins what it reads.
 *
 * ## Why this exists
 *
 * `CONTRIBUTING.md` has a "How the source scans are written" section whose
 * table names each scanner, the file it lives in, and the shape of source it
 * reads. That table is the map a contributor follows when a scan misses a
 * spelling — it says where the scanner is, which gate drives it, and (in the
 * prose below the table) where the fixture block for it lives.
 *
 * Nothing checked it. A map that is only ever read by somebody already lost is
 * a map that rots in the one direction that matters: the file is renamed, the
 * gate is merged into another one, a scanner is added and never listed — and
 * the table still looks authoritative. The repository already made the same
 * call for the README's file citations (`readme.test.ts`); this is that call
 * applied to the document that describes the gates themselves.
 *
 * ## What this file does
 *
 *  - **Both directions of the table.** The scanners this file knows about and
 *    the rows in the document must be the same set: a row without a rule here
 *    is unchecked prose, and a rule without a row is a scanner CI gates but
 *    the map does not mention.
 *  - **The paths the document cites exist.** Read out of the *"Lives in"*
 *    column only — the "What it reads" column is prose that legitimately names
 *    files without paths (`app-container.ts`), and treating those as citations
 *    would be fourteen false positives all over again.
 *  - **A `-scan.ts` module is named in the table.** A new scanner module in
 *    `tests/contract` that nobody documents fails here, by name.
 *  - **A scanner module is imported by the gate the table names.** "Driven by
 *    `error-formatting.test.ts`" is a checkable claim: that file has to import
 *    the module. A row whose driver stopped importing its scanner documents a
 *    gate that no longer exists.
 *  - **A block in that gate pins what the scan reads.** The named block is the
 *    fixture block the prose tells a contributor to extend; if it disappears,
 *    the instruction below the table points at nothing.
 *
 * Deliberately **not** asserted: what is *inside* those blocks. Which spellings
 * a scanner is fed, and which blind spots are asserted absent, is the business
 * of the driving test, and a rule about it here would be a second parser
 * reading the first one's tests. This file keeps the map honest; it does not
 * grade the territory.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';

const CONTRIBUTING = 'CONTRIBUTING.md';
const contributing = existsSync(CONTRIBUTING) ? readFileSync(CONTRIBUTING, 'utf8') : '';

const TABLE_HEADING = '## How the source scans are written';
/** Where a bare `foo.test.ts` in the table resolves. */
const TEST_ROOT = 'tests/contract';

interface ScannerRule {
  /** the row's first cell, verbatim */
  readonly id: string;
  /** files this scanner consists of; every one must exist */
  readonly lives: readonly string[];
  /** the gate the table names as driving this scanner */
  readonly driver?: string;
  /** the block in that gate that pins what the scan reads */
  readonly pins: { readonly file: string; readonly block: string };
}

/**
 * One entry per row of the table, in the order the table lists them.
 *
 * This duplicates the map on purpose. The two copies are compared against each
 * other below, so the duplication is checked rather than trusted: renaming a
 * file in one place and not the other is a red test, not a stale row.
 */
const SCANNERS: readonly ScannerRule[] = [
  {
    id: 'Container claims',
    lives: ['tests/contract/app-container-started.test.ts'],
    pins: {
      file: 'tests/contract/app-container-started.test.ts',
      block: 'the scan that reads the container’s promises',
    },
  },
  {
    id: 'Zod messages',
    lives: ['tests/contract/zod-message-scan.ts', 'tests/contract/zod-custom-messages.test.ts'],
    driver: 'tests/contract/zod-custom-messages.test.ts',
    pins: {
      file: 'tests/contract/zod-custom-messages.test.ts',
      block: 'the scan recognises the shapes a schema can write a message in',
    },
  },
  {
    id: 'Bare throws',
    lives: ['tests/contract/bare-throw-scan.ts', 'tests/contract/error-formatting.test.ts'],
    driver: 'tests/contract/error-formatting.test.ts',
    pins: { file: 'tests/contract/error-formatting.test.ts', block: 'the bare-throw scan' },
  },
  {
    id: 'Page scripts',
    lives: ['tests/contract/layout-scripts.test.ts', 'scripts/layout-page-scripts.mjs'],
    driver: 'tests/contract/layout-scripts.test.ts',
    pins: { file: 'tests/contract/layout-scripts.test.ts', block: 'page scripts run in a real browser' },
  },
  {
    id: 'Renderer markup',
    lives: ['tests/contract/ui-copy.test.ts', 'tests/contract/layout.test.ts'],
    pins: {
      file: 'tests/contract/ui-copy.test.ts',
      block: 'no hardcoded UI copy (defect class: English in a translated panel)',
    },
  },
];

/** The data rows of the first markdown table under a heading, as trimmed cells. */
function tableRows(markdown: string, heading: string): string[][] {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start === -1) return [];
  const rows: string[][] = [];
  let inTable = false;
  for (const line of lines.slice(start + 1)) {
    if (line.trim().startsWith('|')) {
      inTable = true;
      const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|');
      // The `|---|---|` separator is not a row.
      if (cells.every((cell) => /^\s*:?-+:?\s*$/.test(cell))) continue;
      rows.push(cells.map((cell) => cell.trim()));
      continue;
    }
    if (inTable) break; // the table ended
  }
  // Drop the header row: every table here has one, and it names columns rather
  // than a scanner.
  return rows.slice(1);
}

/**
 * The repo paths a markdown cell cites.
 *
 * Only backticked tokens that look like files count, and a bare `foo.test.ts`
 * resolves against `tests/contract/` — the table writes it that way after
 * "driven by". A token that is prose (`field!: T`, `throw new Error(…)`) is not
 * a path and is skipped by the extension rule.
 */
function citedFiles(cell: string): string[] {
  return [...cell.matchAll(/`([^`\n]+)`/g)]
    .map((match) => match[1]!.trim())
    .filter((token) => /\.(tsx?|mjs|cjs)$/.test(token))
    .map((token) => (token.includes('/') ? token : `${TEST_ROOT}/${token}`));
}

/** Paths in the list that are not on disk. */
function missingFiles(paths: readonly string[], exists: (path: string) => boolean): string[] {
  return paths.filter((path) => !exists(path));
}

/**
 * Whether a test file contains the named block.
 *
 * `describe(…)` or `it(…)`, either quote style, so the check is about the block
 * existing rather than about how it was written. A template literal is
 * deliberately not read — the blind spot is pinned in
 * "does not recognise a block whose name is written as a template literal"
 * below, so teaching the scan about backticks is a decision with a red test
 * attached rather than a quiet widening of the map.
 */
function hasBlock(source: string, block: string): boolean {
  return new RegExp(`(?:describe|it)\\((['"])${block.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\1`)
    .test(source);
}

/** Files under `tests/contract` that are scanner modules rather than gates. */
function scannerModules(dir = TEST_ROOT): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('-scan.ts'))
    .map((name) => `${dir}/${name}`)
    .sort();
}

/**
 * Scanner modules no table row mentions.
 *
 * The claim the table makes is "these are the source scans"; a module outside it
 * is a scan whose blind spots the document does not describe.
 */
function undocumentedModules(modules: readonly string[], documented: readonly string[]): string[] {
  const known = new Set(documented);
  return modules.filter((module) => !known.has(module));
}

/** Import specifier a driver would use for a module beside it. */
function siblingImport(module: string): string {
  return `from './${module.split('/').pop()!.replace(/\.ts$/, '')}'`;
}

const rows = tableRows(contributing, TABLE_HEADING);
const documentedPaths = rows.flatMap((row) => citedFiles(row[1] ?? ''));

describe('CONTRIBUTING’s table of source scanners', () => {
  it.skipIf(contributing === '')('is present and parseable, so the checks below are not vacuous', () => {
    // Every assertion here reads this table. If the heading is reworded or the
    // table becomes prose, the parse returns `[]` and the checks pass over
    // nothing — the shape of a gate that has stopped gating.
    expect(rows.length, `no table was found under "${TABLE_HEADING}" in CONTRIBUTING.md`).toBeGreaterThan(
      SCANNERS.length - 1,
    );
    expect(documentedPaths.length).toBeGreaterThan(SCANNERS.length - 1);
  });

  it('documents exactly the scanners this file knows about', () => {
    // Both directions, so the table cannot grow a row nobody checks and this
    // file cannot hold a rule the document never explains.
    const documented = rows.map((row) => row[0] ?? '');
    expect(
      documented,
      'the document and this file name different scanners; add the row and the rule together',
    ).toEqual(SCANNERS.map((scanner) => scanner.id));
  });

  it('cites only files that exist', () => {
    const missing = missingFiles(
      [...documentedPaths, ...SCANNERS.flatMap((scanner) => scanner.lives)],
      existsSync,
    );
    expect(
      [...new Set(missing)],
      'the scanner table points at files that no longer exist:\n  ' +
        `${missing.join('\n  ')}\nA contributor following the table finds nothing.`,
    ).toEqual([]);
  });

  it('documents every scanner module in the contract suite', () => {
    expect(
      undocumentedModules(scannerModules(), documentedPaths),
      'a `-scan.ts` module is not named in the scanner table, so its rules are undocumented',
    ).toEqual([]);
  });

  it('leaves no scanner module without a gate that imports it', () => {
    // A scanner validated only by the file it sits in has never been fed a
    // fixture, and its failure mode is unknown.
    for (const scanner of SCANNERS) {
      const module = scanner.lives.find((path) => path.endsWith('-scan.ts'));
      if (module === undefined) continue;
      expect(scanner.driver, `${scanner.id} names a scanner module but no driving test`).toBeDefined();
      const source = readFileSync(scanner.driver!, 'utf8');
      expect(
        source.includes(siblingImport(module)),
        `${scanner.driver} no longer imports ${module}, so the table's "driven by" is a claim about nothing`,
      ).toBe(true);
    }
  });

  it('keeps the block that pins what each scan reads', () => {
    // The prose under the table tells a contributor to extend a named fixture
    // block when a spelling is missed. Those instructions are only followable
    // while the blocks exist, and a block is cheap to delete by accident.
    for (const scanner of SCANNERS) {
      const source = existsSync(scanner.pins.file) ? readFileSync(scanner.pins.file, 'utf8') : '';
      expect(
        hasBlock(source, scanner.pins.block),
        `${scanner.pins.file} no longer has the block "${scanner.pins.block}", which CONTRIBUTING tells a contributor to extend`,
      ).toBe(true);
    }
  });
});

describe('the helpers that read the table', () => {
  const TABLE = [
    '## Scans',
    '',
    '| Scanner | Lives in | What it reads |',
    '|---|---|---|',
    '| Thing | `tests/contract/a-scan.ts`, driven by `a.test.ts` | `field!: T` in `app.ts` |',
    '',
    'after',
  ].join('\n');

  it('reads the rows of the table and stops at the next block', () => {
    // Fed a table written the way CONTRIBUTING writes one, including a
    // citation form that is not a path (`field!: T`) and a file named without
    // a directory (`app.ts`) — both of which must not become citations.
    const parsed = tableRows(TABLE, '## Scans');
    expect(parsed, 'the header row is a column list, not a scanner').toHaveLength(1);
    expect(parsed.map((row) => row[0])).toEqual(['Thing']);
    expect(citedFiles(parsed[0]![1]!)).toEqual([
      'tests/contract/a-scan.ts',
      'tests/contract/a.test.ts',
    ]);
  });

  it('resolves a bare test filename against the contract suite', () => {
    // The table says "driven by `error-formatting.test.ts`", not the full
    // path. Resolving it any other way would report a file that exists as
    // missing, and a gate that cries wolf gets switched off.
    expect(citedFiles('`bare-throw-scan.ts`, driven by `error-formatting.test.ts`')).toEqual([
      'tests/contract/bare-throw-scan.ts',
      'tests/contract/error-formatting.test.ts',
    ]);
  });

  it('reports a cited file that is not on disk', () => {
    // The negative fixture: the single defect this file exists to catch.
    const cited = citedFiles('`tests/contract/a-scan.ts`');
    expect(missingFiles(cited, (path) => path.endsWith('-scan.ts'))).toEqual([]);
    expect(missingFiles(cited, () => false)).toEqual(['tests/contract/a-scan.ts']);
  });

  it('finds a block by name, and reports the one that is gone', () => {
    const source = "describe('the bare-throw scan', () => {\n  it('x', () => {});\n});";
    expect(hasBlock(source, 'the bare-throw scan')).toBe(true);
    expect(hasBlock(source, 'the bare throw scan')).toBe(false);
    // A block name with regex characters in it must be matched literally.
    expect(hasBlock("it('reports a (weird) name', () => {})", 'reports a (weird) name')).toBe(true);
  });

  it('does not recognise a block whose name is written as a template literal', () => {
    // The blind spot, asserted rather than described. `hasBlock` reads a
    // quoted string argument, so a gate whose fixture block is written
    // it(`the bare-throw scan`, …) reads as a *missing* block here — the table
    // then fails claiming a block CONTRIBUTING tells a contributor to extend
    // has been deleted, and the message names the wrong cause.
    //
    // Pinned in this direction on purpose: if the scan is taught about
    // backticks, this line goes red and whoever changed it has to decide what
    // the map now accepts. CONTRIBUTING says the same in prose ("write the
    // block name in a quoted literal").
    expect(hasBlock('it(`the bare-throw scan`, () => {});', 'the bare-throw scan')).toBe(false);
    // And the quoted spelling of the same block is the one that counts, so the
    // assertion above is about the quoting, not about this name.
    expect(hasBlock("it('the bare-throw scan', () => {});", 'the bare-throw scan')).toBe(true);
  });

  it('reports a scanner module the table does not name', () => {
    expect(undocumentedModules(['tests/contract/a-scan.ts'], [])).toEqual([
      'tests/contract/a-scan.ts',
    ]);
    expect(
      undocumentedModules(['tests/contract/a-scan.ts'], ['tests/contract/a-scan.ts']),
    ).toEqual([]);
  });

  it('builds the import specifier a beside-module driver would use', () => {
    // The claim "driven by x.test.ts" is checked by looking for this string, so
    // the string has to be the one a real import writes.
    expect(siblingImport('tests/contract/bare-throw-scan.ts')).toBe("from './bare-throw-scan'");
  });
});
