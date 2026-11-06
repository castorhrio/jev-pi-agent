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
 * points at the CSS rule that caused it. Screenshots are written to
 * `.run-logs/` as evidence for a human, and they are never compared against a
 * stored baseline.
 *
 * Two claims *about* the pictures are asserted, and neither is a baseline
 * comparison: which window a picture was taken at (its own IHDR, against the
 * size the target declared), and that two pictures that describe two different
 * states are not the same bytes. The first is metadata, the second can only go
 * red when a state stops being distinguishable — no font hinting, scrollbar or
 * antialiased edge can make it fail.
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
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import electronPath from 'electron';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FAILURE_REASON_SCENARIOS,
  IN_FLIGHT_SCENARIO,
  LONG_REASON_PARAM,
  LONG_REASON_TAIL,
  LONG_REASON_VALUE,
  STATE_SCENARIOS,
} from '../../apps/desktop/src/renderer/src/dev/scenarios';
// The blocks the failed-load screen is measured by, imported rather than
// re-spelled: a selector written twice is a second answer to "which box is the
// failure message", and the day one of them is renamed the gate would keep
// measuring the old one and stay green.
import { FATAL_PROSE_BLOCKS } from '../../scripts/layout-page-scripts.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, '..', '..');
const PROBE = path.join(REPO_ROOT, 'scripts', 'layout-probe.mjs');
const BOOTSTRAP = path.join(REPO_ROOT, 'apps', 'desktop', 'src', 'main', 'bootstrap.ts');
const STYLES = path.join(REPO_ROOT, 'apps', 'desktop', 'src', 'renderer', 'src', 'styles.css');
const APP = path.join(REPO_ROOT, 'apps', 'desktop', 'src', 'renderer', 'src', 'App.tsx');
const I18N = path.join(REPO_ROOT, 'apps', 'desktop', 'src', 'shared', 'i18n.ts');
const PAGE_SCRIPTS = path.join(REPO_ROOT, 'scripts', 'layout-page-scripts.mjs');

/**
 * Where the probe writes its pictures.
 *
 * One constant for the directory because two facts about it exist: the value
 * handed to the probe, and the assertions below that read the pictures back to
 * ask which window each one was taken at. Writing the path out twice would let
 * the assertions look at a directory nothing writes to.
 */
const SHOTS_DIR = path.join(REPO_ROOT, '.run-logs', 'layout');

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
  /**
   * Which variant of a state this target measures, when it is not the plain
   * one. `long-reason` is the same screen with a failure reason of unbounded
   * length; it is a separate target so the plain state's assertions keep
   * meaning what they said.
   */
  variant?: 'long-reason';
  error?: string;
  viewport: { width: number; height: number };
  document: { scrollWidth: number; scrollHeight: number; clientWidth: number };
  content: {
    treeRows: number;
    projectChip: string;
    previewVisible: boolean;
    /**
     * Which of the shell's three regions are on screen.
     *
     * The failed-load screen is the one frame that is deliberately not the
     * shell, and `treeRows` cannot say so: it is 0 both when the rail is absent
     * and when it is present and empty. These three are read by name so the
     * omission can be asserted rather than inferred — see the block below that
     * uses them, and the comment beside the measurement in
     * `scripts/layout-page-scripts.mjs` for the decision they enforce.
     */
    shell: { topbar: boolean; rail: boolean; statusbar: boolean };
    /** App.tsx's 'if (fatal)' screen: the pane a failed first load paints. */
    errorPane: boolean;
    /** The permission prompt, the one overlay that announces itself as a modal. */
    dialogOpen: boolean;
    bodyChars: number;
    /**
     * The failure box's text, when the screen has one.
     *
     * `chars` is the whole string and `head` its first 120 characters, so a
     * gate can assert both "the tail was on screen" and "the label is still
     * the first thing in the box" without shipping the whole reason into the
     * result file.
     */
    failure: { chars: number; head: string } | null;
    /**
     * The failed-load screen's next step, measured against the fold.
     *
     * `docs/state-walkthrough.md` asks whether that screen says what to do next,
     * and the E2E suite pins the order the sentence is written in. This is the
     * same claim on the axis the DOM cannot see: whether the line and the retry
     * button are inside the window a person is looking at, or three lines below
     * it. `null` when no fatal pane is on screen.
     */
    fatalFold: {
      viewportHeight: number;
      next: { top: number; bottom: number };
      retry: { top: number; bottom: number };
      columnHeight: number;
    } | null;
    /**
     * The failed-load screen's column, measured on both axes.
     *
     * `fatalFold` above answers "is the next step inside the window". This
     * answers "is the column inside the window *evenly*", which is the half the
     * `layout` pass changed and the half nothing measured: the rule that
     * centres this column said "centred in the window" while only centring it
     * vertically, so the four blocks sat in the left third of a 1440px window.
     * `content` is the pane's padding box (what the centring happens inside),
     * `ink` the union of the four blocks, and the four margins are the numbers
     * the assertions below compare — two per axis, because a rule that names
     * two directions and implements one is exactly the defect this file has
     * now caught twice.
     *
     * `overflows` is the engine's own answer to "did the column fit in the
     * pane", and it is what makes the vertical pair readable: `safe center`
     * falls back to start alignment when it does not fit, so unequal vertical
     * margins are correct in that frame and a bug in every other one.
     * `null` when no fatal pane is on screen.
     */
    fatalColumn: {
      viewportWidth: number;
      viewportHeight: number;
      content: { left: number; right: number; top: number; bottom: number };
      ink: { left: number; right: number; top: number; bottom: number };
      leftMargin: number;
      rightMargin: number;
      topMargin: number;
      bottomMargin: number;
      blocks: number;
      overflows: boolean;
      scrollHeight: number;
      clientHeight: number;
    } | null;
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
    /**
     * The self-check card on Diagnostics, when that surface is on screen.
     *
     * The three expected lines are the scripts' own output — the feed one is a
     * 250-character sentence — so their length is not something this repository
     * decides. `null` when the card is not on screen, so a surface that lost it
     * cannot be read as one that has an empty card.
     */
    selfCheck: {
      items: number;
      codes: number;
      expected: number;
      codeOverflow: Array<{ element: string; scrollWidth: number; clientWidth: number }>;
      codeOutsideCard: Array<{ element: string; outRight: number }>;
      expectedLines: number[];
      expectedOverflow: Array<{ element: string; scrollWidth: number; clientWidth: number }>;
      cardOverflow: number;
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
    /**
     * The failed-load screen's two prose blocks, measured **by name**.
     *
     * The sweep above is a sweep: it walks whatever is on screen and applies the
     * three paragraph rules to the blocks whose own text is Chinese. On the one
     * screen a person sees when the app cannot start, that leaves the failure box
     * unmeasured — its text is an IPC error or a Windows path, so the sweep's
     * Chinese test skips it — and leaves the next-step sentence measured but
     * unnamed, so a renamed class would quietly take one block out of the sweep
     * and leave the gate green.
     *
     * `present` is reported rather than the row being omitted, so "this frame has
     * no failed-load pane" and "the pane lost its failure box" are two different
     * readings of the same JSON. The numbers are absent when the block is.
     */
    fatalBlocks: Array<{
      name: string;
      selector: string;
      present: boolean;
      chars?: number;
      text?: string;
      fontSize?: number;
      lines?: number;
      longestCjk?: number;
      roomCjk?: number;
      badBreaks?: Array<{ kind: string; char: string; line: number }>;
      lastGlyphs?: number;
      last?: string;
    }>;
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
    /** The floor the measurement used for a paragraph's last line. */
    minLastLineGlyphs: number;
    /**
     * body's computed `text-wrap`, as the engine resolved it.
     *
     * The *means* behind `stubLines`: a browser that dropped `pretty` would
     * resolve `auto` and leave this sweep's result assertion green on the
     * screen where it last measured a runt-free engine.
     */
    textWrap: string;
    /**
     * Paragphs whose final line carries fewer characters than the floor — the
     * runt line. Punctuation is not counted, so '容。' is one character.
     */
    stubLines: Array<{
      element: string;
      fontSize: number;
      lines: number;
      lastGlyphs: number;
      last: string;
      text: string;
    }>;
    /**
     * 中英混排间距, as the engine set it — measured in both directions.
     *
     * The tight side (`boundaries`, `minGapEm`, `underGap`) is the air the engine
     * owes a Han character that touches a Latin one with no space between them.
     * On the current screens that set is **empty** — the app's own text writes the
     * space, and `typography.test.ts` is the half that keeps it that way — so
     * those rows are a guard for text the dictionary does not write (a path, an
     * agent's sentence, something typed into the composer), not a measurement this
     * sweep can make today.
     *
     * The spaced side (`spacedBoundaries`, `maxExtraEm`, `doubleSpaced`) is the
     * other half of "moderate": where the sentence already has a space, the engine
     * must add nothing. 509 boundaries across the gated frames answer that today,
     * all at zero, which is why this direction is the one asserted over real ink.
     *
     * The three `*Em` fields are the numbers the page script compared against,
     * carried out so the assertions below can check them against the exported
     * constants instead of trusting the interpolation still reads them.
     */
    hanLatin: {
      boundaries: number;
      /** Junctions of two boxes, which text-autospace is defined not to space. */
      crossRunEdges: number;
      /**
       * The largest gap measured at one of those junctions, or null when the frame
       * had none — an absent measurement must not be readable as a zero.
       */
      crossRunMaxEm: number | null;
      /** How many of them nevertheless got at least the engine's floor. */
      crossRunWithAir: number;
      spacedBoundaries: number;
      minGapEm: number | null;
      maxExtraEm: number | null;
      gapFloorEm: number;
      gapDeclaredEm: number;
      extraCeilingEm: number;
      underGap: Array<{
        element: string;
        pair: string;
        gapEm: number;
        fontSize: number;
        floorEm: number;
        text: string;
      }>;
      doubleSpaced: Array<{
        element: string;
        pair: string;
        extraEm: number;
        ceilingEm: number;
        text: string;
      }>;
      samples: Array<{ pair: string; gapEm: number; fontSize: number; element: string }>;
      spacedSamples: Array<{ pair: string; extraEm: number; fontSize: number; element: string }>;
    };
    /** body's computed `text-autospace`, as the engine resolved it. */
    textAutospace: string;
  };
  /** axe-core violations, present only on surfaces-bearing targets (round 34). */
  violations?: Array<{
    id: string;
    impact: string | null;
    help: string;
    nodes: Array<{ html: string; target: string[] }>;
  }>;
  axeError?: string;
  /**
   * Set on the rows that caught the app mid-fetch.
   *
   * Copied from the target by the probe. These rows carry `geometry: false` —
   * the frame is measured for content, not for layout — which is exactly why the
   * size and distinctness claims below are made about the *picture* rather than
   * left to the geometry loops, which never see them.
   */
  inFlight?: boolean;
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
 * A PNG's pixel size, read from its IHDR chunk.
 *
 * The same eight-byte signature, four-byte length, `IHDR` type and two
 * big-endian 32-bit integers `screenshots.test.ts` reads. No dependency, because
 * a dependency to read five bytes would be the tail wagging the dog.
 */
function pngSize(bytes: Buffer): { width: number; height: number } | null {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(signature)) return null;
  if (bytes.subarray(12, 16).toString('ascii') !== 'IHDR') return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/**
 * One picture the probe wrote in this run: its bytes and the window it shows.
 *
 * `null` when the file is not there, which the caller has to answer for — a
 * missing picture is the "nothing was measured" shape, not a smaller result.
 *
 * This is *not* a baseline comparison: nothing here knows what the pixels are
 * supposed to look like. The two questions asked of a picture are which window
 * it was taken at (metadata, exactly reproducible) and whether two pictures are
 * the same bytes (a claim about two frames of this same run, so an innocent CSS
 * change cannot break it — only a state that stopped being distinguishable
 * does).
 */
function pictureAt(absolutePath: string): { digest: string; width: number; height: number } | null {
  if (!fs.existsSync(absolutePath)) return null;
  const bytes = fs.readFileSync(absolutePath);
  const size = pngSize(bytes);
  if (size === null) return null;
  return { digest: createHash('sha256').update(bytes).digest('hex'), ...size };
}

/** One picture this run wrote in `SHOTS_DIR`. */
function writtenShot(name: string): { digest: string; width: number; height: number } | null {
  return pictureAt(path.join(SHOTS_DIR, name));
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
 * The last-line floor the measurement is supposed to be using, read the same
 * way as the two line-length numbers above.
 *
 * Its own reader rather than a third number inside one function, for the same
 * reason the ceiling and the floor are separate: they are three rules with
 * three different conditions, and this one is about the only line of a
 * paragraph that neither length rule looks at.
 */
function declaredLastLineFloor(): number {
  const source = fs.readFileSync(PAGE_SCRIPTS, 'utf8');
  const match = /export const MIN_LAST_LINE_GLYPHS = (\d+);/.exec(source);
  expect(
    match,
    'layout-page-scripts.mjs no longer exports MIN_LAST_LINE_GLYPHS, so the last-line ' +
      'floor this gate enforces is not the one the measurement used',
  ).not.toBeNull();
  return Number(match![1]);
}

/**
 * The 中英混排 gap band the measurement is supposed to be enforcing, read out of
 * the page script the way the three numbers above are.
 *
 * Two numbers because the rule cuts both ways: an engine that leaves no air where
 * a Han character touches a Latin one is the failure everybody expects, and an
 * engine that adds its eighth *on top of a space the sentence already wrote* is
 * the one nobody thinks to check — Chinese prose would read as a column of holes.
 * The tolerance decides both, which is why it is one exported constant rather
 * than a number written twice in two comparisons.
 *
 * Comments are stripped first: this file's own prose quotes `0.125` and `0.02`
 * while explaining where they come from, and a regex over raw text reads an
 * explanation as a declaration — the mistake `codeOnly` exists for.
 */
function declaredGapBand(): { ceiling: number; tolerance: number } {
  const source = codeOnly(fs.readFileSync(PAGE_SCRIPTS, 'utf8'));
  const ceiling = /export const MIN_HAN_LATIN_GAP_EM = ([\d.]+);/.exec(source);
  expect(
    ceiling,
    'layout-page-scripts.mjs no longer exports MIN_HAN_LATIN_GAP_EM, so the gap this gate ' +
      'enforces is not the number the measurement used',
  ).not.toBeNull();
  const tolerance = /export const HAN_LATIN_GAP_TOLERANCE_EM = ([\d.]+);/.exec(source);
  expect(
    tolerance,
    'layout-page-scripts.mjs no longer exports HAN_LATIN_GAP_TOLERANCE_EM, so the slack ' +
      'this gate allows is not the slack the measurement allowed itself',
  ).not.toBeNull();
  return { ceiling: Number(ceiling![1]), tolerance: Number(tolerance![1]) };
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
        UCAD_LAYOUT_SHOTS: SHOTS_DIR,
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
     * The two screens that carry a failure message, with a reason of the
     * length the product cannot control.
     *
     * `?reason=long` makes the fixture append a 200-character Windows path to
     * every failure reason: one token, no space, no break opportunity. The
     * fixture's own reasons are one short sentence, so nothing had ever put
     * that shape in front of the box that renders it — and at 768x700 it did
     * not survive it: the notice's scrollWidth was 1562px inside a 429px box
     * and the whole window grew a horizontal scrollbar. `styles.css` now sets
     * `overflow-wrap: anywhere` on `.notice` and `.pane-head p`; these targets
     * are what keeps that true.
     *
     * Built from `FAILURE_REASON_SCENARIOS` rather than from the state names,
     * for the same reason the state targets are: a target URL that spells a
     * walkable state out by hand is what `scenario-states.test.ts` fails.
     */
    ...FAILURE_REASON_SCENARIOS.map((state) => ({
      name: `state-${state}-tight-long-reason`,
      state,
      variant: 'long-reason' as const,
      width: TIGHT.width,
      height: TIGHT.height,
      url: `${base}?scenario=${state}&${LONG_REASON_PARAM}=${LONG_REASON_VALUE}`,
    })),
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
    /*
     * The same frame at the tightest window the product allows.
     *
     * One in-flight size was not enough, and the gap was visible rather than
     * theoretical: `docs/screenshots/states/loading-768x700.png` — the picture
     * the five-minute walkthrough sends a person for the narrow loading state —
     * was byte-for-byte the loaded app at that size, because the only frame
     * caught mid-fetch was the wide one and the settled `?scenario=loading`
     * screen is the ordinary populated window (`dev/scenarios.ts` says so about
     * `IN_FLIGHT_SCENARIO`). A narrow picture of a waiting screen has to be
     * caught while the reads are still out, at the narrow size.
     */
    {
      name: 'loading-frame-tight',
      width: TIGHT.width,
      height: TIGHT.height,
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

  it('drops the shell on the failed-load screen on purpose, and keeps the topbar', () => {
    /*
     * The critique this assertion is the answer to: `?scenario=error` paints a
     * window that is mostly background — an h1, the failure text, one sentence
     * and three buttons — and every round since has written 「窗口其余部分仍是背景色」
     * without deciding whether that is a restrained failure screen or a screen
     * nobody finished. Both readings were defensible, which is why it stayed
     * undecided for three rounds.
     *
     * The decision: the omission is the design. The rail and the statusbar are
     * navigation and state for a workspace that did not load; painting them
     * empty would be a screen claiming to have a project it could not open, and
     * a statusbar with nothing in it is the "measured nothing, found nothing"
     * shape this repository keeps designing against. The topbar stays, because
     * it is the brand and the language switch — the two things a person needs
     * while reading a failure in a language they may not have chosen.
     *
     * What was missing was not the decision but its enforcement: `treeRows` is
     * 0 both when the rail is absent and when it is present and empty, so
     * "left out on purpose" and "forgotten" measured the same thing. Now both
     * directions are asserted — absent on every error frame, present on every
     * populated one — so a round that removes the topbar from the fatal branch,
     * or one that starts painting an empty rail there, goes red and has to say
     * which of the two it meant.
     */
    const error = measurements.filter((m) => m.state === 'error');
    expect(
      error.length,
      'the failed-load screen was never measured, so the shell check below is vacuous',
    ).toBeGreaterThanOrEqual(3);

    for (const m of error) {
      expect(
        m.content.shell.topbar,
        `${m.name}: the failed-load screen lost its topbar — the brand and the language ` +
          'switch are the two things a person reading a failure still needs',
      ).toBe(true);
      for (const region of ['rail', 'statusbar'] as const) {
        expect(
          m.content.shell[region],
          `${m.name}: the failed-load screen painted a .${region} — the omission is the ` +
            'design (see the comment beside the measurement in scripts/layout-page-scripts.mjs); ' +
            'if this screen is now meant to carry the shell, change that comment and this ' +
            'assertion together rather than letting one of them describe the other',
        ).toBe(false);
      }
    }

    // The other direction, so "absent everywhere" cannot pass: the populated
    // frames are the ones that do carry all three, and a rail that stopped
    // rendering would otherwise be reported as the failure screen working.
    expect(POPULATED.length, 'no populated frame was measured').toBeGreaterThan(0);
    for (const m of POPULATED) {
      for (const region of ['topbar', 'rail', 'statusbar'] as const) {
        expect(
          m.content.shell[region],
          `${m.width}px: the populated app has no .${region} — the shell lost a region, and ` +
            'the failed-load screen is the only frame that is supposed to be without one',
        ).toBe(true);
      }
    }
  });

  it('keeps the failed-load screen above the fold, not merely above the buttons', () => {
    /*
     * The fourth `error` criterion in `docs/state-walkthrough.md` is 「这一屏说得出
     * 下一步」, and last round made it measurable: `tests/e2e/scenarios.e2e.test.tsx`
     * asserts `error.fatalNext` comes *before* `error.retry`. That is the whole
     * claim on one axis and nothing on the other — a next step printed below the
     * visible area is a next step for somebody who has already scrolled, and a
     * first-run failure is the screen nobody scrolls on. Ordered correctly and
     * invisible is the same defect wearing a green badge, so this measures the
     * bottom edges against `window.innerHeight` in the real layout engine.
     *
     * Every `error` frame counts, at both window sizes and both reason lengths:
     * the promise is not size-specific, and 200 characters of Windows path is
     * precisely the moment a layout has to keep it. `columnHeight` rides along in
     * the failure so the reader can tell "the column overflowed its window" from
     * "one box sat too low" — two defects with one symptom.
     */
    const failed = measurements.filter((m) => m.state === 'error');
    expect(
      failed.length,
      'the failed-load screen was never measured, so the fold check below is vacuous',
    ).toBeGreaterThanOrEqual(3);

    const outside: string[] = [];
    for (const m of failed) {
      const fold = m.content.fatalFold;
      if (fold === null) {
        outside.push(
          `${m.name}: no next-step line or retry button was found to place — the failed-load ` +
            'pane lost one of them',
        );
        continue;
      }
      for (const [label, box] of [
        ['the next-step line', fold.next],
        ['the retry button', fold.retry],
      ] as const) {
        if (box.bottom > fold.viewportHeight) {
          outside.push(
            `${m.name}: ${label} ends at ${box.bottom}px in a ${fold.viewportHeight}px window ` +
              `(the column is ${fold.columnHeight}px tall) — it is below the fold, so the ` +
              'screen says what to do next somewhere the reader cannot see',
          );
        }
        if (box.top < 0) {
          outside.push(
            `${m.name}: ${label} starts at ${box.top}px — pushed above the window, reachable ` +
              'only by scrolling backwards',
          );
        }
      }
    }
    expect(outside, 'the failed-load screen promises below the fold').toEqual([]);
  });

  it('centres the failed-load column on both axes, not just the vertical one', () => {
    /*
     * The `layout` pass on the failed-load screen, made measurable.
     *
     * `docs/dod-status.md` records the critique: the shell is absent on
     * purpose, the topbar stays, and the four blocks are the whole screen. What
     * it also recorded, one round later, is that the rule centring this column
     * claimed the window and only did one axis — `justify-content: safe center`
     * is vertical, so at 1440x900 the ink sat in the left third of a window
     * whose entire subject is four short blocks. That asymmetry is the
     * difference between "a centred column, which reads as a decision" and "a
     * page that stopped loading halfway", and it is exactly the kind of claim
     * this repository does not accept as a comment.
     *
     * So: on every `error` frame, at both window sizes and both reason lengths,
     * the union of the four blocks must sit inside the pane's padding box with
     * equal margins. Two pixels of slack, because subpixel layout rounds the
     * two edges independently and a gate that fails on 0.5px is a gate people
     * switch off.
     *
     * The two guards against a vacuous pass matter as much as the equality:
     * `blocks` must be 4 (a pane that lost three children is trivially
     * "centred"), and both margins must be positive (a column as wide as its
     * pane has nothing to centre, and would pass the equality by being flush on
     * both sides — the same "measured zero, therefore green" shape this
     * repository has named before).
     */
    const failed = measurements.filter((m) => m.state === 'error');
    expect(
      failed.length,
      'the failed-load screen was never measured, so the centring check below is vacuous',
    ).toBeGreaterThanOrEqual(3);

    const off: string[] = [];
    for (const m of failed) {
      const column = m.content.fatalColumn;
      if (column === null) {
        off.push(`${m.name}: no failed-load column was found to place`);
        continue;
      }
      if (column.blocks !== 4) {
        off.push(
          `${m.name}: the failed-load column has ${column.blocks} block(s), not 4 — the heading, ` +
            'the reason, the next step and the buttons are the whole screen',
        );
        continue;
      }
      if (column.leftMargin <= 0 || column.rightMargin <= 0) {
        off.push(
          `${m.name}: the column is flush against its pane (${column.leftMargin}px / ` +
            `${column.rightMargin}px), so there is no centring to measure`,
        );
        continue;
      }
      if (Math.abs(column.leftMargin - column.rightMargin) > 2) {
        off.push(
          `${m.name}: the column sits ${column.leftMargin}px from the left and ` +
            `${column.rightMargin}px from the right of a ${column.viewportWidth}px window — ` +
            'off-centre, which reads as a page that stopped loading halfway',
        );
      }
    }
    expect(off, 'the failed-load column is not centred on the horizontal axis').toEqual([]);
  });

  it('centres the failed-load column on the vertical axis too, or says why it cannot', () => {
    /*
     * The second axis of the same rule, measured separately.
     *
     * The case above is the horizontal one, and it exists because a rule that
     * said "centred in the window" only centred one direction. Measuring the
     * pair as a single number is how the other direction hides, so this is its
     * own reading: `topMargin` and `bottomMargin` of the union of the four
     * blocks inside the pane's padding box, on every `error` frame, at both
     * window sizes and both reason lengths.
     *
     * Two branches, because `justify-content: safe center` has two behaviours
     * and only one of them is "equal margins":
     *
     *  - the column fits: the two margins are equal within 2px, and both are
     *    positive — a column as tall as its pane has nothing to centre and
     *    would pass the equality by being flush at both ends, which is the
     *    "measured zero, therefore green" shape this repository has named
     *    before;
     *  - the column does not fit: `safe` falls back to start alignment, so the
     *    column must begin at the top of the padding box. That is not a
     *    tolerance, it is the reason the keyword is `safe`: centring an
     *    overflowing column pushes its first line above the scroll origin,
     *    where no scrollbar can reach it. A frame that overflows *and* sits
     *    centred is the bug, and it is reported as one.
     *
     * `fatalFold` above is not this check: it asks whether the next step is
     * inside the window, which a column pinned to the top of the pane also
     * satisfies. This asks whether the column is where the rule says it is.
     */
    const failed = measurements.filter((m) => m.state === 'error');
    expect(
      failed.length,
      'the failed-load screen was never measured, so the vertical centring check is vacuous',
    ).toBeGreaterThanOrEqual(3);

    const off: string[] = [];
    for (const m of failed) {
      const column = m.content.fatalColumn;
      if (column === null) {
        off.push(`${m.name}: no failed-load column was found to place`);
        continue;
      }
      if (column.blocks !== 4) {
        off.push(
          `${m.name}: the failed-load column has ${column.blocks} block(s), not 4 — the heading, ` +
            'the reason, the next step and the buttons are the whole screen',
        );
        continue;
      }
      if (column.overflows) {
        // `safe center` gives up on centring when the column is taller than the
        // pane; the fallback is start alignment, and anything else is a column
        // whose first line is above the scroll origin.
        if (column.topMargin < 0) {
          off.push(
            `${m.name}: the column is ${-column.topMargin}px above the top of its pane ` +
              `(${column.scrollHeight}px of content in ${column.clientHeight}px) — the first ` +
              'line is above the scroll origin, where no scrollbar reaches it',
          );
        } else if (column.topMargin > 2) {
          off.push(
            `${m.name}: the column overflows its pane (${column.scrollHeight}px of content in ` +
              `${column.clientHeight}px) and still starts ${column.topMargin}px down — ` +
              '`safe center` is supposed to fall back to the top when it does not fit',
          );
        }
        continue;
      }
      if (column.topMargin <= 0 || column.bottomMargin <= 0) {
        off.push(
          `${m.name}: the column is flush against its pane (${column.topMargin}px above / ` +
            `${column.bottomMargin}px below), so there is no vertical centring to measure`,
        );
        continue;
      }
      if (Math.abs(column.topMargin - column.bottomMargin) > 2) {
        off.push(
          `${m.name}: the column sits ${column.topMargin}px from the top and ` +
            `${column.bottomMargin}px from the bottom of a ${column.viewportHeight}px window — ` +
            'off-centre on the vertical axis, which is the axis the rule claimed and the ' +
            'horizontal case above cannot see',
        );
      }
    }
    expect(off, 'the failed-load column is not centred on the vertical axis').toEqual([]);
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
        (m) =>
          m.state === state &&
          m.variant === undefined &&
          m.width === TIGHT.width &&
          m.height === TIGHT.height,
      );
      expect(
        tight.map((m) => m.scenario ?? '(not measured)'),
        `?scenario=${state} was not measured at ${TIGHT.width}x${TIGHT.height}`,
      ).toEqual([state]);
    }
  });

  it('survives a failure reason with no break opportunity in it', () => {
    /*
     * The reason half of a failure message is not written by this repository:
     * it is an IPC error, a store that could not be opened, a path that does
     * not exist. Chinese wraps anywhere, so the fixture's own reasons never
     * showed the problem — a Windows path does not, and at 768x700 it pushed
     * the whole window sideways (documentElement.scrollWidth 1691 against 768,
     * the notice's own scrollWidth 1562 inside a 429px box).
     *
     * Four things are asserted, and the first one is what keeps the rest from
     * being vacuous: the tail really was inside the failure box (not merely
     * somewhere on the page), the box did not overflow, nothing escaped the
     * window, and the label is still the first thing in it — a rule that
     * wrapped the reason by pushing the label out would pass a scrollbar check
     * and lose the only part of the message that says *what* failed.
     */
    const long = measurements.filter((m) => m.variant === 'long-reason');
    expect(
      long.map((m) => m.state).sort(),
      'the long-reason targets did not all get measured',
    ).toEqual([...FAILURE_REASON_SCENARIOS].sort());

    const labels = copyFor('sessions.loadFailed');
    expect(labels.length, 'could not read sessions.loadFailed out of the dictionary').toBeGreaterThan(
      0,
    );

    for (const m of long) {
      expect(m.mounted, `?scenario=${m.state}&reason=long did not mount: ${m.error ?? ''}`).toBe(
        true,
      );
      expect(m.scenario, `?scenario=${m.state}&reason=long measured another state`).toBe(m.state);

      const failure = m.content.failure;
      expect(failure, `?scenario=${m.state}&reason=long painted no failure box`).not.toBeNull();
      expect(
        failure!.chars,
        `the long reason never reached the failure box on ?scenario=${m.state} ` +
          `(${failure!.chars} characters, the tail alone is ${LONG_REASON_TAIL.length})`,
      ).toBeGreaterThanOrEqual(LONG_REASON_TAIL.length);
      expect(
        failure!.head,
        `the failure box on ?scenario=${m.state} does not carry the tail: ` +
          JSON.stringify(failure!.head),
      ).toContain(LONG_REASON_TAIL.slice(0, 60));

      expect(
        m.horizontalOverflow,
        `a long failure reason made the window scroll sideways at ` +
          `${m.width}x${m.height} (?scenario=${m.state})`,
      ).toBeLessThanOrEqual(0);
      expect(
        m.escaping.map((e) => e.element),
        `a long failure reason pushed something out of the window (?scenario=${m.state})`,
      ).toEqual([]);
      expect(
        m.clipped.map((c) => `${c.element} ${c.scrollWidth}>${c.clientWidth}`),
        `a long failure reason was cut off instead of wrapped (?scenario=${m.state})`,
      ).toEqual([]);

      if (m.state === 'partial') {
        expect(
          labels.some((copy) => failure!.head.startsWith(copy)),
          `the label is no longer the first thing in the failure box: ` +
            JSON.stringify(failure!.head),
        ).toBe(true);
      }
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

  it('keeps the self-check card inside its own card, on both windows', () => {
    /*
     * The three external blockers used to be a card on Help, phrased as an
     * account of what we had not done. They are now a section of Diagnostics —
     * "here is a command you can run" — and this is the half of that move a
     * person cannot check by reading the diff: the expected lines are the
     * scripts' own output, and the feed one is a 250-character sentence. A card
     * that lets one of them push the pane sideways, or a code block that
     * overflows its own card, is the same defect class as the 70-character
     * prose line — fine in the source, unreadable on screen.
     *
     * Measured at both windows the sweep visits, because the tight one is where
     * a long unbroken sentence actually gives out.
     */
    const diagnostics = measurements.filter((m) => m.surface === 'diagnostics' && m.mounted);
    expect(diagnostics.length, 'the sweep never visited the diagnostics surface').toBeGreaterThan(0);

    for (const m of diagnostics) {
      const card = m.content.selfCheck;
      expect(card, `${m.label}: the self-check card is not on the diagnostics surface`).not.toBeNull();
      if (card === null) continue;

      // Not vacuous: three blockers, three commands, three expected lines.
      expect(card.items, `${m.label}: the card shows ${card.items} block(s)`).toBe(3);
      expect(card.codes, `${m.label}: the card shows ${card.codes} command block(s)`).toBe(3);
      expect(card.expected, `${m.label}: the card shows ${card.expected} expected line(s)`).toBe(3);

      expect(
        card.codeOverflow,
        `${m.label}: a command block is wider than its own box\n${lines(card.codeOverflow)}`,
      ).toEqual([]);
      expect(
        card.codeOutsideCard,
        `${m.label}: a command block sits outside the card\n${lines(card.codeOutsideCard)}`,
      ).toEqual([]);
      expect(
        card.expectedOverflow,
        `${m.label}: an expected line is clipped by its box\n${lines(card.expectedOverflow)}`,
      ).toEqual([]);
      expect(
        card.cardOverflow,
        `${m.label}: the card scrolls sideways by ${card.cardOverflow}px`,
      ).toBeLessThanOrEqual(0);

      /*
       * Four lines is the ceiling, not a measurement: the longest expected line
       * is a 250-character sentence, and a card that turns it into nine lines
       * has stopped being a line you can read off the screen. The number is
       * asserted rather than recorded so a stylesheet change that halves the
       * card's width fails here instead of shipping.
       */
      for (const [index, count] of card.expectedLines.entries()) {
        expect(
          count,
          `${m.label}: expected line ${index + 1} wrapped to ${count} lines`,
        ).toBeLessThanOrEqual(4);
      }
    }

    /*
     * And it is not on Help any more. The move is the point of the change, and
     * a copy left behind would be the second copy of one fact this repository
     * keeps removing — with the extra twist that the two copies would be on two
     * pages, so nobody would ever see them disagree.
     */
    const help = measurements.filter((m) => m.surface === 'help' && m.mounted);
    expect(help.length, 'the sweep never visited the help surface').toBeGreaterThan(0);
    for (const m of help) {
      expect(
        m.content.selfCheck,
        `${m.label}: the self-check card is still on the help surface`,
      ).toBeNull();
    }
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
     *
     * Every in-flight target is asked, not the one the case remembers by name:
     * the narrow frame arrived because a person is told to judge the loading
     * state at two window sizes, and a check that names one of them would leave
     * the other asserted by nobody.
     */
    const frames = measurements.filter((m) => m.inFlight === true);
    expect(frames.length, 'no in-flight frame was measured at all').toBeGreaterThan(0);
    for (const frame of frames) {
      expect(
        frame.flight?.pending,
        `${frame.name}: never caught a read in flight, so nothing about the loading frame was measured`,
      ).toBeGreaterThan(0);
      expect(
        frame.flight?.sawLoadingCopy,
        `${frame.name}: the loading copy was not on screen while fetching`,
      ).toBe(true);
      expect(
        frame.flight?.bodyChars ?? 0,
        `${frame.name}: the frame while fetching was effectively blank`,
      ).toBeGreaterThan(50);
    }
  });

  it('photographs each in-flight frame at the size that target declares', () => {
    /*
     * The in-flight branch loads a page and reads it, and until this round it
     * never resized the window. So the frame the target calls 1440x900 was
     * caught at whatever size the previous target had left the window — which
     * was 768x700, and the picture written for it says so.
     *
     * Nothing could notice: every geometry rule in this file runs over the rows
     * that are *not* `geometry: false`, and the in-flight row is the one that is.
     * The one claim a picture makes that needs no pixels is which window it was
     * taken at, and that is what is asserted here.
     */
    const frames = measurements.filter((m) => m.inFlight === true);
    expect(frames.length, 'no in-flight frame was measured, so this case had no subject').toBeGreaterThan(
      0,
    );
    for (const frame of frames) {
      const shot = writtenShot(`${frame.name}.png`);
      expect(
        shot,
        `${frame.name}: the probe wrote no picture at ${SHOTS_DIR}/${frame.name}.png, so the ` +
          'frame it claims to have caught cannot be looked at',
      ).not.toBeNull();
      expect(
        { width: shot!.width, height: shot!.height },
        `${frame.name}: the picture is ${shot!.width}x${shot!.height} and the target declares ` +
          `${frame.width}x${frame.height} — the window was never resized to the size being measured`,
      ).toEqual({ width: frame.width, height: frame.height });
    }
  });

  it('shows a waiting screen that is not the same picture as the loaded app', () => {
    /*
     * Two committed screenshots said otherwise, and the claim they made is the
     * one step 6 asks a person to judge: `docs/screenshots/states/loading.png`
     * and `docs/screenshots/states/loading-768x700.png` were byte-for-byte
     * `chat.png` and the loaded app at 768x700. Not "similar" — the same bytes.
     *
     * The reason was in plain sight in `dev/scenarios.ts`: `loading` delays
     * every read, so the *settled* screen of that scenario is the ordinary
     * populated window. The state targets wait for the app to settle (that is
     * what makes their geometry comparable), so the picture they write is of a
     * frame that has finished loading, under a name that says it has not.
     *
     * This compares two frames of the same run on the same machine, so it is not
     * the pixel-baseline diff this file refuses: nothing here says what the
     * picture should look like. It says a state that is supposed to be waiting
     * has to be a *different picture* from the state that is done.
     */
    const pairs = [
      { waiting: 'loading-frame.png', loaded: 'layout-1440-chat.png' },
      { waiting: 'loading-frame-tight.png', loaded: 'layout-768x700-chat.png' },
    ];
    for (const { waiting, loaded } of pairs) {
      const wait = writtenShot(waiting);
      const done = writtenShot(loaded);
      expect(wait, `${waiting} was never written, so the waiting frame is not evidence`).not.toBeNull();
      expect(done, `${loaded} was never written, so there is nothing to compare it with`).not.toBeNull();
      expect(
        wait!.digest,
        `${waiting} and ${loaded} are the same bytes: the picture taken for the state that is ` +
          'still fetching shows a page that has finished fetching, so nobody can judge what a ' +
          'waiting screen looks like',
      ).not.toBe(done!.digest);
    }

    /*
     * And the reason the rule is needed, measured in the same run rather than
     * argued about: the *settled* picture of this state is the loaded app, byte
     * for byte. `dev/scenarios.ts` says this about `IN_FLIGHT_SCENARIO` in prose
     * ("the settled screen is the ordinary populated one"); a sentence in a
     * document is what the last four rounds read and worked around, and two
     * digests are what decides it.
     *
     * If this ever goes red, the fixture changed so that `?scenario=loading`
     * keeps waiting: the state target would then be photographing a real waiting
     * screen, and the in-flight pair above stops being the only honest source for
     * the loading-state pictures. Re-read this file before deleting either half.
     */
    const settled = writtenShot('state-loading-chat.png');
    const loaded = writtenShot('layout-1440-chat.png');
    expect(settled, 'the settled loading-state frame was never photographed').not.toBeNull();
    expect(
      settled!.digest,
      'the settled `?scenario=loading` frame is no longer the loaded app: the fixture changed, so ' +
        'check whether the state target can be the loading picture again (see the note above)',
    ).toBe(loaded!.digest);
  });

  it('ships loading-state pictures that are not photographs of a finished load', () => {
    /*
     * The half a reader actually meets. Everything above is about frames this run
     * caught; the files `docs/state-walkthrough.md` and `docs/manual-verification.md`
     * send a person to live in `docs/screenshots/`, and both of them were the
     * loaded app — `states/loading.png` was even byte-identical to `chat.png`,
     * which is why `screenshots.test.ts` now forbids duplicate pictures.
     *
     * The comparison is against the loaded frame *this run* photographed, so it
     * can only fail on the machine where somebody copied the settled frame into
     * the loading-state file — the exact act being prevented. A machine whose
     * render differs from the committed bytes passes: this is not the pixel
     * baseline the header of this file refuses, because nothing here claims what
     * the picture has to look like. It claims which frame it is not.
     */
    const pairs = [
      { committed: 'docs/screenshots/states/loading.png', loaded: 'layout-1440-chat.png' },
      {
        committed: 'docs/screenshots/states/loading-768x700.png',
        loaded: 'layout-768x700-chat.png',
      },
    ];
    for (const { committed, loaded } of pairs) {
      const shipped = pictureAt(path.join(REPO_ROOT, committed));
      const done = writtenShot(loaded);
      expect(
        shipped,
        `${committed} is missing or is not a PNG, so the walkthrough is pointing at nothing`,
      ).not.toBeNull();
      expect(
        done,
        `${loaded} was never photographed, so there is no finished-load frame to compare with`,
      ).not.toBeNull();
      expect(
        shipped!.digest,
        `${committed} is the same picture as ${loaded}: the walkthrough asks a person to judge ` +
          'what a waiting screen looks like using a photograph of a screen that already loaded. ' +
          'Copy the in-flight frame instead — the probe writes it as ' +
          '`loading-frame.png` / `loading-frame-tight.png`',
      ).not.toBe(done!.digest);
    }
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

  it('leaves no paragraph ending on a runt line', () => {
    /*
     * 孤字行. The two rules above look at the longest line and at the breaks
     * between lines; neither looks at the *last* line, which is exempt by
     * definition — the last line of a paragraph is short, and there is no break
     * after it. That exemption is where a paragraph can end on '容。' alone:
     * legal under every rule here, and the one thing a reader notices when it
     * happens, because the eye lands on a single character under eleven full
     * lines and reads it as a mistake.
     *
     * This was measured before it was asserted. `?scenario=empty` ended
     * '.preview-body .faint' ('发送一轮指令后，这里会显示 Agent 实际收到的内容。')
     * on '容。', and `?scenario=permission` ended the dialog's own note on
     * '批。' — at 1440x900 *and* at 768x700, so it was not a narrow-window
     * effect. The fix is one declaration in styles.css ('text-wrap: pretty') and
     * the note there records why 'balance' — which also removes both — is the
     * wrong tool.
     *
     * The floor travels in the measurement and is checked against the
     * declaration first, like the two line-length numbers: a measurement that
     * quietly stopped using MIN_LAST_LINE_GLYPHS would otherwise enforce
     * whatever number it happened to carry.
     */
    const floor = declaredLastLineFloor();
    for (const m of GEOMETRY) {
      expect(
        m.typeset.minLastLineGlyphs,
        `${m.label}: the measurement used a ${m.typeset.minLastLineGlyphs}-character ` +
          `last-line floor, but layout-page-scripts.mjs declares ${floor}`,
      ).toBe(floor);
      expect(
        m.typeset.stubLines,
        `${m.label}: a Chinese paragraph ends on a runt line (under ${floor} characters ` +
          'of text on its last line)\n' + lines(m.typeset.stubLines),
      ).toEqual([]);
    }
  });

  /*
   * The failed-load screen, typeset.
   *
   * ## Why this block exists
   *
   * `7faf47e` made the failed-load screen say *which step failed* and *what to do
   * next*, and the round that wrote it recorded what it did not do: 「窗口其余部分
   * 仍是背景色」. The blocks it added are the only prose on the one screen a
   * person sees when the app cannot start at all, and neither was measured:
   *
   *  - the failure box (`.notice.error`) holds the string the product did not
   *    write — an IPC error, a store that could not be opened, a Windows path. It
   *    is ASCII, so the sweep's `CJK.test(own)` skips it: the box carrying the
   *    longest line on the screen was the one block no rule looked at.
   *  - the next-step sentence (`.fatal-next`) is Chinese and does wrap, so the
   *    sweep does measure it — but nothing said so. A renamed class or a removed
   *    paragraph would have left the sweep measuring one block fewer and the gate
   *    green, which is the "measured nothing, found nothing" shape this file keeps
   *    having to design against.
   *
   *  - the lead sentence (`.pane-head p`) is the third, and it was named last:
   *    it is one short Chinese sentence today, so the sweep does measure it —
   *    but the sweep's condition is `CJK.test(own)`, and the English half of the
   *    same sentence is ASCII. A lead that grew into a paragraph in English
   *    would wrap, carry a measure, and be measured by nobody. Naming it costs
   *    nothing on the frames where it is one line (a block that did not wrap has
   *    no measure to judge) and closes the shape `.notice.error` had.
   *
   * So all three are measured by selector on every frame (`FATAL_PROSE_BLOCKS` in
   * `scripts/layout-page-scripts.mjs`), and the rules below are the sweep's own
   * three — line length against the ceiling and the floor, 行首禁则 / 行尾禁则, and
   * the last-line floor — applied to a block whether or not its text is Chinese:
   * a 200-character path wraps into lines just as long as a Chinese paragraph's,
   * and the last line of a wrapped path can be a runt just as easily.
   *
   * The floor keeps the sweep's condition, and it is the whole rule: a block that
   * did not wrap has no measure to judge (the failure box is one 19-character line
   * at 1440px in a column with room for 80), and a block whose container was
   * narrower than the floor could not have been wider. What is asserted is that
   * the condition was met somewhere — otherwise the floor would be enforced over
   * an empty set on every frame, forever.
   */

  /** The blocks of one failed-load frame, with `present` already asserted. */
  function fatalBlocksOf(m: Measurement): Array<Measurement['typeset']['fatalBlocks'][number]> {
    const blocks = m.typeset.fatalBlocks;
    expect(
      blocks.map((block) => block.name),
      `${m.label}: the failed-load screen's blocks are not the ones the page script declares`,
    ).toEqual(FATAL_PROSE_BLOCKS.map((block) => block.name));
    expect(
      blocks.map((block) => block.selector),
      `${m.label}: the measurement looked for different selectors than the page script declares`,
    ).toEqual(FATAL_PROSE_BLOCKS.map((block) => block.selector));
    for (const block of blocks) {
      expect(
        block.present,
        `${m.label}: ${block.selector} was not on the failed-load screen — the block the ` +
          'screen exists for is missing, so the rules below would be enforced over nothing',
      ).toBe(true);
    }
    return blocks;
  }

  it('measures every block of the failed-load screen, and none on any other screen', () => {
    /*
     * The presence half. Without it every rule below could pass over an empty
     * list: a selector that stopped matching reports `present: false` and no
     * numbers, and a gate that only reads the numbers would call that clean.
     *
     * The other direction matters as much: a `.notice.error` that started
     * appearing on the populated shell would mean the failure box is no longer
     * the failed-load screen's own, and the numbers below would be measuring a
     * different box under the same name.
     */
    const failed = measurements.filter((m) => m.state === 'error');
    expect(
      failed.length,
      'the failed-load screen was never measured, so this block is vacuous',
    ).toBeGreaterThanOrEqual(3);
    for (const m of failed) {
      for (const block of fatalBlocksOf(m)) {
        expect(
          block.chars,
          `${m.label}: ${block.selector} was on screen with no text in it`,
        ).toBeGreaterThan(0);
      }
    }
    for (const m of GEOMETRY.filter((other) => other.state !== 'error')) {
      for (const block of m.typeset.fatalBlocks) {
        expect(
          block.present,
          `${m.label}: ${block.selector} was on a screen that is not the failed-load pane`,
        ).toBe(false);
      }
    }
  });

  it('measures the failure box the sweep cannot see, which is why it is named', () => {
    /*
     * The reason this block exists at all, asserted rather than described: the
     * failure box's own text carries no Han character, so the sweep's
     * `CJK.test(own)` skips it. If that ever stops being true the named
     * measurement is still correct — but the argument for it would have changed,
     * and this case is what makes somebody re-read it instead of assuming.
     */
    const failed = measurements.filter((m) => m.state === 'error');
    const failure = failed.map((m) => fatalBlocksOf(m)[0]!);
    expect(failure.length).toBeGreaterThan(0);
    for (const block of failure) {
      expect(
        block.text,
        'the failure box now carries Chinese, so the sweep would measure it too — the ' +
          'comment above FATAL_PROSE_BLOCKS says it does not',
      ).not.toMatch(/[\u4e00-\u9fff]/u);
    }
  });

  it('sets no line of the failure box or the next step wider than the ceiling', () => {
    /*
     * The ceiling is the one rule that applies to every block, wrapped or not:
     * a single line longer than the measure is a line the eye loses its place
     * on, and the failure box is exactly where a long unbroken path lands.
     */
    const ceiling = declaredProseCeiling();
    const tooWide: string[] = [];
    for (const m of measurements.filter((frame) => frame.state === 'error')) {
      for (const block of fatalBlocksOf(m)) {
        if ((block.longestCjk ?? 0) > ceiling) {
          tooWide.push(
            `${m.label}: ${block.selector} sets a ${block.longestCjk}-character line ` +
              `(ceiling ${ceiling}) — ${JSON.stringify(block.text)}`,
          );
        }
      }
    }
    expect(tooWide, 'the failed-load screen sets a line wider than the measure').toEqual([]);
  });

  it('gives a wrapped failure box the same floor as a paragraph', () => {
    /*
     * The floor's condition is the rule, and it is the sweep's: only a block that
     * wrapped, in a container that had room for the floor, can be too narrow. The
     * failure box at 1440px is one 19-character line in a column with room for 80
     * — nothing to judge — while the same box with a 200-character path at 768px
     * wraps to five lines and is judged.
     *
     * The count at the end is what keeps this from being a rule about nothing: if
     * every fatal block stopped wrapping, the loop above would pass over an empty
     * set on every frame and the floor would be enforced nowhere.
     */
    const floor = declaredProseFloor();
    const tooNarrow: string[] = [];
    let judged = 0;
    for (const m of measurements.filter((frame) => frame.state === 'error')) {
      for (const block of fatalBlocksOf(m)) {
        if ((block.lines ?? 0) < 2) continue;
        if ((block.roomCjk ?? 0) < floor) continue;
        judged += 1;
        if ((block.longestCjk ?? 0) < floor) {
          tooNarrow.push(
            `${m.label}: ${block.selector} sets a ${block.longestCjk}-character line in a ` +
              `column that had room for ${block.roomCjk} (floor ${floor})`,
          );
        }
      }
    }
    expect(tooNarrow, 'the failed-load screen sets a wrapped block narrower than the floor').toEqual(
      [],
    );
    expect(
      judged,
      'no failed-load block wrapped in a column with room for the floor, so the rule above ' +
        'was enforced over nothing',
    ).toBeGreaterThan(0);
  });

  it('breaks no line in the failure box or the next step where Chinese does not allow it', () => {
    /*
     * 行首禁则 / 行尾禁则 on the blocks the sweep does not name. The failure box
     * is the one place in the product where `overflow-wrap: anywhere` is load
     * bearing — it is what keeps a 200-character path inside its box — and that
     * same declaration is what lets a line break immediately before a full stop.
     * So the rule is measured on the block that declaration was written for.
     */
    const bad: string[] = [];
    for (const m of measurements.filter((frame) => frame.state === 'error')) {
      for (const block of fatalBlocksOf(m)) {
        for (const entry of block.badBreaks ?? []) {
          bad.push(
            `${m.label}: ${block.selector} broke line ${entry.line} ${entry.kind} at ` +
              `'${entry.char}' — ${JSON.stringify(block.text)}`,
          );
        }
      }
    }
    expect(bad, 'the failed-load screen breaks a line where Chinese does not allow it').toEqual([]);
  });

  it('leaves neither block of the failed-load screen ending on a runt line', () => {
    /*
     * 孤字行, on the screen where the last line is the one that says what to do.
     * `MIN_LAST_LINE_GLYPHS` was enforced over the sweep's Chinese paragraphs and
     * over nothing else; the failure box is exempt from the sweep by language, so
     * a path that ended on one character under four full lines would have been
     * legal under every rule in this file.
     *
     * The floor travels in the measurement and is checked against the declaration
     * first, like the two line-length numbers: a measurement that quietly stopped
     * using MIN_LAST_LINE_GLYPHS would otherwise enforce whatever number it
     * happened to carry.
     */
    const floor = declaredLastLineFloor();
    const runts: string[] = [];
    for (const m of measurements.filter((frame) => frame.state === 'error')) {
      for (const block of fatalBlocksOf(m)) {
        if ((block.lastGlyphs ?? 0) < floor) {
          runts.push(
            `${m.label}: ${block.selector} ends on ${JSON.stringify(block.last)} ` +
              `(${block.lastGlyphs} glyph(s), floor ${floor})`,
          );
        }
      }
    }
    expect(runts, 'the failed-load screen ends a block on a runt line').toEqual([]);
  });

  it('has the engine apply the last-line rule, and says which value it applied', () => {
    /*
     * 孤字行 has two ways to come back, and until this case only one of them was
     * gated.
     *
     * `stubLines` is the *result*: no paragraph's final line carries fewer than
     * MIN_LAST_LINE_GLYPHS characters of text. It is measured in whatever engine
     * the run happens to boot, which is the product's engine today — so a
     * browser that did not understand `text-wrap: pretty` would drop the
     * declaration, resolve `auto`, and leave the result assertion green on the
     * frames that happen to break where they always did. The runts would then
     * only reappear when a paragraph's text or the window changed, i.e. after
     * the gate said the rule was in place.
     *
     * This is the *means*: body's computed `text-wrap` has to be the value
     * styles.css declares. Two assertions, because they fail differently and a
     * reader needs to know which one broke — the declaration disappearing from
     * the stylesheet, or the engine not applying a declaration that is still
     * there.
     *
     * The declaration is read with comments stripped for the same reason the
     * window geometry is: this stylesheet explains itself in prose, and the
     * explanation of `pretty` (and of why `balance` was refused) lives in the
     * same rule it describes. A regex over raw text would pass on the comment
     * alone, which is the failure `codeOnly` exists to prevent.
     */
    const css = codeOnly(fs.readFileSync(STYLES, 'utf8'));
    const body = /(?:^|\n)body\s*\{([^}]*)\}/.exec(css);
    expect(
      body,
      'styles.css has no `body { … }` rule any more, so the last-line rule has no home',
    ).not.toBeNull();
    expect(
      body![1],
      'styles.css `body` no longer declares `text-wrap: pretty`; `stubLines` can stay green ' +
        'for a round on the frames it measured and the runts return everywhere else',
    ).toMatch(/text-wrap:\s*pretty\s*;/);

    const floor = declaredLastLineFloor();
    for (const m of GEOMETRY) {
      expect(
        m.typeset.textWrap,
        `${m.label}: the engine resolved body's \`text-wrap\` to ` +
          `"${m.typeset.textWrap || '(empty)'}", not \`pretty\`. ` +
          'Either styles.css `body { text-wrap: pretty }` lost its declaration, or this ' +
          'engine dropped it and fell back to `auto` — the value `.preview-body .faint` ' +
          `ended on '容。' under. MIN_LAST_LINE_GLYPHS is ${floor}: ` +
          'with `auto` the floor is a rule about luck, not about the engine.',
      ).toContain('pretty');
    }
  });

  it('leaves the air the sentence already paid for alone', () => {
    /*
     * 中英混排间距, the direction this app can measure today.
     *
     * Where a Chinese sentence puts a space between the two scripts, the engine
     * must not also insert its own eighth. Nobody writes that rule down as a
     * defect to look for — it is the *loose* half of the same checklist item, and
     * it is invisible until prose starts reading as a column of holes.
     *
     * It is asserted over real ink rather than over an empty list because that is
     * what the sweep holds: every boundary the app's own text puts on screen is
     * spaced, hundreds of them across the frames, and every one measures 0em of
     * engine insertion. So the count is part of the assertion: a `doubleSpaced`
     * list over nothing would look exactly like this one, and `spacedBoundaries`
     * is what tells the two apart.
     *
     * The tolerance is checked against the exported constants before the verdict
     * is read, like the three line-length numbers above: a measurement that
     * quietly stopped interpolating HAN_LATIN_GAP_TOLERANCE_EM would otherwise
     * enforce whatever slack it happened to carry.
     */
    const band = declaredGapBand();
    for (const m of GEOMETRY) {
      const gap = m.typeset.hanLatin;
      expect(
        gap.extraCeilingEm,
        `${m.label}: the measurement allowed itself ${gap.extraCeilingEm}em of extra air, ` +
          `but layout-page-scripts.mjs declares HAN_LATIN_GAP_TOLERANCE_EM = ${band.tolerance}`,
      ).toBe(band.tolerance);
      expect(
        gap.doubleSpaced,
        `${m.label}: the engine added air on top of a space that was already there — ` +
          `中英混排 over ${gap.spacedBoundaries} spaced boundaries here, and a Chinese ` +
          'sentence set like that reads as a column of holes\n' + lines(gap.doubleSpaced),
      ).toEqual([]);
    }
    const spaced = GEOMETRY.reduce((sum, m) => sum + m.typeset.hanLatin.spacedBoundaries, 0);
    expect(
      spaced,
      'the spacing measurement walked no spaced Han/Latin boundaries across the sweep, so ' +
        'the assertion above was enforced over an empty list — either the walk stopped ' +
        'finding boundaries or the product stopped writing spaces between the two scripts, ' +
        'and both are defects this case exists to name',
    ).toBeGreaterThan(100);
  });

  it('has the engine give air where one run puts the two scripts together', () => {
    /*
     * 中英混排间距, the guard.
     *
     * Where a Han character touches a Latin one with *no* space between them, the
     * engine's `text-autospace: normal` is what keeps the word readable — and that
     * is the only case where the gap has to come from the stylesheet rather than
     * from the sentence.
     *
     * Two facts measured on the current build decide what this case may claim.
     *
     *  - Inside one text run, Chromium does insert the eighth: a boundary written
     *    tight ('显示Agent' in `context.waiting`) measures 0.125em at 13px, and the
     *    same boundary with the declaration removed measures 0em. That is the case
     *    this assertion is for — text the dictionary does not write, which is to
     *    say a path, a digest, an agent's sentence, something typed into the
     *    composer. Today the app's own strings leave this set empty — 178 spaced
     *    Han/letter boundaries and 45 interpolation slots, none of them touching a
     *    Han character, which is `typography.test.ts`'s census to keep and this
     *    case's guard to stay green for a reason. The mutation that tightens one of
     *    those boundaries is recorded in `docs/dod-status.md` with the message it
     *    produced, because a guard nobody has seen fail is a decoration.
     *  - At the junction of two boxes — a label's last character and a value
     *    element's first — Chromium inserts nothing, and this app has 0 to 13 of
     *    those per frame, 225 across the gated sweep ('.def .k', '.badge', '.v',
     *    'button.link'). They are not defects and not this rule's: the separation
     *    there is the row's own gap, which the overlap and clipping assertions
     *    above already measure. Counting
     *    them is what proves the flow walk really crosses nodes; asserting an
     *    eighth at them would blame the stylesheet for a fact about flex layout.
     *
     * Both numbers are read back out of the page script first, so this case cannot
     * be green because the measurement drifted away from the declared band.
     */
    const band = declaredGapBand();
    for (const m of GEOMETRY) {
      const gap = m.typeset.hanLatin;
      expect(
        gap.gapDeclaredEm,
        `${m.label}: the measurement compared against ${gap.gapDeclaredEm}em, but ` +
          `layout-page-scripts.mjs declares MIN_HAN_LATIN_GAP_EM = ${band.ceiling}`,
      ).toBe(band.ceiling);
      expect(
        gap.gapFloorEm,
        `${m.label}: the gap floor the measurement used is ${gap.gapFloorEm}em, not the ` +
          `${band.ceiling}em minus the ${band.tolerance}em tolerance this gate enforces — ` +
          'the page script stopped reading its own exported constants',
      ).toBe(band.ceiling - band.tolerance);
      expect(
        gap.underGap,
        `${m.label}: a Han character touches a Latin one with less than ` +
          `${band.ceiling - band.tolerance}em of air, and nothing in the sentence supplied ` +
          'it — the text is either interpolated into Chinese without a space (see ' +
          'typography.test.ts) or the engine stopped applying text-autospace\n' +
          lines(gap.underGap),
      ).toEqual([]);
    }
    const cross = GEOMETRY.reduce((sum, m) => sum + m.typeset.hanLatin.crossRunEdges, 0);
    expect(
      cross,
      'the spacing walk found no boundary at the junction of two boxes anywhere in the ' +
        'sweep, which is what a React-assembled label and its value always are — the pass ' +
        'stopped joining text nodes, and every count above is then measured over nothing',
    ).toBeGreaterThan(50);
    /*
     * And the exclusion the page script applies to those junctions is measured, not
     * assumed. It skips them because Chromium inserts nothing there — a fact about
     * this engine, stated in a comment, which is the kind of sentence this
     * repository has kept having to turn into an assertion. So each frame reports
     * the largest gap it saw at a box junction: if a later engine starts spacing
     * them, the exclusion is a rule that has outlived its reason, and this is the
     * case that says so instead of the rows quietly keeping their air for a reason
     * nobody can name.
     */
    for (const m of GEOMETRY) {
      const junctions = m.typeset.hanLatin;
      if (junctions.crossRunMaxEm === null) continue;
      expect(
        Math.abs(junctions.crossRunMaxEm),
        `${m.label}: the gap rule skips every Han/Latin boundary at the junction of two boxes ` +
          `because this engine leaves them at zero, and this frame measured ` +
          `${junctions.crossRunMaxEm}em over ${junctions.crossRunEdges} of them — the ` +
          'exclusion in layout-page-scripts.mjs needs re-reading, and so does whatever the ' +
          'row layout is doing there',
      ).toBeLessThanOrEqual(band.tolerance);
    }
  });

  it('resolves the gap the stylesheet declared, in this engine', () => {
    /*
     * The means, next to the two results, for the same reason `text-wrap` is:
     * `text-autospace` is the property that decides the tight direction, and a
     * browser that did not understand it would drop the declaration and resolve
     * the initial value anyway. Today the tight set is empty, so a lost
     * declaration would leave both result assertions above green — this is the
     * assertion that cannot be green for the wrong reason, and it is what makes
     * the guard above a guard rather than a note.
     */
    const css = codeOnly(fs.readFileSync(STYLES, 'utf8'));
    const body = /(?:^|\n)body\s*\{([^}]*)\}/.exec(css);
    expect(body, 'styles.css has no `body { … }` rule any more').not.toBeNull();
    expect(
      body![1],
      'styles.css `body` no longer declares `text-autospace: var(--text-autospace)`; the gap ' +
        'between the two scripts is then whatever the engine feels, and the tight-boundary ' +
        'guard above goes green on an empty set',
    ).toMatch(/text-autospace:\s*var\(--text-autospace\)\s*;/);

    for (const m of GEOMETRY) {
      expect(
        m.typeset.textAutospace,
        `${m.label}: the engine resolved body's \`text-autospace\` to ` +
          `"${m.typeset.textAutospace || '(empty)'}", not the value styles.css declares. ` +
          'Either the token lost its declaration, or this engine dropped it.',
      ).toContain('normal');
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
