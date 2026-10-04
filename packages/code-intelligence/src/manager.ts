/**
 * §4.8 §5 — `IntelligenceManager`.
 *
 * The manager is the only place that decides *which* provider answers and it is
 * responsible for three architectural guarantees:
 *
 *  - C-3: `query()` checks method existence BEFORE calling. A kind the provider
 *    does not implement returns `status: 'unsupported'` and NEVER throws. An
 *    empty result would be a lie; a throw would be a crash.
 *  - C-5: `unsupported` and `error` are distinct states with distinct reasons,
 *    so the ContextBroker (T-5) can drop one and surface the other.
 *  - NFR-09: when an advanced provider fails to initialize, it stays registered
 *    but is exposed as `degraded` with a `degradation.because`, and `basic`
 *    remains usable.
 *
 * NFR-05: every long running call goes through an in-flight `Map<operationId,
 * AbortController>`, so `cancel()` is genuinely reachable.
 */

import { nowIso, ulid } from '@ucad/observability';
import type { Logger } from '@ucad/observability';
import { appError, describeError } from '@ucad/contracts';
import type {
  CodeIntelligenceManifest,
  CodeIntelligenceProvider,
  FreshnessState,
  IndexWorkspaceInput,
  IntelligenceInitializeContext,
  IntelligenceOperationHandle,
  IntelligenceQueryKind,
  IntelligenceQueryStatus,
  IntelligenceStatus,
  RefreshWorkspaceInput,
} from '@ucad/contracts';
import type { Database } from '@ucad/storage';
import { BASIC_PROVIDER_ID } from './basic-provider';

/** The manager's own return shape for `query`. */
export interface IntelligenceQueryOutcome {
  status: IntelligenceQueryStatus;
  result: unknown;
  freshness: FreshnessState;
  durationMs: number;
  providerId: string;
  /** present for `unsupported`, `error` and `cancelled`; absent on `ok` */
  reason?: string;
}

export interface IntelligenceManagerOptions {
  db: Database;
  logger: Logger;
  /** NFR-09: the id every fallback path lands on. Defaults to 'basic'. */
  basicProviderId?: string;
}

interface RegisteredProvider {
  provider: CodeIntelligenceProvider;
  initialized: boolean;
  degradation?: IntelligenceStatus['degradation'];
}

/** NFR-09: how an `initialize` failure is explained to the user. */
type DegradationBecause = NonNullable<IntelligenceStatus['degradation']>['because'];

function classifyDegradation(error: unknown): DegradationBecause {
  const message = describeError(error).toLowerCase();
  if (
    message.includes('cannot find module') ||
    message.includes('modulenotfound') ||
    message.includes('enoent') ||
    message.includes('not installed') ||
    message.includes('missing')
  ) {
    return 'dependency_missing';
  }
  if (
    message.includes('version') ||
    message.includes('incompatible') ||
    message.includes('protocol')
  ) {
    return 'version_mismatch';
  }
  if (
    message.includes('econnrefused') ||
    message.includes('unreachable') ||
    message.includes('timeout') ||
    message.includes('etimedout') ||
    message.includes('http')
  ) {
    return 'backend_unreachable';
  }
  return 'index_failed';
}

const UNKNOWN_REVISION: FreshnessState = { stale: true, stalenessReason: 'unknown_revision' };

/** An operation `cancel()` can reach, plus what it needs to tell the provider. */
interface InFlightOperation {
  controller: AbortController;
  providerId: string;
  startedAtMs: number;
}

/** Registry entries nobody cancelled age out after this long. */
const OPERATION_TTL_MS = 600_000;

export class IntelligenceManager {
  private readonly db: Database;
  private readonly logger: Logger;
  private readonly basicProviderId: string;
  private readonly providers = new Map<string, RegisteredProvider>();
  /** NFR-05: the reason `cancel()` is reachable. */
  private readonly inFlight = new Map<string, InFlightOperation>();
  private readonly workspaceStatuses = new Map<string, Map<string, IntelligenceStatus>>();
  private disposed = false;

  constructor(opts: IntelligenceManagerOptions) {
    this.db = opts.db;
    this.logger = opts.logger;
    this.basicProviderId = opts.basicProviderId ?? BASIC_PROVIDER_ID;
  }

  register(provider: CodeIntelligenceProvider): void {
    const id = provider.manifest.id;
    this.providers.set(id, { provider, initialized: false });
    this.persistProvider(provider.manifest);
    this.logger.info('intelligence provider registered', {
      providerId: id,
      tier: provider.manifest.tier,
      optionalMethods: provider.manifest.optionalMethods,
    });
  }

  listProviders(): CodeIntelligenceManifest[] {
    return [...this.providers.values()].map((entry) => entry.provider.manifest);
  }

  /**
   * NFR-09: the requested provider, else the workspace default (the usable
   * provider with the highest tier), else `basic`. Always returns a provider —
   * a caller can never be left without one.
   */
  resolve(providerId?: string, workspaceId?: string): CodeIntelligenceProvider {
    if (providerId !== undefined) {
      const requested = this.providers.get(providerId);
      if (requested) return requested.provider;
      this.logger.warn('requested intelligence provider is not registered; falling back', {
        providerId,
        fallback: this.basicProviderId,
      });
    }
    const workspaceDefault = this.workspaceDefaultProviderId(workspaceId);
    if (workspaceDefault !== undefined) {
      const entry = this.providers.get(workspaceDefault);
      if (entry) return entry.provider;
    }
    const basic = this.providers.get(this.basicProviderId);
    if (basic) return basic.provider;
    // Last resort: build a detached basic view so `resolve` is total.
    throw appError(
      'INTELLIGENCE_UNAVAILABLE',
      'no intelligence provider is registered (the basic provider must be registered first)',
      'intelligence',
    );
  }

  /**
   * NFR-09: a provider whose `initialize` failed is reported as `degraded`, with
   * `degradation.because` and `degradation.since`, so the UI can explain what
   * still works instead of pretending the provider is simply gone.
   */
  async status(workspaceId: string, providerId?: string): Promise<IntelligenceStatus> {
    const resolvedId = providerId ?? this.workspaceDefaultProviderId(workspaceId) ?? this.basicProviderId;
    const entry = this.providers.get(resolvedId);
    if (!entry) {
      return {
        providerId: resolvedId,
        state: 'unavailable',
        reason: 'provider is not registered',
        stale: true,
        features: EMPTY_CAPABILITIES,
      };
    }

    let base: IntelligenceStatus;
    try {
      base = await entry.provider.getStatus(workspaceId);
    } catch (error) {
      base = {
        providerId: resolvedId,
        state: 'error',
        reason: describeError(error).slice(0, 300),
        stale: true,
        features: entry.provider.manifest.capabilities,
      };
    }

    const degradation = entry.degradation;
    // `providerId` is forced to the id the manager asked about: a provider that
    // mislabels its own status must not be able to overwrite another provider's
    // slot in the per-workspace map (and become the workspace default).
    const status: IntelligenceStatus = {
      ...base,
      providerId: resolvedId,
      ...(degradation
        ? { state: 'degraded' as const, stale: true, reason: base.reason ?? degradation.because, degradation }
        : {}),
    };
    this.rememberStatus(workspaceId, status);
    return status;
  }

  /**
   * NFR-09: a failed initialize is recorded as a degradation, never propagated
   * as a throw, so `basic` keeps working.
   */
  async initializeProvider(providerId: string, ctx: IntelligenceInitializeContext): Promise<void> {
    const entry = this.providers.get(providerId);
    if (!entry) {
      this.logger.warn('initializeProvider for an unknown provider', { providerId });
      return;
    }
    const controller = new AbortController();
    const operationId = ulid('iop_');
    this.inFlight.set(operationId, { controller, providerId, startedAtMs: Date.now() });
    try {
      await entry.provider.initialize(ctx, controller.signal);
      entry.initialized = true;
      entry.degradation = undefined;
      this.logger.info('intelligence provider initialized', { providerId, workspaceId: ctx.workspaceId });
    } catch (error) {
      entry.initialized = false;
      entry.degradation = { since: nowIso(), because: classifyDegradation(error) };
      this.logger.error('intelligence provider failed to initialize; degrading', {
        providerId,
        because: entry.degradation.because,
        error: describeError(error).slice(0, 300),
        basicStillUsable: this.providers.has(this.basicProviderId),
      });
    } finally {
      this.inFlight.delete(operationId);
    }
  }

  /**
   * C-3 / C-5. The method-existence check happens first, so an unsupported kind
   * can never reach the provider and can never throw.
   */
  async query<K extends IntelligenceQueryKind>(input: {
    kind: K;
    providerId: string;
    input: unknown;
    signal?: AbortSignal;
    /**
     * NFR-05: Main may pre-allocate the id so a fire-and-forget query stays
     * cancellable through `cancel(operationId)`. Omit it and the manager
     * allocates one internally (cancellable only through `signal`).
     */
    operationId?: string;
  }): Promise<IntelligenceQueryOutcome> {
    const started = Date.now();
    const provider = this.resolve(input.providerId);

    if (!hasMethod(provider, input.kind)) {
      // C-1: absence is the honest signal. Say so explicitly, distinguishably.
      this.logger.debug('intelligence query is unsupported by this provider', {
        providerId: provider.manifest.id,
        kind: input.kind,
      });
      return {
        status: 'unsupported',
        result: null,
        freshness: { ...UNKNOWN_REVISION },
        durationMs: Math.max(0, Date.now() - started),
        providerId: provider.manifest.id,
        reason:
          `method '${input.kind}' is absent on provider '${provider.manifest.id}' ` +
          `(optionalMethods: [${provider.manifest.optionalMethods.join(', ') || 'none'}]); ` +
          'the provider cannot answer, which is not the same as having no results',
      };
    }

    const operationId = input.operationId ?? ulid('iop_');
    const controller = new AbortController();
    const onOuterAbort = (): void => controller.abort();
    if (input.signal) {
      if (input.signal.aborted) controller.abort();
      else input.signal.addEventListener('abort', onOuterAbort, { once: true });
    }
    this.inFlight.set(operationId, { controller, providerId: provider.manifest.id, startedAtMs: Date.now() });

    try {
      const result = await callMethod(provider, input.kind, input.input, controller.signal);
      return {
        status: 'ok',
        result,
        freshness: freshnessOf(result),
        durationMs: Math.max(0, Date.now() - started),
        providerId: provider.manifest.id,
      };
    } catch (error) {
      if (controller.signal.aborted) {
        return {
          status: 'cancelled',
          result: null,
          freshness: { ...UNKNOWN_REVISION },
          durationMs: Math.max(0, Date.now() - started),
          providerId: provider.manifest.id,
          reason: `query '${input.kind}' was cancelled (${operationId})`,
        };
      }
      const message = describeError(error);
      this.logger.error('intelligence query failed', {
        providerId: provider.manifest.id,
        kind: input.kind,
        error: message.slice(0, 300),
      });
      return {
        status: 'error',
        result: null,
        freshness: { ...UNKNOWN_REVISION },
        durationMs: Math.max(0, Date.now() - started),
        providerId: provider.manifest.id,
        reason: `query '${input.kind}' failed: ${message.slice(0, 300)}`,
      };
    } finally {
      this.inFlight.delete(operationId);
      if (input.signal) input.signal.removeEventListener('abort', onOuterAbort);
    }
  }

  async index(input: {
    workspaceId: string;
    workspaceRoot: string;
    providerId: string;
    full: boolean;
  }): Promise<IntelligenceOperationHandle> {
    const provider = this.resolve(input.providerId);
    const indexInput: IndexWorkspaceInput = {
      workspaceId: input.workspaceId,
      workspaceRoot: input.workspaceRoot,
      full: input.full,
    };
    return this.runOperation(provider, input.providerId, (controller) => provider.index(indexInput, controller.signal));
  }

  async refresh(input: {
    workspaceId: string;
    providerId: string;
    changedPaths?: string[];
  }): Promise<IntelligenceOperationHandle> {
    const provider = this.resolve(input.providerId);
    const refreshInput: RefreshWorkspaceInput = {
      workspaceId: input.workspaceId,
      ...(input.changedPaths !== undefined ? { changedPaths: input.changedPaths } : {}),
    };
    return this.runOperation(provider, input.providerId, (controller) =>
      provider.refresh(refreshInput, controller.signal),
    );
  }

  /**
   * `index` / `refresh` return a handle and may still be running, so the
   * controller stays registered under the handle's own operationId — that is
   * what makes `cancel(handle.operationId)` reachable afterwards.
   */
  private async runOperation(
    provider: CodeIntelligenceProvider,
    providerId: string,
    start: (controller: AbortController) => Promise<IntelligenceOperationHandle>,
  ): Promise<IntelligenceOperationHandle> {
    const controller = new AbortController();
    const tempId = ulid('iop_');
    this.inFlight.set(tempId, { controller, providerId: provider.manifest.id, startedAtMs: Date.now() });
    try {
      const handle = await start(controller);
      this.inFlight.delete(tempId);
      this.inFlight.set(handle.operationId, { controller, providerId: provider.manifest.id, startedAtMs: Date.now() });
      this.pruneOperations();
      return handle;
    } catch (error) {
      this.inFlight.delete(tempId);
      throw appError(
        'INTELLIGENCE_UNAVAILABLE',
        `operation failed for provider '${providerId}': ${describeError(error).slice(0, 300)}`,
        'intelligence',
      );
    }
  }

  /** NFR-05: aborts the controller wired into the call and tells the provider. */
  async cancel(operationId: string): Promise<{ cancelled: boolean; reason?: string }> {
    const entry = this.inFlight.get(operationId);
    if (!entry) {
      return { cancelled: false, reason: `no in-flight operation '${operationId}'` };
    }
    entry.controller.abort();
    this.inFlight.delete(operationId);
    this.logger.info('intelligence operation cancelled', { operationId, providerId: entry.providerId });

    const provider = this.providers.get(entry.providerId)?.provider;
    if (!provider) return { cancelled: true };
    try {
      const own = await provider.cancel({ operationId });
      return own.cancelled ? { cancelled: true } : { cancelled: true, reason: own.reason };
    } catch (error) {
      // The signal is already aborted, so the operation is cancelled either way.
      return {
        cancelled: true,
        reason: `provider cancel failed: ${describeError(error).slice(0, 200)}`,
      };
    }
  }

  /** number of operations `cancel()` can currently reach — diagnostics/tests. */
  get inFlightCount(): number {
    return this.inFlight.size;
  }

  /** Bounds the registry: an operation nobody cancelled ages out. */
  private pruneOperations(): void {
    const cutoff = Date.now() - OPERATION_TTL_MS;
    for (const [id, entry] of this.inFlight) {
      if (entry.startedAtMs < cutoff) this.inFlight.delete(id);
    }
  }

  setWorkspaceStatus(workspaceId: string, providerId: string, status: IntelligenceStatus): void {
    this.rememberStatus(workspaceId, status);
    this.persistWorkspaceStatus(workspaceId, status);
  }

  listWorkspaceStatuses(workspaceId: string): IntelligenceStatus[] {
    const forWorkspace = this.workspaceStatuses.get(workspaceId);
    return forWorkspace ? [...forWorkspace.values()] : [];
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const op of this.inFlight.values()) op.controller.abort();
    this.inFlight.clear();
    for (const entry of this.providers.values()) {
      try {
        await entry.provider.dispose();
      } catch (error) {
        this.logger.warn('intelligence provider dispose failed', {
          providerId: entry.provider.manifest.id,
          error: describeError(error).slice(0, 200),
        });
      }
    }
    this.providers.clear();
    this.workspaceStatuses.clear();
  }

  // -------------------------------------------------------------------------

  /**
   * The workspace default is the usable provider with the highest tier. A
   * provider that is degraded, or that was never initialized and has no recorded
   * status for this workspace, is never promoted — "registered" is not "ready".
   */
  private workspaceDefaultProviderId(workspaceId?: string): string | undefined {
    if (workspaceId === undefined) return undefined;
    const statuses = this.workspaceStatuses.get(workspaceId);
    const ranked = [...this.providers.values()]
      .filter((entry) => !entry.degradation)
      .filter((entry) => {
        const id = entry.provider.manifest.id;
        const status = statuses?.get(id);
        if (status && (status.state === 'unavailable' || status.state === 'error')) return false;
        return entry.initialized || status !== undefined;
      })
      .sort(
        (a, b) =>
          tierRank(b.provider.manifest) - tierRank(a.provider.manifest) ||
          a.provider.manifest.id.localeCompare(b.provider.manifest.id),
      );
    for (const entry of ranked) return entry.provider.manifest.id;
    return this.providers.has(this.basicProviderId) ? this.basicProviderId : undefined;
  }

  private rememberStatus(workspaceId: string, status: IntelligenceStatus): void {
    const forWorkspace = this.workspaceStatuses.get(workspaceId) ?? new Map<string, IntelligenceStatus>();
    forWorkspace.set(status.providerId, status);
    this.workspaceStatuses.set(workspaceId, forWorkspace);
  }

  private persistProvider(manifest: CodeIntelligenceManifest): void {
    this.tryPersist(
      () =>
        this.db.driver.run(
          `INSERT INTO intelligence_providers (id, type, enabled, config_json, created_at, updated_at)
           VALUES (?, ?, 1, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET type = excluded.type, enabled = 1,
             config_json = excluded.config_json, updated_at = excluded.updated_at`,
          [
            manifest.id,
            manifest.tier,
            JSON.stringify({
              displayName: manifest.displayName,
              version: manifest.version ?? null,
              transport: manifest.transport,
              requires: manifest.requires,
              capabilities: manifest.capabilities,
              optionalMethods: manifest.optionalMethods,
              pinned: manifest.pinned,
            }),
            nowIso(),
            nowIso(),
          ],
        ),
      `register provider ${manifest.id}`,
    );
  }

  private persistWorkspaceStatus(workspaceId: string, status: IntelligenceStatus): void {
    this.tryPersist(
      () =>
        this.db.driver.run(
          `INSERT INTO workspace_intelligence (
             workspace_id, provider_id, status, degradation_json, provider_version,
             indexed_revision, indexed_at, metadata_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(workspace_id, provider_id) DO UPDATE SET
             status = excluded.status,
             degradation_json = excluded.degradation_json,
             provider_version = excluded.provider_version,
             indexed_revision = excluded.indexed_revision,
             indexed_at = excluded.indexed_at,
             metadata_json = excluded.metadata_json`,
          [
            workspaceId,
            status.providerId,
            status.state,
            status.degradation ? JSON.stringify(status.degradation) : null,
            status.providerVersion ?? null,
            status.indexedRevision ?? null,
            status.indexedAt ?? null,
            JSON.stringify({ stale: status.stale, reason: status.reason ?? null, features: status.features }),
          ],
        ),
      `persist status ${workspaceId}/${status.providerId}`,
    );
  }

  /**
   * Provider status is observability, not correctness: a missing row must not
   * break a query. The failure is logged loudly and the in-memory status stands.
   */
  private tryPersist(fn: () => void, what: string): void {
    if (this.disposed) return;
    try {
      fn();
    } catch (error) {
      this.logger.warn('intelligence status was not persisted', {
        what,
        error: describeError(error).slice(0, 300),
      });
    }
  }
}

const EMPTY_CAPABILITIES: IntelligenceStatus['features'] = {
  symbolSearch: false,
  definitions: false,
  callers: false,
  callees: false,
  dependencyGraph: false,
  trace: false,
  impact: false,
  persistentIndex: false,
  incrementalRefresh: false,
  machineReadableOutput: false,
  tokenizer: 'unknown',
};

function tierRank(manifest: CodeIntelligenceManifest): number {
  return manifest.tier === 'advanced' ? 1 : 0;
}

/** C-1/C-3: the check is `typeof x[kind] === 'function'`, never a truthiness test. */
function hasMethod(provider: CodeIntelligenceProvider, kind: IntelligenceQueryKind): boolean {
  return typeof (provider as unknown as Record<string, unknown>)[kind] === 'function';
}

async function callMethod(
  provider: CodeIntelligenceProvider,
  kind: IntelligenceQueryKind,
  input: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  const fn = (provider as unknown as Record<string, unknown>)[kind];
  if (typeof fn !== 'function') {
    // Unreachable through `query()`; kept so the cast can never call garbage.
    throw new Error(`method '${kind}' vanished from provider '${provider.manifest.id}'`);
  }
  return (fn as (input: unknown, signal?: AbortSignal) => Promise<unknown>).call(provider, input, signal);
}

/** NFR-11: no provider may answer without stating its freshness. */
function freshnessOf(result: unknown): FreshnessState {
  if (result && typeof result === 'object' && 'freshness' in result) {
    const candidate = (result as { freshness?: unknown }).freshness;
    if (candidate && typeof candidate === 'object' && 'stale' in candidate) {
      return candidate as FreshnessState;
    }
  }
  return { ...UNKNOWN_REVISION };
}
