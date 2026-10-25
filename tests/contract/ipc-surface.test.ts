/**
 * Three lists describe one surface, and they have to agree.
 *
 * ## Why this file exists
 *
 * Every callable channel is written down three times:
 *
 *  1. `IPC_CHANNELS` in `@ucad/contracts` — the names and the `UcadApi` shape;
 *  2. `apps/desktop/src/preload/preload.ts` — the methods the Renderer is
 *     actually given;
 *  3. `apps/desktop/src/main/ipc*.ts` — the `handle(...)` registrations.
 *
 * Nothing in the type system connects (3) to (1): `handle` takes a plain
 * `string`, so a channel declared in the contract and never registered throws
 * 「No handler registered」 at the worst possible moment — after the user clicks.
 * The opposite failure is quieter: a handler that is registered but not exposed
 * is dead code, and a preload method that calls a channel the contract does not
 * declare is a bridge method nobody can find by reading the contract.
 *
 * This test walks all three by executing them rather than by parsing source:
 * the mocked `ipcMain` records what Main registers, and the mocked
 * `contextBridge`/`ipcRenderer` record what the real preload module exposes and
 * which channels each method invokes. A new channel is covered the moment it is
 * added to the contract, and a forgotten registration fails here instead of in
 * the packaged app.
 */

import { describe, it, expect, vi } from 'vitest';

const { mainHandlers, invokeChannels, subscribedChannels, bridge } = vi.hoisted(() => ({
  mainHandlers: new Map<string, (...args: unknown[]) => unknown>(),
  invokeChannels: [] as string[],
  subscribedChannels: [] as string[],
  bridge: { key: '', api: undefined as unknown },
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      mainHandlers.set(channel, fn);
    },
    removeHandler: () => {},
  },
  ipcRenderer: {
    invoke: (channel: string) => {
      invokeChannels.push(channel);
      return Promise.resolve(undefined);
    },
    on: (channel: string) => {
      subscribedChannels.push(channel);
    },
    removeListener: () => {},
  },
  contextBridge: {
    exposeInMainWorld: (key: string, api: unknown) => {
      bridge.key = key;
      bridge.api = api;
    },
  },
  dialog: {
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    showSaveDialog: async () => ({ canceled: true }),
    showMessageBox: async () => ({ response: 1 }),
  },
  BrowserWindow: class {},
}));

import { IPC_CHANNELS, IPC_PUSH } from '@ucad/contracts';
import { registerIpc } from '../../apps/desktop/src/main/ipc';
import type { UcadApp } from '../../apps/desktop/src/main/app-container';
import '../../apps/desktop/src/preload/preload';
import type { Locale } from '../../apps/desktop/src/shared/i18n';

/** Flattens a two-level channel namespace into `namespace.method` names. */
function flatten(group: Record<string, Record<string, string>>): Set<string> {
  const out = new Set<string>();
  for (const [namespace, channels] of Object.entries(group)) {
    for (const name of Object.keys(channels)) out.add(`${namespace}.${name}`);
  }
  return out;
}

const contract = flatten(IPC_CHANNELS as unknown as Record<string, Record<string, string>>);

/** Main registers every handler at start-up; nothing here calls one. */
registerIpc({} as UcadApp, () => null, {
  getLocale: (): Locale => 'zh-CN',
  setLocale: () => {},
  getUpdates: () => null,
  getVersion: () => '1.0.0',
});

/**
 * The APIs are thin wrappers over `invoke`/`subscribe`; calling each with its
 * callback-shaped argument is enough to record the channel it uses.
 */
function recordPreloadCalls(api: Record<string, Record<string, unknown>>): void {
  for (const group of Object.values(api)) {
    for (const method of Object.values(group)) {
      if (typeof method === 'function') (method as (arg?: unknown) => unknown)(() => {});
    }
  }
}

const api = bridge.api as Record<string, Record<string, unknown>>;
recordPreloadCalls(api);

/**
 * Channel -> `namespace.method`.
 *
 * The contract names the channel values, the registrations and the preload
 * calls talk in those values, so everything is compared in the same currency.
 */
const channelToName = new Map<string, string>();
for (const [namespace, channels] of Object.entries(
  IPC_CHANNELS as unknown as Record<string, Record<string, string>>,
)) {
  for (const [name, channel] of Object.entries(channels)) {
    channelToName.set(channel, `${namespace}.${name}`);
  }
}

const registered = new Set([...mainHandlers.keys()].map((c) => channelToName.get(c) ?? c));
const invoked = new Set(invokeChannels.map((c) => channelToName.get(c) ?? c));

describe('IPC surface — contract, preload and Main agree', () => {
  it('exposes the API under the documented global', () => {
    expect(bridge.key).toBe('ucad');
    expect(typeof api).toBe('object');
  });

  it('Main registers exactly the channels the contract declares', () => {
    const missing = [...contract].filter((name) => !registered.has(name)).sort();
    const stray = [...registered].filter((name) => !contract.has(name)).sort();
    // A missing entry is 「No handler registered」 the first time the Renderer
    // calls it; a stray one is a channel no contract test polices.
    expect({ missing, stray }).toEqual({ missing: [], stray: [] });
  });

  it('the preload invokes exactly the channels the contract declares', () => {
    const missing = [...contract].filter((name) => !invoked.has(name)).sort();
    const stray = [...invoked].filter((name) => !contract.has(name)).sort();
    // Missing: a namespace the preload forgot to expose (the method exists in
    // `UcadApi` but not in the bridge). Stray: a bridge method that calls a
    // channel the contract does not know about.
    expect({ missing, stray }).toEqual({ missing: [], stray: [] });
  });

  it('every preload subscription is a declared push channel (or the menu hop)', () => {
    // Main -> Renderer channels are not in `IPC_CHANNELS`; they are pushed and
    // subscribed instead. `menu:command` is the one hop that lives in
    // `ipc-menus.ts` because the preload cannot import a Main module.
    const declared = new Set(Object.values(IPC_PUSH) as string[]);
    declared.add('menu:command');
    const stray = [...new Set(subscribedChannels)].filter((c) => !declared.has(c)).sort();
    expect(stray).toEqual([]);
  });
});
