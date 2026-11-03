/**
 * Builds the release feed — the document the app's update check reads.
 *
 * ## Why this file exists
 *
 * The updater now refuses to install a package it cannot check, and a feed
 * that carries no SHA-256 cannot be installed from at all. That is the right
 * behaviour for the app, but it puts a requirement on whoever publishes a
 * release: the feed has to carry the hash of the exact file that was
 * uploaded, and a human pasting a digest into a JSON file is exactly the
 * step that gets skipped, or done from the wrong file.
 *
 * So the hash is computed here, from the installer that is about to be
 * uploaded, and written into the feed by the same command. The rule becomes
 * a mechanism instead of a reminder: run this, and the feed is checkable.
 *
 * ## The URL trap
 *
 * The installer URL must name the *release*, not `latest`. A feed published
 * as v1.0.0 pointed at `releases/latest/download/UCAD-Setup-1.0.0.exe`,
 * which resolves while 1.0.0 is the newest release and 404s the moment
 * 1.1.0 is published — the feed would then point at a file that is no longer
 * there. The default here is `releases/download/v<version>/<file>`, which
 * keeps working.
 *
 * ## Why the writer runs the reader's check
 *
 * `make-update-feed` and `verify-release-feed` are two halves of one rule, and
 * for one release they disagreed. The v1.0.0 feed was produced while the app
 * already refused to install a feed without a hash, and while
 * `verify-release-feed.mjs` already reported `no-sha256` and
 * `installer-latest-url` for it — but nothing asked the writer whether the
 * document it was about to publish was one the checker would accept. The
 * mistake was therefore made by a command, and found by a different command,
 * on a different machine, days later.
 *
 * So the judgement runs here, before the file is written: the document is
 * handed to `judgeFeedDocument()` — the same function the verifier and its
 * contract tests use, over the same rules imported from the app's own
 * `update-feed.ts` — and if it would fail, nothing is written and the command
 * exits 1. `--url` is the reason this is not theoretical: it exists so a
 * mirror can be used, and it is exactly the flag that can point a release back
 * at `releases/latest`.
 *
 * The refusal lists the findings the verifier would have printed, so the two
 * commands report a broken feed the same way.
 *
 * ## Usage
 *
 * ```bash
 * node scripts/make-update-feed.mjs --version 1.1.0 \
 *   --installer release/UCAD-Setup-1.1.0.exe \
 *   --out release/update-feed.json
 * ```
 *
 * `--notes <file>` reads release notes from a file; `--url <url>` overrides
 * the installer URL (a self-hosted mirror, say) and is still held to the
 * release-pinned rule above.
 *
 * Exit codes: 0 when the feed was written, 1 when the arguments are wrong or
 * the resulting document would fail the app's own feed check.
 */

import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  findingLine,
  hasFailure,
  judgeFeedDocument,
  loadAppRules,
} from './verify-release-feed.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Where this project's releases live. */
export const RELEASE_BASE_URL = 'https://github.com/castorhrio/jev-pi-agent/releases';

/**
 * The SHA-256 of a file, streamed.
 */
export function sha256OfFile(filePath) {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolvePromise(hash.digest('hex')));
  });
}

/**
 * The URL an installer of this version is published under.
 *
 * The version's own release, not `latest` — see the header for why that
 * difference matters.
 */
export function installerUrlFor(version, fileName, baseUrl = RELEASE_BASE_URL) {
  return `${baseUrl}/download/v${version}/${fileName}`;
}

/**
 * The feed document for an installer.
 *
 * `version` is the version without a leading `v`; the tag carries it, the
 * feed's own `version` field is compared with the app's version the same way
 * the app compares a dotted triple.
 */
export async function buildFeedDocument({
  version,
  notes,
  url,
  installerPath,
}) {
  if (typeof version !== 'string' || version.trim().length === 0) {
    throw new Error('a version is required (for example: --version 1.1.0)');
  }
  if (typeof installerPath !== 'string' || installerPath.length === 0) {
    throw new Error('an installer path is required (for example: --installer release/UCAD-Setup-1.1.0.exe)');
  }

  const absolute = resolve(root, installerPath);
  const stats = statSync(absolute);
  if (!stats.isFile()) {
    throw new Error(`not a file: ${installerPath}`);
  }

  const cleanVersion = version.trim().replace(/^v/, '');
  const document = {
    version: cleanVersion,
    notes: typeof notes === 'string' ? notes : undefined,
    url: url ?? installerUrlFor(cleanVersion, basename(absolute)),
    sha256: await sha256OfFile(absolute),
    size: stats.size,
  };

  // `undefined` is not JSON; the field is simply absent when there are no
  // notes, and the app reads a missing field as "no notes".
  return JSON.parse(JSON.stringify(document));
}

/**
 * What the app's own feed check says about a document about to be written.
 *
 * The version is passed as the *expected* version because that is the question
 * worth asking here: this build of the feed claims to be for `version`, so the
 * installer URL has to name that release and that file. A mirror URL is
 * welcome; a URL that points at another release, or at `latest`, is not a
 * mirror — it is the trap this file's header describes.
 *
 * Returned rather than thrown so the decision is testable without a filesystem
 * and so `main()` can print every finding rather than the first.
 */
export function feedRefusals(document, rules) {
  const version = typeof document?.version === 'string' ? document.version : '';
  return judgeFeedDocument(document, { expectedVersion: version, rules });
}

/** Reads `--flag value` pairs out of argv. */
function parseArgs(argv) {
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

async function main(argv) {
  const args = parseArgs(argv);
  const notesPath = typeof args.notes === 'string' ? args.notes : null;
  const notes = notesPath ? readFileSync(resolve(root, notesPath), 'utf8').trim() : undefined;

  const document = await buildFeedDocument({
    version: typeof args.version === 'string' ? args.version : '',
    notes,
    url: typeof args.url === 'string' ? args.url : undefined,
    installerPath: typeof args.installer === 'string' ? args.installer : '',
  });

  const out = typeof args.out === 'string' ? args.out : 'release/update-feed.json';
  const outPath = resolve(root, out);

  // The reader's check, run by the writer. A feed this refuses is a feed the
  // app would refuse to install from, or a URL that stops resolving — and the
  // cheapest moment to find that out is before the file exists, not after it
  // is uploaded and a different machine runs `verify-release-feed.mjs`.
  const refusals = feedRefusals(document, await loadAppRules());
  if (hasFailure(refusals)) {
    for (const entry of refusals) {
      process.stderr.write(`${findingLine(entry)}\n`);
    }
    process.stderr.write(
      `\nrefused: ${out} was not written — the app's own feed check rejects this document.\n` +
        'Fix the URL (a release tag, not `latest`) or the version, then run this again.\n',
    );
    process.exitCode = 1;
    return;
  }

  writeFileSync(outPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');

  process.stdout.write(`${JSON.stringify(document, null, 2)}\n`);
  process.stdout.write(`\nwritten: ${outPath}\n`);
  process.stdout.write(
    'upload this file to the release as `update-feed.json` — the app reads it from the\n' +
      'release it belongs to, and the installer URL must resolve for that release.\n',
  );
  // Two checks, and they are not the same check: this one judges the bytes that
  // are about to be uploaded (no network, so it works before the release
  // exists), and the one after it judges the bytes that were published.
  process.stdout.write(
    `check it before uploading: \`node scripts/verify-release-feed.mjs --feed-file ${out}\`\n` +
      'judges this exact document with the app’s own rules, offline.\n' +
      'then check the published bytes: `node scripts/verify-release-feed.mjs` (it fetches the\n' +
      'feed the shipped configuration names and judges it the way the app does).\n',
  );
}

// Only run as a command; importing the helpers must not publish anything.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
