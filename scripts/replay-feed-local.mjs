/**
 * The feed the app is willing to install from, replayed over TLS from this machine.
 *
 * ## Why this file exists
 *
 * The update path is proven in one direction and argued in the other. The feed
 * published on the v1.0.0 release carries no `sha256`, so
 * `scripts/verify-release-feed.mjs` reads it and says so, and
 * `scripts/release-gate.mjs` turns that verdict into a release build that
 * refuses to run. Both of those are red on this machine today, and both are
 * correct.
 *
 * What has never happened is the green branch: a run in which the feed is
 * right, every check ran, and both commands say so. `[skipped]` and
 * `INCOMPLETE` are printed precisely so a green run that did half the work
 * cannot be mistaken for a measured one — and until now the only green the
 * repository could show was driven by a hand-written envelope in
 * `tests/contract/release-gate.test.ts`. That is a test of the decision, not a
 * run of the path.
 *
 * The one thing between this machine and a real green run is the document on
 * the release: replacing it needs a token with `contents: write` (see
 * `docs/blockers.md`), and that is not this file's problem. What this file can
 * do is take the corrected document — the committed bytes, unchanged — and put
 * it behind a real address, so the two real commands can judge it over the
 * wire instead of over a fixture.
 *
 * ## What it does
 *
 *  1. reads the document on disk (default `docs/release/update-feed-v1.0.0.json`)
 *     and prints its size and the hash of the bytes it is about to serve, so
 *     the reader can compare them with the file;
 *  2. makes a one-day self-signed certificate for `localhost` and serves those
 *     exact bytes at `https://localhost:<port>/update-feed.json` — TLS because
 *     the app's own rule is https-only, and `checkChannelUrl()` is the same
 *     function this run is trying to satisfy;
 *  3. runs `scripts/verify-release-feed.mjs --feed <that address>` and prints
 *     its output verbatim, including the `[skipped]` lines and the summary;
 *  4. runs the same command with `--json`, writes the run to a file, and hands
 *     that file to `scripts/release-gate.mjs --from-json`, printing the gate's
 *     output and exit code.
 *
 * Exit code 0 only when both commands exit 0. A run that could not finish because the
 * release host stopped answering exits 1 with `[INCOMPLETE]`: the document was not
 * judged, which is not the same thing as being refused.
 *
 * ## What it does not prove, and says so
 *
 * The last line of a green run names the two things it cannot claim:
 *
 *  - the asset published on GitHub Releases is still the old document; this is
 *    the corrected one, replayed from this machine;
 *  - the gate is judging a saved run (`--from-json` prints "a saved run, not
 *    fetched now"), which is the shape the gate offers and not the shape
 *    `npm run dist` uses.
 *
 * The certificate is self-signed and trusted by nothing: the two child runs get
 * it through `NODE_EXTRA_CA_CERTS`, so the trust ends inside this process tree.
 * Nothing here relaxes the app's rules, and nothing here is on a release path —
 * `npm run dist` still runs `release-gate.mjs` with no argument, against the
 * published feed.
 *
 * ## Why a host that did not answer is not a verdict on the document
 *
 * The green branch needs one thing from outside this machine: the verifier also
 * sends a HEAD to the installer URL, which lives on the release host. The route
 * to that host is not always there (the same flakiness `verify-release-feed.mjs`
 * names for its own runs), and a proof that reads "the verifier failed" as "the
 * document was refused" would send the next reader to fix a document that is
 * fine — the exact misdiagnosis this repository keeps closing.
 *
 * So a red verifier run is classified before anything is concluded. The codes
 * that mean "a host did not answer" (`feed-unreachable` / `feed-timeout` /
 * `installer-unreachable` / `installer-timeout`) produce `[INCOMPLETE]`, with
 * the two ways forward printed: retry when the route is back, or judge the
 * document itself offline with `--feed-file`. Every other failure — a document
 * finding, or a run that named no finding at all — produces `[FAIL]`, because
 * the conservative direction matters: calling a real refusal a network problem
 * hides a fixable feed. The classification is a pure function so both
 * directions are pinned by `tests/contract/replay-feed-local.test.ts`.
 *
 * ## Why a script instead of six shell commands
 *
 * The transcript is the evidence, so it has to be reproducible by someone who
 * was not here. Six hand-typed commands (openssl, a background server, two
 * commands with an exported CA path, a saved run, a gate invocation) is a
 * transcript nobody can repeat, and a certificate generated once by hand is a
 * file whose provenance the next reader has to take on trust.
 *
 * ## Usage
 *
 * ```bash
 * npm run build:main -w @ucad/desktop        # the app's own feed rules
 * node scripts/replay-feed-local.mjs
 * node scripts/replay-feed-local.mjs --feed docs/release/update-feed-v1.0.0.json --port 8787
 * ```
 *
 * Flags: `--feed <path>` (the document to replay), `--port <n>` (default 0,
 * an ephemeral port printed by the run), `--timeout <ms>` (passed to the
 * verifier, default 20000), `--help`.
 *
 * An option this command does not know is an error, not a default — the same
 * rule the two commands it drives already state, and for the same reason: a
 * mistyped `--feed` would replay the default document while the operator
 * believes they replayed theirs.
 *
 * Requires `openssl` on `PATH` for the certificate. There is no fallback to
 * cleartext: the address rule the app enforces is the thing being honoured, and
 * a proof that turns it off is a proof of something else. A machine without
 * openssl can still judge the document itself with
 * `node scripts/verify-release-feed.mjs --feed-file docs/release/update-feed-v1.0.0.json`,
 * which prints the address rule as `[skipped]` rather than pretending it ran.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

/** The path the replica answers on. The verifier fetches exactly this. */
export const DOCUMENT_PATH = '/update-feed.json';

/** The document replayed when `--feed` is not given. */
export const DEFAULT_FEED = 'docs/release/update-feed-v1.0.0.json';

/** The two commands this run hands its verdict to, by repository-relative path. */
export const VERIFIER = 'scripts/verify-release-feed.mjs';
export const GATE = 'scripts/release-gate.mjs';

/** The options this command understands. Anything else is a typo, not a default. */
export const KNOWN_FLAGS = ['feed', 'port', 'timeout', 'help'];

/** Reads `--flag value` pairs out of argv. */
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

/** The hash of the bytes that were served, printed so "byte for byte" is checkable. */
export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * The replica's request handler: one document, one path.
 *
 * A second path is a 404 rather than the same document, because "it served
 * something" and "it served the feed at the address the verifier fetched" are
 * different facts, and only the second one is the proof.
 */
export function documentHandler(bytes) {
  return (req, res) => {
    if (req.url !== DOCUMENT_PATH) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not this document');
      return;
    }
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(bytes.length),
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    res.end(bytes);
  };
}

/**
 * Serves the document on `127.0.0.1`, over TLS when a certificate is given.
 *
 * The cleartext form exists so the handler can be exercised without generating
 * a certificate; this command never uses it, because the address rule under
 * test is https-only.
 */
export async function startReplica(bytes, options = {}) {
  const { port = 0, host = '127.0.0.1', cert = null, key = null } = options;
  const tls = cert !== null && key !== null;
  const handler = documentHandler(bytes);
  const server = tls
    ? createHttpsServer({ cert: readFileSync(cert), key: readFileSync(key) }, handler)
    : createHttpServer(handler);

  await new Promise((done, fail) => {
    const onError = (error) => fail(error);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      done();
    });
  });

  const address = server.address();
  return {
    url: `${tls ? 'https' : 'http'}://localhost:${address.port}${DOCUMENT_PATH}`,
    port: address.port,
    close: () => new Promise((done) => server.close(() => done())),
  };
}

/**
 * A one-day self-signed certificate for `localhost`, written into `dir`.
 *
 * `spawn` is a parameter so the missing-openssl branch can be shown rather than
 * described: the failure a reader without openssl will actually meet is the
 * message, and a message nothing exercises is a message that rots.
 */
export function makeSelfSignedCertificate(dir, spawn = spawnSync) {
  const keyPath = join(dir, 'key.pem');
  const certPath = join(dir, 'cert.pem');
  const result = spawn(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1',
    ],
    { encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'] },
  );

  const fallback =
    'The document itself can still be judged without a certificate: ' +
    `node ${VERIFIER} --feed-file ${DEFAULT_FEED}`;
  if (result.error) {
    throw new Error(
      `openssl could not be run (${result.error.code ?? result.error.message}), so a ` +
        `self-signed certificate cannot be made. ${fallback}`,
    );
  }
  if (result.status !== 0) {
    const why = String(result.stderr ?? '').trim().split('\n').slice(-1)[0] ?? `exit ${result.status}`;
    throw new Error(
      `openssl refused to make a certificate for localhost: ${why}. ${fallback}`,
    );
  }
  return { cert: certPath, key: keyPath };
}

/**
 * One child run, as this command needs it: a script, its arguments, an exit code.
 *
 * Asynchronous on purpose. The replica lives in this process, so a synchronous
 * spawn would block the event loop that is supposed to answer the child's TLS
 * handshake: the child connects, nobody completes the handshake, and the
 * verifier reports `feed-unreachable` about a server that is running fine. The
 * first version of this file did exactly that, and the message it printed was
 * indistinguishable from a genuinely unreachable host.
 */
function spawnScript({ script, args, env }) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [join(root, script), ...args], {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      done({ code: 1, stdout, stderr: `${stderr}${error.message}` });
    });
    child.on('close', (code) => {
      done({ code: code ?? 1, stdout, stderr });
    });
  });
}

/** A child's own words, printed as it wrote them — no re-rendering. */
function printOutput(log, output) {
  for (const block of [output.stdout, output.stderr]) {
    const text = String(block ?? '').trimEnd();
    if (text.length > 0) log(text);
  }
}

/**
 * The verifier findings that are about a host, not about a document.
 *
 * Kept as a list rather than a prefix test: `installer-not-https` and
 * `installer-unreachable` differ by one word and by everything that matters —
 * the first is a document the app refuses, the second is a host that did not
 * answer. A prefix rule that caught both would call a bad URL "INCOMPLETE".
 */
export const HOST_FINDING_CODES = [
  'feed-unreachable',
  'feed-timeout',
  'installer-unreachable',
  'installer-timeout',
];

/** The finding codes a verifier run named, in the order it printed them. */
export function verifierFindings(output) {
  const codes = [];
  for (const raw of String(output ?? '').split('\n')) {
    const match = /^\[FAIL\] ([a-z0-9-]+):/u.exec(raw.trim());
    if (match !== null && !codes.includes(match[1])) codes.push(match[1]);
  }
  return codes;
}

/**
 * Whether a red verifier run is a host result or a verdict on the document.
 *
 * `host` only when every finding it named is a host finding, and only when it
 * named at least one. A run that failed silently (a crash, a mistyped flag)
 * counts as `document`, so the reader is sent to look at the run rather than
 * told to retry the network.
 */
export function classifyFailure(output) {
  const codes = verifierFindings(output);
  if (codes.length > 0 && codes.every((code) => HOST_FINDING_CODES.includes(code))) return 'host';
  return 'document';
}

/**
 * The three-step proof, with every side effect handed in.
 *
 * `run` is the only way this function can touch another process, and `log` the
 * only way it can print, so the sequencing (does a red verifier stop before the
 * gate? does the gate get the run the second verifier wrote?) is a function a
 * test can drive — the alternative is a proof whose control flow is only
 * exercised on a machine with openssl and a route to the release host.
 */
export async function replayDocument({
  url,
  bytes,
  certPath,
  timeoutMs,
  run,
  log,
  saveRun,
}) {
  log(
    `serving: ${url} — the committed document, byte for byte ` +
      `(${bytes.length} bytes, sha256 ${sha256Hex(bytes)})`,
  );

  const verify = await run({
    script: VERIFIER,
    args: ['--feed', url, '--timeout', String(timeoutMs)],
    env: { NODE_EXTRA_CA_CERTS: certPath },
  });
  printOutput(log, verify);
  if (verify.code !== 0) {
    log('');
    if (classifyFailure(`${verify.stdout}\n${verify.stderr}`) === 'host') {
      log(
        '[INCOMPLETE] the release host did not answer, so the replayed document was not judged ' +
          'and the release gate was not run — this is not a verdict on the feed. The installer ' +
          'URL lives on the release host and the verifier sends it one HEAD; retry when the ' +
          'route is back, or judge the document itself offline with ' +
          `\`node ${VERIFIER} --feed-file ${DEFAULT_FEED}\`.`,
      );
    } else {
      log(
        '[FAIL] the verifier did not accept the replayed document, so the release gate was ' +
          'not run: a gate over a run that is already red would only repeat the same lines.',
      );
    }
    return 1;
  }

  const saved = await run({
    script: VERIFIER,
    args: ['--feed', url, '--timeout', String(timeoutMs), '--json'],
    env: { NODE_EXTRA_CA_CERTS: certPath },
  });
  if (saved.code !== 0) {
    printOutput(log, saved);
    log('');
    if (classifyFailure(`${saved.stdout}\n${saved.stderr}`) === 'host') {
      log(
        '[INCOMPLETE] the first run judged the document and passed, but the release host stopped ' +
          'answering before the saved run could be written, so the gate was not run. Nothing about ' +
          'the document changed between the two runs; retry when the route is back.',
      );
    } else {
      log(
        '[FAIL] the saved run could not be produced from the same address, so the gate was not run.',
      );
    }
    return 1;
  }

  const runPath = saveRun(saved.stdout);
  log(`saved run: ${runPath} (the same command, in the envelope the gate reads)`);

  const gate = await run({ script: GATE, args: ['--from-json', runPath], env: {} });
  printOutput(log, gate);
  if (gate.code !== 0) {
    log('');
    log('[FAIL] the release gate refused the saved run of the replayed document.');
    return 1;
  }

  log('');
  log(
    '[ok] the green branch is a run, not an argument: the feed was fetched over TLS ' +
      'through the app’s own rules, nothing was skipped, and the release gate accepted it.',
  );
  log(
    '[note] two things this does not claim: the asset published on GitHub Releases is ' +
      'still the old document without sha256 (replacing it needs a token with contents: ' +
      'write — docs/blockers.md), and the gate judged a saved run, which is what ' +
      '--from-json does and not what `npm run dist` does.',
  );
  return 0;
}

export function usage() {
  return [
    'usage: node scripts/replay-feed-local.mjs [--feed <path>] [--port <n>] [--timeout <ms>]',
    '',
    'Serves the corrected feed from a local TLS address and runs the two real commands',
    'against it: scripts/verify-release-feed.mjs, then scripts/release-gate.mjs.',
    'Exit 0 only when both do. Nothing is uploaded and no release is touched.',
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

  const feedLabel = typeof args.feed === 'string' ? args.feed : DEFAULT_FEED;
  const port = args.port === undefined ? 0 : Number.parseInt(String(args.port), 10);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`--port wants a number between 0 and 65535, not ${JSON.stringify(args.port)}`);
  }
  const timeoutMs = Number.parseInt(String(args.timeout ?? '20000'), 10) || 20_000;

  let bytes;
  try {
    bytes = readFileSync(resolve(root, feedLabel));
  } catch (error) {
    console.log(
      `[FAIL] feed-unreadable: ${feedLabel}: ${error instanceof Error ? error.message : String(error)}`,
    );
    console.log(
      'Nothing was served and nothing was judged. Name a document with --feed, or run with ' +
        `no flag to replay the committed one (${DEFAULT_FEED}).`,
    );
    return 1;
  }

  const work = mkdtempSync(join(tmpdir(), 'ucad-feed-replay-'));
  let replica = null;
  try {
    const { cert, key } = makeSelfSignedCertificate(work);
    replica = await startReplica(bytes, { port, cert, key });
    console.log(`feed: ${feedLabel} (${bytes.length} bytes, sha256 ${sha256Hex(bytes)})`);

    const code = await replayDocument({
      url: replica.url,
      bytes,
      certPath: cert,
      timeoutMs,
      run: spawnScript,
      log: (line) => console.log(line),
      saveRun: (stdout) => {
        const path = join(work, 'verify-run.json');
        writeFileSync(path, stdout, 'utf8');
        return path;
      },
    });
    return code;
  } catch (error) {
    console.log(`[FAIL] ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    if (replica !== null) await replica.close();
    rmSync(work, { recursive: true, force: true });
  }
}

// Only run as a command; importing the proof must not open a port.
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
