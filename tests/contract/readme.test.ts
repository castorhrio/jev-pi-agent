/**
 * The README must not cite files that no longer exist.
 *
 * ## Why this exists
 *
 * A README drifts quietly. The counts rot first — this file used to promise
 * "121 tests" when the suite had passed 300, and "17 packages" when there
 * were 21. Both were wrong for a long time and neither was caught, because
 * prose is not compiled.
 *
 * Removing the counts is the right fix for the counts. This file is the fix
 * for the paths: a README that points a reader at `tests/contract/foo.test.ts`
 * is making a checkable claim, and the claim can be checked. A renamed or
 * deleted test is the most common way a README starts lying, and it is the
 * cheapest kind of lie to catch.
 *
 * It was deleted once, for a real reason: the code-only release removed
 * every root markdown file, and a gate whose subject does not exist cannot
 * fail — it is the appearance of coverage rather than coverage. It came back
 * with the README.
 *
 * Deliberately **not** asserted here:
 *  - the numbers in prose (they are gone from the README for this reason, and a
 *    rule about them would rot the same way), and
 *  - prose claims in general. Judging English is not a job a test should do.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const README = 'README.md';
const readme = existsSync(README) ? readFileSync(README, 'utf8') : '';

/**
 * Top-level directories a repo-relative path in this README can start with.
 * `docs/` is here because the README links the screenshots in it, and a broken
 * image link is exactly the kind of lie this file exists to catch.
 */
const TOP_LEVEL = ['apps/', 'packages/', 'tests/', 'scripts/', 'docs/'];

/** Extensions worth resolving on disk. Images count: a screenshot that 404s is
 *  a broken promise in the first thing a reader sees. */
const CITED_EXT = /\.(ts|tsx|md|json|css|png|jpe?g|gif|svg|webp)$/;

/** Every file under tests/, by basename, so a shorthand citation resolves. */
function testFilesByBasename(): Set<string> {
  const out = new Set<string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.add(entry.name);
    }
  };
  if (existsSync('tests')) walk('tests');
  return out;
}

type Citation = { text: string; kind: 'path' | 'test' };

/**
 * Classifies a cited path.
 *
 * The first version of this gate treated every `foo.test.ts` as repo-relative
 * and reported **14 false positives on the first run** — the evidence table
 * uses bare filenames as shorthand for `tests/contract/…`, and
 * `src/renderer/…` is relative to `apps/desktop/`. A gate that cries wolf gets
 * switched off, so the classification is explicit and anything ambiguous is
 * ignored rather than guessed at.
 *
 * Two citation forms count, because a modern README uses both: a backticked
 * path, and the target of a markdown link or image. URLs and anchors are not
 * repo-relative and are skipped.
 */
function classify(markdown: string): Citation[] {
  const out: Citation[] = [];
  const seen = new Set<string>();

  const candidates = [
    ...[...markdown.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]!),
    ...[...markdown.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]!),
  ];

  for (const raw of candidates) {
    const text = raw.trim().split('#')[0]!.trim();
    if (seen.has(text)) continue;
    if (!text || text.includes('*')) continue;
    if (/^[a-z][a-z0-9+.-]*:/i.test(text)) continue; // http:, mailto:, …
    if (!/^[\w./-]+$/.test(text)) continue;
    if (!CITED_EXT.test(text)) continue;
    seen.add(text);
    if (TOP_LEVEL.some((prefix) => text.startsWith(prefix))) {
      out.push({ text, kind: 'path' });
    } else if (/\.e?2?e?\.?test\.tsx?$/.test(text) || /^[\w.-]+\.test\.tsx?$/.test(text)) {
      out.push({ text, kind: 'test' });
    }
  }
  return out;
}

const citations = classify(readme);
const paths = citations.filter((c) => c.kind === 'path');
const tests = citations.filter((c) => c.kind === 'test');

describe('README', () => {
  it.skipIf(readme === '')('is present', () => {
    expect(readme.length).toBeGreaterThan(0);
  });

  it.skipIf(readme === '')('cites files, so the checks below are not vacuous', () => {
    expect(
      paths.length + tests.length,
      'no file citations were recognised in the README, so the existence checks ' +
        'below would pass without checking anything',
    ).toBeGreaterThan(0);
  });

  it.skipIf(readme === '')('only cites repo-relative paths that exist', () => {
    const missing = paths.filter((c) => !existsSync(c.text)).map((c) => c.text);
    expect(
      missing,
      `the README points at ${missing.length} path(s) that do not exist:\n  ` +
        `${missing.join('\n  ')}\nA reader following these gets nothing.`,
    ).toEqual([]);
  });

  it.skipIf(readme === '')('only names tests that still exist', () => {
    const known = testFilesByBasename();
    const missing = tests.filter((c) => !known.has(c.text)).map((c) => c.text);
    expect(
      missing,
      `the README names ${missing.length} test file(s) that no longer exist:\n  ` +
        `${missing.join('\n  ')}\nA renamed test is the most common way a README starts lying.`,
    ).toEqual([]);
  });

  it.skipIf(readme === '')('states no test count, which is the claim that rots', () => {
    // The failure this guards against is specific and already happened once:
    // "npm test  # 121 个契约 / 集成测试" sat there long after the number was
    // three times larger. The fix was to delete the number, not to update it.
    const claim = readme.match(/npm test[^\n]*#\s*[^\n]*\d+[^\n]*个/) ?? null;
    expect(
      claim,
      'the README states a test count next to `npm test`; counts rot silently, ' +
        'so link to the gate instead',
    ).toBeNull();
  });
});
