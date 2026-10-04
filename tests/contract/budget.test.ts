/**
 * The renderer must not put every dependency in the startup chunk.
 *
 * ## Why
 *
 * Vite warned on every build that the renderer was one oversized chunk. The
 * instinct is to code-split "because the tool said so", which is how a 40 kB
 * dependency ends up behind a lazy boundary for no reason — and how a real win
 * gets lost in noise.
 *
 * So this gate is about one measured fact rather than a style rule.
 * Source-map attribution of the built chunk said `@xterm/xterm` is 339 kB of
 * source, about 46% of the whole thing, and the terminal surface lives behind
 * the "更多" menu. Deferring it took the startup chunk from 742 kB to 401 kB.
 *
 * There is no network in an Electron app: files load from disk. The saving is
 * therefore parse and compile time at launch, not download — which is why the
 * number that matters is the size of the *entry* chunk, and why this asserts
 * on that rather than on the total.
 *
 * ## What it does not do
 *
 * It does not enforce a byte budget on the whole build, and it does not fail
 * when a new large dependency is added. A total-size rule would go red for
 * every ordinary feature and get raised; the useful, durable invariant is the
 * narrower one: the terminal emulator must not be in the entry chunk.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const RENDERER_DIST = 'apps/desktop/dist/renderer/assets';

/**
 * Reads the build output. Returns null when there is no build, so the gate can
 * skip rather than fail in a checkout that has not been built — a test that
 * demands a build artifact is a test that fails for the wrong reason.
 */
function rendererChunks(): Array<{ name: string; bytes: number }> | null {
  if (!existsSync(RENDERER_DIST)) return null;
  return readdirSync(RENDERER_DIST)
    .filter((f) => f.endsWith('.js'))
    .map((f) => ({ name: f, bytes: statSync(join(RENDERER_DIST, f)).size }));
}

const chunks = rendererChunks();
const entry =
  chunks?.find((c) => c.name.startsWith('index-') && !c.name.startsWith('index-legacy')) ?? null;

describe('renderer bundle', () => {
  it.skipIf(chunks === null)('has a build to inspect', () => {
    expect(chunks?.length).toBeGreaterThan(0);
  });

  it.skipIf(chunks === null)('keeps the terminal emulator out of the entry chunk', () => {
    expect(entry, 'no entry chunk found; has the build run?').not.toBeNull();
    const dedicated = chunks!.find((c) => c.name.startsWith('TerminalPanel-'));
    expect(
      dedicated,
      'TerminalPanel is not a separate chunk again, so the whole xterm emulator ' +
        '(~339 kB, about 46% of the renderer) is being parsed on every launch',
    ).toBeDefined();
  });

  it.skipIf(chunks === null)('keeps the entry chunk under the warning threshold', () => {
    // Vite warns above 500 kB. The build prints that warning on every run, and
    // a warning nobody acts on is noise, so it is asserted here instead.
    const bytes = entry!.bytes;
    expect(
      bytes,
      `the entry chunk is ${(bytes / 1024).toFixed(1)} kB, which Vite warns about on every build`,
    ).toBeLessThan(500 * 1024);
  });

  it.skipIf(chunks === null)('keeps the fixture bridge out of the entry chunk', () => {
    // The fixture is dev-only and is already split. If it ever merges back in,
    // the dev harness ships to users, which is the mistake the dynamic import
    // in `main.tsx` exists to prevent.
    const dedicated = chunks!.find((c) => c.name.startsWith('fixture-bridge-'));
    expect(
      dedicated,
      'the fixture bridge is inside the entry chunk — the dev harness would ship to users',
    ).toBeDefined();
  });
});
