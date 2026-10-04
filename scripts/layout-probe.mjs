/**
 * The layout probe: the first gate in this repo that runs against a real
 * layout engine.
 *
 * Why this file exists
 * -------------------
 * Every other UI gate in this repository runs in happy-dom, which has no
 * typography and no layout: `getBoundingClientRect()` returns 0 for everything
 * and media queries are the only responsive behaviour that can be observed.
 * So "the main column collapsed to 0px", "14 tabs overflowed at 1280px" and
 * "the project chip was pushed off-screen" were all real, shipped defects that
 * every automated gate reported as clean. This records the shape of
 * the problem; this file is the first instrument that can see it.
 *
 * Electron *is* Chromium — it is already a devDependency and it is what ships
 * the product — so a real layout engine costs zero new dependencies. The
 * BrowserWindow width is the viewport, and unlike the browser harness used in
 * previous rounds, it is exact and reproducible.
 *
 * What it must not become
 * ----------------------
 * A screenshot comparison. Image diffing is brittle, slow to explain and tends
 * to be switched off after the first innocent change. The probe reports
 * *geometry* — measured numbers with the offending element named — so a failure
 * points at the CSS rule that caused it. Screenshots are still written, but as
 * evidence for a human, not as the assertion.
 *
 * Contract with the caller
 * ------------------------
 * Input (env):
 *   UCAD_LAYOUT_TARGETS  JSON array of { name, width, height, url }
 *   UCAD_LAYOUT_OUT      where to write the JSON result (required)
 *   UCAD_LAYOUT_SHOTS    directory for screenshots; skipped when unset
 *
 * Output: one JSON file, always written, with an `ok` flag. The process exit
 * code mirrors `ok`. The result is written to a file rather than stdout because
 * `app.exit()` discards buffered stdout when stdout is a pipe, which makes a
 * passing run look like a silent one — the exact "did not run" and "found
 * nothing" confusion the gates warn about.
 */

import { app, BrowserWindow } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MEASURE,
  SETTLE,
  visitScript,
  inFlightScript,
  assertPageScriptsParse,
  AXE_RUN,
} from './layout-page-scripts.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = process.env.UCAD_LAYOUT_OUT ?? path.join(here, 'layout-result.json');
const SHOTS = process.env.UCAD_LAYOUT_SHOTS ?? '';
const TARGETS = JSON.parse(process.env.UCAD_LAYOUT_TARGETS ?? '[]');

/**
 * axe-core's browser bundle, injected once per page load.
 *
 * happy-dom has no layout engine, so the E2E accessibility scan can never see
 * what a narrow window actually renders — and real Chromium, which this probe
 * already drives for geometry, can. Running axe here means every surface is
 * scanned twice per layout: once in the DOM (cheap, broad) and once inside a
 * real layout engine at a width where media queries have re-shaped the app.
 */
const AXE_SOURCE = fs.readFileSync(
  path.join(here, '..', 'node_modules', 'axe-core', 'axe.min.js'),
  'utf8',
);

/**
 * Progress evidence, appended as the probe runs.
 *
 * Electron can die without a message, a stack, or an exit code anyone can read
 * — a crashed browser process is how this gate first failed, and "it exited
 * with a number" is not a diagnosis. Leaving a breadcrumb per step means a
 * crash reports the step it died on instead of only that it died.
 */
const PROGRESS = OUT + '.progress';
fs.rmSync(PROGRESS, { force: true });
function step(message) {
  fs.appendFileSync(PROGRESS, `${new Date().toISOString()} ${message}\n`, 'utf8');
}

// A malformed page script fails here, by name, instead of inside Chromium.
assertPageScriptsParse();

/**
 * A wedged Chromium must not become a wedged `npm test`. Sized for five targets
 * on a cold start plus two full surface sweeps (thirty visits, each with a
 * real-axe pass); each visit is a click, a settle, a measure and a scan.
 */
const WATCHDOG_MS = 300_000;

/**
 * `useContentSize: true` is the whole reason the widths in this gate are the
 * widths the assertions talk about. Without it the requested width is the
 * *window* including the frame, and a 1100px request really lays out at
 * 1084px — which is how "we tested 1100" becomes a statement that is not true.
 */
const WINDOW_OPTIONS = {
  useContentSize: true,
  show: false,
  backgroundColor: '#0a0a0b',
  webPreferences: {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    // No preload: this window loads the browser harness, which installs the
    // in-memory fixture bridge. The point is to measure the same DOM the
    // browser harness serves, with a layout engine attached.
  },
};

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait for the app to have data, not merely to exist.
 *
 * The first version of this waited for `.statusbar` to have text and measured
 * a first-run screen: every read was still in flight, so the "clean" 1440px
 * result was a result about the wrong screen. The harness now reports when it
 * has gone quiet, which is the only signal that means "this is the state the
 * user would see".
 *
 * The DOM check afterwards is a floor, not the mechanism: if the harness seam
 * is ever missing, the probe says so instead of quietly measuring a shell.
 */
async function waitForData(win, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last = 'no answer';
  while (Date.now() < deadline) {
    try {
      const answer = await win.webContents.executeJavaScript(SETTLE);
      const parsed = JSON.parse(answer);
      last = JSON.stringify(parsed);
      if (parsed.seam && parsed.hasStatusbar) {
        step(`data settled: ${last}`);
        return parsed;
      }
    } catch (error) {
      last = String(error);
    }
    await delay(150);
  }
  throw new Error(`the app never settled: ${last}`);
}

/**
 * One window, resized per target.
 *
 * The first version created a window per width. The second window's load came
 * back `ERR_FAILED (-2)` and, before that, took the whole browser process with
 * it — an exit code with no message, which is the least diagnosable failure a
 * gate can have.
 *
 * Resizing one live window is also the more faithful measurement: it is what a
 * user does when they drag the window narrower, so media queries re-evaluate
 * and the flex/grid distribution is recomputed against a real app that was
 * already running — not a fresh mount that happens to be small.
 */
/*
 * Why there is no hover/focus-state contrast scan here, measured and then
 * deliberately not done (round 37):
 *
 * Forcing `:hover`/`:focus` through the DevTools protocol
 * (`CSS.forcePseudoState`) does not reliably restyle the element in this
 * Electron/Chromium build. On identical sibling buttons (`.surface-tab`) the
 * forced state shows up in `matches(':hover')` and in
 * `CSS.getMatchedStylesForNode` — the rule *is* matched — while
 * `getComputedStyle` and `CSS.getComputedStyleForNode` keep reporting the
 * resting colour. An inline custom property and a class toggle were both
 * tried as style-cache busts; neither changed the read. On other elements
 * (`.row-item`, two non-identical rows) the same forcing flips a descendant's
 * `opacity` and the row's own colour correctly — so the instrument works on
 * some elements and silently lies on others, and a red-proof with a real
 * low-contrast `:hover` colour came back green. A gate that cannot prove it
 * goes red is not a gate.
 *
 * Real input events (`sendInputEvent` mouseMove) do not drive `:hover` in a
 * hidden window at all (`matches(':hover')` stays false), and showing the
 * window plus per-element input choreography would trade determinism for
 * coverage of one state class. `:focus-visible` does not match programmatic
 * `focus()` either. The state therefore stays a human check — see
 * It is the third known blind spot of the automated gates.
 */

async function runTargets(targets) {
  const first = targets[0];
  const win = new BrowserWindow({
    ...WINDOW_OPTIONS,
    width: first.width,
    height: first.height ?? 900,
  });

  const consoleErrors = [];
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 3) consoleErrors.push(message);
  });

  const results = [];
  /*
   * axe is injected once per page load and survives surface navigation
   * (visitScript clicks, it does not reload). Any loadURL wipes it, so the
   * flag is reset wherever the page is reloaded below.
   */
  let axeInjected = false;
  const ensureAxe = async () => {
    if (axeInjected) return;
    await win.webContents.executeJavaScript(AXE_SOURCE);
    axeInjected = true;
    step('axe-core injected');
  };
  try {
    step(`loading ${first.url}`);
    await win.loadURL(first.url);
    axeInjected = false;
    await waitForData(win);

    for (const target of targets) {
      /*
       * An in-flight target wants the frame where the app is still fetching,
       * which means its own page load and **not** the settled wait. It is
       * handled before anything else in the target, and the shell is reloaded
       * afterwards so the order of targets does not matter.
       */
      if (target.inFlight === true) {
        try {
          step(`${target.name}: loading ${target.url} to catch the in-flight frame`);
          await win.loadURL(target.url);
          const flight = JSON.parse(
            await win.webContents.executeJavaScript(
              inFlightScript(target.markers ?? []),
            ),
          );
          if (SHOTS) {
            fs.mkdirSync(SHOTS, { recursive: true });
            const image = await win.webContents.capturePage();
            fs.writeFileSync(path.join(SHOTS, `${target.name}.png`), image.toPNG());
          }
          results.push({
            ...target,
            label: target.name,
            surface: 'loading',
            // This frame is measured for *content*, not geometry: it exists to
            // answer "is anything on screen while fetching". Marking it keeps
            // the geometry assertions from passing vacuously over it.
            geometry: false,
            mounted: flight.shell === true && flight.pending > 0,
            flight,
            consoleErrors: [...consoleErrors],
          });
        } catch (error) {
          results.push({
            ...target,
            label: target.name,
            surface: 'loading',
            geometry: false,
            mounted: false,
            error: `${target.name}: ${error instanceof Error ? error.message : String(error)}`,
            consoleErrors: [],
          });
        }
        step(`${target.name}: restoring the settled shell`);
        await win.loadURL(first.url);
        axeInjected = false;
        await waitForData(win);
        continue;
      }

      try {
        if (target !== first) {
          step(`${target.name}: resizing to ${target.width}x${target.height}`);
          win.setContentSize(target.width, target.height ?? 900);
          // Let the resize propagate through layout before reading geometry.
          await win.webContents.executeJavaScript(
            `new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))`,
          );
          await delay(120);
        }

        /*
         * A surface list, or just the one the app opens on. The panels are
         * where the two overlap defects of rounds 4 and 9 lived, and the chat
         * surface alone would have reported clean for both — so the walk is the
         * point, not an extra.
         */
        for (const surface of target.surfaces ?? ['chat']) {
          const label = `${target.name}#${surface}`;
          try {
            if (surface !== 'chat' || target.surfaces) {
              const visit = JSON.parse(
                await win.webContents.executeJavaScript(visitScript(surface)),
              );
              if (visit.ok !== true) throw new Error(visit.reason ?? 'could not open the surface');
            }
            step(`${label}: measuring`);
            const raw = await win.webContents.executeJavaScript(MEASURE);
            const measured = JSON.parse(raw);
            step(`${label}: measured at ${measured.viewport.width}px`);

            /*
             * axe runs only on surfaces-bearing targets — those are the full
             * panel sweeps, the runs where a per-surface a11y verdict means
             * something. The width-only targets exist for geometry and would
             * pay the axe cost for a surface that is not the point.
             */
            let violations = [];
            let axeError;
            if (target.surfaces) {
              try {
                await ensureAxe();
                const axeRaw = await win.webContents.executeJavaScript(AXE_RUN);
                const axeResult = JSON.parse(axeRaw);
                if (axeResult.error) {
                  axeError = axeResult.error;
                } else {
                  violations = axeResult.violations ?? [];
                }
                step(`${label}: axe reported ${violations.length} violation(s)`);
              } catch (error) {
                axeError = error instanceof Error ? error.message : String(error);
              }
            }

            if (SHOTS) {
              fs.mkdirSync(SHOTS, { recursive: true });
              const image = await win.webContents.capturePage();
              fs.writeFileSync(path.join(SHOTS, `${label.replace('#', '-')}.png`), image.toPNG());
            }

            results.push({
              ...target,
              surface,
              label,
              ...measured,
              ...(target.surfaces ? { violations, ...(axeError ? { axeError } : {}) } : {}),
              consoleErrors: [...consoleErrors],
              mounted: true,
            });
          } catch (error) {
            results.push({
              ...target,
              surface,
              label,
              mounted: false,
              error: `${label}: ${error instanceof Error ? error.message : String(error)}`,
              viewport: { width: 0, height: 0 },
              document: { scrollWidth: 0, scrollHeight: 0, clientWidth: 0 },
              content: { treeRows: 0, projectChip: '', previewVisible: false, bodyChars: 0 },
              horizontalOverflow: null,
              escaping: [],
              collapsed: [],
              clipped: [],
              offscreenControls: [],
              overlaps: [],
              violations: [],
              textBoxes: 0,
              consoleErrors: [],
            });
          }
        }
      } catch (error) {
        results.push({
          ...target,
          mounted: false,
          error: error instanceof Error ? error.message : String(error),
          viewport: { width: 0, height: 0 },
          document: { scrollWidth: 0, scrollHeight: 0, clientWidth: 0 },
          content: { treeRows: 0, projectChip: '', previewVisible: false, bodyChars: 0 },
          horizontalOverflow: null,
          escaping: [],
          collapsed: [],
          clipped: [],
          offscreenControls: [],
          overlaps: [],
          violations: [],
          textBoxes: 0,
          consoleErrors: [],
        });
      }
    }
  } finally {
    // A window that never loaded takes the whole run with it: every target
    // would otherwise report "no layout problems found", so the failure is left
    // to propagate to the caller rather than being folded into a result.
    if (!win.isDestroyed()) win.destroy();
  }
  return results;
}

const results = [];
let failure = null;

app.whenReady().then(async () => {
  step(`app ready; ${TARGETS.length} target(s)`);
  try {
    results.push(...(await runTargets(TARGETS)));
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    step(`run failed: ${failure}`);
  }

  fs.writeFileSync(
    OUT,
    JSON.stringify({ ok: failure === null, failure, results }, null, 2),
    'utf8',
  );
  app.exit(failure === null ? 0 : 1);
});

// A wedged Chromium must not become a wedged `npm test`.
const bail = setTimeout(() => {
  fs.writeFileSync(
    OUT,
    JSON.stringify(
      { ok: false, failure: `timed out after ${WATCHDOG_MS}ms`, results },
      null,
      2,
    ),
    'utf8',
  );
  app.exit(2);
}, WATCHDOG_MS);
bail.unref?.();
