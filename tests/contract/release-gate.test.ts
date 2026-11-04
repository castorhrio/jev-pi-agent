/**
 * The release gate: the sentence "1.1.0 must not ship" as a command.
 *
 * ## Why this file exists
 *
 * The README's limitations list and `docs/dod-status.md` both stated the rule,
 * and both were true, and neither of them could stop a release. The published
 * v1.0.0 feed carries no `sha256`; `scripts/verify-release-feed.mjs` says so in
 * a `[FAIL]` line; and a person could still type `npm run dist` and get an
 * installer to upload. A rule that lives only in prose is a rule that depends on
 * someone remembering it at the exact moment they are busy doing something else.
 *
 * So the judgement moved into `scripts/release-gate.mjs` and the release build
 * runs it (`dist` → `npm run verify:release`), and this file pins three things:
 *
 *  - the **decision**: a document finding refuses, a host that did not answer
 *    *or a check that did not run* refuses too but says so in different words,
 *    and only a run with no failures and nothing skipped passes. The second and
 *    third branches are the whole point — a gate that goes green when it is
 *    blind is worse than no gate, because it is trusted;
 *  - the **wiring**: `npm run dist` runs the gate between the build and
 *    `electron-builder`, the gate as a script takes no option that would let a
 *    saved run stand in for a fresh one, and `npm run package` — the unpacked
 *    build every manual verification in this repo uses — still does not, because
 *    it ships nothing;
 *  - the **one vocabulary** rule: the gate reads the verifier's findings and
 *    severities from `verify-release-feed.mjs` instead of restating them. Two
 *    copies of "is this a failure" would drift, and the drift would be invisible
 *    because each copy would pass the tests written for it.
 *
 * ## What is exercised through the command, and what is honest about it
 *
 * The cases below run the real CLI on saved `verify-release-feed.mjs --json`
 * runs, so the parser is proven against the shape the verifier actually emits
 * rather than against a shape invented here. What is *not* exercised is a green
 * run over the wire: that needs the fixed feed on the release, which is the
 * blocked step itself (`docs/dod-status.md`, the write-token row). The green
 * branch is driven with the envelope a clean run produces — the alternative,
 * skipping it, would leave the gate's only positive outcome unproven, and a
 * gate whose green path is untested is how a gate gets switched off.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  GATE_VERDICT_LINE,
  HOST_FINDINGS,
  KNOWN_FLAGS,
  judgeReleaseGate,
  main,
  parseVerifierOutput,
  VERIFIER,
} from '../../scripts/release-gate.mjs';
import { FEED_FINDINGS, FEED_FINDING_SEVERITY } from '../../scripts/verify-release-feed.mjs';
import { blankComments } from './source-scan';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const GATE = join(REPO_ROOT, 'scripts', 'release-gate.mjs');

const PACKAGE = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
  version: string;
  scripts: Record<string, string>;
};

/** A finding in the shape the verifier prints, for the decision table. */
function finding(code: string, detail = 'detail') {
  return { code, detail };
}

/** One command's outcome, exit code included. */
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
  const dir = mkdtempSync(join(tmpdir(), 'ucad-release-gate-'));
  tempDirs.push(dir);
  const path = join(dir, 'saved-run.json');
  writeFileSync(path, JSON.stringify(envelope, null, 2), 'utf8');
  return path;
}

/** The envelope `verify-release-feed.mjs --json` prints when nothing is wrong. */
function cleanRun() {
  return {
    feedUrl: 'https://github.com/castorhrio/jev-pi-agent/releases/latest/download/update-feed.json',
    feedFile: null,
    expectedVersion: PACKAGE.version,
    findings: [],
    notChecked: [],
    incomplete: false,
  };
}

describe('the gate decision', () => {
  it('passes a run that found nothing and left nothing out', () => {
    expect(judgeReleaseGate([])).toBe('pass');
    // A warning is not a refusal: the app installs a feed without a `size`, it
    // just loses the cheap truncation check. A gate that failed on it would be
    // turned off the first time a release tripped it.
    expect(judgeReleaseGate([finding('no-size')], [])).toBe('pass');
  });

  it('refuses a feed that was read and is wrong', () => {
    expect(judgeReleaseGate([finding('no-sha256')])).toBe('refused');
    expect(judgeReleaseGate([finding('no-sha256'), finding('installer-latest-url')])).toBe(
      'refused',
    );
  });

  it('refuses rather than passing when the host did not answer', () => {
    // The expensive direction: an unreachable host must never read as "fine".
    expect(judgeReleaseGate([finding('feed-unreachable')])).toBe('unverified');
    expect(judgeReleaseGate([finding('feed-timeout')])).toBe('unverified');
    expect(judgeReleaseGate([finding('installer-timeout')])).toBe('unverified');
  });

  it('keeps a proven defect a refusal even when another check timed out', () => {
    // The document was read and it has no hash; the installer HEAD then timed
    // out. Saying "unverified" here would send the reader to retry the fetch
    // instead of to the fix, and the fix is already known.
    expect(judgeReleaseGate([finding('no-sha256'), finding('installer-timeout')])).toBe('refused');
  });

  it('refuses a run that skipped a check, even with nothing failed', () => {
    // `--no-installer` and `--feed-file` both leave something unproven. The
    // verifier prints `[skipped]` and counts it; the gate must not accept a
    // partial run as an authorisation to ship.
    expect(judgeReleaseGate([], ['the installer URL: not fetched'])).toBe('unverified');
  });

  it('treats a finding it does not recognise as blocking', () => {
    // The vocabulary is pinned in `release-feed.test.ts`, but the gate is the
    // one caller where meeting an unknown code must not read as "fine": a new
    // failure code added to the verifier and forgotten here would otherwise be
    // silently waved through.
    expect(judgeReleaseGate([finding('something-new')])).toBe('refused');
  });
});

describe('the three verdicts are three sentences', () => {
  it('has a line for every verdict, and each names its own outcome', () => {
    expect(Object.keys(GATE_VERDICT_LINE).sort()).toEqual(['pass', 'refused', 'unverified']);
    expect(GATE_VERDICT_LINE.pass.startsWith('PASS')).toBe(true);
    expect(GATE_VERDICT_LINE.refused.startsWith('REFUSED')).toBe(true);
    // "unverified" is a refusal, not a third kind of green — the word and the
    // exit code have to agree, or a reader learns the wrong lesson.
    expect(GATE_VERDICT_LINE.unverified.startsWith('REFUSED')).toBe(true);
    expect(GATE_VERDICT_LINE.unverified).toContain('not a pass');
  });

  it('names the fix in the refusal, not just the problem', () => {
    // The reader of a refused release build is mid-release. A line that only
    // says "no" sends them to search `docs/`.
    expect(GATE_VERDICT_LINE.refused).toContain('scripts/publish-feed.mjs');
  });
});

describe('the host-level findings are the vocabulary’s own', () => {
  it('names codes that exist', () => {
    for (const code of HOST_FINDINGS) {
      expect(FEED_FINDINGS, `${code} is not a feed finding`).toContain(code);
    }
  });

  it('leaves no `-unreachable` or `-timeout` code unclassified', () => {
    // Derived rather than listed, so a host-level code added to the verifier
    // later cannot quietly default to "the feed is broken" in the gate — which
    // is the misdiagnosis `verify-release-feed.mjs` spent a round removing.
    const hostCodes = FEED_FINDINGS.filter((code) => /-(unreachable|timeout)$/u.test(code));
    expect([...HOST_FINDINGS].sort()).toEqual([...hostCodes].sort());
  });

  it('agrees with the verifier about which codes are failures', () => {
    // The gate reads severities, it does not own them. If this ever grows a
    // local table, the two callers can disagree about the same release.
    expect(FEED_FINDING_SEVERITY['no-size']).toBe('warn');
    expect(FEED_FINDING_SEVERITY['no-sha256']).toBe('fail');
  });
});

describe('reading the verifier’s own output', () => {
  it('finds the JSON after the two human lines', () => {
    const stdout = [
      'feed: https://example.test/update-feed.json',
      'version: this build is 1.0.0',
      JSON.stringify(cleanRun(), null, 2),
      '',
    ].join('\n');

    const run = parseVerifierOutput(stdout);
    expect(run?.findings).toEqual([]);
    expect(run?.notChecked).toEqual([]);
    expect(run?.expectedVersion).toBe(PACKAGE.version);
  });

  it('returns nothing rather than throwing when there is no envelope', () => {
    // A gate that throws an unhandled error here would be caught by a caller
    // with `||` and read as success; returning `null` makes the caller decide.
    expect(parseVerifierOutput('')).toBeNull();
    expect(parseVerifierOutput('total garbage')).toBeNull();
    expect(parseVerifierOutput('feed: x\n\n{\n  "nothing": true\n}')).toBeNull();
    expect(parseVerifierOutput('feed: x\n\n{ not json')).toBeNull();
  });
});

describe('the gate as a command', () => {
  it('exits 1 for the run that is red today: the published v1.0.0 feed', () => {
    // The exact findings the live check produces, saved. This is the case the
    // gate exists for, and it must not pass on any future refactor.
    const path = savedRun({
      feedUrl: 'https://github.com/castorhrio/jev-pi-agent/releases/latest/download/update-feed.json',
      expectedVersion: PACKAGE.version,
      findings: [
        finding('no-sha256', 'null'),
        finding('no-size', 'absent'),
        finding(
          'installer-latest-url',
          'https://github.com/castorhrio/jev-pi-agent/releases/latest/download/UCAD-Setup-1.0.0.exe',
        ),
      ],
      notChecked: [],
      incomplete: false,
    });

    const result = runGate(['--from-json', path]);

    expect(result.code).toBe(1);
    expect(result.stdout).toContain('[FAIL] no-sha256:');
    expect(result.stdout).toContain('[warn] no-size:');
    expect(result.stdout).toContain('verify-release-feed: FAIL');
    expect(result.stdout).toContain(GATE_VERDICT_LINE.refused);
    // A saved run must say so: otherwise a stale artefact reads as a fresh
    // measurement of the published feed.
    expect(result.stdout).toContain('a saved run, not fetched now');
  });

  it('exits 1 for a run whose host never answered, and says it is not a pass', () => {
    const path = savedRun({
      expectedVersion: PACKAGE.version,
      findings: [finding('feed-timeout', 'no answer within 20000ms — https://example.test/')],
      notChecked: [],
      incomplete: true,
    });

    const result = runGate(['--from-json', path]);

    expect(result.code).toBe(1);
    expect(result.stdout).toContain('INCOMPLETE');
    expect(result.stdout).toContain(GATE_VERDICT_LINE.unverified);
    // The refusal is about the fetch, so it must not send the reader to edit
    // the feed.
    expect(result.stdout).not.toContain('publish-feed.mjs');
  });

  it('exits 0 for a clean run, and prints the counts it decided on', () => {
    const result = runGate(['--from-json', savedRun(cleanRun())]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('PASS — 0 warning(s)');
    expect(result.stdout).toContain(GATE_VERDICT_LINE.pass);
  });

  it('exits 1 for a saved run with something skipped, even with no findings', () => {
    const path = savedRun({
      ...cleanRun(),
      notChecked: ['the installer URL: not fetched (--no-installer)'],
    });

    const result = runGate(['--from-json', path]);

    expect(result.code).toBe(1);
    expect(result.stdout).toContain('[skipped] the installer URL');
    expect(result.stdout).toContain(GATE_VERDICT_LINE.unverified);
  });

  it('refuses an option it does not know instead of ignoring it', () => {
    const result = runGate(['--from-jsn', 'x.json']);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('unknown option');
    expect(result.stderr).toContain('--from-json');
  });

  it('refuses a path that is not a saved run, by name', () => {
    const result = runGate(['--from-json', join(tmpdir(), 'no-such-run.json')]);

    expect(result.code).toBe(1);
    expect(result.stdout).toContain('no saved run at');
    expect(result.stdout).toContain(GATE_VERDICT_LINE.unverified);
  });

  it('prints its usage without judging anything', () => {
    const result = runGate(['--help']);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('release-gate.mjs');
    expect(result.stdout).toContain('--from-json');
  });

  it('reads the verifier’s real envelope, which is the shape the parser was written for', () => {
    // The one case that lets the two commands meet: the verifier writes a
    // `--json` run for a document on disk, and the gate judges that file. A
    // document on disk leaves the address rule out, so the gate refuses it with
    // `unverified` — which is the correct answer, and the reason
    // `verify-release-feed.mjs --feed-file` is *not* what `npm run dist` runs.
    const document = join(REPO_ROOT, 'docs', 'release', 'update-feed-v1.0.0.json');
    let verifierOut: string;
    try {
      verifierOut = execFileSync(
        process.execPath,
        [join(REPO_ROOT, 'scripts', VERIFIER), '--feed-file', document, '--no-installer', '--json'],
        { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      );
    } catch (error) {
      verifierOut = (error as { stdout?: string }).stdout ?? '';
    }

    const path = savedRun(JSON.parse(verifierOut.slice(verifierOut.lastIndexOf('{'))));
    expect(parseVerifierOutput(verifierOut)?.notChecked.length).toBeGreaterThan(0);

    const result = runGate(['--from-json', path]);

    expect(result.code).toBe(1);
    expect(result.stdout).toContain('[skipped] the feed address rule');
    expect(result.stdout).toContain(GATE_VERDICT_LINE.unverified);
  });
});

describe('the gate is wired into the release build', () => {
  const scripts = PACKAGE.scripts;

  it('is the command `npm run dist` runs, by name', () => {
    expect(scripts['verify:release']).toBe('node scripts/release-gate.mjs');
    expect(existsSync(GATE), 'the script the release build names must exist').toBe(true);
  });

  it('runs after the build and before the installer is produced', () => {
    // Order is the assertion. A gate placed after `electron-builder` would let
    // the artefact exist and merely complain afterwards; one placed before
    // `npm run build` would judge with yesterday's `dist/` rules.
    const dist = scripts.dist ?? '';
    const build = dist.indexOf('npm run build');
    const gate = dist.indexOf('npm run verify:release');
    const builder = dist.indexOf('electron-builder');

    expect(build, '`dist` must build first').toBeGreaterThanOrEqual(0);
    expect(gate, '`dist` must run the release gate').toBeGreaterThan(build);
    expect(builder, '`dist` must produce the installer last').toBeGreaterThan(gate);
  });

  it('is not satisfied by a saved run on the release path', () => {
    // `--from-json` exists for a pipeline that judged once and gated on the
    // artefact. On the release path it would let a stale file stand in for the
    // published bytes, which is the defect the gate is here to prevent.
    expect(scripts['verify:release']).not.toContain('--from-json');
    expect(scripts.dist ?? '').not.toContain('--from-json');
  });

  it('does not hold up the unpacked build every manual check uses', () => {
    // `npm run package` ships nothing and is the command the layout gate, the
    // asar check and the main-chain run all depend on. Making it need the
    // release host would turn three offline procedures into network ones.
    expect(scripts.package ?? '').not.toContain('verify:release');
  });

  it('does not run inside the offline gates', () => {
    for (const name of ['test', 'test:e2e', 'build', 'typecheck', 'lint', 'knip']) {
      expect(String(scripts[name] ?? ''), `${name} must stay offline`).not.toContain(
        'verify:release',
      );
    }
  });
});

describe('the gate does not restate the feed’s rules', () => {
  const code = blankComments(readFileSync(GATE, 'utf8'));

  it('reads the findings, severities and printer from the verifier', () => {
    expect(code).toContain("from './verify-release-feed.mjs'");
    expect(code, 'the gate must print the verifier’s own lines').toContain('findingLine(');
    expect(code, 'the gate must read the verifier’s severities').toContain(
      'FEED_FINDING_SEVERITY',
    );
  });

  it('spawns the verifier instead of fetching the feed itself', () => {
    // Two fetchers disagree about redirects and timeouts, and the day they do,
    // the gate and the command a human runs print two verdicts for one release.
    expect(VERIFIER).toBe('verify-release-feed.mjs');
    expect(code, 'the gate must run the verifier').toContain('spawnSync(');
    expect(code, 'the gate must not fetch by itself').not.toContain('fetch(');
  });

  it('carries no second copy of the hash or scheme rule', () => {
    expect(code, 'the gate restates the SHA-256 pattern').not.toMatch(/\[0-9a-f\]\{64\}/i);
    expect(code, 'the gate restates the https rule').not.toMatch(/['"]https:['"]/);
  });

  it('takes no option that would let a document on disk stand in for the published feed', () => {
    // `--feed-file` names a document; this gate's question is about the bytes
    // the release publishes. Keeping the flag list short is the assertion.
    //
    // `--simulate-missing-sha` is on the list and is not an exception to it: it
    // fetches nothing and judges nothing on disk — it prints the refusal for the
    // feed that is already published, and exits 1 doing it
    // (`tests/contract/release-gate-simulation.test.ts` pins both halves). The
    // list is written out rather than counted so that adding a fourth flag is a
    // decision someone makes here, in front of this comment.
    expect(KNOWN_FLAGS).toEqual(['from-json', 'help', 'simulate-missing-sha']);
    expect(code, 'the gate must not grow a feed-file mode').not.toContain('feed-file');
  });
});

describe('importing the gate does not run it', () => {
  it('exposes main() without spawning anything on import', async () => {
    // `--help` through the imported function, with no child process and no
    // network: the guard that makes this file importable is the same one that
    // keeps `npm test` from hitting the release host.
    const originalLog = console.log;
    const lines: string[] = [];
    console.log = (...args: unknown[]) => {
      lines.push(args.join(' '));
    };
    try {
      await expect(main(['--help'])).resolves.toBe(0);
    } finally {
      console.log = originalLog;
    }
    expect(lines.join('\n')).toContain('release-gate.mjs');
  });
});
