/**
 * The five interface states have one list, and four consumers.
 *
 * ## Why this file exists
 *
 * Step 6 of the manual checklist asks a person to open
 * `?scenario=empty|loading|error|partial|permission` and answer four questions.
 * "The five states" is therefore a fact that lives in four places:
 *
 *  1. `apps/desktop/src/renderer/src/dev/scenarios.ts` — the names, and the
 *     `?scenario=` validator the browser harness runs;
 *  2. `tests/e2e/scenarios.e2e.test.tsx` — what each state puts on screen;
 *  3. `tests/contract/layout.test.ts` — the same states measured in a real
 *     layout engine;
 *  4. the prose that tells a person which URLs to open (`README.md` in both
 *     languages, `docs/manual-verification.md`).
 *
 * Each of those passed on its own while disagreeing with the others. Adding a
 * state to the fixture and not to (2) leaves it unasserted; adding it to (2)
 * and not to (4) leaves it unwalkable by hand; adding it to the union in the
 * old `fixture-bridge.ts` and not to the array it validated against made
 * `?scenario=` fall back to `default` — the state existed in tests and nowhere
 * a person could look at it. That last one is exactly how five states went
 * several rounds without being looked at, and it is why the union is now
 * derived from the array rather than written beside it.
 *
 * The checks below are cheap and specific: the names come from the one list,
 * and each consumer is read back to prove it still says the same thing.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SCENARIO,
  SCENARIOS,
  STATE_SCENARIOS,
  isScenario,
  scenarioFromLocation,
} from '../../apps/desktop/src/renderer/src/dev/scenarios';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, '..', '..');

/** The source with its comments removed — prose is not a declaration. */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function read(...parts: string[]): string {
  return fs.readFileSync(path.join(REPO_ROOT, ...parts), 'utf8');
}

describe('the scenario list is one fact', () => {
  it('the five walkable states are a subset of the installed scenarios', () => {
    // A state that cannot be installed is a URL that silently shows the happy
    // path, so this is the direction that matters most.
    for (const state of STATE_SCENARIOS) {
      expect(SCENARIOS, `${state} is not installable`).toContain(state);
    }
    expect(new Set(SCENARIOS).size, 'a duplicate scenario name').toBe(SCENARIOS.length);
  });

  it('the walkable list does not include the happy path', () => {
    // Otherwise "all five states are covered" could be satisfied by the one
    // state `critical-path.e2e.test.tsx` already drives end to end.
    expect(STATE_SCENARIOS as readonly string[]).not.toContain(DEFAULT_SCENARIO);
    expect(SCENARIOS[0]).toBe(DEFAULT_SCENARIO);
  });

  it('every state is reachable from the URL the checklist tells a person to open', () => {
    // Runs the real validator rather than restating the list: this is the check
    // that a name added to the array is actually reachable, and that the
    // fallback is the happy path rather than a half-installed fixture.
    for (const state of STATE_SCENARIOS) {
      expect(scenarioFromLocation(`?scenario=${state}`), `?scenario=${state}`).toBe(state);
    }
    expect(scenarioFromLocation('')).toBe(DEFAULT_SCENARIO);
    expect(scenarioFromLocation('?scenario=')).toBe(DEFAULT_SCENARIO);
    expect(scenarioFromLocation('?scenario=nonsense')).toBe(DEFAULT_SCENARIO);
  });

  it('the validator and the list agree, name by name', () => {
    for (const scenario of SCENARIOS) {
      expect(isScenario(scenario), `${scenario} is in SCENARIOS but not recognised`).toBe(true);
    }
    expect(isScenario('nonsense')).toBe(false);
    expect(isScenario(null)).toBe(false);
    expect(isScenario(undefined)).toBe(false);
  });
});

describe('the E2E suite drives exactly the walkable states', () => {
  it('mounts every state in the list, and nothing else', () => {
    const source = codeOnly(read('tests', 'e2e', 'scenarios.e2e.test.tsx'));
    const mounted = new Set([...source.matchAll(/mount\(\s*'([a-z-]+)'\s*\)/g)].map((m) => m[1]));

    expect(mounted.size, 'the step 6 suite mounts no state at all').toBeGreaterThan(0);
    // Two directions: a state with no test is unasserted, and a test for a
    // state that no longer exists is a test of the fallback.
    expect([...mounted].sort()).toEqual([...STATE_SCENARIOS].sort());
  });
});

describe('the layout gate measures the same five states', () => {
  it('builds its state targets from the list instead of spelling the names out', () => {
    // The gate had one `?scenario=` per hand-written target, so a sixth state
    // would be measured by nobody and nobody would notice. Both halves are
    // checked: the list is imported, and no target writes a scenario name
    // inline any more.
    const source = codeOnly(read('tests', 'contract', 'layout.test.ts'));
    expect(source, 'the layout gate does not import the scenario list').toContain('STATE_SCENARIOS');
    // Only target URLs: a *failure message* may name a state (`?scenario=error
    // did not mount`), and forbidding that would police prose instead of the
    // list. What must not appear is a target whose URL spells a state out.
    expect(source, 'a target still spells a walkable state out by hand').not.toMatch(
      /url:[^\n]*scenario=(empty|loading|error|partial|permission)/,
    );
  });
});

describe('the prose names the same five states', () => {
  const docs: Array<[string, string]> = [
    ['README.md', 'README (English + 中文)'],
    ['docs/manual-verification.md', 'the step 6 checklist'],
  ];

  it.each(docs)('%s tells a person about every state', (file, label) => {
    const prose = read(...file.split('/'));
    for (const state of STATE_SCENARIOS) {
      expect(prose, `${label} never mentions ?scenario=${state}`).toContain(`?scenario=${state}`);
    }
  });

  it('the README names the states in both languages', () => {
    // The two halves of the README are written separately, so one of them can
    // fall behind the fixture. The English paragraph says "Append", the Chinese
    // one says 追加; both list the same five URLs, and this fails if either
    // stops.
    const readme = read('README.md');
    for (const state of STATE_SCENARIOS) {
      const count = readme.split(`?scenario=${state}`).length - 1;
      expect(count, `README mentions ?scenario=${state} ${count} time(s), expected 2`).toBe(2);
    }
  });
});

describe('the probe loads a page in exactly one place', () => {
  /*
   * A page load has three consequences: axe's bundle is gone, the URL on
   * screen changed, and the app is fetching again. The probe wrote all three
   * out at each of its three call sites, which is correct today and one
   * forgotten line away from measuring (or scanning) the previous page. It is
   * one function now, so the invariant cannot be forgotten — and this is what
   * keeps it one function.
   */
  it('calls `loadURL` once, inside the helper that resets what a load wipes', () => {
    const source = codeOnly(read('scripts', 'layout-probe.mjs'));
    const calls = [...source.matchAll(/loadURL\(/g)];
    expect(calls.length, `layout-probe.mjs calls loadURL ${calls.length} time(s)`).toBe(1);

    const helper = source.slice(source.indexOf('const loadOnly'), source.indexOf('const showSettled'));
    expect(helper, 'the load helper does not reset axeInjected').toContain('axeInjected = false');
    expect(helper, 'the load helper does not record the URL it loaded').toContain('loadedUrl = url');
  });
});
