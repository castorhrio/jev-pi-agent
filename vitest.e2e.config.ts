import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Renderer end-to-end gate.
 *
 * Runs the *real* `App` in a DOM against the *real* fixture bridge, so the
 * whole path — mount → send a turn → stream a response → generate a handoff —
 * is exercised as a user would, not as a unit with mocked children.
 *
 * This is the gate whose absence let a menu item ship with no handler and a
 * collapsed column ship unnoticed.
 */
export default defineConfig({
  test: {
    include: ['tests/e2e/**/*.e2e.test.tsx'],
    environment: 'happy-dom',
    globals: true,
    setupFiles: ['tests/e2e/setup.ts'],
    /*
     * Actually process CSS instead of stubbing it out.
     *
     * With the default (`css: false`) Vitest replaces every `.css` import with
     * an empty module, so `document.styleSheets` was empty and every E2E test
     * ran against a completely unstyled DOM. That is not a subtle loss of
     * coverage: it means the accessibility scan could not see anything the
     * stylesheet decides, including content hidden by a media query — and
     * `getComputedStyle` cheerfully reported `display: block` for an element the
     * real app hides.
     */
    css: true,
    testTimeout: 20_000,
    hookTimeout: 20_000,
    pool: 'forks',
    reporters: ['default'],
    // The viewport is NOT set here. This `environmentOptions.happyDOM.settings`
    // block was believed to pin the window to 1440px and did not: the window
    // stayed at happy-dom's 1024px default, and because happy-dom applies media
    // queries, the preview column (`display: none` below 1180px) was invisible
    // to every accessibility scan — which still reported itself clean.
    //
    // The working call is `happyDOM.setViewport()` in `tests/e2e/setup.ts`, and
    // `tests/e2e/setup.ts` asserts the resulting `innerWidth` so a silent
    // revert cannot happen again. See `tests/e2e/viewport.ts`.
  },
  resolve: {
    alias: {
      // Point at source so the E2E run does not depend on a prior build.
      // `fileURLToPath` is required here: on Windows `import.meta.url` is a
      // `file:///E:/...` URL, and its `.pathname` starts with `/E:`, which no
      // resolver can open.
      '@ucad/contracts': path.resolve(here, 'packages/contracts/src/index.ts'),
      '@renderer': path.resolve(here, 'apps/desktop/src/renderer/src'),
    },
  },
  esbuild: {
    jsx: 'automatic',
  },
});
