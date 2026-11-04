/**
 * Replaces the `update-feed.json` asset on a release — the step that is still
 * missing from v1.0.0.
 *
 * ## Why this file exists
 *
 * The published v1.0.0 feed carries no `sha256` and points its installer URL at
 * `releases/latest`. The app refuses to install from it, so the defect is safe
 * but real, and it is the only red row left in `docs/dod-status.md`. The
 * corrected document has existed for a while: `docs/release/update-feed-v1.0.0.json`
 * is judged clean by `verify-release-feed.mjs` — the same judgement the app's
 * own rules produce — and it is committed so that replacing the asset needs no
 * regeneration and no 120 MB download.
 *
 * What is missing is the *upload*. Every previous round ended at the same
 * sentence: this machine has no GitHub write token and `gh` is not installed.
 * That is true, and it is not a reason for the next person to invent a
 * procedure: a hand-run `curl` against the assets API, typed once, in a
 * terminal, is how two other mistakes in this release were made — the feed
 * written by one command and judged by another, days later, on another machine.
 *
 * So the upload is a command, and it runs the judgement first:
 *
 *  1. judge the document with the app's own rules (offline, no token needed);
 *  2. only then look for a token — and say which variable it wants, instead of
 *     failing with a bare 401 from the API;
 *  3. with `--apply`, read the release, compare the feed's `sha256` and `size`
 *     with the digest the *host* publishes for the installer asset (this is the
 *     comparison `verify-release-feed.mjs` deliberately does not make: it never
 *     downloads the file, and one CLI cannot prove a 120 MB digest by HEAD);
 *  4. replace the asset, then (with `--verify`) re-run the published-bytes
 *     verifier, so "it is fixed" is one command's output rather than a claim.
 *
 * ## Dry run is the default
 *
 * This command deletes a release asset. A flag that turns a dry run into a real
 * one is the difference between reading the plan and running it, so `--apply`
 * is explicit and everything before it is read-only. Without `--apply` nothing
 * is fetched and nothing is uploaded — that is asserted, not promised.
 *
 * ## What it will not do
 *
 * It does not create releases, does not touch the installer, and does not
 * upload a document that the app would refuse: judgement runs before the token
 * is even looked for, so a bad file cannot be published by someone who happens
 * to have credentials. It also never prints the token; the token appears only
 * in an `Authorization` header.
 *
 * ## `--preflight`: the one question a token-holder asks first
 *
 * `--dry-run` answers "what would this upload, and where". It cannot answer the
 * question the person holding the token actually has: *is the published feed
 * still the broken one?* — because it never reads the published feed. So the
 * step before `--apply` used to be a human comparing two documents by eye, and
 * "the asset is still missing its sha256" was a claim in a document rather than
 * something the command had looked at.
 *
 * `--preflight` reads the published document once (one anonymous `GET`, no
 * token needed on a public repository), judges it with **the same
 * `judgeFeedDocument()` call and the same expected version** that `--apply`
 * uses on the document it is about to upload, and prints the two judgements
 * side by side: what is wrong now, what would be wrong after the upload, which
 * findings the upload fixes, which fields change, and which URL is overwritten.
 * It writes nothing — no asset, no file, no log — and that is asserted rather
 * than promised.
 *
 * Its exit code is the answer to that one question, and the verdict line says
 * so out loud so nobody has to remember which way round it is:
 *
 *  - `0` — the published feed is still the broken one, so the plan below is
 *    current and `--apply --verify` is the next command;
 *  - `1` — it is not (already corrected, or the host did not answer), so there
 *    is nothing to replace and running `--apply` would be a change nobody
 *    needed.
 *
 * ## Usage
 *
 * ```bash
 * node scripts/publish-feed.mjs --preflight          # read the published feed, judge both, write nothing
 * node scripts/publish-feed.mjs --dry-run            # print the plan, touch nothing
 * GITHUB_TOKEN=… node scripts/publish-feed.mjs --apply --verify
 * ```
 *
 * `--dry-run` names the default out loud: a reader who has never run this
 * command should not have to infer "does no arguments mean upload?" from a
 * doc comment, and a CI or release script should not have to remember that the
 * safe mode is the silent one. It is also the only flag that says what the run
 * will *check* — the app's own feed rules (which have already run by the time
 * the plan is printed), the host's digest for the installer, and, after a real
 * upload, the published bytes. `--dry-run` with `--apply` asks for two opposite
 * things and is refused rather than resolved by argument order.
 *
 * `--feed-file <path>` chooses another document. Exit codes: 0 when the run did
 * what it said (a dry run always exits 0), 1 when the document was refused, the
 * token is missing, the host disagreed about the installer, or the API refused.
 * `--preflight` is the one exception, and it is deliberate: its exit code is the
 * answer to "is the published feed still broken?", so 0 means *yes* — see the
 * section above.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  findingLine,
  hasFailure,
  judgeFeedDocument,
  loadAppRules,
} from './verify-release-feed.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The corrected v1.0.0 document, committed and already judged clean. */
export const DEFAULT_FEED_FILE = 'docs/release/update-feed-v1.0.0.json';

/** The asset name the app reads: `update-feed.json` inside the release. */
export const ASSET_NAME = 'update-feed.json';

/** The host the release lives on, and the two endpoints this command uses. */
export const API_BASE = 'https://api.github.com';
export const UPLOAD_BASE = 'https://uploads.github.com';

/**
 * The variables a write token is read from, in the order they are tried.
 *
 * Named here rather than read inline so the refusal can tell the reader which
 * variable to set — "no token" without a name is a message that costs the
 * reader a search through the API's documentation.
 */
export const TOKEN_VARS = ['GITHUB_TOKEN', 'GH_TOKEN'];

/** The options this command understands. Anything else is a typo, not a default. */
export const KNOWN_FLAGS = ['feed-file', 'preflight', 'dry-run', 'apply', 'verify'];

/** Reads `--flag value` pairs out of argv, the way its two sibling scripts do. */
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

/** The `--options` in argv this command does not know. */
export function unknownFlags(argv) {
  const unknown = [];
  for (const token of argv) {
    if (!token || !token.startsWith('--')) continue;
    const name = token.slice(2).split('=')[0];
    if (!KNOWN_FLAGS.includes(name)) unknown.push(token);
  }
  return unknown;
}

/**
 * The release tag a feed document belongs to, from the installer URL it names.
 *
 * `releases/download/v1.0.0/<file>` names a release; `releases/latest/download/<file>`
 * names whatever is newest, which is the trap the corrected document exists to
 * leave. The tag is also what this command needs to address the right release,
 * so an unpinned URL is refused here rather than after an upload has landed on
 * the wrong one. Off a host that is not a release page at all, returns null.
 */
export function releaseTagFromFeedUrl(url) {
  if (typeof url !== 'string') return null;
  const match = /\/releases\/download\/([^/]+)\/[^/]+$/.exec(url.trim());
  if (match === null) return null;
  const tag = match[1];
  if (tag === undefined || tag === 'latest') return null;
  return tag;
}

/**
 * `owner/repo`, from the same URL.
 *
 * Derived rather than declared: the document already says which repository it
 * is published from, and a second copy of that fact is a second thing to keep
 * true. Returns null when the URL has no owner/repo path.
 */
export function repoSlugFromFeedUrl(url) {
  if (typeof url !== 'string') return null;
  const match = /^https?:\/\/[^/]+\/([^/]+)\/([^/]+)\/releases\//.exec(url.trim());
  if (match === null) return null;
  const [, owner, repo] = match;
  if (!owner || !repo) return null;
  return `${owner}/${repo}`;
}

/** The installer file name the feed's URL ends with, or null. */
export function installerNameFromFeedUrl(url) {
  if (typeof url !== 'string') return null;
  const name = url.trim().split('/').pop();
  return name && name.length > 0 ? name : null;
}

/**
 * The token this run would use, and which variable it came from.
 *
 * The value is returned so the request can carry it; nothing in this module
 * ever puts it in a message. An empty string counts as absent — an exported-but-
 * blank `GITHUB_TOKEN` is a variable someone set and did not fill in, not a
 * credential.
 */
export function tokenFromEnv(env) {
  for (const name of TOKEN_VARS) {
    const value = env?.[name];
    if (typeof value === 'string' && value.trim().length > 0) {
      return { name, value: value.trim() };
    }
  }
  return null;
}

/**
 * What the host says the installer asset is, against what the feed claims.
 *
 * The one comparison `verify-release-feed.mjs` cannot make: it never downloads
 * the file, so it can check that the `sha256` is *shaped* like a digest and
 * nothing more. The release JSON carries the host's own `digest` for every
 * asset, which makes "the hash in the feed is the hash of the uploaded file" a
 * comparison instead of a promise. Missing on either side is `skipped` — said
 * out loud, because a check that did not run must not look like a check that
 * passed — and a disagreement is a refusal, before anything is deleted.
 */
export function judgeInstallerAsset({ document, asset }) {
  const problems = [];
  const skipped = [];
  const claimed = typeof document?.sha256 === 'string' ? document.sha256.toLowerCase() : '';
  const claimedSize = typeof document?.size === 'number' ? document.size : null;

  if (asset === null || asset === undefined) {
    skipped.push('the release has no asset with the installer name the feed points at');
    return { problems, skipped };
  }
  const digest = typeof asset.digest === 'string' ? asset.digest.trim() : '';
  if (digest.length === 0) {
    skipped.push('the host published no digest for the installer, so the feed’s sha256 was not compared');
  } else if (claimed.length > 0) {
    const normalised = digest.toLowerCase().startsWith('sha256:') ? digest.slice(7) : digest;
    if (normalised.toLowerCase() !== claimed) {
      problems.push(
        `the feed says sha256=${claimed}, and the host says the installer is sha256=${normalised.toLowerCase()}`,
      );
    }
  }
  if (claimedSize !== null && typeof asset.size === 'number' && asset.size !== claimedSize) {
    problems.push(`the feed says size=${claimedSize}, and the host says the installer is ${asset.size} bytes`);
  }
  return { problems, skipped };
}

/** The asset in a release's `assets` array with this name, or null. */
export function findAsset(release, name) {
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  return assets.find((asset) => asset?.name === name) ?? null;
}

/**
 * The plan, as the lines a dry run prints. Pure, so it can be asserted.
 *
 * The three `check` lines are the reason a dry run exists: "will upload these
 * bytes to this URL" is a plan, and a plan that does not say which judgement
 * decides whether the upload counted sends the reader to another document to
 * find out. They are named in the order they run, and the last one says it
 * waits for a real upload — a check that will not run must not look like one
 * that will.
 */
export function planLines({ feedFile, document, tag, repo, token, bytes = null, verify = false, apply = false }) {
  const installer = installerNameFromFeedUrl(document?.url) ?? '(none)';
  return [
    `feed: ${feedFile}${bytes === null ? '' : ` (${bytes} bytes)`}`,
    `version: ${document?.version ?? '(none)'}`,
    `installer: ${installer} (${document?.sha256 ?? 'no sha256'}, ${document?.size ?? 'no size'} bytes)`,
    `target: ${ASSET_NAME} on ${repo} ${tag}`,
    `[plan] check 1 (already ran, before any token was read): the app’s own feed rules — ${feedFile} produced no failure`,
    `[plan] check 2: the host’s digest for ${installer} equals the feed’s sha256/size, before anything is deleted`,
    verify
      ? `[plan] check 3: node scripts/verify-release-feed.mjs on the published bytes${apply ? ' (--verify, after the upload)' : ' — waits for a real upload, so this run only plans it'}`
      : '[plan] check 3 is not requested: add --verify to judge the published bytes after uploading',
    `[plan] GET ${API_BASE}/repos/${repo}/releases/tags/${tag}`,
    `[plan] compare the feed’s sha256/size with the host’s digest for ${installer}`,
    `[plan] DELETE ${API_BASE}/repos/${repo}/releases/assets/<existing ${ASSET_NAME} id> (if present)`,
    `[plan] POST ${UPLOAD_BASE}/repos/${repo}/releases/<release id>/assets?name=${ASSET_NAME}`,
    token === null
      ? `[plan] token: none — --apply needs ${TOKEN_VARS.join(' or ')}`
      : `[plan] token: from ${token.name} (never printed)`,
  ];
}

/**
 * The URL the published feed asset is served from — the one `--apply` replaces.
 *
 * Derived from the same two facts the upload addresses (`repo`, `tag`), so the
 * address `--preflight` reads and the asset `--apply` overwrites cannot drift
 * apart: they are one expression.
 */
export function publishedFeedUrl(repo, tag) {
  return `https://github.com/${repo}/releases/download/${tag}/${ASSET_NAME}`;
}

/**
 * What the upload changes about the judgement, as three lists of finding codes.
 *
 * `fixed` is the point of the whole command — the findings that are on the
 * published document and not on the one about to replace it. `remaining` is the
 * honest half: a finding both documents share is not fixed by uploading, and a
 * preflight that only printed `fixed` would let a reader believe the upload
 * closes everything. `introduced` is the direction nobody expects and the one
 * worth printing anyway: a document that brings a finding the published one did
 * not have is a change that makes the feed worse, and it should be visible
 * before the upload rather than after it.
 */
export function diffFindings(before, after) {
  const beforeCodes = new Set(before.map((entry) => entry.code));
  const afterCodes = new Set(after.map((entry) => entry.code));
  return {
    fixed: [...beforeCodes].filter((code) => !afterCodes.has(code)),
    remaining: [...afterCodes].filter((code) => beforeCodes.has(code)),
    introduced: [...afterCodes].filter((code) => !beforeCodes.has(code)),
  };
}

/** The fields a feed document carries, in the order a reader reads them. */
const FIELD_ORDER = ['version', 'url', 'sha256', 'size', 'notes'];

/**
 * One field's value, as it prints.
 *
 * Only `notes` is shortened. Every other field is a value the reader has to be
 * able to compare byte for byte — the whole point of the `url` line is that
 * `releases/latest` becomes `releases/download/v1.0.0`, and a truncated URL
 * would hide exactly the part that changed. `notes` is free text, so it is the
 * one field where a long value would push the rest of the report off the screen.
 */
function fieldValue(key, value) {
  if (value === undefined) return '(absent)';
  if (typeof value !== 'string') return JSON.stringify(value);
  if (key === 'notes' && value.length > 72) return `${value.slice(0, 69)}…`;
  return value;
}

/**
 * The fields that change, as `before → after` lines.
 *
 * The judgement diff says *which rules* the upload satisfies; this says *which
 * bytes* change, which is what a reader checking the plan against the release
 * page needs. A field that is the same on both sides is printed as `(unchanged)`
 * rather than omitted: "the upload does not touch `version`" is a fact worth
 * reading, and an omitted line reads as "not checked".
 */
export function fieldDiffLines(before, after) {
  const keys = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])];
  const ordered = [
    ...FIELD_ORDER.filter((key) => keys.includes(key)),
    ...keys.filter((key) => !FIELD_ORDER.includes(key)),
  ];
  return ordered.map((key) => {
    const from = before?.[key];
    const to = after?.[key];
    if (JSON.stringify(from) === JSON.stringify(to)) {
      return `[preflight] field ${key}: ${fieldValue(key, to)} (unchanged)`;
    }
    return `[preflight] field ${key}: ${fieldValue(key, from)} → ${fieldValue(key, to)}`;
  });
}

/**
 * The two verdicts, as the sentences that print them.
 *
 * The exit code is the answer to one question — *is the published feed still
 * the broken one?* — and a code with no sentence next to it is a code the
 * reader has to look up. Both lines say which way round it is, so the answer
 * survives being copied into a terminal transcript.
 */
export const PREFLIGHT_VERDICT = {
  broken:
    '[preflight] verdict: the published feed is still the broken one — exit 0 means "still broken, run --apply --verify"',
  fixed:
    '[preflight] verdict: the published feed is already the corrected one — exit 1 means "nothing to replace"',
};

/**
 * The preflight report, as the lines it prints. Pure, so it can be asserted.
 *
 * Both judgements are printed in full, with the same `findingLine()` the
 * `--apply` path uses: a preflight that summarised them ("2 problems") would be
 * a second, lossier printer of the same facts, and the reader comparing this
 * output with `verify-release-feed.mjs` would have to trust that the summary
 * meant the same thing.
 */
export function preflightLines({ feedFile, publishedUrl, before, after, diff, fields }) {
  const list = (codes) => (codes.length === 0 ? '(none)' : codes.join(', '));
  return [
    `[preflight] before: ${before.length} finding(s) on the published document`,
    ...before.map((entry) => findingLine(entry)),
    `[preflight] after: ${after.length} finding(s) on ${feedFile}`,
    ...after.map((entry) => findingLine(entry)),
    `[preflight] fixed by this upload: ${list(diff.fixed)}`,
    `[preflight] still there after the upload: ${list(diff.remaining)}`,
    `[preflight] introduced by this upload: ${list(diff.introduced)}`,
    ...fields,
    `[preflight] overwrites: ${publishedUrl}`,
    '[preflight] writes: none — this run only read the published document',
  ];
}

/**
 * Reads the published feed, judges it, and compares it with the document that
 * would replace it. One `GET`, no writes, no token required.
 *
 * The token is used when it is there (a private repository's asset is not
 * anonymous) and never printed; without one the request is anonymous, which is
 * enough for the repository this command ships with. A host that does not
 * answer is not a verdict: the run says nothing was compared and exits 1,
 * because "the feed is fine" and "the feed was never read" must not look alike.
 */
export async function runPreflight({
  feedFile,
  document,
  after,
  expectedVersion,
  tag,
  repo,
  token,
  rules,
  fetchImpl,
  out,
  err,
}) {
  const publishedUrl = publishedFeedUrl(repo, tag);
  out(`[preflight] target: ${ASSET_NAME} on ${repo} ${tag}`);
  out(
    `[preflight] GET ${publishedUrl} (read-only${token === null ? ', anonymous' : `, with ${token.name}`})`,
  );

  let response;
  try {
    response = await fetchImpl(publishedUrl, {
      redirect: 'follow',
      headers: token === null ? {} : { authorization: `Bearer ${token.value}` },
    });
  } catch (error) {
    err(
      `[preflight] unreachable: GET ${publishedUrl} failed (${error instanceof Error ? error.message : String(error)}) ` +
        '— nothing was compared and nothing was written',
    );
    return 1;
  }
  if (!response.ok) {
    err(
      `[preflight] unreachable: GET ${publishedUrl} answered ${response.status} — nothing was compared ` +
        'and nothing was written',
    );
    return 1;
  }

  const raw = await response.text();
  let published = null;
  let before;
  try {
    published = JSON.parse(raw);
    before = judgeFeedDocument(published, { expectedVersion, rules });
  } catch {
    // A published feed that is not JSON is a finding, not a crash: it is one of
    // the ways the feed is wrong, and the diff below is still worth printing.
    before = [{ code: 'feed-not-json', detail: `${raw.length} bytes that do not parse` }];
  }

  const diff = diffFindings(before, after);
  for (const line of preflightLines({
    feedFile,
    publishedUrl,
    before,
    after,
    diff,
    fields: fieldDiffLines(published, document),
  })) {
    out(line);
  }

  if (hasFailure(before)) {
    out(PREFLIGHT_VERDICT.broken);
    return 0;
  }
  out(PREFLIGHT_VERDICT.fixed);
  return 1;
}

/** Writes to stdout, in the shape the tests capture. */
const write = (line) => process.stdout.write(`${line}\n`);
const writeErr = (line) => process.stderr.write(`${line}\n`);

/**
 * The whole run, as one function.
 *
 * `fetchImpl`, `out`, `err` and `env` are injected so every branch — including
 * "the token is missing" and "the document is bad" — is exercised without a
 * network, a token or a released asset. The exit code is returned rather than
 * set, so a test asserts the decision instead of the process.
 */
export async function publishFeed({
  argv = [],
  env = process.env,
  fetchImpl = fetch,
  out = write,
  err = writeErr,
  rules = null,
  verify = null,
} = {}) {
  const unknown = unknownFlags(argv);
  if (unknown.length > 0) {
    err(`unknown option(s): ${unknown.join(', ')}`);
    err(`known options: ${KNOWN_FLAGS.map((name) => `--${name}`).join(', ')}`);
    return 1;
  }
  const args = parseArgs(argv);
  const dryRun = args['dry-run'] === true;
  if (args.preflight === true && (args.apply === true || dryRun)) {
    // `--preflight` reads the published feed; `--dry-run` promises that nothing
    // is fetched at all, and `--apply` writes. Asking for two of the three on
    // one line means the caller is not sure which one they want, and the
    // difference between them is "reads the host" and "deletes an asset".
    err(
      'refused: --preflight is its own run — it reads the published feed and writes nothing. ' +
        'Run it alone, then `--dry-run` for the plan, then `--apply --verify`.',
    );
    return 1;
  }
  if (dryRun && args.apply === true) {
    // Two opposite intents on one command line: the caller does not know what
    // it wants, and picking one for it is how a release step runs while the
    // person who typed it believes it only planned.
    err(
      'refused: --dry-run and --apply ask for opposite things — run `--dry-run` first, read the ' +
        'plan, then run `--apply --verify` with no --dry-run.',
    );
    return 1;
  }
  const feedFile = typeof args['feed-file'] === 'string' ? args['feed-file'] : DEFAULT_FEED_FILE;
  const absolute = resolve(root, feedFile);

  let bytes;
  let document;
  try {
    bytes = readFileSync(absolute, 'utf8');
    document = JSON.parse(bytes);
  } catch (error) {
    err(`feed-unreadable: ${feedFile}: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  // The judgement first, and before the token: a bad document must not be
  // publishable by whoever happens to hold credentials.
  const appRules = rules ?? (await loadAppRules());
  // One expected version, used by both judgements: the document about to be
  // uploaded and the document already published are judged against the same
  // release, so the diff `--preflight` prints compares two documents and not
  // two questions.
  const expectedVersion = typeof document?.version === 'string' ? document.version : '';
  const findings = judgeFeedDocument(document, { expectedVersion, rules: appRules });
  for (const entry of findings) err(findingLine(entry));
  if (hasFailure(findings)) {
    err('');
    err(`refused: ${feedFile} was not uploaded — the app’s own feed check rejects this document.`);
    return 1;
  }

  const tag = releaseTagFromFeedUrl(document?.url);
  const repo = repoSlugFromFeedUrl(document?.url);
  if (tag === null || repo === null) {
    err(
      `feed-url-not-pinned: ${document?.url ?? '(no url)'} — the installer URL must name the release ` +
        `(\`…/releases/download/v<version>/<file>\`), not \`latest\`: the tag is what says which ` +
        'release this document belongs to.',
    );
    return 1;
  }

  const token = tokenFromEnv(env);

  if (args.preflight === true) {
    return runPreflight({
      feedFile,
      document,
      after: findings,
      expectedVersion,
      tag,
      repo,
      token,
      rules: appRules,
      fetchImpl,
      out,
      err,
    });
  }

  const plan = planLines({
    feedFile,
    document,
    tag,
    repo,
    token,
    bytes: Buffer.byteLength(bytes, 'utf8'),
    verify: args.verify === true,
    apply: args.apply === true,
  });
  for (const line of plan) out(line);

  if (args.apply !== true) {
    out('');
    out('dry run — nothing was fetched and nothing was uploaded. Add --apply to replace the asset.');
    return 0;
  }

  if (token === null) {
    err('');
    err(
      `blocked: no GitHub write token — set ${TOKEN_VARS[0]} (or ${TOKEN_VARS[1]}) with \`contents: write\` ` +
        `on ${repo}, then run this again. Nothing was uploaded and the published ${ASSET_NAME} is unchanged.`,
    );
    return 1;
  }

  const headers = {
    authorization: `Bearer ${token.value}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
  };

  const releaseResponse = await fetchImpl(`${API_BASE}/repos/${repo}/releases/tags/${tag}`, { headers });
  if (!releaseResponse.ok) {
    err(`release-unreadable: GET releases/tags/${tag} answered ${releaseResponse.status}; nothing was changed.`);
    return 1;
  }
  const release = await releaseResponse.json();

  const installerName = installerNameFromFeedUrl(document.url);
  const installerAsset = findAsset(release, installerName);
  const judgement = judgeInstallerAsset({ document, asset: installerAsset });
  for (const line of judgement.skipped) out(`[skipped] ${line}`);
  for (const line of judgement.problems) err(`[FAIL] digest-mismatch: ${line}`);
  if (judgement.problems.length > 0) {
    err('');
    err(`refused: the host disagrees with ${feedFile}; the published ${ASSET_NAME} was left alone.`);
    return 1;
  }

  const existing = findAsset(release, ASSET_NAME);
  if (existing !== null) {
    const deleted = await fetchImpl(`${API_BASE}/repos/${repo}/releases/assets/${existing.id}`, {
      method: 'DELETE',
      headers,
    });
    if (deleted.status !== 204 && deleted.status !== 200) {
      err(`asset-delete-failed: DELETE assets/${existing.id} answered ${deleted.status}; the old document is still published.`);
      return 1;
    }
    out(`deleted: ${ASSET_NAME} (asset ${existing.id})`);
  } else {
    out(`[note] no asset named ${ASSET_NAME} on ${tag} — uploading a new one`);
  }

  const uploaded = await fetchImpl(`${UPLOAD_BASE}/repos/${repo}/releases/${release.id}/assets?name=${ASSET_NAME}`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/octet-stream' },
    body: bytes,
  });
  if (!uploaded.ok) {
    err(`asset-upload-failed: POST assets answered ${uploaded.status}; rerun this command once the cause is fixed.`);
    return 1;
  }
  const asset = await uploaded.json();
  out(`uploaded: ${ASSET_NAME} (asset ${asset?.id ?? '?'}, ${document.size ?? '?'} bytes of installer named)`);
  out(`PASS — ${ASSET_NAME} on ${repo} ${tag} now carries sha256=${document.sha256}`);

  if (args.verify === true) {
    out('');
    out('re-checking the published bytes: node scripts/verify-release-feed.mjs');
    const run = (verify ?? defaultVerify)();
    return run;
  }
  out('');
  out('now judge the published bytes: `node scripts/verify-release-feed.mjs`');
  return 0;
}

/**
 * Runs the published-bytes verifier as a child process.
 *
 * Inherited stdio on purpose: the verifier's output is the evidence, and a
 * copy captured into this process would be a second printer of the same
 * findings.
 */
function defaultVerify() {
  const result = spawnSync(process.execPath, [join(root, 'scripts', 'verify-release-feed.mjs')], {
    stdio: 'inherit',
  });
  return result.status ?? 1;
}

// Only run as a command; importing the helpers must not upload anything.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  publishFeed({ argv: process.argv.slice(2) })
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}

/** The document this command ships with, for tests that do not want a path. */
export function defaultFeedPath() {
  return join(root, DEFAULT_FEED_FILE);
}
