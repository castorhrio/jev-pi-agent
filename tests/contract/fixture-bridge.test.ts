import { describe, expect, it } from 'vitest';
import { IPC_CHANNELS } from '../../packages/contracts/src/ipc';
import { SCENARIOS } from '../../apps/desktop/src/renderer/src/dev/fixture-bridge';

/**
 * The browser harness exists so the UI can be verified without
 * Electron. Its value depends entirely on the fixture implementing the *real*
 * `UcadApi` surface: a fixture missing a method turns into a panel that renders
 * fine under test and throws in the packaged app — the exact failure mode the
 * harness is supposed to catch.
 *
 * These tests are the guard against that rot.
 */

/**
 * Where the channel list and the API disagree on a name.
 *
 * Two renames, and only two, which is why this map is short enough to keep by
 * hand: the channel says `delete` where the API says `remove`, in both
 * `sessions` and `secrets`. It exists to say *why* the two differ, because
 * "they are the same thing spelled differently" is the kind of thing that gets
 * "tidied up" in one direction and silently breaks the other.
 */
const CHANNEL_TO_METHOD: Record<string, string> = {
  // `getLocale` is the API's name; the channel is just `locale`.
  'app.locale': 'getLocale',
  'sessions.delete': 'remove',
  'secrets.delete': 'remove',
};

/**
 * The methods that are subscriptions rather than calls.
 *
 * They have no IPC channel by design — the Renderer registers a listener and
 * Main pushes — so `IPC_CHANNELS` cannot list them and they have to be named.
 * This is the one part of the surface that is still hand-maintained, and it is
 * eight entries rather than the hundred it used to be.
 */
const SUBSCRIPTIONS: Record<string, string[]> = {
  sessions: ['onEvent'],
  terminal: ['onData', 'onPtyData', 'onPtyExit'],
  intelligence: ['onEvent'],
  decision: ['onEvent'],
  usage: ['onEvent'],
  menu: ['onCommand'],
  app: ['onUpdateStatus'],
};

/**
 * The API surface, derived from the contract rather than retyped.
 *
 * This used to be a hand-written `REQUIRED` object listing every namespace and
 * method, with the comment "kept honest by hand" — which is a promise nobody
 * keeps. Adding a method to `UcadApi` without adding it here left the test
 * green and the fixture missing the method, which is the exact failure the test
 * exists to prevent. Deriving from `IPC_CHANNELS` means a new channel arrives
 * already covered.
 */
function requiredSurface(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  // The union, not just the channels: `menu` is nothing but a subscription and
  // has no channel at all, so iterating `IPC_CHANNELS` alone would drop the
  // namespace and quietly stop policing it.
  const namespaces = new Set([...Object.keys(IPC_CHANNELS), ...Object.keys(SUBSCRIPTIONS)]);
  for (const namespace of namespaces) {
    const channels = (IPC_CHANNELS as Record<string, Record<string, string>>)[namespace] ?? {};
    const methods = Object.keys(channels).map(
      (method) => CHANNEL_TO_METHOD[`${namespace}.${method}`] ?? method,
    );
    out[namespace] = [...new Set([...methods, ...(SUBSCRIPTIONS[namespace] ?? [])])].sort();
  }
  return out;
}

const REQUIRED = requiredSurface();

async function loadApi(scenario: string): Promise<Record<string, Record<string, unknown>>> {
  const { createFixtureApi } = await import(
    '../../apps/desktop/src/renderer/src/dev/fixture-bridge'
  );
  return createFixtureApi(scenario as never).api as unknown as Record<
    string,
    Record<string, unknown>
  >;
}

describe('fixture bridge — a write must actually stick', () => {
  /*
   * The harness is how UI work is verified by hand. A method that accepts a
   * write and returns an unchanged object makes the product look broken while
   * reporting success — which is worse than having no harness at all, because
   * the next reader blames the app.
   *
   * `settings.patch` was the first one found, by choosing a provider,
   * reloading, and noticing the marker was gone. It was not an isolated slip:
   * every other write method had the same shape.
   *
   * The rule is deliberately behavioural rather than structural. It does not
   * check that a method "looks like" it mutates; it performs the write and then
   * reads the same fact back **through a different method**. A method could
   * satisfy any amount of source inspection and still discard the value.
   */
  const apiFor = async () => {
    const { createFixtureApi } = await import(
      '../../apps/desktop/src/renderer/src/dev/fixture-bridge'
    );
    return createFixtureApi('default').api;
  };

  it('remembers the workspace trust state', async () => {
    const api = await apiFor();
    expect((await api.workspace.open()).trustState).not.toBe('untrusted');
    await api.workspace.setTrust('untrusted');
    expect((await api.workspace.open()).trustState).toBe('untrusted');
  });

  it('remembers a saved credential and reports the provider as configured', async () => {
    const api = await apiFor();
    expect(await api.providers.configured()).not.toContain('qwen');

    await api.secrets.set({ providerId: 'qwen', key: 'api-key' }, 'sk-test');

    // Two different methods: one writes, the other reads, so this cannot pass
    // by the same object being handed back twice.
    expect(await api.providers.configured()).toContain('qwen');
    expect((await api.secrets.describe({ providerId: 'qwen', key: 'api-key' })).configured).toBe(
      true,
    );

    await api.secrets.remove({ providerId: 'qwen', key: 'api-key' });
    expect(await api.providers.configured()).not.toContain('qwen');
  });

  it('remembers a created session and honours removal', async () => {
    const api = await apiFor();
    const before = (await api.sessions.list()).length;
    const created = await api.sessions.create({
      workspaceId: 'ws-1',
      agentId: 'universal',
      permissionMode: 'ask',
      title: 'made in the harness',
    });
    expect((await api.sessions.list()).map((s) => s.id)).toContain(created.id);

    await api.sessions.remove(created.id);
    const after = (await api.sessions.list()).map((s) => s.id);
    expect(after).not.toContain(created.id);
    expect(after).toHaveLength(before);
  });

  it('remembers a renamed session', async () => {
    const api = await apiFor();
    const first = (await api.sessions.list())[0]!;
    await api.sessions.rename(first.id, 'renamed in the harness');
    expect((await api.sessions.list())[0]!.title).toBe('renamed in the harness');
  });

  it('remembers the retention setting', async () => {
    const api = await apiFor();
    const snapshot = (await api.storage.setRetention(7)) as unknown as {
      storage: { retentionDays: number | null };
    };
    expect(snapshot.storage.retentionDays).toBe(7);
  });

  it('remembers the locale, so the switcher is not merely local state', async () => {
    const api = await apiFor();
    expect(await api.app.getLocale()).toBe('zh-CN');
    await api.app.setLocale('en-US');
    // Previously hardcoded to 'zh-CN': the switcher looked saved and every
    // later read came back in Chinese.
    expect(await api.app.getLocale()).toBe('en-US');
  });

  it('remembers the decision chain', async () => {
    const api = await apiFor();
    await api.decision.setChain(['rule']);
    expect((await api.settings.get()).decision.chain).toEqual(['rule']);
  });

  it('remembers MCP enable and exposure toggles', async () => {
    const api = await apiFor();
    // Pinned by id rather than by position: which row happens to be first is
    // not what this test is about, and depending on it makes the assertion
    // depend on seed ordering.
    const target = (await api.mcp.list()).find((s) => s.id === 'mcp-1')!;
    expect(target).toBeDefined();
    expect(target.enabled).toBe(true);

    await api.mcp.setEnabled('mcp-1', false);
    expect((await api.mcp.list()).find((s) => s.id === 'mcp-1')!.enabled).toBe(false);

    await api.mcp.setExposure('mcp-1', 'ucad_internal');
    expect((await api.mcp.list()).find((s) => s.id === 'mcp-1')!.exposure).toBe('ucad_internal');
  });

  it('remembers an MCP server added and removed', async () => {
    const api = await apiFor();
    const before = (await api.mcp.list()).length;
    const added = await api.mcp.upsert({
      scope: 'workspace',
      name: 'added-in-harness',
      exposure: 'agent_facing',
      transport: 'stdio',
      command: 'ucad-mcp-stub',
    });
    expect((await api.mcp.list()).map((s) => s.id)).toContain(added.id);

    await api.mcp.remove(added.id);
    expect(await api.mcp.list()).toHaveLength(before);
  });

  it('keeps each bridge instance independent', async () => {
    // A module-level cache would leak one window's writes into another's,
    // which is its own kind of lie.
    const { createFixtureApi } = await import(
      '../../apps/desktop/src/renderer/src/dev/fixture-bridge'
    );
    const a = createFixtureApi('default').api;
    const b = createFixtureApi('default').api;
    await a.workspace.setTrust('untrusted');
    expect((await b.workspace.open()).trustState).not.toBe('untrusted');
  });
});

describe('browser fixture bridge', () => {
  it('exposes every scenario the harness documents', () => {
    expect(SCENARIOS).toEqual([
      'default',
      'empty',
      'loading',
      'error',
      'partial',
      'permission',
    ]);
  });

  it('reports the schema version the migrations actually produce', async () => {
    // The fixture cannot import @ucad/storage (it would drag the database into
    // the renderer bundle), so the number is a literal — and a literal drifts:
    // it still said 3 after migration 4 shipped. This parity check is what
    // keeps the literal from rotting; bump the fixture whenever a migration
    // lands and this goes red.
    const { TARGET_SCHEMA_VERSION } = await import('@ucad/storage');
    const api = await loadApi('default');
    const diagnostics = (await api.diagnostics.info()) as { schemaVersion: number };
    expect(diagnostics.schemaVersion).toBe(TARGET_SCHEMA_VERSION);
  });

  it('reports the Electron the repo actually installs', async () => {
    // Same rot pattern as the schema version above: the literal still said
    // 33.2.1 after the Electron 44 upgrade landed. The installed electron
    // package is the source of truth, so the fixture has to agree with it.
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const { version } = require('electron/package.json') as { version: string };
    const api = await loadApi('default');
    const diagnostics = (await api.diagnostics.info()) as { electron: string };
    expect(diagnostics.electron).toBe(version);
  });

  it('reports the Node that the pinned Electron bundles', async () => {
    // No package.json carries this number — it is a property of the Electron
    // binary — so it is pinned here instead. Re-measure with
    // `ELECTRON_RUN_AS_NODE=1 electron -p process.versions.node` whenever the
    // Electron test above goes red.
    const api = await loadApi('default');
    const diagnostics = (await api.diagnostics.info()) as { node: string };
    expect(diagnostics.node).toBe('24.21.0');
  });

  it('gates no read-only tool', async () => {
    // The real tool contract asserts read-only tools declare no permission
    // category; the fixture must tell the same story, or the Settings page
    // badges `read_file` as FILE_WRITE and the harness teaches a lie.
    const api = await loadApi('default');
    const tools = (await api.tools.list()) as Array<{ name: string; permissionCategory: string | null }>;
    const read = tools.find((tool) => tool.name === 'read_file');
    expect(read).toBeDefined();
    expect(read?.permissionCategory).toBeNull();
  });

  it('implements every method the Renderer can call', async () => {
    const api = await loadApi('default');

    const missing: string[] = [];
    for (const [namespace, methods] of Object.entries(REQUIRED)) {
      const group = api[namespace];
      if (!group) {
        missing.push(`${namespace} (namespace)`);
        continue;
      }
      for (const method of methods) {
        if (typeof group[method] !== 'function') {
          missing.push(`${namespace}.${method}`);
        }
      }
    }

    // This is the assertion that matters: a missing entry here is a method the
    // real preload provides and the fixture does not, which is precisely how a
    // "works in the harness, throws in the app" bug gets shipped.
    expect(missing).toEqual([]);
  });

  it('covers the full documented surface with no stray namespaces', async () => {
    const api = await loadApi('default');
    const documented = Object.keys(REQUIRED).sort();
    const actual = Object.keys(api).sort();
    // An undocumented namespace would mean the fixture grew something the test
    // does not police, so the two lists have to agree exactly.
    expect(actual).toEqual(documented);
  });

  it('returns real data in the default scenario', async () => {
    const { createFixtureApi } = await import(
      '../../apps/desktop/src/renderer/src/dev/fixture-bridge'
    );
    const { api } = createFixtureApi('default');
    await expect(api.workspace.listRecent()).resolves.toHaveLength(1);
    await expect(api.sessions.list('ws-1')).resolves.toHaveLength(2);
    await expect(api.agents.list()).resolves.toHaveLength(2);
  });

  it('makes the empty scenario genuinely empty', async () => {
    // A fixture whose "empty" still returns rows would make the renderer's
    // empty state permanently untestable, which is how it goes unchecked.
    const { createFixtureApi } = await import(
      '../../apps/desktop/src/renderer/src/dev/fixture-bridge'
    );
    const { api } = createFixtureApi('empty');
    await expect(api.workspace.listRecent()).resolves.toEqual([]);
    await expect(api.sessions.list('ws-1')).resolves.toEqual([]);
  });

  it('makes the error scenario actually reject', async () => {
    const { createFixtureApi } = await import(
      '../../apps/desktop/src/renderer/src/dev/fixture-bridge'
    );
    const { api } = createFixtureApi('error');
    // These are the calls the renderer must survive and report on.
    await expect(api.workspace.listRecent()).rejects.toThrow(/failed/);
    await expect(api.sessions.list('ws-1')).rejects.toThrow(/failed/);
    await expect(api.events.since({ sessionId: 's', afterSeq: 0 })).rejects.toThrow(/failed/);
  });

  it('keeps the workspace readable in the partial scenario', async () => {
    // `partial` is the realistic "one subsystem is down" case: the window must
    // still come up, and only the broken panel may report a problem.
    const { createFixtureApi } = await import(
      '../../apps/desktop/src/renderer/src/dev/fixture-bridge'
    );
    const { api } = createFixtureApi('partial');
    await expect(api.workspace.listRecent()).resolves.toHaveLength(1);
    await expect(api.agents.list()).resolves.toHaveLength(2);
    await expect(api.decision.listEngines()).rejects.toThrow(/failed/);
  });

  it('fails the session list in `partial`, so "could not read" stays testable', async () => {
    // This is the defect the `partial` scenario exists to catch: a failed read
    // used to be rendered as "no sessions yet". If this ever resolves to `[]`,
    // the scenario has stopped covering the distinction and the regression it
    // guards against can come back unnoticed.
    const { createFixtureApi } = await import(
      '../../apps/desktop/src/renderer/src/dev/fixture-bridge'
    );
    const { api } = createFixtureApi('partial');
    await expect(api.sessions.list('ws-1')).rejects.toThrow(/sessions\.list/);
  });

  it('replays a pending permission request in the `permission` scenario', async () => {
    // The security loop needs a reachable starting state. If this stops
    // producing an unresolved request, the E2E around the dialog would keep
    // passing while testing nothing.
    const { createFixtureApi } = await import(
      '../../apps/desktop/src/renderer/src/dev/fixture-bridge'
    );
    const { api } = createFixtureApi('permission');
    const events = await api.events.since({ sessionId: 'sess-1', afterSeq: 0 });
    const requested = events.find((e) => e.type === 'permission.requested');
    expect(requested).toBeDefined();
    // Derived from the log rather than hand-copied: the request is the newest
    // event and `latestSeq` agrees with the log it is read from. A magic 5 here
    // rotted the moment a seeded event was added.
    expect(requested?.seq).toBe(Math.max(...events.map((e) => e.seq)));
    expect(await api.events.latestSeq('sess-1')).toBe(requested?.seq);
  });

  it('emits the context-pack and usage events a real turn produces', async () => {
    // The preview column's context tab reads `view.context`, which only a
    // `context.pack.built` event can populate; the usage readout needs a
    // `usage` record. Dropping either from the fixture again would break no API
    // call — the main context page reads the pack back by turn id and masks
    // the gap — so the guard sits here, on the event stream itself, and pins
    // E-4's order too: the pack exists before the agent speaks, and the usage
    // record lands before the turn is declared complete.
    const { createFixtureApi } = await import(
      '../../apps/desktop/src/renderer/src/dev/fixture-bridge'
    );
    const { api } = createFixtureApi('default');
    // Filter to the live turn's own stream: the seeded history also carries an
    // E-4 event, and assertions over the whole log would keep passing on the
    // seed even if the live path stopped emitting.
    const { turnId } = await api.sessions.send({
      sessionId: 'sess-1',
      objective: 'guard the stream shape',
    });
    const order = (await api.events.since({ sessionId: 'sess-1', afterSeq: 0 }))
      .filter((e) => e.turnId === turnId)
      .map((e) => e.type);
    expect(order).toContain('context.pack.built');
    expect(order).toContain('usage');
    expect(order.indexOf('context.pack.built')).toBeGreaterThan(order.indexOf('turn.started'));
    expect(order.indexOf('context.pack.built')).toBeLessThan(order.indexOf('text.delta'));
    expect(order.indexOf('usage')).toBeLessThan(order.indexOf('turn.completed'));
  });

  it('produces a readable markdown handoff, not an empty blob', async () => {
    const { createFixtureApi } = await import(
      '../../apps/desktop/src/renderer/src/dev/fixture-bridge'
    );
    const { toMarkdown } = await import(
      '../../apps/desktop/src/renderer/src/components/HandoffPanel'
    );
    const { api } = createFixtureApi('default');
    // A handoff that renders to nothing would defeat the entire point of the
    // feature: the next agent has to be able to read it.
    await expect(
      api.sessions.createHandoff('sess-1').then((h) => toMarkdown(h)),
    ).resolves.toContain('#');
  });
});
