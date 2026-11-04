/**
 * A report carried home from a Windows machine, judged — and what it takes to
 * close the row it was made for.
 *
 * ## Why this exists
 *
 * `scripts/verify-main-chain.mjs --report` writes the six steps as a document,
 * `docs/manual-verification.md` says to copy that file back, and
 * `docs/dod-status.md` says the Windows row is waiting for it. Until this file,
 * nothing said what **inside** the document would close the row. That is the
 * shape this repository keeps finding and naming: a gate that records an
 * artefact but never answers yes or no about it, so the answer is supplied by
 * whoever wants it.
 *
 * So the judgement is a function (`judgeReport()`) and a command
 * (`--judge <file>`), and this file drives both. Four things are asserted, in
 * the order they matter:
 *
 *  1. a fully-passing `win32` report for this build closes the row;
 *  2. each way of being *almost* that is refused, and refused **by name** —
 *     another platform, a `fail` step, a `skip` step, a missing step row, a
 *     report about another build, and a file that is not a report at all. The
 *     wordings differ because the next action differs: re-run on Windows,
 *     fix what failed, cover what was skipped, or run it again on this build;
 *  3. the writer and the judge agree — a report from `buildReport()` is judged
 *     green, so the format the run produces is the format the reader consumes.
 *     Two functions that each look right and disagree would be worse than one;
 *  4. the documents name the command, because a documented procedure and an
 *     implemented one are the same only while something compares them.
 *
 * ## What it cannot assert
 *
 * That the run happened. A report is a document, and a document can be written
 * by hand; `judgeReport()` says so in its own doc comment and the file's `note`
 * says so in the file. The case
 * `says in its own words that it judges what the file says` pins that honesty
 * rather than letting the verdict read as a certificate.
 */

import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DRIVEN_STEPS,
  buildReport,
  judgeReport,
  judgeReportCommand,
  repoVersion,
} from '../../scripts/verify-main-chain.mjs';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'verify-main-chain.mjs');

/** A report that closes the row: every driven step passed, on Windows, this build. */
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

describe('what a carried-home report has to be, to close the row', () => {
  it('closes the row when every driven step passed on Windows for this build', () => {
    const result = judgeReport(greenReport(), { expectedVersion: repoVersion() });

    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
    // One row per step the verifier drives, so a reader sees what was judged
    // rather than a bare verdict.
    expect(result.rows.map((row) => [row.n, row.verdict])).toEqual(
      DRIVEN_STEPS.map((n) => [n, 'pass']),
    );
  });

  it('refuses a report from another platform instead of counting it as a Windows run', () => {
    // The substitution this row has been waiting on for several rounds: the
    // steps pass on a Linux desktop session, and "we already ran it" is one
    // edit away from here.
    const result = judgeReport(greenReport({ platform: 'linux' }), {
      expectedVersion: repoVersion(),
    });

    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toContain('written on linux');
    expect(result.problems.join(' ')).toContain('win32');
  });

  it('keeps the row open on a failed step, and says which one', () => {
    const steps = DRIVEN_STEPS.map((n) => ({
      n,
      verdict: n === 4 ? 'fail' : 'pass',
      evidence: [`${n}:recorded`],
    }));

    const result = judgeReport(greenReport({ steps }), { expectedVersion: repoVersion() });

    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([expect.stringContaining('step 4 failed')]);
    // A failure is a result, not a bad upload: the sentence has to leave the
    // reader with the row open rather than with "fix the file".
    expect(result.problems[0]).toContain('row stays open');
  });

  it('treats a skipped step as not covered, in words that differ from a failure', () => {
    // `--steps 1,4` writes `skip` rows on purpose (a reader comparing two
    // reports must see the gap). Carried home as if complete, it would cover a
    // row it never drove — and "not run" needs a different next action from
    // "failed", so it gets a different sentence.
    const steps = DRIVEN_STEPS.map((n) => ({
      n,
      verdict: n === 5 ? 'skip' : 'pass',
      evidence: [`${n}:recorded`],
    }));

    const result = judgeReport(greenReport({ steps }), { expectedVersion: repoVersion() });

    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([expect.stringContaining('step 5 was not run')]);
    expect(result.problems[0]).not.toContain('failed');
  });

  it('names a step the report does not carry at all', () => {
    const steps = DRIVEN_STEPS.filter((n) => n !== 3).map((n) => ({
      n,
      verdict: 'pass',
      evidence: [`${n}:recorded`],
    }));

    const result = judgeReport(greenReport({ steps }), { expectedVersion: repoVersion() });

    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([expect.stringContaining('step 3 is not in the report')]);
    expect(result.rows.find((row) => row.n === 3)?.verdict).toBe('missing');
  });

  it('refuses a report about another build, because it proves something about that build', () => {
    const report = greenReport({ build: { executable: 'C:\\old\\UCAD.exe', version: '0.9.0' } });

    const result = judgeReport(report, { expectedVersion: repoVersion() });

    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toContain('measured build 0.9.0');
    expect(result.problems.join(' ')).toContain('run it again');
  });

  it('refuses a report that does not say which build it measured', () => {
    const report = greenReport({ build: { executable: 'C:\\repo\\UCAD.exe' } });

    expect(judgeReport(report, { expectedVersion: repoVersion() }).ok).toBe(false);
  });

  it('refuses an unknown verdict rather than reading anything that is not a failure as a pass', () => {
    const steps = DRIVEN_STEPS.map((n) => ({
      n,
      verdict: n === 2 ? 'ok' : 'pass',
      evidence: [`${n}:recorded`],
    }));

    const result = judgeReport(greenReport({ steps }), { expectedVersion: repoVersion() });

    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toContain('`ok`');
    expect(result.problems.join(' ')).toContain('not one of pass / fail / skip');
  });

  it('refuses a file that is not a report instead of judging an empty set as green', () => {
    for (const value of [null, [], 'a string', {}, { steps: [] }]) {
      const result = judgeReport(value, { expectedVersion: repoVersion() });
      expect(result.ok, `${JSON.stringify(value)} was judged green`).toBe(false);
      expect(result.problems.length).toBeGreaterThan(0);
    }
  });

  it('says in its own words that it judges what the file says', () => {
    // The verdict must not read as a certificate: the run may have been
    // retyped. Both halves say it — here, and inside the report's `note`.
    const source = readFileSync(SCRIPT, 'utf8');

    expect(source).toContain('It judges what the file *says*');
    // The file says it too: `buildReport()` writes the sentence into the
    // report's own `note`, so a reader who never opens this test still knows
    // what they are holding. Asserted as the field plus its wording, because
    // `'note'` as a quoted literal is not in the source — the field is written
    // as `note:` and referred to in backticks.
    expect(source).toContain('note:');
    expect(source).toContain('cannot check that');
  });
});

describe('the writer and the judge agree on what a report is', () => {
  it('judges a report built by the run itself as green', () => {
    // The two halves of one feature: `buildReport()` produces the format,
    // `judgeReport()` consumes it. Two functions that each look right and
    // disagree would send a real Windows run home with a false red.
    const report = buildReport({
      platform: 'win32',
      build: { executable: 'C:\\repo\\release\\win-unpacked\\UCAD.exe', version: repoVersion() },
      requested: [...DRIVEN_STEPS],
      driven: DRIVEN_STEPS,
      passed: [...DRIVEN_STEPS],
      failed: [],
      evidence: DRIVEN_STEPS.map((n) => `${n}:recorded`),
      ranAt: '2026-11-04T00:00:00.000Z',
    });

    expect(judgeReport(report, { expectedVersion: repoVersion() }).problems).toEqual([]);
  });

  it('judges a partially requested run as not covering the row', () => {
    const report = buildReport({
      platform: 'win32',
      build: { executable: 'C:\\repo\\UCAD.exe', version: repoVersion() },
      requested: [1, 4],
      driven: DRIVEN_STEPS,
      passed: [1, 4],
      failed: [],
      evidence: ['1:recorded', '4:recorded'],
      ranAt: '2026-11-04T00:00:00.000Z',
    });

    const result = judgeReport(report, { expectedVersion: repoVersion() });

    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toContain('step 2 was not run');
  });
});

describe('the judge as a command', () => {
  /** A throwaway directory per case, removed after it. */
  function withTempFile(contents: string | null, body: (file: string) => void) {
    const dir = mkdtempSync(join(tmpdir(), 'ucad-win-report-'));
    try {
      const file = join(dir, 'win-report.json');
      if (contents !== null) writeFileSync(file, contents, 'utf8');
      body(file);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('exits 0 for a report that closes the row, and never launches anything', () => {
    withTempFile(JSON.stringify(greenReport(), null, 2), (file) => {
      const run = spawnSync(process.execPath, [SCRIPT, '--judge', file], { encoding: 'utf8' });

      expect(run.status).toBe(0);
      expect(run.stdout).toContain('PASS — the report covers steps 1, 2, 3, 4, 5 on win32');
      // The judge path answers before the run begins: no `[run] executable`
      // line, so a reader on a machine without `release/` can still judge.
      expect(run.stdout).not.toContain('[run] executable');
      expect(run.stdout).toContain('step 6 is the five states');
    });
  });

  it('exits 1 and names the step for a report that keeps the row open', () => {
    const steps = DRIVEN_STEPS.map((n) => ({
      n,
      verdict: n === 2 ? 'fail' : 'pass',
      evidence: [`${n}:recorded`],
    }));
    withTempFile(JSON.stringify(greenReport({ steps }), null, 2), (file) => {
      const run = spawnSync(process.execPath, [SCRIPT, '--judge', file], { encoding: 'utf8' });

      expect(run.status).toBe(1);
      expect(run.stderr).toContain('step 2 failed');
      expect(run.stderr).toContain('keep the row open');
      // A red report is evidence, not a mistake: the note says so on the way out.
      expect(run.stdout).toContain('a red report is still evidence');
    });
  });

  it('exits 1 with a readable sentence for a file that is not JSON', () => {
    withTempFile('{ not json', (file) => {
      const run = spawnSync(process.execPath, [SCRIPT, '--judge', file], { encoding: 'utf8' });

      expect(run.status).toBe(1);
      expect(run.stderr).toContain('report-unreadable');
      expect(run.stderr).toContain('win-report.json');
    });
  });

  it('exits 1 rather than throwing when the path does not exist', () => {
    const run = spawnSync(process.execPath, [SCRIPT, '--judge', '/nonexistent/win-report.json'], {
      encoding: 'utf8',
    });

    expect(run.status).toBe(1);
    expect(run.stderr).toContain('report-unreadable');
  });

  it('returns the decision as a value too, so nothing has to parse the printout', () => {
    withTempFile(JSON.stringify(greenReport(), null, 2), (file) => {
      const judged = judgeReportCommand(file, { expectedVersion: repoVersion() });

      expect(judged.code).toBe(0);
      expect(judged.result?.ok).toBe(true);
    });
  });
});

describe('the documents point at the command that judges the report', () => {
  it('makes the Windows row state what closes it, by command', () => {
    // The row said "waiting for a report" for several rounds. Prose that names
    // the artefact but not the verdict is what kept it open by default; the row
    // and the reader's command have to name each other.
    const doc = readFileSync(join(REPO_ROOT, 'docs', 'dod-status.md'), 'utf8');
    const row = doc
      .split('\n')
      .find((line) => line.startsWith('| Windows 安装包航运 · NSIS 产出与安装'));

    expect(row, 'the Windows row moved; this gate must move with it').toBeDefined();
    expect(row).toContain('--judge');
    expect(row).toContain('win32');
  });

  it('tells the person carrying the report home how to read it back', () => {
    const doc = readFileSync(join(REPO_ROOT, 'docs', 'manual-verification.md'), 'utf8');
    const section = doc.slice(doc.indexOf('## 如何从 Windows 机器带回证据'));

    expect(section).toContain('--judge');
    expect(section).toContain('win32');
  });
});
