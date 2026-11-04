/**
 * The green branch of the release gate, replayed from this machine.
 *
 * ## Why this file exists
 *
 * `release-gate.test.ts` proves the gate's *decision* over a hand-written
 * envelope, and says so in its own header: the envelope was written by hand
 * because the published feed could not pass — it has no `sha256`. That is a test
 * of the judgement. What the repository could not show was a **run**: the
 * verifier fetching a document over TLS, finding nothing, and the gate accepting
 * that run. `[skipped]` and `INCOMPLETE` exist precisely so a run that did half
 * the work cannot be mistaken for a measured one, and the only green the suite
 * could produce was a document it wrote itself.
 *
 * The edit the release needs — replacing the asset — needs a token with
 * `contents: write` (`docs/blockers.md`), which this machine does not have. What
 * this machine *can* do is take the corrected document, unchanged, and put it
 * behind a real address. `scripts/replay-feed-local.mjs` does that, and the two
 * real commands judge it over the wire.
 *
 * ## What the cases below pin, and why each one matters
 *
 *  - the **control flow**: a red verifier must stop before the gate (a gate over
 *    a run that is already red only repeats the same lines), and a gate that was
 *    not run must not be reported as passing. The proof function takes `run` and
 *    `log` as parameters so this is a function a test drives, not a transcript
 *    somebody once read;
 *  - the **wiring**: the verifier is pointed at the replayed *address* (not the
 *    file on disk), the saved run is produced by the same address with `--json`,
 *    and the gate receives exactly the file the second verifier wrote. A proof
 *    that judged the file would be a proof of the other thing;
 *  - the **trust boundary**: only the two child runs get
 *    `NODE_EXTRA_CA_CERTS`; the certificate is self-signed and ends inside this
 *    process tree, and the gate is handed no environment at all;
 *  - the **byte-for-byte claim**: the hash the run prints is the hash of the
 *    bytes it serves, and the replica answers one path with those bytes and 404
 *    everywhere else — "it served something" and "it served the feed the
 *    verifier fetched" are different facts;
 *  - the **refusals**: an unknown option is an error rather than a default (a
 *    mistyped `--feed` would replay the committed document while the operator
 *    believes they replayed theirs), and a missing `openssl` says so and points
 *    at `--feed-file` instead of falling back to cleartext.
 *
 * ## The one case that runs the real thing
 *
 * The last case runs the command end to end: real TLS, real certificate, both
 * real child processes. It asserts the transcript rather than only the exit
 * code, because the exit code alone cannot tell a green run from a command that
 * did nothing. Its two preconditions — a built main process and `openssl` — are
 * asserted as *their own red outcomes* (a diagnosable refusal), not skipped: a
 * case that quietly does nothing off a fresh clone is the shape this suite keeps
 * removing.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_FEED,
  DOCUMENT_PATH,
  GATE,
  HOST_FINDING_CODES,
  KNOWN_FLAGS,
  VERIFIER,
  classifyFailure,
  documentHandler,
  main,
  makeSelfSignedCertificate,
  parseArgs,
  replayDocument,
  sha256Hex,
  startReplica,
  unknownFlags,
  verifierFindings,
} from '../../scripts/replay-feed-local.mjs';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const CLI = join(REPO_ROOT, 'scripts', 'replay-feed-local.mjs');
const APP_RULES_BUILD = join(REPO_ROOT, 'apps', 'desktop', 'dist', 'main', 'update-feed.js');

/** The committed document every case here is about. */
const FEED_BYTES = readFileSync(join(REPO_ROOT, DEFAULT_FEED));

/** One child run the proof asked for, as the proof asked for it. */
interface ChildCall {
  script: string;
  args: string[];
  env: Record<string, string>;
}

/** A `run` that answers from a script of outcomes, recording every call. */
function scriptedRun(
  outcomes: readonly number[],
  outputs: readonly string[] = [],
): {
  calls: ChildCall[];
  run: (call: ChildCall) => Promise<{ code: number; stdout: string; stderr: string }>;
} {
  const calls: ChildCall[] = [];
  let index = 0;
  return {
    calls,
    run: async (call: ChildCall) => {
      calls.push(call);
      const code = outcomes[index] ?? 0;
      const stdout = outputs[index] ?? `run ${index + 1}`;
      index += 1;
      return { code, stdout, stderr: '' };
    },
  };
}

/** A proof invocation with everything handed in, so each case varies one thing. */
async function prove(options: {
  outcomes: readonly number[];
  outputs?: readonly string[];
  log?: (line: string) => void;
  saveRun?: (stdout: string) => string;
}) {
  const scripted = scriptedRun(options.outcomes, options.outputs);
  const lines: string[] = [];
  const code = await replayDocument({
    url: 'https://localhost:4443/update-feed.json',
    bytes: FEED_BYTES,
    certPath: '/tmp/cert.pem',
    timeoutMs: 1234,
    run: scripted.run,
    log: options.log ?? ((line: string) => lines.push(line)),
    saveRun: options.saveRun ?? (() => '/tmp/verify-run.json'),
  });
  return { code, lines, calls: scripted.calls };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the replay proof stops when a run is red', () => {
  it('does not run the gate over a verifier that already refused the document', async () => {
    const { code, calls, lines } = await prove({ outcomes: [1] });

    expect(code).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.script).toBe(VERIFIER);
    expect(lines.join('\n')).toContain('[FAIL] the verifier did not accept the replayed document');
    // The gate's own name must not appear: "not run" and "run and passed" must
    // not read the same in the transcript.
    expect(calls.map((call) => call.script)).not.toContain(GATE);
  });

  it('does not run the gate when the saved run could not be produced', async () => {
    // The verifier said PASS the first time and could not produce the envelope
    // the second time. The gate has nothing to judge, and inventing a verdict
    // from the first run would be judging a file that does not exist.
    const { code, calls, lines } = await prove({ outcomes: [0, 1] });

    expect(code).toBe(1);
    expect(calls.map((call) => call.script)).toEqual([VERIFIER, VERIFIER]);
    expect(lines.join('\n')).toContain('the saved run could not be produced');
  });

  it('stops when the gate refuses the saved run it was handed', async () => {
    const { code, calls, lines } = await prove({ outcomes: [0, 0, 1] });

    expect(code).toBe(1);
    expect(calls.map((call) => call.script)).toEqual([VERIFIER, VERIFIER, GATE]);
    expect(lines.join('\n')).toContain('[FAIL] the release gate refused the saved run');
  });
});

describe('the proof is about the address, not about the file on disk', () => {
  it('points both verifier runs at the replayed address and hands the gate their file', async () => {
    const saved: string[] = [];
    const { code, calls } = await prove({
      outcomes: [0, 0, 0],
      saveRun: (stdout) => {
        saved.push(stdout);
        return '/tmp/the-saved-run.json';
      },
    });

    expect(code).toBe(0);
    expect(calls).toHaveLength(3);

    const [first, second, gate] = calls as [ChildCall, ChildCall, ChildCall];
    for (const call of [first, second]) {
      expect(call.script).toBe(VERIFIER);
      expect(call.args).toEqual(expect.arrayContaining(['--feed', 'https://localhost:4443/update-feed.json']));
      // Never `--feed-file`: judging the committed bytes locally is what
      // `--feed-file` is for, and it is the other half of the evidence.
      expect(call.args).not.toContain('--feed-file');
      expect(call.env).toEqual({ NODE_EXTRA_CA_CERTS: '/tmp/cert.pem' });
    }
    expect(first.args).not.toContain('--json');
    expect(second.args).toContain('--json');

    // The gate gets the run the second verifier wrote — not the first run's
    // output, and not a path of its own choosing.
    expect(gate.script).toBe(GATE);
    expect(gate.args).toEqual(['--from-json', '/tmp/the-saved-run.json']);
    expect(saved).toEqual(['run 2']);
    // The certificate's trust ends inside this process tree: the gate is handed
    // no environment of its own.
    expect(gate.env).toEqual({});
  });

  it('prints the hash of the bytes it is about to serve, so "byte for byte" is checkable', async () => {
    const { lines } = await prove({ outcomes: [0, 0, 0] });
    const served = lines[0] ?? '';

    expect(served).toContain('https://localhost:4443/update-feed.json');
    expect(served).toContain(`${FEED_BYTES.length} bytes`);
    // The number a reader compares with the file on disk. Computed here from the
    // committed bytes, so a wrong document is a red run rather than a footnote.
    expect(served).toContain(sha256Hex(FEED_BYTES));
    expect(sha256Hex(FEED_BYTES)).toBe(createHash('sha256').update(FEED_BYTES).digest('hex'));
  });

  it('says what a green run does not claim, in the run itself', async () => {
    // The two things a green replay cannot establish: the published asset is
    // still the old document, and the gate judged a saved run rather than
    // fetching the feed itself the way `npm run dist` does. If this line is
    // dropped, a reader takes the transcript for a release sign-off.
    const { lines } = await prove({ outcomes: [0, 0, 0] });
    const text = lines.join('\n');

    expect(text).toContain('[ok] the green branch is a run, not an argument');
    expect(text).toContain('the asset published on GitHub Releases is');
    expect(text).toContain('docs/blockers.md');
    expect(text).toContain('--from-json');
  });
});

describe('a host that did not answer is not a verdict on the document', () => {
  it('names the codes it reads, and keeps the host ones apart from the document ones', () => {
    // The whole point of the list: `installer-not-https` and
    // `installer-unreachable` differ by one word and by everything that
    // matters, so a prefix rule would call a refused URL "INCOMPLETE".
    expect(HOST_FINDING_CODES).toEqual([
      'feed-unreachable',
      'feed-timeout',
      'installer-unreachable',
      'installer-timeout',
    ]);
    expect(
      verifierFindings(
        '[FAIL] installer-unreachable: fetch failed — https://github.com/…\n' +
          '[WARN] no-size: the feed publishes no size\n' +
          '[FAIL] installer-unreachable: duplicate line\n',
      ),
    ).toEqual(['installer-unreachable']);
    expect(classifyFailure('[FAIL] installer-unreachable: fetch failed')).toBe('host');
    expect(classifyFailure('[FAIL] feed-timeout: no answer within 20000ms')).toBe('host');
    // A document finding wins over a host finding: retrying cannot fix a feed.
    expect(
      classifyFailure('[FAIL] installer-unreachable: fetch failed\n[FAIL] no-sha256: nothing'),
    ).toBe('document');
    expect(classifyFailure('[FAIL] installer-not-https: plaintext mirror')).toBe('document');
    // A run that named nothing (crash, bad flag) is not evidence the host was down.
    expect(classifyFailure('TypeError: something in the verifier')).toBe('document');
    expect(classifyFailure('')).toBe('document');
  });

  it('prints INCOMPLETE instead of calling a host problem a refused document', async () => {
    const { code, calls, lines } = await prove({
      outcomes: [1],
      outputs: ['[FAIL] installer-unreachable: fetch failed — https://github.com/…\nFAIL — 1 failure(s)'],
    });
    const text = lines.join('\n');

    expect(code).toBe(1);
    expect(calls).toHaveLength(1);
    expect(text).toContain('[INCOMPLETE] the release host did not answer');
    expect(text).toContain('this is not a verdict on the feed');
    // The two ways forward, printed rather than assumed known.
    expect(text).toContain('--feed-file docs/release/update-feed-v1.0.0.json');
    expect(text).not.toContain('the verifier did not accept the replayed document');
  });

  it('still calls a refused document a refusal, even when a host also failed', async () => {
    const { code, lines } = await prove({
      outcomes: [1],
      outputs: ['[FAIL] installer-unreachable: fetch failed\n[FAIL] no-sha256: the feed publishes no sha256'],
    });

    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('the verifier did not accept the replayed document');
    expect(lines.join('\n')).not.toContain('[INCOMPLETE]');
  });

  it('says the document passed when only the saved run lost the host', async () => {
    const { code, calls, lines } = await prove({
      outcomes: [0, 1],
      outputs: ['PASS — 0 warning(s), nothing the app would refuse', '[FAIL] installer-timeout: no answer'],
    });
    const text = lines.join('\n');

    expect(code).toBe(1);
    expect(calls.map((call) => call.script)).toEqual([VERIFIER, VERIFIER]);
    expect(text).toContain('the first run judged the document and passed');
    expect(text).not.toContain('[FAIL] the saved run could not be produced');
  });
});

describe('the replica serves one document, at one path', () => {
  it('answers the verifier’s path with the exact bytes and everything else with 404', async () => {
    const bytes = Buffer.from('{"version":"1.0.0"}', 'utf8');
    const replica = await startReplica(bytes);
    try {
      const hit = await fetch(`http://127.0.0.1:${replica.port}${DOCUMENT_PATH}`);
      expect(hit.status).toBe(200);
      expect(hit.headers.get('content-type')).toContain('application/json');
      expect(hit.headers.get('content-length')).toBe(String(bytes.length));
      expect(await hit.text()).toBe(bytes.toString('utf8'));

      const miss = await fetch(`http://127.0.0.1:${replica.port}${DOCUMENT_PATH}.bak`);
      expect(miss.status).toBe(404);
      expect(await miss.text()).toBe('not this document');

      const root = await fetch(`http://127.0.0.1:${replica.port}/`);
      expect(root.status).toBe(404);
    } finally {
      await replica.close();
    }
  });

  it('answers HEAD with the headers and no body', async () => {
    const bytes = Buffer.from('{"version":"1.0.0"}', 'utf8');
    const replica = await startReplica(bytes);
    try {
      const head = await fetch(`http://127.0.0.1:${replica.port}${DOCUMENT_PATH}`, { method: 'HEAD' });
      expect(head.status).toBe(200);
      expect(head.headers.get('content-length')).toBe(String(bytes.length));
      expect(await head.text()).toBe('');
    } finally {
      await replica.close();
    }
  });

  it('is reachable at the address it reports, and nowhere else', async () => {
    // The handler is a parameter-driven function, so a bug that served the
    // document from every path would look like a working replica.
    const bytes = Buffer.from('{"version":"1.0.0"}', 'utf8');
    const handler = documentHandler(bytes);
    const statuses: number[] = [];
    const headers: Record<string, string> = {};
    const response = {
      writeHead: (status: number, fields?: Record<string, string>) => {
        statuses.push(status);
        Object.assign(headers, fields ?? {});
      },
      end: () => {},
    };
    handler({ url: DOCUMENT_PATH, method: 'GET' }, response);
    handler({ url: '/other.json', method: 'GET' }, response);
    expect(statuses).toEqual([200, 404]);
    expect(headers['content-length']).toBe(String(bytes.length));
  });
});

describe('options and refusals', () => {
  it('reads `--flag value` pairs, and a trailing flag as true', () => {
    expect(parseArgs(['--feed', 'docs/x.json', '--help'])).toEqual({ feed: 'docs/x.json', help: true });
    expect(parseArgs(['--port', '8787'])).toEqual({ port: '8787' });
  });

  it('names an option it does not know instead of falling back to a default', async () => {
    // `--feed-file` is the verifier's flag. Reaching for it here would replay
    // the committed document while the operator believes they replayed theirs,
    // and the transcript would look like a green run of the wrong thing.
    expect(unknownFlags(['--feed-file', 'x.json', '--port', '1'])).toEqual(['--feed-file']);
    expect(KNOWN_FLAGS).toEqual(['feed', 'port', 'timeout', 'help']);
    await expect(main(['--feed-file', 'docs/release/update-feed-v1.0.0.json'])).rejects.toThrow(
      /unknown option\(s\): --feed-file/,
    );
    await expect(main(['--portt', '8787'])).rejects.toThrow(
      /known options: --feed, --port, --timeout, --help/,
    );
  });

  it('refuses a port that is not a port before opening anything', async () => {
    await expect(main(['--port', '99999'])).rejects.toThrow(/between 0 and 65535/);
    await expect(main(['--port', 'not-a-number'])).rejects.toThrow(/between 0 and 65535/);
  });

  it('reports a document that is not there, and serves nothing', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      lines.push(String(line));
    });

    const code = await main(['--feed', 'docs/release/__missing__.json']);

    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('feed-unreadable');
    expect(lines.join('\n')).toContain('Nothing was served and nothing was judged');
  });

  it('says what to do instead when openssl is missing, rather than serving cleartext', () => {
    const missing = () => ({ error: { code: 'ENOENT' } });
    expect(() => makeSelfSignedCertificate('/tmp', missing)).toThrow(/openssl could not be run \(ENOENT\)/);
    expect(() => makeSelfSignedCertificate('/tmp', missing)).toThrow(
      /--feed-file docs\/release\/update-feed-v1\.0\.0\.json/,
    );
  });

  it('passes openssl’s own last line through when it refuses', () => {
    const refused = () => ({ status: 1, stderr: 'some noise\nunable to load config' });
    expect(() => makeSelfSignedCertificate('/tmp', refused)).toThrow(
      /openssl refused to make a certificate for localhost: unable to load config/,
    );
  });
});

describe('the command, end to end', () => {
  // Two real child processes, a TLS handshake each, a self-signed certificate
  // and a saved run: seconds of work on an idle machine, and the default 30 s
  // budget belongs to the suite rather than to this command — the first version
  // of this case went red only when it ran beside another script suite.
  it('runs both real commands against the committed document and prints a green transcript', { timeout: 120_000 }, () => {
    const result = spawnSync(process.execPath, [CLI], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 110_000,
    });
    const transcript = `${result.stdout ?? ''}${result.stderr ?? ''}`;

    // Two preconditions, each asserted as its own readable refusal rather than
    // skipped: a suite that proves nothing off a fresh clone is not a gate.
    if (!existsSync(APP_RULES_BUILD)) {
      expect(result.status, transcript).toBe(1);
      expect(transcript).toContain('not built');
      return;
    }
    const openssl = spawnSync('openssl', ['version'], { encoding: 'utf8' });
    if (openssl.status !== 0) {
      expect(result.status, transcript).toBe(1);
      expect(transcript).toContain('openssl could not be run');
      expect(transcript).toContain('--feed-file');
      return;
    }

    // Two acceptable outcomes, and only two. The full green run needs the
    // release host to answer the verifier's HEAD on the installer URL, and the
    // route to that host is intermittent on this machine (the same flakiness
    // `verify-release-feed.mjs` names). When it is up, the transcript must be
    // green; when it is down, the transcript must say INCOMPLETE and name the
    // installer host — never that the document was refused. Anything else,
    // including a document finding, is red: a case that accepted "some failure"
    // would pass on a broken gate.
    expect([0, 1]).toContain(result.status);
    // Whichever branch ran, the bytes served are the committed ones, named and
    // hashed: that part never depends on the network.
    expect(transcript).toContain(DEFAULT_FEED);
    expect(transcript).toContain(sha256Hex(FEED_BYTES));

    if (result.status === 0) {
      // Both real commands said so, in their own words.
      expect(transcript).toContain('PASS — 0 warning(s), nothing the app would refuse');
      expect(transcript).toContain('can be installed through the update path');
      expect(transcript).toContain('[ok] the green branch is a run, not an argument');
      // And the hedge travelled with the transcript.
      expect(transcript).toContain('does not claim');
    } else {
      expect(transcript).toContain('[INCOMPLETE]');
      // The host that could not answer is the release host, not the replica
      // this command just started: a `feed-unreachable` here would be this
      // file's own bug, and the branch must not excuse it.
      expect(transcript).toMatch(/installer-(unreachable|timeout)/u);
      expect(transcript).not.toContain('the verifier did not accept the replayed document');
      expect(transcript).not.toContain('[ok] the green branch is a run, not an argument');
    }
  });
});
