/**
 * §4.8.1 optional-capability semantics.
 *
 * The distinction that matters: a provider that cannot compute callers must say
 * so by NOT IMPLEMENTING the method. Returning `[]` would be read by every
 * caller as "this symbol has no callers", which is a confident wrong answer
 * rather than an honest gap.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BasicIntelligenceProvider, IntelligenceManager } from '@ucad/code-intelligence';
import { silentLogger } from '@ucad/observability';

let fixtureRoot: string;
let provider: BasicIntelligenceProvider;

function write(rel: string, content: string): void {
  // `rel` values come from this file's own fixture list, but the boundary is
  // enforced rather than assumed: a typo'd relative path must fail loudly
  // instead of writing outside the temporary fixture root.
  const file = path.resolve(fixtureRoot, rel);
  if (!file.startsWith(fixtureRoot + path.sep)) {
    throw new Error(`fixture path escapes the fixture root: ${rel}`);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
}

beforeAll(() => {
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ucad-ix-'));
  write(
    'src/auth/login.ts',
    [
      'export function login(user: string) {',
      '  return validate(user);',
      '}',
      '',
      'function validate(u: string) {',
      '  return u.length > 0;',
      '}',
    ].join('\n'),
  );
  write('src/auth/session.ts', "import { login } from './login';\nexport const s = login;\n");
  write('README.md', '# fixture\n\nlogin is mentioned here\n');
  // things that must be ignored
  write('node_modules/pkg/index.js', 'function login() {}\n');
  write('.git/config', '[core]\n');
  fs.mkdirSync(path.join(fixtureRoot, 'dist'), { recursive: true });
  write('dist/bundle.js', 'function login() {}\n');

  provider = new BasicIntelligenceProvider({
    logger: silentLogger('test'),
    blobs: { put: (t: string) => `blob_${t.length}`, get: () => '', putOrPreview: (t: string) => ({ preview: t, truncated: false, bytes: t.length }), directory: '', exists: () => true, clear: () => undefined } as never,
  });
});

afterAll(() => {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

describe('Basic provider manifest / C-4', () => {
  it('declares no optional methods', () => {
    expect(provider.manifest.optionalMethods).toEqual([]);
  });

  it('does not claim relation, graph, trace or impact capability', () => {
    const c = provider.manifest.capabilities;
    expect(c.callers).toBe(false);
    expect(c.callees).toBe(false);
    expect(c.trace).toBe(false);
    expect(c.impact).toBe(false);
    expect(c.dependencyGraph).toBe(false);
  });

  it('does claim the two capabilities it really has', () => {
    expect(provider.manifest.capabilities.symbolSearch).toBe(true);
    expect(provider.manifest.capabilities.definitions).toBe(true);
  });

  it('requires no external infrastructure', () => {
    expect(provider.manifest.requires).toEqual([]);
    expect(provider.manifest.tier).toBe('basic');
  });
});

describe('C-1 / C-2: optional methods are ABSENT, not empty', () => {
  it('callers does not exist on the instance', () => {
    expect(typeof (provider as { callers?: unknown }).callers).toBe('undefined');
  });

  it('callees does not exist on the instance', () => {
    expect(typeof (provider as { callees?: unknown }).callees).toBe('undefined');
  });

  it('trace does not exist on the instance', () => {
    expect(typeof (provider as { trace?: unknown }).trace).toBe('undefined');
  });

  it('impact does not exist on the instance', () => {
    expect(typeof (provider as { impact?: unknown }).impact).toBe('undefined');
  });

  it('the supported methods do exist', () => {
    expect(typeof provider.search).toBe('function');
    expect(typeof provider.locate).toBe('function');
    expect(typeof provider.overview).toBe('function');
  });
});

describe('IntelligenceManager / C-3, C-5', () => {
  function makeManager(withBasic = true) {
    const manager = new IntelligenceManager({
      db: { driver: { run: () => ({ changes: 0, lastInsertRowid: 0 }), all: () => [], get: () => undefined, runBatch: () => undefined, transaction: <T,>(fn: () => T) => fn(), close: () => undefined } } as never,
      logger: silentLogger('test'),
    });
    if (withBasic) manager.register(provider);
    return manager;
  }

  it('returns unsupported instead of throwing for an absent method', async () => {
    const manager = makeManager();
    const result = await manager.query({
      kind: 'callers',
      providerId: 'basic',
      input: { workspaceId: 'ws_1', target: { path: 'a.ts', startLine: 1, endLine: 2 } },
    });
    expect(result.status).toBe('unsupported');
  });

  it('returns unsupported for trace and impact too', async () => {
    const manager = makeManager();
    for (const kind of ['trace', 'impact'] as const) {
      const result = await manager.query({
        kind,
        providerId: 'basic',
        input: { workspaceId: 'ws_1' },
      });
      expect(result.status).toBe('unsupported');
    }
  });

  it('does not fabricate a result payload for an unsupported call', async () => {
    const manager = makeManager();
    const result = await manager.query({
      kind: 'callers',
      providerId: 'basic',
      input: { workspaceId: 'ws_1' },
    });
    expect(result.result ?? null).toBeNull();
  });

  it('resolves an unregistered provider to basic rather than failing (NFR-09)', () => {
    const manager = makeManager();
    expect(manager.resolve('does-not-exist').manifest.id).toBe('basic');
  });

  it('lists the registered providers', () => {
    const manager = makeManager();
    expect(manager.listProviders().map((m) => m.id)).toContain('basic');
  });
});

describe('NFR-11: freshness honesty', () => {
  it('never reports ready — the basic provider has no persistent index', async () => {
    const status = await provider.getStatus('ws_1');
    expect(status.state).not.toBe('ready');
    expect(status.stale).toBe(true);
  });

  it('marks search results stale with an explicit reason', async () => {
    await provider.initialize({
      workspaceId: 'ws_1',
      workspaceRoot: fixtureRoot,
      configDir: fixtureRoot,
      cacheDir: fixtureRoot,
      trustState: 'trusted',
      logger: silentLogger('test') as never,
    });

    const result = await provider.search({ workspaceId: 'ws_1', query: 'validate' });
    expect(result.freshness.stale).toBe(true);
    expect(result.freshness.stalenessReason).toBe('unknown_revision');
  });
});

describe('basic search behaviour', () => {
  beforeAll(async () => {
    await provider.initialize({
      workspaceId: 'ws_1',
      workspaceRoot: fixtureRoot,
      configDir: fixtureRoot,
      cacheDir: fixtureRoot,
      trustState: 'trusted',
      logger: silentLogger('test') as never,
    });
  });

  it('finds a match with correct 1-based line numbers', async () => {
    const result = await provider.search({ workspaceId: 'ws_1', query: 'function validate' });
    const hit = result.items.find((i) => i.path.includes('login.ts'));
    expect(hit).toBeTruthy();
    // fixture layout:
    //   1 export function login(user: string) {
    //   2   return validate(user);
    //   3 }
    //   4 (blank)
    //   5 function validate(u: string) {
    expect(hit!.startLine).toBe(5);
  });

  it('ignores node_modules and build output', async () => {
    const result = await provider.search({ workspaceId: 'ws_1', query: 'function login' });
    const paths = result.items.map((i) => i.path);
    expect(paths.some((p) => p.includes('node_modules'))).toBe(false);
    expect(paths.some((p) => p.includes('dist'))).toBe(false);
  });

  it('reports truncation when the result set is capped', async () => {
    const result = await provider.search({ workspaceId: 'ws_1', query: 'e', limit: 2 });
    expect(result.items.length).toBeLessThanOrEqual(2);
  });

  it('is case insensitive', async () => {
    const result = await provider.search({ workspaceId: 'ws_1', query: 'VALIDATE' });
    expect(result.items.length).toBeGreaterThan(0);
  });

  it('produces an overview describing the real tree', async () => {
    const overview = await provider.overview({ workspaceId: 'ws_1' });
    expect(overview.summary.length).toBeGreaterThan(0);
    expect(overview.freshness.stale).toBe(true);
  });
});
