/**
 * Preload — the only channel between Main and Renderer (NFR-01).
 *
 * Rules enforced here:
 *  - no `ipcRenderer` is ever handed to the Renderer (ADR-002)
 *  - no Node object crosses the bridge
 *  - subscriptions return a real unsubscribe function
 *  - there is deliberately NO secret read channel; `secrets.describe` returns
 *    metadata only
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import {
  IPC_CHANNELS,
  IPC_PUSH,
  type UcadApi,
  type Unsubscribe,
} from '@ucad/contracts';

/** Kept in sync with `src/main/ipc-menus.ts`; the preload cannot import from
 *  `src/main` because it is bundled for a sandboxed context. */
const IPC_MENU_CHANNEL = 'menu:command';

function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return ipcRenderer.invoke(channel, ...args) as Promise<T>;
}

function subscribe<T>(channel: string, cb: (payload: T) => void): Unsubscribe {
  const listener = (_e: IpcRendererEvent, payload: T) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

const api: UcadApi = {
  workspace: {
    open: () => invoke(IPC_CHANNELS.workspace.open),
    listRecent: () => invoke(IPC_CHANNELS.workspace.listRecent),
    activate: (workspaceId) => invoke(IPC_CHANNELS.workspace.activate, workspaceId),
    setTrust: (state) => invoke(IPC_CHANNELS.workspace.setTrust, state),
  },

  sessions: {
    create: (input) => invoke(IPC_CHANNELS.sessions.create, input),
    resume: (sessionId) => invoke(IPC_CHANNELS.sessions.resume, sessionId),
    list: (workspaceId) => invoke(IPC_CHANNELS.sessions.list, workspaceId),
    rename: (sessionId, title) => invoke(IPC_CHANNELS.sessions.rename, sessionId, title),
    remove: (sessionId) => invoke(IPC_CHANNELS.sessions.delete, sessionId),
    export: (sessionId, format) => invoke(IPC_CHANNELS.sessions.export, sessionId, format),
    createHandoff: (sessionId) => invoke(IPC_CHANNELS.sessions.createHandoff, sessionId),
    listHandoffs: (sessionId) => invoke(IPC_CHANNELS.sessions.listHandoffs, sessionId),
    claimHandoff: (sessionId, handoffId, agentId) =>
      invoke(IPC_CHANNELS.sessions.claimHandoff, { sessionId, handoffId, agentId }),
    completeHandoff: (sessionId, handoffId) =>
      invoke(IPC_CHANNELS.sessions.completeHandoff, { sessionId, handoffId }),
    send: (input) => invoke(IPC_CHANNELS.sessions.send, input),
    cancel: (sessionId) => invoke(IPC_CHANNELS.sessions.cancel, sessionId),
    onEvent: (cb) => subscribe(IPC_PUSH.turnEvent, cb),
  },

  events: {
    since: (input) => invoke(IPC_CHANNELS.events.since, input),
    latestSeq: (sessionId) => invoke(IPC_CHANNELS.events.latestSeq, sessionId),
  },

  agents: {
    list: () => invoke(IPC_CHANNELS.agents.list),
  },

  permissions: {
    respond: (requestId, decision) =>
      invoke(IPC_CHANNELS.permissions.respond, requestId, decision),
    listRules: (scope) => invoke(IPC_CHANNELS.permissions.listRules, scope),
    revokeRule: (ruleId) => invoke(IPC_CHANNELS.permissions.revokeRule, ruleId),
  },

  secrets: {
    set: (ref, value) => invoke(IPC_CHANNELS.secrets.set, ref, value),
    remove: (ref) => invoke(IPC_CHANNELS.secrets.delete, ref),
    describe: (ref) => invoke(IPC_CHANNELS.secrets.describe, ref),
  },

  files: {
    read: (p, opts) => invoke(IPC_CHANNELS.files.read, p, opts),
    write: (p, content, opts) => invoke(IPC_CHANNELS.files.write, p, content, opts),
    list: (dir) => invoke(IPC_CHANNELS.files.list, dir),
    watch: (p, cb) => subscribe(`${IPC_PUSH.fileChange}:${p}`, cb),
  },

  git: {
    status: (workspaceId) => invoke(IPC_CHANNELS.git.status, workspaceId),
    diff: (input) => invoke(IPC_CHANNELS.git.diff, input),
    stage: (paths) => invoke(IPC_CHANNELS.git.stage, paths),
    unstage: (paths) => invoke(IPC_CHANNELS.git.unstage, paths),
    discard: (paths) => invoke(IPC_CHANNELS.git.discard, paths),
    commit: (message) => invoke(IPC_CHANNELS.git.commit, message),
  },

  terminal: {
    create: (input) => invoke(IPC_CHANNELS.terminal.create, input),
    write: (terminalId, data) => invoke(IPC_CHANNELS.terminal.write, terminalId, data),
    kill: (terminalId) => invoke(IPC_CHANNELS.terminal.kill, terminalId),
    onData: (cb) => subscribe(IPC_PUSH.terminalData, cb),

    // §11.2 — the interactive PTY. What crosses this bridge is a chunk of text
    // and a string of keystrokes; `node-pty` itself stays in Main (NFR-01), and
    // the Renderer cannot reach a process handle, a pid, or a file descriptor.
    ptyStatus: () => invoke(IPC_CHANNELS.terminal.ptyStatus),
    ptyCreate: (input) => invoke(IPC_CHANNELS.terminal.ptyCreate, input),
    ptyWrite: (terminalId, data) => invoke(IPC_CHANNELS.terminal.ptyWrite, terminalId, data),
    ptyResize: (terminalId, cols, rows) =>
      invoke(IPC_CHANNELS.terminal.ptyResize, terminalId, cols, rows),
    ptyKill: (terminalId) => invoke(IPC_CHANNELS.terminal.ptyKill, terminalId),
    onPtyData: (cb) => subscribe(IPC_PUSH.ptyData, cb),
    onPtyExit: (cb) => subscribe(IPC_PUSH.ptyExit, cb),
  },

  intelligence: {
    listProviders: () => invoke(IPC_CHANNELS.intelligence.listProviders),
    status: (workspaceId, providerId) =>
      invoke(IPC_CHANNELS.intelligence.status, workspaceId, providerId),
    index: (workspaceId, providerId) =>
      invoke(IPC_CHANNELS.intelligence.index, workspaceId, providerId),
    refresh: (workspaceId, providerId) =>
      invoke(IPC_CHANNELS.intelligence.refresh, workspaceId, providerId),
    query: (input) => invoke(IPC_CHANNELS.intelligence.query, input),
    cancel: (operationId) => invoke(IPC_CHANNELS.intelligence.cancel, operationId),
    onEvent: (cb) => subscribe(IPC_PUSH.turnEvent, cb),
  },

  context: {
    preview: (input) => invoke(IPC_CHANNELS.context.preview, input),
    getPack: (packId) => invoke(IPC_CHANNELS.context.getPack, packId),
    extend: (input) => invoke(IPC_CHANNELS.context.extend, input),
    getInjection: (turnId) => invoke(IPC_CHANNELS.context.getInjection, turnId),
  },

  decision: {
    listEngines: () => invoke(IPC_CHANNELS.decision.listEngines),
    setChain: (engineIds) => invoke(IPC_CHANNELS.decision.setChain, engineIds),
    preview: (input) => invoke(IPC_CHANNELS.decision.preview, input),
    onEvent: (cb) => subscribe(IPC_PUSH.turnEvent, cb),
  },

  usage: {
    query: (filter) => invoke(IPC_CHANNELS.usage.query, filter),
    summary: (filter) => invoke(IPC_CHANNELS.usage.summary, filter),
    onEvent: (cb) => subscribe(IPC_PUSH.turnEvent, cb),
  },

  tools: {
    list: () => invoke(IPC_CHANNELS.tools.list),
  },

  settings: {
    get: () => invoke(IPC_CHANNELS.settings.get),
    patch: (patch) => invoke(IPC_CHANNELS.settings.patch, patch),
  },

  diagnostics: {
    info: () => invoke(IPC_CHANNELS.diagnostics.info),
  },

  // §8.4 — a transcript the user cannot delete is one the product keeps without
  // consent, so these are first-class bridge methods rather than a hidden one.
  storage: {
    usage: () => invoke(IPC_CHANNELS.storage.usage),
    setRetention: (days) => invoke(IPC_CHANNELS.storage.setRetention, days),
    previewPurge: (scope, workspaceId) =>
      invoke(IPC_CHANNELS.storage.previewPurge, scope, workspaceId),
    purge: (input) => invoke(IPC_CHANNELS.storage.purge, input),
    collectOrphanBlobs: () => invoke(IPC_CHANNELS.storage.collectOrphanBlobs),
  },

  // §10 / §12.1 — no secret *value* crosses this bridge, only a reference to an
  // already-stored credential (NFR-01).
  mcp: {
    list: (scope) => invoke(IPC_CHANNELS.mcp.list, scope),
    upsert: (input) => invoke(IPC_CHANNELS.mcp.upsert, input),
    remove: (id) => invoke(IPC_CHANNELS.mcp.remove, id),
    setEnabled: (id, enabled) => invoke(IPC_CHANNELS.mcp.setEnabled, id, enabled),
    setExposure: (id, exposure) => invoke(IPC_CHANNELS.mcp.setExposure, id, exposure),
    test: (id) => invoke(IPC_CHANNELS.mcp.test, id),
  },

  menu: {
    onCommand: (cb) => subscribe(IPC_MENU_CHANNEL, cb),
  },

  providers: {
    list: () => invoke(IPC_CHANNELS.providers.list),
    models: (providerId) => invoke(IPC_CHANNELS.providers.models, providerId),
    probe: (providerId) => invoke(IPC_CHANNELS.providers.probe, providerId),
    configured: () => invoke(IPC_CHANNELS.providers.configured),
  },

  app: {
    getLocale: () => invoke(IPC_CHANNELS.app.locale),
    setLocale: (locale) => invoke(IPC_CHANNELS.app.setLocale, locale),
    updateStatus: () => invoke(IPC_CHANNELS.app.updateStatus),
    checkUpdate: () => invoke(IPC_CHANNELS.app.checkUpdate),
    downloadUpdate: () => invoke(IPC_CHANNELS.app.downloadUpdate),
    installUpdate: () => invoke(IPC_CHANNELS.app.installUpdate),
    onUpdateStatus: (cb) => subscribe(IPC_PUSH.updateStatus, cb),
  },
};

contextBridge.exposeInMainWorld('ucad', api);
