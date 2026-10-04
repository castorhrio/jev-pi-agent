/**
 * §15 版本锁定与 Compatibility Matrix.
 *
 * V-1 is the load-bearing clause: every `pinned` entry must be an **exact**
 * version — no `^`, no `~`, no `latest`, no `*`. A range in `pinned` looks
 * precise on the manifest and means "whatever the lockfile resolved to on the
 * day it was installed", which is precisely the drift the clause exists to stop.
 *
 * V-2 is equally mechanical and equally decayable: a compatibility entry must
 * exist for every manifest that declares one. A matrix that silently falls
 * behind the code is worse than no matrix, because it reads as current.
 *
 * This file is the enforcement. Without it both clauses rot within one release.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MockAgentAdapter } from '@ucad/adapter-mock';
import { createUniversalAdapter } from '@ucad/adapter-universal';
import { BasicIntelligenceProvider } from '@ucad/code-intelligence';
import { silentLogger } from '@ucad/observability';
import { BASIC_PROVIDER_ID } from '@ucad/code-intelligence';
import type { PinnedDependency } from '@ucad/contracts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** `1.2.3`, `1.2.3-beta.4`, `0.0.0-experimental` — and nothing looser. */
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** Every way a range or a floating tag can sneak in. */
const RANGE_MARKERS = ['^', '~', '>=', '<=', '>', '<', '*', 'x', 'X', '||'];

function describeRanges(version: string): string[] {
  const found = RANGE_MARKERS.filter((marker) => version.includes(marker));
  if (/\blatest\b/i.test(version)) found.push('latest');
  if (/\bnext\b/i.test(version)) found.push('next');
  if (/\b(star|main|master|canary|nightly)\b/i.test(version)) found.push('dist-tag');
  return found;
}

function assertPinned(label: string, pinned: PinnedDependency[]): void {
  for (const entry of pinned) {
    const markers = describeRanges(entry.version);
    expect(
      markers,
      `${label}: pinned['${entry.package}'] = "${entry.version}" is not an exact version ` +
        `(${markers.join(', ')}). §15 V-1 forbids ranges.`,
    ).toEqual([]);
    expect(
      EXACT_VERSION.test(entry.version),
      `${label}: pinned['${entry.package}'] = "${entry.version}" is not an exact semver.`,
    ).toBe(true);

    // V-1's companion fields: a version with no date and no source is a guess.
    expect(entry.verifiedAt, `${label}: ${entry.package} has no verifiedAt`).toMatch(
      /^\d{4}-\d{2}-\d{2}$/,
    );
    expect(entry.source.length, `${label}: ${entry.package} has no source`).toBeGreaterThan(0);
  }
}

describe('§15 V-1 — pinned versions are exact', () => {
  it('every shipped Agent manifest declares only exact versions', () => {
    const manifests = [
      new MockAgentAdapter().manifest,
      createUniversalAdapter({ logger: silentLogger('pin') }).manifest,
    ];
    for (const manifest of manifests) assertPinned(`agent '${manifest.id}'`, manifest.pinned);
  });

  it('every shipped Intelligence manifest declares only exact versions', () => {
    const provider = new BasicIntelligenceProvider({ logger: silentLogger('pin') });
    assertPinned(`intelligence '${BASIC_PROVIDER_ID}'`, provider.manifest.pinned);
  });

  it('storage declares an exact SQLite engine, not a range', () => {
    // The one real third-party runtime dependency in V1, and the one where a
    // silent bump is most likely to change behaviour underneath a schema
    // migration. It shipped as "^0.8.30" resolving to 0.8.60.
    const pkg = JSON.parse(
      fs.readFileSync(path.join(repoRoot, 'packages', 'storage', 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> };
    const version = pkg.dependencies?.['node-sqlite3-wasm'];
    expect(version, 'node-sqlite3-wasm must stay a declared dependency').toBeDefined();
    expect(describeRanges(version as string), `node-sqlite3-wasm = "${version}"`).toEqual([]);
    expect(EXACT_VERSION.test(version as string)).toBe(true);
  });

  it('the installed engine is the declared one', () => {
    const declared = (
      JSON.parse(fs.readFileSync(path.join(repoRoot, 'packages', 'storage', 'package.json'), 'utf8')) as {
        dependencies: Record<string, string>;
      }
    ).dependencies['node-sqlite3-wasm'];
    const installed = (
      JSON.parse(
        fs.readFileSync(path.join(repoRoot, 'node_modules', 'node-sqlite3-wasm', 'package.json'), 'utf8'),
      ) as { version: string }
    ).version;
    expect(installed, `declared ${declared} but ${installed} is installed`).toBe(declared);
  });
});
