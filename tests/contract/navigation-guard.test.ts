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
 *
 * The second guard is `setWindowOpenHandler` (`window.open`, `target="_blank"`).
 * It used to be inline in `bootstrap.ts` and decided with
 * `/^https?:\/\//i.test(url)` — a spelling check on a URL, not a protocol
 * check, and untestable without an Electron window. It has its own section
 * below, on the same extracted function the bootstrap calls.
 */

import { describe, expect, it } from 'vitest';
import {
  evaluateNavigation,
  evaluateWindowOpen,
  isOwnNavigation,
} from '../../apps/desktop/src/main/navigation-guard';

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

describe('window open guard: no second window, links go to the browser', () => {
  it('opens an http(s) link in the browser and never in the app', () => {
    // `action` is `deny` in every case: a window opened from the Renderer would
    // get UCAD's preload, and with it `files.write`, `terminal`, `secrets.set`.
    expect(evaluateWindowOpen('https://github.com/castorhrio/jev-pi-agent')).toEqual({
      action: 'deny',
      openExternal: true,
      reason: 'external-link',
    });
    expect(evaluateWindowOpen('http://example.com/docs?x=1#y')).toEqual({
      action: 'deny',
      openExternal: true,
      reason: 'external-link',
    });
  });

  it('refuses file: instead of handing it to the browser', () => {
    // The same local page `will-navigate` refuses: opening it externally would
    // be the same bypass with an extra step.
    for (const target of [
      OWN_FILE,
      'file:///C:/ucad/apps/desktop/dist/renderer/other.html',
      'file:///etc/passwd',
    ]) {
      expect(evaluateWindowOpen(target)).toEqual({
        action: 'deny',
        openExternal: false,
        reason: 'unsupported-protocol',
      });
    }
  });

  it('refuses a script url rather than launching it', () => {
    // `shell.openExternal('javascript:…')` is code execution dressed as a link.
    expect(evaluateWindowOpen('javascript:alert(1)')).toEqual({
      action: 'deny',
      openExternal: false,
      reason: 'unsupported-protocol',
    });
    expect(evaluateWindowOpen('data:text/html,<script>alert(1)</script>').openExternal).toBe(false);
    expect(evaluateWindowOpen('about:blank').openExternal).toBe(false);
  });

  it('refuses what is not a url at all', () => {
    for (const target of ['', 'not a url']) {
      expect(evaluateWindowOpen(target)).toEqual({
        action: 'deny',
        openExternal: false,
        reason: 'invalid-url',
      });
    }
  });

  it('refuses a bare windows path', () => {
    // A path rendered in chat is not a link. `new URL()` reads `C:` as a
    // scheme, so this lands on `unsupported-protocol` rather than
    // `invalid-url` — either way it is denied and nothing is opened, which is
    // the property the handler depends on.
    expect(evaluateWindowOpen('C:\\ucad\\index.html')).toEqual({
      action: 'deny',
      openExternal: false,
      reason: 'unsupported-protocol',
    });
  });

  it('denies the window whatever the link is', () => {
    // The one property a caller cannot get wrong: there is no input for which
    // the handler is told to open a window.
    for (const target of [
      'https://example.com',
      'javascript:alert(1)',
      'file:///C:/ucad/index.html',
      '',
    ]) {
      expect(evaluateWindowOpen(target).action).toBe('deny');
    }
  });
});
