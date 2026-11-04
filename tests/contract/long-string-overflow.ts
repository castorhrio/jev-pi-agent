/**
 * The scan behind `long-string-overflow.test.ts`: which boxes hold a string
 * whose length this repository does not decide, and does that box wrap it.
 *
 * ## Why this is a module and not a regex in the test
 *
 * The defect it exists for was found by measuring, not by reading: at 768×700 a
 * failure reason of 200 characters with no break opportunity (a Windows path)
 * made `.notice.error`'s `scrollWidth` 1562px inside a 429px box, and the whole
 * window grew a horizontal scrollbar. The fix was two `overflow-wrap: anywhere`
 * declarations — and two declarations is a sample, not a rule. The strings that
 * reach the screen are not written here: they are IPC errors, stores that could
 * not be opened, paths that do not exist. Chinese wraps anywhere, so the
 * fixture's own reasons never showed the problem; the next one will not be
 * Chinese either.
 *
 * So the question is asked of the *source*: every place a downstream string is
 * put into a JSX text node, and whether the box that holds it declares a
 * wrapping rule. That is a taint question, and a regex cannot answer it —
 * `{reason}` and `{t('x', { reason })}` and `{fatal}` after
 * `setFatal(describeError(e))` are the same fact three spellings apart.
 *
 * ## What counts as a downstream string
 *
 * A value whose length is decided outside this repository:
 *
 *  - `describeError(…)` — the one place a caught value becomes a sentence;
 *  - a member named `message` / `reason` / `stack` / `detail` / `fatal` — the
 *    fields an error, a rejection or a status object carries;
 *  - anything reached through `endpointErrors` — the reasons a read failed;
 *  - a local function whose `return` is one of the above (`errorMessage()` in
 *    two panels), because a helper is not a laundering step;
 *  - a template literal, a `+`, a `??`, a `? :` or a `t(…)` call with one of
 *    the above inside it — the sentence is still the string's length.
 *
 * Taint is then carried through `const x = …` and through `setX(…)` for a
 * `useState` pair, and across files through props: `<ReadFailure reason={…} />`
 * makes `reason` a downstream string inside `ReadFailure`.
 *
 * ## What counts as protected
 *
 * `overflow-wrap` is an inherited property, so a declaration on any ancestor
 * protects the text below it. The scan therefore walks the JSX ancestor chain
 * (and matches the stylesheet's selectors against it) and asks whether *any*
 * box on the way up declares `overflow-wrap: anywhere` / `break-word` /
 * `word-break: break-word` / `break-all`, or carries the same thing inline.
 *
 * The two roots are excluded on purpose. `overflow-wrap: anywhere` on `.app`
 * would make every site below pass and the gate would assert nothing — the
 * blanket fix is the one thing this file must not accept, so it is a failure
 * with its own message rather than a quiet pass.
 *
 * ## What it deliberately does not do
 *
 * It does not measure. Whether `anywhere` is enough at 768px is the layout
 * gate's question, and it is answered in a real Chromium with a real 200-
 * character reason. This file answers the other half: that the rule is *there*
 * at every site, including the ones nobody has measured yet.
 */

import { parse } from '@typescript-eslint/typescript-estree';

// ---------------------------------------------------------------------------
// A minimal AST walk (the same shape `endpoint-failures.test.ts` uses)
// ---------------------------------------------------------------------------

/** A parser node, read structurally: this file needs a handful of node types. */
export interface Node {
  readonly type: string;
  readonly [field: string]: unknown;
}

export const isNode = (value: unknown): value is Node =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { type?: unknown }).type === 'string';

/** A node on the path from the root, and the field of its parent it came through. */
export interface Ancestor {
  readonly node: Node;
  readonly field: string;
}

/** `walk`, but carrying the path. */
export function walkWithAncestors(
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
    // `parent` is a back-edge (infinite), `loc`/`range` are positions.
    if (field === 'parent' || field === 'loc' || field === 'range') continue;
    ancestors.push({ node: value, field });
    walkWithAncestors(child, visit, ancestors);
    ancestors.pop();
  }
}

/** Visits every node under `value`. */
export function walk(value: unknown, visit: (node: Node) => void): void {
  walkWithAncestors(value, (node) => visit(node));
}

const nameOf = (node: unknown): string | null => {
  if (!isNode(node)) return null;
  const name = node.name;
  return typeof name === 'string' ? name : null;
};

// ---------------------------------------------------------------------------
// The stylesheet, as selectors this scan can match
// ---------------------------------------------------------------------------

/** One compound selector: an optional tag and the classes it requires. */
export interface Compound {
  readonly tag: string | null;
  readonly classes: readonly string[];
}

/** One rule, with its selector list already split. */
export interface CssRule {
  readonly selector: string;
  readonly parts: readonly Compound[] | null;
  readonly declarations: ReadonlyMap<string, string>;
}

/** The properties that decide whether a long token can be broken. */
const WRAP_PROPERTIES = ['overflow-wrap', 'word-wrap', 'word-break'] as const;

/** The values of those properties that actually allow a break inside a token. */
const WRAPPING_VALUES = new Set(['anywhere', 'break-word', 'break-all']);

/** Whether a declaration map asks for a break inside a long token. */
export function declaresWrapping(declarations: ReadonlyMap<string, string>): boolean {
  for (const property of WRAP_PROPERTIES) {
    const value = declarations.get(property);
    if (value !== undefined && WRAPPING_VALUES.has(value.trim().toLowerCase())) return true;
  }
  return false;
}

/**
 * A selector, as compounds, or `null` when this scan cannot read it.
 *
 * `null` is not "no match": a wrapping declaration inside a selector this file
 * cannot read would be a rule that protects a box the gate then reports as
 * unprotected, or worse, one it silently credits. The test asserts that no
 * wrapping declaration lives in such a selector, so the limit is a red gate
 * rather than a blind spot.
 */
export function parseSelector(selector: string): Compound[] | null {
  // Combinators other than the descendant space, pseudo-classes, attribute
  // selectors, ids and the universal selector are all outside what this needs.
  if (/[>+~:[\]*#()]/.test(selector)) return null;
  const parts: Compound[] = [];
  for (const raw of selector.trim().split(/\s+/)) {
    const match = /^([a-zA-Z][a-zA-Z0-9-]*)?((?:\.[a-zA-Z0-9_-]+)*)$/.exec(raw);
    if (match === null) return null;
    const tag = match[1] ?? null;
    const classes = (match[2] ?? '').split('.').filter((c) => c.length > 0);
    if (tag === null && classes.length === 0) return null;
    parts.push({ tag, classes });
  }
  return parts.length > 0 ? parts : null;
}

/** Splits a stylesheet into rules, flattening `@media` / `@supports` blocks. */
export function parseCss(css: string): CssRule[] {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: CssRule[] = [];

  const readBlock = (text: string): void => {
    let i = 0;
    while (i < text.length) {
      const open = text.indexOf('{', i);
      if (open === -1) break;
      const prelude = text.slice(i, open).trim();
      let depth = 1;
      let j = open + 1;
      while (j < text.length && depth > 0) {
        if (text[j] === '{') depth += 1;
        else if (text[j] === '}') depth -= 1;
        j += 1;
      }
      const body = text.slice(open + 1, j - 1);
      if (prelude.startsWith('@')) {
        // `@media` / `@supports` / `@layer` wrap ordinary rules; `@keyframes`
        // and `@font-face` do not, and their bodies are not selectors.
        if (/^@(media|supports|layer|container)\b/.test(prelude)) readBlock(body);
      } else {
        const declarations = new Map<string, string>();
        for (const declaration of body.split(';')) {
          const colon = declaration.indexOf(':');
          if (colon === -1) continue;
          const property = declaration.slice(0, colon).trim().toLowerCase();
          const value = declaration.slice(colon + 1).trim();
          if (property.length > 0) declarations.set(property, value);
        }
        for (const selector of prelude.split(',')) {
          const trimmed = selector.trim().replace(/\s+/g, ' ');
          if (trimmed.length === 0) continue;
          rules.push({ selector: trimmed, parts: parseSelector(trimmed), declarations });
        }
      }
      i = j;
    }
  };

  readBlock(withoutComments);
  return rules;
}

// ---------------------------------------------------------------------------
// An element on the way up from a render site
// ---------------------------------------------------------------------------

/** One JSX element, as the stylesheet would see it. */
export interface ElementRef {
  /** Lower-case tag name, or the component name for a capitalised tag. */
  readonly tag: string;
  readonly classes: readonly string[];
  /** `style={{ overflowWrap: 'anywhere' }}` — the inline spelling of the rule. */
  readonly inlineWrap: boolean;
  /** How the element was written, for the failure message. */
  readonly written: string;
}

/** Whether a compound selector matches one element. */
function matchesCompound(compound: Compound, element: ElementRef): boolean {
  if (compound.tag !== null && compound.tag.toLowerCase() !== element.tag.toLowerCase()) return false;
  return compound.classes.every((cls) => element.classes.includes(cls));
}

/**
 * Whether a selector matches the element at the end of `chain`.
 *
 * `chain` is outermost-first and ends at the element itself. Descendant
 * combinators are matched greedily from the right, which is what CSS does for
 * the only combinator this stylesheet uses to set wrapping.
 */
export function matchesSelector(parts: readonly Compound[], chain: readonly ElementRef[]): boolean {
  if (chain.length === 0) return false;
  const last = parts[parts.length - 1];
  if (last === undefined) return false;
  if (!matchesCompound(last, chain[chain.length - 1]!)) return false;
  let index = chain.length - 2;
  for (let p = parts.length - 2; p >= 0; p -= 1) {
    let found = false;
    while (index >= 0) {
      const candidate = chain[index]!;
      index -= 1;
      if (matchesCompound(parts[p]!, candidate)) {
        found = true;
        break;
      }
    }
    if (!found) return false;
  }
  return true;
}

/** The classes that are the whole window, where a blanket rule would hide everything. */
const ROOT_CLASSES = new Set(['app', 'root', 'shell']);

/** Whether an element is one of the roots a blanket rule must not be put on. */
export function isRootElement(element: ElementRef): boolean {
  return element.classes.some((cls) => ROOT_CLASSES.has(cls));
}

/** How a box keeps a long token from widening it. */
export interface Protection {
  readonly kind: 'wrap' | 'clip';
  readonly element: ElementRef;
  /** The selector (or inline style) that does it, for the failure message. */
  readonly selector: string;
}

/** Every declaration that applies to `chain[depth - 1]`, later rules winning. */
export function declarationsAt(
  chain: readonly ElementRef[],
  depth: number,
  rules: readonly CssRule[],
): Map<string, string> {
  const out = new Map<string, string>();
  const prefix = chain.slice(0, depth);
  for (const rule of rules) {
    if (rule.parts === null) continue;
    if (!matchesSelector(rule.parts, prefix)) continue;
    for (const [property, value] of rule.declarations) out.set(property, value);
  }
  return out;
}

/** The first selector that gives `chain[depth - 1]` one of `properties`. */
function selectorFor(
  chain: readonly ElementRef[],
  depth: number,
  rules: readonly CssRule[],
  properties: readonly string[],
): string {
  const prefix = chain.slice(0, depth);
  for (const rule of rules) {
    if (rule.parts === null) continue;
    if (!matchesSelector(rule.parts, prefix)) continue;
    if (properties.some((property) => rule.declarations.has(property))) return rule.selector;
  }
  return '(unknown rule)';
}

/** The `overflow` values that clip instead of growing the box. */
const CLIPPING = new Set(['hidden', 'clip']);

/** The `white-space` values under which a clipped box never wraps. */
const NO_WRAP = new Set(['nowrap', 'pre']);

/**
 * The box that keeps `chain`'s text from widening the window, or `null`.
 *
 * Two things count, because the product uses both and both are honest:
 *
 *  - **wrapping** — `overflow-wrap: anywhere` (or `word-break: break-word`),
 *    which is what a sentence of unknown length wants;
 *  - **clipping** — `overflow: hidden` together with `white-space: nowrap`,
 *    which is what a one-line label wants (`.truncate`). The text is cut with
 *    an ellipsis instead of being wrapped, and the box does not grow either.
 *
 * `overflow-wrap` and `white-space` are inherited, so the walk goes outward
 * from the text and stops at the first box that answers.
 */
export function protectionFor(
  chain: readonly ElementRef[],
  rules: readonly CssRule[],
): Protection | null {
  let whiteSpace: string | null = null;
  for (let depth = 1; depth <= chain.length; depth += 1) {
    const element = chain[depth - 1]!;
    const declarations = declarationsAt(chain, depth, rules);
    const own = declarations.get('white-space');
    if (own !== undefined) whiteSpace = own.trim().toLowerCase();

    if (element.inlineWrap) {
      return { kind: 'wrap', element, selector: 'style={{ overflowWrap: … }}' };
    }
    if (declaresWrapping(declarations)) {
      return {
        kind: 'wrap',
        element,
        selector: selectorFor(chain, depth, rules, [...WRAP_PROPERTIES]),
      };
    }
    const overflow = (declarations.get('overflow') ?? declarations.get('overflow-x') ?? '')
      .trim()
      .toLowerCase();
    if (CLIPPING.has(overflow) && whiteSpace !== null && NO_WRAP.has(whiteSpace)) {
      return {
        kind: 'clip',
        element,
        selector: selectorFor(chain, depth, rules, ['overflow', 'overflow-x']),
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Reading one JSX element
// ---------------------------------------------------------------------------

/** The tag of a JSX opening element, or `null` for a namespaced name. */
function tagOf(opening: Node): string | null {
  const name = opening.name;
  if (!isNode(name)) return null;
  if (name.type === 'JSXIdentifier') return nameOf(name);
  if (name.type === 'JSXMemberExpression') {
    const object = name.object;
    const property = name.property;
    const left = isNode(object) ? nameOf(object) : null;
    const right = isNode(property) ? nameOf(property) : null;
    return left !== null && right !== null ? `${left}.${right}` : null;
  }
  return null;
}

const splitClasses = (text: string): string[] => text.split(/\s+/).filter(Boolean);

/**
 * The classes a `className` value applies *whatever* the condition does.
 *
 * `className={`notice ${level === 'error' ? 'error' : 'warn'}`}` is a real
 * element in `ChatLog.tsx`, and reading it as "dynamic, cannot tell" would
 * leave the one box that draws a notice's message outside the gate. What can
 * be said without running the code is the intersection: `notice` is applied on
 * every path, `error` and `warn` are not. The intersection is the sound answer
 * — a class in it is always there — and it is what the matcher is given.
 *
 * `null` means genuinely unknown (a variable, a call), and the caller reports
 * the site rather than guessing.
 */
function classNamesOf(value: unknown): string[] | null {
  if (!isNode(value)) return [];
  if (value.type === 'Literal') {
    return typeof value.value === 'string' ? splitClasses(value.value) : null;
  }
  if (value.type === 'JSXExpressionContainer') return classNamesOf(value.expression);
  if (value.type === 'TemplateLiteral') {
    const quasis = value.quasis;
    const expressions = value.expressions;
    if (!Array.isArray(quasis) || !Array.isArray(expressions)) return null;
    const always = new Set<string>();
    for (const quasi of quasis) {
      const cooked = (quasi as { value?: { cooked?: unknown } }).value?.cooked;
      if (typeof cooked !== 'string') return null;
      for (const cls of splitClasses(cooked)) always.add(cls);
    }
    for (const expression of expressions) {
      const inner = classNamesOf(expression);
      if (inner === null) return null;
      for (const cls of inner) always.add(cls);
    }
    return [...always];
  }
  if (value.type === 'ConditionalExpression') {
    const consequent = classNamesOf(value.consequent);
    const alternate = classNamesOf(value.alternate);
    if (consequent === null || alternate === null) return null;
    return consequent.filter((cls) => alternate.includes(cls));
  }
  if (value.type === 'LogicalExpression') {
    // `cond && 'error'` applies nothing when `cond` is falsy.
    const right = classNamesOf(value.right);
    return right === null ? null : [];
  }
  return null;
}

/** Whether a `style={{ … }}` value asks for a break inside a long token. */
function inlineWraps(value: unknown): boolean {
  if (!isNode(value) || value.type !== 'JSXExpressionContainer') return false;
  const expression = value.expression;
  if (!isNode(expression) || expression.type !== 'ObjectExpression') return false;
  const properties = expression.properties;
  if (!Array.isArray(properties)) return false;
  for (const property of properties) {
    if (!isNode(property) || property.type !== 'Property') continue;
    const key = property.key;
    const keyName = isNode(key) ? (nameOf(key) ?? (typeof key.value === 'string' ? key.value : null)) : null;
    if (keyName === null) continue;
    if (!['overflowWrap', 'wordBreak', 'word-wrap', 'overflow-wrap'].includes(keyName)) continue;
    const propertyValue = property.value;
    if (!isNode(propertyValue)) continue;
    if (propertyValue.type === 'Literal' && typeof propertyValue.value === 'string') {
      if (WRAPPING_VALUES.has(propertyValue.value.trim().toLowerCase())) return true;
    }
  }
  return false;
}

/** Reads one `JSXElement` into the shape the stylesheet matcher wants. */
export function elementOf(element: Node): ElementRef | null {
  const opening = element.openingElement;
  if (!isNode(opening)) return null;
  const tag = tagOf(opening);
  if (tag === null) return null;
  const attributes = opening.attributes;
  let classes: string[] = [];
  let inlineWrap = false;
  if (Array.isArray(attributes)) {
    for (const attribute of attributes) {
      if (!isNode(attribute) || attribute.type !== 'JSXAttribute') continue;
      const attributeName = nameOf(attribute.name);
      if (attributeName === 'className') {
        const parsed = classNamesOf(attribute.value);
        // A dynamic class name is not a class name this scan can match. It is
        // reported by the caller rather than guessed at.
        if (parsed === null) return null;
        classes = parsed;
      } else if (attributeName === 'style') {
        inlineWrap = inlineWraps(attribute.value);
      }
    }
  }
  const written = classes.length > 0 ? `<${tag} className="${classes.join(' ')}">` : `<${tag}>`;
  return { tag, classes, inlineWrap, written };
}

// ---------------------------------------------------------------------------
// Taint: which expressions carry a string this repository did not write
// ---------------------------------------------------------------------------

/** The member names that carry a downstream string. */
const DOWNSTREAM_MEMBERS = new Set(['message', 'reason', 'stack', 'detail', 'fatal']);

/** The functions whose result is a downstream string by definition. */
const DOWNSTREAM_CALLS = new Set(['describeError']);

/** Whether a member expression reaches through `endpointErrors`. */
function reachesEndpointErrors(node: Node): boolean {
  let current: unknown = node;
  for (let guard = 0; guard < 16; guard += 1) {
    if (!isNode(current)) return false;
    if (current.type === 'Identifier') return current.name === 'endpointErrors';
    if (current.type !== 'MemberExpression') return false;
    if (nameOf(current.property) === 'endpointErrors') return true;
    current = current.object;
  }
  return false;
}

/** The taint state of one file, grown to a fixpoint. */
interface Taint {
  readonly names: Set<string>;
  readonly localReturns: Set<string>;
}

/** Whether an expression evaluates to a downstream string. */
function isTainted(expression: unknown, taint: Taint): boolean {
  if (!isNode(expression)) return false;
  switch (expression.type) {
    case 'Identifier': {
      const name = nameOf(expression);
      return name !== null && taint.names.has(name);
    }
    case 'MemberExpression': {
      const property = nameOf(expression.property);
      if (property !== null && DOWNSTREAM_MEMBERS.has(property)) return true;
      return reachesEndpointErrors(expression);
    }
    case 'CallExpression': {
      const callee = expression.callee;
      const calleeName = nameOf(callee);
      if (calleeName !== null && (DOWNSTREAM_CALLS.has(calleeName) || taint.localReturns.has(calleeName))) {
        return true;
      }
      const args = expression.arguments;
      if (!Array.isArray(args)) return false;
      return args.some((argument) => isTainted(argument, taint));
    }
    case 'TemplateLiteral': {
      const expressions = expression.expressions;
      if (!Array.isArray(expressions)) return false;
      return expressions.some((part) => isTainted(part, taint));
    }
    case 'BinaryExpression':
      return isTainted(expression.left, taint) || isTainted(expression.right, taint);
    case 'LogicalExpression':
      return isTainted(expression.left, taint) || isTainted(expression.right, taint);
    case 'ConditionalExpression':
      return isTainted(expression.consequent, taint) || isTainted(expression.alternate, taint);
    case 'AwaitExpression':
      return isTainted(expression.argument, taint);
    case 'TSAsExpression':
    case 'TSNonNullExpression':
      return isTainted(expression.expression, taint);
    case 'SequenceExpression': {
      const expressions = expression.expressions;
      if (!Array.isArray(expressions)) return false;
      return expressions.some((part) => isTainted(part, taint));
    }
    default:
      return false;
  }
}

/** Grows `taint` until nothing new is learned. */
function saturate(program: Node, taint: Taint): void {
  for (let round = 0; round < 12; round += 1) {
    const before = taint.names.size + taint.localReturns.size;

    // `const [value, setValue] = useState(…)` — the setter taints the value.
    const setters = new Map<string, string>();
    walk(program, (node) => {
      if (node.type !== 'VariableDeclarator') return;
      const id = node.id;
      if (!isNode(id) || id.type !== 'ArrayPattern') return;
      const elements = id.elements;
      if (!Array.isArray(elements) || elements.length < 2) return;
      const value = nameOf(elements[0]);
      const setter = nameOf(elements[1]);
      if (value !== null && setter !== null) setters.set(setter, value);
    });

    walk(program, (node) => {
      // `const x = <downstream>` — the name carries it from here on.
      if (node.type === 'VariableDeclarator') {
        const name = nameOf(node.id);
        if (name !== null && isTainted(node.init, taint)) taint.names.add(name);
        return;
      }
      // `setX(<downstream>)` — the state carries it to wherever it is drawn.
      if (node.type === 'CallExpression') {
        const callee = nameOf(node.callee);
        if (callee === null) return;
        const state = setters.get(callee);
        if (state === undefined) return;
        const args = node.arguments;
        if (!Array.isArray(args)) return;
        if (args.some((argument) => isTainted(argument, taint))) taint.names.add(state);
        return;
      }
      // `function errorMessage(…) { … return error.message; }` — a helper is
      // not a laundering step, so its name is downstream too.
      if (node.type === 'FunctionDeclaration') {
        const name = nameOf(node.id);
        if (name === null) return;
        let returns = false;
        walk(node.body, (inner) => {
          if (inner.type !== 'ReturnStatement') return;
          if (isTainted(inner.argument, taint)) returns = true;
        });
        if (returns) taint.localReturns.add(name);
      }
    });

    if (taint.names.size + taint.localReturns.size === before) return;
  }
}

// ---------------------------------------------------------------------------
// The scan
// ---------------------------------------------------------------------------

/** One place a downstream string reaches a JSX text node. */
export interface RenderSite {
  readonly file: string;
  readonly line: number;
  /** The element that holds the string, as written. */
  readonly element: string;
  /** The expression, trimmed to one line. */
  readonly expression: string;
  /** Outermost-first, ending at the element that holds the string. */
  readonly chain: readonly ElementRef[];
}

/** What one file contributes. */
export interface FileScan {
  readonly sites: readonly RenderSite[];
  /** Component name → the props that were handed a downstream string. */
  readonly propTaint: ReadonlyMap<string, ReadonlySet<string>>;
  /** Sites whose box this scan could not read (a dynamic `className`). */
  readonly unreadable: readonly string[];
  /** The functions this file defines — the components a prop can be handed to. */
  readonly components: ReadonlySet<string>;
}

/** The component a JSX element names, or `null` for a DOM tag. */
function componentOf(element: ElementRef): string | null {
  return /^[A-Z]/.test(element.tag) ? element.tag : null;
}

/**
 * Follows an expression to the boxes its text actually lands in.
 *
 * A `? :` or a `&&` is not a box: the string is drawn by whichever branch runs,
 * and a `JSXElement` branch draws it in its own children — which the walk
 * reaches separately. So the recursion stops at markup and only reports the
 * leaves that are text.
 */
function resolveText(
  expression: unknown,
  chain: readonly ElementRef[],
  record: (chain: readonly ElementRef[]) => void,
): void {
  if (!isNode(expression)) return;
  switch (expression.type) {
    case 'ConditionalExpression':
      resolveText(expression.consequent, chain, record);
      resolveText(expression.alternate, chain, record);
      return;
    case 'LogicalExpression':
      // `x && <div/>` draws nothing when `x` is falsy — and a falsy string is
      // the empty string, which draws nothing either. Only the right side is
      // ever on screen. `||` and `??` do draw the left side when it is truthy.
      if (expression.operator === '&&') resolveText(expression.right, chain, record);
      else {
        resolveText(expression.left, chain, record);
        resolveText(expression.right, chain, record);
      }
      return;
    case 'ArrayExpression': {
      const elements = expression.elements;
      if (Array.isArray(elements)) for (const element of elements) resolveText(element, chain, record);
      return;
    }
    case 'JSXElement':
    case 'JSXFragment':
      // Markup: the text inside it is a container of its own, visited by the walk.
      return;
    default:
      record(chain);
  }
}

/**
 * Where each component in this file draws its `children`.
 *
 * `<Def>{reason}</Def>` puts the string inside `Def`'s own markup, not inside
 * the `<Def>` tag — and `Def` draws `{children}` inside `<span className="v">`,
 * which is the box that clips it. Without this the gate would report the
 * `<Def>` tag as an unprotected box, which is true of the tag and false of the
 * screen. The chain is the elements from the component's root down to the one
 * that renders `{children}`.
 */
function childrenChains(program: Node): Map<string, ElementRef[]> {
  const chains = new Map<string, ElementRef[]>();
  walkWithAncestors(program, (node, ancestors) => {
    if (node.type !== 'JSXExpressionContainer') return;
    const expression = node.expression;
    if (!isNode(expression) || expression.type !== 'Identifier' || expression.name !== 'children') return;

    // The component this container belongs to: the nearest enclosing function
    // with a name.
    let component: string | null = null;
    for (let i = ancestors.length - 1; i >= 0; i -= 1) {
      const candidate = ancestors[i]!.node;
      if (candidate.type === 'FunctionDeclaration') {
        component = nameOf(candidate.id);
        break;
      }
      if (candidate.type === 'VariableDeclarator') {
        component = nameOf(candidate.id);
        break;
      }
    }
    if (component === null) return;

    const chain: ElementRef[] = [];
    for (const ancestor of ancestors) {
      if (ancestor.node.type !== 'JSXElement') continue;
      const ref = elementOf(ancestor.node);
      if (ref === null) return;
      chain.push(ref);
    }
    if (chain.length > 0) chains.set(component, chain);
  });
  return chains;
}

/** Replaces a component tag in a chain with the boxes it draws its children in. */
function expandChain(
  chain: readonly ElementRef[],
  chains: ReadonlyMap<string, ElementRef[]>,
): ElementRef[] {
  const out: ElementRef[] = [];
  for (const element of chain) {
    const inner = componentOf(element) === null ? undefined : chains.get(element.tag);
    if (inner === undefined) out.push(element);
    else out.push(...inner);
  }
  return out;
}

/** Reads one renderer source and reports where downstream strings are drawn. */
export function scanFile(file: string, source: string, seedProps: ReadonlySet<string>): FileScan {
  const program = parse(source, { jsx: true, range: true, loc: true, filePath: file });
  const taint: Taint = { names: new Set(seedProps), localReturns: new Set() };
  saturate(program, taint);

  const sites: RenderSite[] = [];
  const unreadable: string[] = [];
  const propTaint = new Map<string, Set<string>>();
  const chains = childrenChains(program);
  const components = new Set<string>();
  walk(program, (node) => {
    if (node.type === 'FunctionDeclaration') {
      const name = nameOf(node.id);
      if (name !== null) components.add(name);
    }
    if (node.type === 'VariableDeclarator') {
      const name = nameOf(node.id);
      if (name !== null) components.add(name);
    }
  });

  walkWithAncestors(program, (node, ancestors) => {
    if (node.type !== 'JSXExpressionContainer') return;
    const expression = node.expression;
    if (!isNode(expression)) return;
    if (expression.type === 'JSXEmptyExpression') return;
    if (!isTainted(expression, taint)) return;

    const parent = ancestors[ancestors.length - 1];
    const line = (node.loc as { start: { line: number } } | undefined)?.start.line ?? 0;
    const text = source.slice(
      (node.range as [number, number] | undefined)?.[0] ?? 0,
      (node.range as [number, number] | undefined)?.[1] ?? 0,
    );

    // `reason={…}` — a prop, not a text node. The string is drawn inside the
    // component, so the component's own `reason` becomes downstream.
    if (parent !== undefined && parent.node.type === 'JSXAttribute') {
      const attributeName = nameOf(parent.node.name);
      const element = ancestors
        .map((ancestor) => ancestor.node)
        .filter((ancestor) => ancestor.type === 'JSXElement')
        .pop();
      if (attributeName === null || element === undefined) return;
      const ref = elementOf(element);
      const component = ref === null ? null : componentOf(ref);
      if (component === null) return;
      const props = propTaint.get(component) ?? new Set<string>();
      props.add(attributeName);
      propTaint.set(component, props);
      return;
    }

    const chain: ElementRef[] = [];
    for (const ancestor of ancestors) {
      if (ancestor.node.type !== 'JSXElement') continue;
      const ref = elementOf(ancestor.node);
      if (ref === null) {
        unreadable.push(`${file}:${line} — a box on the way up has a dynamic className`);
        return;
      }
      chain.push(ref);
    }
    if (chain.length === 0) {
      unreadable.push(`${file}:${line} — a downstream string is drawn with no element around it`);
      return;
    }

    // `{cond && <div className="notice">{reason}</div>}` is one container whose
    // expression is markup, not text. The text lands in the inner box, which
    // the walk visits on its own — recording the outer box as well would report
    // a `.card` as unprotected for a string that is never drawn in it.
    const record = (target: readonly ElementRef[]): void => {
      const expanded = expandChain(target, chains);
      sites.push({
        file,
        line,
        element: expanded[expanded.length - 1]!.written,
        expression: text.replace(/\s+/g, ' ').trim(),
        chain: expanded,
      });
    };
    resolveText(expression, chain, record);
  });

  return { sites, propTaint, unreadable, components };
}

/** The result of scanning a whole tree. */
export interface TreeScan {
  readonly sites: readonly RenderSite[];
  readonly unreadable: readonly string[];
  /** Sites with no wrapping rule on the way up. */
  readonly unprotected: readonly RenderSite[];
  /** Sites protected only by a rule on one of the roots. */
  readonly blanket: readonly RenderSite[];
}

/**
 * Scans every file, then decides which sites are protected.
 *
 * Props are resolved to a fixpoint: `App.tsx` hands `endpointErrors.sessions`
 * to `ReadFailure`'s `reason`, and `ReadFailure` draws it — so the second pass
 * has to know about the first. Three rounds is more than the tree needs and
 * cheap enough to be obviously enough.
 *
 * The taint has to travel to the file that *defines* the component, not stay
 * where the tag was written. `<ReadFailure reason={…} />` appears in `App.tsx`
 * and in four panels; the `{reason}` that reaches the screen is in
 * `ReadFailure.tsx`. Keeping the prop in the call-site file (which is what this
 * did first) left the one component every failed read goes through outside the
 * scanned set — the gate was green and blind at the same time, which is why
 * `long-string-overflow.test.ts` names the sites it must find.
 */
export function scanTree(
  files: ReadonlyMap<string, string>,
  rules: readonly CssRule[],
): TreeScan {
  // Seeds are keyed by file, not by component: a prop handed to `PanelCrash`
  // taints `message` inside `PanelBoundary.tsx`, and the file is the unit this
  // scan reads. Seeding the whole file is the permissive direction, and the
  // permissive direction here only means a site is *checked*, never skipped.
  const seeds = new Map<string, Set<string>>();
  let scans = new Map<string, FileScan>();

  for (let round = 0; round < 4; round += 1) {
    scans = new Map<string, FileScan>();
    for (const [file, source] of files) {
      scans.set(file, scanFile(file, source, seeds.get(file) ?? new Set()));
    }

    // Which files define each component. A name defined in two files seeds
    // both, which is the permissive direction again: a site is checked twice,
    // never skipped.
    const definers = new Map<string, Set<string>>();
    for (const [file, scan] of scans) {
      for (const component of scan.components) {
        const set = definers.get(component) ?? new Set<string>();
        set.add(file);
        definers.set(component, set);
      }
    }

    let changed = false;
    for (const scan of scans.values()) {
      for (const [component, props] of scan.propTaint) {
        for (const definer of definers.get(component) ?? []) {
          const existing = seeds.get(definer) ?? new Set<string>();
          const before = existing.size;
          for (const prop of props) existing.add(prop);
          if (existing.size !== before) changed = true;
          seeds.set(definer, existing);
        }
      }
    }
    if (!changed) break;
  }

  const sites: RenderSite[] = [];
  const unreadable: string[] = [];
  const seen = new Set<string>();
  for (const scan of scans.values()) {
    for (const site of scan.sites) {
      // `a ?? b` records both sides, and both are the same line and box.
      const key = `${site.file}:${site.line}:${site.element}:${site.expression}`;
      if (seen.has(key)) continue;
      seen.add(key);
      sites.push(site);
    }
    unreadable.push(...scan.unreadable);
  }

  const unprotected: RenderSite[] = [];
  const blanket: RenderSite[] = [];
  for (const site of sites) {
    const protection = protectionFor(site.chain, rules);
    if (protection === null) {
      unprotected.push(site);
      continue;
    }
    // A rule on the window itself protects every site below it, which is the
    // same as protecting none of them: the gate would then assert nothing.
    if (isRootElement(protection.element)) blanket.push(site);
  }

  return { sites, unreadable, unprotected, blanket };
}

/** One line per site, for a failure message that names the file and the box. */
export function describeSite(site: RenderSite): string {
  return `${site.file}:${site.line} — ${site.element} holds ${site.expression}`;
}
