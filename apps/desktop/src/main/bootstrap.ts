/**
 * Electron bootstrap. The only file that touches the Electron app lifecycle.
 *
 * NFR-01: the window is created with `contextIsolation: true`,
 * `nodeIntegration: false` and `sandbox: true`. The Renderer reaches Main only
 * through the typed preload bridge.
 */

import { app, BrowserWindow, shell, Tray, Menu, nativeImage } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { IPC_PUSH, describeError, type TurnEvent } from '@ucad/contracts';
import type { Logger } from '@ucad/observability';
import { FileLogSink, Logger as UcadLogger, MemoryLogSink, MultiLogSink } from '@ucad/observability';
import { UcadApp } from './app-container';
import { resolvePaths } from './paths';
import { registerIpc } from './ipc';
import { installApplicationMenu } from './menu';
import { UpdateService, type UpdateStatus } from './update-service';
import { IPC_MENU } from './ipc-menus';
import { createTranslator, negotiateLocale, type Locale } from '../shared/i18n';

const isDev = !app.isPackaged;

let mainWindow: BrowserWindow | null = null;
let ucad: UcadApp | null = null;
/** set once the container is up; used for renderer diagnostics before that. */
let appLog: Logger | null = null;
let updates: UpdateService | null = null;
let tray: Tray | null = null;
/**
 * Whether closing the window hides to tray or quits.
 *
 * Default is **hide to tray**: a long agent run is not something a user wants to
 * kill by clicking the X, and a desktop agent that silently disappears is a
 * desktop agent that looks broken. Quitting is explicit — the tray menu, or the
 * menu bar's File → Quit.
 */
let closeToTray = true;
let locale: Locale = negotiateLocale(app.getPreferredSystemLanguages?.() ?? ['zh-CN']);

/**
 * `isQuitting` is our own flag, not an Electron one. The close handler must be
 * able to tell "the user clicked X" from "the app is actually exiting",
 * otherwise `before-quit` would be swallowed by the hide-to-tray default.
 */
interface QuittableApp {
  isQuitting?: boolean;
}
const appState = app as QuittableApp;

/**
 * Adapters are resolved through Node's module resolution rather than by
 * counting `../` hops out of `dist/main`. A relative path silently breaks when
 * the build layout changes — and it cannot work at all once the app is
 * packaged, where the workspace layout no longer exists. `require.resolve`
 * follows the workspace symlink in development and the packaged `node_modules`
 * in a build, so one call covers both.
 *
 * V1 ships the mock adapter as the executable reference. A real vendor adapter
 * is added here by pointing an entry at its compiled module (ADR-017: the
 * product must not depend on any single adapter being present).
 */
function resolveAdapterModules(log?: Logger): Record<string, string> {
  const candidates: Record<string, string> = {
    // The reference adapter that actually talks to a model.
    universal: '@ucad/adapter-universal',
    // The executable specification of the protocol, for offline work and CI.
    mock: '@ucad/adapter-mock',
  };
  // Electron resolves bare specifiers against the ASAR-appended app path, which
  // is not the workspace root, so a plain `require.resolve` silently finds only
  // what the packaged app contains. Search the usual roots explicitly and give
  // every failure a search path set that can be acted on.
  const searchPaths = [
    app.getAppPath(),
    path.resolve(__dirname, '../../../..'),
    path.resolve(__dirname, '../../..'),
    process.cwd(),
  ];
  const out: Record<string, string> = {};
  for (const [id, specifier] of Object.entries(candidates)) {
    try {
      out[id] = require.resolve(specifier, { paths: searchPaths });
    } catch (error) {
      // A missing adapter must not stop the app from starting (ADR-017), but it
      // MUST be visible: a silently absent adapter is indistinguishable from a
      // broken product.
      const message = `adapter "${id}" could not be resolved`;
      // Written to stdout as well as the log: adapter resolution failing is the
      // difference between "the product is broken" and "this vendor is not
      // installed", and that distinction has to survive a log file nobody opened.
      log?.warn(message, {
        specifier,
        searched: searchPaths,
        error: describeError(error),
      });
      console.error(`[ucad] ${message}`, specifier);
    }
  }
  log?.info('adapters resolved', { resolved: Object.keys(out) });
  console.log('[ucad] adapters resolved:', Object.keys(out).join(', ') || '(none)');
  return out;
}

async function createWindow(): Promise<BrowserWindow> {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    /**
     * 768, not the 1080 this used to say, and the number is measured rather than
     * guessed.
     *
     * `minWidth: 1080` made the stylesheet's 860px breakpoint unreachable:
     * a user could never produce the width it was written for, so it was dead
     * CSS maintained by nobody and verified by nothing. The layout gate
     * (`tests/contract/layout.test.ts`) then measured the real shell at 1080,
     * 980, 900, 861, 860, 820, 768 and 700 — no horizontal overflow, no
     * collapsed region, no control pushed out of the navigation or the composer
     * at any of them, and the 860px rules (narrower rail, no search affordance)
     * visibly doing their job below 860.
     *
     * 768 is the width the design was actually built for, and it is where the
     * tightest real window lives: the narrowest width and `minHeight` together.
     * A higher minimum would only protect layouts that do not exist.
     */
    minWidth: 768,
    minHeight: 700,
    backgroundColor: '#0a0a0b',
    show: false,
    title: 'UCAD',
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });

  win.once('ready-to-show', () => win.show());

  // The user's expectation for a long-running agent app: closing the window
  // means "get it out of my way", not "kill my run". Quitting is explicit.
  win.on('close', (event) => {
    if (!closeToTray || appState.isQuitting) return;
    event.preventDefault();
    win.hide();
    if (process.platform === 'darwin') app.dock?.hide();
  });

  win.on('show', () => {
    if (process.platform === 'darwin') app.dock?.show();
  });

  // Renderer errors must be diagnosable. Without this, a blank window is
  // indistinguishable from a hung app: the main process looks perfectly healthy
  // while the UI failed to mount.
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    const text = `[renderer] ${message} (${sourceId}:${line})`;
    if (level >= 3) appLog?.error(text);
    else if (level === 2) appLog?.warn(text);
    else appLog?.debug(text);
  });

  win.webContents.on('render-process-gone', (_e, details) => {
    appLog?.error('renderer process gone', { reason: details.reason });
  });

  win.webContents.on('preload-error', (_e, preloadPath, error) => {
    appLog?.error('preload failed', { preloadPath, error: error.message });
  });

  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    appLog?.error('renderer failed to load', { code, desc, url });
  });

  // External links open in the user's browser, never inside the app shell.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  const devUrl = 'http://localhost:5273';
  const devServer = isDev && process.env.UCAD_DEV_SERVER === '1';
  // Navigation stays on the app's own page. Allowing any file:// URL let a
  // stray link (a path rendered in chat, a workspace HTML file) point the
  // window at an arbitrary local page — one that loads with UCAD's preload and
  // receives the whole bridge: files.write, terminal, secrets.set. The window
  // shows exactly one document; everything else is refused. The own URL is
  // read at event time from the webContents itself, so the check matches
  // whatever this window actually loaded (file in production, dev server in
  // dev) rather than a string this file guesses at; before the first load
  // completes it is empty and everything is refused — fail closed.
  win.webContents.on('will-navigate', (event, url) => {
    const own = devServer ? devUrl : win.webContents.getURL();
    if (!own || !url.startsWith(own)) {
      event.preventDefault();
    }
  });

  if (devServer) {
    await win.loadURL(devUrl);
  } else {
    await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  }

  return win;
}

/**
 * The product version.
 *
 * `app.getVersion()` returns the Electron version when running unpackaged, so
 * an in-development build would report "33.x" as the app's own version — and
 * the update check would compare releases against Electron, never matching.
 * `app.getAppPath()` is the directory of the entry script in dev, so the root
 * manifest is found by walking up until the workspace `package.json` appears.
 */
function productVersion(): string {
  if (app.isPackaged) return app.getVersion();
  try {
    let dir = __dirname;
    for (let depth = 0; depth < 8; depth++) {
      const candidate = path.join(dir, 'package.json');
      if (fs.existsSync(candidate)) {
        const raw = JSON.parse(fs.readFileSync(candidate, 'utf8')) as {
          name?: string;
          version?: string;
        };
        if (raw.name === 'ucad' && typeof raw.version === 'string') {
          return raw.version;
        }
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // fall through
  }
  return app.getVersion();
}

async function bootstrap(): Promise<void> {
  const paths = resolvePaths();
  // The container owns the logger, but adapter resolution must happen before
  // it, so a bootstrap-level sink stands in for the diagnostic.
  const bootLog = new UcadLogger({
    scope: 'ucad:bootstrap',
    sink: new MultiLogSink([
      new FileLogSink(path.join(paths.logDir, 'app.log')),
      new MemoryLogSink(200),
    ]),
  });
  ucad = new UcadApp({ paths, adapterModules: resolveAdapterModules(bootLog) });
  await ucad.start();
  appLog = ucad.logger.child('bootstrap');

  // The stored preference wins over the OS language, so a user who switched to
  // English keeps English across restarts.
  locale = ucad.sessionStore.getSettings().locale;

  updates = new UpdateService({
    logger: ucad.logger.child('update'),
    getFeedUrl: () => readUpdateFeed(),
    downloadDir: paths.downloadDir,
    currentVersion: productVersion(),
  });
  updates.onChange((status: UpdateStatus) => {
    mainWindow?.webContents.send('push:updateStatus', status);
  });

  registerIpc(ucad, () => mainWindow, {
    getLocale: () => locale,
    setLocale: (next: Locale) => {
      locale = next;
      app.emit('ucad:locale-changed');
    },
    getUpdates: () => updates,
    getVersion: () => productVersion(),
  });

  installApplicationMenu({
    getWindow: () => mainWindow,
    getLocale: () => locale,
    getVersion: () => productVersion(),
    isTrusted: () => true,
  });

  bootstrapTray();

  // Start the reference adapters. `universal` is the one that can actually do
  // work; `mock` is the offline/CI reference that needs no credentials.
  const started: string[] = [];
  for (const agentId of ['universal', 'mock']) {
    const manifest = await ucad.registerAgent(agentId);
    if (manifest) started.push(manifest.id);
  }
  ucad.logger.info('adapter registry ready', { started });

  mainWindow = await createWindow();
  ucad.setRendererSink((event: TurnEvent) => {
    mainWindow?.webContents.send(IPC_PUSH.turnEvent, event);
  });
  ucad.setDataSink((channel, payload) => {
    mainWindow?.webContents.send(channel, payload);
  });

  // A provider that is registered but not initialised answers every query with
  // `INTELLIGENCE_UNAVAILABLE`, which reads exactly like "code intelligence is
  // broken". Initialise it as soon as there is a workspace.
  await ucad.initCodeIntelligence();

  // §8.4: the 90-day default is only real if something enforces it. It runs
  // after crash recovery, so a session the user was halfway through is never
  // the one that gets swept, and it logs rather than throws.
  await ucad.applyRetentionOnStart();

  // Nothing is opened implicitly: UCAD never touches a folder the user did not
  // choose, so the first screen is always the Welcome / Open Project flow.
  if (updates) {
    void updates.check().catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Tray
// ---------------------------------------------------------------------------

/**
 * The tray is the app's real home once the window is closed, so it has to carry
 * the three things a user needs at a glance: that a run is in progress, how to
 * get the window back, and how to actually quit.
 */
function installTray(): void {
  if (tray) return;
  try {
    // A 1x1 transparent PNG: a generated icon is not worth failing startup for,
    // and the menu + notification area affordance is the real affordance.
    const icon = nativeImage.createFromDataURL(
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
    );
    tray = new Tray(icon);
    tray.setToolTip('UCAD');
  } catch (error) {
    // No tray (some Linux sessions, some CI). The window then quits normally.
    appLog?.warn('tray unavailable; closing the window will quit', {
      error: error instanceof Error ? error.message : String(error),
    });
    closeToTray = false;
    return;
  }

  tray.on('click', () => {
    const win = mainWindow;
    if (!win) return;
    if (win.isVisible() && win.isFocused()) win.hide();
    else {
      win.show();
      win.focus();
    }
  });

  refreshTrayMenu();
}

function refreshTrayMenu(): void {
  if (!tray) return;
  const t = createTranslator(locale);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: t('app.name'), enabled: false },
      { type: 'separator' },
      {
        label: t('tray.show'),
        click: () => {
          mainWindow?.show();
          mainWindow?.focus();
        },
      },
      {
        label: t('tray.openProject'),
        click: () => {
          mainWindow?.show();
          mainWindow?.webContents.send(IPC_MENU.command, { command: 'open-project' });
        },
      },
      { type: 'separator' },
      {
        label: t('settings.title'),
        click: () => {
          mainWindow?.show();
          mainWindow?.webContents.send(IPC_MENU.command, { command: 'open-settings' });
        },
      },
      {
        label: t('tray.quit'),
        click: () => {
          closeToTray = false;
          app.quit();
        },
      },
    ]),
  );
}

function bootstrapTray(): void {
  installTray();
  // every locale change relabels the tray too, same as the menu bar
  const emitter = app as unknown as { on(event: string, listener: () => void): unknown };
  emitter.on('ucad:locale-changed', refreshTrayMenu);
}

/**
 * The release feed. A published build gets it from the packaged config; a
 * development build can point at one with `UCAD_UPDATE_FEED`, and otherwise
 * reports "not configured" rather than pretending to check.
 */
function readUpdateFeed(): string | null {
  const fromEnv = process.env.UCAD_UPDATE_FEED?.trim();
  if (fromEnv) return fromEnv;
  return null;
}

app.whenReady().then(bootstrap).catch((error) => {
  // A failed migration must not leave a half-initialised app running (NFR-07).
   
  console.error('[ucad] fatal startup error', error);
  app.exit(1);
});

app.on('window-all-closed', () => {
  // On macOS the app conventionally stays alive; everywhere else the tray keeps
  // it alive. Quitting is explicit from the tray or the File menu.
  if (process.platform !== 'darwin' && !tray) app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void createWindow().then((win) => {
      mainWindow = win;
    });
  }
});

/*
 * Electron never awaits an async `before-quit` listener, so the teardown used
 * to race process exit: `ucad.dispose()` kills the ConPTY helpers (the one
 * thing that makes quitting work at all, per its own comment), waits out the
 * agent hosts and closes the database — any of which could still be running
 * when the loop tore down. The standard shape instead: prevent this quit, run
 * the teardown to completion, then quit again with the guard down so the
 * second attempt sails through.
 */
let teardownDone = false;
app.on('before-quit', (event) => {
  appState.isQuitting = true;
  if (teardownDone) return;
  event.preventDefault();
  void ucad
    ?.dispose()
    .catch(() => undefined)
    .finally(() => {
      teardownDone = true;
      app.quit();
    });
});
