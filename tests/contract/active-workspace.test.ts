/**
 * Workspace-scoped operations must follow the project that is open.
 *
 * ## Why this file exists
 *
 * "The first row of `listWorkspaces()`" is not "the project the user is working
 * in". The list is ordered by `last_opened_at`, so any code path that touches a
 * row can put a different project first — and then:
 *
 *  - `workspace.setTrust` grants trust to one project while another is on
 *    screen;
 *  - `mcp:upsert({ scope: 'workspace' })` scopes a server to the wrong project.
 *
 * Both were real: `app-container.ts` already tracks the activated workspace in
 * `activeWorkspaceId` (exposed as `currentWorkspaceId`), and both handlers
 * ignored it in favour of `listWorkspaces()[0]`. These tests set up exactly the
 * state that makes the two disagree — two projects, the *other* one first in
 * the list — and assert the handler changes the active one.
 *
 * The rows are real: a real `SessionStore` over a real SQLite file. The
 * activation itself is stubbed because this surface only needs the id it
 * records; the real activation path is covered by `workspace-activation.test.ts`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * The channels Main registers, captured from the mocked `ipcMain`.
 *
 * `vi.hoisted` because `vi.mock` is lifted above the imports: the factory may
 * not close over an ordinary top-level binding.
 */
const { mainHandlers } = vi.hoisted(() => ({
  mainHandlers: new Map<string, (...args: unknown[]) => unknown>(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      mainHandlers.set(channel, fn);
    },
    removeHandler: () => {},
  },
  dialog: {
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    showSaveDialog: async () => ({ canceled: true }),
    showMessageBox: async () => ({ response: 1 }),
  },
  BrowserWindow: class {},
}));

import { Database } from '@ucad/storage';
import { SessionStore } from '@ucad/session';
import { McpManager } from '@ucad/mcp';
import { IPC_CHANNELS } from '@ucad/contracts';
import { Logger, MemoryLogSink, silentLogger } from '@ucad/observability';
import { registerIpc } from '../../apps/desktop/src/main/ipc';
import { registerMcpIpc } from '../../apps/desktop/src/main/ipc-mcp';
import type { UcadApp } from '../../apps/desktop/src/main/app-container';
import type { Locale } from '../../apps/desktop/src/shared/i18n';

let dir: string;
let db: Database;
let store: SessionStore;
let manager: McpManager;
let projectA: string;
let projectB: string;

/**
 * The container surface these handlers read, with the active project mutable.
 *
 * `currentWorkspaceId` is a getter so the value is read at handler time, the
 * same as the real container.
 */
function fakeApp(logger = silentLogger('active-workspace')) {
  const state: { activeId: string | undefined } = { activeId: undefined };
  const app = {
    sessionStore: store,
    logger,
    get currentWorkspaceId(): string | undefined {
      return state.activeId;
    },
    async activateWorkspace(id: string) {
      state.activeId = id;
      return store.getWorkspace(id);
    },
    setActive(id: string | undefined) {
      state.activeId = id;
    },
  };
  return app;
}

/** Runs `registerIpc` against the mocked `ipcMain` and returns the handlers. */
function ipcHandlers(app: ReturnType<typeof fakeApp>) {
  mainHandlers.clear();
  registerIpc(app as unknown as UcadApp, () => null, {
    getLocale: (): Locale => 'zh-CN',
    setLocale: () => {},
    getUpdates: () => null,
    getVersion: () => '1.0.0',
  });
  return mainHandlers;
}

/** The MCP surface on its own, with the same container and real settings. */
function mcpHandlers(app: ReturnType<typeof fakeApp>) {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  registerMcpIpc({
    handle: (channel, fn) => handlers.set(channel, fn),
    // The registry's health overlay is stored through the real `SessionStore`,
    // so `persist()` runs against the same settings document a restart reads.
    ucad: { ...app, db, mcp: manager } as unknown as UcadApp,
    getWindow: () => null,
  });
  return handlers;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucad-active-ws-'));
  projectA = path.join(dir, 'project-a');
  projectB = path.join(dir, 'project-b');
  fs.mkdirSync(projectA);
  fs.mkdirSync(projectB);

  db = new Database({ dbPath: path.join(dir, 'ucad.db'), logger: silentLogger('test') });
  db.migrate();
  store = new SessionStore({ db, logger: silentLogger('test') });
  manager = new McpManager({ db, logger: silentLogger('test') });
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * Two projects, with the *inactive* one first in `listWorkspaces()`.
 *
 * This is the arrangement that makes the two answers disagree. It is forced
 * through `last_opened_at` rather than by insertion order, because insertion
 * order inside the same millisecond is not something a test should rely on.
 */
function twoProjects(inactiveFirst: 'A' | 'B' = 'B') {
  const a = store.upsertWorkspace({ path: projectA, name: 'project-a' });
  const b = store.upsertWorkspace({ path: projectB, name: 'project-b' });
  const first = inactiveFirst === 'B' ? b : a;
  db.driver.run('UPDATE workspaces SET last_opened_at = ? WHERE id = ?', [
    '2999-01-01T00:00:00.000Z',
    first.id,
  ]);
  return { a, b, first };
}

describe('workspace.setTrust trusts the project that is open', () => {
  it('changes the active project, not the first row in the list', async () => {
    const { a, b, first } = twoProjects();
    // The fixture is the point: the list and the active project disagree.
    expect(store.listWorkspaces()[0]!.id).toBe(first.id);

    const app = fakeApp();
    app.setActive(a.id);
    const setTrust = ipcHandlers(app).get(IPC_CHANNELS.workspace.setTrust)!;
    expect(setTrust, 'workspace:setTrust is not registered').toBeDefined();

    // The registered wrapper mirrors `ipcMain.handle`: the event comes first.
    const updated = (await setTrust(null, 'trusted')) as { id: string };

    expect(updated.id).toBe(a.id);
    expect(store.getWorkspace(a.id)!.trustState).toBe('trusted');
    expect(store.getWorkspace(b.id)!.trustState).toBe('untrusted');
  });

  it('refuses when no project is open, instead of choosing one', async () => {
    const { a, b } = twoProjects();
    const app = fakeApp();
    app.setActive(undefined);

    const setTrust = ipcHandlers(app).get(IPC_CHANNELS.workspace.setTrust)!;
    await expect(setTrust(null, 'trusted')).rejects.toThrow(/没有已打开的项目/);

    // Nothing was trusted as a side effect of the refusal.
    expect(store.getWorkspace(a.id)!.trustState).toBe('untrusted');
    expect(store.getWorkspace(b.id)!.trustState).toBe('untrusted');
  });
});

describe('mcp:upsert scopes a workspace server to the open project', () => {
  it('writes the active workspace id into scope_ref', async () => {
    const { a, b, first } = twoProjects();
    expect(store.listWorkspaces()[0]!.id).toBe(first.id);

    const app = fakeApp();
    app.setActive(a.id);
    const upsert = mcpHandlers(app).get(IPC_CHANNELS.mcp.upsert)!;
    expect(upsert, 'mcp:upsert is not registered').toBeDefined();

    const saved = (await upsert({
      scope: 'workspace',
      name: 'project server',
      exposure: 'ucad_internal',
      transport: 'stdio',
      command: process.execPath,
    })) as { id: string };

    const row = db.driver.get<{ scope_ref: string | null }>(
      'SELECT scope_ref FROM mcp_servers WHERE id = ?',
      [saved.id],
    );
    expect(row?.scope_ref).toBe(a.id);
    expect(row?.scope_ref).not.toBe(b.id);
  });

  it('refuses a workspace-scoped server when no project is open', async () => {
    twoProjects();
    const app = fakeApp();
    app.setActive(undefined);

    const upsert = mcpHandlers(app).get(IPC_CHANNELS.mcp.upsert)!;
    // The MCP surface registers the handler itself, so a refusal is a plain
    // synchronous throw rather than a rejected promise.
    expect(() =>
      upsert({
        scope: 'workspace',
        name: 'orphan server',
        exposure: 'ucad_internal',
        transport: 'stdio',
        command: process.execPath,
      }),
    ).toThrow(/请先打开一个项目/);

    const count = db.driver.get<{ n: number }>('SELECT COUNT(*) AS n FROM mcp_servers');
    expect(count?.n).toBe(0);
  });
});

describe('workspace:activate answers with the activation, not with the request', () => {
  it('reports superseded and names the project that is in force', async () => {
    const { a, b } = twoProjects();
    const app = fakeApp();
    app.setActive(a.id);

    // The container maps a `superseded` activator outcome to the project that
    // actually won. The handler used to return the freshly upserted row
    // instead, so the Renderer was told "you are on A" while B's code was the
    // one loaded — and Recent Projects navigates on exactly that answer.
    app.activateWorkspace = async () => ({
      ...store.getWorkspace(b.id)!,
      activation: 'superseded',
      requestedWorkspaceId: a.id,
    });

    const activate = ipcHandlers(app).get(IPC_CHANNELS.workspace.activate)!;
    const answer = (await activate(null, a.id)) as {
      id: string;
      activation: string;
      requestedWorkspaceId?: string;
    };

    expect(answer.id).toBe(b.id);
    expect(answer.activation).toBe('superseded');
    expect(answer.requestedWorkspaceId).toBe(a.id);
  });
});

describe('reopening a project reuses its row (§8.1)', () => {
  it('activating the same path twice does not add a second recent project', async () => {
    const { a } = twoProjects();
    const app = fakeApp();
    app.setActive(a.id);
    const activate = ipcHandlers(app).get(IPC_CHANNELS.workspace.activate)!;
    expect(activate, 'workspace:activate is not registered').toBeDefined();

    const first = (await activate(null, a.id)) as { id: string };
    const second = (await activate(null, a.id)) as { id: string };

    expect(second.id).toBe(first.id);
    expect(second.id).toBe(a.id);
    // Two projects were seeded; activation must not have made a third row.
    expect(store.listWorkspaces()).toHaveLength(2);
  });
});

/**
 * What the log says about a refusal.
 *
 * Every handler is wrapped once in `ipc.ts`, and the wrapper logs the channel
 * and the error's `code` before it converts the failure into the user-facing
 * sentence that crosses the bridge. Until the refusals here were given codes,
 * that line said `UNKNOWN` — so "the project is gone", "no project is open" and
 * "the provider exploded" were the same entry in the log, and the sentence was
 * the only thing telling them apart.
 *
 * The code cannot be asserted on the thrown value: Electron carries an `Error`
 * across the bridge by its message alone, and the wrapper deliberately answers
 * with the user-safe sentence. The log line is the observable, so that is what
 * this asserts — through a real `Logger` and a `MemoryLogSink`, the same pair
 * the app builds.
 */
describe('an IPC refusal is logged under a stable code', () => {
  /** The last `ipc handler failed` record for one channel. */
  function refusal(sink: MemoryLogSink, channel: string) {
    return sink.records
      .filter((record) => record.msg === 'ipc handler failed' && record.meta?.['channel'] === channel)
      .pop();
  }

  it('logs NO_ACTIVE_WORKSPACE when a trust change has no project to apply to', async () => {
    twoProjects();
    const sink = new MemoryLogSink();
    const app = fakeApp(new Logger({ scope: 'test', sink }));
    app.setActive(undefined);

    const setTrust = ipcHandlers(app).get(IPC_CHANNELS.workspace.setTrust)!;
    await expect(setTrust(null, 'trusted')).rejects.toThrow(/没有已打开的项目/);

    const record = refusal(sink, IPC_CHANNELS.workspace.setTrust);
    expect(record, 'no refusal was logged').toBeDefined();
    expect(record?.meta?.['code']).toBe('NO_ACTIVE_WORKSPACE');
    // The user's sentence is unchanged: this step adds a code, it does not
    // reword the interface.
    expect(record?.meta?.['message']).toBe('没有已打开的项目');
  });

  it('logs WORKSPACE_NOT_FOUND when the requested project has no row', async () => {
    twoProjects();
    const sink = new MemoryLogSink();
    const app = fakeApp(new Logger({ scope: 'test', sink }));

    const activate = ipcHandlers(app).get(IPC_CHANNELS.workspace.activate)!;
    await expect(activate(null, 'ws_does_not_exist')).rejects.toThrow(/项目不存在/);

    expect(refusal(sink, IPC_CHANNELS.workspace.activate)?.meta?.['code']).toBe(
      'WORKSPACE_NOT_FOUND',
    );
  });
});
