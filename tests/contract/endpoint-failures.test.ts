/**
 * Every guarded read has a panel that says why it failed.
 *
 * ## Why this file exists
 *
 * `state/hooks.ts` guards six reads individually so one dead subsystem cannot
 * blank the whole window. The cost of guarding is that a failure then looks
 * *exactly* like an empty result — and that is the defect this repository has
 * already paid for twice: `diagnostics.info()` failing rendered a red
 * **"not encrypted"** badge and "no log entries" on the one page whose job is
 * telling the user what is true, and a failed `sessions.list` painted
 * "还没有对话。在下面说清要做什么…" over a project that had conversations.
 *
 * The fix was `endpointErrors: Partial<Record<EndpointKey, string>>` — the
 * reason travels with the fallback, and the key set is the union so a new
 * guarded read cannot be added without deciding how it reports failure. What
 * the *type* cannot say is the other half: that the reason is actually
 * **rendered**. `endpointErrors.tools` can be recorded, typed, and read by
 * nobody, and the panel goes on saying "no tools" — green typecheck, green
 * tests, wrong screen.
 *
 * So this gate reads the renderer's own sources and asks, per key: does the
 * reason reach a place that draws something?
 *
 * ## What counts as "reaches the screen"
 *
 * Three shapes, all of them the ones the panels actually use:
 *
 *  - `reason={data.endpointErrors.x}` — the `ReadFailure` prop, which renders
 *    `label — reason` inside `role="alert"`;
 *  - `data.endpointErrors.x ? … : …` / `data.endpointErrors.x && …` — the
 *    reason gates a branch, which is how the rail and the status bar say it;
 *  - `const failure = data.endpointErrors.x` and then `failure` in either of
 *    the two positions above — the same thing, named once;
 *  - `{data.endpointErrors.x}` as a JSX child, which is on screen by
 *    definition and is how the rail prints the reason under its heading.
 *
 * A `reason=` site is additionally required to carry a `label=`, because
 * `ReadFailure`'s signature makes "just the reason" unspellable and a gate
 * that accepted a bare reason would let the label be dropped in the JSX
 * instead.
 *
 * ## The second question: is that position reachable?
 *
 * "Wired to a rendering position" is a syntactic claim, and it has a hole the
 * first version of this file left open: a position can be wired and still never
 * be reached. `{false && <ReadFailure reason={data.endpointErrors.tools} />}`
 * satisfies every check above — the key is in a `reason=`, the `label=` is
 * there, the panel exists — and the reader is told nothing, forever. So is the
 * shape that is one keystroke away from the correct one:
 * `{!data.endpointErrors.tools && <ReadFailure reason={data.endpointErrors.tools} />}`
 * renders the reason exactly when there is no reason, and
 * `{data.endpointErrors.tools ? null : <ReadFailure … />}` is the same mistake
 * written the other way round.
 *
 * The check is a walk up the ancestor chain of each rendering position, asking
 * whether a guard on the way makes the position impossible:
 *
 *  - a branch whose test is a literal falsy (`false && …`, `false ? … : …`);
 *  - a branch guarded by the *absence* of the same key (`!x && …`,
 *    `x === undefined ? … : …`, `x == null ? … : …`) when the reason is drawn
 *    inside it;
 *  - a branch guarded by the *presence* of the same key when the reason is
 *    drawn in the other half (`x ? null : <ReadFailure reason={x} />`).
 *
 * This is a static approximation, and it is deliberately a small one: it reads
 * the guard's *shape*, not its meaning. `data.loading ? … : …` around a reason
 * is not judged, because whether `loading` can be true while a reason exists is
 * a fact about `hooks.ts` that this file would have to re-derive — and the
 * e2e `?scenario=partial` case is where that question is actually answered.
 *
 * ## What is deliberately not asserted
 *
 * That the sentence is good, that the branch is not `null`, or that the panel
 * is the right one. This gate answers "is the reason wired to a rendering
 * position that can be reached", not "is the rendering honest" — the honest
 * half is driven by `tests/e2e/scenarios.e2e.test.tsx` (`?scenario=partial`
 * asserts the rail shows the reason and *not* the empty-state text) and by the
 * five-state walkthrough. A gate that tried to judge the copy would be a gate
 * nobody could keep green for the right reason.
 *
 * ## The red direction
 *
 * The checks are pure functions of `(keys, sources)`, so every failure path is
 * driven with mutated copies below rather than argued about: a key with no
 * reference, a key read into a variable nobody shows, a `reason=` without a
 * `label=`, a key added to the union with no panel at all, and each of the
 * three unreachable shapes above.
 */

import { readFileSync, readdirSync, type Dirent } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from '@typescript-eslint/typescript-estree';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(here, '../..');

/** The file that *produces* the reasons; it is not a panel and is not scanned. */
const PRODUCER = 'apps/desktop/src/renderer/src/state/hooks.ts';

/** The tree the panels live in. */
const RENDERER_ROOT = 'apps/desktop/src/renderer/src';

/** The union whose members each need a panel. */
const UNION_NAME = 'EndpointKey';

// ---------------------------------------------------------------------------
// A minimal AST walk
// ---------------------------------------------------------------------------

/** A parser node, read structurally: this file needs four node types, not a schema. */
interface Node {
  readonly type: string;
  readonly [field: string]: unknown;
}

const isNode = (value: unknown): value is Node =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { type?: unknown }).type === 'string';

/** Visits every node under `value`, skipping the parser's back-edges. */
function walk(value: unknown, visit: (node: Node) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit);
    return;
  }
  if (!isNode(value)) return;
  visit(value);
  for (const [field, child] of Object.entries(value)) {
    // `parent` is a back-edge (infinite), `loc`/`range` are positions.
    if (field === 'parent' || field === 'loc' || field === 'range') continue;
    walk(child, visit);
  }
}

/**
 * A node on the path from the root to the node being visited, and the field of
 * that node the path came through.
 *
 * The field is what makes a branch question answerable: `consequent` and
 * `alternate` are the two halves of a `? :`, and `right` is the half of a
 * `&&` / `||` that only runs when the left side allows it.
 */
interface Ancestor {
  readonly node: Node;
  readonly field: string;
}

/** `walk`, but carrying the path. Used by the reachability check below. */
function walkWithAncestors(
  value: unknown,
  visit: (node: Node, ancestors: readonly Ancestor[]) => void,
  ancestors: Ancestor[] = [],
): void {
  if (Array.isArray(value)) {
    for (const item of value) walkWithAncestors(item, visit, ancestors);
    return;
  }
  if (!isNode(value)) return;
  visit(value, ancestors);
  for (const [field, child] of Object.entries(value)) {
    if (field === 'parent' || field === 'loc' || field === 'range') continue;
    ancestors.push({ node: value, field });
    walkWithAncestors(child, visit, ancestors);
    ancestors.pop();
  }
}

const nameOf = (node: unknown): string | null => {
  if (!isNode(node)) return null;
  const name = node.name;
  return typeof name === 'string' ? name : null;
};

/** `endpointErrors` or `data.endpointErrors` — the two spellings in the tree. */
function isEndpointErrorsBag(value: unknown): boolean {
  if (!isNode(value)) return false;
  if (value.type === 'Identifier') return value.name === 'endpointErrors';
  if (value.type === 'MemberExpression') return nameOf(value.property) === 'endpointErrors';
  return false;
}

/** The key of `data.endpointErrors.<key>`, or `null` for any other expression. */
function endpointKeyOf(node: unknown): string | null {
  if (!isNode(node) || node.type !== 'MemberExpression') return null;
  if (node.computed === true) return null;
  if (!isEndpointErrorsBag(node.object)) return null;
  const property = node.property;
  if (!isNode(property) || property.type !== 'Identifier') return null;
  return nameOf(property);
}

/** The string literals of a union type alias, in source order. */
function unionMembers(source: string, alias: string): string[] {
  const program = parse(source, { jsx: false, range: false, loc: false });
  const members: string[] = [];
  walk(program, (node) => {
    if (node.type !== 'TSTypeAliasDeclaration') return;
    if (nameOf(node.id) !== alias) return;
    const annotation = node.typeAnnotation;
    if (!isNode(annotation) || annotation.type !== 'TSUnionType') return;
    const types = annotation.types;
    if (!Array.isArray(types)) return;
    for (const member of types) {
      if (!isNode(member) || member.type !== 'TSLiteralType') continue;
      const literal = member.literal;
      if (isNode(literal) && typeof literal.value === 'string') members.push(literal.value);
    }
  });
  return members;
}

/** The keys `guarded('<key>', …)` is called with, in source order. */
function guardedKeys(source: string): string[] {
  const program = parse(source, { jsx: false, range: false, loc: false });
  const keys: string[] = [];
  walk(program, (node) => {
    if (node.type !== 'CallExpression') return;
    if (nameOf(node.callee) !== 'guarded') return;
    const args = node.arguments;
    if (!Array.isArray(args) || args.length === 0) return;
    const first = args[0];
    if (isNode(first) && typeof first.value === 'string') keys.push(first.value);
  });
  return keys;
}

// ---------------------------------------------------------------------------
// What one renderer file does with the reasons
// ---------------------------------------------------------------------------

/** What a single renderer source file contributes to the question. */
interface FileAnalysis {
  /** Keys that appear directly in a rendering position. */
  readonly shownKeys: Set<string>;
  /** Identifier names that appear in a rendering position. */
  readonly shownNames: Set<string>;
  /** Key → the variables it was assigned to (`const failure = …`). */
  readonly namedKeys: Map<string, Set<string>>;
  /** Defects in the file itself, independent of which keys it mentions. */
  readonly problems: string[];
}

// ---------------------------------------------------------------------------
// Reachability: a rendering position that can never be reached
// ---------------------------------------------------------------------------

/** `null` or `undefined`, the two spellings a guard compares against. */
function isNullish(node: unknown): boolean {
  if (!isNode(node)) return false;
  if (node.type === 'Literal') return node.value === null;
  return node.type === 'Identifier' && node.name === 'undefined';
}

/** A literal that is falsy, so a guard built on it never lets anything through. */
function isFalsyLiteral(node: unknown): boolean {
  if (!isNode(node)) return false;
  if (node.type === 'Literal') return !node.value;
  return node.type === 'Identifier' && node.name === 'undefined';
}

/** Whether `test` asserts that `endpointErrors.<key>` is present. */
function assertsPresent(test: unknown, key: string): boolean {
  if (endpointKeyOf(test) === key) return true;
  if (!isNode(test) || test.type !== 'BinaryExpression') return false;
  if (test.operator !== '!=' && test.operator !== '!==') return false;
  return (
    (endpointKeyOf(test.left) === key && isNullish(test.right)) ||
    (endpointKeyOf(test.right) === key && isNullish(test.left))
  );
}

/** Whether `test` asserts that `endpointErrors.<key>` is absent. */
function assertsAbsent(test: unknown, key: string): boolean {
  if (isNode(test) && test.type === 'UnaryExpression' && test.operator === '!') {
    return endpointKeyOf(test.argument) === key;
  }
  if (!isNode(test) || test.type !== 'BinaryExpression') return false;
  if (test.operator !== '==' && test.operator !== '===') return false;
  return (
    (endpointKeyOf(test.left) === key && isNullish(test.right)) ||
    (endpointKeyOf(test.right) === key && isNullish(test.left))
  );
}

/** Every endpoint key mentioned inside one expression. */
function keysIn(expression: unknown): string[] {
  const keys: string[] = [];
  walk(expression, (node) => {
    const key = endpointKeyOf(node);
    if (key !== null) keys.push(key);
  });
  return keys;
}

/**
 * Why a rendering position can never be reached, or `null` when it can.
 *
 * The three shapes are the ones a panel actually gets wrong; each is a guard
 * that contradicts the reason it is guarding. The message says which, because
 * the fix differs: a literal guard is a leftover, and a guard on the same key
 * is a condition that was written the wrong way round.
 */
function unreachableReason(ancestors: readonly Ancestor[], key: string): string | null {
  for (const { node, field } of ancestors) {
    if (node.type === 'ConditionalExpression') {
      // `x ? <ReadFailure reason={x} /> : …` is fine; `!x ? …` is not.
      if (field === 'consequent' && assertsAbsent(node.test, key)) {
        return 'it is the branch taken when the read did not fail';
      }
      if (field === 'alternate' && assertsPresent(node.test, key)) {
        return 'it is the branch taken when the read did not fail';
      }
      continue;
    }
    if (node.type === 'LogicalExpression' && field === 'right') {
      if (node.operator === '&&' && (assertsAbsent(node.left, key) || isFalsyLiteral(node.left))) {
        return 'the guard in front of it is false whenever the reason exists';
      }
      if (node.operator === '||' && assertsPresent(node.left, key)) {
        return 'the guard in front of it is true whenever the reason exists';
      }
    }
  }
  return null;
}

/** Collects the identifiers and endpoint keys inside one rendering expression. */
function collectShown(expression: unknown, into: FileAnalysis): void {
  walk(expression, (node) => {
    const key = endpointKeyOf(node);
    if (key !== null) into.shownKeys.add(key);
    if (node.type === 'Identifier') {
      const name = nameOf(node);
      if (name !== null) into.shownNames.add(name);
    }
  });
}

/** Reads one renderer source and reports where the reasons reach the screen. */
function analyse(file: string, source: string): FileAnalysis {
  const analysis: FileAnalysis = {
    shownKeys: new Set(),
    shownNames: new Set(),
    namedKeys: new Map(),
    problems: [],
  };
  const program = parse(source, {
    jsx: file.endsWith('.tsx'),
    range: false,
    loc: false,
    filePath: file,
  });

  /** Keys already reported as unreachable in this file (a `reason=` is visited twice). */
  const reported = new Set<string>();

  /** Records a rendering position that no run of the app can reach. */
  const checkReachable = (expression: unknown, ancestors: readonly Ancestor[]): void => {
    for (const key of keysIn(expression)) {
      if (reported.has(key)) continue;
      const reason = unreachableReason(ancestors, key);
      if (reason === null) continue;
      reported.add(key);
      analysis.problems.push(
        `${file}: endpointErrors.${key} is drawn in a branch that cannot be taken — ${reason}`,
      );
    }
  };

  walkWithAncestors(program, (node, ancestors) => {
    // `reason={…}` — the ReadFailure prop. Its sibling `label=` is required:
    // the component's signature makes a bare reason unspellable, so a JSX
    // site that drops the label is the same defect one level out.
    if (node.type === 'JSXAttribute' && nameOf(node.name) === 'reason') {
      const value = node.value;
      if (isNode(value) && value.type === 'JSXExpressionContainer') {
        collectShown(value.expression, analysis);
        checkReachable(value.expression, ancestors);
      }
      return;
    }

    // `{…}` as a JSX child: whatever it evaluates to is on screen.
    if (node.type === 'JSXExpressionContainer') {
      collectShown(node.expression, analysis);
      checkReachable(node.expression, ancestors);
      return;
    }

    // `x ? … : …` and `x && …` — the reason gates a branch.
    if (node.type === 'ConditionalExpression') {
      collectShown(node.test, analysis);
      return;
    }
    if (node.type === 'LogicalExpression') {
      collectShown(node.left, analysis);
      return;
    }

    // `const failure = data.endpointErrors.x` — named once, shown later.
    if (node.type === 'VariableDeclarator') {
      const key = endpointKeyOf(node.init);
      if (key === null) return;
      const name = nameOf(node.id);
      if (name === null) return;
      const names = analysis.namedKeys.get(key) ?? new Set<string>();
      names.add(name);
      analysis.namedKeys.set(key, names);
    }
  });

  // A `reason=` with no `label=` in the same element: `ReadFailure` would not
  // compile, but a hand-written `<div>{reason}</div>` would, and it would drop
  // the half that says *what* could not be read.
  walk(program, (node) => {
    if (node.type !== 'JSXOpeningElement') return;
    const attributes = node.attributes;
    if (!Array.isArray(attributes)) return;
    const names = attributes
      .filter(isNode)
      .filter((attribute) => attribute.type === 'JSXAttribute')
      .map((attribute) => nameOf(attribute.name));
    if (names.includes('reason') && !names.includes('label')) {
      analysis.problems.push(`${file}: a reason= without a label=, so the reader is not told what failed`);
    }
  });

  return analysis;
}

/**
 * Every key whose reason never reaches a rendering position.
 *
 * Reported per key rather than as one "mismatch", because the fix is per key:
 * a key with no reference at all needs a panel, and a key read into a variable
 * nobody shows needs the panel it already has to use it.
 */
function unshownKeys(keys: readonly string[], sources: ReadonlyMap<string, string>): string[] {
  const analyses = [...sources].map(([file, source]) => [file, analyse(file, source)] as const);
  const problems: string[] = [];
  for (const [, analysis] of analyses) problems.push(...analysis.problems);

  for (const key of keys) {
    const shown = analyses.some(([, analysis]) => {
      if (analysis.shownKeys.has(key)) return true;
      const names = analysis.namedKeys.get(key);
      if (!names) return false;
      return [...names].some((name) => analysis.shownNames.has(name));
    });
    if (shown) continue;

    const referenced = analyses
      .filter(([, analysis]) => analysis.namedKeys.has(key))
      .map(([file]) => file);
    problems.push(
      referenced.length === 0
        ? `endpointErrors.${key}: no panel reads it, so a failed read renders as an empty one`
        : `endpointErrors.${key}: read in ${referenced.join(', ')} but never shown — ` +
          'the reason is recorded and the panel still says "there is nothing there"',
    );
  }
  return problems;
}

// ---------------------------------------------------------------------------
// The repository
// ---------------------------------------------------------------------------

const read = (relativePath: string): string =>
  readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');

/** Every `.ts`/`.tsx` under the renderer tree, minus the file that produces the reasons. */
function rendererSources(): Map<string, string> {
  const sources = new Map<string, string>();
  const visit = (relativeDir: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(path.join(REPO_ROOT, relativeDir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = `${relativeDir}/${entry.name}`;
      if (entry.isDirectory()) {
        visit(relative);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name)) continue;
      if (relative === PRODUCER) continue;
      sources.set(relative, read(relative));
    }
  };
  visit(RENDERER_ROOT);
  return sources;
}

const KEYS = unionMembers(read(PRODUCER), UNION_NAME);
const SOURCES = rendererSources();

describe('every guarded read has a panel that says why it failed', () => {
  it('finds the key set in the file that produces the reasons', () => {
    // Without this, an emptied union would make every case below pass over
    // nothing at all.
    expect(KEYS.length, `${PRODUCER} no longer declares ${UNION_NAME}`).toBeGreaterThan(0);
    expect(new Set(KEYS).size, 'a duplicate key in the union').toBe(KEYS.length);
    // The union and the guarded reads are the same set: a key that is guarded
    // but not in the union would not type-check, and a key in the union that
    // nothing guards is a panel waiting for a reason that never arrives.
    expect([...guardedKeys(read(PRODUCER))].sort()).toEqual([...KEYS].sort());
  });

  it('shows the reason for every key', () => {
    const problems = unshownKeys(KEYS, SOURCES);
    expect(
      problems,
      `a failed read would render as an empty one:\n  ${problems.join('\n  ')}`,
    ).toEqual([]);
  });

  it('is not vacuous: the panels really carry the reasons being looked for', () => {
    // The scan reads the real tree, not an empty map: `sessions` is shown in
    // two places (the rail and the chat region) and `diagnostics` in two (the
    // panel and the status bar), which is the shape the checks above rely on.
    expect(SOURCES.size, 'the renderer tree was not read').toBeGreaterThan(10);
    const sessions = [...SOURCES].filter(([, source]) => source.includes('endpointErrors.sessions'));
    expect(sessions.length, 'no file reads endpointErrors.sessions').toBeGreaterThan(1);
    expect(SOURCES.has('apps/desktop/src/renderer/src/components/ReadFailure.tsx')).toBe(true);
  });
});

describe('the check above, when a panel stops showing the reason', () => {
  const panel = (body: string): Map<string, string> =>
    new Map([['apps/desktop/src/renderer/src/components/Panel.tsx', body]]);

  it('reports a key no panel reads at all', () => {
    // The regression this file exists for: a seventh guarded read is added to
    // `hooks.ts`, the type is satisfied, and no panel ever looks at the reason.
    const problems = unshownKeys(['tools'], panel('export const x = 1;'));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('no panel reads it');
  });

  it('reports a key read into a variable nobody shows', () => {
    // The subtler one: the panel *looks* wired — it destructures the reason —
    // and then renders the empty state anyway.
    const problems = unshownKeys(
      ['usage'],
      panel(`
        export function UsagePanel({ data }: { data: AppData }) {
          const failure = data.endpointErrors.usage;
          return <div className="empty">no usage recorded yet</div>;
        }
      `),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('never shown');
  });

  it('accepts a reason passed to ReadFailure', () => {
    const problems = unshownKeys(
      ['usage'],
      panel(`
        export function UsagePanel({ data }: { data: AppData }) {
          return <ReadFailure label={t('usage.loadFailed')} reason={data.endpointErrors.usage} />;
        }
      `),
    );
    expect(problems).toEqual([]);
  });

  it('accepts a reason that gates a branch', () => {
    const problems = unshownKeys(
      ['sessions'],
      panel(`
        export function Rail({ data }: { data: AppData }) {
          return data.endpointErrors.sessions ? <div>{data.endpointErrors.sessions}</div> : null;
        }
      `),
    );
    expect(problems).toEqual([]);
  });

  it('accepts a reason named once and shown later', () => {
    const problems = unshownKeys(
      ['diagnostics'],
      panel(`
        export function Diagnostics({ data }: { data: AppData }) {
          const failure = data.endpointErrors.diagnostics;
          return failure ? <ReadFailure label={t('diagnostics.loadFailed')} reason={failure} /> : null;
        }
      `),
    );
    expect(problems).toEqual([]);
  });

  it('reports a reason= that dropped its label=', () => {
    const problems = unshownKeys(
      ['tools'],
      panel(`
        export function Tools({ data }: { data: AppData }) {
          return <ReadFailure reason={data.endpointErrors.tools} />;
        }
      `),
    );
    // The reason is on screen, so the key itself is fine; the label is not.
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('without a label=');
  });

  it('accepts a reason printed as a JSX child', () => {
    // The rail's shape: a heading, then the reason underneath it.
    const problems = unshownKeys(
      ['sessions'],
      panel(`
        export function Rail({ data }: { data: AppData }) {
          return (
            <div className="rail-note">
              {t('sessions.loadFailed')}
              <div className="rail-note-detail">{data.endpointErrors.sessions}</div>
            </div>
          );
        }
      `),
    );
    expect(problems).toEqual([]);
  });

  it('reports a key added to the union with no panel', () => {
    // The direction that matters for the next change: the union is the input,
    // so a new member is a red run until a panel shows it.
    const union = `
      type EndpointKey = 'sessions' | 'tools' | 'mcpServers';
    `;
    const keys = unionMembers(union, 'EndpointKey');
    expect(keys).toEqual(['sessions', 'tools', 'mcpServers']);
    const problems = unshownKeys(
      keys,
      panel(`
        export function Panel({ data }: { data: AppData }) {
          return <ReadFailure label="x" reason={data.endpointErrors.sessions} />;
        }
      `),
    );
    expect(problems.map((problem) => problem.split(':')[0])).toEqual([
      'endpointErrors.tools',
      'endpointErrors.mcpServers',
    ]);
  });

  it('reads the guarded keys out of the producer, not out of the union', () => {
    // The two are compared above; this pins that the extractor sees the real
    // call shape rather than matching nothing and returning `[]`.
    const keys = guardedKeys(`
      const a = await guarded('providers', () => api.intelligence.listProviders(), []);
      const b = await guarded('sessions', () => api.sessions.list(id), []);
    `);
    expect(keys).toEqual(['providers', 'sessions']);
  });
});

describe('the check above, when the reason is drawn where nothing can reach it', () => {
  const panel = (body: string): Map<string, string> =>
    new Map([['apps/desktop/src/renderer/src/components/Panel.tsx', body]]);

  it('reports a reason behind a literal that is never true', () => {
    // The shape a half-finished panel leaves behind: the wiring is right, the
    // guard in front of it is a leftover. Every other check in this file passes
    // — the key is in a `reason=`, the `label=` is there — and the reader is
    // told nothing, forever.
    const problems = unshownKeys(
      ['tools'],
      panel(`
        export function Tools({ data }: { data: AppData }) {
          return <div>{false && <ReadFailure label="tools" reason={data.endpointErrors.tools} />}</div>;
        }
      `),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('endpointErrors.tools is drawn in a branch that cannot be taken');
    expect(problems[0]).toContain('the guard in front of it is false whenever the reason exists');
  });

  it('reports a reason guarded by the absence of the reason itself', () => {
    // One keystroke from the correct shape: `x && …` became `!x && …`, so the
    // panel draws the failure exactly when there is no failure.
    const problems = unshownKeys(
      ['tools'],
      panel(`
        export function Tools({ data }: { data: AppData }) {
          return <div>{!data.endpointErrors.tools && <ReadFailure label="tools" reason={data.endpointErrors.tools} />}</div>;
        }
      `),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('endpointErrors.tools is drawn in a branch that cannot be taken');
  });

  it('reports a reason drawn in the branch that means "the read worked"', () => {
    // The same mistake written as a ternary, which is how the panels actually
    // spell it: the reason is in the `null` half.
    const problems = unshownKeys(
      ['sessions'],
      panel(`
        export function Rail({ data }: { data: AppData }) {
          return data.endpointErrors.sessions ? null : <ReadFailure label="sessions" reason={data.endpointErrors.sessions} />;
        }
      `),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('it is the branch taken when the read did not fail');
  });

  it('reports a reason behind an `=== undefined` guard', () => {
    // The explicit spelling of the same contradiction, which a type-narrowing
    // refactor produces: the guard says "there is no reason" and the branch
    // draws the reason.
    const problems = unshownKeys(
      ['usage'],
      panel(`
        export function Usage({ data }: { data: AppData }) {
          return data.endpointErrors.usage === undefined
            ? <ReadFailure label="usage" reason={data.endpointErrors.usage} />
            : null;
        }
      `),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('endpointErrors.usage is drawn in a branch that cannot be taken');
  });

  it('accepts the three reachable shapes the panels use', () => {
    // The control for the four cases above: the same keys, guarded the right
    // way round. A gate that reported these would be red over the real tree.
    expect(
      unshownKeys(
        ['tools'],
        panel(`
          export function Tools({ data }: { data: AppData }) {
            return <div>{data.endpointErrors.tools && <ReadFailure label="tools" reason={data.endpointErrors.tools} />}</div>;
          }
        `),
      ),
    ).toEqual([]);
    expect(
      unshownKeys(
        ['sessions'],
        panel(`
          export function Rail({ data }: { data: AppData }) {
            return data.endpointErrors.sessions ? <ReadFailure label="sessions" reason={data.endpointErrors.sessions} /> : null;
          }
        `),
      ),
    ).toEqual([]);
    expect(
      unshownKeys(
        ['usage'],
        panel(`
          export function Usage({ data }: { data: AppData }) {
            return data.endpointErrors.usage !== undefined
              ? <ReadFailure label="usage" reason={data.endpointErrors.usage} />
              : null;
          }
        `),
      ),
    ).toEqual([]);
  });

  it('does not judge a guard about something else', () => {
    // The boundary the header states: `data.loading` around a reason is not
    // this file's question, because whether `loading` can be true while a
    // reason exists is a fact about `hooks.ts`. A gate that guessed would be
    // red over a correct panel.
    expect(
      unshownKeys(
        ['tools'],
        panel(`
          export function Tools({ data }: { data: AppData }) {
            return data.loading ? <div>loading</div> : <ReadFailure label="tools" reason={data.endpointErrors.tools} />;
          }
        `),
      ),
    ).toEqual([]);
  });
});
