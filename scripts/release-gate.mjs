/**
 * The release gate: a broken published feed stops the build that would ship.
 *
 * ## Why this file exists
 *
 * Two documents said the same thing in prose: the README's limitations list and
 * `docs/dod-status.md` both said "1.1.0 must not ship until the feed is fixed".
 * Neither of them could stop anything. The published v1.0.0 feed carries no
 * `sha256`, so every user already on 1.0.0 will read a newer version, download
 * it, and be refused by `verifyInstaller()` with `no-hash` — the update channel
 * goes down for everyone at once, at the moment nobody is looking at the feed.
 * A sentence in a document does not prevent that; it only records that someone
 * knew. The gap between "we wrote it down" and "the build refuses" is the whole
 * point of this file.
 *
 * `scripts/verify-release-feed.mjs` already answers *is the published feed
 * usable?* — with findings, severities, and three verdict words. It is a command
 * someone has to remember to run. This gate is the same judgement wired to a
 * consequence: `npm run dist` runs it before `electron-builder`, so a release
 * built while the update path is broken cannot be produced at all.
 *
 * ## What it decides, and what it refuses to decide
 *
 * Three outcomes, and only one of them is green:
 *
 *  - `pass` — the published feed produced no finding the app would refuse. A
 *    release built now is installable by the people already on the older one.
 *  - `refused` — the feed was read and it is wrong (no hash, a `releases/latest`
 *    URL, a size the host does not serve, …). Building now would publish an
 *    installer nobody can install. The lines printed are the verifier's own
 *    `[FAIL] …` lines, from the same `findingLine()`, so the two commands cannot
 *    describe one defect in two ways.
 *  - `unverified` — the feed was not measured: the host did not answer, the run
 *    left a check out (`notChecked`), or the child could not be parsed. This is
 *    not a verdict on the feed and it is not a pass; the exit code is 1 either
 *    way, because "I could not look" must never read like "I looked and it is
 *    fine". A gate that goes green when it is blind is worse than no gate.
 *
 * The asymmetry is deliberate: `unverified` and `refused` both exit 1, and only
 * the message differs. The alternative — letting an unreachable host pass —
 * would make the gate green exactly on the machines where it learned nothing.
 *
 * ## Why it judges the *published* feed and not a local document
 *
 * The document a release is about to upload lives on disk and can be judged
 * offline: that is `verify-release-feed.mjs --feed-file`, and it is the right
 * command while preparing a release. It is the wrong command here, because it
 * answers a different question. The defect that broke v1.0.0 was published
 * months before anyone noticed, and the feed on the release *is* what users
 * read. So the gate fetches the shipped feed and judges that. If this gate
 * could be satisfied by a local file, it would be satisfiable by the file the
 * writer just produced — which is precisely the file the writer already checked.
 *
 * ## Why it runs the verifier instead of re-implementing the fetch
 *
 * Two fetchers, two timeouts, two policies about redirects — and the day they
 * disagree, the gate and the command that a human runs print different verdicts
 * about the same release. So the gate spawns
 * `verify-release-feed.mjs --json` and reads the `findings` array out of it.
 * That also means the `[skipped]` lines and the `INCOMPLETE` distinction arrive
 * with the data instead of being invented here.
 *
 * ## Usage
 *
 * ```bash
 * npm run verify:release          # what `npm run dist` runs
 * node scripts/release-gate.mjs   # same thing
 * node scripts/release-gate.mjs --from-json saved-run.json
 * ```
 *
 * `--simulate-missing-sha` prints the refusal this gate produces for the feed
 * that is on the release today, without fetching anything — see
 * `simulateMissingShaRun()`. It is a demonstration of the refusal path, not a
 * way to pass it: the run it prints is `refused` and the exit code is 1.
 *
 * `--from-json <path>` judges a saved `verify-release-feed.mjs --json` run
 * instead of fetching. Its stated use is a pipeline that runs the check once and
 * gates on the artefact — and a machine that has the JSON but no route to the
 * release host can still be told what the last measurement said. Its summary
 * line says which of the two happened, so a saved run is never read as a fresh
 * one. `npm run dist` does not use it: `tests/contract/release-gate.test.ts`
 * pins that.
 *
 * Exit code 0 only for `pass`; 1 for `refused` and `unverified`.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  FEED_FINDING_SEVERITY,
  findingLine,
  judgeFeedDocument,
  loadAppRules,
  packageVersion,
  summaryLine,
} from './verify-release-feed.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

/** The command this gate wraps. One fetch implementation, one set of rules. */
export const VERIFIER = 'verify-release-feed.mjs';

/**
 * The findings that mean "this host did not answer", not "this feed is wrong".
 *
 * They are failures — the run proved nothing — but they are a different kind of
 * failure from a document that was read and found wanting. This list is derived
 * from the finding vocabulary by `tests/contract/release-gate.test.ts`
 * (`every code named here exists, and every `-unreachable` / `-timeout` code is
 * named here`), so a new host-level code cannot be added without being
 * classified.
 */
export const HOST_FINDINGS = [
  'feed-unreachable',
  'feed-timeout',
  'installer-unreachable',
  'installer-timeout',
];

/**
 * The gate's decision, as a pure function of one verifier run.
 *
 * Split out from the CLI for the same reason `judgeReport()` and
 * `judgeFeedDocument()` are: the decision is what has to hold, and it must be
 * provable without a network, a release, or a build.
 *
 * The order of the three branches is the part worth reading twice:
 *  1. a finding that is about the *document* wins outright. If the feed is
 *     provably wrong, "the installer was not fetched either" does not soften it
 *     into "unverified" — the reader needs the fix, not a retry;
 *  2. otherwise a failure (host-level), or any check that did not run, means
 *     nothing was proven → `unverified`;
 *  3. only a run with no failures *and* nothing skipped is `pass`.
 *
 * A finding whose severity is not a known `warn` is treated as blocking. The
 * vocabulary is pinned elsewhere (`release-feed.test.ts`), but a gate is the one
 * place where meeting an unknown code must not read as "fine".
 */
export function judgeReleaseGate(findings, notChecked = []) {
  const blocking = findings.filter((entry) => FEED_FINDING_SEVERITY[entry.code] !== 'warn');
  if (blocking.some((entry) => !HOST_FINDINGS.includes(entry.code))) return 'refused';
  if (blocking.length > 0) return 'unverified';
  if (notChecked.length > 0) return 'unverified';
  return 'pass';
}

/**
 * The last line of a gate run.
 *
 * One sentence per verdict, and each one says what the reader should do next —
 * fix the feed, retry the fetch, or ship. The `refused` sentence carries the
 * release rule the README states in prose ("1.1.0 must not ship"), because this
 * line is where the rule is now enforced.
 */
export const GATE_VERDICT_LINE = {
  pass:
    'PASS — the published feed carries what the app needs, so a release built now can be ' +
    'installed through the update path',
  refused:
    'REFUSED — the published feed is one the app refuses to install from, so a release ' +
    'published now would not reach anyone through it: no version may ship until the feed is ' +
    'fixed (node scripts/publish-feed.mjs --dry-run, then --apply --verify)',
  unverified:
    'REFUSED (unverified) — the feed was not measured, so nothing about it was proven; ' +
    'this is not a pass: retry the fetch, or run it where the release host is reachable',
};

/**
 * The envelope `verify-release-feed.mjs --json` prints, taken out of its stdout.
 *
 * The verifier prints two human lines (`feed: …`, `version: …`) before the JSON
 * so a terminal reader still sees what was judged; parsing therefore starts at
 * the last line that is exactly `{`. Returning `null` rather than throwing is
 * the point: "the child printed something this gate cannot read" has to become a
 * refusal in the gate, not an unhandled rejection that a `||` chain might read
 * as success.
 */
export function parseVerifierOutput(stdout) {
  const lines = String(stdout).split('\n');
  const start = lines.lastIndexOf('{');
  if (start === -1) return null;
  try {
    const parsed = JSON.parse(lines.slice(start).join('\n'));
    if (!parsed || !Array.isArray(parsed.findings)) return null;
    return {
      findings: parsed.findings,
      notChecked: Array.isArray(parsed.notChecked) ? parsed.notChecked : [],
      expectedVersion: typeof parsed.expectedVersion === 'string' ? parsed.expectedVersion : null,
      incomplete: parsed.incomplete === true,
    };
  } catch {
    return null;
  }
}

/** A `--json` run saved on disk, in the same envelope the parser expects. */
export function readSavedRun(path) {
  let text;
  try {
    text = readFileSync(resolve(root, path), 'utf8');
  } catch (error) {
    throw new Error(
      `no saved run at ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const run = parseVerifierOutput(text);
  if (run === null) {
    throw new Error(
      `${path} is not a saved \`verify-release-feed.mjs --json\` run: no findings array to judge`,
    );
  }
  return run;
}

/**
 * The feed document the v1.0.0 release publishes, as `verify-release-feed.mjs`
 * measured it on 2026-11-04: a version, notes, and a `releases/latest` URL —
 * no `sha256`, no `size`.
 *
 * It is data, not a rule: the judgement below is `judgeFeedDocument()`, the
 * same function the writer and the verifier use, so this constant cannot drift
 * into a second opinion about what is wrong with the feed. It exists so the
 * refusal can be *seen* on a machine with no token, no route to the release
 * host, and no way to publish anything — which is every machine this repository
 * is developed on.
 */
export const PUBLISHED_V1_FEED = Object.freeze({
  version: '1.0.0',
  notes:
    'First release published on GitHub Releases. Layout order restored; transcript no longer ' +
    'amputates history; handoff chain visible on open; failed reads reported instead of ' +
    'rendered as empty.',
  url: 'https://github.com/castorhrio/jev-pi-agent/releases/latest/download/UCAD-Setup-1.0.0.exe',
});

/**
 * The envelope a real run over the published feed produces, built offline.
 *
 * ## Why this is not a new feature
 *
 * The refusal already exists: `npm run dist` runs this gate, the gate fetches
 * the published feed, and the feed is refused. What did not exist was a way to
 * *watch* that happen without a route to `github.com` — so the one thing this
 * repository is blocked on was described in three documents and demonstrable in
 * none of them. A reader had to take the documents' word for it.
 *
 * So this builds the same envelope the fetch would have produced, by handing the
 * published document to the same `judgeFeedDocument()` the verifier uses, and
 * returns it to the same `report()` printer. Nothing about the decision is
 * restated: the findings, their severities, their sentences and the verdict line
 * are the ones a real run prints. `tests/contract/release-gate-simulation.test.ts`
 * asserts that line for line against a saved run of the published feed.
 *
 * ## What it deliberately leaves out
 *
 * The installer HEAD. A real run also asks the host whether the installer is
 * served at the size the feed claims; this one does not, because it does not
 * touch the network at all. That check cannot change the verdict here — the
 * document findings already refuse — and the simulation says which half it
 * skipped rather than printing a `PASS` that would read as a complete run.
 */
export function simulateMissingShaRun({ rules, expectedVersion }) {
  const findings = judgeFeedDocument(PUBLISHED_V1_FEED, { rules, expectedVersion });
  return {
    findings,
    notChecked: [
      'the installer URL: not fetched (--simulate-missing-sha never touches the network)',
    ],
    expectedVersion,
    incomplete: false,
  };
}

/** The `source:` line a simulated run prints, so it cannot read as a measurement. */
export const SIMULATED_SOURCE =
  'SIMULATED — the v1.0.0 feed as published, judged by the app’s own rules; nothing was fetched';

/** The options this command understands. Anything else is a typo, not a default. */
export const KNOWN_FLAGS = ['from-json', 'help', 'simulate-missing-sha'];

/** `--options` in argv this command does not know, so a typo cannot be ignored. */
export function unknownFlags(argv) {
  const unknown = [];
  for (const token of argv) {
    if (!token || !token.startsWith('--')) continue;
    const name = token.slice(2).split('=')[0];
    if (!KNOWN_FLAGS.includes(name)) unknown.push(token);
  }
  return unknown;
}

/** `--flag value` pairs, matching the sibling scripts so the three read alike. */
export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token || !token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

/**
 * Runs the verifier and returns its envelope, or a refusal to judge.
 *
 * `timeout` is generous compared with the verifier's own per-fetch window
 * (20 s) because a slow release host makes two requests (feed + installer); the
 * child's timeout is the last resort against a wedged shell, not the policy.
 */
function runVerifier() {
  const child = spawnSync(process.execPath, [join(here, VERIFIER), '--json'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 180_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (child.error) {
    return { run: null, why: `could not run ${VERIFIER}: ${child.error.message}` };
  }
  const run = parseVerifierOutput(child.stdout ?? '');
  if (run === null) {
    const stderr = (child.stderr ?? '').trim();
    const stdout = (child.stdout ?? '').trim();
    return {
      run: null,
      why:
        `${VERIFIER} printed no findings this gate can read` +
        (stderr === '' ? '' : `: ${stderr.split('\n').slice(-3).join(' ')}`) +
        (stdout === '' ? '' : ` (stdout: ${stdout.split('\n').slice(-3).join(' ')})`),
    };
  }
  return { run, why: null };
}

/** Prints one run and returns the exit code. The single printer, as elsewhere. */
function report({ run, source }) {
  const version = run.expectedVersion ?? packageVersion();

  console.log(`source: ${source}`);
  console.log(`version: this build is ${version}`);
  for (const entry of run.findings) {
    console.log(findingLine(entry));
  }
  for (const entry of run.notChecked) {
    console.log(`[skipped] ${entry}`);
  }
  // The verifier's summary is printed with its own name on it. The gate's
  // decision is not the same question — it also weighs `notChecked` — so two
  // unlabelled verdict lines could read as a contradiction. Labelled, the only
  // thing a reader can conclude from their differing is the true one: the
  // verifier had a verdict, and the gate would not accept it.
  console.log(`verify-release-feed: ${summaryLine(run.findings, run.notChecked)}`);

  const verdict = judgeReleaseGate(run.findings, run.notChecked);
  console.log(GATE_VERDICT_LINE[verdict]);
  return verdict === 'pass' ? 0 : 1;
}

/** Refuses to judge, with a reason a reader can act on, and exits 1. */
function refuseUnreadable(why) {
  console.log(`[FAIL] release-gate: ${why}`);
  console.log(GATE_VERDICT_LINE.unverified);
  return 1;
}

export function usage() {
  return [
    'usage: node scripts/release-gate.mjs [--from-json <path>] [--simulate-missing-sha]',
    '',
    'Judges the *published* feed and refuses a release build while it is wrong.',
    'Runs `scripts/verify-release-feed.mjs --json` unless --from-json names a saved run.',
    'Exit 0 only when the run has no failures and nothing was skipped.',
    '',
    '--simulate-missing-sha prints the refusal for the feed on the release today,',
    'offline, so the blocked step can be seen on a machine that cannot publish. It',
    'is a demonstration: the verdict is `refused` and the exit code is 1.',
  ].join('\n');
}

export async function main(argv) {
  const unknown = unknownFlags(argv);
  if (unknown.length > 0) {
    throw new Error(
      `unknown option(s): ${unknown.join(', ')}\n` +
        `known options: ${KNOWN_FLAGS.map((name) => `--${name}`).join(', ')}`,
    );
  }

  const args = parseArgs(argv);
  if (args.help === true) {
    console.log(usage());
    return 0;
  }

  const simulate = args['simulate-missing-sha'] === true;
  const saved = typeof args['from-json'] === 'string' ? args['from-json'] : null;
  if (simulate && saved !== null) {
    throw new Error(
      '--simulate-missing-sha and --from-json ask different questions: one prints the refusal ' +
        'for the published feed, the other judges a saved run. Pass one of them.',
    );
  }
  if (simulate) {
    let rules;
    try {
      rules = await loadAppRules();
    } catch (error) {
      return refuseUnreadable(error instanceof Error ? error.message : String(error));
    }
    return report({
      run: simulateMissingShaRun({ rules, expectedVersion: packageVersion() }),
      source: SIMULATED_SOURCE,
    });
  }

  if (saved !== null) {
    let run;
    try {
      run = readSavedRun(saved);
    } catch (error) {
      return refuseUnreadable(error instanceof Error ? error.message : String(error));
    }
    return report({
      run,
      source: `${resolve(root, saved)} (a saved run, not fetched now)`,
    });
  }

  const { run, why } = runVerifier();
  if (run === null) return refuseUnreadable(why);
  return report({ run, source: 'the published feed, fetched by verify-release-feed.mjs' });
}

// Only run as a command; importing the decision must not spawn anything.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(`[FAIL] ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
}
