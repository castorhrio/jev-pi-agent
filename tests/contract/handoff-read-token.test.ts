/**
 * The handoff read token is bumped during render, before any effect can run.
 *
 * ## Why this is a gate rather than a comment
 *
 * `App.tsx` identifies the selected session with two refs. `handoffSession`
 * says which session the panel shows; `handoffReadToken` is the claim an
 * in-flight `listHandoffs` read must still hold when it resolves. A session
 * switch has to invalidate that claim *before* a promise continuation for the
 * new session can observe it, and the only place guaranteed to run first is
 * the render body — effects run after commit, and callbacks run whenever they
 * are called.
 *
 * So the increment sits in `if (handoffSession.current !== sessionId)` in the
 * body of the component that owns the handoff state (`Shell` today), outside
 * every `useEffect`/`useCallback`. That is an implicit contract: moving those
 * four lines into an effect (a plausible "clean up render-time writes"
 * refactor) leaves the code compiling and most tests green, while a read that
 * started under the previous session can now land in the next one's panel. The
 * failure is an intermittent cross-session leak, the class of bug a reviewer is
 * least likely to notice.
 *
 * The scan reads the TypeScript AST rather than text, so a comment or a string
 * that spells the increment cannot satisfy it, and the line number is the real
 * one. It is deliberately local to this gate (not a `-scan.ts` module): one
 * pattern, one file, one question.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as ts from 'typescript';

const APP = join(
  import.meta.dirname,
  '..',
  '..',
  'apps',
  'desktop',
  'src',
  'renderer',
  'src',
  'App.tsx',
);
const TOKEN_REF = 'handoffReadToken';
const GUARD = 'handoffSession.current !== sessionId';

interface Increment {
  /** 1-based, the way a failure should name it */
  readonly line: number;
  /** the nearest enclosing function, for a failure message */
  readonly owner: string;
  /**
   * true only when the nearest function is a top-level component declaration —
   * `function Shell()` or `const Shell = () => …`, both at module scope (see
   * `isTopLevelComponent`). The component's name is not pinned: `Shell` owns
   * the handoff state today, and a rename should not need a test edit. `owner`
   * is here to make a failure readable (and to show the *fixture's* name was
   * read from the fixture), not to assert what the real component is called.
   */
  readonly inRenderBody: boolean;
  /** the condition of the nearest enclosing `if`, or `null` */
  readonly guard: string | null;
}

/**
 * Whether `owner` is a component declared at module scope.
 *
 * Two spellings, and they are the same component:
 *
 * ```ts
 * function Shell(): JSX.Element { … }
 * const Shell = (): JSX.Element => { … };
 * ```
 *
 * The first was the only one this gate accepted, which made the arrow-function
 * conversion a *silent* regression: the bump was still in the render body, the
 * gate still compiled, and every bump was classified `inRenderBody: false` —
 * so `never bumps it inside an effect` went red with a message that blamed an
 * effect, and `bumps it when the session changes` failed with "found 0". The
 * failure pointed at the wrong refactor, which is worse than no gate at all.
 *
 * A function *expression* assigned to a `const` is accepted for the same
 * reason: it is the third mechanical spelling of the same declaration, and
 * refusing it would reintroduce the same false alarm. What stays refused is
 * everything that is not module scope — a nested `function` inside `Shell`
 * (the exact shape of the "move it into a helper" refactor), a method, and a
 * callback — which is the classification that carries the real signal.
 */
function isTopLevelComponent(owner: ts.Node): boolean {
  if (ts.isFunctionDeclaration(owner)) return ts.isSourceFile(owner.parent);
  if (!ts.isArrowFunction(owner) && !ts.isFunctionExpression(owner)) return false;
  // The chain is `VariableDeclaration` ← `VariableDeclarationList` ←
  // `VariableStatement` ← `SourceFile`. The statement node is easy to forget
  // (this helper's first version did, and every arrow component then read as
  // "not a render body" — the exact silent regression the case below pins), so
  // it is spelled out rather than skipped through `parent.parent.parent`.
  const declaration = owner.parent;
  if (!ts.isVariableDeclaration(declaration)) return false;
  const list = declaration.parent;
  if (!ts.isVariableDeclarationList(list)) return false;
  const statement = list.parent;
  return ts.isVariableStatement(statement) && ts.isSourceFile(statement.parent);
}

function ownerName(owner: ts.Node): string {
  if (ts.isFunctionDeclaration(owner) || ts.isMethodDeclaration(owner)) {
    return owner.name?.getText() ?? '(anonymous)';
  }
  if (ts.isFunctionExpression(owner) || ts.isArrowFunction(owner)) {
    // A function expression may be named (`const X = function inner() {}`), but
    // the name a failure should print is the one the component is declared
    // under: `inner` is invisible to every reader of the file.
    if (owner.name !== undefined) return owner.name.getText();
    if (ts.isVariableDeclaration(owner.parent)) return owner.parent.name.getText();
    if (ts.isCallExpression(owner.parent)) return `${owner.parent.expression.getText()} callback`;
  }
  return '(unknown)';
}

function enclosingFunction(node: ts.Node): ts.Node | null {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isFunctionLike(current)) return current;
  }
  return null;
}

function enclosingGuard(node: ts.Node): string | null {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isFunctionLike(current)) return null;
    if (ts.isIfStatement(current)) return current.expression.getText();
  }
  return null;
}

/**
 * Every `handoffReadToken.current += 1` in `source`, with its enclosing
 * function and guard.
 *
 * The `+=` operator is checked explicitly so a plain assignment
 * (`handoffReadToken.current = token` in `refreshHandoffHistory`) is not
 * counted as the session-switch bump.
 */
function increments(source: string, fileName = 'App.tsx'): Increment[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: Increment[] = [];

  const visit = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      node.left.expression.getText(file) === TOKEN_REF &&
      node.left.name.text === 'current'
    ) {
      const owner = enclosingFunction(node);
      found.push({
        line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
        owner: owner === null ? '(top level)' : ownerName(owner),
        inRenderBody: owner !== null && isTopLevelComponent(owner),
        guard: enclosingGuard(node),
      });
    }
    ts.forEachChild(node, visit);
  };

  visit(file);
  return found;
}

describe('the handoff read token is bumped in the render body', () => {
  const found = increments(readFileSync(APP, 'utf8'), 'App.tsx');

  it('finds the bump at all, so an empty scan is not a green scan', () => {
    expect(
      found.length,
      `no ${TOKEN_REF}.current += 1 was found in App.tsx. If the bump moved into a hook ` +
        '(e.g. `useHandoffSession`), this gate no longer looks at it: the guarantee is about ' +
        'running in the render body of the component that owns the state, so move the scan to ' +
        'that module rather than deleting this case.',
    ).toBeGreaterThan(0);
  });

  it('never bumps it inside an effect or a callback', () => {
    const misplaced = found.filter((entry) => !entry.inRenderBody);
    expect(
      misplaced,
      `these bumps run after render, where a session switch can be observed first:\n  ${misplaced
        .map((entry) => `App.tsx:${entry.line} in ${entry.owner}`)
        .join('\n  ')}`,
    ).toEqual([]);
  });

  it('bumps it when the session changes, and nowhere else', () => {
    const renderBumps = found.filter((entry) => entry.inRenderBody);
    // The owner is printed, not asserted by name: `Shell` owns the handoff
    // state today, and a rename of the component should not need a test edit.
    // What is asserted is the count — a second render-time bump would
    // invalidate the claim held by a read this one did not start — and the
    // guard, so the sole bump is the session switch.
    const where = renderBumps
      .map((entry) => `App.tsx:${entry.line} in ${entry.owner}`)
      .join(', ');
    expect(
      renderBumps.length,
      `the render body must bump the token exactly once; found ${renderBumps.length}` +
        (renderBumps.length === 0
          ? `. If the bump moved into a hook, move this gate to that module — do not widen ` +
            '`inRenderBody` until the bump no longer sits in a render body.'
          : ` (${where})`),
    ).toBe(1);
    expect(renderBumps[0]?.guard, 'the bump is no longer guarded by a session change').toBe(
      GUARD,
    );
  });
});

/**
 * Fixtures, so the gate can go red.
 *
 * The first fixture is the accepted shape. The second is the refactor this
 * gate exists to refuse: the identical bump inside `useCallback` and
 * `useEffect`, which compiles and reads like the same code. The third is a
 * render-body bump with no session guard — it would invalidate every in-flight
 * read on every render. The last pins that the plain assignment in
 * `refreshHandoffHistory` is not mistaken for the bump.
 */
describe('the token scan can fail', () => {
  it('counts the render-body bump and reads its guard', () => {
    // The fixture's component is deliberately *not* named `App`: the owner a
    // failure prints has to be the declaration the AST found, not a constant
    // this file carries, and the real component's name is not a fact worth
    // pinning (see `Increment.owner`).
    const result = increments(
      [
        'export function FixtureOwner(): JSX.Element {',
        '  const handoffSession = useRef(sessionId);',
        '  const handoffReadToken = useRef(0);',
        '  if (handoffSession.current !== sessionId) {',
        '    handoffSession.current = sessionId;',
        '    handoffReadToken.current += 1;',
        '  }',
        '  return null;',
        '}',
      ].join('\n'),
    );

    expect(result).toHaveLength(1);
    expect(result[0]?.line).toBe(6);
    expect(result[0]?.owner).toBe('FixtureOwner');
    expect(result[0]?.inRenderBody).toBe(true);
    expect(result[0]?.guard).toBe(GUARD);
  });

  it('reads a component written as a top-level arrow function', () => {
    // The same mount, mechanically rewritten as `const FixtureOwner = () => …`.
    // This was the gate's blind spot: every bump inside an arrow component was
    // classified as *not* a render body, so the conversion failed the gate with
    // a message about effects and a count of zero. A refactor that changes no
    // behaviour must not change the verdict.
    const fixture = [
      'export const FixtureOwner = (): JSX.Element => {',
      '  const handoffSession = useRef(sessionId);',
      '  const handoffReadToken = useRef(0);',
      '  if (handoffSession.current !== sessionId) {',
      '    handoffSession.current = sessionId;',
      '    handoffReadToken.current += 1;',
      '  }',
      '  return null;',
      '};',
    ].join('\n');
    const result = increments(fixture);

    expect(result).toHaveLength(1);
    expect(result[0]?.line).toBe(6);
    expect(result[0]?.owner).toBe('FixtureOwner');
    expect(result[0]?.inRenderBody).toBe(true);
    expect(result[0]?.guard).toBe(GUARD);
    // The function-expression spelling is the same declaration shape
    // (`const X = function () {…}`), so it gets the same answer rather than a
    // third rule somebody has to remember.
    expect(
      increments(fixture.replace('= (): JSX.Element => {', '= function (): JSX.Element {')).map(
        (entry) => [entry.owner, entry.inRenderBody],
      ),
    ).toEqual([['FixtureOwner', true]]);
  });

  it('does not treat a nested arrow function as the component body', () => {
    // The reason the arrow-function rule is about *where the declaration is*,
    // not merely what it is: moving the bump into `const bump = () => …` inside
    // the component is exactly the "clean up render-time writes" refactor this
    // gate exists to refuse, and it must stay refused.
    const result = increments(
      [
        'export const FixtureOwner = (): JSX.Element => {',
        '  const handoffSession = useRef(sessionId);',
        '  const handoffReadToken = useRef(0);',
        '  const bump = (): void => {',
        '    if (handoffSession.current !== sessionId) {',
        '      handoffReadToken.current += 1;',
        '    }',
        '  };',
        '  bump();',
        '  return null;',
        '};',
      ].join('\n'),
    );

    expect(result.map((entry) => [entry.owner, entry.inRenderBody])).toEqual([['bump', false]]);
  });

  it('sees a bump hidden in a callback, which is the bug', () => {
    const result = increments(
      [
        'export function App(): JSX.Element {',
        '  const handoffReadToken = useRef(0);',
        '  const refresh = useCallback(() => {',
        '    handoffReadToken.current += 1;',
        '  }, []);',
        '  useEffect(() => {',
        '    handoffReadToken.current += 1;',
        '  }, []);',
        '  return null;',
        '}',
      ].join('\n'),
    );

    expect(result.map((entry) => entry.owner)).toEqual([
      'useCallback callback',
      'useEffect callback',
    ]);
    expect(result.map((entry) => entry.inRenderBody)).toEqual([false, false]);
  });

  it('sees an unguarded render-body bump', () => {
    const result = increments(
      [
        'export function App(): JSX.Element {',
        '  const handoffReadToken = useRef(0);',
        '    handoffReadToken.current += 1;',
        '  return null;',
        '}',
      ].join('\n'),
    );

    expect(result).toHaveLength(1);
    expect(result[0]?.inRenderBody).toBe(true);
    expect(result[0]?.guard).toBeNull();
  });

  it('does not count the token assignment used to claim a read', () => {
    const result = increments(
      [
        'export function App(): JSX.Element {',
        '  const handoffReadToken = useRef(0);',
        '  function refresh(): void {',
        '    const token = handoffReadToken.current + 1;',
        '    handoffReadToken.current = token;',
        '  }',
        '  return null;',
        '}',
      ].join('\n'),
    );

    expect(result).toEqual([]);
  });
});
