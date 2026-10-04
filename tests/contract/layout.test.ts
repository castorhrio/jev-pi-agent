/**
 * The layout gate: the first one in this repository that measures anything.
 *
 * ## Why
 *
 * Every other UI gate here runs in happy-dom, which has no typography and no
 * layout engine — `getBoundingClientRect()` is always 0. The consequence is
 * recorded in the gates themselves: "the main column collapsed
 * to 0px", "14 tabs overflowed at 1280px" and "the project chip was pushed off
 * screen" were all real, shipped defects that every automated gate reported as
 * clean, because the thing that broke was geometry and no gate measured
 * geometry.
 *
 * Electron *is* Chromium, it is already a devDependency, and it is what ships
 * the product. Driving it costs no new dependency and no new download — the
 * only thing previous rounds lacked was a way to *choose* a viewport, which
 * `BrowserWindow`'s `useContentSize` gives exactly.
 *
 * ## What it asserts
 *
 * Geometry, not pixels. A screenshot diff breaks on every innocent change and
 * gets switched off; a measurement names the element and the number, which
 * points at the CSS rule that caused it. Screenshots are still written to
 * `.run-logs/` as evidence for a human, never as the assertion.
 *
 * ## What keeps it honest
 *
 * The widths are not written down and trusted. They are checked against the
 * product's own declarations — the window size in `main/bootstrap.ts` and the
 * breakpoints in `styles.css` — so changing either one fails this file instead
 * of quietly leaving it measuring states the product cannot reach. That is the
 * same failure the E2E viewport had once (a `settings.viewport` block that did
 * nothing, while the suite claimed the right width).
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import electronPath from 'electron';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, '..', '..');
const PROBE = path.join(REPO_ROOT, 'scripts', 'layout-probe.mjs');
const BOOTSTRAP = path.join(REPO_ROOT, 'apps', 'desktop', 'src', 'main', 'bootstrap.ts');
const STYLES = path.join(REPO_ROOT, 'apps', 'desktop', 'src', 'renderer', 'src', 'styles.css');
const APP = path.join(REPO_ROOT, 'apps', 'desktop', 'src', 'renderer', 'src', 'App.tsx');
const I18N = path.join(REPO_ROOT, 'apps', 'desktop', 'src', 'shared', 'i18n.ts');

/**
 * The heights are not interesting: the shell is a full-height flex column and
 * every region sizes against the viewport height, so a taller window only
 * proves the same thing more slowly.
 */
const HEIGHT = 900;

/**
 * The widths a real user window can be.
 *
 * 1440 / 900 is the window the product opens at, 1280 is the ordinary laptop
 * width where fourteen peer tabs used to overflow, 1180 is the width at which
 * the preview column is shed (so 1181 must still show it), 860 is the width the
 * rail-narrowing rules were written for, and 768 is the `minWidth` the product
 * enforces. 768 x 700 is also the tightest window a user can produce — the
 * narrowest width at the shortest height — which is where a layout gives out
 * first, so it is measured as its own target rather than assumed.
 *
 * The end points are read back out of the product's own source in the drift
 * tests below, so this list cannot quietly fall behind the code it covers.
 */
const GATED_WIDTHS = [1440, 1280, 1181, 1180, 861, 860, 768];

/** The one target that is not just a width: the tightest window there is. */
const TIGHT = { name: 'layout-768x700', width: 768, height: 700 };

/**
 * The widest window at the shortest height.
 *
 * Every width above the 1180px breakpoint at a height between `minHeight` and
 * the 900px default had never been measured: the preview column is present
 * there (unlike at 768) while `62vh` blocks and the composer squeeze into the
 * same vertical budget as the tightest window. Both dimensions are asserted
 * against `bootstrap.ts` in the drift test below, so it cannot drift from the
 * product's declared geometry.
 */
const WIDE_SHORT = { name: 'layout-1440x700', width: 1440, height: 700 };

/**
 * The surfaces the walk covers, and why the list is written down here rather
 * than discovered: the point is to measure the panels, and a panel the gate
 * silently stopped visiting is a panel nobody is looking at any more. The
 * drift test below reads `App.tsx` and fails if a surface is added without
 * being added here.
 */
const SURFACES = [
  'chat',
  'explorer',
  'changes',
  'context',
  'decision',
  'handoff',
  'usage',
  'terminal',
  'intelligence',
  'mcp',
  'storage',
  'recent',
  'settings',
  'diagnostics',
  'help',
] as const;

/** The width at which every surface is measured. */
const PANEL_WIDTH = 1440;

interface Measurement {
  name: string;
  label: string;
  surface: string;
  width: number;
  height: number;
  url: string;
  mounted: boolean;
  error?: string;
  viewport: { width: number; height: number };
  document: { scrollWidth: number; scrollHeight: number; clientWidth: number };
  content: {
    treeRows: number;
    projectChip: string;
    previewVisible: boolean;
    bodyChars: number;
  };
  horizontalOverflow: number;
  escaping: Array<{ element: string; overflowRight: number; overflowLeft: number; text: string }>;
  collapsed: Array<{ element: string; width: number; height: number; text: string }>;
  clipped: Array<{ element: string; scrollWidth: number; clientWidth: number; text: string }>;
  offscreenControls: Array<{
    container: string;
    element: string;
    outRight: number;
    outLeft: number;
    text: string;
  }>;
  overlaps: Array<{ a: string; b: string; sharedWidth: number; sharedHeight: number }>;
  textBoxes: number;
  /** axe-core violations, present only on surfaces-bearing targets (round 34). */
  violations?: Array<{
    id: string;
    impact: string | null;
    help: string;
    nodes: Array<{ html: string; target: string[] }>;
  }>;
  axeError?: string;
  /** Only present on the in-flight target. */
  flight?: {
    shell: boolean;
    pending: number;
    bodyChars: number;
    sawLoadingCopy: boolean;
    markers: number;
  };
  consoleErrors: string[];
}

/**
 * The loading copy in every locale, read from the product's own dictionary.
 *
 * Hard-coding "加载中…" here would make the check pass in one language and fail
 * in the other, which is the kind of gate that gets reported as flaky instead
 * of fixed. The dictionary is the source of truth for what the user sees.
 */
function loadingMarkers(): string[] {
  const source = fs.readFileSync(I18N, 'utf8');
  const found = [...source.matchAll(/'common\.loading':\s*'([^']+)'/g)].map((match) => match[1]!);
  expect(
    found.length,
    'could not read common.loading out of the dictionary, so the loading check would be vacuous',
  ).toBeGreaterThan(0);
  return found;
}

let server: ViteDevServer | undefined;
let measurements: Measurement[] = [];
let failure: string | null = null;

/**
 * Run the probe in one Electron process for all widths.
 *
 * One process rather than one per width: Chromium boot is the expensive part,
 * and a gate that costs 20 seconds is a gate people stop waiting for.
 */
function runProbe(
  targets: Array<{ name: string; width: number; height: number; url: string }>,
  outFile: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(electronPath, [PROBE], {
      cwd: REPO_ROOT,
      windowsHide: true,
      env: {
        ...process.env,
        UCAD_LAYOUT_TARGETS: JSON.stringify(targets),
        UCAD_LAYOUT_OUT: outFile,
        // Screenshots are evidence, and `.run-logs/` is ignored, so writing
        // them costs the gate nothing and gives a human something to look at
        // when a measurement is hard to believe.
        UCAD_LAYOUT_SHOTS: path.join(REPO_ROOT, '.run-logs', 'layout'),
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

beforeAll(async () => {
  server = await createServer({
    configFile: path.join(REPO_ROOT, 'apps', 'desktop', 'vite.config.ts'),
    // A random free port: the gate must not fight a `npm run dev:web` the
    // developer left open, and `strictPort` in the app config would do exactly
    // that. The renderer itself does not care which port it is served from.
    server: { port: 0, strictPort: false, host: '127.0.0.1' },
    logLevel: 'error',
  });
  await server.listen();
  const base = server.resolvedUrls?.local[0];
  if (!base) throw new Error('vite did not report a local URL to measure against');

  const targets = [
    ...GATED_WIDTHS.map((width) => ({
      name: `layout-${width}`,
      width,
      height: HEIGHT,
      url: `${base}?scenario=default`,
    })),
    /*
     * The tightest window walks every surface too: geometry is not the only
     * thing that changes with width, media queries re-shape which controls
     * exist, and axe inside a real layout engine (round 34) can therefore
     * see narrow-layout a11y states that the happy-dom scan never will.
     */
    { ...TIGHT, url: `${base}?scenario=default`, surfaces: [...SURFACES] },
    /*
     * And the widest window at the shortest height: the preview column is
     * visible there while the vertical budget matches the tightest window.
     */
    { ...WIDE_SHORT, url: `${base}?scenario=default`, surfaces: [...SURFACES] },
    // The loading frame, and the panel sweep. The panels are where the overlap
    // and collapsed-region defects of rounds 4 and 9 lived, and a sweep of the
    // chat surface alone would have called both of them clean.
    {
      name: `panels-${PANEL_WIDTH}`,
      width: PANEL_WIDTH,
      height: HEIGHT,
      url: `${base}?scenario=default`,
      surfaces: [...SURFACES],
    },
    /*
     * The frame where the app is still fetching, which had been checked by
     * hand for five rounds and never managed to be seen.
     */
    {
      name: 'loading-frame',
      width: PANEL_WIDTH,
      height: HEIGHT,
      url: `${base}?scenario=loading`,
      inFlight: true,
      markers: loadingMarkers(),
    },
  ];

  const outFile = path.join(os.tmpdir(), `ucad-layout-${process.pid}.json`);
  const { code, stdout, stderr } = await runProbe(targets, outFile);

  if (!fs.existsSync(outFile)) {
    // No result file means the probe never finished. Electron failing to start
    // is not a reason to report "no layout problems found" — that is the
    // silent-pass failure the gates are written against.
    throw new Error(
      `the layout probe produced no result (exit ${code}).\n` +
        `stdout: ${stdout.slice(-2000)}\nstderr: ${stderr.slice(-2000)}`,
    );
  }

  const parsed = JSON.parse(fs.readFileSync(outFile, 'utf8')) as {
    ok: boolean;
    failure: string | null;
    results: Measurement[];
  };
  measurements = parsed.results;
  failure = parsed.failure;
  fs.rmSync(outFile, { force: true });
}, 240_000);

/**
 * The frames the geometry rules apply to.
 *
 * The in-flight target is measured for content, not geometry, and is excluded
 * on purpose: letting it through would make every geometry assertion pass over
 * a frame where nothing was measured, which is how a gate stops meaning
 * anything without ever going red.
 */
const GEOMETRY = measurements.filter((m) => m.geometry !== false);

afterAll(async () => {
  await server?.close();
});

/** A readable one-line summary of a violation, so failures name the element. */
function lines(rows: Array<Record<string, unknown>>): string {
  return rows.map((row) => JSON.stringify(row)).join('\n');
}

/**
 * The source with its comments removed.
 *
 * These drift checks read numbers out of the product's own files, and a regex
 * over raw source will happily match a number that only exists in prose. That
 * is not hypothetical: the comment explaining why `minWidth` moved from 1080 to
 * 768 contains the string `minWidth: 1080`, and the first version of this check
 * read *that* and concluded the product still had a 1080 floor.
 *
 * A comment is not a declaration, so it is removed before anything is read.
 */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('layout in a real browser engine', () => {
  it('mounted the app at every gated width', () => {
    const broken = measurements.filter((m) => !m.mounted);
    expect(
      broken.map((m) => `${m.name}: ${m.error ?? 'unknown'}`),
      'a width that could not be measured is a failed measurement, not a clean one',
    ).toEqual([]);
  });

  it('reports the width it actually measured', () => {
    // `useContentSize` is the reason this holds; without it a 1100px request
    // lays out at 1084px and every width in this file would be a small lie.
    for (const m of GEOMETRY) {
      expect(m.viewport.width, `${m.name} laid out at a different width than requested`)
        .toBe(m.width);
    }
  });

  it('reports the height it actually measured', () => {
    // Same honesty for the height axis: the wide-short and tight targets only
    // mean something if the window really laid out at 700px tall.
    for (const m of GEOMETRY) {
      expect(m.viewport.height, `${m.name} laid out at a different height than requested`)
        .toBe(m.height);
    }
  });

  it('measured the app, not a shell that had not loaded yet', () => {
    // The first version of this probe waited for `.statusbar` to have text,
    // measured, and reported a clean 1440px — of a first-run screen with no
    // workspace and no sessions, because every read was still in flight. A
    // green measurement of the wrong screen is worse than no gate, so the
    // state that was measured is part of what gets asserted.
    for (const m of GEOMETRY) {
      expect(
        m.content.treeRows,
        `${m.width}px: measured before the data arrived (no rows in the rail); ` +
          `chip=${JSON.stringify(m.content.projectChip)}`,
      ).toBeGreaterThan(0);
      expect(m.content.bodyChars, `${m.width}px: measured an almost empty document`).toBeGreaterThan(
        200,
      );
    }
  });

  it('shows the preview column exactly where the stylesheet says it should', () => {
    // Derived from the stylesheet so a new breakpoint cannot quietly leave the
    // gate checking a column the product no longer has. The blocks are split
    // rather than matched with one regex: a media query body contains nested
    // braces, and a pattern that cannot cross them silently finds nothing.
    const css = fs.readFileSync(STYLES, 'utf8');
    const blocks = css.split('@media').slice(1);
    const shedBlocks = blocks.filter((block) => {
      const condition = /^\s*\(([^)]*)\)/.exec(block)?.[1] ?? '';
      return condition.includes('max-width') && /\.preview\s*\{[^}]*display:\s*none/.test(block);
    });
    expect(
      shedBlocks.length,
      'could not find the media query that hides the preview column',
    ).toBeGreaterThan(0);

    const shedAt = Math.min(
      ...shedBlocks.map((block) => Number(/\(max-width:\s*(\d+)px\)/.exec(block)![1])),
    );

    for (const m of GEOMETRY) {
      // Only the chat surface keeps the preview column; the panels take the
      // full main column, so "no preview there" is correct, not a failure.
      if (m.surface !== 'chat') continue;
      const expected = m.width > shedAt;
      expect(
        m.content.previewVisible,
        `${m.width}px: preview column is ${m.content.previewVisible ? 'shown' : 'hidden'}, ` +
          `but the stylesheet hides it at ${shedAt}px and below`,
      ).toBe(expected);
    }
  });

  it('keeps every navigation tab and composer control on screen', () => {
    /*
     * Proven red before it was trusted: with all fifteen surfaces as peer tabs,
     * the nav row scrolls, and 设置 / 诊断 / 帮助 and the 更多 menu itself end up
     * 6–217px outside a 642px row — while the document never overflowed, the
     * column never collapsed, and every control still "rendered". Those four
     * checks were not wrong, they were incomplete.
     */
    for (const m of GEOMETRY) {
      expect(
        m.offscreenControls,
        `${m.name}: controls you cannot see and would not know to scroll for\n` +
          lines(m.offscreenControls),
      ).toEqual([]);
    }
  });

  it('laps no surface, and every one of them had text to measure', () => {
    const panels = measurements.filter((m) => m.name.startsWith('panels-'));
    expect(
      panels.map((m) => m.surface),
      'the sweep did not visit every surface',
    ).toEqual([...SURFACES]);
    // A surface that rendered an empty shell would sail through every geometry
    // check, so the sweep also has to prove it measured something.
    const empty = panels.filter((m) => m.textBoxes < 5).map((m) => `${m.surface} (${m.textBoxes})`);
    expect(empty, 'these surfaces had almost no text to measure').toEqual([]);
  });

  it('says it is loading instead of flashing an empty frame', () => {
    /*
     * This had been an untickable manual item since round 23, on the grounds
     * that the slow scenario slows the shell itself "so the
     * in-flight frame cannot be photographed". That is true of clicking
     * through the UI and false of measuring it: the harness knows when a read
     * is in flight, so the frame can be caught and read.
     *
     * The claim being checked is the one the item actually makes — a slow
     * interface gives feedback rather than a blank screen — and the screenshot
     * lands in `.run-logs/layout/loading-frame.png` for a person to look at.
     */
    const flight = measurements.find((m) => m.name === 'loading-frame');
    expect(flight, 'the in-flight frame was never measured').toBeDefined();
    expect(
      flight!.flight.pending,
      'never caught a read in flight, so nothing about the loading frame was measured',
    ).toBeGreaterThan(0);
    expect(flight!.flight.sawLoadingCopy, 'the loading copy was not on screen while fetching')
      .toBe(true);
    expect(flight!.flight.bodyChars, 'the frame while fetching was effectively blank').toBeGreaterThan(
      50,
    );
  });

  it('lays no text on top of other text, in any panel', () => {
    /*
     * Round 4 shipped a dialog whose description sat on its own risk row and
     * every gate was green. Static-flow boxes only: a positioned box is layered
     * on purpose, and a box scrolled out of a pane is not covering anything.
     */
    for (const m of GEOMETRY) {
      expect(
        m.overlaps,
        `${m.label}: text lying on top of other text\n${lines(m.overlaps)}`,
      ).toEqual([]);
    }
  });

  it('never needs a horizontal scrollbar', () => {
    for (const m of GEOMETRY) {
      expect(
        m.horizontalOverflow,
        `${m.width}px: the document is ${m.horizontalOverflow}px wider than the window\n` +
          `scrollWidth=${m.document.scrollWidth} innerWidth=${m.viewport.width}\n` +
          `escaping:\n${lines(m.escaping)}`,
      ).toBeLessThanOrEqual(0.5);
    }
  });

  it('keeps every visible control inside the window', () => {
    for (const m of GEOMETRY) {
      expect(m.escaping, `${m.width}px: elements pushed outside the window\n${lines(m.escaping)}`)
        .toEqual([]);
    }
  });

  it('collapses no region that has content in it', () => {
    // The defect this exists for: a pane that still "renders" at zero width
    // satisfies every render assertion in the E2E suite while the user sees an
    // empty column.
    for (const m of GEOMETRY) {
      expect(m.collapsed, `${m.width}px: regions collapsed\n${lines(m.collapsed)}`).toEqual([]);
    }
  });

  it('cuts no text off without an ellipsis', () => {
    for (const m of GEOMETRY) {
      expect(m.clipped, `${m.width}px: text clipped by its own box\n${lines(m.clipped)}`).toEqual(
        [],
      );
    }
  });

  it('logs nothing to the console at any width', () => {
    // "no console errors" has been a manual item for
    // seven rounds, re-checked by hand after every browser visit. It is a
    // measurement, so it is measured here.
    for (const m of GEOMETRY) {
      expect(m.consoleErrors, `${m.width}px: console errors\n${m.consoleErrors.join('\n')}`).toEqual(
        [],
      );
    }
  });

  it('has no axe violations on any surface, at any measured layout', () => {
    /*
     * Round 34: the probe now runs axe-core inside the same real Chromium that
     * measures geometry, once per surface on every surfaces-bearing target.
     * This closes the gap the happy-dom scan never could: axe's rule set there
     * evaluates elements without a layout engine — colour-contrast evaluated
     * *zero nodes* — and at exactly one viewport, while this window resizes.
     * First run caught two real defects (text-3 on surface-2 at 4.34:1; a
     * keyboard-unreachable scrollable pane on diagnostics) that 56 E2E and
     * 363 unit tests called clean.
     *
     * Only surfaces-bearing targets carry `violations`; the width-only sweeps
     * are geometry runs and say nothing here.
     */
    const scanned = measurements.filter((m) => m.mounted && m.violations !== undefined);
    expect(
      scanned.length,
      'the probe scanned no surfaces with axe; the surfaces-bearing targets disappeared',
    ).toBeGreaterThan(0);

    const format = (m: Measurement): string =>
      (m.violations ?? [])
        .map(
          (v) =>
            `  [${v.impact ?? 'unknown'}] ${v.id} — ${v.help}\n` +
            v.nodes.map((n) => `      ${n.target.join(' ')}\n      ${n.html}`).join('\n'),
        )
        .join('\n');

    for (const m of scanned) {
      expect(m.axeError, `${m.label}: axe could not run`).toBeUndefined();
      expect(
        m.violations,
        `${m.label}: accessibility violations\n${format(m)}`,
      ).toEqual([]);
    }
  });

  it('reported a run that completed', () => {
    expect(failure, 'the probe itself reported a problem').toBeNull();
  });
});

describe('the gate tracks the product it measures', () => {
  /** The window geometry the product actually declares, comments excluded. */
  function declaredWindow(): {
    width: number;
    minWidth: number;
    height: number;
    minHeight: number;
  } {
    const source = codeOnly(fs.readFileSync(BOOTSTRAP, 'utf8'));
    return {
      width: Number(/\bwidth:\s*(\d+)/.exec(source)?.[1]),
      minWidth: Number(/\bminWidth:\s*(\d+)/.exec(source)?.[1]),
      height: Number(/\bheight:\s*(\d+)/.exec(source)?.[1]),
      minHeight: Number(/\bminHeight:\s*(\d+)/.exec(source)?.[1]),
    };
  }

  it('covers the window the product opens at, and the smallest it allows', () => {
    const { width, minWidth, minHeight } = declaredWindow();
    expect(width, 'could not read the window width out of bootstrap.ts').toBeGreaterThan(0);
    expect(minWidth, 'could not read minWidth out of bootstrap.ts').toBeGreaterThan(0);
    expect(minHeight, 'could not read minHeight out of bootstrap.ts').toBeGreaterThan(0);
    expect(GATED_WIDTHS, `the product opens at ${width}px`).toContain(width);
    expect(GATED_WIDTHS, `the product cannot go below ${minWidth}px`).toContain(minWidth);
    // The two fixed-height targets exist because minHeight is a real user
    // state, not because 700 looked like a number.
    expect(TIGHT.height, 'the tightest-height target must match minHeight').toBe(minHeight);
    expect(
      WIDE_SHORT.height,
      'the wide-short target must match minHeight',
    ).toBe(minHeight);
    expect(WIDE_SHORT.width, 'the wide-short target must match the declared width').toBe(width);
  });

  it('covers both sides of every CSS breakpoint', () => {
    // A media query boundary is exactly where a layout breaks, and a gate that
    // does not include it measures the wrong states. Derived from the
    // stylesheet, so adding a breakpoint makes this fail until it is measured.
    const css = fs.readFileSync(STYLES, 'utf8');
    const breakpoints = [...css.matchAll(/@media\s*\(max-width:\s*(\d+)px\)/g)]
      .map((match) => Number(match[1]))
      .filter((value) => Number.isFinite(value));
    expect(breakpoints.length, 'no responsive breakpoints were found in styles.css').toBeGreaterThan(
      0,
    );
    for (const breakpoint of breakpoints) {
      expect(GATED_WIDTHS, `${breakpoint}px is a breakpoint in styles.css`).toContain(breakpoint);
      expect(GATED_WIDTHS, `${breakpoint + 1}px is the width just above it`).toContain(
        breakpoint + 1,
      );
    }
  });

  it('covers every surface the app can navigate to', () => {
    // A new surface that the sweep does not visit is a panel nobody measures.
    // `App.tsx` is the list, so this fails when the product grows.
    const source = fs.readFileSync(APP, 'utf8');
    const declared = new Set<string>();
    for (const match of source.matchAll(/'(chat|explorer|changes|context|decision|usage|terminal|intelligence|mcp|storage|handoff|recent|settings|diagnostics|help)'/g)) {
      declared.add(match[1]!);
    }
    expect(declared.size, 'could not read the surface list out of App.tsx').toBeGreaterThan(5);
    const missing = [...declared].filter((surface) => !SURFACES.includes(surface as never));
    expect(
      missing,
      `App.tsx declares surfaces the sweep never visits: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('does not gate widths the product cannot reach', () => {
    // A gated width below `minWidth` is a fiction: it measures a state no user
    // can produce, and it makes the gate slower without making it stronger.
    const { minWidth } = declaredWindow();
    expect(Math.min(...GATED_WIDTHS), `minWidth is ${minWidth}px`).toBeGreaterThanOrEqual(minWidth);
  });
});
