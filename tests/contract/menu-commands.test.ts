/**
 * Every menu command Main registers must have a renderer handler.
 *
 * ## Why this exists
 *
 * This is red line 2, and it has a shipped failure behind it.
 * Round 1 found that the menu item 「生成交接摘要」 sent `create-handoff` and the
 * renderer's `onCommand` switch had no such case: clicking it did *nothing at
 * all*, with no error and no visible effect. The fix was one `case` line — which
 * is exactly why it is easy to forget the next time, and why the invariant was
 * written down as a red line but left unenforced for forty rounds.
 *
 * The project has a rule about this: **a check only a person can perform by hand
 * is not a gate, because it will be skipped.** Nobody re-reads a switch statement
 * against a menu template.
 *
 * ## Why it is written defensively
 *
 * The obvious way to write this — regex both files, compare the two sets — has a
 * failure mode that is worse than having no test: if the regex quietly stops
 * matching (someone switches to a computed command, or reformats the `case`), the
 * command set becomes empty, every subset assertion passes, and the gate reports
 * green while protecting nothing. That is the 「没跑」和「没找到」长得一模一样
 * trap the `focus-indicator` gate already documents in its first assertion.
 *
 * So the first test here counts *call sites* separately from *literal commands*,
 * and fails if those two numbers ever disagree. A dynamic command cannot hide.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const MENU_PATH = 'apps/desktop/src/main/menu.ts';
const RENDERER_DIR = 'apps/desktop/src/renderer/src';

const menuSource = readFileSync(MENU_PATH, 'utf8');

/**
 * Command strings the menu actually sends, and how many call sites there are.
 *
 * The two are tracked apart on purpose. `SEND_CALLS` counts every `send(deps, …)`
 * invocation; `SENT` only counts the ones whose command is a string literal. If
 * someone ever dispatches a computed command, the counts diverge and the guard
 * test below fails loudly instead of the command silently vanishing from the set.
 */
const SEND_CALLS = menuSource.match(/\bsend\(\s*deps\s*,/g) ?? [];
const SENT = [...menuSource.matchAll(/\bsend\(\s*deps\s*,\s*'([^']+)'/g)].map((m) => m[1]!);
const sentCommands = [...new Set(SENT)].sort();

/** Every `case '…':` in the renderer's command handler(s). */
function rendererSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name)) out.push(readFileSync(full, 'utf8'));
    }
  };
  walk(RENDERER_DIR);
  return out;
}

const handlerSources = rendererSources();
const HANDLED = new Set(
  handlerSources.flatMap((src) => [...src.matchAll(/\bcase\s+'([^']+)'\s*:/g)].map((m) => m[1]!)),
);

describe('menu commands reach a renderer handler', () => {
  it('finds the command sends in the menu', () => {
    // If this ever reads 0, every assertion below is vacuously true.
    expect(
      sentCommands.length,
      `no menu command was found in ${MENU_PATH} — the menu was refactored and this ` +
        'scan no longer sees it, so it is protecting nothing',
    ).toBeGreaterThan(0);
  });

  it('reads every send() call site as a string literal', () => {
    // The hollow-green guard. A computed command would drop out of `SENT` and
    // take its coverage with it; this turns that into a red run instead.
    expect(
      SEND_CALLS.length,
      `found ${SEND_CALLS.length} send() call sites but only ${SENT.length} string-literal ` +
        'commands — one of them is computed, so this gate cannot check it',
    ).toBe(SENT.length);
  });

  it('finds the renderer command handler', () => {
    expect(
      handlerSources.some((src) => src.includes('menu.onCommand')),
      `no renderer file calls menu.onCommand under ${RENDERER_DIR} — the subscription ` +
        'moved or was renamed, so this gate is checking a switch nobody runs',
    ).toBe(true);
    expect(
      HANDLED.size,
      'no `case` labels were found in the renderer, so every command would look unhandled',
    ).toBeGreaterThan(0);
  });

  it.each(sentCommands)('`%s` is handled in the renderer', (command) => {
    expect(
      HANDLED.has(command),
      `the menu sends \`${command}\` but the renderer's onCommand switch has no case for ` +
        'it, so clicking that item does nothing at all — the round 1 defect, in a new item',
    ).toBe(true);
  });
});
