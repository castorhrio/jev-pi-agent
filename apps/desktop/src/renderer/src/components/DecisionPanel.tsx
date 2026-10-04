/**
 * The Decision plane: which engines exist, what they declare, which ones this
 * session actually runs — and, the part that used to be unanswerable, the
 * answer to "why this one" *before* the turn.
 *
 * `decision.preview` is the same call the runtime makes at the turn boundary,
 * through the same chain and the same mandatory `rationale` / `confidence`
 * (NFR-16), surfaced earlier. Showing it here is what turns a claim about
 * explainability into something the user can check.
 *
 * NFR-14: an engine that declares `network` is not merely labelled — it cannot
 * be put in the chain while `allowNetworkEngines` is off, because "it has a
 * side effect" and "the user authorised that side effect" are two facts and
 * only one of them is true by default.
 */

import { useCallback, useEffect, useState } from 'react';
import type {
  DeepPartial,
  DecisionEngineManifest,
  DecisionKind,
  DecisionOutcome,
  DecisionResult,
  SettingsSnapshot,
} from '@ucad/contracts';
import { getApi } from '../api';
import { useT } from '../i18n-context';
import type { Translate } from '../../../shared/i18n';
import type { AppData } from '../state/hooks';
import type { SessionViewState } from '../state/session-reducer';

const KINDS: ReadonlyArray<DecisionKind> = [
  'route',
  'risk',
  'continue_or_stop',
  'context_relevance',
  'clarify',
  'option_select',
];

export function DecisionPanel({
  data,
  view,
  onEnsureSession,
  onChanged,
}: {
  data: AppData;
  view: SessionViewState;
  onEnsureSession: () => Promise<string | null>;
  onChanged: () => void;
}): JSX.Element {
  const t = useT();

  const [engines, setEngines] = useState<DecisionEngineManifest[]>([]);
  const [enginesError, setEnginesError] = useState<string | null>(null);
  const [loadingEngines, setLoadingEngines] = useState(true);

  const [autoRoute, setAutoRoute] = useState(data.settings?.decision.autoRoute ?? false);
  const [allowNetwork, setAllowNetwork] = useState(
    data.settings?.decision.allowNetworkEngines ?? false,
  );
  const [chain, setChain] = useState<string[]>(data.settings?.decision.chain ?? ['rule']);
  const [savingChain, setSavingChain] = useState(false);
  const [chainNote, setChainNote] = useState<string | null>(null);
  const [chainError, setChainError] = useState<string | null>(null);

  const [objective, setObjective] = useState('');
  const [kind, setKind] = useState<DecisionKind>('route');
  const [deciding, setDeciding] = useState(false);
  const [result, setResult] = useState<DecisionResult | null>(null);
  const [decisionError, setDecisionError] = useState<string | null>(null);

  const loadEngines = useCallback(() => {
    let cancelled = false;
    setLoadingEngines(true);
    void getApi()
      .decision.listEngines()
      .then((list) => {
        if (cancelled) return;
        setEngines(list);
        setEnginesError(null);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setEngines([]);
        setEnginesError(errorMessage(error, t));
      })
      .finally(() => {
        if (!cancelled) setLoadingEngines(false);
      });
    return () => {
      cancelled = true;
    };
  }, [t]);

  useEffect(() => loadEngines(), [loadEngines]);

  // Settings arrive after the first render; the local mirrors must not strand
  // the panel on its defaults.
  useEffect(() => {
    const decision = data.settings?.decision;
    if (!decision) return;
    setAutoRoute(decision.autoRoute);
    setAllowNetwork(decision.allowNetworkEngines);
    setChain(decision.chain);
  }, [data.settings]);

  const patch = useCallback(
    async (next: DeepPartial<SettingsSnapshot>) => {
      try {
        await getApi().settings.patch(next);
        onChanged();
      } catch (error) {
        // A rejected patch must not become an unhandled rejection, and a
        // checkbox that silently did not save is the same class of lie as an
        // empty list: say what happened.
        setChainError(errorMessage(error, t));
      }
    },
    [onChanged, t],
  );

  const toggleEngine = useCallback(
    (id: string, sideEffects: ReadonlyArray<string>) => {
      setChain((current) => {
        if (current.includes(id)) {
          const remaining = current.filter((entry) => entry !== id);
          return remaining.length > 0 ? remaining : current;
        }
        if (sideEffects.includes('network') && !allowNetwork) return current;
        return [...current, id];
      });
    },
    [allowNetwork],
  );

  const applyChain = useCallback(async () => {
    setChainError(null);
    setChainNote(null);
    if (chain.length === 0) {
      setChainError(t('decision.chainEmpty'));
      return;
    }
    setSavingChain(true);
    try {
      await getApi().decision.setChain(chain);
      onChanged();
      setChainNote(t('decision.chainSaved'));
    } catch (error) {
      setChainError(errorMessage(error, t));
    } finally {
      setSavingChain(false);
    }
  }, [chain, onChanged, t]);

  const runPreview = useCallback(async () => {
    const body = objective.trim();
    setDecisionError(null);
    if (!body) {
      setDecisionError(t('decision.previewEmpty'));
      return;
    }
    setDeciding(true);
    try {
      const sessionId = await onEnsureSession();
      if (!sessionId) {
        setDecisionError(t('decision.needsSession'));
        return;
      }
      setResult(await getApi().decision.preview({ sessionId, objective: body, kind }));
    } catch (error) {
      setResult(null);
      setDecisionError(errorMessage(error, t));
    } finally {
      setDeciding(false);
    }
  }, [objective, kind, onEnsureSession, t]);

  return (
    <div className="pane">
      <div className="pane-head">
        <h1>{t('decision.title')}</h1>
        <p>{t('decision.subtitle')}</p>
      </div>

      <div className="card">
        <h2>{t('decision.engines')}</h2>
        {enginesError && <div className="notice error">{enginesError}</div>}
        {!enginesError && loadingEngines && <div className="faint">{t('common.loading')}</div>}
        {!enginesError && !loadingEngines && engines.length === 0 && (
          <div className="faint">{t('decision.noEngines')}</div>
        )}
        {engines.length > 0 && (
          <table className="grid">
            <thead>
              <tr>
                <th style={{ width: 1 }}>{t('decision.inChain')}</th>
                <th>{t('decision.engineColumn')}</th>
                <th>{t('decision.sideEffects')}</th>
                <th>{t('decision.kinds')}</th>
                <th style={{ width: 1 }}>{t('decision.timeout')}</th>
              </tr>
            </thead>
            <tbody>
              {engines.map((engine) => (
                <EngineRow
                  key={engine.id}
                  engine={engine}
                  selected={chain.includes(engine.id)}
                  allowNetwork={allowNetwork}
                  onToggle={() => toggleEngine(engine.id, engine.sideEffects)}
                />
              ))}
            </tbody>
          </table>
        )}

        <div className="row-gap" style={{ marginTop: 10, flexWrap: 'wrap' }}>
          <button className="primary" disabled={savingChain} onClick={() => void applyChain()}>
            {savingChain ? t('decision.chainSaving') : t('decision.chainApply')}
          </button>
          <span className="faint mono" style={{ fontSize: 11 }}>
            {t('decision.chain')}: {chain.join(' > ') || '—'} ·{' '}
            {data.settings?.decision.timeoutMs ?? 2000}ms
          </span>
        </div>
        {chainNote && (
          <div className="faint" style={{ fontSize: 11.5, marginTop: 6 }}>
            {chainNote}
          </div>
        )}
        {chainError && (
          <div className="notice error" style={{ marginTop: 8 }}>
            {chainError}
          </div>
        )}

        <label className="check">
          <input
            type="checkbox"
            className="checkbox"
            checked={autoRoute}
            onChange={(e) => {
              setAutoRoute(e.target.checked);
              void patch({ decision: { autoRoute: e.target.checked } });
            }}
          />
          <span>{t('decision.autoRoute')}</span>
        </label>
        <label className="check">
          <input
            type="checkbox"
            className="checkbox"
            checked={allowNetwork}
            onChange={(e) => {
              setAllowNetwork(e.target.checked);
              void patch({ decision: { allowNetworkEngines: e.target.checked } });
            }}
          />
          <span>{t('decision.allowNetwork')}</span>
        </label>
      </div>

      <div className="card">
        <h2>{t('decision.previewTitle')}</h2>
        <div className="faint" style={{ fontSize: 11.5, marginBottom: 8 }}>
          {t('decision.previewHint')}
        </div>
        <textarea
          rows={2}
          placeholder={t('decision.previewPlaceholder')}
          value={objective}
          onChange={(e) => setObjective(e.target.value)}
        />
        <div className="row-gap" style={{ marginTop: 8, flexWrap: 'wrap' }}>
          <select
            className="picker-select"
            value={kind}
            aria-label={t('decision.kind')}
            onChange={(e) => setKind(e.target.value as DecisionKind)}
          >
            {KINDS.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
          <button
            className="primary"
            disabled={deciding || objective.trim() === ''}
            onClick={() => void runPreview()}
          >
            {deciding ? t('decision.previewBusy') : t('decision.previewAction')}
          </button>
        </div>
        {decisionError && (
          <div className="notice error" style={{ marginTop: 10 }}>
            {decisionError}
          </div>
        )}
        {result && <ResultView result={result} />}
      </div>

      <div className="card">
        <h2>
          {t('decision.recent')} ({view.decisions.length})
        </h2>
        {view.decisions.length === 0 ? (
          <div className="faint">{t('empty.decision')}</div>
        ) : (
          <table className="grid">
            <thead>
              <tr>
                <th>{t('decision.kindColumn')}</th>
                <th>
                  <span className="sr-only">{t('col.reason')}</span>
                </th>
                <th>{t('decision.confidence')}</th>
                <th>{t('decision.engine')}</th>
              </tr>
            </thead>
            <tbody>
              {view.decisions
                .slice()
                .reverse()
                .map((decision) => (
                  <tr key={decision.requestId}>
                    <td className="mono">{decision.kind}</td>
                    <td>
                      {decision.summary}
                      {decision.fallbackUsed && (
                        <span className="badge warn" style={{ marginLeft: 6 }}>
                          {t('decision.fallback')}
                        </span>
                      )}
                      <div className="faint" style={{ marginTop: 3, fontSize: 11.5 }}>
                        {decision.rationale}
                      </div>
                    </td>
                    <td className="mono">{(decision.confidence * 100).toFixed(0)}%</td>
                    <td className="mono">{decision.engineId}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function EngineRow({
  engine,
  selected,
  allowNetwork,
  onToggle,
}: {
  engine: DecisionEngineManifest;
  selected: boolean;
  allowNetwork: boolean;
  onToggle: () => void;
}): JSX.Element {
  const t = useT();
  const gated = engine.sideEffects.includes('network') && !allowNetwork;
  return (
    <tr>
      <td>
        <input
          type="checkbox"
          className="checkbox"
          style={{ width: 'auto' }}
          checked={selected}
          disabled={gated}
          onChange={onToggle}
          aria-label={engine.id}
        />
      </td>
      <td>
        <div>{engine.displayName}</div>
        <div className="faint mono" style={{ fontSize: 10.5 }}>
          {engine.id}
          {engine.version ? ` · ${engine.version}` : ''}
        </div>
        {gated && (
          <div className="badge warn" style={{ marginTop: 4 }}>
            {t('decision.networkGated')}
          </div>
        )}
      </td>
      <td>
        {engine.sideEffects.map((effect) => (
          <span
            key={effect}
            className={`badge ${effect === 'none' ? 'ok' : 'warn'}`}
            style={{ marginRight: 4 }}
          >
            {effect}
          </span>
        ))}
      </td>
      <td className="mono" style={{ fontSize: 10.5 }}>
        {engine.supportedKinds.join(', ')}
      </td>
      <td className="mono" style={{ width: 1 }}>
        {engine.timeoutMs}ms
      </td>
    </tr>
  );
}

function ResultView({ result }: { result: DecisionResult }): JSX.Element {
  const t = useT();
  return (
    <div style={{ marginTop: 12 }}>
      <div className="defs">
        <div className="def">
          <span className="k">{t('decision.outcome')}</span>
          <span className="v truncate" title={describeOutcome(result.outcome)}>
            {describeOutcome(result.outcome)}
          </span>
        </div>
        <div className="def">
          <span className="k">{t('decision.confidence')}</span>
          <span className="v mono">{(result.confidence * 100).toFixed(0)}%</span>
        </div>
        <div className="def">
          <span className="k">{t('decision.producedBy')}</span>
          <span className="v mono">
            {result.producedBy.engineId}
            {result.producedBy.version ? ` · ${result.producedBy.version}` : ''}
          </span>
        </div>
        <div className="def">
          <span className="k">{t('decision.latency')}</span>
          <span className="v mono">{result.latencyMs}ms</span>
        </div>
      </div>

      {result.fallback && (
        <div className="notice warn" style={{ marginTop: 8 }}>
          {t('decision.fallbackReason', { reason: result.fallback.reason })}
        </div>
      )}

      <div className="block-title" style={{ marginTop: 12 }}>
        <span>{t('decision.rationale')}</span>
      </div>
      <div style={{ fontSize: 12.5 }}>{result.rationale}</div>

      {result.evidence && result.evidence.length > 0 && (
        <div className="defs" style={{ marginTop: 8 }}>
          {result.evidence.map((entry) => (
            <div className="def" key={entry.ref}>
              <span className="k mono truncate">{entry.ref}</span>
              <span className="v mono">{entry.weight ?? '—'}</span>
            </div>
          ))}
        </div>
      )}

      <div className="faint" style={{ fontSize: 10.5, marginTop: 8 }}>
        {t('decision.previewNote')}
      </div>
    </div>
  );
}

function describeOutcome(outcome: DecisionOutcome): string {
  switch (outcome.kind) {
    case 'route':
      return `> ${outcome.agentId}${outcome.modelId ? ` / ${outcome.modelId}` : ''}`;
    case 'risk':
      return `${outcome.risk} · ${outcome.categories.join(', ')}`;
    case 'continue_or_stop':
      return `${outcome.action} · ${outcome.reason}`;
    case 'clarify':
      return outcome.question;
    case 'option_select':
      return outcome.optionId;
    case 'context_relevance':
      return `${outcome.relevantItemIds.length} relevant`;
    default:
      return (outcome as { kind: string }).kind;
  }
}

function errorMessage(error: unknown, t: Translate): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  return t('common.unknown');
}
