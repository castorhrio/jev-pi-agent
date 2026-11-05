/**
 * The build's reminder has to arrive, and it has to stay a reminder.
 *
 * ## Why this file exists
 *
 * `screenshot-sources.test.ts` next door proves the *gate* can say no. This file
 * is about the other half of the same defect: the gate was red three rounds
 * running because the person who edited `renderer/src/**` found out from CI,
 * after the commit. `scripts/screenshot-drift-hint.mjs` runs after
 * `npm run build` and prints the same drift lines while that person is still at
 * the terminal.
 *
 * Two things can go wrong with a reminder, and both are silent:
 *
 *  1. **it stops arriving** — the `postbuild` hook is renamed, or `npm run dev`
 *     stops going through `npm run build`, and nobody notices because a build
 *     that says nothing looks exactly like a build with nothing to say;
 *  2. **it becomes a gate** — it exits non-zero, and now there are two verdicts
 *     about the same tree that can disagree (a bisect, a packaging run, a branch
 *     that is about to retake the images).
 *
 * So the cases below run the file as a subprocess against a throwaway tree, the
 * way the gate's own test does, and assert the exit code on all three paths plus
 * the wiring in `package.json`.
 *
 * ## What is deliberately not asserted
 *
 * That anybody reads it. A reminder that is printed and scrolled past is the
 * same as no reminder, and no test can see the difference. What is asserted is
 * narrower and checkable: the line is printed, at the moment the build finishes,
 * and it names the file that moved and the command that acknowledges it.
 */

import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const SCRIPTS = join(REPO_ROOT, 'scripts');
const HINT = join(SCRIPTS, 'screenshot-drift-hint.mjs');
const GATE = join(SCRIPTS, 'screenshot-sources.mjs');
const CONTRIBUTING = join(REPO_ROOT, 'CONTRIBUTING.md');

/** Where the two scripts live inside a throwaway tree, so their root is that tree. */
const HINT_IN_TREE = join('scripts', 'screenshot-drift-hint.mjs');
const GATE_IN_TREE = join('scripts', 'screenshot-sources.mjs');

/** A renderer source, relative to the tree root. */
const RENDERER_SOURCE = join('apps', 'desktop', 'src', 'renderer', 'src', 'styles.css');

/** The manifest the gate writes, relative to the tree root. */
const MANIFEST = join('docs', 'screenshots', 'sources.json');

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * A tree both scripts can be run against: themselves, one renderer source, one
 * screenshot.
 *
 * The hint imports `drift()`/`driftLines()` from the gate, so both files are
 * copied — that import is the point (one spelling of "styles.css changed"), and
 * a tree with only the hint in it would fail on the import rather than on
 * anything this file is about.
 */
function tree(): string {
  const root = mkdtempSync(join(tmpdir(), 'ucad-shot-hint-'));
  tempDirs.push(root);
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'apps', 'desktop', 'src', 'renderer', 'src'), { recursive: true });
  mkdirSync(join(root, 'docs', 'screenshots'), { recursive: true });
  copyFileSync(HINT, join(root, HINT_IN_TREE));
  copyFileSync(GATE, join(root, GATE_IN_TREE));
  writeFileSync(join(root, RENDERER_SOURCE), '.app { color: #fff; }\n', 'utf8');
  // Not a real PNG on purpose: both scripts hash bytes and never decode them.
  writeFileSync(join(root, 'docs', 'screenshots', 'empty.png'), 'not really a png', 'utf8');
  return root;
}

/** Runs one of the two scripts inside `root`; never throws on a non-zero exit. */
function run(root: string, script: string, args: string[] = []): RunResult {
  const result = spawnSync(process.execPath, [join(root, script), ...args], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    code: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/** A tree whose manifest is current, then one source edited afterwards. */
function driftedTree(): string {
  const root = tree();
  expect(run(root, GATE_IN_TREE, ['--write']).code, 'the gate could not record the tree').toBe(0);
  writeFileSync(join(root, RENDERER_SOURCE), '.app { color: #000; }\n', 'utf8');
  return root;
}

describe('the build reminds you to retake the screenshots', () => {
  it('runs after `npm run build`, which is what `dev` and `dist` both go through', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    // `postbuild` is npm's own lifecycle hook: it fires for `npm run build` and
    // for nothing else, which is exactly the moment the renderer was just
    // compiled and the person is still watching.
    expect(pkg.scripts.postbuild, 'package.json has no postbuild hook').toBe(
      'node scripts/screenshot-drift-hint.mjs',
    );
    expect(pkg.scripts.build, 'there is no build for postbuild to follow').toBeTruthy();
    // The two commands a person actually types. If either stopped going through
    // `npm run build`, the reminder would be wired to a script nobody runs.
    expect(pkg.scripts.dev, '`npm run dev` no longer builds first').toContain('npm run build');
    expect(pkg.scripts.dist, '`npm run dist` no longer builds first').toContain('npm run build');
  });

  it('names the file that moved and the command that acknowledges it', () => {
    const root = driftedTree();
    const hint = run(root, HINT_IN_TREE);

    expect(hint.code, 'the reminder failed the build').toBe(0);
    expect(hint.stdout, 'the reminder wrote to stdout, where a build log reads it as output').toBe(
      '',
    );
    expect(hint.stderr).toContain('changed since the screenshots were taken');
    expect(hint.stderr, 'the reminder does not name the file that moved').toContain(
      'apps/desktop/src/renderer/src/styles.css',
    );
    expect(hint.stderr, 'the reminder does not say what to run').toContain(
      'node scripts/screenshot-sources.mjs --write',
    );
    // The one sentence that keeps it from reading as a failure: a build that
    // prints a red-looking block and exits 0 teaches people to ignore red.
    expect(hint.stderr, 'the reminder does not say the build itself is fine').toContain(
      'this build is fine',
    );
  });

  it('says nothing at all when the screenshots are current', () => {
    const root = tree();
    expect(run(root, GATE_IN_TREE, ['--write']).code).toBe(0);
    const hint = run(root, HINT_IN_TREE);
    expect(hint.code).toBe(0);
    // Silence is the signal. A paragraph on every build is a paragraph nobody
    // reads, and the one run that mattered would be inside it.
    expect(hint.stdout).toBe('');
    expect(hint.stderr).toBe('');
  });

  it('still exits 0 when there is no manifest to compare against', () => {
    const root = tree();
    const hint = run(root, HINT_IN_TREE);
    expect(hint.code, 'a missing manifest failed the build').toBe(0);
    expect(hint.stderr, 'the reminder does not say the manifest is missing').toContain(
      'docs/screenshots/sources.json is missing',
    );
    expect(hint.stderr).toContain('node scripts/screenshot-sources.mjs --write');
  });

  it('writes nothing — the acknowledgement stays a deliberate act', () => {
    const root = driftedTree();
    const before = readFileSync(join(root, MANIFEST), 'utf8');
    expect(run(root, HINT_IN_TREE).code).toBe(0);
    expect(
      readFileSync(join(root, MANIFEST), 'utf8'),
      'the reminder recorded the drift it was meant to report',
    ).toBe(before);
    // And the gate is still red afterwards: the reminder did not quietly turn
    // the acknowledgement into a side effect of building.
    expect(run(root, GATE_IN_TREE, ['--check']).code).toBe(1);
  });

  it('prints the gate’s own lines, so the two cannot describe different files', () => {
    const root = driftedTree();
    const hint = run(root, HINT_IN_TREE);
    const gate = run(root, GATE_IN_TREE, ['--check']);

    const gateLines = gate.stderr
      .split('\n')
      .filter((line) => line.startsWith('[drift] '))
      .map((line) => line.slice('[drift] '.length));
    expect(gateLines.length, 'the gate printed no drift lines to compare against').toBeGreaterThan(
      0,
    );
    for (const line of gateLines) {
      expect(hint.stderr, `the reminder does not repeat the gate's line: ${line}`).toContain(
        `[screenshots]   ${line}`,
      );
    }
  });

  it('is documented where somebody editing the renderer will look', () => {
    const contributing = readFileSync(CONTRIBUTING, 'utf8');
    const at = contributing.indexOf('## Working on the interface');
    expect(at, 'CONTRIBUTING.md has no "Working on the interface" section').toBeGreaterThan(-1);
    const next = contributing.indexOf('\n## ', at + 1);
    const section = contributing.slice(at, next === -1 ? undefined : next);

    expect(
      section,
      'the interface section never says that changing the renderer means retaking the screenshots',
    ).toContain('node scripts/screenshot-sources.mjs --write');
    expect(section, 'the section does not name the directory that triggers it').toContain(
      'renderer/src/',
    );
  });
});
