/**
 * §12.1 Settings / MCP.
 *
 * MCP is where a "green badge" is most expensive, because a server that is not
 * there, a server that is there but broken, and a server that works can all be
 * rendered as a coloured dot. The rules this page is built around:
 *
 *  - **Transport is always stated, never implied.** A local `stdio` process and
 *    a remote `http` server are different trust boundaries — one runs on the
 *    user's machine, the other is somewhere else entirely — so they get
 *    different badges and the full localised label, not just a colour.
 *  - **Health is a word, not a colour.** Every badge carries its text, so the
 *    state survives a screen reader and a colourblind reader (§12.1).
 *  - **A failed load is not an empty list.** `mcp.loadFailed` and the reason are
 *    shown instead of "no servers configured", because those two look identical
 *    and only one of them is true.
 *  - **Every failure shows its reason.** The test button surfaces the real
 *    outcome — including what was *not* verified — because "connected" without
 *    evidence is the one thing this page must never say.
 *  - **`agent_facing` is a warning, not a dropdown value.** §10.1: those tools
 *    bypass the Context Broker, so the exposure warning is shown the moment it
 *    is selected rather than at the point of damage.
 *  - **A stored environment is shown, never re-shown.** §10.1 / NFR-01: the
 *    values are write-only, so a server that has variables lists their names
 *    behind a mask and the editor says the value cannot be read back. A blank
 *    field there would be indistinguishable from a variable set to "".
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { McpServerDto, McpTestResult } from '@ucad/contracts';
import { MCP_ENV_MASK } from '@ucad/contracts';
import { getApi } from '../api';
import { useT } from '../i18n-context';
import type { AppData } from '../state/hooks';

type ScopeFilter = 'all' | 'global' | 'workspace';
type Transport = 'stdio' | 'http';
type Exposure = 'agent_facing' | 'ucad_internal';

/** What the probe actually did, read off the IPC result (see `ipc-mcp.ts`). */
interface TestOutcome extends McpTestResult {
  outcome: 'handshake' | 'unverified' | 'unreachable';
  checks: string[];
  notVerified: string;
  serverInfo?: string;
}

interface FormState {
  id: string | null;
  scope: Exclude<ScopeFilter, 'all'>;
  name: string;
  transport: Transport;
  exposure: Exposure;
  command: string;
  args: string;
  url: string;
  /** `KEY=VALUE` per line; what the user types now, never a stored value */
  env: string;
  /** the names already stored for the edited server (NFR-01: names only) */
  envStored: string[];
  secretRef: string;
}

const EMPTY_FORM: FormState = {
  id: null,
  scope: 'global',
  name: '',
  transport: 'stdio',
  exposure: 'ucad_internal',
  command: '',
  args: '',
  url: '',
  env: '',
  envStored: [],
  secretRef: '',
};

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function Def({ k, children }: { k: string; children: ReactNode }): JSX.Element {
  return (
    <div className="def">
      <span className="k">{k}</span>
      <span className="v">{children}</span>
    </div>
  );
}

export function McpPanel({ data }: { data: AppData }): JSX.Element {
  const t = useT();
  const api = useMemo(() => getApi(), []);

  const [servers, setServers] = useState<McpServerDto[] | null>(null);
  const [loadFailed, setLoadFailed] = useState<string | null>(null);
  const [scope, setScope] = useState<ScopeFilter>('all');

  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, TestOutcome>>({});
  const [armed, setArmed] = useState<string | null>(null);

  const [form, setForm] = useState<FormState | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const workspaceOpen = data.workspace !== null;

  const load = useCallback(async () => {
    setLoadFailed(null);
    try {
      setServers(
        await api.mcp.list(scope === 'all' ? undefined : scope === 'workspace' ? 'workspace-scoped' : 'global'),
      );
    } catch (error) {
      // Never fall back to an empty list: "nothing configured" and "the load
      // failed" are different facts and only one of them is true.
      setServers(null);
      setLoadFailed(message(error));
    }
  }, [api, scope]);

  useEffect(() => {
    void load();
  }, [load]);

  const afterChange = useCallback(async () => {
    await load();
    // Keeps the app-level snapshot honest for any other surface.
    await data.refresh();
  }, [data, load]);

  const run = useCallback(
    async (key: string, work: () => Promise<string | void>) => {
      setBusy(key);
      setFailure(null);
      setFlash(null);
      try {
        const done = await work();
        if (done) setFlash(done);
      } catch (error) {
        // Every failure path surfaces its reason; none of them is swallowed.
        setFailure(message(error));
      } finally {
        setBusy(null);
      }
    },
    [],
  );

  const test = useCallback(
    async (id: string) =>
      run(`test:${id}`, async () => {
        const result = (await api.mcp.test(id)) as TestOutcome;
        setTests((current) => ({ ...current, [id]: result }));
        // A test changes stored health, so the list is re-read rather than
        // patched in place: the server that Main holds is the source of truth.
        await load();
      }),
    [api, load, run],
  );

  const toggleEnabled = useCallback(
    (server: McpServerDto) =>
      run(`enable:${server.id}`, async () => {
        await api.mcp.setEnabled(server.id, !server.enabled);
        await afterChange();
      }),
    [api, afterChange, run],
  );

  const changeExposure = useCallback(
    (server: McpServerDto, exposure: Exposure) =>
      run(`exposure:${server.id}`, async () => {
        await api.mcp.setExposure(server.id, exposure);
        await afterChange();
      }),
    [api, afterChange, run],
  );

  const remove = useCallback(
    (server: McpServerDto) => {
      // Two steps: a destructive action that fires on the first click is one
      // mis-click away from losing a server the user configured.
      if (armed !== server.id) {
        setArmed(server.id);
        setFailure(null);
        setFlash(null);
        return;
      }
      setArmed(null);
      void run(`remove:${server.id}`, async () => {
        await api.mcp.remove(server.id);
        setTests((current) => {
          const next = { ...current };
          delete next[server.id];
          return next;
        });
        await afterChange();
        return t('mcp.removed', { name: server.name });
      });
    },
    [api, afterChange, armed, run, t],
  );

  const startEdit = useCallback((server: McpServerDto) => {
    setFormError(null);
    setFlash(null);
    setForm({
      id: server.id,
      // A workspace server keeps its own scope; the DTO carries it.
      scope: server.scope,
      name: server.name,
      transport: server.transport,
      exposure: server.exposure,
      // The endpoint is not part of the DTO (NFR-01 keeps it in Main), so the
      // fields start empty rather than showing a value we did not read back.
      command: '',
      args: '',
      url: '',
      // Same for the environment: the names are known, the values are not, so
      // the editor shows the names and leaves the value box empty.
      env: '',
      envStored: Object.keys(server.envMasked ?? {}),
      secretRef: '',
    });
  }, []);

  const save = useCallback(() => {
    if (!form) return;
    setFormError(null);
    const name = form.name.trim();
    if (!name) {
      setFormError(t('mcp.needName'));
      return;
    }
    if (form.scope === 'workspace' && !workspaceOpen) {
      setFormError(t('retention.workspaceMissing'));
      return;
    }
    const command = form.command.trim();
    const url = form.url.trim();
    if (form.transport === 'stdio' && !command) {
      setFormError(t('mcp.needCommand'));
      return;
    }
    if (form.transport === 'http') {
      if (!url) {
        setFormError(t('mcp.needUrl'));
        return;
      }
      if (!url.toLowerCase().startsWith('https://')) {
        setFormError(t('mcp.needHttps'));
        return;
      }
    }

    const ref = form.secretRef.trim();
    const [providerId, ...rest] = ref ? ref.split('/') : [];
    const key = rest.join('/');

    // A line that is not `NAME=VALUE` is shown back rather than dropped: a
    // silently ignored line is a variable the user believes is configured.
    const { env, bad } = parseEnv(form.env);
    if (bad.length > 0) {
      setFormError(`${t('mcp.env')}: ${bad.join(' / ')}`);
      return;
    }

    void run('save', async () => {
      await api.mcp.upsert({
        id: form.id ?? undefined,
        scope: form.scope,
        name,
        exposure: form.exposure,
        transport: form.transport,
        ...(form.transport === 'stdio'
          ? { command, args: lines(form.args) }
          : { url }),
        // Write-only (NFR-01). Omitted when the box is empty, which keeps the
        // stored values instead of blanking variables the user cannot see.
        ...(Object.keys(env).length > 0 ? { env } : {}),
        // A reference to a stored credential, never the credential (NFR-01).
        ...(providerId && key ? { secretRef: { providerId, key } } : {}),
      });
      setForm(null);
      await afterChange();
      return t('mcp.saved', { name });
    });
  }, [api.mcp, afterChange, form, run, t, workspaceOpen]);

  const visible = (servers ?? []).filter((server) => scope === 'all' || server.scope === scope);

  return (
    <div className="pane">
      <div className="pane-head">
        <h1>{t('mcp.title')}</h1>
        <p>{t('mcp.subtitle')}</p>
      </div>

      {loadFailed && (
        <div className="notice error">
          {t('mcp.loadFailed', { reason: loadFailed })}
          <div style={{ marginTop: 8 }}>
            <button onClick={() => void load()}>{t('error.retry')}</button>
          </div>
        </div>
      )}

      {failure && (
        <div className="notice error">
          <div className="error-text">{failure}</div>
        </div>
      )}

      {flash && <div className="notice info">{flash}</div>}

      <div className="card">
        <h2>{t('mcp.scope')}</h2>
        <div className="row-gap" style={{ flexWrap: 'wrap' }}>
          <button className={scope === 'all' ? 'primary' : ''} onClick={() => setScope('all')}>
            {t('mcp.scopeAll')}
          </button>
          <button
            className={scope === 'global' ? 'primary' : ''}
            onClick={() => setScope('global')}
          >
            {t('mcp.scope_global')}
          </button>
          <button
            className={scope === 'workspace' ? 'primary' : ''}
            onClick={() => setScope('workspace')}
            disabled={!workspaceOpen}
            title={workspaceOpen ? undefined : t('retention.workspaceMissing')}
          >
            {t('mcp.scope_workspace')}
          </button>
          <button onClick={() => setForm({ ...EMPTY_FORM })}>{t('mcp.add')}</button>
        </div>
        {/* The disabled control alone would leave the user guessing. */}
        {!workspaceOpen && <div className="faint" style={{ marginTop: 8, fontSize: 11.5 }}>{t('retention.workspaceMissing')}</div>}
      </div>

      {servers === null && !loadFailed && <div className="faint">{t('common.loading')}</div>}

      {servers !== null && servers.length === 0 && (
        <div className="faint">{t('mcp.empty')}</div>
      )}

      {visible.map((server) => (
        <ServerCard
          key={server.id}
          server={server}
          busy={busy}
          test={tests[server.id]}
          armed={armed === server.id}
          onToggle={() => void toggleEnabled(server)}
          onExposure={(exposure) => void changeExposure(server, exposure)}
          onTest={() => void test(server.id)}
          onEdit={() => startEdit(server)}
          onRemove={() => remove(server)}
          onDisarm={() => setArmed(null)}
        />
      ))}

      {form && (
        <div className="card">
          <h2>{form.id ? t('mcp.edit') : t('mcp.add')}</h2>

          <div className="defs">
            <Def k={t('mcp.name')}>
              <input
                value={form.name}
                placeholder={t('mcp.name')}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
              />
            </Def>
            <Def k={t('mcp.scope')}>
              <select
                className="picker-select"
                value={form.scope}
                disabled={!workspaceOpen}
                onChange={(event) =>
                  setForm({ ...form, scope: event.target.value as Exclude<ScopeFilter, 'all'> })
                }
              >
                <option value="global">{t('mcp.scope_global')}</option>
                <option value="workspace" disabled={!workspaceOpen}>
                  {t('mcp.scope_workspace')}
                </option>
              </select>
            </Def>
            <Def k={t('mcp.transport')}>
              <select
                className="picker-select"
                value={form.transport}
                onChange={(event) => setForm({ ...form, transport: event.target.value as Transport })}
              >
                <option value="stdio">{t('mcp.transport_stdio')}</option>
                <option value="http">{t('mcp.transport_http')}</option>
              </select>
            </Def>
            <Def k={t('mcp.exposure')}>
              <select
                className="picker-select"
                value={form.exposure}
                onChange={(event) => setForm({ ...form, exposure: event.target.value as Exposure })}
              >
                <option value="ucad_internal">{t('mcp.exposure_ucad_internal')}</option>
                <option value="agent_facing">{t('mcp.exposure_agent_facing')}</option>
              </select>
            </Def>
            {form.exposure === 'agent_facing' && (
              <div className="notice warn" style={{ marginTop: 6 }}>
                {t('mcp.exposureWarn')}
              </div>
            )}

            {form.transport === 'stdio' ? (
              <>
                <Def k={t('mcp.command')}>
                  <input
                    className="mono"
                    value={form.command}
                    placeholder="npx"
                    onChange={(event) => setForm({ ...form, command: event.target.value })}
                  />
                </Def>
                <Def k={t('mcp.args')}>
                  <textarea
                    className="mono"
                    rows={3}
                    value={form.args}
                    placeholder={'--stdio\n--port'}
                    onChange={(event) => setForm({ ...form, args: event.target.value })}
                  />
                </Def>
              </>
            ) : (
              <Def k={t('mcp.url')}>
                <input
                  className="mono"
                  value={form.url}
                  placeholder="https://mcp.example.com/mcp"
                  onChange={(event) => setForm({ ...form, url: event.target.value })}
                />
              </Def>
            )}

            <Def k={t('mcp.env')}>
              <textarea
                className="mono"
                rows={2}
                value={form.env}
                placeholder={'TOKEN=\nHTTPS_PROXY='}
                onChange={(event) => setForm({ ...form, env: event.target.value })}
              />
              {/* The placeholder is the credential string already in the
                  dictionary: a value here cannot be read back after saving. */}
              <span className="faint" style={{ display: 'block', fontSize: 11.5, marginTop: 4 }}>
                {t('settings.secretPlaceholder')}
              </span>
              {form.envStored.length > 0 && (
                <span
                  className="faint mono"
                  style={{ display: 'block', fontSize: 11.5, marginTop: 4 }}
                >
                  {`${t('settings.secretConfigured')}: `}
                  {form.envStored.map((name) => `${name}=${MCP_ENV_MASK}`).join('  ')}
                </span>
              )}
            </Def>

            <Def k={t('mcp.secretRef')}>
              <input
                className="mono"
                value={form.secretRef}
                placeholder="mcp/token"
                onChange={(event) => setForm({ ...form, secretRef: event.target.value })}
              />
            </Def>
          </div>

          {formError && (
            <div className="notice error" style={{ marginTop: 10 }}>
              <div className="error-text">{formError}</div>
            </div>
          )}

          <div className="row-gap" style={{ marginTop: 12 }}>
            <button className="primary" onClick={save} disabled={busy === 'save'}>
              {t('mcp.save')}
            </button>
            <button onClick={() => setForm(null)}>{t('common.cancel')}</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// one server
// ---------------------------------------------------------------------------

function ServerCard({
  server,
  busy,
  test,
  armed,
  onToggle,
  onExposure,
  onTest,
  onEdit,
  onRemove,
  onDisarm,
}: {
  server: McpServerDto;
  busy: string | null;
  test: TestOutcome | undefined;
  armed: boolean;
  onToggle: () => void;
  onExposure: (exposure: Exposure) => void;
  onTest: () => void;
  onEdit: () => void;
  onRemove: () => void;
  onDisarm: () => void;
}): JSX.Element {
  const t = useT();
  const testing = busy === `test:${server.id}`;
  // A count is only shown when a handshake produced it. "0" would read as a
  // measured zero; the truth for an untested or unverified server is that the
  // number is unknown.
  const counted = server.health === 'ok' && server.toolCount !== undefined;

  return (
    <div className="card">
      <h2>{server.name}</h2>

      <div className="row-gap" style={{ flexWrap: 'wrap' }}>
        {/* Local process and remote server are different trust boundaries, so
            they never share a badge — and both carry their full label. */}
        <span className={server.transport === 'http' ? 'badge accent' : 'badge'}>
          <span className="mono">{server.transport === 'http' ? '☁' : '▸'}</span>{' '}
          {server.transport === 'http' ? t('mcp.transport_http') : t('mcp.transport_stdio')}
        </span>
        <span className={healthBadge(server.health)}>{t(healthKey(server.health))}</span>
        <span className="badge">{server.scope === 'workspace' ? t('mcp.scope_workspace') : t('mcp.scope_global')}</span>
        {!server.enabled && <span className="badge warn">{t('mcp.enabled')} ✗</span>}
      </div>

      <div className="defs" style={{ marginTop: 10 }}>
        <Def k={t('mcp.tools')}>
          {counted ? <span className="mono">{server.toolCount}</span> : <span className="faint">{t('mcp.neverTested')}</span>}
        </Def>
        <Def k={t('mcp.exposure')}>{t(exposureKey(server.exposure))}</Def>
        {/* NFR-01: the names that are set, never the values. `common.none` when
            nothing is stored, so "no environment" is not an empty box. */}
        <Def k={t('mcp.env')}>
          {envNames(server).length > 0 ? (
            <span className="mono">{envNames(server).map((name) => `${name}=${MCP_ENV_MASK}`).join('  ')}</span>
          ) : (
            <span className="faint">{t('common.none')}</span>
          )}
        </Def>
        <Def k="id">
          <span className="mono truncate">{server.id}</span>
        </Def>
      </div>

      {/* The reason, verbatim. Truncating it would defeat the purpose. */}
      {server.lastError && (
        <div className="notice error" style={{ marginTop: 10 }}>
          <div className="error-text">{server.lastError}</div>
          {server.lastCheckedAt && (
            <div className="faint mono" style={{ marginTop: 4, fontSize: 11.5 }}>
              {server.lastCheckedAt}
            </div>
          )}
        </div>
      )}

      <div className="row-gap" style={{ marginTop: 12, flexWrap: 'wrap' }}>
        <label className="row-gap" style={{ gap: 6 }}>
          <input
            type="checkbox"
            checked={server.enabled}
            disabled={busy === `enable:${server.id}`}
            onChange={onToggle}
          />
          <span>{t('mcp.enabled')}</span>
        </label>
        <select
          className="picker-select"
          value={server.exposure}
          disabled={busy === `exposure:${server.id}`}
          aria-label={t('mcp.exposure')}
          onChange={(event) => onExposure(event.target.value as Exposure)}
        >
          <option value="ucad_internal">{t('mcp.exposure_ucad_internal')}</option>
          <option value="agent_facing">{t('mcp.exposure_agent_facing')}</option>
        </select>
        <button className="primary" onClick={onTest} disabled={testing}>
          {testing ? t('mcp.testing') : t('mcp.test')}
        </button>
        <button onClick={onEdit}>{t('mcp.edit')}</button>
        <button className="danger" onClick={onRemove}>
          {t('mcp.remove')}
        </button>
      </div>

      {/* §10.1: agent-facing tools bypass the Context Broker, so the warning
          travels with the setting, not with the damage. */}
      {server.exposure === 'agent_facing' && (
        <div className="notice warn" style={{ marginTop: 10 }}>
          {t('mcp.exposureWarn')}
        </div>
      )}

      {armed && (
        <div className="notice warn" style={{ marginTop: 10 }}>
          <div>
            {t('mcp.remove')} — {server.name}
          </div>
          <div className="row-gap" style={{ marginTop: 8 }}>
            <button className="danger" onClick={onRemove} disabled={busy === `remove:${server.id}`}>
              {t('mcp.remove')}
            </button>
            <button onClick={onDisarm}>{t('common.cancel')}</button>
          </div>
        </div>
      )}

      {test && <TestLine test={test} />}
    </div>
  );
}

function TestLine({ test }: { test: TestOutcome }): JSX.Element {
  const t = useT();
  return (
    <div style={{ marginTop: 10 }}>
      {test.ok ? (
        <div className="notice info">
          <span className="badge ok">✓</span>{' '}
          {t('mcp.testOk', { count: test.toolCount, ms: test.latencyMs })}
          {test.serverInfo && <span className="faint mono" style={{ marginLeft: 6 }}>{test.serverInfo}</span>}
        </div>
      ) : (
        <div className="notice error">
          <div>
            <span className="badge err">✗</span>{' '}
            {t('mcp.testFailed', { reason: test.reason ?? t('common.unknown') })}
          </div>
          {/* What was checked, and — more importantly — what was not. */}
          {test.notVerified && (
            <div className="faint" style={{ marginTop: 5, fontSize: 11.5 }}>
              {test.notVerified}
            </div>
          )}
          {test.checks.length > 0 && (
            <ul className="faint mono" style={{ marginTop: 5, fontSize: 11.5, paddingLeft: 18 }}>
              {test.checks.map((check) => (
                <li key={check}>{check}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function lines(value: string): string[] {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** A name a process can actually export; `1PATH` is not an environment. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * `KEY=VALUE` per line. The value may contain `=`; the name may not be empty.
 * Unusable lines come back in `bad` so the caller can show them instead of
 * saving a configuration the user did not write.
 */
function parseEnv(value: string): { env: Record<string, string>; bad: string[] } {
  const env: Record<string, string> = {};
  const bad: string[] = [];
  for (const line of lines(value)) {
    const eq = line.indexOf('=');
    const name = eq < 0 ? line : line.slice(0, eq).trim();
    if (eq <= 0 || !ENV_NAME.test(name)) {
      bad.push(line);
      continue;
    }
    env[name] = line.slice(eq + 1);
  }
  return { env, bad };
}

/** The stored variable names, sorted (NFR-01 — `envMasked` is already sorted). */
function envNames(server: McpServerDto): string[] {
  return Object.keys(server.envMasked ?? {}).sort();
}

function healthBadge(health: McpServerDto['health']): string {
  return health === 'ok' ? 'badge ok' : health === 'error' ? 'badge err' : 'badge warn';
}

function healthKey(health: McpServerDto['health']): string {
  return health === 'ok' ? 'mcp.health_ok' : health === 'error' ? 'mcp.health_error' : 'mcp.health_unknown';
}

function exposureKey(exposure: McpServerDto['exposure']): string {
  return exposure === 'agent_facing' ? 'mcp.exposure_agent_facing' : 'mcp.exposure_ucad_internal';
}
