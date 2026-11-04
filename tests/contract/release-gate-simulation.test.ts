/**
 * The release blocker, made watchable on a machine that cannot publish.
 *
 * ## Why this file exists
 *
 * The one thing this repository is blocked on is a published feed with no
 * `sha256`. Three documents describe it — `docs/blockers.md`,
 * `docs/dod-status.md` (DOD-4.2) and the README's limitations list — and all
 * three are accurate. None of them let a reader *see* the refusal: the gate that
 * refuses the release fetches the feed from `github.com`, and the machines this
 * repository is developed on have no route to it and no token to fix it. So the
 * blocker was a paragraph, and a paragraph is taken on trust.
 *
 * `--simulate-missing-sha` prints the refusal offline. The risk in a flag like
 * that is obvious and is the reason this file is mostly about *sameness*: a
 * simulation that drifts from the real refusal is worse than no simulation,
 * because it would be quoted in a review as what the gate says. So the
 * assertions are:
 *
 *  1. the simulated run prints the **same refusal**, line for line, as a run
 *     over the published feed — the findings, their severities, their sentences
 *     and the `REFUSED` verdict line are compared as text, not as codes;
 *  2. the two lines that *do* differ are the two that must: `source:` says the
 *     run was simulated and that nothing was fetched, and `[skipped]` says which
 *     half of a real run this one did not do. A simulation that printed neither
 *     would read as a measurement;
 *  3. it exits 1. A demonstration of a refusal that exits 0 would be a way to
 *     pass the gate by asking it to pretend;
 *  4. the release path does not use it — `npm run dist` runs the gate with no
 *     flags, and the flag list is asserted so a future "just add it to dist"
 *     goes red here.
 *
 * ## What it cannot assert
 *
 * That the published feed still looks like `PUBLISHED_V1_FEED`. The simulation
 * judges a document written down from the 2026-11-04 measurement; if the asset
 * on the release changes, this file keeps proving what the gate would say about
 * *that* document. The live answer is `node scripts/verify-release-feed.mjs`,
 * which needs a route to the host — the same split the rest of the release
 * tooling already has.
 *
 * ## The build dependency, stated rather than hidden
 *
 * The judgement is the app's own (`checkChannelUrl` / `normalizeSha256` from
 * `apps/desktop/dist/main/update-feed.js`), so the simulation needs the main
 * process built. CI runs `npm test` before `npm run build`, so on a clean
 * checkout the command refuses with "run `npm run build:main -w @ucad/desktop`
 * first" — and that refusal is asserted below rather than skipped, because a
 * case that quietly does nothing is the shape this repository keeps finding.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  GATE_VERDICT_LINE,
  PUBLISHED_V1_FEED,
  SIMULATED_SOURCE,
  simulateMissingShaRun,
} from '../../scripts/release-gate.mjs';
import { judgeFeedDocument, loadAppRules } from '../../scripts/verify-release-feed.mjs';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const GATE = join(REPO_ROOT, 'scripts', 'release-gate.mjs');
const APP_RULES_BUILD = join(REPO_ROOT, 'apps', 'desktop', 'dist', 'main', 'update-feed.js');

/** Whether the app's feed rules are built in this checkout. */
const RULES_BUILT = existsSync(APP_RULES_BUILD);

const PACKAGE = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
  version: string;
  scripts: Record<string, string>;
};

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs the gate CLI; never throws on a non-zero exit. */
function runGate(args: string[]): RunResult {
  try {
    const stdout = execFileSync(process.execPath, [GATE, ...args], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '' };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { code: failure.status ?? 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

/** Writes a saved verifier run into a throwaway directory and returns its path. */
function savedRun(envelope: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'ucad-gate-simulation-'));
  tempDirs.push(dir);
  const path = join(dir, 'saved-run.json');
  writeFileSync(path, JSON.stringify(envelope, null, 2), 'utf8');
  return path;
}

/**
 * The run a real gate produces for the published feed, as the verifier measured
 * it on 2026-11-04 and as `tests/contract/release-gate.test.ts` already pins it.
 *
 * Written out here rather than derived from `simulateMissingShaRun()`, because
 * the whole point is to compare the simulation against something that is not the
 * simulation. This is the independent side of the comparison.
 */
function publishedFeedRun() {
  return {
    feedUrl: 'https://github.com/castorhrio/jev-pi-agent/releases/latest/download/update-feed.json',
    feedFile: null,
    expectedVersion: PACKAGE.version,
    findings: [
      { code: 'no-sha256', detail: 'null' },
      { code: 'no-size', detail: 'absent' },
      {
        code: 'installer-latest-url',
        detail:
          'https://github.com/castorhrio/jev-pi-agent/releases/latest/download/UCAD-Setup-1.0.0.exe',
      },
    ],
    notChecked: [],
    incomplete: false,
  };
}

/**
 * The lines of a run that are the refusal itself.
 *
 * Three kinds of line are left out, and each for its own reason: `source:` says
 * where the run came from, `[skipped]` says what this run did not do, and the
 * `verify-release-feed:` summary counts the skipped checks — so all three are
 * *about the run* rather than about the feed. Everything else is the refusal,
 * and it has to be identical.
 */
function refusalLines(stdout: string): string[] {
  return stdout
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .filter(
      (line) =>
        !line.startsWith('source:') &&
        !line.startsWith('[skipped]') &&
        !line.startsWith('verify-release-feed:'),
    );
}

/** The `verify-release-feed:` summary line of a run. */
function summaryOf(stdout: string): string {
  return stdout.split('\n').find((line) => line.startsWith('verify-release-feed:')) ?? '';
}

describe('the simulation prints the refusal the gate really prints', () => {
  it('matches a run over the published feed line for line, apart from its own two labels', () => {
    if (!RULES_BUILT) {
      // A clean checkout has no built main process, and the honest outcome is a
      // refusal that names the build command — never a silent pass.
      const result = runGate(['--simulate-missing-sha']);
      expect(result.code).toBe(1);
      expect(result.stdout).toContain('build:main');
      expect(result.stdout).toContain(GATE_VERDICT_LINE.unverified);
      return;
    }

    const simulated = runGate(['--simulate-missing-sha']);
    const real = runGate(['--from-json', savedRun(publishedFeedRun())]);

    expect(simulated.code).toBe(1);
    expect(real.code).toBe(1);
    // The refusal itself: findings, severities, sentences, verdict line.
    expect(refusalLines(simulated.stdout)).toEqual(refusalLines(real.stdout));
    expect(refusalLines(simulated.stdout)).toContain(GATE_VERDICT_LINE.refused);
    // The summary agrees about the feed and differs only by the check this run
    // did not do — the same sentence, plus the count of what was left out.
    expect(summaryOf(real.stdout)).toBe('verify-release-feed: FAIL — 2 failure(s), 1 warning(s)');
    expect(summaryOf(simulated.stdout)).toBe(
      'verify-release-feed: FAIL — 2 failure(s), 1 warning(s); 1 check(s) did not run',
    );
  });

  it('says it was simulated, and says which half of a real run it did not do', () => {
    if (!RULES_BUILT) return;

    const result = runGate(['--simulate-missing-sha']);

    // The two lines a simulation is allowed to differ on, and both have to say
    // what they are: a run that printed neither would read as a measurement.
    expect(result.stdout).toContain(`source: ${SIMULATED_SOURCE}`);
    expect(SIMULATED_SOURCE).toContain('SIMULATED');
    expect(SIMULATED_SOURCE).toContain('nothing was fetched');
    expect(result.stdout).toContain('[skipped] the installer URL');
    expect(result.stdout).toContain('--simulate-missing-sha never touches the network');
    // And the summary counts the skipped check, so the run cannot read as
    // complete: this is the same rule `verify-release-feed.mjs` applies.
    expect(result.stdout).toContain('1 check(s) did not run');
  });

  it('refuses, rather than passing, when asked to demonstrate a refusal', () => {
    if (!RULES_BUILT) return;

    const result = runGate(['--simulate-missing-sha']);

    // A demonstration that exits 0 would be a way to pass the gate by asking it
    // to pretend — the one thing a gate must not grow.
    expect(result.code).toBe(1);
    expect(result.stdout).not.toContain(GATE_VERDICT_LINE.pass);
  });
});

describe('the simulated run is the app’s own judgement, not a second opinion', () => {
  it('produces exactly the findings the verifier produces for the same document', async () => {
    if (!RULES_BUILT) return;

    const rules = await loadAppRules();
    const run = simulateMissingShaRun({ rules, expectedVersion: PACKAGE.version });
    const direct = judgeFeedDocument(PUBLISHED_V1_FEED, {
      rules,
      expectedVersion: PACKAGE.version,
    });

    expect(run.findings).toEqual(direct);
    // The three the published feed really produces, named so a change in the
    // judgement shows up here as a change rather than as a shorter list.
    expect(run.findings.map((entry) => entry.code)).toEqual([
      'no-sha256',
      'no-size',
      'installer-latest-url',
    ]);
  });

  it('carries no hash or scheme rule of its own', () => {
    // The simulation hands a document to `judgeFeedDocument()`; if it ever grew
    // its own idea of what is wrong, the two would drift and this file would
    // keep passing because it compares the simulation to itself.
    const source = readFileSync(GATE, 'utf8');

    expect(source).toContain('judgeFeedDocument(');
    expect(source, 'the simulation restates the SHA-256 pattern').not.toMatch(/\[0-9a-f\]\{64\}/i);
    expect(source, 'the simulation restates the https rule').not.toMatch(/['"]https:['"]/);
  });
});

describe('the simulation is not a way past the gate', () => {
  it('is not on the release path', () => {
    // `npm run dist` runs the gate with no flags. The flag exists so a person
    // can watch the refusal, not so a build can be told to expect one.
    expect(PACKAGE.scripts['verify:release']).toBe('node scripts/release-gate.mjs');
    expect(PACKAGE.scripts.dist ?? '').not.toContain('--simulate-missing-sha');
    expect(PACKAGE.scripts['verify:release']).not.toContain('--simulate-missing-sha');
  });

  it('refuses to be combined with a saved run, because the two ask different questions', () => {
    const result = runGate([
      '--simulate-missing-sha',
      '--from-json',
      savedRun(publishedFeedRun()),
    ]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('ask different questions');
  });

  it('is named in its own usage, with what it is for', () => {
    const result = runGate(['--help']);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('--simulate-missing-sha');
    expect(result.stdout).toContain('demonstration');
  });
});
