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
import { IPC_PUSH, describeError, type CloseBehaviour, type TurnEvent } from '@ucad/contracts';
import type { Logger } from '@ucad/observability';
import { FileLogSink, Logger as UcadLogger, MemoryLogSink, MultiLogSink } from '@ucad/observability';
import { ADAPTER_LOAD_ORDER } from './adapter-candidates';
import { adapterSearchPaths, resolveAdapterModules } from './adapter-resolution';
import { UcadApp } from './app-container';
import { resolvePaths } from './paths';
import { registerIpc } from './ipc';
import { installApplicationMenu } from './menu';
import { UpdateService, type UpdateStatus } from './update-service';
import { resolveUpdateFeed } from './update-feed';
import { loadTrayIcon, shouldPreventWindowClose, type TrayProblem } from './tray-icon';
import { evaluateNavigation, evaluateWindowOpen } from './navigation-guard';
import { IPC_MENU } from './ipc-menus';
import { createTranslator, negotiateLocale, type Locale } from '../shared/i18n';

const isDev = !app.isPackaged;

/** The packaged configuration that names the release feed. */
const UPDATE_CONFIG_FILE = 'update-config.json';
/** The feed is read on every check; it is announced once. */
let updateFeedLogged = false;
/** A refused `UCAD_UPDATE_FEED` is equally worth saying once, not per check. */
let updateFeedRejectedLogged = false;

let mainWindow: BrowserWindow | null = null;
let ucad: UcadApp | null = null;
/** set once the container is up; used for renderer diagnostics before that. */
let appLog: Logger | null = null;
let updates: UpdateService | null = null;
let tray: Tray | null = null;
/**
 * Whether a *usable* tray exists: one that was created and whose icon decoded.
 *
 * A tray slot with an invisible icon is not a tray — hiding the window there
 * strands the app with nothing to click — so the two are tracked separately and
 * the decision below treats them as one.
 */
let trayUsable = false;
/** Why the tray is unusable, when it is. */
let trayProblem: TrayProblem | undefined;
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
 * What closing the window does.
 *
 * The default is **hide to tray**: a long agent run is not something a user
 * wants to kill by clicking the X, and a desktop agent that silently
 * disappears is a desktop agent that looks broken. Quitting is explicit — the
 * tray menu, or the menu bar's File → Quit.
 *
 * The default is only the default: Settings → 关闭窗口时 can change it, and the
 * setting is read when the window closes so a change takes effect at once.
 */
function closePreference(): CloseBehaviour {
  try {
    return ucad?.sessionStore.getSettings().window.closeBehaviour ?? 'hide_to_tray';
  } catch (error) {
    // An unreadable settings document must not decide the app's exit
    // behaviour by accident; the documented default is the safe one.
    appLog?.warn('close behaviour could not be read; using the default', {
      error: describeError(error),
    });
    return 'hide_to_tray';
  }
}

/**
 * Whether this close must be cancelled so the window hides instead of dying.
 *
 * The decision lives in `tray-icon.ts` as a pure function, so the branches that
 * matter are testable without Electron: an icon that did not decode must never
 * become a place to hide, and a real exit — `before-quit`, from the Dock, the
 * menu bar or an OS shutdown — must never be cancelled by the hide-to-tray
 * default. `isQuitting` is read first there precisely because it outranks the
 * preference.
 */
function shouldPreventClose(): boolean {
  return shouldPreventWindowClose({
    isQuitting: appState.isQuitting === true,
    trayUsable,
    preference: closePreference(),
    ...(trayProblem ? { trayProblem } : {}),
  });
}

/**
 * The adapters this build could load, by id.
 *
 * Resolution lives in `adapter-resolution.ts` — where the search paths can be
 * asserted from a Node test instead of discovered from a log line after an
 * Electron boot — and this function only supplies the three facts about *this*
 * process that the search depends on. Nothing else in Main knows where an
 * adapter is loaded from.
 *
 * **`write` is deliberately not passed.** The resolver's `write` option is the
 * diagnostic channel for the "could not be resolved" line and the
 * "adapters resolved:" summary; left unset, it defaults to `console.error`,
 * which is where a person who launched the app from a terminal is already
 * looking. Adapter resolution runs *before* the container exists, so the only
 * logger available here is `bootLog`, a file-plus-memory sink — and a failure
 * that lands only in `app.log` is a failure nobody sees until they go looking.
 * Passing `write` here (or defaulting it from `log`) would quietly remove the
 * one channel that survives "the app started with no adapter at all". See the
 * `write` field in `adapter-resolution.ts` for why both channels exist.
 *
 * `bootLog` itself is bootstrap-scoped: it exists only until the container is
 * constructed below, after which `ucad.logger` (and its `appLog` child) takes
 * over every diagnostic in this file.
 */
function loadAdapterModules(log?: Logger): Record<string, string> {
  return resolveAdapterModules({
    searchPaths: adapterSearchPaths({
      appPath: app.getAppPath(),
      mainDir: __dirname,
      cwd: process.cwd(),
    }),
    log,
  }).modules;
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
    // An app that is really quitting must never be talked out of it: hiding
    // here would leave the process with no window and no tray, the "alive but
    // unreachable" failure this file exists to prevent. `shouldPreventClose()`
    // checks the quit flag itself, so the ordering cannot drift.
    if (!shouldPreventClose()) return;
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

  // External links open in the user's browser, never inside the app shell. The
  // rule lives in `navigation-guard.ts` (same reason as `will-navigate` below):
  // `window.open()` always gets `deny`, and only `http(s)` reaches the browser.
  // A `file:` or `javascript:` target used to be refused here too, but by a
  // regex — which is a spelling check, not a protocol check.
  win.webContents.setWindowOpenHandler(({ url }) => {
    const verdict = evaluateWindowOpen(url);
    if (verdict.reason !== 'external-link') {
      appLog?.warn('refused a window open from the app document', {
        url,
        reason: verdict.reason,
      });
    } else {
      void shell.openExternal(url);
    }
    return { action: verdict.action };
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
  //
  // The rule itself lives in `navigation-guard.ts` because it is a security
  // boundary, and a boundary that can only be checked by booting Electron is a
  // boundary nobody checks. It compares origins, not string prefixes:
  // `http://localhost:52730.evil` and `file:///…/index.html.evil` both start
  // with our own URL and both point somewhere else.
  win.webContents.on('will-navigate', (event, url) => {
    const own = devServer ? devUrl : win.webContents.getURL();
    const verdict = evaluateNavigation(url, own);
    if (!verdict.allow) {
      appLog?.warn('refused a navigation away from the app document', {
        url,
        own,
        reason: verdict.reason,
      });
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
  ucad = new UcadApp({ paths, adapterModules: loadAdapterModules(bootLog) });
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
  //
  // The ids come from `ADAPTER_LOAD_ORDER`, not from a literal list here. They
  // were spelled out in this loop, which made a third copy of the adapter list:
  // an adapter added to `ADAPTER_CANDIDATES` resolved fine and was logged in
  // "adapters resolved", and then never started, because nobody edited this
  // line. The gate in `tests/contract/adapter-candidates.test.ts` now scans
  // this file for quoted ids, so a copy here is red.
  const started: string[] = [];
  for (const agentId of ADAPTER_LOAD_ORDER) {
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
  // broken". Restore the project the user had open, so the workspace-rooted
  // subsystems are already in force for the first turn.
  await ucad.activateMostRecentWorkspace();

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
    const icon = loadTrayIcon(nativeImage, {
      platform: process.platform,
      packaged: app.isPackaged,
      mainDir: __dirname,
      resourcesPath: process.resourcesPath,
    });
    // An empty image would create a tray slot with nothing in it, and the
    // window would still hide there — the app alive but unreachable. Fail into
    // the catch below instead, which turns close-to-tray off. This is the one
    // `throw new Error()` in Main that stays: it is raised and caught inside
    // this function, never crosses the IPC bridge, and the app degrades rather
    // than reporting a failure to anyone (§4.11 codes are for the bridge).
    if (icon.empty) {
      trayProblem = 'icon-empty';
      throw new Error(`tray icon could not be decoded: ${icon.path}`);
    }
    tray = new Tray(icon.image);
    tray.setToolTip('UCAD');
    trayUsable = true;
  } catch (error) {
    // No tray (some Linux sessions, some CI) — or a tray whose icon did not
    // decode, which is the same thing with worse optics. The window then
    // quits normally instead of hiding into a slot nobody can see.
    trayUsable = false;
    trayProblem = trayProblem ?? 'no-tray';
    appLog?.warn('tray unavailable; closing the window will quit', {
      reason: trayProblem,
      error: error instanceof Error ? error.message : String(error),
    });
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
          // The flag is what tells the close handler this is a real exit and
          // not a request to get out of the way. Without it the window would
          // hide on the way down and the app would keep running with no
          // window and no way back — the "quit" that does not quit.
          appState.isQuitting = true;
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
 * The release feed.
 *
 * A released build carries its feed in `update-config.json`, which the
 * packaging step copies next to the app — so the update check works in the
 * published app without the user setting an environment variable. A
 * development build reads the same file from `apps/desktop/resources`, and
 * `UCAD_UPDATE_FEED` overrides both for anyone pointing at a private feed —
 * as long as it is https, the same rule the file is held to.
 *
 * A refused override is logged once, loudly enough to be found: the alternative
 * is an app that says "未配置更新源" while the variable the operator set sits
 * right there in the environment, which reads like the override was ignored for
 * no reason. The check runs on every update check, so the line is de-duplicated
 * like the resolved-feed line above.
 */
function readUpdateFeed(): string | null {
  const resolved = resolveUpdateFeed({
    envValue: process.env.UCAD_UPDATE_FEED,
    configPaths: updateConfigPaths(),
  });
  if (resolved.rejected && !updateFeedRejectedLogged) {
    updateFeedRejectedLogged = true;
    ucad?.logger.warn('UCAD_UPDATE_FEED ignored: the feed must be an https URL', {
      reason: resolved.rejected,
    });
  }
  if (resolved.url && !updateFeedLogged) {
    updateFeedLogged = true;
    ucad?.logger.info('update feed resolved', { source: resolved.source });
  }
  return resolved.url;
}

/**
 * Where the packaged configuration may live.
 *
 * A packaged app keeps its resources beside the asar, so that is the first
 * candidate; the second is the same file in the source tree, which is what a
 * development build sees. Both are tried, and a file that is not there is
 * simply not a candidate — a build without the file is a development build,
 * not an error.
 */
function updateConfigPaths(): string[] {
  return [
    path.join(process.resourcesPath, UPDATE_CONFIG_FILE),
    path.join(__dirname, '..', '..', 'resources', UPDATE_CONFIG_FILE),
  ];
}

app.whenReady().then(bootstrap).catch((error) => {
  // A failed migration must not leave a half-initialised app running (NFR-07).
   
  console.error('[ucad] fatal startup error', error);
  app.exit(1);
});

app.on('window-all-closed', () => {
  // On macOS the app conventionally stays alive; everywhere else the tray keeps
  // it alive. Quitting is explicit from the tray or the File menu.
  if (process.platform !== 'darwin' && !trayUsable) app.quit();
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
