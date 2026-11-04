/**
 * The one line that runs the layout gate, compared with the machine that runs it green.
 *
 * ## Why this file exists
 *
 * `tests/contract/layout.test.ts` is the only gate in this repository that launches a real
 * Chromium, so it is the one a contributor's machine fails first — and the failure it prints
 * does not mention a display. On a headless box the run ends in about half a second with
 * `Error: the layout probe produced no result` and `Missing X server or $DISPLAY` under it,
 * which reads like a broken probe. The correct answer (`xvfb-run`) was written nowhere a
 * contributor would read it, so the first failure a newcomer meets costs them a round.
 *
 * The obvious fix — write the command into `CONTRIBUTING.md` — has a defect of its own, and
 * it is the shape this repository has now been caught in four times: a document that quotes
 * a command nobody re-verifies. Two details in that command decide whether it works:
 *
 *  - **the screen size.** `xvfb-run`'s default screen is narrower than the widest window the
 *    gate asks for, and a window larger than the display is clamped to it. The gate then
 *    fails its own "reports the width it actually measured" assertion — a red gate about the
 *    virtual display, not about the interface. So the size is part of the test environment
 *    and cannot be left to a default;
 *  - **the build.** `npm test` runs `build:packages` as `pretest`; `npx vitest` does not, and
 *    the suite resolves `@ucad/*` to `packages/<name>/dist`. A reader who copies only the vitest
 *    half measures whatever the last build left on disk.
 *
 * So this file compares the document with the two things that actually decide it:
 *
 *  - `.github/workflows/ci.yml` — the command CI wraps `npm test` in, and the flags it uses.
 *    The document is not allowed to carry its own idea of the screen size: the number is
 *    read out of the workflow, so CI moving it moves this line too;
 *  - `tests/contract/layout.test.ts` itself — its `GATED_WIDTHS` list. The screen CI picks
 *    has to *contain* the widest window the gate requests, and that is checked here rather
 *    than assumed from a comment.
 *
 * The symptom is not compared with text at all: one case launches the real Electron probe with
 * `DISPLAY` removed and requires it to fail with the sentence `CONTRIBUTING.md` quotes. A
 * document describing a symptom the machine no longer prints is the same defect one level
 * down, and only the machine can answer it.
 *
 * ## What is deliberately not asserted
 *
 * That the gate passes here. It needs a display that answers, and a headless checkout proves
 * nothing about geometry — that is CI's job, and `ci-gate-local.test.ts` already pins that
 * `npm run verify:gates` runs CI's own steps rather than a copy of them.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const CONTRIBUTING_PATH = join(REPO_ROOT, 'CONTRIBUTING.md');
const CI_PATH = join(REPO_ROOT, '.github', 'workflows', 'ci.yml');
const LAYOUT_TEST_PATH = join(REPO_ROOT, 'tests', 'contract', 'layout.test.ts');
const PROBE_PATH = join(REPO_ROOT, 'scripts', 'layout-probe.mjs');

/** The gate the document is about, as a path a reader can copy. */
const LAYOUT_GATE = 'tests/contract/layout.test.ts';

/** The sentence Chromium prints when there is no display to open. */
const NO_DISPLAY_SENTENCE = 'Missing X server or $DISPLAY';

/** The wrapper the gate prints around it, which is what a contributor actually sees. */
const PROBE_FAILURE = 'the layout probe produced no result';

const read = (path: string): string => (existsSync(path) ? readFileSync(path, 'utf8') : '');

/**
 * The command CI wraps the unit suite in.
 *
 * `null` when the workflow has no xvfb step at all — reported rather than treated as
 * "nothing to compare", because a workflow that dropped the display would leave the document
 * telling readers to do something CI itself no longer does.
 */
function ciGateCommand(ci: string): string | null {
  for (const line of ci.split('\n')) {
    if (line.includes('xvfb-run') && line.includes('npm test')) return line.trim();
  }
  return null;
}

/** The `--server-args="…"` value of an `xvfb-run` command line. */
function serverArgs(command: string): string | null {
  return /--server-args="([^"]*)"/u.exec(command)?.[1] ?? null;
}

/** A virtual screen as `…x…`, or `null` when the argument string does not carry one. */
function screenSize(args: string | null): { width: number; height: number } | null {
  const match = args === null ? null : /\b(\d+)x(\d+)/u.exec(args);
  if (match === null || match === undefined) return null;
  return { width: Number(match[1]), height: Number(match[2]) };
}

/**
 * The line `CONTRIBUTING.md` tells a reader to type to run the layout gate alone.
 *
 * One line, deliberately: a command split over a backslash continuation is a command whose
 * copy-and-paste behaviour depends on the reader's shell.
 */
function documentedGateCommand(markdown: string): string | null {
  for (const line of markdown.split('\n')) {
    if (line.includes('vitest run') && line.includes(LAYOUT_GATE)) return line.trim();
  }
  return null;
}

/** The fenced block containing a line, or `null` when the command sits outside any block. */
function enclosingBlock(markdown: string, line: string): string | null {
  const at = markdown.indexOf(line);
  if (at === -1) return null;
  const open = markdown.lastIndexOf('```', at);
  const close = markdown.indexOf('\n```', at);
  if (open === -1 || close === -1) return null;
  return markdown.slice(open, close);
}

/**
 * The widths the layout gate asks Chromium for, read out of the gate itself.
 *
 * `GATED_WIDTHS` is a local in that file, so this is a text read — the only honest kind here,
 * because the value decides a document line rather than a runtime behaviour. A gate that
 * renames or reshapes the list is reported, not silently skipped: an unreadable width list
 * would make the size comparison below compare nothing.
 */
function gatedWidths(layoutSource: string): number[] | null {
  const match = /const GATED_WIDTHS = \[([\d,\s]*)\]/u.exec(layoutSource);
  if (match === null || match === undefined) return null;
  const widths = match[1]!
    .split(',')
    .map((entry) => Number.parseInt(entry.trim(), 10))
    .filter((entry) => Number.isFinite(entry));
  return widths.length === 0 ? null : widths;
}

/**
 * Every way the document's line can stop being the line that works.
 *
 * Empty means a reader typing it gets the same environment CI gets. The messages name the
 * thing that moved, because the reader fixing it is looking at two files, not one.
 */
function commandProblems(
  contributing: string,
  ci: string,
  layoutSource: string,
): string[] {
  const problems: string[] = [];

  const ciCommand = ciGateCommand(ci);
  if (ciCommand === null) {
    problems.push(
      '.github/workflows/ci.yml: no xvfb step wrapping `npm test` any more, so this document ' +
        'is the only place a display is specified and nothing decides it',
    );
  }

  const documented = documentedGateCommand(contributing);
  if (documented === null) {
    problems.push(
      'CONTRIBUTING.md: does not give one command line that runs the layout gate alone, so a ' +
        'headless machine meets a red gate it cannot explain',
    );
    return problems;
  }

  if (!documented.includes('xvfb-run')) {
    problems.push(
      `CONTRIBUTING.md: runs the layout gate without a display (${documented}), and the gate ` +
        'launches a real Chromium',
    );
  }
  if (!documented.includes('--auto-servernum')) {
    problems.push(
      `CONTRIBUTING.md: does not pass --auto-servernum, so two readers on one machine ask for ` +
        'the same display number and one of them gets a display that is not theirs',
    );
  }
  if (!documented.includes('ELECTRON_DISABLE_SANDBOX=1')) {
    problems.push(
      'CONTRIBUTING.md: the line does not carry ELECTRON_DISABLE_SANDBOX=1, which CI sets in ' +
        'the env: of the same step; without it Chromium aborts on a rootless host',
    );
  }

  const ciSize = screenSize(serverArgs(ciCommand ?? ''));
  const docSize = screenSize(serverArgs(documented));
  if (serverArgs(ciCommand ?? '') !== null && serverArgs(documented) === null) {
    problems.push(
      'CONTRIBUTING.md: asks for no --server-args, and xvfb-run\'s default screen is narrower ' +
        'than the window the gate requests, so the gate is clamped and fails its own ' +
        'measurement assertion',
    );
  } else if (ciSize !== null && docSize !== null && (docSize.width !== ciSize.width || docSize.height !== ciSize.height)) {
    problems.push(
      `CONTRIBUTING.md: sizes the virtual display ${docSize.width}x${docSize.height}, while ` +
        `CI sizes the same gate ${ciSize.width}x${ciSize.height} — one number, in two places`,
    );
  }

  const widths = gatedWidths(layoutSource);
  if (widths === null) {
    problems.push(
      `${LAYOUT_GATE}: no readable \`const GATED_WIDTHS = […]\`, so this check cannot prove ` +
        'the screen it asks for is big enough for the windows the gate requests',
    );
  } else if (ciSize !== null) {
    const widest = Math.max(...widths);
    if (ciSize.width < widest) {
      problems.push(
        `.github/workflows/ci.yml: gives the gate a ${ciSize.width}px screen and the gate asks ` +
          `for ${widest}px, so every run is measuring a clamped window`,
      );
    }
  }

  const block = enclosingBlock(contributing, documented);
  if (block === null) {
    problems.push(
      `CONTRIBUTING.md: the layout gate line is not inside a fenced block, so it is prose ` +
        'rather than something a reader copies',
    );
  } else if (!block.includes('npm run build:packages')) {
    problems.push(
      'CONTRIBUTING.md: the block that runs the gate with `npx vitest` does not say to run ' +
        '`npm run build:packages` first, and the suite resolves @ucad/* to packages/*/dist',
    );
  }

  for (const sentence of [NO_DISPLAY_SENTENCE, PROBE_FAILURE]) {
    if (!contributing.includes(sentence)) {
      problems.push(
        `CONTRIBUTING.md: no longer names the failure a displayless machine prints (${sentence}), ` +
          'so the reader cannot tell a missing display from a broken gate',
      );
    }
  }

  return problems;
}

/**
 * What a real Electron prints when it is given no display.
 *
 * The child env is copied with `DISPLAY`, `WAYLAND_DISPLAY` and `XAUTHORITY` removed, so the
 * answer does not depend on whether the host running the suite happens to have a display:
 * on a desktop machine this case must fail the same way it does on CI.
 * `ELECTRON_RUN_AS_NODE` is removed for the reason `layout.test.ts` gives — with it set, the
 * probe runs under plain Node and dies on an import instead of on the display.
 */
function noDisplayProbeFailure(): { code: number | null; stderr: string } {
  const electronPath = createRequire(import.meta.url)('electron') as string;
  const env: Record<string, string | undefined> = { ...process.env };
  for (const key of ['DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'ELECTRON_RUN_AS_NODE']) {
    delete env[key];
  }
  const child = spawnSync(electronPath, [PROBE_PATH], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env,
    timeout: 120_000,
  });
  return { code: child.status, stderr: (child.stderr ?? '') + (child.stdout ?? '') };
}

/** The blank-line-separated paragraph of `text` that contains `needle`. */
function paragraphContaining(text: string, needle: string): string | null {
  for (const paragraph of text.split(/\n\s*\n/u)) {
    if (paragraph.includes(needle)) return paragraph;
  }
  return null;
}

describe('the layout gate as one copyable line', () => {
  it('finds the three files it compares, so the checks below are not vacuous', () => {
    expect(existsSync(CONTRIBUTING_PATH), 'CONTRIBUTING.md is missing').toBe(true);
    expect(existsSync(CI_PATH), '.github/workflows/ci.yml is missing').toBe(true);
    expect(existsSync(LAYOUT_TEST_PATH), LAYOUT_GATE + ' is missing').toBe(true);
    expect(gatedWidths(read(LAYOUT_TEST_PATH)), 'the gate’s width list is unreadable').not.toBeNull();
    expect(ciGateCommand(read(CI_PATH)), 'CI’s xvfb step is unreadable').not.toBeNull();
    expect(documentedGateCommand(read(CONTRIBUTING_PATH)), 'the documented line is unreadable').not.toBeNull();
  });

  it('asks for the same display CI gives the same gate', () => {
    const problems = commandProblems(read(CONTRIBUTING_PATH), read(CI_PATH), read(LAYOUT_TEST_PATH));
    expect(
      problems,
      `the document and the machine that runs this gate disagree:\n  ${problems.join('\n  ')}`,
    ).toEqual([]);
  });

  it('reports a line that dropped the display wrapper', () => {
    const contributing = read(CONTRIBUTING_PATH);
    const documented = documentedGateCommand(contributing)!;
    // Only the wrapper, not its flags: removing both `xvfb-run` and
    // `--auto-servernum` in one mutation reports two true problems and proves nothing about
    // which assertion caught which.
    const stripped = documented.replace('xvfb-run ', '');
    expect(stripped).not.toBe(documented);
    const problems = commandProblems(
      contributing.replace(documented, stripped),
      read(CI_PATH),
      read(LAYOUT_TEST_PATH),
    );

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('without a display');
  });

  it('reports a screen size that moved away from the one CI uses', () => {
    const contributing = read(CONTRIBUTING_PATH);
    const documented = documentedGateCommand(contributing)!;
    const resized = documented.replace('-screen 0 1920x1080x24', '-screen 0 1920x1000000x24');
    expect(resized).not.toBe(documented);

    const problems = commandProblems(
      contributing.replace(documented, resized),
      read(CI_PATH),
      read(LAYOUT_TEST_PATH),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('one number, in two places');
  });

  it('reports a screen narrower than the widest window the gate asks for', () => {
    // The check that decides the size by measurement instead of by a comment. Both sides move
    // together, so the only thing left failing is the one that matters: a display narrower
    // than the gate's widest target, which the gate itself reports as a clamped measurement.
    const contributing = read(CONTRIBUTING_PATH).replace(
      '-screen 0 1920x1080x24',
      '-screen 0 1280x1024x24',
    );
    const ci = read(CI_PATH).replace('-screen 0 1920x1080x24', '-screen 0 1280x1024x24');
    const problems = commandProblems(contributing, ci, read(LAYOUT_TEST_PATH));

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('measuring a clamped window');
  });

  it('reports the build precondition being dropped from the block', () => {
    const contributing = read(CONTRIBUTING_PATH).replace('npm run build:packages\n', '');
    const problems = commandProblems(contributing, read(CI_PATH), read(LAYOUT_TEST_PATH));

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('build:packages');
  });

  it('names the platform whose symptom it quotes', () => {
    const contributing = read(CONTRIBUTING_PATH);
    const paragraph = paragraphContaining(contributing, NO_DISPLAY_SENTENCE);

    expect(paragraph, `CONTRIBUTING.md no longer quotes ${NO_DISPLAY_SENTENCE}`).not.toBeNull();
    expect(contributing).toContain(PROBE_FAILURE);
    // Windows and macOS have no `$DISPLAY` to miss. A paragraph that prints a Linux symptom
    // without saying so sends a reader on those platforms looking for a cause that is not
    // there, which is the failure shape this repository keeps meeting.
    expect(paragraph!, 'the symptom is quoted without naming its platform').toContain('Linux');
  });

  it.runIf(process.platform === 'linux')(
    'prints that symptom when the display is taken away',
    () => {
      // The one case here that asks a machine rather than a document. `CI runs on
      // ubuntu-latest`, so this is not a branch that goes quiet where it matters: it is the
      // same Linux the document is writing about.
      const failure = noDisplayProbeFailure();

      // A launch with nothing to open must not pretend it ran.
      expect(failure.code, `the probe exited ${String(failure.code)} with no display`).not.toBe(0);
      expect(failure.stderr).toContain(NO_DISPLAY_SENTENCE);

      const contributing = read(CONTRIBUTING_PATH);
      expect(contributing).toContain(NO_DISPLAY_SENTENCE);
      expect(contributing).toContain(PROBE_FAILURE);
    },
  );
});
