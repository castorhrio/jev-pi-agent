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
 * ## The build dependency, built rather than branched on
 *
 * The judgement is the app's own (`checkChannelUrl` / `normalizeSha256` from
 * `apps/desktop/dist/main/update-feed.js`), so the simulation needs the main
 * process built. It used to ask whether that build happened to be on disk and,
 * when it was not, three of the cases below returned before their first
 * assertion — a green that proved nothing, which is the shape this repository
 * has now removed from `verify-main-chain.mjs`'s `--steps`, from the `skipIf`
 * guards in `readme*.test.ts`, and from the screenshot manifest's failure path.
 *
 * `tests/global-setup.ts` builds the rules once before any test file loads
 * (`tests/contract/app-rules-build.ts` explains why that is one owner rather
 * than four `beforeAll` hooks), so every case below runs every time, and the
 * strictest tier of the `docs/blockers.md` comparison is no longer conditional.
 * What a missing build costs now is a red run that names
 * `npm run build:main -w @ucad/desktop`.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  GATE_VERDICT_LINE,
  PUBLISHED_V1_FEED,
  SIMULATED_SOURCE,
  simulateMissingShaRun,
} from '../../scripts/release-gate.mjs';
import { findingLine, judgeFeedDocument, loadAppRules } from '../../scripts/verify-release-feed.mjs';

import { appRulesMissing } from './app-rules-build';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const GATE = join(REPO_ROOT, 'scripts', 'release-gate.mjs');

/**
 * The app's rules are a requirement of this file, not a question it asks.
 *
 * `tests/global-setup.ts` builds them before any test file loads; this is the
 * check that the build is actually there, so a run configured some other way
 * fails here with the command to type instead of working through the cases
 * below one assertion at a time. Nothing in this file may proceed without it:
 * the gate's own refusal would then satisfy `expect(code).toBe(1)` for a reason
 * that has nothing to do with the feed.
 */
beforeAll(() => {
  const missing = appRulesMissing();
  if (missing !== null) throw new Error(missing);
});

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
    const result = runGate(['--simulate-missing-sha']);

    // A demonstration that exits 0 would be a way to pass the gate by asking it
    // to pretend — the one thing a gate must not grow. The `beforeAll` above is
    // what makes this exit code mean the feed: unbuilt rules make the gate exit
    // 1 for a reason that has nothing to do with it.
    expect(result.code).toBe(1);
    expect(result.stdout).not.toContain(GATE_VERDICT_LINE.pass);
  });
});

describe('the simulated run is the app’s own judgement, not a second opinion', () => {
  it('produces exactly the findings the verifier produces for the same document', async () => {
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

/**
 * `docs/blockers.md` shows the refusal instead of describing it.
 *
 * The page has two halves for the one blocker: the half for someone who holds a
 * `contents: write` token, and the half for someone who does not. The second is
 * worth less than a paragraph unless the reader can *see* the thing being
 * blocked, so the page now pastes the output of
 * `node scripts/release-gate.mjs --simulate-missing-sha` and calls it a
 * demonstration. Pasted output is exactly the kind of text that rots — the
 * sentences belong to the gate, and a reworded refusal leaves the page quoting
 * a run nobody will ever get. `handoff-packs.test.ts` closed that for the two
 * packs; this closes it for the page in front of them.
 *
 * Two comparisons, both of which run on every machine:
 *
 *  - every quoted `[FAIL]` / `[warn]` line is compared with `findingLine()`, the
 *    gate's own printer, fed the codes and details recorded in
 *    `publishedFeedRun()` above. It needs no network, and it names one code per
 *    problem, which is the sentence a reader needs when exactly one moved;
 *  - the whole block is compared with the live command's stdout, line for line,
 *    so the `version:` line, the `[skipped]` line and the summary cannot be
 *    edited, dropped or reordered either. This is the half that used to be
 *    conditional on a build being on disk, and on the machines where it was not,
 *    the page could have pasted any text at all.
 */
const BLOCKERS_PATH = 'docs/blockers.md';

/** The heading that introduces the no-token half of the feed blocker. */
const OFFLINE_HEADING = '### 没有令牌的人：同一次拒绝，离线也看得见';

/** The command the page tells that reader to run. */
const OFFLINE_COMMAND = 'node scripts/release-gate.mjs --simulate-missing-sha';

/**
 * The offline half: from 「没有令牌的人」 to the next numbered section.
 *
 * Its claims live here and only here. A whole-page containment would let the
 * same string satisfy the check from somewhere else — the re-check prose of
 * section 2 also says 「退出码 1」, about an entirely different command — so
 * both prose checks below read this slice rather than the page.
 */
function offlineSection(markdown: string): string | null {
  const start = markdown.indexOf(OFFLINE_HEADING);
  if (start === -1) return null;
  const rest = markdown.slice(start + OFFLINE_HEADING.length);
  const nextSection = rest.indexOf('\n## ');
  return nextSection === -1 ? rest : rest.slice(0, nextSection);
}

/** The fenced `text` block under the no-token heading, as its lines. */
function quotedOfflineBlock(markdown: string): string[] | null {
  const section = offlineSection(markdown);
  if (section === null) return null;
  const open = section.indexOf('```text\n');
  if (open === -1) return null;
  const body = section.slice(open + '```text\n'.length);
  const close = body.indexOf('\n```');
  if (close === -1) return null;
  return body.slice(0, close).split('\n');
}

/**
 * Every way the page can stop showing the refusal it claims to show.
 *
 * `live` is the command's own stdout. The mutation cases below pass `null` to
 * hold that comparison back and prove the first one reports exactly one problem
 * on its own; the real call site always has the output, because the suite's
 * global setup built the rules it takes to produce it.
 */
function blockersPageProblems(markdown: string, quoted: string[] | null, live: string | null): string[] {
  const problems: string[] = [];

  if (quoted === null) {
    return [
      `${BLOCKERS_PATH}: no longer quotes the offline run under "${OFFLINE_HEADING}", so the ` +
        'reader without a token is back to taking the refusal on trust',
    ];
  }
  if (!markdown.includes(OFFLINE_COMMAND)) {
    problems.push(`${BLOCKERS_PATH}: the offline half no longer names \`${OFFLINE_COMMAND}\``);
  }

  // Tier one: every finding sentence is the one the gate prints, looked up from
  // the script's own printer rather than copied into this file.
  for (const entry of publishedFeedRun().findings) {
    const line = findingLine(entry);
    if (!quoted.includes(line)) {
      problems.push(
        `${BLOCKERS_PATH}: quotes a different sentence for \`${entry.code}\`. The gate prints:\n` +
          `  ${line}\n  and the page shows something else — re-run the command and paste it.`,
      );
    }
  }

  for (const line of [`source: ${SIMULATED_SOURCE}`, GATE_VERDICT_LINE.refused]) {
    if (!quoted.includes(line)) {
      problems.push(`${BLOCKERS_PATH}: does not quote \`${line}\`, which the command prints`);
    }
  }

  // The two sentences that stop the paste being read as a fix. Both are read
  // out of the offline half, not the whole page: another section's re-check
  // prose says 「退出码 1」 about its own command, and a claim about this half
  // satisfied by a different section's sentence is a claim nothing holds.
  const offline = offlineSection(markdown);
  if (offline === null || !offline.includes('退出码 1')) {
    problems.push(
      `${BLOCKERS_PATH}: the offline half does not say the command exits 1, so the refusal ` +
        'reads like a demo that can be ignored',
    );
  }
  if (offline === null || !offline.includes('不是真替换')) {
    problems.push(
      `${BLOCKERS_PATH}: the offline half does not say it demonstrates rather than replaces, ` +
        'so a reader could conclude the published feed has been fixed',
    );
  }

  // Tier two: on a machine that can run the judgement, the block is the output.
  if (live !== null) {
    const printed = live.split('\n').filter((line) => line.trim().length > 0);
    if (quoted.join('\n') !== printed.join('\n')) {
      problems.push(
        `${BLOCKERS_PATH}: the pasted block is not what \`${OFFLINE_COMMAND}\` prints today:\n` +
          printed
            .map((line, index) => (quoted[index] === line ? null : `  line ${index + 1}: ${line}`))
            .filter((entry) => entry !== null)
            .join('\n'),
      );
    }
  }

  return problems;
}

describe('the blockers page shows the refusal instead of describing it', () => {
  it('quotes the sentences the gate prints, and says it is only a demonstration', () => {
    const markdown = readFileSync(join(REPO_ROOT, BLOCKERS_PATH), 'utf8');
    const live = runGate(['--simulate-missing-sha']).stdout;
    const problems = blockersPageProblems(markdown, quotedOfflineBlock(markdown), live);

    expect(problems, problems.join('\n')).toEqual([]);
  });

  it('is not vacuous: the block really carries the lines being compared', () => {
    const markdown = readFileSync(join(REPO_ROOT, BLOCKERS_PATH), 'utf8');
    const quoted = quotedOfflineBlock(markdown);

    expect(quoted, `${OFFLINE_HEADING} has no fenced text block`).not.toBeNull();
    expect(quoted!.length, 'a paste this short is not the refusal').toBeGreaterThanOrEqual(6);
    expect(quoted).toContain(`source: ${SIMULATED_SOURCE}`);
  });

  it('reports a quoted sentence the gate reworded', () => {
    // The failure this exists for: the refusal is edited in the script, and the
    // page keeps promising a sentence nobody will see.
    const markdown = readFileSync(join(REPO_ROOT, BLOCKERS_PATH), 'utf8');
    const reworded = markdown.replace(
      '[FAIL] no-sha256: the feed publishes no sha256,',
      '[FAIL] no-sha256: the feed is missing its hash,',
    );
    expect(reworded).not.toBe(markdown);

    const problems = blockersPageProblems(reworded, quotedOfflineBlock(reworded), null);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('no-sha256');
  });

  it('reports the paste being deleted, or the exit code being softened', () => {
    const markdown = readFileSync(join(REPO_ROOT, BLOCKERS_PATH), 'utf8');

    const fenceGone = blockersPageProblems(
      markdown.replace('```text\n', '```json\n'),
      quotedOfflineBlock(markdown.replace('```text\n', '```json\n')),
      null,
    );
    expect(fenceGone).toHaveLength(1);
    expect(fenceGone[0]).toContain('no longer quotes the offline run');

    const softened = blockersPageProblems(
      markdown.replace('**退出码 1**', '**退出码 0**'),
      quotedOfflineBlock(markdown),
      null,
    );
    expect(softened).toHaveLength(1);
    expect(softened[0]).toContain('exits 1');
  });
});
