/**
 * The native application menu.
 *
 * A desktop app with no menu is not navigable: a user who does not already
 * know the shortcuts cannot discover that a project can be opened, that the
 * current run can be stopped, or that the app has an updater. Every action
 * below dispatches a real IPC command to the Renderer, so the menu is a peer
 * of the UI rather than a decoration.
 *
 * The menu is rebuilt whenever the locale changes, so switching language in
 * Settings relabels the menu too.
 */

import { Menu, BrowserWindow, app, shell, type MenuItemConstructorOptions } from 'electron';
import { IPC_MENU } from './ipc-menus';
import { createTranslator, type Locale } from '../shared/i18n';

export interface MenuDeps {
  getWindow: () => BrowserWindow | null;
  getLocale: () => Locale;
  getVersion: () => string;
  isTrusted: () => boolean;
}

const LOCALE_LABELS: Record<Locale, string> = {
  'zh-CN': '简体中文',
  'en-US': 'English',
};

function send(deps: MenuDeps, command: string, payload?: unknown): void {
  const win = deps.getWindow();
  // A menu command with no window has nowhere to go; opening a new one would be
  // surprising, so this is deliberately a no-op rather than a new window.
  if (!win) return;
  win.webContents.send(IPC_MENU.command, { command, payload });
}

export function installApplicationMenu(deps: MenuDeps): void {
  const build = (): Menu => {
    const t = createTranslator(deps.getLocale());
    const isMac = process.platform === 'darwin';

    const template: MenuItemConstructorOptions[] = [];

    if (isMac) {
      template.push({
        label: t('app.name'),
        submenu: [
          { role: 'about' },
          { type: 'separator' },
          {
            label: t('settings.checkUpdate'),
            click: () => send(deps, 'check-update'),
          },
          { type: 'separator' },
          { role: 'services' },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' },
        ],
      });
    }

    template.push({
      label: t('menu.file'),
      submenu: [
        {
          label: t('menu.file.openProject'),
          accelerator: 'CmdOrCtrl+O',
          click: () => send(deps, 'open-project'),
        },
        {
          label: t('menu.file.newSession'),
          accelerator: 'CmdOrCtrl+N',
          click: () => send(deps, 'new-session'),
        },
        { type: 'separator' },
        {
          label: t('menu.file.export'),
          accelerator: 'CmdOrCtrl+E',
          click: () => send(deps, 'export-session'),
        },
        { type: 'separator' },
        {
          label: t('settings.language'),
          submenu: (['zh-CN', 'en-US'] as const).map((locale) => ({
            label: LOCALE_LABELS[locale],
            type: 'radio' as const,
            checked: deps.getLocale() === locale,
            click: () => send(deps, 'set-locale', locale),
          })),
        },
        ...(isMac
          ? []
          : ([
              { type: 'separator' as const },
              {
                label: t('settings.title'),
                accelerator: 'CmdOrCtrl+,',
                click: () => send(deps, 'open-settings'),
              },
              {
                label: t('menu.file.quit'),
                accelerator: 'Alt+F4',
                click: () => app.quit(),
              },
            ] as MenuItemConstructorOptions[])),
      ],
    });

    template.push({
      label: t('menu.edit'),
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        ...(isMac
          ? [{ role: 'selectAll' } as MenuItemConstructorOptions]
          : ([
              { type: 'separator' } as MenuItemConstructorOptions,
              { role: 'selectAll' } as MenuItemConstructorOptions,
            ])),
        { type: 'separator' },
        {
          label: t('session.handoff'),
          accelerator: 'CmdOrCtrl+Shift+H',
          click: () => send(deps, 'create-handoff'),
        },
      ],
    });

    template.push({
      label: t('menu.view'),
      submenu: [
        {
          label: t('tab.explorer'),
          accelerator: 'CmdOrCtrl+Shift+E',
          click: () => send(deps, 'navigate', 'explorer'),
        },
        {
          label: t('tab.changes'),
          accelerator: 'CmdOrCtrl+Shift+G',
          click: () => send(deps, 'navigate', 'changes'),
        },
        {
          label: t('tab.context'),
          accelerator: 'CmdOrCtrl+Shift+C',
          click: () => send(deps, 'navigate', 'context'),
        },
        {
          label: t('tab.decision'),
          accelerator: 'CmdOrCtrl+Shift+D',
          click: () => send(deps, 'navigate', 'decision'),
        },
        { type: 'separator' },
        {
          label: t('composer.stop'),
          accelerator: 'CmdOrCtrl+.',
          click: () => send(deps, 'stop-turn'),
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    });

    template.push({
      label: t('menu.help'),
      role: 'help',
      submenu: [
        {
          label: t('menu.help.quickStart'),
          accelerator: 'F1',
          click: () => send(deps, 'navigate', 'help'),
        },
        {
          label: t('menu.help.shortcuts'),
          accelerator: 'CmdOrCtrl+/',
          click: () => send(deps, 'navigate', 'help'),
        },
        { type: 'separator' },
        {
          label: t('menu.help.checkUpdate'),
          ...(isMac ? {} : { accelerator: 'CmdOrCtrl+U' }),
          click: () => send(deps, 'check-update'),
        },
        {
          label: t('menu.help.about'),
          click: () => {
            void shell.openExternal('https://github.com/ucad');
          },
        },
        { type: 'separator' },
        {
          label: t('diagnostics.openDataDir'),
          click: () => {
            void shell.openPath(app.getPath('userData'));
          },
        },
      ],
    });

    return Menu.buildFromTemplate(template);
  };

  const apply = (): void => {
    Menu.setApplicationMenu(build());
  };

  apply();
  // `language-changed` is a documented Electron event; `ucad:locale-changed` is
  // ours, emitted when the user switches from Settings. Both rebuild the menu so
  // a language change is visible outside the window too. Electron's typed
  // `app.on` overloads only accept its own event names, so the emitter is
  // reached through the untyped EventEmitter signature.
  const emitter = app as unknown as {
    on(event: string, listener: () => void): unknown;
  };
  emitter.on('language-changed', apply);
  emitter.on('ucad:locale-changed', apply);
}
