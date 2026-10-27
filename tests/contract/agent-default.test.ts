/**
 * The Renderer's last-resort agent id and the adapter table name one agent.
 *
 * ## Why this exists
 *
 * `effectiveAgentId` (and the Context Drawer's preview) used to end with
 * `|| 'mock'`: a literal in the Renderer, written independently of
 * `ADAPTER_CANDIDATES`, which is the table the Main process actually loads.
 * The fallback is only reached when settings and the catalogue are both empty —
 * exactly the first-run window where nothing else would notice — so a renamed
 * or removed adapter would leave the app sending turns to an id no adapter
 * answers to, with every existing test still green.
 *
 * Two checks close that:
 *
 *  - the id is now `DEFAULT_AGENT_ID` from `@ucad/contracts`, and
 *    `adapter-candidates.ts` asserts at compile time that it is a key of
 *    `ADAPTER_CANDIDATES` (the runtime assertion here is the same fact, so a
 *    build that skipped the type check still fails);
 *  - no Renderer source outside the dev fixture spells the id as a string
 *    literal. This is the direction the type system cannot see: a later edit
 *    can write `|| 'mock'` next to the constant and compile cleanly.
 *
 * `apps/desktop/src/renderer/src/dev/fixture-bridge.ts` is deliberately out of
 * scope: it *is* mock data, and its `agentId: 'mock'` describes a seeded
 * session, not a fallback the product computes.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { DEFAULT_AGENT_ID } from '@ucad/contracts';
import {
  ADAPTER_CANDIDATES,
  DEFAULT_AGENT_IS_A_CANDIDATE,
} from '../../apps/desktop/src/main/adapter-candidates';
import { blankComments } from './source-scan';

const here = import.meta.dirname;
const REPO_ROOT = join(here, '..', '..');
const RENDERER_SRC = join(REPO_ROOT, 'apps', 'desktop', 'src', 'renderer', 'src');
const DEV_DIR = join(RENDERER_SRC, 'dev');

interface SourceFile {
  /** repo-relative, `/`-separated, as a failure message should name it */
  readonly path: string;
  readonly source: string;
}

/** Every `.ts`/`.tsx` under the Renderer, except the dev fixture. */
function rendererSources(dir: string = RENDERER_SRC): SourceFile[] {
  const files: SourceFile[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (full === DEV_DIR) continue;
      files.push(...rendererSources(full));
      continue;
    }
    if (!/\.tsx?$/.test(entry.name)) continue;
    files.push({
      path: relative(REPO_ROOT, full).split(sep).join('/'),
      source: readFileSync(full, 'utf8'),
    });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

/** The line number of every string literal `'mock'` / `"mock"` in code. */
function quotedMockLines(source: string): number[] {
  const lines: number[] = [];
  blankComments(source)
    .split('\n')
    .forEach((line, index) => {
      if (/['"]mock['"]/.test(line)) lines.push(index + 1);
    });
  return lines;
}

const sources = rendererSources();

describe('the renderer fallback agent is the adapter table’s agent', () => {
  beforeAll(() => {
    // The subject itself: an empty walk would make the literal scan vacuous.
    expect(sources.length, `no Renderer sources were read under ${RENDERER_SRC}`).toBeGreaterThan(0);
    expect(DEFAULT_AGENT_ID, 'the shared default agent id is empty').not.toBe('');
  });

  it('is one of the adapters this build registers', () => {
    // Compile-time proof (`DEFAULT_AGENT_IS_A_CANDIDATE`) and runtime proof.
    // The first catches a removed adapter during `tsc`; the second catches a
    // build that did not run the type check, and names both values when red.
    expect(DEFAULT_AGENT_IS_A_CANDIDATE).toBe(true);
    expect(
      Object.keys(ADAPTER_CANDIDATES),
      `DEFAULT_AGENT_ID is "${DEFAULT_AGENT_ID}", which is not an adapter this build registers`,
    ).toContain(DEFAULT_AGENT_ID);
  });

  it('is never written as a bare string literal outside the dev fixture', () => {
    const offenders = sources
      .map((file) => ({ path: file.path, lines: quotedMockLines(file.source) }))
      .filter((file) => file.lines.length > 0)
      .map((file) => `${file.path}:${file.lines.join(',')}`);

    expect(
      offenders,
      'these Renderer sources spell the fallback agent id as a literal; ' +
        'import DEFAULT_AGENT_ID from @ucad/contracts instead:\n  ' +
        offenders.join('\n  '),
    ).toEqual([]);
  });

  it('can see a copied literal, so the scan is not vacuous', () => {
    // The exact shape this gate was written for, through the same line reader.
    expect(quotedMockLines("const id = agentId || 'mock';\n")).toEqual([1]);
    expect(
      quotedMockLines("// 'mock' is the reference adapter\nconst id = DEFAULT_AGENT_ID;\n"),
    ).toEqual([]);
  });
});
