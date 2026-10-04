/**
 * §4.8 / §5 — Project Intelligence.
 *
 * Three rules drive every decision in this file:
 *
 *  NFR-09 — "degraded" on its own is not information. `IntelligenceStatus`
 *  carries `degradation.because` and `degradation.since`, and both are shown;
 *  "degraded because the backend is unreachable" is something the user can act
 *  on, "degraded" is not.
 *
 *  NFR-11 — nothing stale may look current. The Basic provider is permanently
 *  `stale: true` because it has no persistent index, so its `not_indexed` state
 *  is rendered together with an explicit sentence saying its results are not
 *  the current code. A `ready`-looking badge on top of a scan-every-time
 *  provider would be a lie.
 *
 *  C-1 / C-5 — absence is a fact. `optionalMethods` is rendered explicitly, and
 *  each capability flag gets its own row, because a provider that does not
 *  implement `callers` is NOT the same as one whose `callers` query returned an
 *  empty list. `unsupported` and `error` therefore get different notices.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  CodeIntelligenceCapabilities,
  CodeIntelligenceManifest,
  FreshnessState,
  IntelligenceOperationHandle,
  IntelligenceQueryKind,
  IntelligenceStatus,
  OptionalIntelligenceMethod,
} from '@ucad/contracts';
import { getApi } from '../api';
import { useT } from '../i18n-context';
import type { AppData } from '../state/hooks';

const QUERY_KINDS: readonly IntelligenceQueryKind[] = [
  'search',
  'locate',
  'overview',
  'callers',
  'callees',
  'trace',
  'impact',
];

const OPTIONAL_METHODS: readonly OptionalIntelligenceMethod[] = [
  'callers',
  'callees',
  'trace',
  'impact',
];

/** Ordered so the table reads the same way for every provider. */
const CAPABILITY_KEYS = [
  'symbolSearch',
  'definitions',
  'callers',
  'callees',
  'dependencyGraph',
  'trace',
  'impact',
  'persistentIndex',
  'incrementalRefresh',
  'machineReadableOutput',
] as const satisfies ReadonlyArray<keyof CodeIntelligenceCapabilities>;

/**
 * The wire shape of `intelligence.query`.
 *
 * `UcadApi.intelligence.query` is declared as returning only `{ operationId }`,
 * but Main resolves with the manager's full outcome attached. Rather than trust
 * either, the outcome is narrowed at runtime and an unrecognised payload is shown
 * as-is instead of being rendered as a successful empty result.
 */
interface QueryOutcome {
  status: 'ok' | 'cancelled' | 'error' | 'unsupported';
  result: unknown;
  freshness?: FreshnessState;
  durationMs?: number;
  providerId?: string;
  reason?: string;
}

interface QueryReport {
  kind: IntelligenceQueryKind;
  outcome: QueryOutcome | null;
  /** the payload as it came back, kept for the unrecognised-shape case */
  raw: unknown;
  /** the whole call failed (IPC rejected) rather than returning an outcome */
  failure: string | null;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toOutcome(value: unknown): QueryOutcome | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Record<string, unknown>;
  const status = candidate['status'];
  if (status !== 'ok' && status !== 'cancelled' && status !== 'error' && status !== 'unsupported') {
    return null;
  }
  return {
    status,
    result: candidate['result'],
    freshness: (candidate['freshness'] ?? undefined) as FreshnessState | undefined,
    durationMs: typeof candidate['durationMs'] === 'number' ? candidate['durationMs'] : undefined,
    providerId: typeof candidate['providerId'] === 'string' ? candidate['providerId'] : undefined,
    reason: typeof candidate['reason'] === 'string' ? candidate['reason'] : undefined,
  };
}

export function IntelligencePanel({ data }: { data: AppData }): JSX.Element {
  const t = useT();
  const api = useMemo(() => getApi(), []);

  const [providers, setProviders] = useState<CodeIntelligenceManifest[]>([]);
  const [providersLoaded, setProvidersLoaded] = useState(false);
  const [providersFailed, setProvidersFailed] = useState<string | null>(null);
  const [providerId, setProviderId] = useState<string | null>(null);

  const [status, setStatus] = useState<IntelligenceStatus | null>(null);
  const [statusFailure, setStatusFailure] = useState<string | null>(null);

  const [handle, setHandle] = useState<IntelligenceOperationHandle | null>(null);
  const [opFailure, setOpFailure] = useState<string | null>(null);
  const [opBusy, setOpBusy] = useState(false);
  const [cancelNote, setCancelNote] = useState<string | null>(null);

  const [kind, setKind] = useState<IntelligenceQueryKind>('search');
  const [question, setQuestion] = useState('');
  const [queryBusy, setQueryBusy] = useState(false);
  const [report, setReport] = useState<QueryReport | null>(null);

  const workspaceId = data.workspace?.id ?? null;

  const loadProviders = useCallback(async () => {
    setProvidersFailed(null);
    try {
      const list = await api.intelligence.listProviders();
      setProviders(list);
      setProviderId((current) =>
        current !== null && list.some((entry) => entry.id === current)
          ? current
          : (list[0]?.id ?? null),
      );
    } catch (error) {
      // Never fall back to an empty table here: an empty table and a failed
      // fetch look identical, and only one of them is true.
      setProvidersFailed(message(error));
    } finally {
      setProvidersLoaded(true);
    }
  }, [api]);

  useEffect(() => {
    void loadProviders();
  }, [loadProviders]);

  const loadStatus = useCallback(async () => {
    if (!workspaceId || !providerId) {
      setStatus(null);
      return;
    }
    setStatusFailure(null);
    try {
      setStatus(await api.intelligence.status(workspaceId, providerId));
    } catch (error) {
      setStatus(null);
      setStatusFailure(message(error));
    }
  }, [api, workspaceId, providerId]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const runOperation = useCallback(
    async (operation: 'index' | 'refresh') => {
      if (!workspaceId || !providerId) return;
      setOpBusy(true);
      setOpFailure(null);
      setCancelNote(null);
      try {
        const started =
          operation === 'index'
            ? await api.intelligence.index(workspaceId, providerId)
            : await api.intelligence.refresh(workspaceId, providerId);
        setHandle(started);
        // The handle only says the work started; the status is the truth.
        await loadStatus();
      } catch (error) {
        setHandle(null);
        setOpFailure(`${t(operation === 'index' ? 'intel.index' : 'intel.refresh')} — ${message(error)}`);
      } finally {
        setOpBusy(false);
      }
    },
    [api, workspaceId, providerId, loadStatus, t],
  );

  const cancelOperation = useCallback(async () => {
    if (!handle) return;
    setOpFailure(null);
    try {
      const result = await api.intelligence.cancel(handle.operationId);
      // The Renderer contract types this as `{ cancelled }`; the manager also
      // reports why a cancel missed, so read the extra field if it is there.
      const reason = (result as { reason?: unknown }).reason;
      setCancelNote(
        result.cancelled
          ? t('intel.cancelled')
          : (typeof reason === 'string' ? reason : t('intel.cancelMissed')),
      );
      await loadStatus();
    } catch (error) {
      setOpFailure(message(error));
    }
  }, [api, handle, loadStatus, t]);

  const runQuery = useCallback(async () => {
    if (!workspaceId) return;
    setQueryBusy(true);
    try {
      const raw = await api.intelligence.query({
        workspaceId,
        kind,
        input: queryInputFor(kind, question),
      });
      const envelope = raw as { result?: unknown };
      const payload = 'result' in envelope ? envelope.result : raw;
      setReport({ kind, outcome: toOutcome(payload), raw: payload, failure: null });
    } catch (error) {
      setReport({ kind, outcome: null, raw: null, failure: message(error) });
    } finally {
      setQueryBusy(false);
    }
  }, [api, workspaceId, kind, question]);

  const manifest = providers.find((entry) => entry.id === providerId) ?? null;

  return (
    <div className="pane">
      <div className="pane-head">
        <h1>{t('intel.title')}</h1>
        <p>{t('intel.subtitle')}</p>
      </div>

      {!workspaceId && <div className="notice warn">{t('intel.noWorkspace')}</div>}

      {providersFailed && (
        <div className="notice error">
          {t('intel.loadFailed')} — {providersFailed}
        </div>
      )}

      {providers.length === 0 && !providersFailed && !providersLoaded && (
        <div className="faint">{t('common.loading')}</div>
      )}

      {providers.length === 0 && providersLoaded && !providersFailed && (
        <div className="notice warn">{t('intel.loadFailed')}</div>
      )}

      {providers.length > 0 && (
        <div className="card">
          <h2>{t('intel.providers')}</h2>
          <div className="row-gap" style={{ flexWrap: 'wrap' }}>
            {providers.map((entry) => (
              <button
                key={entry.id}
                className={entry.id === providerId ? 'primary' : ''}
                onClick={() => setProviderId(entry.id)}
              >
                {entry.id}
              </button>
            ))}
          </div>
        </div>
      )}

      {manifest && (
        <div className="card">
          <h2>
            {manifest.id} · {manifest.displayName}
          </h2>
          <div className="defs">
            <Def k={t('intel.tier')}>{manifest.tier}</Def>
            <Def k={t('intel.transport')}>{manifest.transport}</Def>
            <Def k={t('intel.requires')}>{manifest.requires.join(', ') || t('common.none')}</Def>
            <Def k={t('intel.tokenizer')}>{manifest.capabilities.tokenizer}</Def>
          </div>

          <div className="block-title" style={{ marginTop: 14 }}>
            <span>{t('intel.capabilities')}</span>
          </div>
          <div className="cap-grid">
            {CAPABILITY_KEYS.map((key) => (
              <span key={key} className={manifest.capabilities[key] ? 'cap on' : 'cap off'}>
                <span className="glyph">{manifest.capabilities[key] ? '✓' : '✗'}</span>
                {t(`intel.cap.${key}`)}
                <span className="cap-state">
                  {manifest.capabilities[key] ? t('intel.present') : t('intel.absent')}
                </span>
              </span>
            ))}
          </div>

          <div className="block-title" style={{ marginTop: 14 }}>
            <span>{t('intel.optionalMethods')}</span>
          </div>
          {manifest.optionalMethods.length === 0 ? (
            <div className="faint" style={{ fontSize: 11.5 }}>
              {t('intel.optionalNone')}
            </div>
          ) : (
            <div className="row-gap" style={{ flexWrap: 'wrap' }}>
              {OPTIONAL_METHODS.map((method) => {
                const implemented = manifest.optionalMethods.includes(method);
                return (
                  <span key={method} className={implemented ? 'cap on' : 'cap off'}>
                    <span className="glyph">{implemented ? '✓' : '✗'}</span>
                    <span className="mono">{method}</span>
                    <span className="cap-state">
                      {implemented ? t('intel.optionalPresent') : t('intel.optionalAbsent')}
                    </span>
                  </span>
                );
              })}
            </div>
          )}
        </div>
      )}

      <div className="card">
        <h2>{t('intel.status')}</h2>

        {statusFailure && (
          <div className="notice error" style={{ marginBottom: 10 }}>
            {statusFailure}
          </div>
        )}

        {status ? (
          <>
            <div className="row-gap" style={{ flexWrap: 'wrap' }}>
              <span className={`badge ${stateBadge(status.state)}`}>{status.state}</span>
              {status.stale ? (
                <span className="badge warn">{t('intel.stale')}</span>
              ) : (
                <span className="badge ok">{t('intel.fresh')}</span>
              )}
              {status.indexedAt && <span className="badge mono">{status.indexedAt}</span>}
            </div>

            {status.stale && (
              <div className="notice warn" style={{ marginTop: 10 }}>
                {status.features.persistentIndex ? t('intel.staleGeneric') : t('intel.staleBasic')}
              </div>
            )}

            <div className="defs" style={{ marginTop: 10 }}>
              <Def k={t('intel.reason')}>{status.reason ?? t('common.none')}</Def>
              <Def k={t('intel.indexedAt')}>{status.indexedAt ?? t('common.none')}</Def>
              <Def k={t('intel.indexedRevision')}>{status.indexedRevision ?? t('common.none')}</Def>
            </div>

            {status.degradation && (
              <div className="notice error" style={{ marginTop: 10 }}>
                <div>
                  <strong>{t('intel.degradation')}</strong>: {status.degradation.because}
                </div>
                <div className="faint" style={{ marginTop: 4, fontSize: 11.5 }}>
                  {t('intel.degradedSince')}: {status.degradation.since}
                </div>
              </div>
            )}
          </>
        ) : (
          !statusFailure && <div className="faint">{t('common.loading')}</div>
        )}

        <div className="row-gap" style={{ marginTop: 12, flexWrap: 'wrap' }}>
          <button onClick={() => void runOperation('index')} disabled={opBusy || !providerId}>
            {t('intel.index')}
          </button>
          <button onClick={() => void runOperation('refresh')} disabled={opBusy || !providerId}>
            {t('intel.refresh')}
          </button>
          {handle && (
            <button className="danger" onClick={() => void cancelOperation()}>
              {t('intel.cancel')}
            </button>
          )}
        </div>

        {opFailure && (
          <div className="notice error" style={{ marginTop: 10 }}>
            {opFailure}
          </div>
        )}

        {handle && (
          <div className="defs" style={{ marginTop: 10 }}>
            <Def k={t('intel.opId')}>
              <span className="mono truncate">{handle.operationId}</span>
            </Def>
            <Def k="kind">
              <span className="mono">{handle.kind}</span>
            </Def>
            <Def k={t('intel.opStartedAt')}>
              <span className="mono">{handle.startedAt}</span>
            </Def>
          </div>
        )}

        {cancelNote && <div className="faint" style={{ marginTop: 8 }}>{cancelNote}</div>}
      </div>

      <div className="card">
        <h2>{t('intel.ask')}</h2>
        <div className="faint" style={{ fontSize: 11.5, marginBottom: 10 }}>
          {t('intel.askHint')}
        </div>

        <div className="row-gap" style={{ flexWrap: 'wrap' }}>
          <select
            className="picker-select"
            value={kind}
            onChange={(event) => setKind(event.target.value as IntelligenceQueryKind)}
            aria-label={t('intel.kind')}
          >
            {QUERY_KINDS.map((entry) => (
              <option key={entry} value={entry}>
                {entry}
              </option>
            ))}
          </select>
          <input
            value={question}
            placeholder={t('intel.queryInput')}
            onChange={(event) => setQuestion(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void runQuery();
            }}
          />
          <button className="primary" onClick={() => void runQuery()} disabled={queryBusy}>
            {queryBusy ? t('intel.querying') : t('intel.runQuery')}
          </button>
        </div>

        {report && <QueryReportView report={report} />}
      </div>
    </div>
  );
}

function QueryReportView({ report }: { report: QueryReport }): JSX.Element {
  const t = useT();

  if (report.failure !== null) {
    return (
      <div style={{ marginTop: 12 }}>
        <div className="notice error">
          {t('intel.queryError')} — {report.failure}
        </div>
      </div>
    );
  }

  const outcome = report.outcome;
  if (!outcome) {
    return (
      <div style={{ marginTop: 12 }}>
        <div className="notice warn">
          {t('intel.unknownShape')}
          <div className="code" style={{ marginTop: 8 }}>
            {JSON.stringify(report.raw, null, 2)}
          </div>
        </div>
      </div>
    );
  }

  if (outcome.status === 'unsupported') {
    return (
      <div style={{ marginTop: 12 }}>
        <div className="notice warn">
          <div>
            <span className="badge warn">{outcome.status}</span> {t('intel.queryUnsupported')}
          </div>
          {outcome.reason && (
            <div className="faint" style={{ marginTop: 5, fontSize: 11.5 }}>
              {outcome.reason}
            </div>
          )}
        </div>
      </div>
    );
  }

  if (outcome.status === 'error') {
    return (
      <div style={{ marginTop: 12 }}>
        <div className="notice error">
          <div>
            <span className="badge err">{outcome.status}</span> {t('intel.queryError')}
          </div>
          {outcome.reason && (
            <div className="error-text" style={{ marginTop: 5 }}>
              {outcome.reason}
            </div>
          )}
        </div>
      </div>
    );
  }

  if (outcome.status === 'cancelled') {
    return (
      <div style={{ marginTop: 12 }}>
        <div className="notice warn">
          <span className="badge warn">{outcome.status}</span> {t('intel.queryCancelled')}
          {outcome.reason && (
            <div className="faint" style={{ marginTop: 5, fontSize: 11.5 }}>
              {outcome.reason}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div style={{ marginTop: 12 }}>
      <div className="notice info">
        <span className="badge ok">{outcome.status}</span> {t('intel.queryOk')}
        {outcome.durationMs !== undefined && (
          <span className="faint" style={{ marginLeft: 6 }}>
            {outcome.durationMs}ms
          </span>
        )}
      </div>
      <FreshnessLine freshness={outcome.freshness} />
      <ResultBody kind={report.kind} result={outcome.result} />
    </div>
  );
}

function FreshnessLine({ freshness }: { freshness?: FreshnessState }): JSX.Element | null {
  const t = useT();
  if (!freshness) return null;
  return (
    <div className={`notice ${freshness.stale ? 'warn' : 'info'}`} style={{ marginTop: 8 }}>
      {t('intel.freshness')}:{' '}
      <span className={freshness.stale ? 'badge warn' : 'badge ok'}>
        {freshness.stale ? t('intel.stale') : t('intel.fresh')}
      </span>{' '}
      <span className="faint mono">{freshness.stalenessReason ?? '—'}</span>
    </div>
  );
}

interface LocationLike {
  path?: unknown;
  startLine?: unknown;
  endLine?: unknown;
  symbol?: unknown;
}

function LocationRow({ location }: { location: LocationLike }): JSX.Element {
  const path = typeof location.path === 'string' ? location.path : '—';
  const start = typeof location.startLine === 'number' ? location.startLine : 0;
  const end = typeof location.endLine === 'number' ? location.endLine : start;
  const symbol = typeof location.symbol === 'string' ? location.symbol : null;
  return (
    <div className="def">
      <span className="k mono truncate" title={path}>
        {symbol ? `${symbol} — ` : ''}
        {path}
      </span>
      <span className="v mono">
        {start}
        {end !== start ? `-${end}` : ''}
      </span>
    </div>
  );
}

function ResultBody({
  kind: _kind,
  result,
}: {
  kind: IntelligenceQueryKind;
  result: unknown;
}): JSX.Element {
  const t = useT();

  if (result === null || result === undefined) {
    return <div className="empty">{t('intel.noItems')}</div>;
  }

  const locations = locationsOf(result);
  if (locations) {
    return (
      <div style={{ marginTop: 10 }}>
        <div className="block-title">
          <span>{t('intel.items')}</span>
          <span>{locations.length}</span>
        </div>
        {locations.length === 0 ? (
          <div className="faint">{t('intel.noItems')}</div>
        ) : (
          <div className="defs">
            {locations.map((location, index) => (
              <LocationRow key={index} location={location} />
            ))}
          </div>
        )}
      </div>
    );
  }

  const overview = overviewOf(result);
  if (overview) {
    return (
      <div style={{ marginTop: 10 }}>
        <div className="block-title">
          <span>{t('intel.summary')}</span>
        </div>
        <div style={{ fontSize: 12.5 }}>{overview.summary}</div>
        {overview.modules && overview.modules.length > 0 && (
          <>
            <div className="block-title" style={{ marginTop: 12 }}>
              <span>{t('intel.modules')}</span>
            </div>
            <div className="defs">
              {overview.modules.map((module) => (
                <div className="def" key={module.path}>
                  <span className="k mono truncate" title={module.path}>
                    {module.name}
                  </span>
                  <span className="v mono">{module.symbols}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    );
  }

  return (
    <div style={{ marginTop: 10 }}>
      <div className="block-title">
        <span>{t('intel.rawResult')}</span>
      </div>
      <div className="faint" style={{ fontSize: 11.5, marginBottom: 6 }}>
        {t('intel.unknownShape')}
      </div>
      <div className="code">{JSON.stringify(result, null, 2)}</div>
    </div>
  );
}

function locationsOf(result: unknown): LocationLike[] | null {
  const container = Array.isArray(result)
    ? result
    : typeof result === 'object' && result !== null
      ? (result as Record<string, unknown>)['items']
      : null;
  if (!Array.isArray(container)) return null;
  return container.filter(
    (entry): entry is LocationLike => typeof entry === 'object' && entry !== null,
  );
}

interface OverviewLike {
  summary: string;
  modules?: Array<{ name: string; path: string; symbols: number }>;
}

function overviewOf(result: unknown): OverviewLike | null {
  if (typeof result !== 'object' || result === null) return null;
  const summary = (result as Record<string, unknown>)['summary'];
  if (typeof summary !== 'string') return null;
  const modules = (result as Record<string, unknown>)['modules'];
  return {
    summary,
    modules: Array.isArray(modules)
      ? modules.filter(
          (entry): entry is { name: string; path: string; symbols: number } =>
            typeof entry === 'object' && entry !== null,
        )
      : undefined,
  };
}

/** The input Main merges into the provider call for each kind. */
function queryInputFor(kind: IntelligenceQueryKind, question: string): unknown {
  const value = question.trim();
  if (kind === 'search') return { query: value };
  if (kind === 'locate') return { symbol: value };
  if (kind === 'overview') return value ? { target: value } : {};
  return { target: value };
}

function stateBadge(state: IntelligenceStatus['state']): string {
  if (state === 'ready') return 'ok';
  if (state === 'degraded' || state === 'unavailable' || state === 'error') return 'err';
  return 'warn';
}

function Def({ k, children }: { k: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="def">
      <span className="k">{k}</span>
      <span className="v">{children}</span>
    </div>
  );
}
