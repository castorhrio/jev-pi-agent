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
// Imported, not spawned: the two questions below are about strings — does every
// line carry the prefix, does the tail survive a long report — and a subprocess
// would answer them through a pipe. The scripts are ESM with no side effects at
// import time (the hint's `main()` is behind a `process.argv[1]` guard), so
// importing them runs nothing.
import { hintLines } from '../../scripts/screenshot-drift-hint.mjs';
import { buildManifest, drift, driftLines } from '../../scripts/screenshot-sources.mjs';

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

// ---------------------------------------------------------------------------
// The reminder is not the gate, and the document has to say so
// ---------------------------------------------------------------------------

/**
 * ## Why this block exists
 *
 * The case above asserts that `CONTRIBUTING.md` tells a reader to retake the
 * screenshots. It does not assert the boundary, and the boundary is the part
 * that gets misread: `postbuild` is npm's own lifecycle hook, so the reminder
 * fires for `npm run build` and for **nothing else**. `npm test`,
 * `npm run test:e2e` and `npm run typecheck` all go around it.
 *
 * That is fine — a reminder is not a gate — but it is only fine while the
 * document says it. A reader who believes the reminder covers every entry point
 * will edit `renderer/src/**`, run `npm test`, see nothing, and conclude the
 * screenshots are current. The gate then goes red in CI, which is exactly the
 * failure this whole file was written to move earlier.
 *
 * So the sentence is pinned verbatim. It is one sentence, in the section a
 * person editing the renderer is already reading, and it names the command that
 * *is* the gate — because "this is not a gate" without "here is the gate" is a
 * disclaimer rather than an instruction.
 */

/**
 * The sentence `CONTRIBUTING.md` has to carry, word for word.
 *
 * Compared against the section with its line breaks collapsed, because the
 * document wraps its prose at about a hundred columns and a sentence that is
 * asserted with its wrapping baked in goes red the first time somebody reflows
 * the paragraph. The words are the contract; where the line ends is not.
 */
const REMINDER_BOUNDARY =
  'If you change `renderer/src/**` and run only `npm test` without `npm run build`, you will ' +
  'not see this reminder; `node scripts/screenshot-sources.mjs --check` is the gate.';

/** The same text with every run of whitespace collapsed to one space. */
function unwrapped(text: string): string {
  return text.replace(/\s+/gu, ' ');
}

/** The `## Working on the interface` section of `CONTRIBUTING.md`, or `''`. */
function interfaceSection(contributing: string): string {
  const at = contributing.indexOf('## Working on the interface');
  if (at === -1) return '';
  const next = contributing.indexOf('\n## ', at + 1);
  return contributing.slice(at, next === -1 ? undefined : next);
}

/**
 * Every way the interface section fails to state the boundary.
 *
 * A pure function of the document, so the red direction is driven by deleting
 * the sentence rather than argued about.
 */
function boundaryProblems(contributing: string): string[] {
  const section = interfaceSection(contributing);
  if (section.length === 0) {
    return ['CONTRIBUTING.md has no "## Working on the interface" section'];
  }
  const problems: string[] = [];
  if (!unwrapped(section).includes(REMINDER_BOUNDARY)) {
    problems.push(
      'CONTRIBUTING.md: the interface section does not say that the build reminder is not the ' +
        'gate — a reader who runs `npm test` instead of `npm run build` sees nothing and ' +
        'concludes the screenshots are current',
    );
  }
  // The three entry points that go around `postbuild`, named so the sentence
  // cannot be softened into "some commands do not print it".
  for (const command of ['npm test', 'npm run test:e2e', 'npm run typecheck']) {
    if (!section.includes(command)) {
      problems.push(
        `CONTRIBUTING.md: the interface section does not name \`${command}\` among the entry ` +
          'points that go around `postbuild`',
      );
    }
  }
  return problems;
}

describe('the reminder is documented as a reminder, not as a gate', () => {
  it('says in the interface section which entry points do not print it', () => {
    const problems = boundaryProblems(readFileSync(CONTRIBUTING, 'utf8'));
    expect(
      problems,
      `CONTRIBUTING.md does not state the reminder's boundary:\n  ${problems.join('\n  ')}`,
    ).toEqual([]);
  });

  it('reports the section when the sentence is deleted', () => {
    // The edit this case exists for: somebody tidies the paragraph and drops the
    // one sentence that says the reminder is not a gate.
    const contributing = readFileSync(CONTRIBUTING, 'utf8');
    const broken = contributing.replace(
      /If you change[\s\S]*?is the gate\./u,
      'The build prints a reminder.',
    );
    expect(broken, 'the sentence this case deletes is gone from CONTRIBUTING.md').not.toBe(
      contributing,
    );
    const problems = boundaryProblems(broken);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('is not the gate');
  });

  it('reports a section that lost the whole paragraph', () => {
    const contributing = readFileSync(CONTRIBUTING, 'utf8');
    const broken = contributing.replace(interfaceSection(contributing), '');
    expect(broken).not.toBe(contributing);
    expect(boundaryProblems(broken)).toEqual([
      'CONTRIBUTING.md has no "## Working on the interface" section',
    ]);
  });
});

// ---------------------------------------------------------------------------
// A report with more than one file in it still reads
// ---------------------------------------------------------------------------

/**
 * ## Why this block exists
 *
 * Every case above drifts **one** file, and one file is the easy case: the
 * block is a header, one line, and a tail, and nothing about it can be
 * misread. The real tree has thirty-four renderer sources, and the round that
 * retook the screenshots changed several of them at once — so the question this
 * block asks is the one a person actually faces: when the report is long, does
 * every line still say what it is, and does the sentence that says "this build
 * is fine" survive at the bottom?
 *
 * Two things are asserted, both about the shape of the block rather than its
 * wording:
 *
 *  - every line carries the `[screenshots]` prefix, so a long report pasted
 *    into an issue is still greppable and still not mistaken for a failure;
 *  - the count is `driftLines().length + 4` — one header, three tail lines —
 *    and the tail is the last three lines whatever the count is. A block that
 *    grew a line per file and lost its tail would be a wall of file names with
 *    no instruction at the end of it.
 *
 * The report is built from a real tree rather than hand-written, because a
 * hand-written report is a fixture that can drift from what `drift()` returns.
 */

/** The renderer source directory, relative to a throwaway tree. */
const RENDERER_DIR = join('apps', 'desktop', 'src', 'renderer', 'src');

/** A tree with `count` renderer sources in it, all of them distinct. */
function multiSourceTree(count: number): string {
  const root = tree();
  for (let index = 1; index < count; index += 1) {
    writeFileSync(
      join(root, RENDERER_DIR, `panel-${index}.tsx`),
      `export const panel${index} = ${index};\n`,
      'utf8',
    );
  }
  return root;
}

/** A report with `count` changed sources and nothing else, for the long case. */
function longReport(count: number): Record<string, string[]> {
  return {
    sourcesChanged: Array.from(
      { length: count },
      (_, index) => `${RENDERER_DIR.split('\\').join('/')}/panel-${index}.tsx`,
    ),
    sourcesAdded: [],
    sourcesRemoved: [],
    screenshotsChanged: [],
    screenshotsMissing: [],
    screenshotsUnlisted: [],
  };
}

describe('a drift report with several files in it still reads', () => {
  it('prefixes every line and keeps the tail, with five files changed at once', () => {
    const root = multiSourceTree(5);
    const manifest = buildManifest(root);
    // Every source edited after the manifest was written: the shape of a round
    // that touched five components and retook the images afterwards.
    for (let index = 0; index < 5; index += 1) {
      const file = index === 0 ? RENDERER_SOURCE : join(RENDERER_DIR, `panel-${index}.tsx`);
      writeFileSync(join(root, file), `/* edited ${index} */\n`, 'utf8');
    }

    const report = drift(manifest, root);
    const drift_ = driftLines(report);
    expect(drift_.length, 'the report does not name all five files').toBe(5);

    const lines = hintLines(report);
    // One header, one line per file, three tail lines. The number is asserted
    // rather than the shape, because "the tail is still there" is exactly what
    // a block that grew a line per file would lose.
    expect(lines.length, 'the block is not header + files + tail').toBe(drift_.length + 4);

    for (const line of lines) {
      expect(line, `this line does not carry the prefix: ${line}`).toMatch(/^\[screenshots\] /u);
    }
    for (const line of drift_) {
      expect(lines, `the block dropped the gate's line: ${line}`).toContain(
        `[screenshots]   ${line}`,
      );
    }

    const tail = lines.slice(-3).join('\n');
    expect(tail, 'the block no longer says the build itself is fine').toContain('this build is fine');
    expect(tail, 'the block no longer says what to run').toContain(
      'node scripts/screenshot-sources.mjs --write',
    );
  });

  it('keeps the tail when the report is long enough to scroll', () => {
    // The real tree has thirty-four renderer sources. This is the fallback the
    // five-file case cannot show: at forty lines the block is a wall of file
    // names, and the three lines that say "this build is fine, run --write" are
    // the only part a reader needs. They are the last three, always.
    const lines = hintLines(longReport(40));
    expect(lines.length).toBe(40 + 4);
    expect(lines.slice(-3).join('\n')).toContain('this build is fine');
    expect(lines.slice(-3).join('\n')).toContain('--write');
    // And the header is still the first line, so the block still opens by
    // saying what it is.
    expect(lines[0]).toContain('older than the renderer sources');
  });

  it('is not vacuous: the report really has five files and the block really has a tail', () => {
    // A `drift()` that returned empty lists would make the count assertion above
    // `0 + 4` and pass over nothing.
    const root = multiSourceTree(5);
    const manifest = buildManifest(root);
    expect(Object.keys(manifest.renderer).length, 'the tree has fewer than five sources').toBe(5);
    const clean = hintLines(drift(manifest, root));
    // A clean report is not printed at all by `main()`, but `hintLines` still
    // answers with header + tail: the count above is only meaningful because
    // this one is 4.
    expect(clean.length).toBe(4);
  });
});
