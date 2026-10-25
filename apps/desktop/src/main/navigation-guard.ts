/**
 * §11 navigation — the app window shows exactly one document.
 *
 * The window loads the app's own page and nothing else. Allowing any URL
 * would let a stray link (a path rendered in chat, a workspace HTML file) point
 * the window at another page — one that loads with UCAD's preload and therefore
 * receives the whole bridge: `files.write`, `terminal`, `secrets.set`.
 *
 * The old check was `url.startsWith(own)`, which is a *string* comparison, and
 * strings do not know where a URL ends:
 *
 * - `http://localhost:52730.evil` starts with `http://localhost:5273` — a
 *   different host that merely looks like ours.
 * - `file:///…/index.html.evil` starts with `file:///…/index.html` — a
 *   different file that merely starts with our file's name.
 *
 * Both are the same bug: a prefix is not a boundary. This module compares
 * *origins* for `http(s)` and, for `file:`, the normalized pathname with a `/`
 * boundary — the two cases where "same app" is actually decidable.
 *
 * It is a pure function on purpose: the rule is a security boundary, and a rule
 * that can only be checked by booting Electron is a rule nobody checks.
 */

export interface NavigationVerdict {
  allow: boolean;
  /** `own-document` when allowed, otherwise why it was refused */
  reason:
    | 'own-document'
    | 'no-own-url'
    | 'invalid-url'
    | 'protocol-mismatch'
    | 'unsupported-protocol'
    | 'different-origin'
    | 'outside-own-document';
}

/** The protocols a document may be loaded from. Everything else is refused. */
const SUPPORTED_PROTOCOLS: ReadonlySet<string> = new Set(['file:', 'http:', 'https:']);

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    // An unparseable URL is not navigable to anything we own.
    return null;
  }
}

/**
 * A file path as a comparable string.
 *
 * `new URL()` already normalises most of it, but three things still differ
 * between two spellings of the same file: percent-encoding, `\` vs `/` on
 * Windows, and the case of a drive letter. The drive letter is folded because
 * `C:` and `c:` are the same drive; the path case is *not* folded, because
 * Windows paths are case-insensitive but the product does not depend on that
 * and a false refusal is the safe direction.
 */
function normalizeFilePath(pathname: string): string {
  let p = pathname;
  try {
    p = decodeURIComponent(p);
  } catch {
    // A malformed escape sequence is not a reason to fail open; keep the
    // encoded form and compare that.
  }
  p = p.replace(/\\/g, '/');
  p = p.replace(/\/{2,}/g, '/');
  p = p.replace(/^\/([a-zA-Z]):/, (_match, drive: string) => `/${drive.toUpperCase()}:`);
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p;
}

/**
 * Whether `target` is the app's own document.
 *
 * `own` is the URL the window actually loaded — read from the webContents at
 * event time, so the check matches whatever this window is showing rather than
 * a string the caller guesses at. An empty `own` means the first load has not
 * completed yet, and everything is refused: fail closed.
 */
export function evaluateNavigation(
  target: string,
  own: string | null | undefined,
): NavigationVerdict {
  if (!own) return { allow: false, reason: 'no-own-url' };

  const targetUrl = parse(target);
  const ownUrl = parse(own);
  if (!targetUrl || !ownUrl) return { allow: false, reason: 'invalid-url' };

  // `javascript:`, `data:`, `about:`, `chrome:` — none of them is a document
  // this app owns, and none of them may be reached by a navigation whatever
  // the window is currently showing.
  if (!SUPPORTED_PROTOCOLS.has(targetUrl.protocol)) {
    return { allow: false, reason: 'unsupported-protocol' };
  }

  if (targetUrl.protocol !== ownUrl.protocol) {
    return { allow: false, reason: 'protocol-mismatch' };
  }

  if (targetUrl.protocol === 'file:') {
    // `file:` URLs have an opaque origin ("null" for every file), so the
    // origin check says nothing here. The pathname is the boundary instead:
    // the target must be the same document, or sit under it with a `/` in
    // between. `index.html.evil` is not under `index.html`.
    const targetPath = normalizeFilePath(targetUrl.pathname);
    const ownPath = normalizeFilePath(ownUrl.pathname);
    const inside = targetPath === ownPath || targetPath.startsWith(`${ownPath}/`);
    return inside
      ? { allow: true, reason: 'own-document' }
      : { allow: false, reason: 'outside-own-document' };
  }

  if (targetUrl.protocol === 'http:' || targetUrl.protocol === 'https:') {
    // `origin` is the whole point: it is host + port + scheme, with the
    // default port normalised away. `http://localhost:5273@evil.com` has the
    // host `evil.com`, not `localhost`, and is refused.
    return targetUrl.origin === ownUrl.origin
      ? { allow: true, reason: 'own-document' }
      : { allow: false, reason: 'different-origin' };
  }

  return { allow: false, reason: 'unsupported-protocol' };
}

/** The boolean form, for the caller that only wants yes or no. */
export function isOwnNavigation(
  target: string,
  own: string | null | undefined,
): boolean {
  return evaluateNavigation(target, own).allow;
}
