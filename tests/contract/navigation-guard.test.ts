/**
 * The navigation guard decides what the app window is allowed to show.
 *
 * ## Why this file exists
 *
 * The guard used to be `url.startsWith(own)`. A prefix is not a boundary:
 *
 * - `http://localhost:52730.evil` starts with `http://localhost:5273`, and it
 *   is a different host — a page that would load with UCAD's preload and
 *   therefore with the whole bridge: `files.write`, `terminal`, `secrets.set`.
 * - `file:///…/index.html.evil` starts with `file:///…/index.html`, and it is a
 *   different file.
 *
 * The window shows exactly one document, so the question is not "does this
 * string look like ours" but "is this the document we loaded". These tests
 * answer that question on the pure function, without booting Electron — a
 * boundary that can only be checked by running the app is a boundary nobody
 * checks.
 */

import { describe, expect, it } from 'vitest';
import { evaluateNavigation, isOwnNavigation } from '../../apps/desktop/src/main/navigation-guard';

/** The production window: the packaged renderer document. */
const OWN_FILE = 'file:///C:/ucad/apps/desktop/dist/renderer/index.html';

/** The development window: the Vite dev server. */
const OWN_HTTP = 'http://localhost:5273';

describe('navigation guard: the window shows exactly one document', () => {
  it('allows the document it is showing', () => {
    expect(evaluateNavigation(OWN_FILE, OWN_FILE)).toEqual({
      allow: true,
      reason: 'own-document',
    });
  });

  it('allows the same document with a hash route', () => {
    // The renderer routes on the hash; that is still the same document.
    expect(isOwnNavigation(`${OWN_FILE}#/settings`, OWN_FILE)).toBe(true);
  });

  it('allows the dev server origin it is showing', () => {
    expect(isOwnNavigation('http://localhost:5273/', OWN_HTTP)).toBe(true);
    expect(isOwnNavigation('http://localhost:5273/index.html?x=1', OWN_HTTP)).toBe(true);
  });

  it('refuses a host that merely starts with our own', () => {
    // The exact case the old prefix check let through.
    expect(isOwnNavigation('http://localhost:52730.evil', OWN_HTTP)).toBe(false);
    expect(isOwnNavigation('http://localhost:5273.evil.com', OWN_HTTP)).toBe(false);
  });

  it('refuses a URL that hides another host behind our own', () => {
    // `localhost` is the userinfo here, `evil.com` is the host.
    expect(evaluateNavigation('http://localhost:5273@evil.com/', OWN_HTTP)).toEqual({
      allow: false,
      reason: 'different-origin',
    });
  });

  it('refuses another origin on the same host', () => {
    expect(isOwnNavigation('http://127.0.0.1:5273/', OWN_HTTP)).toBe(false);
    expect(isOwnNavigation('https://localhost:5273/', OWN_HTTP)).toBe(false);
    expect(isOwnNavigation('http://localhost:5274/', OWN_HTTP)).toBe(false);
  });

  it('refuses a file that merely starts with our own file name', () => {
    // The exact case the old prefix check let through.
    const evil = 'file:///C:/ucad/apps/desktop/dist/renderer/index.html.evil';
    expect(evaluateNavigation(evil, OWN_FILE)).toEqual({
      allow: false,
      reason: 'outside-own-document',
    });
  });

  it('refuses a file next to our document', () => {
    expect(isOwnNavigation('file:///C:/ucad/apps/desktop/dist/renderer/other.html', OWN_FILE)).toBe(
      false,
    );
    expect(isOwnNavigation('file:///C:/ucad/apps/desktop/dist/renderer/', OWN_FILE)).toBe(false);
  });

  it('refuses a file on another drive', () => {
    expect(isOwnNavigation('file:///D:/ucad/index.html', OWN_FILE)).toBe(false);
  });

  it('refuses a script url', () => {
    expect(evaluateNavigation('javascript:alert(1)', OWN_FILE)).toEqual({
      allow: false,
      reason: 'unsupported-protocol',
    });
    expect(isOwnNavigation('javascript:alert(1)', OWN_HTTP)).toBe(false);
  });

  it('refuses a protocol switch', () => {
    // A `file:` document may not be replaced by an `http:` one, or the other
    // way round — the origin of the two is not comparable.
    expect(evaluateNavigation('http://localhost:5273/', OWN_FILE).reason).toBe('protocol-mismatch');
    expect(evaluateNavigation(OWN_FILE, OWN_HTTP).reason).toBe('protocol-mismatch');
  });

  it('refuses everything when the window has not loaded its own document yet', () => {
    // Before the first load completes `getURL()` is empty. Failing open here
    // would hand the whole bridge to whatever asked first.
    for (const own of ['', null, undefined]) {
      expect(evaluateNavigation(OWN_FILE, own)).toEqual({
        allow: false,
        reason: 'no-own-url',
      });
      expect(isOwnNavigation(OWN_HTTP, own)).toBe(false);
    }
  });

  it('refuses an unparseable url', () => {
    expect(evaluateNavigation('not a url', OWN_HTTP)).toEqual({
      allow: false,
      reason: 'invalid-url',
    });
    expect(evaluateNavigation(OWN_HTTP, 'not a url')).toEqual({
      allow: false,
      reason: 'invalid-url',
    });
  });

  it('treats a drive letter case-insensitively', () => {
    // `C:` and `c:` are the same drive on Windows; refusing our own document
    // over a letter would be a bug, not a security win.
    expect(isOwnNavigation('file:///c:/ucad/apps/desktop/dist/renderer/index.html', OWN_FILE)).toBe(
      true,
    );
  });

  it('compares percent-encoded paths as the file they name', () => {
    const own = 'file:///C:/ucad/apps/desktop/dist/renderer/my%20app.html';
    expect(isOwnNavigation('file:///C:/ucad/apps/desktop/dist/renderer/my%20app.html', own)).toBe(
      true,
    );
    expect(isOwnNavigation('file:///C:/ucad/apps/desktop/dist/renderer/my%20app.html.evil', own)).toBe(
      false,
    );
  });
});
