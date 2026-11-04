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

/**
 * The smallest size a Chinese character may be set at, in px.
 *
 * Not a taste number. Han characters are dense: the strokes of 需 and 量 fill
 * most of the em box, so at 10-11px they collapse into a grey block, while a
 * Latin word of the same size still resolves because its letters are mostly
 * white space. This app shipped section labels, table headers, badges and
 * status-bar segments at 10-11px — every one of them Chinese — and no gate
 * measured type size at all, so "readable" was an opinion the CSS never had to
 * defend.
 *
 * 12px is where the dense small-caps labels stop dissolving on a 1x display.
 * It is the floor, not the body size: prose is 13 (--fs-body), and only
 * identifiers and glyphs — paths, hashes, counts, arrows, all ASCII — are
 * allowed under it (--fs-mono).
 *
 * The number lives here rather than inside the page script so the stylesheet's
 * contract test can import it: two copies of "12" is how a floor becomes a
 * suggestion.
 */
export const CJK_FLOOR_PX = 12;

/**
 * The longest a line of Chinese prose may be, in CJK-equivalent characters.
 *
 * Not a taste number either. A Han character is roughly one em wide, so a line
 * length in em *is* a line length in characters, and the reading research on
 * Chinese agrees with the Latin one on the shape of the answer: past about 40
 * characters the eye loses the start of the next line on the return sweep, and
 * the reader re-reads. This app's prose column was 780px wide at 13px body —
 * 60 characters — which is why a paragraph of Chinese read as a wall.
 *
 * The floor of the range is a different kind of rule, and it is gated
 * differently: a narrow panel legitimately sets shorter lines, so "this line is
 * 23 characters" is not by itself a defect. What *is* a defect is a prose block
 * that is narrower than the floor **while its container had room for more** — a
 * paragraph capped at 20em inside a 900px card, which reads as a column of
 * stumps. So the floor is enforced only where the available room reaches it;
 * see `MIN_PROSE_LINE_CJK` and the measurement below.
 */
export const MAX_PROSE_LINE_CJK = 40;

/**
 * The shortest a line of Chinese prose may be, in CJK-equivalent characters,
 * *when the column had the room*.
 *
 * 28 is the bottom of the band the reading research gives for Chinese (28-40),
 * and it is the number the review checklist asks for. It is not a rule about
 * narrow panels: at 768px the chat pane is legitimately narrower than 28
 * characters, and a paragraph there is not a defect. The measurement therefore
 * compares the longest line against this floor only when the block's container
 * is at least this wide — the case where the block itself chose to be narrow.
 *
 * Without that condition the rule would be a rule about window size, which is
 * the shape of gate this repository has had to remove before (a geometry check
 * whose verdict depended on the viewport). With it, the rule is about the
 * stylesheet: a `max-width` on prose that is smaller than the measure.
 */
export const MIN_PROSE_LINE_CJK = 28;

/**
 * Characters that may not begin a line (行首禁则).
 *
 * Closing punctuation, closing brackets and the marks that attach to the
 * character before them. A line that starts with '。' leaves the reader with a
 * full stop floating at the left margin, which reads as a typo.
 */
export const LINE_START_FORBIDDEN = '。，、；：？！）〕］｝〉》」』】”’·…‥%‰℃';

/**
 * Characters that may not end a line (行尾禁则).
 *
 * Opening brackets and quotes: the character they open must be on the same
 * line, otherwise the bracket dangles at the right margin with nothing after
 * it.
 */
export const LINE_END_FORBIDDEN = '（〔［｛〈《「『【“‘';

/**
 * How much text a box needs before it counts as prose.
 *
 * A two-character tab label, a status segment or a badge is not a paragraph: it
 * has no line length to judge and no break to check, and walking its characters
 * one by one is the expensive half of the measurement. Twenty characters is
 * roughly where a Chinese sentence starts being able to wrap at all at the
 * widths this app uses, so it is the point below which the question does not
 * arise. It lives here, exported, so the contract test can pin it rather than
 * let it drift into the measurement as a bare number.
 */
export const PROSE_MIN_CHARS = 20;

/**
 * The fewest characters a wrapped Chinese paragraph may leave on its last line.
 *
 * The defect is the one Chinese typesetting calls 孤字行: the paragraph is set,
 * and the final line carries a single character plus its full stop — '容。' at
 * the left margin, alone under eleven full lines. It is not a geometry problem
 * (nothing overflows, nothing is clipped, the block is inside its box), it is
 * not a line-length problem (the lines above it are the right length), and no
 * gate in this repository could see it.
 *
 * Two is the boundary, and it is stated in *characters that carry text*, not in
 * characters: the punctuation a line ends with belongs to the character before
 * it, so '容。' is one character of text and '内容。' is two. A last line holding
 * one character and its full stop is the runt; a last line holding two is a
 * short line, which is what a paragraph's last line is allowed to be.
 *
 * It was measured before it was written down: `?scenario=empty` ended
 * '.preview-body .faint' on '容。' and `?scenario=permission` ended the
 * dialog's note on '批。', at 1440x900 and at 768x700. `text-wrap: pretty` (the
 * declaration this number exists to judge — see styles.css) moves both to three
 * characters of text and leaves every other block on every other state alone.
 *
 * `text-wrap: balance` would also remove them, and it is *not* the fix: it
 * balances both lines of a two-line paragraph to half the measure, which at
 * 468px and 13px is 12 characters a line — under the prose floor, so it trades
 * a runt for a paragraph that reads as a column of stumps. That trade was
 * measured too (`.run-logs/` notes for the round); 'pretty' only moves the last
 * line.
 */
export const MIN_LAST_LINE_GLYPHS = 2;

/**
 * Characters that do not count as text on a paragraph's last line.
 *
 * Closing punctuation and the marks that attach to the character before them,
 * i.e. the same set 行首禁则 lists, plus the full stop forms. A last line of
 * '内容。' has two glyphs; a last line of '容。' has one.
 *
 * Not exported: it is the same set as {@link LINE_START_FORBIDDEN}, and two
 * exported names for one value is what `npm run knip` reports as a duplicate
 * export. The name stays because the page script reads better with it — the
 * rule it feeds is about the last line, not about line starts.
 */
const LAST_LINE_IGNORED = LINE_START_FORBIDDEN;

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
  /*
   * Both helpers take a possibly-missing element on purpose.
   *
   * The first version assumed the shell was on screen: the measurement asked
   * '.project-chip' for its text, and the one state that does *not* paint the
   * shell — the error pane a first load that failed outright shows — made the
   * whole script throw a TypeError. The gate then reported "state-error:
   * Script failed to execute", which names the harness rather than the screen,
   * and its console error was attributed to whichever frame happened to be
   * measured next. A measurement of 'this element is not here' is a fact; only
   * a measurement of 'nothing at all' is a failure.
   */
  const text = (el) => (el ? (el.innerText || el.textContent || '').trim() : '');
  const visible = (el) =>
    el !== null && el !== undefined &&
    (typeof el.checkVisibility === 'function' ? el.checkVisibility() : true);

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
   *   - **both must be in the same layer.** A modal is a layer: the permission
   *     prompt is drawn over the transcript on purpose, and every text node
   *     inside '.dialog' is statically positioned even though the '.overlay'
   *     around it is not, so the first exemption stopped one level short of the
   *     thing it was exempting. This was invisible while the five states were
   *     only ever measured at 1440x900, where the dialog happens to land on
   *     empty transcript; measured at the tightest window the probe reported
   *     'Agent 请求权限' as lying on top of a chat message, on a screen that is
   *     correct. The layer is the modal the app declares ('role="dialog"' +
   *     'aria-modal="true"', the same selector that answers dialogOpen), so a
   *     text node inside it is compared with the dialog's own contents and not
   *     with the page behind the overlay. Overlaps *inside* one dialog are
   *     still failures - that is the round-4 defect's shape (a description on
   *     top of its own risk row), and the page-vs-page rule is untouched.
   */
  const modalOf = (el) => el.closest('[role="dialog"][aria-modal="true"]');
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
    textBoxes.push({
      el,
      rect,
      layer: modalOf(el),
      label: describe(el) + ' ' + JSON.stringify(text(el).slice(0, 24)),
    });
  }

  const overlaps = [];
  for (let i = 0; i < textBoxes.length; i += 1) {
    for (let j = i + 1; j < textBoxes.length; j += 1) {
      const a = textBoxes[i];
      const b = textBoxes[j];
      // Containment is a layout; only shared area between siblings is a clash.
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
      // Different layers are drawn on top of each other on purpose; see the
      // modal note above.
      if (a.layer !== b.layer) continue;
      const w = Math.min(a.rect.right, b.rect.right) - Math.max(a.rect.left, b.rect.left);
      const h = Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.top, b.rect.top);
      if (w <= 2 || h <= 2) continue;
      overlaps.push({ a: a.label, b: b.label, sharedWidth: round(w), sharedHeight: round(h) });
    }
  }

  /*
   * 7. Typography: text a person has to read must be large enough to read.
   *
   * Every rule above is geometry — where a box is, whether it fits, whether two
   * boxes share pixels. None of them can see the *size of the letters*, which
   * is why 10.5px Chinese section labels, 11px table headers and a 9px caret
   * survived every round of this gate: they were never outside anything, never
   * collapsed, never clipped and never overlapping. They were just too small.
   *
   * The rule is deliberately about Chinese only. Han characters carry far more
   * ink per em than Latin letters do, so the size at which they stop resolving
   * is genuinely higher, and the small sizes this app uses for identifiers
   * (paths, hashes, seq numbers, arrow glyphs) are ASCII and stay legal. The
   * floor itself is imported from this module (CJK_FLOOR_PX) so the
   * stylesheet's contract test and this measurement cannot disagree.
   *
   * Grouped by element and size so one undersized rule reports once with a
   * count, rather than a hundred lines of the same defect — a report nobody
   * can read is a report nobody fixes.
   */
  const CJK = /[\u3400-\u9fff\uf900-\ufaff]/;
  const cjkFloor = ${CJK_FLOOR_PX};
  const ownText = (el) =>
    Array.from(el.childNodes)
      .filter((node) => node.nodeType === 3)
      .map((node) => node.textContent || '')
      .join('')
      .trim();
  const small = new Map();
  const tracked = new Map();
  const tightLeading = [];
  /*
   * Every size actually rendered on this screen, not every size declared in the
   * stylesheet.
   *
   * 'tests/contract/typography.test.ts' already resolves the four --fs-* tokens
   * and fails if a fifth appears *in the source*. That is a claim about the
   * stylesheet, and the promise this app makes is about a screen: four sizes is
   * what a reader holds without noticing the type at all. Between the two there
   * is room for a fifth size that no token declared — an inherited size, a
   * browser default on a control nobody styled, a rule that picked its own
   * number. So the engine's computed sizes are collected here, grouped by size,
   * and the gate asserts the count.
   *
   * Only boxes with their own visible text count: an empty wrapper inherits a
   * size without showing a letter, and counting it would report sizes nobody
   * can see.
   */
  const tiers = new Map();
  const cjkSizes = new Map();
  /*
   * The font stack each Chinese box was actually drawn with, and whether the
   * engine had to synthesise an italic for it.
   *
   * 'tests/contract/typography.test.ts' asserts that the declared stack in
   * styles.css is Latin, then Chinese, then a generic family, and that no rule
   * writes 'font-style: italic'. Both are claims about the source. What ships
   * is the computed style: a var() that stopped resolving, a family inherited
   * from an unstyled control, or an inline style on one component would all
   * leave the source assertion green and the screen wrong. This is the measured
   * half of the same promise, reported per distinct stack so a failure names
   * the family list and one element that carries it.
   */
  const families = new Map();
  const fakeItalics = [];
  /*
   * How many Chinese-bearing boxes this frame actually had. A typography rule
   * that measured nothing is indistinguishable from one that found nothing, so
   * the count travels in the result and the gate asserts it is not near zero.
   */
  let cjkCount = 0;
  for (const el of all) {
    if (!visible(el)) continue;
    const own = ownText(el);
    if (own.length === 0) continue;
    if (!CJK.test(own)) continue;
    /*
     * A screen-reader-only box is not on screen, so its size is not a reading
     * problem; flagging it would be this gate complaining about the
     * accessibility feature working.
     */
    if (el.closest('.sr-only') !== null) continue;
    cjkCount += 1;
    const style = getComputedStyle(el);
    const size = round(parseFloat(style.fontSize));
    cjkSizes.set(size, (cjkSizes.get(size) || 0) + 1);
    if (size < cjkFloor) {
      const key = describe(el) + ' @' + size + 'px';
      const group = small.get(key) || {
        element: describe(el),
        fontSize: size,
        count: 0,
        text: own.slice(0, 30),
      };
      group.count += 1;
      small.set(key, group);
    }
    /*
     * Negative tracking on Han text: the letters are already dense, so pulling
     * them together is the one direction that makes them worse. Latin-only
     * headings may still be tightened.
     */
    const tracking = parseFloat(style.letterSpacing);
    if (Number.isFinite(tracking) && tracking < 0) {
      const key = describe(el) + ' @' + tracking + 'px';
      const group = tracked.get(key) || {
        element: describe(el),
        letterSpacing: tracking,
        count: 0,
        text: own.slice(0, 30),
      };
      group.count += 1;
      tracked.set(key, group);
    }
    /*
     * The stack, as resolved. Grouped by the computed list rather than by
     * element, because one rule is what produces one stack: a failure that
     * names forty boxes is a failure nobody reads.
     */
    const family = style.fontFamily;
    const familyGroup = families.get(family) || {
      family: family,
      count: 0,
      element: describe(el),
      text: own.slice(0, 30),
    };
    familyGroup.count += 1;
    families.set(family, familyGroup);
    /*
     * A slanted Han glyph is not an italic: there is no italic cut of a Chinese
     * face, so the engine shears the upright one and the strokes go muddy.
     * Latin-only emphasis may still use a real italic cut; this loop only walks
     * boxes that carry Han text.
     */
    if (style.fontStyle === 'italic' || style.fontStyle === 'oblique') {
      fakeItalics.push({
        element: describe(el),
        fontStyle: style.fontStyle,
        text: own.slice(0, 30),
      });
    }
    /*
     * Leading, for the case where it matters: a Chinese paragraph that wrapped
     * onto more than one line.
     *
     * A single line has no leading to judge, so the check counts line *boxes*
     * rather than dividing the element's height by the line height: a padded
     * one-line caption would pass that division off as three lines and be
     * reported as cramped. A Range over the element's own text returns one rect
     * per line box, which is exactly the question being asked.
     */
    const lineHeight = parseFloat(style.lineHeight);
    if (Number.isFinite(lineHeight) && lineHeight > 0 && own.length >= 24) {
      const range = document.createRange();
      range.selectNodeContents(el);
      const lineBoxes = Array.from(range.getClientRects()).filter(
        (rect) => rect.width > 1 && rect.height > 1,
      ).length;
      if (lineBoxes >= 2 && lineHeight / size < 1.45) {
        tightLeading.push({
          element: describe(el),
          fontSize: size,
          lineHeight: round(lineHeight / size),
          lines: lineBoxes,
          text: own.slice(0, 30),
        });
      }
    }
  }

  /*
   * An ASCII-only size is still a size on the screen: the identifier role
   * (10.5px) never appears on Han text by design, so a tier count built inside
   * the Chinese loop would miss it and report a three-size screen that shows
   * four. This walks every visible box with its own text, in either script.
   */
  for (const el of all) {
    if (!visible(el)) continue;
    if (el.closest('.sr-only') !== null) continue;
    const own = ownText(el);
    if (own.length === 0) continue;
    const size = round(parseFloat(getComputedStyle(el).fontSize));
    if (!Number.isFinite(size)) continue;
    const tier = tiers.get(size) || {
      element: describe(el),
      fontSize: size,
      count: 0,
      text: own.slice(0, 30),
    };
    tier.count += 1;
    tiers.set(size, tier);
  }

  /*
   * 8. Typeset: how long a line of prose is, and where it is allowed to break.
   *
   * Everything above measures boxes. This measures the *lines inside* them,
   * which is the layer where Chinese typography actually fails: a paragraph can
   * be inside its box, unclipped, unoverlapped, set at 13px with 1.7 leading,
   * and still be unreadable because each line is 60 characters long or because
   * a full stop is sitting at the left margin.
   *
   * Three rules, all from the same measurement:
   *
   *   - **Line length, ceiling.** A Han character is about one em wide, so a
   *     line box's width divided by the font size is the line length in
   *     characters. The ceiling is MAX_PROSE_LINE_CJK. Only wrapped blocks are
   *     measured: a single-line label has no line length to judge, and the last
   *     line of a paragraph is short by definition, so the *longest* line is
   *     what counts.
   *   - **Line length, floor.** The same number against MIN_PROSE_LINE_CJK, but
   *     only where the block's container had that much room — see the check
   *     below for why the condition is the whole rule.
   *   - **Break position.** Walk the characters of a wrapped block, group them
   *     into lines by their own rects, and check the first and last character
   *     of every line that is not the block's first or last. A line may not
   *     begin with closing punctuation and may not end with an opening bracket.
   *
   * Why measure instead of trusting the engine: Chromium's default line
   * breaking already implements most of UAX #14, so the break rule is expected
   * to be clean — and that is exactly why it needs a gate. A rule that is only
   * true by default is a rule that disappears the day someone adds a property
   * to a prose class.
   *
   * Which property actually breaks it was measured, not assumed (a synthetic
   * page, 400px wide, 30 Han characters then '。'): 'line-break: anywhere'
   * puts the full stop at the start of the next line and this rule reports it.
   * 'word-break: break-all' and 'overflow-wrap: anywhere' do *not* — Chromium
   * keeps the CJK punctuation rules under both, so a page that sets them still
   * breaks cleanly. The first version of this comment claimed all three did;
   * the measurement said otherwise, and the comment now says what was seen.
   */
  const MAX_LINE = ${MAX_PROSE_LINE_CJK};
  const MIN_LINE = ${MIN_PROSE_LINE_CJK};
  const PROSE_MIN_CHARS = ${PROSE_MIN_CHARS};
  const START_FORBIDDEN = ${JSON.stringify(LINE_START_FORBIDDEN)};
  const END_FORBIDDEN = ${JSON.stringify(LINE_END_FORBIDDEN)};
  const MIN_LAST_GLYPHS = ${MIN_LAST_LINE_GLYPHS};
  const LAST_IGNORED = ${JSON.stringify(LAST_LINE_IGNORED)};
  const longLines = [];
  const shortLines = [];
  const stubLines = [];
  const badBreaks = [];
  /*
   * How many blocks the floor actually applied to.
   *
   * A rule that measured nothing is indistinguishable from one that found
   * nothing, and this rule has a condition that can silently stop being met:
   * if every prose block ended up in a container narrower than the floor, the
   * check would pass over an empty set forever. The gate asserts this count is
   * not zero, so "the floor was enforced" is a measurement rather than a hope.
   */
  let floorChecked = 0;
  let proseBlocks = 0;
  let proseLines = 0;
  for (const el of all) {
    if (!visible(el)) continue;
    if (el.closest('.sr-only') !== null) continue;
    const own = ownText(el);
    /*
     * Prose, not labels. A two-character tab label or a status segment is not
     * a paragraph: it has no line length to judge and no break to check, and
     * walking its characters would be the expensive half of this measurement
     * for nothing. The threshold is PROSE_MIN_CHARS, exported above so the
     * contract test can pin it.
     */
    if (own.length < PROSE_MIN_CHARS || !CJK.test(own)) continue;
    const style = getComputedStyle(el);
    const size = parseFloat(style.fontSize);
    if (!Number.isFinite(size) || size <= 0) continue;
    /*
     * Per-character rects, grouped into lines.
     *
     * The element's own client rects are not a line count: a button with an
     * icon and a label returns one rect per inline box, and a span with a
     * nested <strong> returns two for one line. The characters are the only
     * thing that knows where the lines actually are. They are sorted by top and
     * then by left, and a character joins the current line while its top is
     * within 2px of that line's first character — the tolerance is for inline
     * elements that set a different font size on the same line.
     */
    const chars = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node !== null) {
      const value = node.textContent || '';
      for (let i = 0; i < value.length; i += 1) {
        const ch = value[i];
        if (/\\s/.test(ch)) continue;
        const charRange = document.createRange();
        charRange.setStart(node, i);
        charRange.setEnd(node, i + 1);
        const box = charRange.getBoundingClientRect();
        if (box.width === 0 && box.height === 0) continue;
        chars.push({ ch: ch, top: box.top, left: box.left, right: box.right });
      }
      node = walker.nextNode();
    }
    if (chars.length === 0) continue;
    chars.sort((a, b) => (Math.abs(a.top - b.top) > 2 ? a.top - b.top : a.left - b.left));
    const lines = [];
    for (const c of chars) {
      const current = lines[lines.length - 1];
      if (current === undefined || Math.abs(c.top - current.top) > 2) {
        lines.push({ top: c.top, first: c.ch, last: c.ch, text: c.ch, left: c.left, right: c.right });
      } else {
        current.last = c.ch;
        current.text += c.ch;
        current.left = Math.min(current.left, c.left);
        current.right = Math.max(current.right, c.right);
      }
    }
    if (lines.length < 2) continue;
    proseBlocks += 1;
    proseLines += lines.length;
    /*
     * Line length in CJK-equivalent characters: a Han character is about one em
     * wide, so the line box's width divided by the font size is the count. The
     * last line of a paragraph is short by definition, so the longest line is
     * what the ceiling is about.
     */
    let longest = 0;
    for (const line of lines) longest = Math.max(longest, (line.right - line.left) / size);
    if (longest > MAX_LINE + 0.5) {
      longLines.push({
        element: describe(el),
        fontSize: round(size),
        lines: lines.length,
        longestCjk: round(longest),
        text: own.slice(0, 30),
      });
    }
    /*
     * The floor, and the one condition that keeps it from being a rule about
     * window size.
     *
     * 'room' is how many characters the block's container could have given it:
     * the parent's content width divided by the same font size. A block whose
     * longest line is under MIN_LINE while its container had MIN_LINE or more
     * is a block that chose to be narrow — a max-width smaller than the measure
     * — and that is the defect. A block in a 300px panel is not: there the
     * container is the constraint, and the ceiling is the only rule that
     * applies.
     *
     * The parent's padding is subtracted because clientWidth includes it, and
     * a card with 16px of padding on each side has 32px less room than its box
     * suggests. A missing parent (a detached node) leaves room at 0, which
     * disables the floor rather than inventing a verdict.
     */
    let room = 0;
    const parent = el.parentElement;
    if (parent !== null) {
      const parentStyle = getComputedStyle(parent);
      const padLeft = parseFloat(parentStyle.paddingLeft) || 0;
      const padRight = parseFloat(parentStyle.paddingRight) || 0;
      room = (parent.clientWidth - padLeft - padRight) / size;
    }
    if (room >= MIN_LINE) floorChecked += 1;
    if (longest < MIN_LINE - 0.5 && room >= MIN_LINE) {
      shortLines.push({
        element: describe(el),
        fontSize: round(size),
        lines: lines.length,
        longestCjk: round(longest),
        roomCjk: round(room),
        text: own.slice(0, 30),
      });
    }
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (i > 0 && START_FORBIDDEN.indexOf(line.first) !== -1) {
        badBreaks.push({
          element: describe(el),
          kind: 'line-start',
          char: line.first,
          line: i + 1,
          text: own.slice(0, 30),
        });
      }
      if (i < lines.length - 1 && END_FORBIDDEN.indexOf(line.last) !== -1) {
        badBreaks.push({
          element: describe(el),
          kind: 'line-end',
          char: line.last,
          line: i + 1,
          text: own.slice(0, 30),
        });
      }
    }
    /*
     * The last line. This is the one line the two rules above deliberately
     * exempt: it is short by definition, so it can be neither too long nor too
     * short, and it is not followed by a break, so neither break rule looks at
     * it. That exemption is what a runt lives in - a paragraph whose final line
     * is a single character plus its full stop is legal under every rule in
     * this measurement and is still a paragraph that ends badly.
     *
     * Characters are counted rather than measured: the punctuation a line ends
     * with belongs to the character before it, so it is skipped rather than
     * counted as company. The threshold is MIN_LAST_GLYPHS, exported above with
     * the measurement that found the defect.
     */
    let lastGlyphs = 0;
    const lastLine = lines[lines.length - 1].text;
    for (let i = 0; i < lastLine.length; i += 1) {
      if (LAST_IGNORED.indexOf(lastLine[i]) === -1) lastGlyphs += 1;
    }
    if (lastGlyphs < MIN_LAST_GLYPHS) {
      stubLines.push({
        element: describe(el),
        fontSize: round(size),
        lines: lines.length,
        lastGlyphs: lastGlyphs,
        last: lastLine,
        text: own.slice(0, 30),
      });
    }
  }

  return JSON.stringify({
    /*
     * Which state this frame actually is.
     *
     * The fixture stamps the installed scenario onto <html>, so a measurement
     * can say what it photographed instead of relying on the caller to
     * remember which URL it asked for — the round that measured five states
     * against the first one's geometry is exactly what that bookkeeping
     * missed.
     */
    scenario: (document.documentElement.dataset.ucadFixture || ''),
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
      previewVisible: visible(document.querySelector('.preview')),
      /*
       * The two screens that are *not* the shell, named rather than inferred.
       *
       * A measurement that reports geometry alone cannot tell "the error pane
       * is laid out correctly" from "the shell was on screen again because the
       * URL was ignored". These two are read exactly as App.tsx paints them:
       * the fatal branch is a '.pane' directly under '.app' with an h1, and the
       * permission dialog is the one overlay that announces itself as a modal.
       */
      errorPane:
        document.querySelector('.app > .pane > .pane-head h1') !== null &&
        document.querySelector('.app > .pane > .row-gap') !== null,
      dialogOpen: document.querySelector('.dialog[role="dialog"][aria-modal="true"]') !== null,
      bodyChars: text(document.body).length,
      /*
       * The first-run block's hierarchy, as computed rather than as declared.
       *
       * 'docs/state-walkthrough.md' asks a walker whether the eye lands on the
       * lead sentence first, "and it is more prominent than the text around
       * it". That half is not a matter of taste: it is a colour and a size, and
       * both are readable from the engine. It was --text-2 at --fs-body while
       * the three steps beneath it were --text-2 at --fs-note - the same
       * colour, one pixel apart - so the block had no entry point at all and
       * the walkthrough could not have passed it.
       *
       * stepMarkers counts the span.n circles the steps used to carry; it is 0
       * now, and the assertion that it stays 0 is what keeps a second drawing
       * of .step-n from coming back. listStyle is the replacement: the count is
       * the list's own marker. (The tokens are named without their leading
       * dashes and without quoting so this comment cannot end the string it
       * lives in - see the note at the top of this file.)
       *
       * null when the block is not on screen, so a state that has no first-run
       * block cannot be read as one that has an empty one.
       */
      firstRun: (() => {
        const lead = document.querySelector('.first-run-lead');
        const step = document.querySelector('.first-run-steps li');
        const list = document.querySelector('.first-run-steps');
        if (lead === null || step === null || list === null) return null;
        const leadStyle = getComputedStyle(lead);
        const stepStyle = getComputedStyle(step);
        return {
          leadSize: round(parseFloat(leadStyle.fontSize)),
          leadColor: leadStyle.color,
          stepSize: round(parseFloat(stepStyle.fontSize)),
          stepColor: stepStyle.color,
          bodyColor: getComputedStyle(document.body).color,
          stepMarkers: document.querySelectorAll('.first-run-steps .n').length,
          listStyle: getComputedStyle(list).listStyleType,
        };
      })(),
    },
    horizontalOverflow: round(horizontalOverflow),
    escaping: escaping.slice(0, 12),
    collapsed: collapsed.slice(0, 12),
    clipped: clipped.slice(0, 12),
    offscreenControls: offscreenControls.slice(0, 12),
    overlaps: overlaps.slice(0, 12),
    textBoxes: textBoxes.length,
    /*
     * Typography, as measured rather than declared. The floor travels with the
     * result so a reader of the JSON can tell which rule produced the numbers
     * without opening this file.
     */
    typography: {
      cjkFloor: cjkFloor,
      cjkCount: cjkCount,
      /*
       * Descending, so the largest tier is first and the fifth one — the one
       * that should not exist — is the last line of a failure message.
       */
      tiers: Array.from(tiers.values()).sort((a, b) => b.fontSize - a.fontSize).slice(0, 12),
      cjkSizes: Array.from(cjkSizes.entries())
        .map((entry) => ({ fontSize: entry[0], count: entry[1] }))
        .sort((a, b) => a.fontSize - b.fontSize),
      tooSmall: Array.from(small.values()).slice(0, 12),
      negativeTracking: Array.from(tracked.values()).slice(0, 12),
      tightLeading: tightLeading.slice(0, 12),
      /*
       * Every computed stack that carried Han text on this frame, with a count
       * and one example element. The gate reads the order out of these strings:
       * a Latin family, then a Chinese one, then a generic.
       */
      families: Array.from(families.values()).slice(0, 8),
      /* Han boxes the engine had to shear, grouped by element and style. */
      fakeItalics: fakeItalics.slice(0, 12),
    },
    /*
     * Typeset, as measured rather than declared: line length in CJK-equivalent
     * characters, and where the lines were allowed to break. The ceiling and
     * the two character sets travel with the result so a reader of the JSON can
     * tell which rule produced the numbers without opening this file.
     */
    typeset: {
      maxLineCjk: MAX_LINE,
      minLineCjk: MIN_LINE,
      proseBlocks: proseBlocks,
      proseLines: proseLines,
      longLines: longLines.slice(0, 12),
      shortLines: shortLines.slice(0, 12),
      floorChecked: floorChecked,
      minLastLineGlyphs: MIN_LAST_GLYPHS,
      /*
       * The last-line rule as the engine resolved it — the means, next to the
       * result.
       *
       * 'stubLines' below is what the rule *did*: no paragraph ends on a runt.
       * This is what makes it do that: body's computed 'text-wrap'. A browser
       * that did not understand 'pretty' would drop the declaration and
       * resolve to 'auto', and the result assertion would still be green on
       * the day an engine change re-introduced the runts in a place this
       * sweep does not look — the gate would be measuring a screen the product
       * no longer renders the same way. Asserting both is what lets a failure
       * say "the engine stopped applying the rule" instead of only "a
       * paragraph ends on one character".
       *
       * The longhands are read as well as the shorthand because 'text-wrap' is
       * a shorthand in Chromium and CSSOM does not promise to serialise a
       * shorthand's computed value: 'text-wrap-style' is the longhand that
       * carries 'pretty', and either one answering is enough.
       */
      textWrap: (() => {
        const style = getComputedStyle(document.body);
        const values = [
          style.getPropertyValue('text-wrap'),
          style.getPropertyValue('text-wrap-style'),
          style.textWrapStyle || '',
        ];
        return values
          .map((value) => String(value).trim())
          .filter((value) => value.length > 0)
          .join(' ');
      })(),
      stubLines: stubLines.slice(0, 12),
      badBreaks: badBreaks.slice(0, 12),
    },
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
  /*
   * Two shapes count as settled, which is why this reports a shape rather than
   * a boolean.
   *
   * A first load that succeeds paints the shell, whose statusbar carries text.
   * A first load that *fails* paints the error pane instead (App.tsx's
   * 'if (fatal)' branch): no rail, no statusbar, an h1 and a retry button. That
   * is a settled screen — it is the screen a person sees when the store cannot
   * be read — and waiting only for a statusbar made '?scenario=error'
   * unmeasurable: the probe waited out its whole budget and then reported "the
   * app never settled" about a window that had settled long before.
   *
   * '.app > .pane' is the error pane's own shape: in the ordinary shell the
   * topbar, the body and the statusbar are the direct children of '.app', and
   * every other pane lives inside '.body'.
   */
  const errorPane =
    document.querySelector('.app > .pane > .pane-head h1') !== null &&
    document.querySelector('.app > .pane > .row-gap') !== null;
  return JSON.stringify({
    seam: true,
    scenario: seam.scenario,
    treeRows: document.querySelectorAll('.rail .tree-row').length,
    hasStatusbar: Boolean((document.querySelector('.statusbar')?.innerText || '').trim()),
    hasErrorPane: errorPane,
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
