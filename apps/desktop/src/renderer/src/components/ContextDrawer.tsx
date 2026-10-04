/**
 * The Context plane as a surface.
 *
 * Every other plane can be trusted on trust: the chat says what happened. This
 * one cannot. The product's single real claim is that injected context is
 * *verifiable* (§4.6 I-1: `render` is pure, so one pack always yields one
 * hash), and a claim the user cannot inspect is indistinguishable from a claim
 * that is not true. So this surface exists to make three things visible:
 *
 *   1. what *would* be packed, before the turn is sent (`context.preview`) —
 *      a preview charges no budget and writes no row;
 *   2. the exact rendered bytes and `renderedHash` of the last turn
 *      (`context.getInjection`), so the bytes can be checked against the hash;
 *   3. the item table behind that pack, including what was left out and why
 *      (`context.getPack`), plus what an extend changed (`context.extend`).
 *
 * T-3 is enforced structurally rather than by convention: `estimateSource` is
 * rendered inside the same header as the token column, so a token count can
 * never appear in this file without the provenance that qualifies it.
 *
 * The failure path is deliberate too. A rejected `context.preview` prints the
 * backend's own message — an empty panel that used to mean "no items" is the
 * exact regression this surface was written to remove.
 */

import { useCallback, useEffect, useState } from 'react';
import type {
  ContextInjectionPlan,
  ContextItem,
  ContextOmitReason,
  ContextPack,
  ContextPackDelta,
  ContextStrategy,
  ExtendDropReason,
} from '@ucad/contracts';
import { getApi } from '../api';
import { useT } from '../i18n-context';
import type { Translate } from '../../../shared/i18n';
import type { AppData } from '../state/hooks';
import type { SessionViewState } from '../state/session-reducer';

const STRATEGIES: ReadonlyArray<ContextStrategy | 'auto'> = [
  'auto',
  'text_first',
  'graph_first',
  'hybrid',
];

export function ContextDrawer({
  data,
  view,
  onEnsureSession,
}: {
  data: AppData;
  view: SessionViewState;
  /** App owns session creation; the Drawer must not fork that logic. */
  onEnsureSession: () => Promise<string | null>;
}): JSX.Element {
  const t = useT();

  const [objective, setObjective] = useState('');
  const [strategy, setStrategy] = useState<ContextStrategy | 'auto'>('auto');
  const [budgetInput, setBudgetInput] = useState('');
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<ContextPack | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  // The live pack of the last turn, read back from storage rather than from the
  // event stream: the event carries counts, the pack carries the items.
  const packId = view.context?.packId ?? null;
  const [pack, setPack] = useState<ContextPack | null>(null);
  const [packError, setPackError] = useState<string | null>(null);
  const [loadingPack, setLoadingPack] = useState(false);

  // The bytes the agent actually received, keyed by the turn that received
  // them. `getInjection` is a separate call from `getPack` on purpose: it is
  // the one that answers "what was really sent", not "what was selected".
  const lastTurnId = view.messages[view.messages.length - 1]?.turnId ?? null;
  const [injection, setInjection] = useState<ContextInjectionPlan | null>(null);
  const [injectionError, setInjectionError] = useState<string | null>(null);

  const [request, setRequest] = useState('');
  const [extending, setExtending] = useState(false);
  const [delta, setDelta] = useState<ContextPackDelta | null>(null);
  const [deltaError, setDeltaError] = useState<string | null>(null);

  const packRevision = view.context?.revision ?? null;

  useEffect(() => {
    if (!packId) {
      setPack(null);
      setPackError(null);
      return;
    }
    let cancelled = false;
    setLoadingPack(true);
    void getApi()
      .context.getPack(packId)
      .then((next) => {
        if (cancelled) return;
        setPack(next);
        setPackError(null);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setPack(null);
        setPackError(errorMessage(error, t));
      })
      .finally(() => {
        if (!cancelled) setLoadingPack(false);
      });
    return () => {
      cancelled = true;
    };
    // `revision` moves when the pack is extended, so the table has to follow it.
  }, [packId, packRevision, t]);

  useEffect(() => {
    if (!lastTurnId) {
      setInjection(null);
      setInjectionError(null);
      return;
    }
    let cancelled = false;
    void getApi()
      .context.getInjection(lastTurnId)
      .then((plan) => {
        if (cancelled) return;
        setInjection(plan);
        setInjectionError(null);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setInjection(null);
        setInjectionError(errorMessage(error, t));
      });
    return () => {
      cancelled = true;
    };
  }, [lastTurnId, packRevision, t]);

  const runPreview = useCallback(async () => {
    const body = objective.trim();
    setPreviewError(null);
    if (!body) {
      setPreviewError(t('context.previewEmpty'));
      return;
    }
    if (!data.workspace) {
      setPreviewError(t('context.needWorkspace'));
      return;
    }
    const maxInputTokens = Number(budgetInput.trim());
    if (budgetInput.trim() !== '' && !(Number.isFinite(maxInputTokens) && maxInputTokens > 0)) {
      setPreviewError(t('context.budgetInvalid'));
      return;
    }

    setPreviewing(true);
    try {
      const sessionId = await onEnsureSession();
      if (!sessionId) {
        setPreviewError(t('context.needSession'));
        return;
      }
      // An empty `defaultAgentId` means "not chosen yet" (§defaults), not a
      // missing key, so this has to be a truthy check rather than `??`.
      const agentId =
        data.settings?.agent.defaultAgentId || data.agents[0]?.manifest.id || 'mock';
      const next = await getApi().context.preview({
        workspaceId: data.workspace.id,
        sessionId,
        objective: body,
        agentId,
        ...(maxInputTokens > 0 ? { budget: { maxInputTokens } } : {}),
        strategy,
      });
      setPreview(next);
    } catch (error) {
      setPreview(null);
      setPreviewError(errorMessage(error, t));
    } finally {
      setPreviewing(false);
    }
  }, [objective, budgetInput, data, onEnsureSession, strategy, t]);

  const runExtend = useCallback(async () => {
    const body = request.trim();
    if (!body || !packId) return;
    setDeltaError(null);
    setExtending(true);
    try {
      const next = await getApi().context.extend({ packId, request: body, maxItems: 10 });
      setDelta(next);
      setRequest('');
    } catch (error) {
      setDelta(null);
      setDeltaError(errorMessage(error, t));
    } finally {
      setExtending(false);
    }
  }, [request, packId, t]);

  return (
    <div className="pane">
      <div className="pane-head">
        <h1>{t('context.title')}</h1>
        <p>{t('context.subtitle')}</p>
      </div>

      <div className="card">
        <h2>{t('context.previewTitle')}</h2>
        <div className="faint" style={{ fontSize: 11.5, marginBottom: 8 }}>
          {t('context.previewHint')}
        </div>
        <textarea
          rows={2}
          placeholder={t('context.previewPlaceholder')}
          value={objective}
          onChange={(e) => setObjective(e.target.value)}
        />
        <div className="row-gap" style={{ marginTop: 8, flexWrap: 'wrap' }}>
          <select
            className="picker-select"
            value={strategy}
            aria-label={t('context.strategy')}
            onChange={(e) => setStrategy(e.target.value as ContextStrategy | 'auto')}
          >
            {STRATEGIES.map((value) => (
              <option key={value} value={value}>
                {value === 'auto' ? t('context.strategyAuto') : value}
              </option>
            ))}
          </select>
          <input
            style={{ width: 128 }}
            placeholder={t('context.budgetInput')}
            value={budgetInput}
            onChange={(e) => setBudgetInput(e.target.value)}
          />
          <button
            className="primary"
            disabled={previewing || objective.trim() === ''}
            onClick={() => void runPreview()}
          >
            {previewing ? t('context.previewBusy') : t('context.previewAction')}
          </button>
          <span className="faint" style={{ fontSize: 11 }}>
            {t('context.budgetHint')}
          </span>
        </div>
        {previewError && (
          <div className="notice error" style={{ marginTop: 10 }}>
            {previewError}
          </div>
        )}
      </div>

      {preview && (
        <div className="card">
          <h2>{t('context.previewResult')}</h2>
          <div className="faint" style={{ fontSize: 11.5, marginBottom: 8 }}>
            {t('context.previewNote')}
          </div>
          <PackDetails pack={preview} />
          {preview.injection && <InjectionBlock plan={preview.injection} />}
        </div>
      )}

      <div className="block">
        <div className="block-title">
          <span>{t('context.lastTurn')}</span>
          {lastTurnId && <span className="mono truncate">{lastTurnId}</span>}
        </div>
        {injectionError && <div className="notice error">{injectionError}</div>}
        {!injection && !injectionError && (
          <div className="faint" style={{ fontSize: 11.5, lineHeight: 1.7 }}>
            {lastTurnId ? t('context.noInjection') : t('context.lastTurnNone')}
          </div>
        )}
        {injection && <InjectionBlock plan={injection} />}
      </div>

      <div className="block">
        <div className="block-title">
          <span>{t('context.packTitle')}</span>
          {packId && <span className="mono truncate">{packId}</span>}
        </div>
        {packError && <div className="notice error">{packError}</div>}
        {!packError && loadingPack && <div className="faint">{t('common.loading')}</div>}
        {!packError && !loadingPack && !pack && (
          <div className="faint" style={{ fontSize: 11.5, lineHeight: 1.7 }}>
            {t('context.waitingDetail')}
          </div>
        )}
        {pack && <PackDetails pack={pack} omittedCountHint={view.context?.omittedCount ?? 0} />}
      </div>

      <div className="card">
        <h2>{t('context.extend')}</h2>
        {!packId && <div className="faint" style={{ fontSize: 11.5 }}>{t('context.extendNeedsPack')}</div>}
        {packId && (
          <>
            <textarea
              rows={2}
              placeholder={t('context.extendPlaceholder')}
              value={request}
              onChange={(e) => setRequest(e.target.value)}
            />
            <div className="row-gap" style={{ marginTop: 8 }}>
              <button
                className="primary"
                disabled={extending || request.trim() === ''}
                onClick={() => void runExtend()}
              >
                {extending ? t('context.extendBusy') : t('context.extend')}
              </button>
              <span className="faint">{t('context.extendHint')}</span>
            </div>
          </>
        )}
        {deltaError && (
          <div className="notice error" style={{ marginTop: 10 }}>
            {deltaError}
          </div>
        )}
        {delta && <DeltaView delta={delta} />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pack
// ---------------------------------------------------------------------------

function PackDetails({
  pack,
  omittedCountHint = 0,
}: {
  pack: ContextPack;
  /**
   * `omitted` is not persisted (§8.1), so a pack read back from storage has an
   * empty list even when items were dropped. The event stream still knows how
   * many, and saying so is better than implying nothing was omitted.
   */
  omittedCountHint?: number;
}): JSX.Element {
  const t = useT();
  const source = pack.budget.estimateSource;

  return (
    <>
      <div className="defs">
        <div className="def">
          <span className="k">{t('context.strategy')}</span>
          <span className="v mono">{pack.strategy}</span>
        </div>
        <div className="def">
          <span className="k">{t('context.strategyReason')}</span>
          <span className="v truncate" title={pack.strategyReason}>
            {pack.strategyReason || '—'}
          </span>
        </div>
        <div className="def">
          <span className="k">{t('context.items')}</span>
          <span className="v mono">{pack.items.length}</span>
        </div>
        <div className="def">
          <span className="k">{t('context.budget')}</span>
          <span className="v mono">
            {pack.budget.usedTokens} / {pack.budget.limitTokens}
            <span className="faint"> · {t('context.remaining')} {pack.budget.remainingTokens}</span>
          </span>
        </div>
        <div className="def">
          <span className="k">{t('context.estimateSource')}</span>
          <span className="v">
            <span className={`badge ${source === 'provider_tokenizer' ? 'ok' : 'warn'}`}>
              {source}
            </span>
          </span>
        </div>
        <div className="def">
          <span className="k">{t('context.revision')}</span>
          <span className="v mono">{pack.revision}</span>
        </div>
      </div>
      <div className="faint" style={{ fontSize: 10.5, marginTop: 6 }}>
        {t('context.estimateNote')}
        {pack.budget.truncated ? ` · ${t('context.truncated')}` : ''}
      </div>

      {pack.items.length === 0 ? (
        <div className="faint" style={{ fontSize: 11.5, marginTop: 8 }}>
          {t('context.itemsEmpty')}
        </div>
      ) : (
        <table className="grid" style={{ marginTop: 10 }}>
          <thead>
            <tr>
              <th>{t('context.itemKind')}</th>
              <th>{t('context.itemSource')}</th>
              <th style={{ textAlign: 'right' }}>{t('context.itemTokens', { source })}</th>
              <th style={{ textAlign: 'right' }}>{t('context.budgetShare')}</th>
              <th>{t('context.freshness')}</th>
            </tr>
          </thead>
          <tbody>
            {pack.items.map((item) => (
              <ItemRow key={item.id} item={item} />
            ))}
          </tbody>
        </table>
      )}

      <div className="block-title" style={{ marginTop: 14 }}>
        <span>{t('context.omitted')}</span>
        {pack.omitted.length === 0 && omittedCountHint > 0 && (
          <span className="mono">{omittedCountHint}</span>
        )}
      </div>
      {pack.omitted.length === 0 ? (
        <div className="faint" style={{ fontSize: 11.5 }}>
          {omittedCountHint > 0 ? t('context.omittedNotPersisted') : t('context.omittedEmpty')}
        </div>
      ) : (
        <div className="defs">
          {pack.omitted.map((entry) => (
            <div className="def" key={entry.itemId}>
              <span className="k mono truncate">{entry.itemId}</span>
              <span className="v">{omitReasonLabel(entry.why, t)}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function ItemRow({ item }: { item: ContextItem }): JSX.Element {
  const t = useT();
  const reference = item.source.reference ?? item.id;
  return (
    <tr>
      <td className="mono" style={{ width: 1 }}>
        {item.kind}
        {item.truncated && (
          <span className="badge" style={{ marginLeft: 6 }}>
            {t('context.truncated')}
          </span>
        )}
      </td>
      <td>
        <div className="truncate" title={reference} style={{ maxWidth: 320 }}>
          {reference}
        </div>
        <div className="faint truncate" style={{ fontSize: 10.5 }} title={item.reason}>
          {item.source.providerId} · {item.reason}
        </div>
      </td>
      <td className="mono" style={{ textAlign: 'right', width: 1 }}>
        {item.estimatedTokens.toLocaleString()}
      </td>
      <td className="mono" style={{ textAlign: 'right', width: 1 }}>
        {(item.budgetShare * 100).toFixed(0)}%
      </td>
      <td style={{ width: 1 }}>
        {item.freshness.stale ? (
          <>
            {/* NFR-11: stale must not look like fresh. */}
            <span className="badge warn">{t('context.stale')}</span>
            {item.freshness.stalenessReason && (
              <div className="faint" style={{ fontSize: 10.5 }}>
                {item.freshness.stalenessReason}
              </div>
            )}
          </>
        ) : (
          <span className="badge ok">{t('context.fresh')}</span>
        )}
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Injection
// ---------------------------------------------------------------------------

function InjectionBlock({ plan }: { plan: ContextInjectionPlan }): JSX.Element {
  const t = useT();
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');

  /*
   * The plan is rendered defensively. It arrives from Main over IPC and can be
   * an older schema, a partially-written record, or — as in the fixture — an
   * empty object. `plan.profile.mode` on such a plan threw, and because there
   * was no error boundary it unmounted the entire window. A pane that cannot
   * describe itself should say so, not blank the app.
   */
  const profile = plan?.profile ?? null;
  const hash = plan?.renderedHash ?? '';
  const estTokens = typeof plan?.estTokens === 'number' ? plan.estTokens : null;
  const indexLength = Array.isArray(plan?.index) ? plan.index.length : null;

  const copy = useCallback(() => {
    if (!hash) return;
    void navigator.clipboard
      .writeText(hash)
      .then(() => setCopyState('copied'))
      .catch(() => setCopyState('failed'));
  }, [hash]);

  if (!hash) {
    // No verifiable hash means there is nothing to verify. Saying that is the
    // honest result; rendering a panel full of empty rows is not.
    return <div className="notice warn">{t('context.noInjectionPlan')}</div>;
  }

  return (
    <>
      <div className="defs">
        <div className="def">
          <span className="k">{t('context.renderedHash')}</span>
          <span className="v">
            <button className="link" onClick={copy}>
              {copyState === 'copied'
                ? t('context.hashCopied')
                : copyState === 'failed'
                  ? t('context.hashCopyFailed')
                  : t('context.hashCopy')}
            </button>
          </span>
        </div>
        {profile && (
          <div className="def">
            <span className="k">{t('context.injectionMode')}</span>
            <span className="v mono">{profile.mode ?? t('common.unknown')}</span>
          </div>
        )}
        {profile && (
          <div className="def">
            <span className="k">{t('context.injectionRendezvous')}</span>
            <span className="v mono">{profile.rendezvous ?? t('common.unknown')}</span>
          </div>
        )}
        {estTokens !== null && (
          <div className="def">
            <span className="k">
              {t('context.injectionTokens', { source: plan.estimateSource ?? t('common.unknown') })}
            </span>
            <span className="v mono">{estTokens.toLocaleString()}</span>
          </div>
        )}
        {indexLength !== null && (
          <div className="def">
            <span className="k">{t('context.injectionIndex')}</span>
            <span className="v mono">{indexLength}</span>
          </div>
        )}
      </div>

      <div className="code" style={{ marginTop: 8, fontSize: 10.5 }}>
        {hash}
      </div>
      <div className="faint" style={{ fontSize: 11, marginTop: 6, lineHeight: 1.7 }}>
        {t('context.hashExplains')}
      </div>
      {plan.estimateSource && plan.estimateSource !== 'provider_tokenizer' && (
        <div className="notice warn" style={{ marginTop: 8 }}>
          {t('context.injectionEstimateWarn')}
        </div>
      )}

      {plan.rendered ? (
        <>
          <div className="block-title" style={{ marginTop: 12 }}>
            <span>{t('context.rendered')}</span>
          </div>
          <div className="code" style={{ maxHeight: 280 }}>
            {plan.rendered}
          </div>
        </>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// Extend delta
// ---------------------------------------------------------------------------

function DeltaView({ delta }: { delta: ContextPackDelta }): JSX.Element {
  const t = useT();
  return (
    <div style={{ marginTop: 12 }}>
      <div className="defs">
        <div className="def">
          <span className="k">{t('context.deltaAdded')}</span>
          <span className="v mono">{delta.addedItems.length}</span>
        </div>
        <div className="def">
          <span className="k">{t('context.deltaRemoved')}</span>
          <span className="v mono">{delta.removedItemIds.length}</span>
        </div>
        <div className="def">
          <span className="k">{t('context.remaining')}</span>
          <span className="v mono">
            {delta.budget.remainingTokens} / {delta.budget.limitTokens}
            <span className={`badge ${delta.budget.estimateSource === 'provider_tokenizer' ? 'ok' : 'warn'}`} style={{ marginLeft: 6 }}>
              {delta.budget.estimateSource}
            </span>
          </span>
        </div>
        <div className="def">
          <span className="k">{t('context.revision')}</span>
          <span className="v mono">
            {delta.baseRevision} → {delta.revision}
          </span>
        </div>
      </div>

      {delta.addedItems.length === 0 && delta.dropped.length === 0 && (
        <div className="faint" style={{ fontSize: 11.5, marginTop: 8 }}>
          {t('context.extendNoChange')}
        </div>
      )}

      {delta.addedItems.length > 0 && (
        <table className="grid" style={{ marginTop: 10 }}>
          <thead>
            <tr>
              <th>{t('context.itemKind')}</th>
              <th>{t('context.itemSource')}</th>
              <th style={{ textAlign: 'right' }}>
                {t('context.itemTokens', { source: delta.budget.estimateSource })}
              </th>
            </tr>
          </thead>
          <tbody>
            {delta.addedItems.map((item) => (
              <tr key={item.id}>
                <td className="mono" style={{ width: 1 }}>
                  {item.kind}
                </td>
                <td>
                  <span className="truncate" title={item.source.reference ?? item.id}>
                    {item.source.reference ?? item.id}
                  </span>
                </td>
                <td className="mono" style={{ textAlign: 'right', width: 1 }}>
                  {item.estimatedTokens.toLocaleString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {delta.dropped.length > 0 && (
        <>
          <div className="block-title" style={{ marginTop: 12 }}>
            <span>{t('context.deltaDropped')}</span>
          </div>
          <div className="defs">
            {delta.dropped.map((entry) => (
              <div className="def" key={entry.itemId}>
                <span className="k mono truncate">{entry.itemId}</span>
                <span className="v">{dropReasonLabel(entry.why, t)}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function omitReasonLabel(why: ContextOmitReason, t: Translate): string {
  switch (why) {
    case 'budget':
      return t('context.omitBudget');
    case 'dedup':
      return t('context.omitDedup');
    case 'stale':
      return t('context.omitStale');
    case 'irrelevant':
      return t('context.omitIrrelevant');
    default:
      return why;
  }
}

function dropReasonLabel(why: ExtendDropReason, t: Translate): string {
  switch (why) {
    case 'budget':
      return t('context.omitBudget');
    case 'no_match':
      return t('context.dropNoMatch');
    case 'provider_unavailable':
      return t('context.dropProvider');
    default:
      return why;
  }
}

/** A failed call must never look like an empty one. */
function errorMessage(error: unknown, t: Translate): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  return t('common.unknown');
}
