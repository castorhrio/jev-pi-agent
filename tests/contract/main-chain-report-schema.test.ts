/**
 * The report's shape is a document, and the judgement reads it.
 *
 * ## Why this file exists
 *
 * `--report` writes a report and `--judge` reads it back, and until this round
 * the shape lived only in the reading code: `judgeReport()` asked
 * `typeof report.platform === 'string'`, then `report.build?.version`, then
 * `Array.isArray(report.steps)`, one field at a time. That is a shape nobody can
 * read without opening a 1600-line script — and the person who judges a report
 * from a Windows machine is usually not the person who wrote it. The page that
 * told them what to do (`docs/manual-verification/README.md`) could describe the
 * fields, but a description and an implementation are two facts, and two facts
 * drift.
 *
 * So the shape is `docs/manual-verification/report-schema.json`, `--judge`
 * validates against it, and this file is what keeps the three from separating:
 *
 *  1. the schema is the file the script loads, and it parses;
 *  2. a report `buildReport()` writes validates — the writer and the declared
 *     shape are the same shape, so a field added to one and not the other is red
 *     here rather than discovered by whoever carries a report home;
 *  3. a report that does not match is refused **by the schema**: the same report
 *     is judged green once the field is removed from the schema's `required`
 *     list. That mutation is the assertion that the schema is the source of
 *     truth rather than a decoration next to the real checks;
 *  4. every keyword in the schema is one the validator implements. A keyword the
 *     walker silently ignores is a rule that reads as enforced and is not — the
 *     failure shape this repository has named more than once;
 *  5. every field the schema requires is a field the judgement actually reads,
 *     so the schema cannot grow a requirement that decides nothing.
 *
 * ## What it does not assert
 *
 * That a report is true. The schema says what a report *is*; whether the run
 * happened is the question `judgeReport()` says in its own words it cannot
 * answer. This file is about the shape being one fact in one place.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  DRIVEN_STEPS,
  REPORT_SCHEMA_PATH,
  buildReport,
  judgeReport,
  judgeReportCommand,
  loadReportSchema,
  repoVersion,
  validateReportShape,
} from '../../scripts/verify-main-chain.mjs';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const SCHEMA_FILE = join(REPO_ROOT, 'docs', 'manual-verification', 'report-schema.json');
const SCRIPT = join(REPO_ROOT, 'scripts', 'verify-main-chain.mjs');
const MANUAL_PAGE = join(REPO_ROOT, 'docs', 'manual-verification', 'README.md');

/** A report that closes the row, in the shape the run writes. */
function greenReport(overrides: Record<string, unknown> = {}) {
  return {
    platform: 'win32',
    build: {
      executable: 'C:\\repo\\release\\win-unpacked\\UCAD.exe',
      version: repoVersion(),
      sizeBytes: 122806279,
      modifiedAt: '2026-11-04T00:00:00.000Z',
    },
    ranAt: '2026-11-04T00:00:00.000Z',
    steps: DRIVEN_STEPS.map((n) => ({ n, verdict: 'pass', evidence: [`${n}:recorded`] })),
    note: 'This file records what a run printed.',
    ...overrides,
  };
}

/** The schema with one entry removed from the root `required` list. */
function schemaWithout(field: string) {
  const schema = JSON.parse(JSON.stringify(loadReportSchema()));
  schema.required = schema.required.filter((entry: string) => entry !== field);
  return schema;
}

/** Every key that appears where a schema node is expected. */
function schemaKeywords(node: unknown, found = new Set<string>()): Set<string> {
  if (node === null || typeof node !== 'object') return found;
  if (Array.isArray(node)) {
    for (const entry of node) schemaKeywords(entry, found);
    return found;
  }
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    found.add(key);
    if (key === 'properties') {
      for (const child of Object.values(value as Record<string, unknown>)) {
        schemaKeywords(child, found);
      }
    } else if (key === 'items') {
      schemaKeywords(value, found);
    }
  }
  return found;
}

describe('the schema is a file the judgement reads', () => {
  it('exists where the script says it does, and parses', () => {
    expect(existsSync(SCHEMA_FILE), `missing ${SCHEMA_FILE}`).toBe(true);
    expect(REPORT_SCHEMA_PATH).toBe('../docs/manual-verification/report-schema.json');

    const schema = loadReportSchema();
    expect(schema.$schema).toContain('json-schema.org');
    expect(schema.title).toContain('report');
    // The file on disk and the object the script loads are the same document:
    // a schema edited in one place and loaded from another would be two facts.
    expect(JSON.parse(readFileSync(SCHEMA_FILE, 'utf8'))).toEqual(schema);
  });

  it('declares the five fields a report has, and the three a step has', () => {
    const schema = loadReportSchema();

    expect(schema.required).toEqual(['platform', 'build', 'ranAt', 'steps', 'note']);
    expect(schema.properties.steps.items.required).toEqual(['n', 'verdict', 'evidence']);
    expect(schema.properties.steps.items.properties.verdict.enum).toEqual(['pass', 'fail', 'skip']);
  });

  it('uses only keywords the validator implements', () => {
    // A keyword the walker does not know is ignored, which makes it a rule that
    // reads as enforced and is not. The set is written out so adding a keyword
    // to the schema is a decision someone makes here, in front of this list.
    const implemented = new Set([
      '$schema',
      '$id',
      'title',
      'description',
      'type',
      'required',
      'properties',
      'items',
      'enum',
      'minItems',
      'minLength',
      'minimum',
    ]);

    const unknown = [...schemaKeywords(loadReportSchema())].filter((key) => !implemented.has(key));
    expect(unknown, `the schema uses keywords the validator ignores: ${unknown.join(', ')}`).toEqual(
      [],
    );
  });
});

describe('the writer and the schema are the same shape', () => {
  it('validates a report the run itself writes', () => {
    const report = buildReport({
      platform: 'win32',
      build: { executable: 'C:\\repo\\UCAD.exe', version: repoVersion(), sizeBytes: 1, modifiedAt: null },
      requested: [...DRIVEN_STEPS],
      driven: [...DRIVEN_STEPS],
      passed: [...DRIVEN_STEPS],
      failed: [],
      evidence: DRIVEN_STEPS.map((n) => `${n}:recorded`),
      ranAt: '2026-11-04T00:00:00.000Z',
    });

    expect(validateReportShape(report)).toEqual([]);
    // And the judgement agrees, so the format the run produces is the format the
    // reader consumes — the same pair `win-report.test.ts` pins from the other
    // side.
    expect(judgeReport(report, { expectedVersion: repoVersion() }).ok).toBe(true);
  });

  it('validates a report whose build could not be read, because those fields may be null', () => {
    const report = buildReport({
      platform: 'win32',
      build: { executable: 'C:\\repo\\UCAD.exe', version: null, sizeBytes: null, modifiedAt: null },
      requested: [...DRIVEN_STEPS],
      driven: [...DRIVEN_STEPS],
      passed: [...DRIVEN_STEPS],
      failed: [],
      evidence: DRIVEN_STEPS.map((n) => `${n}:recorded`),
      ranAt: '2026-11-04T00:00:00.000Z',
    });

    expect(validateReportShape(report)).toEqual([]);
  });
});

describe('a report that does not match the schema is refused by the schema', () => {
  it('refuses a report with no `platform`, and stops refusing it when the schema stops requiring it', () => {
    const report = greenReport();
    delete (report as Record<string, unknown>).platform;

    const violations = validateReportShape(report);
    expect(violations).toEqual([{ path: 'platform', keyword: 'required', detail: 'platform' }]);

    const judged = judgeReport(report, { expectedVersion: repoVersion() });
    expect(judged.ok).toBe(false);
    expect(judged.problems).toEqual([
      'the report does not say which platform the run happened on, so it cannot close a row about one',
    ]);

    // The mutation that proves the schema is the source of truth: with the field
    // no longer required, the same report has no shape violation at all. If the
    // judgement still refused it, the schema would be decoration.
    expect(validateReportShape(report, schemaWithout('platform'))).toEqual([]);
  });

  it('refuses a report whose `platform` is not win32, in the words that name the substitution', () => {
    // This one is *not* a shape violation — `linux` is a perfectly good string.
    // It is the semantic question the schema cannot ask, and the reason the
    // judgement still exists after the schema has passed.
    const report = greenReport({ platform: 'linux' });

    expect(validateReportShape(report)).toEqual([]);
    const judged = judgeReport(report, { expectedVersion: repoVersion() });
    expect(judged.ok).toBe(false);
    expect(judged.problems.join(' ')).toContain('a run on another platform is a real result');
  });

  it('names the location of a violation, so a reader is told where the file is wrong', () => {
    const report = greenReport();
    report.steps[2] = { n: 3, verdict: 'maybe', evidence: ['3:recorded'] } as never;

    const violations = validateReportShape(report);
    expect(violations).toEqual([
      { path: 'steps[2].verdict', keyword: 'enum', detail: '"maybe"' },
    ]);
    expect(judgeReport(report, { expectedVersion: repoVersion() }).problems.join(' ')).toContain(
      'not one of pass / fail / skip',
    );
  });

  it('refuses a step with no evidence array, which the schema requires', () => {
    const report = greenReport();
    report.steps[3] = { n: 4, verdict: 'pass' } as never;

    expect(validateReportShape(report)).toEqual([
      { path: 'steps[3].evidence', keyword: 'required', detail: 'evidence' },
    ]);
    expect(judgeReport(report, { expectedVersion: repoVersion() }).problems.join(' ')).toContain(
      'step 4 says it passed but carries no evidence line',
    );
  });

  it('refuses an empty `steps` array, and a file that is not an object at all', () => {
    expect(validateReportShape(greenReport({ steps: [] }))).toEqual([
      { path: 'steps', keyword: 'minItems', detail: '0 < 1' },
    ]);
    for (const value of [null, [], 'a string', 42]) {
      const violations = validateReportShape(value);
      expect(violations.length, `${JSON.stringify(value)} matched the schema`).toBeGreaterThan(0);
      expect(violations[0]!.keyword).toBe('type');
    }
  });
});

describe('every field the schema requires is a field the judgement reads', () => {
  it('refuses a report with each required field removed, so none of them is decorative', () => {
    for (const field of ['platform', 'build', 'ranAt', 'steps', 'note']) {
      const report = greenReport();
      delete (report as Record<string, unknown>)[field];

      const judged = judgeReport(report, { expectedVersion: repoVersion() });
      expect(judged.ok, `a report with no \`${field}\` was judged green`).toBe(false);
      expect(judged.problems.length, `no problem named for a missing \`${field}\``).toBeGreaterThan(0);
    }
  });
});

describe('the command refuses a report the schema refuses', () => {
  it('exits 1 and names the platform for a report that does not say which one it ran on', () => {
    const report = greenReport();
    delete (report as Record<string, unknown>).platform;

    const result = judgeReportCommand(writeTemp(report), { expectedVersion: repoVersion() });

    expect(result.code).toBe(1);
    expect(result.lines.join('\n')).toContain('does not say which platform');
    expect(result.lines.join('\n')).toContain('FAIL — 1 thing(s)');
  });
});

describe('the page a person reads points at the schema', () => {
  it('names the schema file, so the shape can be read without the script', () => {
    const page = readFileSync(MANUAL_PAGE, 'utf8');

    expect(page).toContain('report-schema.json');
    expect(page).toContain('--judge');
  });

  it('is the file the script loads, by path', () => {
    const source = readFileSync(SCRIPT, 'utf8');

    expect(source).toContain('docs/manual-verification/report-schema.json');
    expect(source, 'the judgement must validate against the schema').toContain(
      'validateReportShape(report)',
    );
  });
});

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

/** Writes a report into a throwaway file and returns its path. */
function writeTemp(report: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'ucad-report-schema-'));
  tempDirs.push(dir);
  const path = join(dir, 'win-report.json');
  writeFileSync(path, JSON.stringify(report, null, 2), 'utf8');
  return path;
}
