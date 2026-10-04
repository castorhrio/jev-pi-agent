/**
 * Colour contrast, as a gate.
 *
 * This exists because two separate things made the question unanswerable, and
 * both were found by checking rather than assuming:
 *
 *  1. **axe-core cannot judge contrast in this harness.** Running
 *     `axe.run` with `runOnly: ['color-contrast']` returns *zero violations and
 *     zero incomplete* — the rule evaluates no nodes at all. So the a11y scan
 *     in `accessibility.e2e.test.tsx` is structurally incapable of reporting a
 *     contrast problem, and its green result says nothing about contrast. A
 *     rule that never ran and a rule that found nothing look identical.
 *
 *  2. **The E2E DOM had no stylesheet** until round 18, so even reading the
 *     colour off an element was impossible.
 *
 * Both are fixed now (CSS is loaded; `getComputedStyle` returns real values),
 * but axe's rule is still inert. So the check is done directly: read the
 * palette tokens out of `styles.css` and compute the WCAG ratio. That needs no
 * layout engine, no browser, and it is exact — whereas axe's answer here is
 * "nothing to say".
 *
 * ## What is and is not asserted
 *
 * Only **text on a background** is asserted, because that is what WCAG 1.4.3
 * governs and what a user actually has to read. Decorative tokens are listed
 * explicitly and are *not* gated: `--border-strong` sits at 1.6:1 against the
 * page and that is a deliberate low-key border, not unreadable text. Gating it
 * would produce a failure with no user behind it, and a gate that cries wolf
 * gets switched off.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

/** WCAG 2.1 relative luminance / contrast ratio, straight from the spec. */
function channel(value: number): number {
  const v = value / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function luminance(hex: string): number {
  const raw = hex.replace('#', '');
  const full =
    raw.length === 3
      ? raw
          .split('')
          .map((c) => c + c)
          .join('')
      : raw;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(foreground: string, background: string): number {
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

const CSS_PATH = 'apps/desktop/src/renderer/src/styles.css';
const css = readFileSync(CSS_PATH, 'utf8');

const tokens = new Map<string, string>();
for (const match of css.matchAll(/(--[a-z0-9-]+):\s*(#[0-9a-fA-F]{3,8})\s*;/g)) {
  tokens.set(match[1]!, match[2]!);
}

function token(name: string): string {
  const value = tokens.get(name);
  expect(value, `${name} is not defined in ${CSS_PATH}`).toBeDefined();
  return value!;
}

/** WCAG AA for body text. All the pairs below are ≤ 12px, i.e. normal text. */
const AA_NORMAL = 4.5;
/** A little headroom, so a later tweak that "just barely" passes still fails. */
const TARGET = 4.6;

/**
 * Every surface a text token is actually rendered on.
 *
 * `--surface-2` was missing from this list for nine rounds — it is the active
 * rail row's background, and `--text-3` sat at 4.34:1 on it while this gate
 * was green. Found only when the layout probe started running axe inside real
 * Chromium (round 34), where the rule evaluates actual elements instead of
 * nothing. A surface that appears in the product belongs in this list.
 */
const SURFACES = ['--bg', '--surface', '--inset', '--surface-2'] as const;

const TEXT_TOKENS = ['--text', '--text-2', '--text-3'] as const;

/** Badges: coloured text on their own dimmed plate. */
const BADGES: Array<{ fg: string; bg: string; where: string }> = [
  { fg: '--ok', bg: '--ok-dim', where: 'the 已配置 / success badge' },
  { fg: '--warn', bg: '--warn-dim', where: 'the warning badge' },
  { fg: '--err', bg: '--err-dim', where: 'the error badge' },
];

describe('colour contrast (WCAG 1.4.3)', () => {
  it.each(TEXT_TOKENS)('%s clears AA on every surface', (fg) => {
    const failures: string[] = [];
    for (const surface of SURFACES) {
      const ratio = contrast(token(fg), token(surface));
      if (ratio < TARGET) {
        failures.push(
          `  ${fg} ${token(fg)} on ${surface} ${token(surface)} = ${ratio.toFixed(2)}:1 ` +
            `(needs ${AA_NORMAL}:1, target ${TARGET}:1)`,
        );
      }
    }
    expect(failures, `contrast failures:\n${failures.join('\n')}`).toEqual([]);
  });

  it.each(BADGES)('$fg clears AA on $bg ($where)', ({ fg, bg }) => {
    const ratio = contrast(token(fg), token(bg));
    expect(
      ratio,
      `${fg} ${token(fg)} on ${bg} ${token(bg)} = ${ratio.toFixed(2)}:1, needs ${AA_NORMAL}:1`,
    ).toBeGreaterThanOrEqual(TARGET);
  });

  it('the accent clears AA on the page background', () => {
    // `.surface-tab.active` and primary buttons draw attention with this, so a
    // label rendered in it has to be readable, not merely noticeable.
    const ratio = contrast(token('--accent'), token('--bg'));
    expect(
      ratio,
      `--accent ${token('--accent')} on --bg = ${ratio.toFixed(2)}:1, needs ${AA_NORMAL}:1`,
    ).toBeGreaterThanOrEqual(TARGET);
  });

  it('does not pretend axe is checking any of this', () => {
    // The reason this file exists, asserted so the reason cannot be forgotten:
    // axe's colour-contrast rule evaluates zero nodes in happy-dom, so its
    // silence is not evidence. If a future environment makes the rule real,
    // this test is the one to revisit — and it should then be deleted rather
    // than left to drift alongside a second, weaker check.
    const tokensSeen = tokens.size;
    expect(
      tokensSeen,
      'the palette could not be parsed out of styles.css, so no ratio below means anything',
    ).toBeGreaterThan(20);
  });
});
