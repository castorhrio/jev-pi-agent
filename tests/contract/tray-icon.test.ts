/**
 * The tray must not be an invisible place to hide.
 *
 * `installTray()` used to build a 1x1 transparent PNG inline. Closing the
 * window then hid it behind a tray slot with nothing to see or click: the run
 * was alive, but the app was unreachable except through the task manager. The
 * failure is quiet on every platform and no other test can see it, because the
 * tray lives in Electron's process and the renderer never renders it.
 *
 * What is checkable here is everything the tray depends on: the platform path
 * (development vs packaged), the files the installer actually copies, and that
 * those files are real images rather than the old placeholder. The last step —
 * `Tray` accepting the image — is exercised by the Electron smoke check, not a
 * DOM test.
 *
 * The closing half of the file also pins the other direction: an exit that
 * arrives while a usable tray exists must not be turned into "hide and keep
 * running". The decision is a pure function, and the flag that decides it is
 * asserted against the source that wires it, because a quit flag nobody sets is
 * exactly as broken as no flag at all.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  decideAllWindowsClosed,
  decideWindowClose,
  loadTrayIcon,
  shouldPreventWindowClose,
  trayIconPath,
  type TrayIconContext,
} from '../../apps/desktop/src/main/tray-icon';

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const resources = join(repoRoot, 'apps', 'desktop', 'resources');

function context(overrides: Partial<TrayIconContext> = {}): TrayIconContext {
  return {
    platform: 'linux',
    packaged: true,
    mainDir: join(repoRoot, 'apps', 'desktop', 'dist', 'main'),
    resourcesPath: join('/opt', 'ucad', 'resources'),
    ...overrides,
  };
}

function factory(empty: boolean) {
  return {
    createFromPath: (path: string) => ({ path, isEmpty: () => empty }),
  };
}

describe('tray icon', () => {
  it('uses the Windows ICO for a crisp 16px notification-area slot', () => {
    expect(trayIconPath(context({ platform: 'win32' }))).toBe(
      join('/opt', 'ucad', 'resources', 'icon.ico'),
    );
  });

  it('uses the PNG elsewhere', () => {
    for (const platform of ['linux', 'darwin'] as const) {
      expect(trayIconPath(context({ platform }))).toBe(
        join('/opt', 'ucad', 'resources', 'icon.png'),
      );
    }
  });

  it('finds the same assets from the development layout', () => {
    const path = trayIconPath(context({ platform: 'linux', packaged: false }));
    expect(path).toBe(join(resources, 'icon.png'));
    // The dev path must point at a file that exists; otherwise `npm run dev`
    // runs with no tray until a release is built.
    expect(existsSync(path)).toBe(true);
  });

  it('reports an icon that did not decode instead of trusting Tray', () => {
    const loaded = loadTrayIcon(factory(true), context());
    expect(loaded.empty).toBe(true);
    expect(loaded.path).toBe(join('/opt', 'ucad', 'resources', 'icon.png'));

    const good = loadTrayIcon(factory(false), context());
    expect(good.empty).toBe(false);
  });

  it('ships both icon files at the top of the packaged resources directory', () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
      build?: { extraResources?: Array<{ from?: string; to?: string }> };
    };
    const entries = pkg.build?.extraResources ?? [];
    const destinations = new Map(
      entries.filter((entry) => entry.to).map((entry) => [entry.to!, entry.from]),
    );

    // `process.resourcesPath` is where `trayIconPath` looks when packaged, so
    // the destination has to be the root — a nested path would load as empty.
    for (const file of ['icon.png', 'icon.ico']) {
      expect(destinations.get(file), `${file} is not copied into Resources`).toBe(
        `apps/desktop/resources/${file}`,
      );
      expect(existsSync(join(resources, file)), `${file} is missing from the repo`).toBe(true);
    }
  });

  it('the PNG is a real image, not a 1x1 transparent placeholder', () => {
    const png = readFileSync(join(resources, 'icon.png'));
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(png.readUInt32BE(16), 'icon.png width').toBeGreaterThan(16);
    expect(png.readUInt32BE(20), 'icon.png height').toBeGreaterThan(16);
  });

  it('the ICO carries the 16px size Windows uses in the tray', () => {
    const ico = readFileSync(join(resources, 'icon.ico'));
    expect(ico.readUInt16LE(0), 'reserved').toBe(0);
    expect(ico.readUInt16LE(2), 'type').toBe(1);
    const count = ico.readUInt16LE(4);
    const sizes: number[] = [];
    for (let index = 0; index < count; index += 1) {
      // A stored 0 means 256 in the ICO directory.
      sizes.push(ico[6 + index * 16]! === 0 ? 256 : ico[6 + index * 16]!);
    }
    expect(sizes).toContain(16);
  });
});

// ---------------------------------------------------------------------------
// what closing the window does
// ---------------------------------------------------------------------------

describe('closing the window', () => {
  it('quits instead of hiding when the tray icon did not decode', () => {
    // The failure this rules out: a tray slot with nothing in it. The window
    // hides there, the app is alive, and there is no icon to click — the app
    // is running and unreachable at the same time.
    const loaded = loadTrayIcon(factory(true), context());
    expect(loaded.empty).toBe(true);

    const decision = decideWindowClose({
      trayUsable: !loaded.empty,
      preference: 'hide_to_tray',
      trayProblem: 'icon-empty',
    });

    expect(decision.hideToTray).toBe(false);
    expect(decision.reason).toBe('icon-empty');
  });

  it('hides to the tray when the user asked for it and a real tray exists', () => {
    const loaded = loadTrayIcon(factory(false), context());
    expect(loaded.empty).toBe(false);

    const decision = decideWindowClose({
      trayUsable: !loaded.empty,
      preference: 'hide_to_tray',
    });

    expect(decision.hideToTray).toBe(true);
    expect(decision.reason).toBe('preference');
  });

  it('quits when the user asked the app to quit', () => {
    const decision = decideWindowClose({
      trayUsable: true,
      preference: 'quit',
    });

    expect(decision.hideToTray).toBe(false);
    expect(decision.reason).toBe('preference');
  });

  it('never hides to a tray that does not exist', () => {
    const decision = decideWindowClose({
      trayUsable: false,
      preference: 'hide_to_tray',
      trayProblem: 'no-tray',
    });

    expect(decision.hideToTray).toBe(false);
    expect(decision.reason).toBe('no-tray');
  });
});

// ---------------------------------------------------------------------------
// a real exit is never cancelled by the hide-to-tray default
// ---------------------------------------------------------------------------

describe('quitting', () => {
  it('does not cancel a close that came from a real exit', () => {
    // The path this rules out: Cmd+Q, Dock → Quit, or an OS shutdown reaches
    // the window's `close` handler while "hide to tray" is the preference and a
    // usable tray exists. Cancelling that close hides the window instead of
    // quitting, and once the session is ending there is nothing left to click.
    const prevented = shouldPreventWindowClose({
      isQuitting: true,
      trayUsable: true,
      preference: 'hide_to_tray',
    });

    expect(prevented).toBe(false);
  });

  it('still hides on an ordinary close', () => {
    expect(
      shouldPreventWindowClose({ isQuitting: false, trayUsable: true, preference: 'hide_to_tray' }),
    ).toBe(true);
    expect(
      shouldPreventWindowClose({ isQuitting: false, trayUsable: false, preference: 'hide_to_tray' }),
    ).toBe(false);
    expect(
      shouldPreventWindowClose({ isQuitting: false, trayUsable: true, preference: 'quit' }),
    ).toBe(false);
  });
});

/**
 * The flag above is only worth having if Main actually sets it.
 *
 * `before-quit` is the one Electron event that must reach the close handler with
 * "we are leaving" already recorded, and nothing in a unit test can install an
 * Electron app object. So the wiring is asserted on the source: the listener
 * exists, it sets the flag *before* it decides anything else, and the close
 * handler reads it through `shouldPreventWindowClose`.
 *
 * The `expect` on the extracted blocks is what keeps this honest: a regex that
 * stopped matching would otherwise turn every assertion below green while
 * checking nothing.
 */
describe('the quit flag is wired into the lifecycle', () => {
  const bootstrapSource = readFileSync(
    join(repoRoot, 'apps', 'desktop', 'src', 'main', 'bootstrap.ts'),
    'utf8',
  );

  const beforeQuit = /app\.on\('before-quit',[\s\S]*?\n\}\);/.exec(bootstrapSource)?.[0];
  const closeHandler = /win\.on\('close',[\s\S]*?\n {2}\}\);/.exec(bootstrapSource)?.[0];

  it('has a before-quit listener that sets the flag before it prevents anything', () => {
    expect(beforeQuit, 'bootstrap.ts has no before-quit listener').toBeDefined();
    const setAt = beforeQuit!.indexOf('appState.isQuitting = true');
    const preventAt = beforeQuit!.indexOf('event.preventDefault()');

    expect(setAt, 'before-quit does not set isQuitting').toBeGreaterThanOrEqual(0);
    expect(preventAt, 'before-quit does not defer to the teardown').toBeGreaterThanOrEqual(0);
    expect(setAt, 'isQuitting must be set before the quit is deferred').toBeLessThan(preventAt);
  });

  it('routes the window close through the quit-aware decision', () => {
    expect(closeHandler, 'bootstrap.ts has no close handler on the window').toBeDefined();
    expect(closeHandler).toContain('shouldPreventClose()');
    expect(bootstrapSource).toMatch(/isQuitting:\s*appState\.isQuitting === true/);
    // The old shape — reading the flag inline and then falling back to the
    // preference-only decision — is what made the two orderings diverge.
    expect(closeHandler).not.toContain('isQuitting) return;');
  });
});

// ---------------------------------------------------------------------------
// after the last window closed
// ---------------------------------------------------------------------------

describe('the last window is gone', () => {
  it('quits when the setting says 退出应用, tray or no tray', () => {
    // The defect this rules out, caught on a real desktop session: the user set
    // 关闭窗口时 = 退出应用, clicked the X, the window went away — and the process
    // stayed. The old rule only asked whether a tray existed, so a usable tray
    // (the very thing that makes "quit" mean something) kept the app alive
    // against the user's instruction.
    expect(
      decideAllWindowsClosed({
        platform: 'linux',
        isQuitting: false,
        trayUsable: true,
        preference: 'quit',
      }),
    ).toEqual({ quit: true, reason: 'preference' });

    expect(
      decideAllWindowsClosed({
        platform: 'win32',
        isQuitting: false,
        trayUsable: false,
        trayProblem: 'no-tray',
        preference: 'quit',
      }),
    ).toEqual({ quit: true, reason: 'preference' });
  });

  it('stays alive on the tray when the setting says hide', () => {
    // The other direction of the same fix: "hide to tray" must not become a
    // quit just because the preference is now read here.
    expect(
      decideAllWindowsClosed({
        platform: 'linux',
        isQuitting: false,
        trayUsable: true,
        preference: 'hide_to_tray',
      }),
    ).toEqual({ quit: false, reason: 'tray-keeps-it-alive' });
  });

  it('quits when there is no tray to hide to', () => {
    expect(
      decideAllWindowsClosed({
        platform: 'win32',
        isQuitting: false,
        trayUsable: false,
        trayProblem: 'icon-empty',
        preference: 'hide_to_tray',
      }),
    ).toEqual({ quit: true, reason: 'icon-empty' });

    expect(
      decideAllWindowsClosed({
        platform: 'linux',
        isQuitting: false,
        trayUsable: false,
        preference: 'hide_to_tray',
      }),
    ).toEqual({ quit: true, reason: 'no-tray' });
  });

  it('keeps the macOS Dock convention, but not over the user\'s choice', () => {
    expect(
      decideAllWindowsClosed({
        platform: 'darwin',
        isQuitting: false,
        trayUsable: false,
        preference: 'hide_to_tray',
      }),
    ).toEqual({ quit: false, reason: 'macos-dock' });

    expect(
      decideAllWindowsClosed({
        platform: 'darwin',
        isQuitting: false,
        trayUsable: true,
        preference: 'quit',
      }),
    ).toEqual({ quit: true, reason: 'preference' });
  });

  it('lets an exit in flight through, whatever the setting says', () => {
    // During a real quit the windows close *while* quitting. Answering "stay"
    // here would be the same defect one event later, so the flag is checked
    // first — and it is why the handler may skip the settings read entirely.
    for (const preference of ['hide_to_tray', 'quit'] as const) {
      expect(
        decideAllWindowsClosed({
          platform: 'darwin',
          isQuitting: true,
          trayUsable: true,
          preference,
        }),
      ).toEqual({ quit: true, reason: 'quitting' });
    }
  });
});

/**
 * And the handler above is only worth having if Main calls it.
 *
 * The expression it replaces — `platform !== 'darwin' && !trayUsable` — is the
 * exact shape that shipped the defect, so it is asserted *absent*: a future
 * edit that goes back to reading the tray alone turns this red instead of
 * returning the bug to a real desktop where only a person would find it.
 */
describe('the last-window rule is wired into the lifecycle', () => {
  const bootstrapSource = readFileSync(
    join(repoRoot, 'apps', 'desktop', 'src', 'main', 'bootstrap.ts'),
    'utf8',
  );
  const allClosed = /app\.on\('window-all-closed',[\s\S]*?\n\}\);/.exec(bootstrapSource)?.[0];

  it('decides through decideAllWindowsClosed', () => {
    expect(allClosed, 'bootstrap.ts has no window-all-closed listener').toBeDefined();
    expect(allClosed).toContain('decideAllWindowsClosed(');
    expect(allClosed).toMatch(/if \(decision\.quit\) app\.quit\(\);/);
  });

  it('no longer quits on the tray alone', () => {
    expect(bootstrapSource).not.toContain("process.platform !== 'darwin' && !trayUsable");
  });

  it('does not defer a quit that has nothing to tear down', () => {
    // The other half of "quit that did not quit": `before-quit` used to
    // `preventDefault()` and then await `ucad?.dispose()`, so a quit arriving
    // before the container existed was cancelled and never re-issued.
    const beforeQuit = /app\.on\('before-quit',[\s\S]*?\n\}\);/.exec(bootstrapSource)?.[0];
    expect(beforeQuit, 'bootstrap.ts has no before-quit listener').toBeDefined();
    const earlyReturnAt = beforeQuit!.indexOf('if (!container) return;');
    const preventAt = beforeQuit!.indexOf('event.preventDefault()');

    expect(earlyReturnAt, 'before-quit defers before checking for a container').toBeGreaterThanOrEqual(0);
    expect(earlyReturnAt).toBeLessThan(preventAt);
    expect(beforeQuit).not.toContain('ucad\n    ?.dispose()');
  });
});
