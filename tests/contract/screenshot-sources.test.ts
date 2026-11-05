/**
 * The screenshot-drift command has to be able to say no.
 *
 * ## Why this file exists
 *
 * `screenshots.test.ts` next door already fails when a renderer source moved
 * after the screenshots were taken, and it does so by calling `drift()` — the
 * pure function. That covers the *judgement*. It does not cover the *command*:
 * `main()` could return 0 on a dirty report, print nothing, or exit before it
 * ever reached the comparison, and every case over there would stay green. The
 * gate and the thing it guards would go quiet together, which is exactly the
 * defect this repository has now found three times (`--steps 6` passing,
 * `skipIf` guards, the backtick that killed the layout gate at import).
 *
 * So these cases run the file. A throwaway tree is built with the script copied
 * into it — the script anchors its root to its own location, so a copy is a
 * whole repository as far as it is concerned — and the assertions are the ones
 * an operator needs: exit code, the file named on stderr, and the fact that
 * `--check` wrote nothing.
 *
 * ## Why a copy of the tree rather than the real one
 *
 * The interesting case is "a renderer source changed and nobody retook the
 * images". Producing that against the real tree means editing `styles.css` and
 * putting it back, which is a test that corrupts the working copy when it
 * fails halfway. A copy costs a few milliseconds and cannot leave the checkout
 * dirty.
 *
 * ## What is deliberately not asserted
 *
 * Whether the screenshots were actually retaken. `--write` records "the sources
 * are now these bytes" and a person can run it without looking at a pixel; the
 * script says so at the top of itself. What is asserted here is narrower and
 * checkable: the command goes red when the bytes moved, names what moved, and
 * refuses the two ways of asking that have no answer.
 */

import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'screenshot-sources.mjs');

/** Where the script lives inside a throwaway tree, so its root is that tree. */
const SCRIPT_IN_TREE = join('scripts', 'screenshot-sources.mjs');

/** A renderer source, relative to the tree root. */
const RENDERER_SOURCE = join('apps', 'desktop', 'src', 'renderer', 'src', 'styles.css');

/** A committed screenshot, relative to the tree root. */
const SCREENSHOT = join('docs', 'screenshots', 'empty.png');

/** The manifest the script writes, relative to the tree root. */
const MANIFEST = join('docs', 'screenshots', 'sources.json');

/** One command's outcome, exit code included. */
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
 * A tree the script can be run against: itself, one renderer source, one
 * screenshot.
 *
 * The PNG is not a real image on purpose — the script hashes bytes and never
 * decodes them, and a real 100 KB capture would make this file slower without
 * making it stronger. `screenshots.test.ts` is where "it is a PNG of the right
 * size" is judged.
 */
function tree(): string {
  const root = mkdtempSync(join(tmpdir(), 'ucad-shot-sources-'));
  tempDirs.push(root);
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'apps', 'desktop', 'src', 'renderer', 'src'), { recursive: true });
  mkdirSync(join(root, 'docs', 'screenshots'), { recursive: true });
  copyFileSync(SCRIPT, join(root, SCRIPT_IN_TREE));
  writeFileSync(join(root, RENDERER_SOURCE), '.app { color: #fff; }\n', 'utf8');
  writeFileSync(join(root, SCREENSHOT), 'not really a png', 'utf8');
  return root;
}

/**
 * Runs the script inside `root`; never throws on a non-zero exit.
 *
 * `spawnSync`, not `execFileSync`. `execFileSync` returns stdout and *discards*
 * stderr when the command succeeds — stderr only comes back attached to the
 * thrown error. That made every assertion about a green run's verdict line
 * unpassable: `--walkthrough` prints its paths on stdout and its
 * `walkthrough: N image(s) …` sentence on stderr, so the case below could only
 * ever see an empty string and the sentence it was written to pin was never
 * read. A test that cannot see half of what it asserts is the same shape as a
 * gate that cannot go red, one level down.
 */
function run(root: string, args: string[]): RunResult {
  const result = spawnSync(process.execPath, [join(root, SCRIPT_IN_TREE), ...args], {
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

/** The walkthrough document, relative to the tree root. */
const WALKTHROUGH = join('docs', 'state-walkthrough.md');

/** A second committed screenshot, so the walkthrough list has two entries. */
const SECOND_SCREENSHOT = join('docs', 'screenshots', 'states', 'loading.png');

/**
 * A tree that also carries a walkthrough document listing two images.
 *
 * The document is written here rather than copied from the repository because
 * this file is about the *command*: what it prints, what it refuses, and what
 * it does when the list and the manifest disagree. Whether the real document
 * lists the right ten images is `state-walkthrough.test.ts`'s question.
 */
function walkthroughTree(): string {
  const root = tree();
  mkdirSync(join(root, 'docs', 'screenshots', 'states'), { recursive: true });
  writeFileSync(join(root, SECOND_SCREENSHOT), 'also not really a png', 'utf8');
  writeFileSync(
    join(root, WALKTHROUGH),
    [
      '# 走查',
      '',
      '## 5 分钟走查脚本',
      '',
      '| # | 图 | 尺寸 |',
      '|---|---|---|',
      `| 1 | \`${SCREENSHOT.split('\\').join('/')}\` | 1440×900 |`,
      `| 2 | \`${SECOND_SCREENSHOT.split('\\').join('/')}\` | 768×700 |`,
      '',
      '## 判据',
      '',
      '正文。',
      '',
    ].join('\n'),
    'utf8',
  );
  return root;
}

/** A tree whose manifest has been written, i.e. a clean checkout. */
function recordedTree(): string {
  const root = tree();
  const written = run(root, ['--write']);
  expect(written.code, `--write failed: ${written.stderr}`).toBe(0);
  return root;
}

describe('the screenshot-drift command', () => {
  it('records a manifest and then passes on the tree it just recorded', () => {
    // The green direction first, so the red cases below are not satisfied by a
    // command that always fails.
    const root = recordedTree();
    const manifest = JSON.parse(readFileSync(join(root, MANIFEST), 'utf8')) as {
      renderer: Record<string, string>;
      screenshots: Record<string, string>;
    };
    expect(Object.keys(manifest.renderer)).toContain(RENDERER_SOURCE.split('\\').join('/'));
    expect(Object.keys(manifest.screenshots)).toContain(SCREENSHOT.split('\\').join('/'));

    const checked = run(root, ['--check']);
    expect(checked.code, `--check failed on a clean tree: ${checked.stderr}`).toBe(0);
    expect(checked.stdout).toContain('PASS');
    // The counts are asserted because "PASS" over an empty manifest and "PASS"
    // over two files read the same, and the first is a gate that stopped
    // looking.
    expect(checked.stdout).toContain('1 renderer source(s)');
    expect(checked.stdout).toContain('1 screenshot(s)');
  });

  it('exits 1 and names the renderer source that moved', () => {
    // The case the whole script exists for: a CSS rule changed and nobody
    // retook the images. This is the assertion `drift()` alone cannot make —
    // it proves the *command* reports it, not that a function could.
    const root = recordedTree();
    writeFileSync(join(root, RENDERER_SOURCE), '.app { color: #000; }\n', 'utf8');

    const checked = run(root, ['--check']);
    expect(checked.code, 'a changed renderer source must be a red run').toBe(1);
    expect(checked.stderr).toContain(
      `[drift] changed since the screenshots were taken: ${RENDERER_SOURCE.split('\\').join('/')}`,
    );
    expect(checked.stderr).toContain('FAIL');
    expect(checked.stdout, 'a red run must not also print PASS').not.toContain('PASS');
  });

  it('exits 1 and names a screenshot that was replaced without recording it', () => {
    // The other side of the same claim: the picture moved, the manifest did
    // not. A gate that only watched the sources would call this clean.
    const root = recordedTree();
    writeFileSync(join(root, SCREENSHOT), 'a different picture', 'utf8');

    const checked = run(root, ['--check']);
    expect(checked.code).toBe(1);
    expect(checked.stderr).toContain(
      `[drift] screenshot replaced without recording it: ${SCREENSHOT.split('\\').join('/')}`,
    );
  });

  it('exits 1 and names a renderer source nobody photographed', () => {
    // A new component is the quietest version of the defect: nothing changed,
    // something arrived, and the committed images are of a renderer that no
    // longer exists.
    const root = recordedTree();
    const added = join(root, 'apps', 'desktop', 'src', 'renderer', 'src', 'New.tsx');
    writeFileSync(added, 'export const New = () => null;\n', 'utf8');

    const checked = run(root, ['--check']);
    expect(checked.code).toBe(1);
    expect(checked.stderr).toContain(
      '[drift] new renderer source, never photographed: apps/desktop/src/renderer/src/New.tsx',
    );
  });

  it('writes nothing on the check path', () => {
    // `--check` and the default are the same judgement, and neither may record
    // an acknowledgement: a check that rewrites the manifest turns every red
    // run green on its second invocation, which is how a gate gets switched off.
    const root = recordedTree();
    const before = readFileSync(join(root, MANIFEST), 'utf8');
    writeFileSync(join(root, RENDERER_SOURCE), '.app { color: #000; }\n', 'utf8');

    expect(run(root, ['--check']).code).toBe(1);
    expect(run(root, []).code, 'the default must be the check, not a write').toBe(1);
    expect(readFileSync(join(root, MANIFEST), 'utf8'), '--check rewrote the manifest').toBe(before);
  });

  it('refuses --check together with --write instead of picking one', () => {
    // A caller that asked for both does not know what it wants. Resolving it by
    // precedence is how a gate records the drift it was meant to report.
    const root = recordedTree();
    const both = run(root, ['--check', '--write']);
    expect(both.code).toBe(1);
    expect(both.stderr).toContain('--check and --write ask for opposite things');
  });

  it('refuses an option it does not know, rather than defaulting to a check', () => {
    // `--wirte` silently checking is the same class of defect as `--steps 6`
    // passing: the caller believes one thing happened and another did.
    const root = recordedTree();
    const typo = run(root, ['--wirte']);
    expect(typo.code).toBe(1);
    expect(typo.stderr).toContain('unknown option(s): --wirte');
    expect(typo.stderr).toContain('usage: node scripts/screenshot-sources.mjs');
  });

  it('lists the walkthrough images, one path per line, and nothing else on stdout', () => {
    // The list is what a handover ships, so stdout has to be usable as an
    // argument list: `tar -czf walkthrough.tar.gz $(… --walkthrough)` is the
    // command the walkthrough document gives, and a verdict line on stdout
    // would become a file name.
    const root = walkthroughTree();
    expect(run(root, ['--write']).code).toBe(0);

    const listed = run(root, ['--walkthrough']);
    expect(listed.code, listed.stderr).toBe(0);
    expect(listed.stdout.trim().split('\n')).toEqual([
      SCREENSHOT.split('\\').join('/'),
      SECOND_SCREENSHOT.split('\\').join('/'),
    ]);
    expect(listed.stderr).toContain('2 image(s)');
    expect(listed.stderr).toContain(MANIFEST.split('\\').join('/'));
  });

  it('fails when the walkthrough document is gone, instead of handing over nothing', () => {
    const root = recordedTree();
    const listed = run(root, ['--walkthrough']);
    expect(listed.code).toBe(1);
    expect(listed.stdout.trim()).toBe('');
    expect(listed.stderr).toContain('no walkthrough images');
    expect(listed.stderr).toContain(WALKTHROUGH.split('\\').join('/'));
  });

  it('fails when an image it would ship is not in the manifest', () => {
    // A picture `--check` cannot say is still the current screen is a picture
    // nobody has verified, and shipping it is how a walker answers questions
    // about a screen the product no longer draws.
    const root = walkthroughTree();
    expect(run(root, ['--write']).code).toBe(0);
    writeFileSync(join(root, SECOND_SCREENSHOT), 'replaced after recording', 'utf8');
    rmSync(join(root, MANIFEST), { force: true });
    expect(run(root, ['--write']).code).toBe(0);
    writeFileSync(join(root, 'docs', 'screenshots', 'states', 'ghost.png'), 'ghost', 'utf8');
    writeFileSync(
      join(root, WALKTHROUGH),
      readFileSync(join(root, WALKTHROUGH), 'utf8').replace(
        '## 判据',
        '| 3 | `docs/screenshots/states/ghost.png` | 1440×900 |\n\n## 判据',
      ),
      'utf8',
    );

    const listed = run(root, ['--walkthrough']);
    expect(listed.code).toBe(1);
    expect(listed.stderr).toContain('[unrecorded] docs/screenshots/states/ghost.png');
  });

  it('refuses --walkthrough together with the two flags that judge or record', () => {
    const root = walkthroughTree();
    for (const other of ['--check', '--write']) {
      const both = run(root, ['--walkthrough', other]);
      expect(both.code, `--walkthrough ${other} was accepted`).toBe(1);
      expect(both.stderr).toContain('does not combine');
    }
  });

  it('fails when the manifest is missing, instead of comparing nothing', () => {
    // With no manifest every screenshot is unaccounted for, so "no drift" is
    // the one answer that cannot be right.
    const root = tree();
    const checked = run(root, ['--check']);
    expect(checked.code).toBe(1);
    expect(checked.stderr).toContain('is missing');
    expect(checked.stderr).toContain('--write');
  });
});
