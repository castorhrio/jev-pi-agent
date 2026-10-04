/**
 * The viewport the E2E suite runs at, in one place.
 *
 * It lives in its own module so `setup.ts` and the assertions that depend on
 * it cannot drift apart — the failure this exists to prevent is a viewport that
 * reverts to happy-dom's 1024px default while the code still claims otherwise.
 *
 * Why 1440 and not something smaller: the preview column is `display: none`
 * below 1180px, and happy-dom applies media queries, so a narrower viewport
 * makes an entire column of the app invisible to the accessibility scan while
 * the scan still reports itself clean. 1440 is the width at which the whole
 * shell is laid out.
 */
export const E2E_VIEWPORT = { width: 1440, height: 900 } as const;
