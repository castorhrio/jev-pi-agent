import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, expect } from 'vitest';
import { cleanup } from '@testing-library/react';
import { E2E_VIEWPORT } from './viewport';
// The production stylesheet, imported for the same reason the App is: the E2E
// suite is meant to exercise the real thing. `main.tsx` imports it, but the
// tests import `App` directly and so were running against a **completely
// unstyled DOM** — which is why `getComputedStyle` reported `display: block`
// for elements the app really hides with a media query, and why the a11y scan
// could never catch anything CSS-dependent.
import '@renderer/styles.css';

/**
 * E2E setup.
 *
 * The only thing standing in for the real app is the transport: `installFixtureBridge`
 * provides an in-memory `UcadApi` because there is no Electron here. Everything
 * above that — the App shell, the session reducer, the panels, the styles' class
 * names — is the production code.
 */
beforeEach(() => {
  // The renderer reads the scenario off the URL; default is the happy path.
  window.history.replaceState({}, '', '/');

  /*
   * The viewport is set HERE, through happy-dom's own API, because the
   * `environmentOptions.happyDOM.settings.viewport` block in
   * `vitest.e2e.config.ts` does not take effect with this vitest/happy-dom
   * pair — the window silently stayed at its 1024px default.
   *
   * That mattered: the preview column is `display: none` below 1180px, and
   * happy-dom *does* apply media queries. So at 1024px the entire right
   * column of the app was invisible to every accessibility scan, and the scan
   * reported itself clean. The claim that the viewport was
   * "pinned to 1440px so the right column is scanned" was simply untrue.
   *
   * Set it per test rather than once per file, because each test gets a fresh
   * window and a one-shot call in this module would apply to only the first.
   */
  (window as unknown as { happyDOM?: { setViewport: (v: { width: number; height: number }) => void } })
    .happyDOM?.setViewport(E2E_VIEWPORT);
});

/**
 * Gates the pin itself.
 *
 * A viewport that silently reverts to its default is exactly the failure this
 * file exists to prevent, and it is invisible: every scan still passes, it just
 * passes over less of the app. So the viewport is asserted rather than assumed.
 */
beforeEach(() => {
  expect(
    window.innerWidth,
    `the E2E viewport must be ${E2E_VIEWPORT.width}px; if this fails, the pin in setup.ts ` +
      'stopped working and every accessibility scan is silently covering less of the app',
  ).toBe(E2E_VIEWPORT.width);
});

afterEach(() => {
  cleanup();
  delete (window as unknown as Record<string, unknown>).ucad;
  delete (window as unknown as Record<string, unknown>).__ucadFixture;
});
