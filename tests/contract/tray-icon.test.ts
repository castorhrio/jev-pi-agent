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
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadTrayIcon,
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
