/**
 * Which file the tray icon comes from.
 *
 * The tray is the app's home after the window is closed, so it cannot be
 * represented by a 1x1 transparent PNG: the window hides, the run continues,
 * and there is nothing visible to click to get back or to quit. That is not a
 * cosmetic placeholder — it makes a running app look dead.
 *
 * `scripts/generate-icon.mjs` already writes the brand icon; the installer
 * copies it next to the app (see `build.extraResources`). Keeping the path
 * selection here, away from Electron, lets the contract test check the two
 * layouts that actually ship rather than trusting a string in bootstrap.
 */

import { join } from 'node:path';
import type { CloseBehaviour } from '@ucad/contracts';

export interface TrayIconContext {
  platform: NodeJS.Platform;
  /** `app.isPackaged`: the workspace layout is gone once packaged. */
  packaged: boolean;
  /** `__dirname` of the compiled main entry (development layout). */
  mainDir: string;
  /** `process.resourcesPath` (packaged layout). */
  resourcesPath: string;
}

/**
 * Windows gets the multi-size ICO so the 16px slot is crisp; everywhere else
 * uses the PNG. The development path is the same file the packaging config
 * copies, so a broken asset fails in `npm run dev` too rather than only after
 * a release.
 */
export function trayIconPath(context: TrayIconContext): string {
  const file = context.platform === 'win32' ? 'icon.ico' : 'icon.png';
  return context.packaged
    ? join(context.resourcesPath, file)
    : join(context.mainDir, '..', '..', 'resources', file);
}

export interface TrayIcon {
  isEmpty(): boolean;
}

/**
 * Load the icon and report whether it actually decoded.
 *
 * A missing or malformed file yields an empty `NativeImage`; `Tray` would then
 * create an invisible icon and the app would still hide to it. The caller
 * treats `empty` as "no tray" and quits on close instead.
 */
export function loadTrayIcon<T extends TrayIcon>(
  images: { createFromPath(path: string): T },
  context: TrayIconContext,
): { path: string; image: T; empty: boolean } {
  const path = trayIconPath(context);
  const image = images.createFromPath(path);
  return { path, image, empty: image.isEmpty() };
}

// ---------------------------------------------------------------------------
// close semantics
// ---------------------------------------------------------------------------

/**
 * Why the tray cannot be used, when it cannot.
 *
 * The two cases are not the same bug: `icon-empty` means the asset shipped
 * broken, `no-tray` means the platform gave us no notification area at all.
 */
export type TrayProblem = 'no-tray' | 'icon-empty';

export interface WindowCloseDecision {
  /** the window hides and the app keeps running */
  hideToTray: boolean;
  /** why, for the log line that explains it later */
  reason: 'preference' | 'no-tray' | 'icon-empty';
}

/**
 * The one place that decides what closing the window does.
 *
 * Three facts go in:
 *
 *  - **what the user asked for** (`preference`), read from Settings;
 *  - **whether a tray exists at all**;
 *  - **whether the tray icon actually decoded**.
 *
 * The third fact is the one that used to be missing. A tray whose image did not
 * decode is an *invisible* slot: the window hides into it and the app is alive
 * with nothing to click — the exact failure the tray fix was meant to close.
 * So a tray that cannot be seen is treated as no tray at all, and the window
 * quits instead of hiding.
 *
 * The user's preference never overrides a missing tray: "hide to tray" means
 * "hide to *a tray*", and there is none to hide to.
 */
export function decideWindowClose(input: {
  /** a tray exists and shows a real icon */
  trayUsable: boolean;
  /** what the user chose in Settings */
  preference: CloseBehaviour;
  /** why the tray is unusable, when it is */
  trayProblem?: TrayProblem;
}): WindowCloseDecision {
  if (input.preference === 'quit') {
    return { hideToTray: false, reason: 'preference' };
  }
  if (!input.trayUsable) {
    return { hideToTray: false, reason: input.trayProblem ?? 'no-tray' };
  }
  return { hideToTray: true, reason: 'preference' };
}
