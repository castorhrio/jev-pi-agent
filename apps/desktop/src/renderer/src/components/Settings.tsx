import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import type {
  AgentCatalogEntry,
  ModelDescriptor,
  PermissionDecision,
  ProviderDescriptorDto,
  UpdateStatus,
} from '@ucad/contracts';
import { getApi } from '../api';
import { useT, useI18n } from '../i18n-context';
import type { Locale } from '../../../shared/i18n';
import type { AppData } from '../state/hooks';
import type { SessionViewState } from '../state/session-reducer';
import { ReadFailure } from './ReadFailure';

function Def({ k, children }: { k: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="def">
      <span className="k">{k}</span>
      <span className="v">{children}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

export function UsagePanel({
  data,
  view,
}: {
  data: AppData;
  view: SessionViewState;
}): JSX.Element {
  const t = useT();
  const summary = data.usage;
  const failure = data.endpointErrors.usage;

  return (
    <div className="pane">
      <div className="pane-head">
        <h1>{t('usage.title')}</h1>
        <p>{t('usage.subtitle')}</p>
      </div>

      {summary ? (
        <div className="card">
          <div className="defs">
            <Def k={t('usage.input')}>{summary.totalInputTokens.toLocaleString()}</Def>
            <Def k={t('usage.output')}>{summary.totalOutputTokens.toLocaleString()}</Def>
            <Def k={t('usage.cost')}>
              {summary.totalCostUsd === null ? (
                <span className="faint">{t('usage.unavailable')}</span>
              ) : (
                <span className="mono">${summary.totalCostUsd.toFixed(4)}</span>
              )}
            </Def>
            <Def k={t('usage.source')}>
              {summary.estimated ? (
                <span className="badge warn">{t('usage.estimated')}</span>
              ) : (
                <span className="badge ok">{t('usage.vendor')}</span>
              )}
            </Def>
          </div>
        </div>
      ) : failure ? (
        // "No usage recorded yet" is the reassurance a user takes away from a
        // failed read. This is a spend panel: a zero that is really an
        // unreadable number is the kind of lie that gets a budget raised.
        <ReadFailure label={t('usage.loadFailed')} reason={failure} />
      ) : data.loading ? (
        // Same third state as the diagnostics page: a summary that has not
        // arrived is not a summary of zero.
        <div className="faint">{t('common.loading')}</div>
      ) : (
        <div className="empty">{t('empty.usage')}</div>
      )}

      {summary && summary.byModel.length > 0 && (
        <div className="card">
          <h2>{t('usage.byModel')}</h2>
          <table className="grid">
            <thead>
              <tr>
                <th>{t('usage.model')}</th>
                <th>{t('usage.in')}</th>
                <th>{t('usage.out')}</th>
              </tr>
            </thead>
            <tbody>
              {summary.byModel.map((row) => (
                <tr key={row.modelId}>
                  <td className="mono truncate">{row.modelId}</td>
                  <td className="mono">{row.inputTokens.toLocaleString()}</td>
                  <td className="mono">{row.outputTokens.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {view.usage && (
        <div className="card">
          <h2>{t('tab.chat')}</h2>
          <div className="defs">
            <Def k={t('usage.input')}>{view.usage.inputTokens.toLocaleString()}</Def>
            <Def k={t('usage.output')}>{view.usage.outputTokens.toLocaleString()}</Def>
            <Def k={t('usage.source')}>
              {view.usage.estimated ? (
                <span className="badge warn">{t('usage.estimated')}</span>
              ) : (
                <span className="badge ok">{t('usage.vendor')}</span>
              )}
            </Def>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export function SettingsPanel({
  data,
  onChanged,
  inUseProviderId,
}: {
  data: AppData;
  onChanged: () => void;
  /**
   * The provider the current session will actually use, or undefined when the
   * session defers to the agent. Derived from state rather than stored as an
   * "active" flag, so it cannot drift out of step with what a turn really does.
   */
  inUseProviderId?: string;
}): JSX.Element {
  const t = useT();
  const { locale, setLocale } = useI18n();
  const [update, setUpdate] = useState<UpdateStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [provider, setProvider] = useState('openai');
  const [key, setKey] = useState('api-key');
  const [secret, setSecret] = useState('');
  const [hint, setHint] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    void getApi()
      .app.updateStatus()
      .then(setUpdate)
      .catch(() => undefined);
  }, []);

  const check = useCallback(async () => {
    setChecking(true);
    setMessage(null);
    try {
      setUpdate(await getApi().app.checkUpdate());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setChecking(false);
    }
  }, []);

  const storeSecret = useCallback(async () => {
    setMessage(null);
    try {
      await getApi().secrets.set({ providerId: provider, key }, secret);
      const described = await getApi().secrets.describe({ providerId: provider, key });
      setHint(described.configured ? described.keyHint : null);
      setSecret('');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }, [provider, key, secret]);

  return (
    <div className="pane">
      <div className="pane-head">
        <h1>{t('settings.title')}</h1>
        <p>{t('settings.subtitle')}</p>
      </div>

      <div className="card">
        <h2>{t('settings.language')}</h2>
        <div className="row-gap">
          {(['zh-CN', 'en-US'] as const).map((code) => (
            <button
              key={code}
              className={locale === code ? 'primary' : ''}
              onClick={() => void setLocale(code as Locale)}
            >
              {code === 'zh-CN' ? t('lang.zhCN') : t('lang.enUS')}
            </button>
          ))}
        </div>
      </div>

      <div className="card">
        <h2>{t('settings.update')}</h2>
        <div className="defs">
          <Def k={t('settings.version')}>
            <span className="mono">
              {update?.currentVersion ?? data.diagnostics?.version ?? '—'}
            </span>
          </Def>
          {update?.latestVersion && (
            <Def k="latest">
              <span className="mono">{update.latestVersion}</span>
            </Def>
          )}
        </div>

        {update?.state === 'available' && update.notes && (
          <div className="code" style={{ marginTop: 10 }}>
            {update.notes}
          </div>
        )}

        <div className="row-gap" style={{ marginTop: 10, flexWrap: 'wrap' }}>
          <button className="primary" onClick={() => void check()} disabled={checking}>
            {checking ? t('settings.checking') : t('settings.checkUpdate')}
          </button>
          {update?.state === 'available' && (
            <button
              onClick={() => {
                void getApi()
                  .app.downloadUpdate()
                  .then(setUpdate)
                  .catch(() => undefined);
              }}
            >
              —            </button>
          )}
          {update?.state === 'downloading' && (
            <span className="faint mono">
              {Math.round((update.progress ?? 0) * 100)}%
            </span>
          )}
          {update?.state === 'ready' && (
            <button
              className="primary"
              onClick={() => {
                void getApi()
                  .app.installUpdate()
                  .catch(() => undefined);
              }}
            >
              {t('settings.restartNow')}
            </button>
          )}
        </div>

        <div className="faint" style={{ marginTop: 8, fontSize: 11.5 }}>
          {update?.state === 'up-to-date' && t('settings.upToDate')}
          {update?.state === 'unsupported' && t('settings.updateNone')}
          {update?.state === 'error' && `${t('settings.updateFailed')}: ${update.message}`}
        </div>
      </div>

      <ProviderSection onChanged={onChanged} inUseProviderId={inUseProviderId} />

      <div className="card">
        <h2>{t('settings.agents')}</h2>
        {data.agents.length === 0 ? (
          <div className="faint">{t('common.none')}</div>
        ) : (
          <table className="grid">
            <thead>
              <tr>
                <th>{t('col.agent')}</th>
                <th>{t('col.kind')}</th>
                <th>{t('col.transport')}</th>
                <th>{t('col.status')}</th>
              </tr>
            </thead>
            <tbody>
              {data.agents.map((agent) => (
                <AgentRow key={agent.manifest.id} agent={agent} />
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h2>{t('settings.intelligence')}</h2>
        {/*
         * The provider list and its status are two independent reads, so each
         * cell reports its own outcome. Hiding both behind one condition was
         * tidier and wrong twice over: a failed status read was rendered as
         * the em dash that also means "no status yet", and the two identical
         * "unknown" badges on one screen are the same-screen duplicate copy
         * this project has now fixed three times.
         */}
        {data.endpointErrors.providers && (
          <ReadFailure
            label={t('settings.intelligenceLoadFailed')}
            reason={data.endpointErrors.providers}
          />
        )}
        <div className="defs">
          <Def k={t('col.provider')}>
            {data.endpointErrors.providers ? (
              <span className="faint">—</span>
            ) : (
              data.providers.map((p) => (
                <span key={p.id} className="badge" style={{ marginRight: 6 }}>
                  {p.id} · {p.tier}
                </span>
              ))
            )}
          </Def>
          <Def k={t('col.status')}>
            {data.providerStatus ? (
              <>
                <span
                  className={`badge ${
                    data.providerStatus.state === 'ready'
                      ? 'ok'
                      : data.providerStatus.state === 'degraded' ||
                          data.providerStatus.state === 'unavailable'
                        ? 'err'
                        : 'warn'
                  }`}
                >
                  {data.providerStatus.state}
                </span>{' '}
                <span className="faint">{data.providerStatus.reason}</span>
              </>
            ) : data.endpointErrors.providerStatus ? (
              <span className="badge warn">{t('settings.intelligenceStatusUnknown')}</span>
            ) : (
              <span className="faint">—</span>
            )}
          </Def>
        </div>
      </div>

      <div className="card">
        <h2>{t('settings.tools')}</h2>
        {/* `common.none` is a claim about the world. On a failed read it is a
            lie about the app, and this is the panel where an operator
            inventories what the agent is allowed to touch. */}
        {data.endpointErrors.tools && (
          <ReadFailure label={t('settings.toolsLoadFailed')} reason={data.endpointErrors.tools} />
        )}
        {data.tools.length === 0 ? (
          // Three states again, and `common.none` is the false one: it says the
          // agent has no tools, which is an operational fact somebody could
          // act on. This is the panel where an operator inventories what the
          // agent is allowed to touch.
          data.endpointErrors.tools ? null : data.loading ? (
            <div className="faint">{t('common.loading')}</div>
          ) : (
            <div className="faint">{t('common.none')}</div>
          )
        ) : (
          <table className="grid">
            <tbody>
              {data.tools.map((tool) => (
                <tr key={tool.name}>
                  <td className="mono" style={{ width: 1, whiteSpace: 'nowrap' }}>
                    {tool.name}
                  </td>
                  <td className="truncate">{tool.description}</td>
                  <td style={{ width: 1 }}>
                    {tool.permissionCategory ? (
                      <span className="badge warn">{tool.permissionCategory}</span>
                    ) : (
                      <span className="faint">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="faint" style={{ marginTop: 8, fontSize: 11.5 }}>
          {t('settings.toolsNote')}
        </div>
      </div>

      <div className="card">
        <h2>{t('settings.secrets')}</h2>
        <div className="row-gap">
          <input
            placeholder="providerId"
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
          />
          <input placeholder="key" value={key} onChange={(e) => setKey(e.target.value)} />
        </div>
        <input
          style={{ marginTop: 8 }}
          type="password"
          placeholder={t('settings.secretPlaceholder')}
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
        />
        <div className="row-gap" style={{ marginTop: 8 }}>
          <button className="primary" onClick={() => void storeSecret()} disabled={!secret}>
            {t('settings.secretSave')}
          </button>
          {hint && (
            <span className="badge ok">
              {t('settings.secretConfigured')} {hint}
            </span>
          )}
        </div>
        {message && <div className="faint" style={{ marginTop: 6 }}>{message}</div>}
      </div>

      <div className="card">
        <h2>{t('settings.storage')}</h2>
        <div className="defs">
          <Def k="at-rest">
            {/*
             * Three states, not two.
             *
             * The old ternary read `data.diagnostics?.encryptionEnabled`, so
             * a *failed read* and a *genuinely unencrypted database* both
             * landed in the `else` and both said "not encrypted" in red. That
             * is the worst possible place to be wrong twice: the user is told
             * their data at rest is exposed when the truth may be the
             * opposite, and the red badge teaches them to stop reading the one
             * badge on this page that actually matters.
             */}
            {data.diagnostics === null ? (
              <span className="badge warn">{t('settings.encryptionUnknown')}</span>
            ) : data.diagnostics.encryptionEnabled ? (
              <span className="badge ok">{t('settings.encrypted')}</span>
            ) : (
              <span className="badge err">{t('settings.notEncrypted')}</span>
            )}
          </Def>
          <Def k={t('diagnostics.database')}>
            <span className="mono truncate">{data.diagnostics?.dbPath ?? '—'}</span>
          </Def>
        </div>
        <button style={{ marginTop: 10 }} onClick={onChanged}>
          {t('error.retry')}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Providers —this is the "which vendor" surface
// ---------------------------------------------------------------------------

/**
 * What the last probe told us, kept **structured**.
 *
 * This used to be a pre-formatted string (`ok · 123ms`, or the English
 * `reason` verbatim), which meant the interface could not translate a failure
 * and could not give it a colour: a Chinese card showed
 * "Anthropic rejected the credential (HTTP 401). Check the API key in
 * Settings → Providers." in English, and an unreachable endpoint looked the
 * same as a bad key. `reason` is kept, but only as a secondary diagnostic line
 * — the headline text comes from `code`, which is localizable.
 */
type ProviderProbeState = {
  ok: boolean;
  latencyMs: number;
  /** Absent when the probe failed for a reason nobody classified. */
  code?: string;
  /** English, user-safe, from the main process. Diagnostics only. */
  reason?: string;
};

/** i18n key for a probe failure code, or `null` when the code is unknown. */
function probeCodeKey(code: string | undefined): string | null {
  if (code === undefined) return null;
  return `providers.probeCode.${code}`;
}

function ProviderSection({
  onChanged,
  inUseProviderId,
}: {
  onChanged: () => void;
  inUseProviderId?: string;
}): JSX.Element {
  const t = useT();
  const [providers, setProviders] = useState<ProviderDescriptorDto[]>([]);
  const [configured, setConfigured] = useState<string[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [models, setModels] = useState<ModelDescriptor[]>([]);
  const [keyInput, setKeyInput] = useState('');
  const [probe, setProbe] = useState<Record<string, ProviderProbeState>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const api = getApi();
    setProviders(await api.providers.list());
    setConfigured(await api.providers.configured().catch(() => [] as string[]));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const expand = useCallback(async (id: string) => {
    const next = open === id ? null : id;
    setOpen(next);
    setKeyInput('');
    setProbe({});
    if (!next) return;
    setBusy(id);
    try {
      setModels(await getApi().providers.models(id));
    } catch (error) {
      // The model list is a different call from the probe; a failure here is
      // not a provider health verdict, so it is recorded without a code and
      // rendered as the generic failure rather than as a health claim.
      setProbe((p) => ({
        ...p,
        [id]: {
          ok: false,
          latencyMs: 0,
          reason: error instanceof Error ? error.message : String(error),
        },
      }));
    } finally {
      setBusy(null);
    }
  }, [open]);

  const saveKey = useCallback(
    async (providerId: string, secretKey: string) => {
      setBusy(providerId);
      try {
        await getApi().secrets.set({ providerId, key: secretKey }, keyInput.trim());
        setKeyInput('');
        await load();
        const result = await getApi().providers.probe(providerId);
        setProbe((p) => ({
          ...p,
          [providerId]: {
            ok: result.ok,
            latencyMs: result.latencyMs,
            ...(result.code !== undefined ? { code: result.code } : {}),
            ...(result.reason !== undefined ? { reason: result.reason } : {}),
          },
        }));
        onChanged();
      } catch (error) {
        setProbe((p) => ({
          ...p,
          [providerId]: {
            ok: false,
            latencyMs: 0,
            reason: error instanceof Error ? error.message : String(error),
          },
        }));
      } finally {
        setBusy(null);
      }
    },
    [keyInput, load, onChanged],
  );

  const runProbe = useCallback(async (providerId: string) => {
    setBusy(providerId);
    try {
      const result = await getApi().providers.probe(providerId);
      setProbe((p) => ({
        ...p,
        [providerId]: {
          ok: result.ok,
          latencyMs: result.latencyMs,
          ...(result.code !== undefined ? { code: result.code } : {}),
          ...(result.reason !== undefined ? { reason: result.reason } : {}),
        },
      }));
    } catch (error) {
      setProbe((p) => ({
        ...p,
        [providerId]: {
          ok: false,
          latencyMs: 0,
          reason: error instanceof Error ? error.message : String(error),
        },
      }));
    } finally {
      setBusy(null);
    }
  }, []);

  return (
    <div className="card">
      <h2>{t('providers.title')}</h2>
      <div className="faint" style={{ fontSize: 11.5, marginBottom: 10 }}>
        {t('providers.subtitle')}
      </div>

      <table className="grid">
        <thead>
          <tr>
            <th>{t('providers.name')}</th>
            <th>{t('col.endpoint')}</th>
            <th>{t('col.models')}</th>
            <th>{t('providers.status')}</th>
            {/* RESEARCH §1: quota sits on the card, not behind a click. */}
            <th>{t('providers.quota')}</th>
            {/* The actions column. An empty `<th>` is announced as a blank
                header, and screen-reader users navigating by column hear a
                column with no name — so it is labelled, not left empty. */}
            <th>
              <span className="sr-only">{t('col.actions')}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {providers.map((p) => {
            const isConfigured = configured.includes(p.id);
            const state = probe[p.id];
            // A keyed Fragment, not a bare fragment: the two rows are siblings
            // inside <tbody>, and an unkeyed wrapper there produces DOM that
            // React and the browser disagree about.
            return (
              <Fragment key={p.id}>
                <tr>
                  <td>
                    <div className="row-gap">
                      <span>{p.displayName}</span>
                      {!p.supported && <span className="badge err">{t('providers.unsupported')}</span>}
                      {isConfigured && p.supported && (
                        <span className="badge ok">{t('providers.configured')}</span>
                      )}
                      {/*
                        Which vendor this session will actually use. Derived
                        from the picker's value or the session's own, never
                        stored as a separate "active" flag — a stored flag
                        would eventually disagree with what a turn really does,
                        and then it is worse than no marker at all.
                      */}
                      {p.supported && inUseProviderId === p.id && (
                        <span className="badge">{t('providers.inUse')}</span>
                      )}
                    </div>
                    {p.notes && (
                      <div className="faint" style={{ fontSize: 11, marginTop: 2 }}>
                        {p.notes}
                      </div>
                    )}
                  </td>
                  {/*
                    `truncate` plus a 180px ceiling rather than 240px: the
                    status and quota columns must not wrap, so the table has
                    a fixed width to fit, and the endpoint is the one column
                    whose content is decorative once the vendor name is known.
                    The full URL is repeated in the expanded row below, so
                    truncating it here loses nothing.
                  */}
                  <td className="mono truncate" style={{ maxWidth: 180 }}>
                    {p.baseUrl}
                  </td>
                  <td className="mono">{p.models.length || '—'}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {!p.supported ? (
                      // Nothing to report. The row already carries a 未接入
                      // badge, and repeating it here would both be redundant
                      // and wide enough to wrap into five lines.
                      <span className="faint">—</span>
                    ) : busy === p.id ? (
                      <span className="faint" style={{ fontSize: 11.5 }}>
                        {t('common.loading')}
                      </span>
                    ) : state === undefined ? (
                      <span className="faint" style={{ fontSize: 11.5 }}>
                        {t('providers.probePending')}
                      </span>
                    ) : state.ok ? (
                      <span className="row-gap">
                        <span className="badge ok">{t('providers.probeOk')}</span>
                        <span className="faint mono" style={{ fontSize: 11 }}>
                          {t('providers.probeLatency', { ms: state.latencyMs })}
                        </span>
                      </span>
                    ) : (
                      <span className="badge err">
                        {t(probeCodeKey(state.code) ?? 'providers.probeFailed')}
                      </span>
                    )}
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {/*
                      The honest answer, and for OpenAI-compatible endpoints it
                      is the usual one: the protocol has no balance or quota
                      field, so there is nothing to show. A blank cell would
                      read as "zero remaining" — a number we do not have. The
                      one state where we genuinely know is 402, because the
                      vendor refused the request for billing.
                    */}
                    {state?.code === 'BUDGET_EXCEEDED' ? (
                      <span className="badge err">{t('providers.quotaExhausted')}</span>
                    ) : (
                      <span className="faint" style={{ fontSize: 11.5 }}>
                        {t('providers.quotaNotProvided')}
                      </span>
                    )}
                  </td>
                  <td style={{ width: 1, whiteSpace: 'nowrap' }}>
                    <button
                      className="ghost"
                      onClick={() => void expand(p.id)}
                      disabled={!p.supported}
                    >
                      {open === p.id ? '▾' : '▸'}
                    </button>
                    <button
                      className="ghost"
                      onClick={() => void runProbe(p.id)}
                      disabled={!p.supported || busy === p.id}
                    >
                      {t('providers.probe')}
                    </button>
                  </td>
                </tr>

                {open === p.id && (
                  <tr>
                    <td colSpan={6} style={{ background: 'var(--inset)' }}>
                      {state && !state.ok && state.reason && (
                        <div style={{ fontSize: 11.5, marginBottom: 8 }}>
                          <div style={{ marginBottom: 2 }}>{t('providers.probeDetail')}</div>
                          {/*
                            The main process writes English here on purpose:
                            it is a diagnostic, it names the HTTP status and the
                            exact call, and translating a diagnostic would make
                            it disagree with the log the user is sent to. It is
                            labelled, and it is never the headline.
                          */}
                          <div
                            className="faint"
                            style={{ fontSize: 11.5, fontFamily: 'var(--mono)' }}
                          >
                            {state.reason}
                          </div>
                        </div>
                      )}
                      {p.requiresApiKey && (
                        <div className="row-gap" style={{ marginBottom: 8 }}>
                          <input
                            type="password"
                            placeholder={p.secretKey}
                            value={keyInput}
                            onChange={(e) => setKeyInput(e.target.value)}
                          />
                          <button
                            onClick={() => void saveKey(p.id, p.secretKey)}
                            disabled={!keyInput.trim() || busy === p.id}
                          >
                            {t('settings.secretSave')}
                          </button>
                        </div>
                      )}
                      <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
                        {models.length === 0 ? (
                          <span className="faint" style={{ fontSize: 11.5 }}>
                            {busy === p.id ? t('common.loading') : t('providers.noModels')}
                          </span>
                        ) : (
                          models.map((m) => (
                            <span className="badge mono" key={m.id}>
                              {m.id}
                            </span>
                          ))
                        )}
                      </div>
                      {/*
                        The full endpoint, untruncated. The summary row
                        ellipsizes it to keep the status and quota columns
                        readable, so this is where a user reads the actual
                        URL when a vendor behaves unexpectedly.
                      */}
                      <div className="mono faint" style={{ fontSize: 10.5, marginTop: 8 }}>
                        {p.baseUrl}
                      </div>
                      {p.docsUrl && (
                        <div className="faint" style={{ fontSize: 10.5, marginTop: 4 }}>
                          {p.docsUrl}
                        </div>
                      )}
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function AgentRow({ agent }: { agent: AgentCatalogEntry }): JSX.Element {
  const m = agent.manifest;
  return (
    <tr>
      <td>
        {m.displayName}
        {m.isDefaultRuntime && <span className="badge accent" style={{ marginLeft: 6 }}>default</span>}
      </td>
      <td className="mono">{m.kind}</td>
      <td className="mono">{m.transport}</td>
      <td>
        <div className="row-gap">
          <span className={`dot ${agent.available ? 'ok' : 'err'}`} />
          <span className="faint">
            {agent.available ? 'ready' : agent.unavailableReason ?? 'unavailable'}
          </span>
        </div>
        {agent.restricted && <span className="badge warn">restricted</span>}
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

export function DiagnosticsPanel({ data }: { data: AppData }): JSX.Element {
  const t = useT();
  const d = data.diagnostics;
  const failure = data.endpointErrors.diagnostics;

  return (
    /*
     * The pane is the surface's scroll container, and this surface's content
     * (a runtime card and a log table) has no focusable descendant for a
     * keyboard user to reach scrolling through. Making the region itself
     * focusable is what a keyboard user needs; without it the log below the
     * fold is unreachable from the keyboard (axe: scrollable-region-focusable).
     */
    <div className="pane" tabIndex={0} aria-label={t('diagnostics.region')}>
      <div className="pane-head">
        <h1>{t('diagnostics.title')}</h1>
        <p>{t('diagnostics.subtitle')}</p>
      </div>

      {/*
       * Three states, because `d === null` means two different things.
       *
       * When the read fails, nothing below renders — and that is the whole
       * point of this branch. This panel exists to answer "what is actually
       * true right now", and a `null` from `diagnostics.info` is not a fact
       * about anything. Rendering the cards anyway produced four false
       * statements at once: a runtime card of `—`, a red **"not encrypted"**
       * badge for an install that may well be encrypted, a blank database
       * path, and "no log entries" on a machine that has been logging all
       * along. A panel that lies here is worse than one that is missing,
       * because the user came to it *because* something was wrong.
       *
       * The `loading` arm is the half that is easy to forget, and it was
       * caught in self-review of this very change: on a cold start `d` is
       * `null` *and* no error has been recorded, so the failure branch would
       * have announced "could not be read" during the ~120 ms before the read
       * came back. "Not known yet" is its own claim and gets its own text.
       */}
      {!d ? (
        data.loading ? (
          <div className="faint">{t('common.loading')}</div>
        ) : (
          <ReadFailure label={t('diagnostics.loadFailed')} reason={failure ?? t('common.unknown')} />
        )
      ) : (
        <>
      <div className="card">
        <h2>{t('diagnostics.runtime')}</h2>
        <div className="defs">
          <Def k={t('diagnostics.version')}>
            <span className="mono">{d?.version ?? '—'}</span>
          </Def>
          <Def k={t('diagnostics.schema')}>
            <span className="mono">v{d?.schemaVersion ?? '—'}</span>
          </Def>
          <Def k="electron / node">
            <span className="mono">
              {d?.electron ?? '—'} / {d?.node ?? '—'}
            </span>
          </Def>
          <Def k={t('diagnostics.platform')}>
            <span className="mono">{d?.platform ?? '—'}</span>
          </Def>
          <Def k={t('diagnostics.journalMode')}>
            <span className="mono">{d?.journalMode ?? '—'}</span>
          </Def>
          <Def k={t('settings.language')}>
            <span className="mono">{d?.locale ?? '—'}</span>
          </Def>
          <Def k={t('diagnostics.atRest')}>
            {d?.encryptionEnabled ? (
              <span className="badge ok">{t('settings.encrypted')}</span>
            ) : (
              <span className="badge err">{t('settings.notEncrypted')}</span>
            )}
          </Def>
          <Def k={t('diagnostics.database')}>
            <span className="mono truncate">{d?.dbPath ?? '—'}</span>
          </Def>
          <Def k={t('diagnostics.logDir')}>
            <span className="mono truncate">{d?.logDir ?? '—'}</span>
          </Def>
        </div>
      </div>

      {/*
       * The log itself, not just where it lives.
       *
       * This is the panel's reason to exist. A panel that threw, a preload
       * that failed to load, an adapter that could not resolve — Main writes all
       * of them down, and until now the only way to read one was to open a file
       * on disk and go looking. That is the step a user reporting a bug will
       * not take, so the evidence stayed on the machine.
       *
       * `meta` is not here because the DTO does not carry it: the logger
       * redacts before any sink, and a narrower payload is a red line that is
       * cheap to keep (see LogEntryDto).
       */}
      <div className="card">
        <h2>{t('diagnostics.recentLog')}</h2>
        {d?.recentLog && d.recentLog.length > 0 ? (
          <div className="logtail">
            {d.recentLog.map((entry, index) => (
              <div key={`${entry.ts}-${index}`} className={`logline ${entry.level}`}>
                <span className="mono logline-ts">{entry.ts.slice(11, 23)}</span>
                <span className={`badge ${entry.level === 'error' ? 'err' : entry.level === 'warn' ? 'warn' : ''}`}>
                  {entry.level}
                </span>
                <span className="faint mono logline-scope">{entry.scope}</span>
                <span className="logline-msg">{entry.msg}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="faint">{t('diagnostics.noLogEntries')}</p>
        )}
      </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Permission dialog
// ---------------------------------------------------------------------------

/**
 * The security loop's modal.
 *
 * This is the one overlay where "close it without answering" is not an option,
 * so the accessibility contract is deliberately strict:
 *  - it announces itself as a modal (`role="dialog"` + `aria-modal`), which is
 *    the only signal a screen reader gets that the rest of the window is now
 *    inert;
 *  - it is named, via `aria-labelledby` pointing at the visible title;
 *  - focus moves into it on open and cannot Tab its way out, because a
 *    keyboard user who wanders into the page behind a permission prompt can no
 *    longer see that they are being asked something;
 *  - the error notice is a live region, so a rejected decision is read out
 *    rather than only appearing.
 *
 * There is deliberately no Escape-to-dismiss: a pending request cannot be
 * abandoned, and pretending otherwise would leave the user believing they had
 * answered it. The four buttons are the only exits.
 */
export function PermissionDialog({
  request,
  busy,
  error,
  onDecide,
}: {
  request: SessionViewState['permissions'][number] | null;
  busy: boolean;
  error: string | null;
  onDecide: (requestId: string, decision: PermissionDecision) => void;
}): JSX.Element | null {
  const t = useT();
  const dialogRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const titleId = 'permission-dialog-title';

  // Move focus in on open; hand it back on close.
  useEffect(() => {
    if (!request) return;
    restoreRef.current = document.activeElement as HTMLElement | null;
    const node = dialogRef.current;
    const first = node?.querySelector<HTMLElement>('footer button:not([disabled])');
    (first ?? node)?.focus();
    return () => {
      restoreRef.current?.focus?.();
    };
  }, [request]);

  // Keep Tab inside the dialog. Without this, focus escapes to the page behind
  // and the prompt becomes invisible while still blocking the turn.
  const onKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (event.key !== 'Tab') return;
    const node = dialogRef.current;
    if (!node) return;
    const selector =
      'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
    const focusable: HTMLElement[] = Array.from(node.querySelectorAll(selector)).filter(
      (el): el is HTMLElement => el instanceof HTMLElement,
    );
    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }, []);

  if (!request) return null;

  const labels: Record<PermissionDecision, string> = {
    allow_once: t('permission.allow_once'),
    allow_session: t('permission.allow_session'),
    allow_workspace: t('permission.allow_workspace'),
    deny: t('permission.deny'),
  };

  return (
    <div className="overlay">
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={dialogRef}
        onKeyDown={onKeyDown}
      >
        <header>
          <span
            className={`badge ${request.risk === 'high' ? 'err' : request.risk === 'medium' ? 'warn' : ''}`}
          >
            {request.category}
          </span>
          <span id={titleId}>{t('permission.title')}</span>
        </header>
        <div className="dialog-body">
          <div className="defs">
            <Def k={t('permission.risk')}>{request.risk}</Def>
            {request.resource && <Def k={t('permission.resource')}>{request.resource}</Def>}
            {request.command && <Def k={t('permission.command')}>{request.command}</Def>}
            {request.reason && <Def k={t('permission.reason')}>{request.reason}</Def>}
          </div>
          <div className="faint" style={{ marginTop: 12, fontSize: 11.5 }}>
            {t('permission.explain')}
          </div>
          {/* A request that timed out in Main still shows here. Saying so beats
              four buttons that silently do nothing. `role="alert"` because a
              decision the user just made was rejected — it has to be read out,
              not merely drawn. */}
          {error && (
            <div className="notice error" style={{ marginTop: 10 }} role="alert">
              {t('permission.respondFailed', { reason: error })}
            </div>
          )}
        </div>
        <footer>
          {(Object.keys(labels) as PermissionDecision[]).map((decision) => (
            <button
              key={decision}
              className={
                decision === 'deny' ? 'danger' : decision === 'allow_once' ? 'primary' : ''
              }
              disabled={busy}
              onClick={() => onDecide(request.requestId, decision)}
            >
              {busy ? t('permission.responding') : labels[decision]}
            </button>
          ))}
        </footer>
      </div>
    </div>
  );
}
