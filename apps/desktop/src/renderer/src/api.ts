/**
 * The Renderer's only door to Main (NFR-01).
 *
 * There is no `require`, no `process` and no `ipcRenderer` here. If `window.ucad`
 * is missing the preload did not run, and we fail loudly rather than silently
 * degrading into an empty shell.
 */

import type { UcadApi } from '@ucad/contracts';

declare global {
  interface Window {
    ucad?: UcadApi;
  }
}

export function getApi(): UcadApi {
  const api = window.ucad;
  if (!api) {
    throw new Error(
      'UCAD bridge unavailable: the preload script did not run. Restart the app.',
    );
  }
  return api;
}

export function hasApi(): boolean {
  return typeof window !== 'undefined' && Boolean(window.ucad);
}
