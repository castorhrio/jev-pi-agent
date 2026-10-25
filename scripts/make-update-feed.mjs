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
 * ## Usage
 *
 * ```bash
 * node scripts/make-update-feed.mjs --version 1.1.0 \
 *   --installer release/UCAD-Setup-1.1.0.exe \
 *   --out release/update-feed.json
 * ```
 *
 * `--notes <file>` reads release notes from a file; `--url <url>` overrides
 * the installer URL (a self-hosted mirror, say).
 */

import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
  writeFileSync(outPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');

  process.stdout.write(`${JSON.stringify(document, null, 2)}\n`);
  process.stdout.write(`\nwritten: ${outPath}\n`);
  process.stdout.write(
    'upload this file to the release as `update-feed.json` — the app reads it from the\n' +
      'release it belongs to, and the installer URL must resolve for that release.\n',
  );
}

// Only run as a command; importing the helpers must not publish anything.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
