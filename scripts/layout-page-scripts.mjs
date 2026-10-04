/**
 * The scripts this repo runs inside a real page, in one module with no Electron
 * dependency.
 *
 * ## Why they live here
 *
 * They used to live inside `layout-probe.mjs`, where they could not be tested,
 * and being untestable had a cost three times over: a backtick inside a comment
 * inside one of these template literals **silently ends the string**, and the
 * rest of the measurement is then parsed as the host module's own code. The
 * symptom each time was a `TypeError` or `SyntaxError` naming an identifier
 * that has nothing to do with the mistake (`".surfaces" is not a function`,
 * `"Unexpected identifier 'text'"`) and a stack pointing nowhere near it.
 *
 * A parse check in the probe caught it, but only at runtime and only for the
 * script that happened to be evaluated first. Here they are importable, so
 * `tests/contract/layout-scripts.test.ts` can check **every** script, and can
 * check the specific thing that keeps going wrong: a backtick inside a script
 * body. Comments in this file therefore say 'quoted' rather than `quoted`.
 */

/** The measurement itself, evaluated in the page. */
export const MEASURE = `(() => {
  const round = (n) => Math.round(n * 10) / 10;
  const describe = (el) => {
    const id = el.id ? '#' + el.id : '';
    const cls = typeof el.className === 'string' && el.className
      ? '.' + el.className.trim().split(/\\s+/).slice(0, 3).join('.')
      : '';
    return el.tagName.toLowerCase() + id + cls;
  };
  const text = (el) => (el.innerText || el.textContent || '').trim();
  const visible = (el) =>
    typeof el.checkVisibility === 'function' ? el.checkVisibility() : true;

  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const doc = document.documentElement;

  /** True when some ancestor is allowed to scroll this axis out of view. */
  const inScrollableAncestor = (el, axis) => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const style = getComputedStyle(p);
      const value = axis === 'x' ? style.overflowX : style.overflowY;
      if (value === 'auto' || value === 'scroll') return true;
    }
    return false;
  };

  const all = Array.from(document.querySelectorAll('body *'));

  /*
   * 1. The document must not scroll sideways. This is the coarse, high-signal
   *    assertion: a shell that needs a horizontal scrollbar at its own default
   *    window size is broken at the most visible level there is.
   */
  const horizontalOverflow = Math.max(doc.scrollWidth, doc.clientWidth) - viewportWidth;

  /*
   * 2. Nothing may sit outside the viewport horizontally unless an ancestor
   *    scrolls. Clipped-by-an-overflow:hidden ancestor content is the quieter
   *    version of the same bug: the document does not scroll, and the user
   *    simply cannot see the control that got pushed out.
   */
  const escaping = [];
  for (const el of all) {
    if (!visible(el)) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    const outRight = rect.right - viewportWidth;
    const outLeft = -rect.left;
    if (outRight <= 1 && outLeft <= 1) continue;
    if (inScrollableAncestor(el, 'x')) continue;
    // Only report the outermost offender in a chain, otherwise one stray
    // element produces a hundred lines of the same defect.
    if (escaping.some((row) => row.element === describe(el.parentElement))) continue;
    escaping.push({
      element: describe(el),
      overflowRight: round(outRight),
      overflowLeft: round(outLeft),
      text: text(el).slice(0, 60),
    });
  }

  /*
   * 3. No visible region may collapse. A container that is still laid out but
   *    has zero height or a sliver of width is how the main column "disappears"
   *    while every test asserting "it rendered" stays green. The structural
   *    classes are the shell's own regions: a new one is a one-word change here.
   */
  const REGIONS = [
    '.app', '.topbar', '.body', '.rail', '.main', '.preview', '.statusbar',
    '.surfaces', '.convo', '.pane', '.pane-stack', '.composer-bar', '.toast',
  ];
  const collapsed = [];
  for (const selector of REGIONS) {
    for (const el of Array.from(document.querySelectorAll(selector))) {
      if (!visible(el)) continue;
      const rect = el.getBoundingClientRect();
      if (text(el).length === 0) continue;
      if (rect.width >= 40 && rect.height >= 20) continue;
      collapsed.push({
        element: describe(el),
        width: round(rect.width),
        height: round(rect.height),
        text: text(el).slice(0, 60),
      });
    }
  }

  /*
   * 4. Flow text must not be cut off by its own box.
   *
   * The measurable half of the "label wraps into soup" class of defect: if a
   * box is narrower than its content and refuses to wrap or scroll, the
   * characters the user needs are not on screen.
   *
   * Two exemptions, both about the same thing - this asks whether the *flow
   * layout* put text somewhere it cannot be read:
   *   - a box with 'text-overflow: ellipsis' is truncating on purpose, and
   *   - a box that is not statically positioned was placed there deliberately.
   *     The second one is what keeps '.sr-only' out of the report: it is a 1px
   *     absolutely-positioned box whose entire job is to hold text for a
   *     screen reader, and flagging it as "clipped" is the gate complaining
   *     about the accessibility feature working.
   */
  const clipped = [];
  for (const el of all) {
    if (!visible(el)) continue;
    if (el.children.length > 0) continue;
    const style = getComputedStyle(el);
    if (style.position !== 'static') continue;
    if (style.overflowX !== 'hidden' && style.overflowX !== 'clip') continue;
    if (style.textOverflow === 'ellipsis') continue;
    if (el.scrollWidth <= el.clientWidth + 1) continue;
    if (el.clientWidth === 0) continue;
    clipped.push({
      element: describe(el),
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      text: text(el).slice(0, 60),
    });
  }

  /*
   * 5. The shell's chrome controls must be on screen without scrolling.
   *
   * This is the invariant the first four could not express, and it was found by
   * putting a shipped defect back and watching the gate stay green. With all
   * fifteen surfaces as peer tabs, the '.surfaces' row scrolls horizontally
   * (871px of tabs in a 642px row) and four controls - 设置, 诊断, 帮助 and the
   * 更多 menu itself - end up outside the row's visible box, with no scrollbar
   * and no affordance. The document never overflowed, the column never
   * collapsed, and every control still "rendered".
   *
   * Scoped to the two chrome containers on purpose. A control below the fold in
   * a session list or a chat log is reachable by scrolling on purpose, and
   * flagging those would make this gate cry wolf on correct design. A
   * navigation tab or the send button is different: if it is not on screen, the
   * feature behind it does not exist for the user.
   */
  const CHROME = ['.surfaces', '.composer-bar'];
  const offscreenControls = [];
  for (const selector of CHROME) {
    const container = document.querySelector(selector);
    if (container === null || !visible(container)) continue;
    const rect = container.getBoundingClientRect();
    const style = getComputedStyle(container);
    // The content box, not the border box: a scrollbar eats into it and a
    // control flush against the border is still visible.
    const contentLeft = rect.left + (parseFloat(style.borderLeftWidth) || 0);
    const contentRight = contentLeft + container.clientWidth;
    for (const el of container.querySelectorAll('button, select, input, textarea, a[href]')) {
      if (!visible(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      const outRight = r.right - contentRight;
      const outLeft = contentLeft - r.left;
      if (outRight <= 1 && outLeft <= 1) continue;
      offscreenControls.push({
        container: selector,
        element: describe(el),
        outRight: round(outRight),
        outLeft: round(outLeft),
        text: text(el).slice(0, 40),
      });
    }
  }

  /*
   * 6. Static-flow text must not lie on top of other static-flow text.
   *
   * The one class of defect that has shipped here (round 4: a dialog whose
   * description sat on top of its risk row) and that no gate had ever caught,
   * because "it rendered" and "it is legible" are different claims.
   *
   * Scoped as narrowly as the claim allows, because overlap is usually
   * intentional, and because a rule that cries wolf gets switched off:
   *   - both boxes must be **statically positioned**. A positioned box is
   *     layered on purpose (a dropdown over a list, a badge on a dot), so
   *     anything whose computed position is not 'static' is exempt. What is
   *     left is the flow layout putting two things in the same place, which is
   *     always a bug.
   *   - both must carry **their own text** (a leaf with text), so a container
   *     that legitimately contains a positioned child is not counted.
   *   - neither may be an ancestor of the other: containment is a layout, not
   *     an overlap.
   *   - **neither may be scrolled out of view.** This one was learned the hard
   *     way. The first run reported the context and help panels as overlapping
   *     the status bar, and the screenshots showed panels that looked fine -
   *     the heading was simply below the fold of a scrolling pane, so its box
   *     extended past the pane's bottom edge and across the status bar's rect
   *     while being clipped by it. A box the user cannot see is not covering
   *     anything.
   */
  const scrolledOutOf = (el, rect) => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const style = getComputedStyle(p);
      const scrolls = style.overflowY === 'auto' || style.overflowY === 'scroll';
      if (!scrolls) continue;
      const box = p.getBoundingClientRect();
      const top = box.top + (parseFloat(style.borderTopWidth) || 0);
      const bottom = top + p.clientHeight;
      if (rect.top < top - 2 || rect.bottom > bottom + 2) return true;
    }
    return false;
  };

  const textBoxes = [];
  for (const el of all) {
    if (!visible(el)) continue;
    if (el.children.length > 0) continue;
    if (text(el).length === 0) continue;
    const style = getComputedStyle(el);
    if (style.position !== 'static') continue;
    if (style.pointerEvents === 'none') continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) continue;
    if (scrolledOutOf(el, rect)) continue;
    textBoxes.push({ el, rect, label: describe(el) + ' ' + JSON.stringify(text(el).slice(0, 24)) });
  }

  const overlaps = [];
  for (let i = 0; i < textBoxes.length; i += 1) {
    for (let j = i + 1; j < textBoxes.length; j += 1) {
      const a = textBoxes[i];
      const b = textBoxes[j];
      // Containment is a layout; only shared area between siblings is a clash.
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
      const w = Math.min(a.rect.right, b.rect.right) - Math.max(a.rect.left, b.rect.left);
      const h = Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.top, b.rect.top);
      if (w <= 2 || h <= 2) continue;
      overlaps.push({ a: a.label, b: b.label, sharedWidth: round(w), sharedHeight: round(h) });
    }
  }

  return JSON.stringify({
    viewport: { width: viewportWidth, height: viewportHeight },
    document: {
      scrollWidth: doc.scrollWidth,
      scrollHeight: doc.scrollHeight,
      clientWidth: doc.clientWidth,
    },
    /*
     * What was on screen, so a reader can tell a populated app from a
     * first-run shell without opening the screenshot. The gate asserts on these
     * directly: a layout measurement of the wrong state is not a pass.
     */
    content: {
      treeRows: document.querySelectorAll('.rail .tree-row').length,
      projectChip: text(document.querySelector('.project-chip')).slice(0, 60),
      previewVisible: (() => {
        const el = document.querySelector('.preview');
        return el !== null && visible(el);
      })(),
      bodyChars: text(document.body).length,
    },
    horizontalOverflow: round(horizontalOverflow),
    escaping: escaping.slice(0, 12),
    collapsed: collapsed.slice(0, 12),
    clipped: clipped.slice(0, 12),
    offscreenControls: offscreenControls.slice(0, 12),
    overlaps: overlaps.slice(0, 12),
    textBoxes: textBoxes.length,
  });
})()`;

/**
 * The readiness script, evaluated in the page.
 *
 * Separate from MEASURE so both can be parse-checked at startup.
 */
export const SETTLE = `(async () => {
  const seam = window.__ucadFixture;
  if (!seam || typeof seam.idle !== 'function') {
    return JSON.stringify({ seam: false });
  }
  await seam.idle();
  // Two frames: one for the state to be committed, one for the layout that
  // commit produced to be flushed.
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  return JSON.stringify({
    seam: true,
    scenario: seam.scenario,
    treeRows: document.querySelectorAll('.rail .tree-row').length,
    hasStatusbar: Boolean((document.querySelector('.statusbar')?.innerText || '').trim()),
  });
})()`;

/**
 * Open a surface and wait for it to be done fetching.
 *
 * Every surface is addressed by 'data-surface', the same attribute a person
 * reading the DOM would use, rather than by index: an index into "the fifth
 * tab" silently measures a different panel the day someone reorders the row,
 * which is the kind of gate that is green about the wrong thing.
 *
 * The surface is interpolated rather than passed as an argument. Electron's
 * executeJavaScript will happily call a function expression you hand it, but
 * the promise that comes back from one is not the same shape as the promise an
 * IIFE returns, and the difference surfaces as 'An object could not be cloned'
 * on every single surface. Interpolation sidesteps that entirely, and it is
 * safe here because the surface names come from this repo's own App.tsx, not
 * from anything a user can type.
 */
export function visitScript(surface) {
  return `(async () => {
  const surface = ${JSON.stringify(surface)};
  const seam = window.__ucadFixture;
  const frame = () => new Promise((r) => requestAnimationFrame(r));
  const find = (sel) => document.querySelector(sel);
  const direct = find('[data-surface="' + surface + '"]');
  if (!direct) {
    // Behind "more": open the menu, then take the item from inside it.
    const more = find('.more-toggle');
    if (!more) return JSON.stringify({ ok: false, reason: 'no more-toggle for ' + surface });
    more.click();
    await frame();
    await frame();
  }
  const target = find('[data-surface="' + surface + '"]');
  if (!target) return JSON.stringify({ ok: false, reason: 'no control for ' + surface });
  target.click();
  if (seam && typeof seam.idle === 'function') await seam.idle();
  await frame();
  await frame();
  const heading = (find('.pane-head h1')?.innerText || find('.pane h1')?.innerText || '').trim();
  return JSON.stringify({
    ok: true,
    surface: surface,
    heading: heading.slice(0, 40),
    mainChildren: find('.main') ? find('.main').childElementCount : 0,
  });
})()`;
}

/**
 * Catch the app *while it is still fetching*, and report what is on screen.
 *
 * This exists because it has been an untickable manual item for
 * five rounds: "loading state — does a slow interface give feedback instead of
 * flashing blank". The stated reason it could not be checked was that the slow
 * scenario slows the shell itself, so you cannot get into a panel while it is
 * loading. That is true of a *click-through* check and false of a *measurement*:
 * what the item asks about is the frame where the reads are in flight, and the
 * harness knows exactly when that is.
 *
 * `markers` is the loading copy in every locale, passed in by the caller, so
 * the check does not depend on which language the app negotiated.
 */
export function inFlightScript(markers) {
  return `(async () => {
  const markers = ${JSON.stringify(markers)};
  const text = (el) => (el.innerText || el.textContent || '').trim();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const deadline = Date.now() + 20000;

  // The seam is installed by a dynamic import, so for the first moments of the
  // page there is nothing to ask. Wait for it to arrive *before* deciding
  // whether it is usable - bailing on the first poll instead reports "no
  // pending()" for a perfectly good build that simply had not mounted yet.
  let seam = null;
  while (Date.now() < deadline) {
    seam = window.__ucadFixture ?? null;
    if (seam) break;
    await sleep(20);
  }
  if (!seam) {
    return JSON.stringify({
      shell: false, pending: -1, bodyChars: 0, sawLoadingCopy: false,
      markers: markers.length, reason: 'the harness seam never appeared',
    });
  }
  if (typeof seam.pending !== 'function') {
    return JSON.stringify({
      shell: false, pending: -1, bodyChars: 0, sawLoadingCopy: false,
      markers: markers.length,
      reason: 'the harness seam has no pending(); the renderer is a stale build',
    });
  }

  let shell = false;
  let pending = seam.pending();
  while (Date.now() < deadline) {
    pending = seam.pending();
    shell = document.querySelector('.surfaces') !== null && document.querySelector('.topbar') !== null;
    if (shell && pending > 0) break;
    await sleep(20);
  }
  const body = text(document.body);
  return JSON.stringify({
    shell: shell,
    pending: pending,
    bodyChars: body.length,
    sawLoadingCopy: markers.some((m) => m.length > 0 && body.indexOf(m) !== -1),
    markers: markers.length,
  });
})()`;
}

/**
 * Run axe-core over the live document.
 *
 * axe-core itself is injected separately (its own minified bundle, read from
 * node_modules by the probe), because it is a library, not a script of ours.
 * What this script owns is the *contract*: full rule set, violations only,
 * results reduced to the same four fields the happy-dom E2E scan reports, so
 * a finding in the real browser reads exactly like a finding in the DOM scan.
 *
 * Requires a settled page: a scan of a still-fetching surface reports on the
 * loading frame, which is green about the wrong screen.
 */
export const AXE_RUN = `(async () => {
  if (!window.axe || typeof window.axe.run !== 'function') {
    return JSON.stringify({ error: 'axe is not injected into this page' });
  }
  const results = await window.axe.run(document.body, { resultTypes: ['violations'] });
  const violations = (results.violations || []).map((v) => ({
    id: v.id,
    impact: v.impact ?? null,
    help: v.help,
    nodes: (v.nodes || []).slice(0, 6).map((n) => ({
      html: String(n.html || '').slice(0, 160),
      target: (n.target || []).map(String),
    })),
  }));
  return JSON.stringify({ violations });
})()`;

/** Every page script, by name. Used by the probe's startup check and the test. */
export const PAGE_SCRIPTS = {
  MEASURE,
  SETTLE,
  visitScript: visitScript('chat'),
  inFlight: inFlightScript(['loading']),
  AXE_RUN,
};

/**
 * Parse every page script, throwing with the name of the one that is broken.
 *
 * Called at the top of the probe so a malformed script fails immediately and
 * locally, instead of surfacing later as an error inside Chromium that names
 * an identifier unrelated to the actual mistake.
 */
export function assertPageScriptsParse() {
  for (const [name, source] of Object.entries(PAGE_SCRIPTS)) {
    try {
      new Function(`return (${source});`);
    } catch (error) {
      throw new Error(
        `the ${name} page script does not parse: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
