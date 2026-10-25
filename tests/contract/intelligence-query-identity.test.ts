/**
 * §4.8 — the identity of a code-intelligence query.
 *
 * ## The failure this file exists to catch
 *
 * The bridge answered a query like this:
 *
 * ```ts
 * const result = await ucad.intelligence.query({ kind, providerId: 'basic', input });
 * return { operationId: result.providerId, result };
 * ```
 *
 * The provider is called `basic`, so every query was reported as operation
 * `basic`. `intelligence.cancel('basic')` then found no in-flight operation
 * and answered "no in-flight operation 'basic'" — the operation existed, it
 * just had no name anyone could use. The panel had no way to stop a query
 * that was taking its time, and the query ignored the provider picker
 * above it, because the provider was hard-coded in the bridge.
 *
 * The second half of the defect is quieter: the id only arrived *with* the
 * answer. An id that shows up when the work is already over cannot stop
 * anything.
 *
 * So the id is allocated by the caller and travels with the request, and the
 * manager reports the outcome as `cancelled` when the provider was stopped —
 * a provider that returns early after an abort used to be reported as `ok`,
 * which turned a cancellation into a confident partial answer.
 *
 * These tests drive the real `IntelligenceManager` and the real bridge
 * function, over a provider that blocks until it is aborted.
 */

import { describe, expect, it } from 'vitest';
import type {
  CodeIntelligenceManifest,
  CodeIntelligenceProvider,
  CodeSearchInput,
  CodeSearchResult,
  IntelligenceInitializeContext,
  IntelligenceOperationHandle,
  IntelligenceStatus,
  IndexWorkspaceInput,
  RefreshWorkspaceInput,
} from '@ucad/contracts';
import { IntelligenceManager } from '@ucad/code-intelligence';
import { silentLogger } from '@ucad/observability';

import { runIntelligenceQuery } from '../../apps/desktop/src/main/intelligence-query';

/** The manager only needs a database to persist provider manifests. */
const stubDb = {
  driver: {
    run: () => ({ changes: 0, lastInsertRowid: 0 }),
    all: () => [],
    get: () => undefined,
    runBatch: () => undefined,
    transaction: <T,>(fn: () => T) => fn(),
    close: () => undefined,
  },
} as never;

function manifest(id: string): CodeIntelligenceManifest {
  return {
    id,
    displayName: id,
    tier: 'basic',
    version: '1.0.0',
    pinned: [],
    transport: 'in_process',
    requires: [],
    capabilities: {
      symbolSearch: true,
      definitions: true,
      callers: false,
      callees: false,
      dependencyGraph: false,
      trace: false,
      impact: false,
      persistentIndex: false,
      incrementalRefresh: false,
      machineReadableOutput: true,
    },
    optionalMethods: [],
  };
}

/**
 * A provider that answers at once.
 *
 * The manager needs a registered provider to answer for, and the bridge tests
 * need one that is not waiting for something.
 */
class AnsweringProvider implements CodeIntelligenceProvider {
  readonly manifest: CodeIntelligenceManifest;

  constructor(id: string) {
    this.manifest = manifest(id);
  }

  async initialize(_ctx: IntelligenceInitializeContext): Promise<void> {}

  async getStatus(_workspaceId: string): Promise<IntelligenceStatus> {
    return {
      providerId: this.manifest.id,
      state: 'ready',
      reason: 'fixture',
      stale: true,
      features: this.manifest.capabilities,
    };
  }

  async index(_input: IndexWorkspaceInput, _signal?: AbortSignal): Promise<IntelligenceOperationHandle> {
    return {
      operationId: `iop_${this.manifest.id}_index`,
      providerId: this.manifest.id,
      kind: 'index',
      startedAt: '2026-01-01T00:00:00.000Z',
    };
  }

  async refresh(
    _input: RefreshWorkspaceInput,
    _signal?: AbortSignal,
  ): Promise<IntelligenceOperationHandle> {
    return {
      operationId: `iop_${this.manifest.id}_refresh`,
      providerId: this.manifest.id,
      kind: 'refresh',
      startedAt: '2026-01-01T00:00:00.000Z',
    };
  }

  async cancel(_input: { operationId: string }): Promise<{ cancelled: boolean; reason?: string }> {
    return { cancelled: true };
  }

  async search(_input: CodeSearchInput, _signal?: AbortSignal): Promise<CodeSearchResult> {
    return {
      items: [],
      truncated: false,
      freshness: { stale: true, stalenessReason: 'unknown_revision' },
    };
  }

  async locate(): Promise<never[]> {
    return [];
  }

  async overview(): Promise<never> {
    return {} as never;
  }

  async dispose(): Promise<void> {}
}

/**
 * A provider whose search never finishes on its own: it waits for the abort
 * signal and then returns a *normal* result.
 *
 * That is what the Basic provider does when it is cancelled mid-scan — it
 * breaks out of its walk and hands back whatever it had. A manager that
 * reported that as `ok` would turn a cancellation into a partial answer.
 */
class BlockingProvider extends AnsweringProvider {
  override async search(
    _input: CodeSearchInput,
    signal?: AbortSignal,
  ): Promise<CodeSearchResult> {
    await new Promise<void>((resolve) => {
      if (signal?.aborted) {
        resolve();
        return;
      }
      signal?.addEventListener('abort', () => resolve(), { once: true });
    });
    return {
      items: [],
      truncated: false,
      freshness: { stale: true, stalenessReason: 'unknown_revision' },
    };
  }
}

function makeManager(): IntelligenceManager {
  const manager = new IntelligenceManager({ db: stubDb, logger: silentLogger('test') });
  manager.register(new AnsweringProvider('basic'));
  // A second provider that answers at once, so "the provider the caller
  // asked for" can be told apart from the default one.
  manager.register(new AnsweringProvider('probe'));
  manager.register(new BlockingProvider('blocking'));
  return manager;
}

/**
 * A provider that remembers what it was asked.
 *
 * The point of the merge is what the provider *receives*, and that is only
 * observable from inside the provider.
 */
class RecordingProvider extends AnsweringProvider {
  lastInput: unknown;

  override async search(
    input: CodeSearchInput,
    _signal?: AbortSignal,
  ): Promise<CodeSearchResult> {
    this.lastInput = input;
    return {
      items: [],
      truncated: false,
      freshness: { stale: true, stalenessReason: 'unknown_revision' },
    };
  }
}

function makeRecordingManager(): { manager: IntelligenceManager; provider: RecordingProvider } {
  const manager = new IntelligenceManager({ db: stubDb, logger: silentLogger('test') });
  const provider = new RecordingProvider('basic');
  manager.register(provider);
  return { manager, provider };
}

describe('a query is an operation with a name', () => {
  it('names the operation instead of repeating the provider id', async () => {
    const manager = makeManager();
    const outcome = await manager.query({
      kind: 'search',
      providerId: 'basic',
      input: { workspaceId: 'ws_1', query: 'needle' },
    });

    expect(outcome.operationId).toBeTruthy();
    expect(outcome.operationId).not.toBe('basic');
  });

  it('names the operation even when the provider cannot answer', async () => {
    const manager = makeManager();
    // `blocking` declares no optional methods, so `callers` is absent (C-1).
    const outcome = await manager.query({
      kind: 'callers',
      providerId: 'blocking',
      input: { workspaceId: 'ws_1' },
    });

    expect(outcome.status).toBe('unsupported');
    expect(outcome.operationId).toBeTruthy();
    expect(outcome.operationId).not.toBe('blocking');
  });

  it('uses the id the caller allocated, so the caller can cancel it', async () => {
    const manager = makeManager();
    const pending = manager.query({
      kind: 'search',
      providerId: 'blocking',
      input: { workspaceId: 'ws_1', query: 'needle' },
      operationId: 'uiq_caller_allocated',
    });

    // The id is known while the query is still running — that is the point.
    const cancel = await manager.cancel('uiq_caller_allocated');
    expect(cancel.cancelled).toBe(true);

    const outcome = await pending;
    expect(outcome.operationId).toBe('uiq_caller_allocated');
  });

  it('reports a cancelled query as cancelled, not as a result', async () => {
    const manager = makeManager();
    const pending = manager.query({
      kind: 'search',
      providerId: 'blocking',
      input: { workspaceId: 'ws_1', query: 'needle' },
      operationId: 'uiq_to_be_cancelled',
    });

    await manager.cancel('uiq_to_be_cancelled');
    const outcome = await pending;

    expect(outcome.status).toBe('cancelled');
    // A cancelled query has no answer. Reporting the partial scan as a
    // result would be the same defect in a different costume.
    expect(outcome.result).toBeNull();
  });

  it('says so when the cancel reaches nothing', async () => {
    const manager = makeManager();
    const cancel = await manager.cancel('basic');
    expect(cancel.cancelled).toBe(false);
    expect(cancel.reason).toContain('basic');
  });
});

describe('the bridge answers with the operation, not with the provider', () => {
  it('returns the operation id the manager allocated', async () => {
    const manager = makeManager();
    const envelope = await runIntelligenceQuery({ intelligence: manager }, {
      workspaceId: 'ws_1',
      kind: 'search',
      input: { query: 'needle' },
    });

    expect(envelope.operationId).toBeTruthy();
    expect(envelope.operationId).not.toBe('basic');
    expect(envelope.operationId).toBe(envelope.result.operationId);
  });

  it('runs against the provider the caller asked for', async () => {
    const manager = makeManager();
    const envelope = await runIntelligenceQuery({ intelligence: manager }, {
      workspaceId: 'ws_1',
      kind: 'search',
      input: { query: 'needle' },
      providerId: 'probe',
    });

    expect(envelope.providerId).toBe('probe');
  });

  it('falls back to the configured provider when the caller names none', async () => {
    const manager = makeManager();
    const envelope = await runIntelligenceQuery(
      { intelligence: manager, defaultProviderId: 'probe' },
      { workspaceId: 'ws_1', kind: 'search', input: { query: 'needle' } },
    );

    expect(envelope.providerId).toBe('probe');
  });

  it('carries the caller’s operation id through to the manager', async () => {
    const manager = makeManager();
    const envelope = await runIntelligenceQuery({ intelligence: manager }, {
      workspaceId: 'ws_1',
      kind: 'search',
      input: { query: 'needle' },
      operationId: 'uiq_from_the_panel',
    });

    expect(envelope.operationId).toBe('uiq_from_the_panel');
  });

  it('refuses a query with no workspace id', async () => {
    const manager = makeManager();
    await expect(
      runIntelligenceQuery({ intelligence: manager }, { kind: 'search', input: {} }),
    ).rejects.toThrow();
  });

  it('refuses a query kind it does not know', async () => {
    const manager = makeManager();
    await expect(
      runIntelligenceQuery({ intelligence: manager }, {
        workspaceId: 'ws_1',
        kind: 'summarise',
        input: {},
      }),
    ).rejects.toThrow();
  });
});

describe('the payload the provider receives', () => {
  it('refuses a payload that is not an object', async () => {
    const manager = makeManager();
    // A bare string or an array used to be passed through untouched, so the
    // provider never saw the workspace id, could not resolve the project
    // root, and answered with an empty result — indistinguishable from
    // "there is nothing to find".
    for (const payload of ['needle', ['needle'], 42, null, true]) {
      await expect(
        runIntelligenceQuery({ intelligence: manager }, {
          workspaceId: 'ws_1',
          kind: 'search',
          input: payload,
        }),
      ).rejects.toThrow();
    }
  });

  it('gives the provider the workspace id of the request', async () => {
    const { manager, provider } = makeRecordingManager();
    await runIntelligenceQuery({ intelligence: manager }, {
      workspaceId: 'ws_1',
      kind: 'search',
      input: { query: 'needle' },
    });

    expect((provider.lastInput as { workspaceId?: string }).workspaceId).toBe('ws_1');
    // The panel's own fields survive the merge.
    expect((provider.lastInput as { query?: string }).query).toBe('needle');
  });

  it('refuses a payload that names another workspace', async () => {
    const { manager, provider } = makeRecordingManager();

    // The request names the project the panel is looking at. A payload that
    // names another one would point the query at a project that may never
    // have been initialised — which answers "no results" for a reason nobody
    // can see. The old code overwrote the payload's id with the request's and
    // ran anyway, so the caller was never told its request was contradictory.
    //
    // Fail closed: no query runs, and the caller gets a reason instead of an
    // answer about a project it did not ask for.
    await expect(
      runIntelligenceQuery({ intelligence: manager }, {
        workspaceId: 'ws_1',
        kind: 'search',
        input: { query: 'needle', workspaceId: 'ws_other' },
      }),
    ).rejects.toThrow(/项目/);

    // Nothing reached the provider: the refusal is not "we fixed your input".
    expect(provider.lastInput).toBeUndefined();
  });

  it('refuses a mismatched payload under a stable code', async () => {
    const { manager, provider } = makeRecordingManager();

    // The sentence is what the user reads; the code is what the log and any
    // later statistics read. A refusal that only carried a sentence was logged
    // as `UNKNOWN`, the same entry as a provider crash.
    const failure = await runIntelligenceQuery({ intelligence: manager }, {
      workspaceId: 'ws_1',
      kind: 'search',
      input: { query: 'needle', workspaceId: 'ws_other' },
    }).then(
      () => null,
      (error: unknown) => error as { code?: string; message?: string },
    );

    expect(failure?.code).toBe('INVALID_INPUT');
    // Still an `Error`: Electron carries a rejection across the bridge as an
    // Error, and the panels branch on `instanceof Error`.
    expect(failure).toBeInstanceOf(Error);
    expect(provider.lastInput).toBeUndefined();
  });

  it('accepts a payload that repeats the request’s workspace id', async () => {
    const { manager, provider } = makeRecordingManager();
    await runIntelligenceQuery({ intelligence: manager }, {
      workspaceId: 'ws_1',
      kind: 'search',
      input: { query: 'needle', workspaceId: 'ws_1' },
    });

    // The same id is not a conflict — a caller may echo what it was given.
    expect((provider.lastInput as { workspaceId?: string }).workspaceId).toBe('ws_1');
  });
});
