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
import {
  IN_FLIGHT_SCENARIO,
  STATE_SCENARIOS,
} from '../../apps/desktop/src/renderer/src/dev/scenarios';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, '..', '..');
const PROBE = path.join(REPO_ROOT, 'scripts', 'layout-probe.mjs');
const BOOTSTRAP = path.join(REPO_ROOT, 'apps', 'desktop', 'src', 'main', 'bootstrap.ts');
const STYLES = path.join(REPO_ROOT, 'apps', 'desktop', 'src', 'renderer', 'src', 'styles.css');
const APP = path.join(REPO_ROOT, 'apps', 'desktop', 'src', 'renderer', 'src', 'App.tsx');
const I18N = path.join(REPO_ROOT, 'apps', 'desktop', 'src', 'shared', 'i18n.ts');
const PAGE_SCRIPTS = path.join(REPO_ROOT, 'scripts', 'layout-page-scripts.mjs');

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
  /** The scenario the fixture says it installed, read off <html data-ucad-fixture>. */
  scenario?: string;
  /**
   * The state this target exists to measure, when it is one of the five.
   *
   * Absent on the width sweeps and the surface walk, which open the populated
   * happy path. The distinction is load-bearing below: "measured a populated
   * app" is a rule about those targets and a false one about `?scenario=empty`
   * — which is *supposed* to have no sessions in the rail.
   */
  state?: string;
  error?: string;
  viewport: { width: number; height: number };
  document: { scrollWidth: number; scrollHeight: number; clientWidth: number };
  content: {
    treeRows: number;
    projectChip: string;
    previewVisible: boolean;
    /** App.tsx's 'if (fatal)' screen: the pane a failed first load paints. */
    errorPane: boolean;
    /** The permission prompt, the one overlay that announces itself as a modal. */
    dialogOpen: boolean;
    bodyChars: number;
    /**
     * The first-run block's hierarchy, as the engine computed it.
     *
     * `null` when the block is not on screen — a state without a first run is
     * not a state with an empty one, and the assertion below says so.
     */
    firstRun: {
      leadSize: number;
      leadColor: string;
      stepSize: number;
      stepColor: string;
      bodyColor: string;
      stepMarkers: number;
      listStyle: string;
    } | null;
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
  /**
   * Type, as measured rather than declared.
   *
   * Geometry cannot see the size of the letters: 10.5px Chinese captions were
   * never outside anything, never collapsed, never clipped and never
   * overlapping — they were just too small to read on a 1x display.
   */
  typography: {
    /** The floor the measurement itself used; imported from the page script. */
    cjkFloor: number;
    /** How many Chinese-bearing boxes this frame had, so the rule is not vacuous. */
    cjkCount: number;
    /**
     * Every type size the engine actually rendered on this frame, largest
     * first, with a count and one example element per size.
     *
     * The stylesheet's own four-tier rule is pinned by `typography.test.ts`
     * against the source; this is the same promise measured on a screen.
     */
    tiers: Array<{ element: string; fontSize: number; count: number; text: string }>;
    /** How many Chinese boxes each rendered size carried, ascending by size. */
    cjkSizes: Array<{ fontSize: number; count: number }>;
    tooSmall: Array<{ element: string; fontSize: number; count: number; text: string }>;
    negativeTracking: Array<{
      element: string;
      letterSpacing: number;
      count: number;
      text: string;
    }>;
    tightLeading: Array<{
      element: string;
      fontSize: number;
      lineHeight: number;
      lines: number;
      text: string;
    }>;
    /**
     * Every font stack the engine actually resolved for a Chinese box on this
     * frame, grouped by the computed list.
     *
     * `typography.test.ts` reads the declared stack out of `styles.css` and
     * asserts its order. That is a claim about the source; this is the same
     * claim measured. A `var()` that stopped resolving, a family inherited from
     * an unstyled control or an inline style on one component would all leave
     * the source assertion green and the screen wrong.
     */
    families: Array<{ family: string; count: number; element: string; text: string }>;
    /**
     * Chinese boxes the engine had to shear because something asked for an
     * italic. There is no italic cut of a Han face, so the engine slants the
     * upright one and the strokes go muddy — a rendering bug, not emphasis.
     */
    fakeItalics: Array<{ element: string; fontStyle: string; text: string }>;
  };
  /**
   * Prose, as measured rather than declared: how long a line is, and where the
   * lines were allowed to break.
   *
   * Geometry cannot see either. A paragraph can be inside its box, unclipped,
   * unoverlapped, set at 13px with 1.7 leading — every rule above green — and
   * still be unreadable because each line is 70 characters long or because a
   * full stop is sitting at the left margin.
   */
  typeset: {
    /** The ceiling the measurement itself used; read from the page script. */
    maxLineCjk: number;
    /** The floor the measurement itself used; read from the page script. */
    minLineCjk: number;
    /** How many wrapped Chinese blocks this frame had, so the rule is not vacuous. */
    proseBlocks: number;
    proseLines: number;
    longLines: Array<{
      element: string;
      fontSize: number;
      lines: number;
      longestCjk: number;
      text: string;
    }>;
    /**
     * Blocks narrower than the floor *while their container had room for it*.
     * `roomCjk` is what the container could have given them, so a failure can
     * say "23 characters in a column that had 69" instead of just "too short".
     */
    shortLines: Array<{
      element: string;
      fontSize: number;
      lines: number;
      longestCjk: number;
      roomCjk: number;
      text: string;
    }>;
    /** How many blocks the floor applied to, so the rule is not vacuous. */
    floorChecked: number;
    badBreaks: Array<{
      element: string;
      kind: string;
      char: string;
      line: number;
      text: string;
    }>;
  };
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

/** The dictionary's copy for one key, in every locale that defines it. */
function copyFor(key: string): string[] {
  const source = fs.readFileSync(I18N, 'utf8');
  const escaped = key.replace(/[.]/g, '\\.');
  const pattern = new RegExp(`'${escaped}':\\s*'([^']+)'`, 'g');
  return [...source.matchAll(pattern)].map((m) => m[1]!);
}

/**
 * The prose ceiling the measurement is supposed to be using.
 *
 * Read out of the page script rather than imported, for the same reason
 * `typography.test.ts` reads `CJK_FLOOR_PX` instead of importing it: the page
 * script is ESM JavaScript outside the TypeScript project, and the thing being
 * checked is that the number in the source is the number the measurement used.
 * `tests/contract/typography.test.ts` pins the declaration itself (the band,
 * the interpolation, the character sets); this file pins the result.
 */
function declaredProseCeiling(): number {
  const source = fs.readFileSync(PAGE_SCRIPTS, 'utf8');
  const match = /export const MAX_PROSE_LINE_CJK = (\d+);/.exec(source);
  expect(
    match,
    'layout-page-scripts.mjs no longer exports MAX_PROSE_LINE_CJK, so the prose ' +
      'ceiling this gate enforces is not the one the measurement used',
  ).not.toBeNull();
  return Number(match![1]);
}

/**
 * The prose floor the measurement is supposed to be using, read the same way.
 *
 * Separate from the ceiling because the two are different rules with different
 * conditions: the ceiling applies to every wrapped block, the floor only to
 * blocks whose container had room for it. A single `declaredProseBand()` would
 * invite the two to be enforced by the same loop, which is the mistake the
 * floor's condition exists to prevent.
 */
function declaredProseFloor(): number {
  const source = fs.readFileSync(PAGE_SCRIPTS, 'utf8');
  const match = /export const MIN_PROSE_LINE_CJK = (\d+);/.exec(source);
  expect(
    match,
    'layout-page-scripts.mjs no longer exports MIN_PROSE_LINE_CJK, so the prose ' +
      'floor this gate enforces is not the one the measurement used',
  ).not.toBeNull();
  return Number(match![1]);
}

/**
 * The two font stacks the stylesheet declares, normalised for comparison.
 *
 * Read out of `styles.css` rather than imported, for the same reason the prose
 * ceiling is: the question is whether the stack the engine resolved is the one
 * the source declares, and importing a copy would answer a different question.
 * Quotes and whitespace are normalised because Chromium echoes the declared
 * list back with its own spacing — the families and their order are what is
 * being compared, not the punctuation.
 *
 * Returned as a **named pair** rather than a flat array, because the two stacks
 * promise different things and the gate has to check each of them against its
 * own promise: the prose stack names Chinese faces after the Latin ones, the
 * identifier stack ends in a monospace generic and names no Chinese face at all.
 * A flat array invites "it is one of the declared stacks, done", which is the
 * check that would have passed while a Chinese label drifted from prose onto
 * the identifier stack — that is exactly what this gate found on its first run
 * (`span.faint` carrying `本轮` on the mono stack, which is legitimate there).
 */
function declaredStacks(): { sans: string; mono: string } {
  const source = fs.readFileSync(STYLES, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const read = (name: string): string => {
    const match = new RegExp(`--${name}:\\s*([^;]+);`).exec(source);
    expect(match, `styles.css no longer declares --${name}`).not.toBeNull();
    return normaliseStack(match![1]!);
  };
  return { sans: read('sans'), mono: read('mono') };
}

/** The families of a stack, in order, unquoted. */
function stackFamilies(stack: string): string[] {
  return stack
    .split(',')
    .map((family) => family.trim().replace(/^["']|["']$/g, ''))
    .filter((family) => family.length > 0);
}

/** A font stack as a comparable string: families in order, unquoted. */
function normaliseStack(stack: string): string {
  return stackFamilies(stack).join(', ');
}

/** Families that draw Latin text, and families that draw Han text. */
const LATIN_FAMILY = /-apple-system|BlinkMacSystemFont|Segoe UI|Inter|Helvetica|Arial/;
const HAN_FAMILY = /PingFang SC|Microsoft YaHei|Noto Sans CJK SC|Source Han|Hiragino Sans GB/;
/** The generic families a stack may end in. Everything after one is unreachable. */
const GENERIC_FAMILY = new Set(['sans-serif', 'monospace', 'serif', 'system-ui']);

let server: ViteDevServer | undefined;
let measurements: Measurement[] = [];
let failure: string | null = null;
/** The probe's own stdout/stderr, kept so a dead run can name its cause. */
let probeOutput = '';

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
  /*
   * `ELECTRON_RUN_AS_NODE` must not reach the probe.
   *
   * Electron documents the variable as "start Electron as a plain Node.js
   * process", and when it is set the probe runs under Node with no Chromium
   * and no `electron` built-in module at all. The import at the top of the
   * probe then resolves to `node_modules/electron/index.js` — the CommonJS
   * shim whose only export is the path to the binary — and the process dies
   * before a line of it runs:
   *
   *   SyntaxError: The requested module 'electron' does not provide an export
   *   named 'BrowserWindow'
   *
   * The cause is invisible in that message, and the variable is not exotic:
   * it is set in the environment of Electron-based editors (VS Code, and the
   * editors built on it), so running `npm test` from an integrated terminal
   * was enough to kill the entire geometry gate. Deleting it from the child
   * env is the only place it can be done — by the time the probe is executing,
   * the Node-vs-Electron decision has already been made.
   */
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  return new Promise((resolve, reject) => {
    const child = spawn(electronPath, [PROBE], {
      cwd: REPO_ROOT,
      windowsHide: true,
      env: {
        ...env,
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
     * The five interface states of step 6, measured instead of assumed.
     *
     * These are built from `STATE_SCENARIOS` rather than written out, because
     * a hand-written list beside the fixture's own list is two facts that
     * drift: a sixth state would be walked by hand, asserted by the E2E suite,
     * and measured by nobody. `tests/contract/scenario-states.test.ts` keeps
     * this import, the E2E suite and the prose on the same names.
     *
     * What this adds that the DOM assertions cannot: every geometry rule below
     * now runs over a first-run screen, a failed load, a half-broken load and a
     * modal — the states where a column collapses or a control leaves the
     * window, and the states no width sweep ever visited.
     */
    /*
     * Each state at two sizes: the window the product opens at, and the
     * tightest window it allows. The tight one is load-bearing — the five
     * states had only ever been measured at 1440x900, and that is *why* the
     * probe's overlap rule had never met a modal in a narrow window (see the
     * modal-layer note in `layout-page-scripts.mjs`). It is also the size the
     * manual checklist asks a person to judge by eye ("长中文在窄窗口是否撑破"),
     * so the measurable half of that question is measured rather than deferred.
     */
    ...STATE_SCENARIOS.flatMap((state) => [
      {
        name: `state-${state}`,
        state,
        width: PANEL_WIDTH,
        height: HEIGHT,
        url: `${base}?scenario=${state}`,
      },
      {
        name: `state-${state}-tight`,
        state,
        width: TIGHT.width,
        height: TIGHT.height,
        url: `${base}?scenario=${state}`,
      },
    ]),
    /*
     * The frame where the app is still fetching, which had been checked by
     * hand for five rounds and never managed to be seen.
     */
    {
      name: 'loading-frame',
      width: PANEL_WIDTH,
      height: HEIGHT,
      url: `${base}?scenario=${IN_FLIGHT_SCENARIO}`,
      inFlight: true,
      markers: loadingMarkers(),
    },
  ];

  const outFile = path.join(os.tmpdir(), `ucad-layout-${process.pid}.json`);
  const { code, stdout, stderr } = await runProbe(targets, outFile);
  probeOutput = `probe exited ${code}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`;

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
  // Derived here, not at module scope: see the note on `GEOMETRY` below.
  /*
   * Only frames that were measured *and* mounted.
   *
   * An unmounted target is already a failure, reported by "mounted the app at
   * every gated width" with the probe's own reason. Letting its empty slot into
   * these loops turns that sentence into a TypeError about comparing null with
   * a number — a stack trace naming the assertion instead of the screen that
   * did not load. Skips are for frames that carry no geometry at all (the
   * in-flight one), which is `geometry: false`.
   */
  GEOMETRY = measurements.filter((m) => m.geometry !== false && m.mounted);
  POPULATED = GEOMETRY.filter((m) => m.state === undefined);
  fs.rmSync(outFile, { force: true });
}, 240_000);

/**
 * The frames the geometry rules apply to.
 *
 * The in-flight target is measured for content, not geometry, and is excluded
 * on purpose: letting it through would make every geometry assertion pass over
 * a frame where nothing was measured, which is how a gate stops meaning
 * anything without ever going red.
 *
 * ## Why this is `let` and filled in by `beforeAll`
 *
 * It used to be `const GEOMETRY = measurements.filter(...)` at module scope.
 * A module body runs at *import* time, which is before `beforeAll`, and
 * `beforeAll` *reassigns* `measurements` rather than mutating it — so the
 * filter ran over the initial empty array and `GEOMETRY` stayed `[]` for the
 * life of the process. Every `for (const m of GEOMETRY)` loop below then
 * iterated nothing and passed, which is why a run where the probe died on its
 * very first page load still reported eleven green geometry assertions
 * ("reports the width it actually measured", "lays no text on top of other
 * text, in any panel", "never needs a horizontal scrollbar", …).
 *
 * The list has to be derived from the data, after the data exists. Kept as a
 * variable rather than a function so the call sites keep reading as the plain
 * loops they are.
 */
let GEOMETRY: Measurement[] = [];

/**
 * The measured frames that opened the populated happy path.
 *
 * The geometry rules below fall into two kinds: invariants of the *window*
 * (no sideways scrolling, nothing pushed off screen, no collapsed region),
 * which every measured frame must satisfy, and invariants of a *populated
 * workspace* (rows in the rail, a workspace chip), which are true of the width
 * sweeps and the surface walk and deliberately false of `?scenario=empty`.
 * Running the second kind over every frame made "measured the app, not a shell
 * that had not loaded yet" fail on the first-run screen it was never about —
 * and the tempting repair, dropping the state targets from `GEOMETRY`, would
 * have quietly exempted five screens from the invariants that matter.
 */
let POPULATED: Measurement[] = [];

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

describe('the interface states are measured, not assumed', () => {
  /*
   * `state-<name>` targets measure the five states step 6 asks a person to
   * open. Two things are asserted here, and neither is about pixels:
   *
   *  - the frame measured is the state that was asked for. The probe loads a
   *    URL per target, and the round before this one found that it had been
   *    reporting the first scenario's geometry under the other four names —
   *    a clean result about the wrong screen. The fixture stamps the installed
   *    scenario onto `<html>`, the measurement carries it back, and this is
   *    the assertion that closes it.
   *  - a first-run screen really is one. `empty` has no workspace and no
   *    sessions, so a measurement that found tree rows was measuring a
   *    different state (or a stale page) no matter what the URL said.
   *
   * The geometry rules below apply to these targets too: they are the states
   * where a column collapses or a control leaves the window, and no width
   * sweep ever visited them.
   */
  it.each(STATE_SCENARIOS)('%s was measured on the state it names', (state) => {
    /*
     * Filtered by the state the *target* declared, not by the target's name:
     * every walkable state is now measured twice (default window, tightest
     * window), and a name filter would quietly check only one of them — which
     * is the same "measured the state once and called it covered" shape this
     * suite was written against.
     */
    const found = measurements.filter((m) => m.state === state);
    expect(found.length, `no measurement for ?scenario=${state}`).toBeGreaterThan(0);
    expect(found.map((m) => m.error ?? ''), `?scenario=${state} did not mount`).toEqual(
      found.map(() => ''),
    );
    expect(found.map((m) => m.scenario), `?scenario=${state} measured another state`).toEqual(
      found.map(() => state),
    );
  });

  it('the failed-load state really is the failed-load pane', () => {
    /*
     * `?scenario=error` is the one state that does not paint the shell: every
     * core read rejects and App.tsx takes its 'if (fatal)' branch, so there is
     * no rail, no statusbar and no preview column. That made it the state the
     * probe could not photograph at all until this round — it waited for a
     * statusbar that was never coming, and the measurement script threw on the
     * missing chip before that.
     *
     * The assertion is therefore about the pane being on screen *instead of*
     * the shell: the error pane is there, and the preview column is not. A
     * frame that said `state: error` while showing the populated shell would
     * pass a geometry check and be a clean result about the wrong screen.
     */
    const error = measurements.filter((m) => m.state === 'error');
    expect(error.length, 'no measurement for ?scenario=error').toBeGreaterThan(0);
    for (const m of error) {
      expect(m.mounted, `?scenario=error did not mount: ${m.error ?? ''}`).toBe(true);
      expect(m.content.errorPane, '?scenario=error measured the shell, not the error pane').toBe(
        true,
      );
      expect(m.content.previewVisible, 'the error pane has no preview column').toBe(false);
    }
    const shellStates = GEOMETRY.filter(
      (other) => other.state !== undefined && other.state !== 'error',
    );
    for (const m of shellStates) {
      expect(m.content.errorPane, `?scenario=${m.state} painted the failed-load pane`).toBe(false);
    }
  });

  it('the permission state really has a prompt on screen', () => {
    /*
     * The security loop is only walkable if the prompt is *there*: the E2E
     * suite asserts its five fields and the two answers in happy-dom, and this
     * asserts that the same scenario, in a real layout engine at 1440px, still
     * has an overlay on screen — and that the four other states have none. A
     * modal that stopped rendering would leave the panel behind it looking
     * fine at every width.
     */
    const permission = measurements.filter((m) => m.state === 'permission');
    expect(permission.length, 'no measurement for ?scenario=permission').toBeGreaterThan(0);
    for (const m of permission) {
      expect(m.mounted, `?scenario=permission did not mount: ${m.error ?? ''}`).toBe(true);
      expect(m.content.dialogOpen, '?scenario=permission had no permission prompt on screen').toBe(
        true,
      );
    }
    const otherStates = GEOMETRY.filter(
      (other) => other.state !== undefined && other.state !== 'permission',
    );
    for (const m of otherStates) {
      expect(m.content.dialogOpen, `?scenario=${m.state} had an unexpected modal open`).toBe(false);
    }
  });

  it('measures every walkable state at the tightest window too', () => {
    /*
     * The narrow measurement is the one that had never happened, and a
     * silently-dropped second target would leave this suite green with the
     * same blind spot it had before. The sizes are read off TIGHT, which the
     * drift tests above keep equal to the product's own `minWidth`/`minHeight`,
     * so "the tightest window" cannot come to mean something the product does
     * not allow.
     */
    for (const state of STATE_SCENARIOS) {
      const tight = measurements.filter(
        (m) => m.state === state && m.width === TIGHT.width && m.height === TIGHT.height,
      );
      expect(
        tight.map((m) => m.scenario ?? '(not measured)'),
        `?scenario=${state} was not measured at ${TIGHT.width}x${TIGHT.height}`,
      ).toEqual([state]);
    }
  });

  it('the first-run state really has no workspace', () => {
    /*
     * The topbar chip shows the workspace name, or the invitation to open one
     * when there is no workspace. So "no workspace" is not an empty chip — it
     * is a chip that asks the user to open a folder, and asserting the empty
     * string would have failed on a perfectly correct screen. The copy comes
     * out of the dictionary in every locale it defines, so the assertion is
     * about the product's own words rather than a string typed here.
     */
    const invitations = copyFor('welcome.open');
    expect(invitations.length, 'could not read welcome.open out of the dictionary').toBeGreaterThan(
      0,
    );
    const empty = measurements.filter((m) => m.state === 'empty');
    expect(empty.length).toBeGreaterThan(0);
    for (const m of empty) {
      expect(m.content.treeRows, 'the empty state rendered session rows').toBe(0);
      expect(
        invitations.some((copy) => m.content.projectChip.includes(copy)),
        `the empty state's chip names a workspace instead of offering to open one: ` +
          JSON.stringify(m.content.projectChip),
      ).toBe(true);
    }
  });

  it('the first-run block has an entry point, and counts its steps once', () => {
    /*
     * `docs/state-walkthrough.md` asks a walker two things about the empty
     * state that are not matters of taste: the eye lands on the lead sentence
     * first, and the three steps can be counted at a glance. Both were false
     * in the stylesheet and nothing measured them, so the walkthrough could
     * only ever have been answered "no" — and a criterion nobody can pass is a
     * criterion that gets quietly reworded.
     *
     * The lead was `--text-2` at `--fs-body` while the steps beneath it were
     * `--text-2` at `--fs-note`: the same colour, one pixel apart, so the
     * block was four paragraphs of equal weight. It is now the body colour —
     * the colour of the transcript it stands in for — and the steps are not.
     * That is the whole assertion: the entry point is painted as primary text
     * and the text under it is not. It says nothing about which colour is
     * prettier, and `contrast.test.ts` still owns whether either is readable.
     *
     * The count is the list's own marker now. Each step used to carry an 18px
     * bordered circle — a second, smaller drawing of `.step-n`, which carries
     * *state* on the help page rather than order. `stepMarkers` is the number
     * of those circles still on screen, and it has to be 0 while the list
     * still counts: a `list-style` of `none` with the circles gone would be a
     * block that stopped being countable, which is the other way to fail the
     * same criterion.
     */
    const empty = measurements.filter((m) => m.state === 'empty');
    expect(empty.length, 'no measurement for ?scenario=empty').toBeGreaterThan(0);
    for (const m of empty) {
      const first = m.content.firstRun;
      expect(first, `?scenario=empty at ${m.width}x${m.height} has no first-run block`).not.toBeNull();
      expect(
        first!.leadColor,
        'the first-run lead is not painted as primary text, so the block has no entry point',
      ).toBe(first!.bodyColor);
      expect(
        first!.stepColor,
        'the first-run steps are painted as primary text too, so nothing leads',
      ).not.toBe(first!.bodyColor);
      expect(
        first!.leadSize,
        'the first-run lead is not larger than the steps it introduces',
      ).toBeGreaterThanOrEqual(first!.stepSize);
      expect(
        first!.stepMarkers,
        'the first-run steps carry their own numbered circles again; the list marker is the count',
      ).toBe(0);
      expect(
        first!.listStyle,
        'the first-run steps are no longer counted by the list, so "three steps" is not visible',
      ).toBe('decimal');
    }
    /*
     * And the block is not painted by the three states that always carry
     * content: a `firstRun` reading there would mean the first-run pitch had
     * leaked into a screen that has data to show. `loading` is deliberately
     * not in this list — it is photographed on the frame where the history has
     * not arrived, and what that frame paints is `tests/e2e/scenarios.e2e
     * .test.tsx`'s question (it must say 加载中 and must not say 还没有对话),
     * not this one's.
     */
    const CONTENT_STATES = ['error', 'partial', 'permission'];
    for (const m of measurements.filter((other) => CONTENT_STATES.includes(other.state ?? ''))) {
      expect(
        m.content.firstRun,
        `?scenario=${m.state} painted the first-run block`,
      ).toBeNull();
    }
  });
});

describe('layout in a real browser engine', () => {
  /*
   * First, on purpose.
   *
   * This gate has two ways to be dead. A probe that never finishes leaves no
   * result file, and `beforeAll` throws for that. A probe that *does* finish
   * but fails its very first `loadURL` leaves a result file whose `results`
   * array is empty — and that used to be reported as "the sweep did not visit
   * every surface", a symptom four assertions downstream of the cause, while
   * everything above it passed over an empty list.
   *
   * "Measured nothing" and "measured no problems" must not read the same, so
   * the emptiness is asserted first and by name.
   *
   * The cause is named in the message because the raw error does not name it:
   * on a machine with no usable Chromium sandbox, `loadURL` returns
   * `ERR_FAILED (-2)` even for a `data:` URL and the GPU process dies with an
   * access violation. `ELECTRON_DISABLE_SANDBOX=1` fixes it, CI already sets
   * it (see CONTRIBUTING), and the gate measures geometry, not the sandbox.
   */
  it('measured something at all', () => {
    expect(
      measurements.length,
      'the probe ran but measured nothing, so every geometry assertion below ' +
        'would pass over an empty list.\n' +
        `probe failure: ${failure ?? '(none reported)'}\n` +
        'if that is ERR_FAILED (-2) on the first page load, this machine has no ' +
        'usable Chromium sandbox — re-run with ELECTRON_DISABLE_SANDBOX=1.\n' +
        `--- probe output (tail) ---\n${probeOutput.slice(-1200)}`,
    ).toBeGreaterThan(0);
  });

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
    //
    // The other way to fail here is the display: a window wider than the
    // screen it opens on is clamped to the screen. On a Linux runner that is
    // the Xvfb screen, whose default is 1280 wide — which is how "measured
    // 1280, requested 1440" reads when the virtual display is smaller than the
    // product's own window. The workflow sizes Xvfb for exactly this reason;
    // a failure here therefore names both causes instead of only the number.
    for (const m of GEOMETRY) {
      expect(
        m.viewport.width,
        `${m.name} laid out at ${m.viewport.width}px, not the ${m.width}px it requested. ` +
          'Either the window size included its frame (useContentSize lost), or the ' +
          'display clamped the window: on Linux CI the Xvfb screen must be at least ' +
          'as wide as the widest gated width (see the server-args in .github/workflows/ci.yml).',
      ).toBe(m.width);
    }
  });

  it('reports the height it actually measured', () => {
    // Same honesty for the height axis: the wide-short and tight targets only
    // mean something if the window really laid out at 700px tall. A clamp
    // here is the same display problem on the other axis.
    for (const m of GEOMETRY) {
      expect(
        m.viewport.height,
        `${m.name} laid out at ${m.viewport.height}px tall, not the ${m.height}px it ` +
          'requested — the display clamped the window (on Linux CI, size the Xvfb ' +
          'screen in .github/workflows/ci.yml).',
      ).toBe(m.height);
    }
  });

  it('measured the app, not a shell that had not loaded yet', () => {
    // The first version of this probe waited for `.statusbar` to have text,
    // measured, and reported a clean 1440px — of a first-run screen with no
    // workspace and no sessions, because every read was still in flight. A
    // green measurement of the wrong screen is worse than no gate, so the
    // state that was measured is part of what gets asserted. Only the targets
    // that opened the populated scenario can answer it; see POPULATED.
    for (const m of POPULATED) {
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

    // `state-error` is excluded with the rest: the failed-load pane has no
    // preview column at all, and that is the screen working, not the media
    // query failing.
    for (const m of POPULATED) {
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

  it('sets Chinese text no smaller than Chinese can be read at', () => {
    /*
     * The gap this closes is a category, not a rule.
     *
     * Every assertion above is about where boxes are. None of them can see how
     * big the type is, so the app shipped section labels at 10.5px, table
     * headers at 11px and a caret at 9px — all Chinese — through every round of
     * this gate and a green E2E suite. Han characters fill most of their em
     * box with strokes, so the size at which they stop resolving is genuinely
     * higher than for Latin; the floor lives in scripts/layout-page-scripts.mjs
     * (CJK_FLOOR_PX) and travels in the measurement so this file cannot drift
     * from the stylesheet's contract test.
     *
     * Identifiers keep their small sizes: a path, a hash, a seq number or an
     * arrow glyph is ASCII and the rule only applies to boxes with Han text.
     */
    for (const m of GEOMETRY) {
      expect(
        m.typography.cjkCount,
        `${m.label}: measured ${m.typography.cjkCount} Chinese boxes — the typography ` +
          'rule had nothing to look at on this target',
        // Four, not more: the smallest frame in the product is the failed-load
        // pane (?scenario=error), which is a heading, a sentence, a reason line
        // and a retry button. A threshold above that would be this gate
        // failing on the product's smallest screen rather than on type size.
      ).toBeGreaterThan(3);
      expect(
        m.typography.tooSmall,
        `${m.label}: Chinese set below the ${m.typography.cjkFloor}px floor\n` +
          lines(m.typography.tooSmall),
      ).toEqual([]);
    }
  });

  it('puts no more than four type sizes on any one screen', () => {
    /*
     * `typography.test.ts` resolves the four --fs-* tokens and fails when the
     * stylesheet declares a fifth. That is a fact about the CSS, not about a
     * screen: an inherited size, a browser default on an unstyled control or a
     * rule that typed its own number would all pass it. This assertion is the
     * measured half — the sizes Chromium computed for boxes that had letters to
     * show — and it is the one that has to stay true when a new component
     * arrives with its own idea of "slightly bigger".
     *
     * Four is what a screen holds without the reader noticing the type at all.
     * A fifth size is a decision, and the failure below names the target, every
     * tier it found, and the elements carrying the extra one, because "too many
     * sizes" is not a sentence anyone can act on.
     */
    for (const m of GEOMETRY) {
      const tiers = m.typography.tiers;
      expect(
        tiers.length,
        `${m.label}: measured no type size at all, so the four-tier rule had nothing to look at`,
      ).toBeGreaterThan(0);
      const sizes = tiers.map((tier) => `${tier.fontSize}px`);
      expect(
        tiers.length,
        `${m.label}: ${tiers.length} type sizes on one screen (${sizes.join(', ')}); ` +
          `four is the ceiling. The fifth and beyond:\n` +
          lines(
            tiers.slice(4).map((tier) => ({
              fontSize: tier.fontSize,
              element: tier.element,
              count: tier.count,
              text: tier.text,
            })),
          ),
      ).toBeLessThanOrEqual(4);
    }
  });

  it('keeps the Chinese the reader actually reads at or above the floor', () => {
    /*
     * The floor assertion above is about *every* Han box. This one is about the
     * size most of them are set at — the prose the screen is made of. A screen
     * can satisfy a per-box floor by setting one paragraph at 12px and the rest
     * at 13px, which is correct; it can also drift toward setting everything at
     * the floor, which passes the same rule and reads as fine print. Recording
     * the histogram makes that drift visible in the result, and the assertion
     * keeps the dominant size at or above the floor rather than assuming it.
     */
    for (const m of GEOMETRY) {
      const histogram = m.typography.cjkSizes;
      expect(histogram.length, `${m.label}: measured no Chinese size at all`).toBeGreaterThan(0);
      const dominant = [...histogram].sort((a, b) => b.count - a.count)[0]!;
      expect(
        dominant.fontSize,
        `${m.label}: most Chinese text (${dominant.count} boxes) is set at ` +
          `${dominant.fontSize}px, under the ${m.typography.cjkFloor}px floor`,
      ).toBeGreaterThanOrEqual(m.typography.cjkFloor);
    }
  });

  it('does not tighten Chinese, and gives a wrapped paragraph room to breathe', () => {
    /*
     * Two ways to make dense text worse without making it smaller: pull the
     * letters together (Han already fills its box) and set a multi-line
     * paragraph at a leading close to solid. Both are measurable, so both are
     * measured — the declaration (`letter-spacing: -0.01em`) and the result
     * (a range over the text returning two line boxes 1.2 apart).
     */
    for (const m of GEOMETRY) {
      expect(
        m.typography.negativeTracking,
        `${m.label}: Chinese tracked tighter than its own glyphs\n` +
          lines(m.typography.negativeTracking),
      ).toEqual([]);
      expect(
        m.typography.tightLeading,
        `${m.label}: wrapped Chinese paragraphs set closer than 1.45 line\n` +
          lines(m.typography.tightLeading),
      ).toEqual([]);
    }
  });

  it('draws Chinese on a declared stack, and prose keeps Latin before Han', () => {
    /*
     * The order is not cosmetic. Put a CJK family first and every Latin string
     * in the app — paths, hashes, engine ids — is drawn from a face whose Latin
     * is an afterthought, at a different x-height from the prose around it. Put
     * a generic early and it swallows every family after it on a machine that
     * lacks the named ones.
     *
     * `typography.test.ts` asserts that order against the source. This is the
     * measured half: the stack Chromium actually resolved for boxes that had
     * Han text to show. A `var()` that stopped resolving, a family inherited
     * from an unstyled control, or an inline style on one component would all
     * leave the source assertion green and the screen wrong — and the failure
     * below names the family list and one element carrying it, because "wrong
     * font" is not a sentence anyone can act on.
     *
     * Two roles, two promises, checked separately:
     *
     *  - the prose stack (`--sans`) has to resolve Latin, then Chinese, then a
     *    generic, because most of what a Chinese reader reads here sits on it;
     *  - the identifier stack (`--mono`) has to end in `monospace` and is
     *    **not** required to name a Chinese face: a mono role carrying Han text
     *    (`span.faint` with `本轮`) falls back to the engine's CJK face, which
     *    is correct — there is no monospaced Chinese face on a stock Windows or
     *    macOS install, and naming one would be a family that never resolves.
     *
     * Requiring both stacks to name a Chinese family is what the first version
     * of this assertion did, and it failed on the mono stack for a reason that
     * is not a defect. That failure is preserved here as the rule for the other
     * role instead of being waved away by skipping the mono stacks.
     */
    const declared = declaredStacks();
    let proseBoxes = 0;

    for (const m of GEOMETRY) {
      const measured = m.typography.families;
      expect(
        measured.length,
        `${m.label}: measured no font stack at all, so the stack rule had nothing to look at`,
      ).toBeGreaterThan(0);

      for (const group of measured) {
        const stack = stackFamilies(group.family);
        const resolved = normaliseStack(group.family);
        const where = `${m.label}: ${group.element} (${group.count} box(es), "${group.text}")`;

        // It is one of the two stacks the stylesheet declares — not a third one
        // that arrived by inheritance from an unstyled control, or an inline
        // style on one component.
        expect(
          [declared.sans, declared.mono],
          `${where} was drawn with a stack the stylesheet does not declare: ${group.family}`,
        ).toContain(resolved);

        if (resolved === declared.sans) {
          proseBoxes += group.count;
          const latin = stack.findIndex((family) => LATIN_FAMILY.test(family));
          const han = stack.findIndex((family) => HAN_FAMILY.test(family));
          expect(
            latin,
            `${where} is set on the prose stack but it names no Latin family: ${group.family}`,
          ).toBeGreaterThanOrEqual(0);
          expect(
            han,
            `${where} is set on the prose stack but it names no Chinese family, so Han text ` +
              `falls back to whatever the engine picks: ${group.family}`,
          ).toBeGreaterThan(latin);
          expect(
            GENERIC_FAMILY.has(stack.at(-1)!),
            `${where} does not end in a generic family, so a machine without the named ones ` +
              `falls back to whatever the engine picks: ${group.family}`,
          ).toBe(true);
        } else {
          expect(
            stack.at(-1),
            `${where} is set on the identifier stack but it does not end in monospace, so a ` +
              `machine without the named faces gets a proportional one: ${group.family}`,
          ).toBe('monospace');
        }
      }
    }

    // The prose branch above is the one that matters most, and it is only
    // checked if some Han box really landed on `--sans`. One product change
    // that put every Han box on `--mono` would leave this whole test green
    // while never evaluating the Latin/Han order again.
    expect(
      proseBoxes,
      'no Chinese box anywhere in the run was drawn on the prose stack, so the Latin-before-Han ' +
        'rule above was never evaluated',
    ).toBeGreaterThan(0);
  });

  it('never shears a Chinese glyph into a fake italic', () => {
    /*
     * There is no italic cut of a Han face. `font-style: italic` on Chinese is
     * the engine slanting the upright one, which reads as a rendering bug
     * rather than emphasis — and it is invisible to every geometry rule above,
     * because a sheared glyph is the same size in the same box.
     *
     * `typography.test.ts` asserts that no rule writes `font-style: italic`.
     * This is the measured half: a component that sets it inline, or a browser
     * default on a control nobody styled, would pass that and still ship the
     * shear.
     */
    for (const m of GEOMETRY) {
      expect(
        m.typography.fakeItalics,
        `${m.label}: Chinese drawn with a synthesised italic\n` +
          lines(m.typography.fakeItalics),
      ).toEqual([]);
    }
  });

  it('sets no line of Chinese prose longer than the ceiling', () => {
    /*
     * The defect this exists for was measured, not imagined: the help page's
     * two paragraphs came out at 70.1 and 69.0 Han characters per line at
     * 13px, because they were set to the page column (960px) rather than to a
     * prose measure. Every rule above was green on that screen — the text was
     * inside its card, unclipped, unoverlapped, at 13px with 1.7 leading — and
     * it still read as a wall.
     *
     * The ceiling travels in the measurement (`maxLineCjk`), and the first
     * assertion is that it is the declared one: a measurement that quietly
     * stopped using MAX_PROSE_LINE_CJK would otherwise enforce whatever number
     * it happened to carry.
     */
    const ceiling = declaredProseCeiling();
    for (const m of GEOMETRY) {
      expect(
        m.typeset.maxLineCjk,
        `${m.label}: the measurement used a ${m.typeset.maxLineCjk}-character ceiling, ` +
          `but layout-page-scripts.mjs declares ${ceiling}`,
      ).toBe(ceiling);
      expect(
        m.typeset.longLines,
        `${m.label}: Chinese prose set wider than ${ceiling} characters per line\n` +
          lines(m.typeset.longLines),
      ).toEqual([]);
    }
  });

  it('sets no line of Chinese prose shorter than the floor where the column had room', () => {
    /*
     * The other end of the band. The ceiling above is a reading problem
     * everywhere; the floor is a reading problem only where the column could
     * have been wider, and that condition is the whole rule.
     *
     * Why it is not "every line must be at least 28 characters": at 768px the
     * chat pane is legitimately narrower than 28 characters, and a paragraph
     * there is correct. A gate that flagged it would be a gate about window
     * size — the shape this repository has had to remove before (a geometry
     * check whose verdict depended on the viewport). So the measurement
     * compares the longest line against the floor only when the block's
     * container had at least the floor's worth of room, which is the case where
     * the *block* chose to be narrow: a `max-width` smaller than the measure.
     *
     * The defect this exists for is the mirror image of the ceiling's: the help
     * page's paragraphs were once set to the page column (70 characters); a
     * paragraph capped at 20em inside the same card would be 20, and every
     * other rule here would be green on it.
     *
     * The floor travels in the measurement (`minLineCjk`) and is asserted
     * against the declaration first, for the same reason the ceiling is: a
     * measurement that quietly stopped using MIN_PROSE_LINE_CJK would otherwise
     * enforce whatever number it happened to carry.
     */
    const floor = declaredProseFloor();
    for (const m of GEOMETRY) {
      expect(
        m.typeset.minLineCjk,
        `${m.label}: the measurement used a ${m.typeset.minLineCjk}-character floor, ` +
          `but layout-page-scripts.mjs declares ${floor}`,
      ).toBe(floor);
      expect(
        m.typeset.shortLines,
        `${m.label}: Chinese prose set narrower than ${floor} characters per line in a ` +
          `column that had room for more\n` +
          lines(m.typeset.shortLines),
      ).toEqual([]);
    }
    /*
     * And the rule has to have applied to something. The floor's condition
     * (the container had room) is exactly the kind of condition that can stop
     * being met without anything going red: if every prose block ended up in a
     * narrow container, the assertion above would pass over an empty set on
     * every frame, forever. The help surface is the prose-heavy one, so it is
     * where the count is required to be non-zero; the sweep total is required
     * to be more than a handful, far below the measured count so it fails on a
     * broken measurement rather than on a paragraph being deleted.
     */
    const help = measurements.filter((m) => m.surface === 'help' && m.mounted);
    expect(help.length, 'the sweep never visited the help surface').toBeGreaterThan(0);
    for (const m of help) {
      expect(
        m.typeset.floorChecked,
        `${m.label}: the prose floor was not applied to a single block on the help surface, ` +
          'so the short-line rule above was enforced over nothing',
      ).toBeGreaterThan(0);
    }
    const checked = GEOMETRY.reduce((sum, m) => sum + m.typeset.floorChecked, 0);
    expect(
      checked,
      'the prose floor applied to almost no wrapped Chinese paragraph across the whole ' +
        'sweep, so the short-line rule above was enforced over nothing',
    ).toBeGreaterThan(10);
  });

  it('breaks no line before closing punctuation or after an opening bracket', () => {
    /*
     * 行首禁则 / 行尾禁则. Chromium implements most of UAX #14 by default, so
     * this is expected to be clean — and that is exactly why it is gated: the
     * rules that break it are the ones this stylesheet uses on purpose.
     * `overflow-wrap: anywhere` and `word-break: break-word` let a line break
     * between any two characters, including immediately before a full stop,
     * which leaves '。' alone at the left margin and reads as a typo.
     *
     * The character sets are declared in the page script and travel with the
     * result, so a reader of a failure knows which rule produced it.
     */
    for (const m of GEOMETRY) {
      expect(
        m.typeset.badBreaks,
        `${m.label}: a line broke where Chinese does not allow it\n` +
          lines(m.typeset.badBreaks),
      ).toEqual([]);
    }
  });

  it('measured prose, not just boxes', () => {
    /*
     * A rule that measured nothing is indistinguishable from one that found
     * nothing — the failure this repository has hit often enough to name. Two
     * assertions keep it honest:
     *
     *  - the help surface, which is the prose-heavy one, must have measured at
     *    least two wrapped paragraphs. If the character walk silently stopped
     *    finding lines, this goes red instead of the ceiling passing over an
     *    empty list.
     *  - across the whole sweep, the number of wrapped paragraphs must be more
     *    than a handful. The threshold is deliberately far below the measured
     *    count (see the round's note in docs/dod-status.md) so it fails on a
     *    broken measurement, not on a paragraph being deleted.
     */
    const help = measurements.filter((m) => m.surface === 'help' && m.mounted);
    expect(help.length, 'the sweep never visited the help surface').toBeGreaterThan(0);
    for (const m of help) {
      expect(
        m.typeset.proseBlocks,
        `${m.label}: the help surface's paragraphs were not measured as prose`,
      ).toBeGreaterThanOrEqual(2);
      expect(m.typeset.proseLines, `${m.label}: no wrapped lines were walked`).toBeGreaterThan(2);
    }
    const total = GEOMETRY.reduce((sum, m) => sum + m.typeset.proseBlocks, 0);
    expect(
      total,
      'the prose measurement found almost no wrapped Chinese paragraphs across the ' +
        'whole sweep, so the ceiling above was enforced over nothing',
    ).toBeGreaterThan(10);
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

describe('the rhythm stays on the scale', () => {
  /**
   * Spacing and type size are the scale's job, not markup's.
   *
   * The layout order this repository restored was lost one inline declaration
   * at a time: 121 `marginTop` values across eleven numbers and 81 `fontSize`
   * values across five, each chosen at the call site, which is how one page
   * ended up with 24px between two blocks and 41px between the next pair. The
   * scale (--sp-1..5, --fs-body/note/fine) and its classes (.mt-*, .mb-*,
   * .fs-*) exist so that decision is made once. An inline value here is that
   * decision being made again, quietly, in a fourteenth place.
   *
   * Geometry that is genuinely one-off — a table column's width, a fixed input
   * width, a positioned menu's coordinates — stays inline and stays legal;
   * only the five properties the scale owns are gated.
   */
  const OWNED_BY_SCALE = /\b(marginTop|marginBottom|marginLeft|fontSize|lineHeight)\s*:/;

  function rendererSources(): Array<{ file: string; source: string }> {
    const dir = path.join(REPO_ROOT, 'apps', 'desktop', 'src', 'renderer', 'src');
    return fs
      .readdirSync(dir, { recursive: true })
      .map((entry) => String(entry))
      .filter((name) => name.endsWith('.tsx'))
      .map((name) => ({
        file: name,
        source: fs.readFileSync(path.join(dir, name), 'utf8'),
      }));
  }

  it('adds no spacing or type size from markup', () => {
    const sources = rendererSources();
    expect(sources.length, 'found no renderer sources to scan').toBeGreaterThan(5);

    const offenders: string[] = [];
    for (const { file, source } of sources) {
      for (const match of source.matchAll(/style=\{\{([^{}]*)\}\}/g)) {
        if (OWNED_BY_SCALE.test(match[1]!)) {
          offenders.push(`${file}: style={{ ${match[1]!.trim()} }}`);
        }
      }
    }
    expect(
      offenders,
      'spacing and type size come from the scale via .mt-*/.mb-*/.ml-*/.fs-* classes; ' +
        'an inline value re-opens the per-call-site decision the scale removed\n' +
        offenders.join('\n'),
    ).toEqual([]);
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
