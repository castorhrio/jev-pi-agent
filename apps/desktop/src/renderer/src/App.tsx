import { useCallback, useEffect, useMemo, useRef, useState, Suspense, lazy } from 'react';
import { createPortal } from 'react-dom';
import type {
  PermissionDecision,
  PermissionMode,
  ContextHandoff,
  HandoffRecord,
  ProviderDescriptorDto,
} from '@ucad/contracts';

/**
 * The terminal panel is loaded on demand; see the note where it renders.
 * Named `LazyTerminalPanel` so the import site reads as deliberate rather than
 * as a leftover.
 */
const LazyTerminalPanel = lazy(async () => {
  const mod = await import('./components/TerminalPanel');
  return { default: mod.TerminalPanel };
});
import { getApi, hasApi } from './api';
import { I18nProvider, useI18n, useT } from './i18n-context';
import type { Locale } from '../../shared/i18n';
import { useAppData, usePermissionQueue, useSessionEvents } from './state/hooks';
import { ChatLog } from './components/ChatLog';
import { Changes, Explorer } from './components/Panels';
import { ContextDrawer } from './components/ContextDrawer';
import { DecisionPanel } from './components/DecisionPanel';
import { PermissionsPanel } from './components/PermissionsPanel';
import {
  DiagnosticsPanel,
  PermissionDialog,
  SettingsPanel,
  UsagePanel,
} from './components/Settings';
import { HelpPanel } from './components/Help';
import { PreviewPane } from './components/PreviewPane';
import { UpdateBanner } from './components/UpdateBanner';
import { Composer } from './components/Composer';
import { LeftRail } from './components/LeftRail';
import { StatusBar } from './components/StatusBar';
import { IntelligencePanel } from './components/IntelligencePanel';
import { StoragePanel } from './components/StoragePanel';
import { McpPanel } from './components/McpPanel';
import { RecentProjects } from './components/RecentProjects';
import { HandoffPanel } from './components/HandoffPanel';
import { PanelBoundary } from './components/PanelBoundary';
import {
  HANDOFF_SECTIONS,
  buildHandoffPrompt,
  sectionLabelKey,
} from '../../shared/handoff-prompt';

type Surface =
  | 'chat'
  | 'explorer'
  | 'changes'
  | 'context'
  | 'decision'
  | 'usage'
  | 'settings'
  | 'diagnostics'
  | 'help'
  | 'terminal'
  | 'intelligence'
  | 'storage'
  | 'mcp'
  | 'handoff'
  | 'recent';

/**
 * Main rejects every handler with a real `Error` (`toUserError` in
 * main/ipc.ts), so this never sees the `AppError` *object* — and the Renderer
 * deliberately imports no runtime code from the CommonJS `@ucad/contracts`, so
 * it cannot use `describeError` either. Kept in one place so a new call site
 * cannot quietly reintroduce `[object Object]`.
 */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Surfaces that take over the full main column (no conversation underneath). */
const FULL_SURFACES: ReadonlySet<Surface> = new Set<Surface>([
  'explorer',
  'changes',
  'context',
  'decision',
  'usage',
  'settings',
  'diagnostics',
  'help',
  'terminal',
  'intelligence',
  'storage',
  'mcp',
  'handoff',
  'recent',
]);

/**
 * Navigation is split by *when you need it*, not by which module implements it.
 *
 * Fourteen peer tabs overflowed the row at 1280 px and gave every destination
 * the same visual weight, so the chat — the thing the product is for — looked
 * like one option among fourteen. The primary row is the working loop; the rest
 * live behind one explicit "more" control.
 */
const PRIMARY_SURFACES: Surface[] = ['chat', 'explorer', 'changes', 'context', 'decision'];

const MORE_SURFACES: Surface[] = [
  'handoff',
  'usage',
  'terminal',
  'intelligence',
  'mcp',
  'storage',
  'recent',
  'settings',
  'diagnostics',
  'help',
];

const SURFACE_ORDER: Surface[] = [...PRIMARY_SURFACES, ...MORE_SURFACES];

export function App(): JSX.Element {
  if (!hasApi()) return <BridgeMissing />;
  return (
    <I18nProvider api={getApi()}>
      <Shell />
    </I18nProvider>
  );
}

function BridgeMissing(): JSX.Element {
  return (
    <div className="app">
      <div className="topbar">
        <div className="brand">
          <span className="brand-mark" />
          UCAD
        </div>
      </div>
      <div className="pane">
        <div className="pane-head">
          <h1>UCAD</h1>
        </div>
        <div className="notice error">
          UCAD bridge unavailable — the preload did not load. Please restart the app.
        </div>
      </div>
    </div>
  );
}

function Shell(): JSX.Element {
  const t = useT();
  const { locale, setLocale } = useI18n();
  const api = useMemo(() => getApi(), []);

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [surface, setSurface] = useState<Surface>('chat');
  const [objective, setObjective] = useState('');
  const [busy, setBusy] = useState(false);
  const [fatal, setFatal] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const [handoff, setHandoff] = useState<ContextHandoff | null>(null);
  const [handoffHistory, setHandoffHistory] = useState<HandoffRecord[]>([]);
  const [handoffBusy, setHandoffBusy] = useState(false);
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('ask');
  const [agentId, setAgentId] = useState<string>('mock');
  const [providers, setProviders] = useState<ProviderDescriptorDto[]>([]);
  /**
   * `''` = do not override; the session's own provider decides. Sending an
   * explicit provider here would change behaviour for a user who never touched
   * the picker, so the default has to be "no opinion".
   */
  const [providerId, setProviderId] = useState<string>('');
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  const data = useAppData(sessionId);

  /**
   * The vendor a turn will use: the picker's choice if the user made one,
   * otherwise whatever the session is bound to. Shown on the provider card as
   * "in use", and computed in the same place the send path uses so the label
   * cannot describe something other than what actually happens.
   */
  const effectiveProviderId =
    providerId !== ''
      ? providerId
      : (data.sessions.find((s) => s.id === sessionId)?.providerId ?? undefined);

  const { view, error: streamError, gaps, replaying } = useSessionEvents(sessionId);
  const { pending, respond, busy: permissionBusy, error: permissionError } =
    usePermissionQueue(view);

  useEffect(() => {
    if (!sessionId && data.sessions.length > 0) setSessionId(data.sessions[0]!.id);
  }, [data.sessions, sessionId]);

  // The vendor list drives the composer's picker. A failure here must not stop
  // the app from starting: without it the picker is simply absent and turns
  // behave exactly as they did before this existed.
  useEffect(() => {
    let cancelled = false;
    void getApi()
      .providers.list()
      .then((list) => {
        if (!cancelled) setProviders(list);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Seed the picker from the remembered default, once.
   *
   * Guarded on the current value being empty rather than running on every
   * settings change, so that re-saving settings does not yank the picker's
   * value back under the user mid-session.
   */
  useEffect(() => {
    if (providerId === '' && data.settings?.provider.defaultProviderId) {
      setProviderId(data.settings.provider.defaultProviderId);
    }
  }, [data.settings, providerId]);

  /**
   * An explicit choice is remembered, so a user does not re-pick on every
   * launch. "Follow agent / session" persists the empty string, which is the
   * honest encoding of "no preference" and is never a made-up vendor id.
   *
   * A failed patch must not become an unhandled rejection, and the picker
   * still shows the choice for this session either way — the turn is not
   * invalidated by a preference that would not save.
   */
  const chooseProvider = useCallback((next: string) => {
    setProviderId(next);
    void getApi()
      .settings.patch({ provider: { defaultProviderId: next } })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (data.settings?.agent.defaultAgentId) {
      setAgentId(data.settings.agent.defaultAgentId);
    } else if (data.agents.length > 0) {      setAgentId(data.agents[0]!.manifest.id);
    }
    if (data.settings?.agent.permissionMode) setPermissionMode(data.settings.agent.permissionMode);
  }, [data.settings, data.agents]);

  useEffect(() => {
    if (data.loadError) setFatal(data.loadError);
  }, [data.loadError]);

  const flash = useCallback((message: string) => {
    setToast(message);
    setTimeout(() => setToast((current) => (current === message ? null : current)), 4000);
  }, []);

  const openProject = useCallback(async () => {
    try {
      const workspace = await api.workspace.open();
      if (!workspace) return;
      await data.refresh();
      setSurface('chat');
      flash(workspace.name);
    } catch (error) {
      setFatal(error instanceof Error ? error.message : String(error));
    }
  }, [api, data, flash]);

  const ensureSession = useCallback(async (): Promise<string | null> => {
    if (!data.workspace) return null;
    if (sessionId) return sessionId;
    try {
      const created = await api.sessions.create({
        workspaceId: data.workspace.id,
        agentId,
        permissionMode,
        title: t('session.new'),
      });
      setSessionId(created.id);
      await data.refresh();
      return created.id;
    } catch (error) {
      // This is reached from the menu item, the rail's "+" and `send()` alike.
      // An unhandled rejection here looked to the user like a button that did
      // nothing, so the reason is surfaced and the typed text is kept.
      flash(t('session.createFailed', { reason: describe(error) }));
      return null;
    }
  }, [api, data, sessionId, agentId, permissionMode, t, flash]);

  const send = useCallback(
    async (text: string) => {
      const body = text.trim();
      if (!body) return;
      setBusy(true);
      setFatal(null);
      try {
        const id = await ensureSession();
        if (!id) return;
        setObjective('');
        await api.sessions.send({
          sessionId: id,
          objective: body,
          // `''` is sent as `undefined` on purpose: the runtime resolves
          // `input.providerId ?? session.providerId`, and passing an empty
          // string would be a provider id that does not exist.
          ...(providerId !== '' ? { providerId } : {}),
        });
      } catch (error) {
        setFatal(error instanceof Error ? error.message : String(error));
      } finally {
        setBusy(false);
      }
    },
    [ensureSession, api, providerId],
  );

  const stop = useCallback(async () => {
    if (!sessionId) return;
    setBusy(false);
    // A cancel that fails must say so. The turn is still running — the Stop
    // button stays because `running` comes from the event stream, not from
    // `busy` — and the user is told the stop did not land rather than left
    // watching a turn they believe they already stopped.
    await api.sessions
      .cancel(sessionId)
      .then(() => undefined)
      .catch((error: unknown) => flash(t('session.stopFailed', { reason: describe(error) })));
  }, [api, sessionId, t, flash]);

  const renameSession = useCallback(
    (id: string, title: string) => {
      void api.sessions
        .rename(id, title)
        .then(() => data.refresh())
        .catch((error: unknown) => flash(t('session.renameFailed', { reason: describe(error) })));
    },
    [api, data, t, flash],
  );

  const deleteSession = useCallback(
    (id: string, title: string) => {
      void api.sessions
        .remove(id)
        .then(() => {
          // Deleting the session the user is looking at must not leave the app
          // pointed at a row that no longer exists.
          setSessionId((current) => (current === id ? null : current));
          return data.refresh();
        })
        .then(() => flash(t('session.deleted', { title })))
        .catch((error: unknown) => flash(t('session.deleteFailed', { reason: describe(error) })));
    },
    [api, data, t, flash],
  );

  /**
   * One implementation, reached from the menu command and the panel button
   * alike, so those two paths cannot drift — the failure mode that let a menu
   * item ship with no handler at all.
   */
  const generateHandoff = useCallback(async () => {
    if (!sessionId) {
      flash(t('handoff.noSession'));
      return;
    }
    setHandoffBusy(true);
    try {
      setHandoff(await api.sessions.createHandoff(sessionId));
      // The chain is read after the write, not before: creating a handoff is
      // what appends to it, so reading first would show the previous state.
      // A failure here must not sink the handoff the user just asked for.
      await api.sessions
        .listHandoffs(sessionId)
        .then(setHandoffHistory)
        .catch(() => undefined);
    } catch (error) {
      flash(t('handoff.failed', { reason: describe(error) }));
    } finally {
      setHandoffBusy(false);
    }
  }, [api, sessionId, t, flash]);

  /**
   * Claim or complete a handoff, then re-read the chain.
   *
   * The re-read is not optional polish: the store refuses an illegal
   * transition, and the user needs to see that refusal. Re-reading means the
   * panel shows the stored truth rather than an optimistic local guess that
   * could disagree with it.
   */
  const mutateHandoff = useCallback(
    async (
      action: 'claim' | 'complete',
      handoffId: string,
    ): Promise<void> => {
      if (!sessionId) return;
      try {
        if (action === 'claim') {
          await api.sessions.claimHandoff(sessionId, handoffId, agentId);
          flash(t('handoff.claimed'));
        } else {
          await api.sessions.completeHandoff(sessionId, handoffId);
          flash(t('handoff.completed'));
        }
        setHandoffHistory(await api.sessions.listHandoffs(sessionId));
      } catch (error) {
        // A refusal here is information, not a crash: it is how the user
        // learns another agent already holds this handoff.
        flash(t('handoff.claimFailed', { reason: describe(error) }));
        await api.sessions
          .listHandoffs(sessionId)
          .then(setHandoffHistory)
          .catch(() => undefined);
      }
    },
    [api, sessionId, agentId, t, flash],
  );

  // One implementation per command, reached from the menu, the keyboard and the
  // buttons alike, so those three paths cannot drift apart.
  useEffect(() => {
    return api.menu.onCommand(({ command, payload }) => {
      switch (command) {
        case 'open-project':
          void openProject();
          break;
        case 'new-session':
          void ensureSession().then(() => data.refresh());
          setSurface('chat');
          break;
        case 'open-settings':
          setSurface('settings');
          break;
        case 'navigate': {
          const target = String(payload ?? '');
          if ((SURFACE_ORDER as string[]).includes(target)) setSurface(target as Surface);
          break;
        }
        case 'stop-turn':
          void stop();
          break;
        case 'set-locale':
          if (payload === 'zh-CN' || payload === 'en-US') void setLocale(payload as Locale);
          break;
        case 'check-update':
          setSurface('settings');
          break;
        case 'create-handoff':
          // This menu item was registered in Main and had no handler here, so
          // clicking it did nothing at all. A handoff is the one artefact that
          // carries state to the *next* agent, so it now
          // has a real action and a real place to land.
          setSurface('handoff');
          void generateHandoff();
          break;
        case 'export-session':
          if (sessionId) {
            const target = sessionId;
            void api.sessions
              .export(target, 'markdown')
              .then((res) => {
                // §8.4: the export is plaintext conversation plus quoted source.
                // A dismissal is a choice and stays silent; a real write reports
                // where the file went, because "nothing happened" after a save
                // dialog is indistinguishable from a silent failure.
                if (res.canceled === true) return;
                flash(t('session.exportDone', { path: res.path }));
              })
              .catch((error: unknown) => {
                flash(
                  t('session.exportFailed', {
                    reason: error instanceof Error ? error.message : String(error),
                  }),
                );
              });
          }
          break;
        default:
          break;
      }
    });
  }, [api, openProject, ensureSession, data, stop, sessionId, setLocale, generateHandoff, t, flash]);

  // In-window keys a menu item cannot express.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && view.status === 'RUNNING') {
        void stop();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key === 'l') {
        event.preventDefault();
        composerRef.current?.focus();
      }
      if ((event.ctrlKey || event.metaKey) && event.key === 'k') {
        event.preventDefault();
        setSurface('explorer');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [view.status, stop]);

  const running = view.status === 'RUNNING';
  const interrupted = view.status === 'INTERRUPTED';
  const showPreview = !FULL_SURFACES.has(surface);
  const visibleSurface = surface === 'chat' ? 'chat' : surface;

  if (fatal) {
    return (
      <div className="app">
        <div className="topbar">
          <div className="brand">
            <span className="brand-mark" />
            UCAD
          </div>
          <div className="spacer" />
          <LocaleSwitch locale={locale} onChange={setLocale} />
        </div>
        <div className="pane">
          <div className="pane-head">
            <h1>{t('error.title')}</h1>
            <p>{fatal}</p>
          </div>
          <div className="row" style={{ display: 'flex', gap: 8 }}>
            <button className="primary" onClick={() => setFatal(null)}>
              {t('error.retry')}
            </button>
            <button onClick={() => void openProject()}>{t('welcome.open')}</button>
            <button onClick={() => setSurface('help')}>{t('help.title')}</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" />
          UCAD
        </div>

        <button className="project-chip" onClick={() => void openProject()} title={t('welcome.open')}>
          <span className="truncate">{data.workspace?.name ?? t('welcome.open')}</span>
          <span className="faint">▾</span>
        </button>

        <div className="spacer" />

        {toast && <span className="toast">{toast}</span>}

        <button
          className="search-fake"
          onClick={() => setSurface('explorer')}
          title={`${t('help.sc.search')}  (Ctrl+K)`}
        >
          <span className="faint">{t('help.sc.search')}</span>
          <span className="spacer" />
          <kbd>⌘K</kbd>
        </button>

        <LocaleSwitch locale={locale} onChange={setLocale} />
      </header>

      <div className={`body ${showPreview ? '' : 'no-preview'}`}>
        {/*
          The rail and the preview pane are both `complementary` landmarks.
          Unnamed, they are announced identically, so a screen-reader user
          hears "complementary" twice and cannot tell which is the session list
          and which is the context readout.
        */}
        <LeftRail
          data={data}
          sessionId={sessionId}
          onSelectSession={setSessionId}
          onNewSession={() => void ensureSession().then(() => data.refresh())}
          onResume={() => {
            // §5.3: a session can be left RUNNING by a crash. Resuming is a
            // real action, not a view toggle — it goes through Main so the
            // INTERRUPTED -> READY transition and the native-session probe
            // actually happen.
            if (!sessionId) return;
            void api.sessions
              .resume(sessionId)
              .then(() => data.refresh())
              .catch((error) =>
                setFatal(error instanceof Error ? error.message : String(error)),
              );
          }}
          onRenameSession={renameSession}
          onDeleteSession={deleteSession}
          onOpenProject={() => void openProject()}
          onOpenFile={(path) => {
            setSurface('explorer');
            setSelectedFile(path);
          }}
          selectedFile={selectedFile}
        />

        <main className="main">
          {/*
            Named landmarks. There are two navigations in the window — this tab
            strip and the preview pane's — and two unnamed `<nav>` elements are
            announced identically, so "navigation" tells a screen-reader user
            nothing about which one they are in.
          */}
          <nav className="surfaces" aria-label={t('tab.chat')}>
            {PRIMARY_SURFACES.map((entry) => (
              <button
                key={entry}
                className={`surface-tab ${visibleSurface === entry ? 'active' : ''}`}
                data-surface={entry}
                onClick={() => setSurface(entry)}
              >
                {t(`tab.${entry}`)}
                {entry === 'changes' && data.workspace && <ChangeCount />}
              </button>
            ))}
            <div className="more-wrap">
              <button
                ref={moreButtonRef}
                className={`surface-tab more-toggle ${
                  MORE_SURFACES.includes(visibleSurface) ? 'active' : ''
                }`}
                onClick={() => setMoreOpen((open) => !open)}
                aria-expanded={moreOpen}
                aria-haspopup="menu"
              >
                {t('tab.more')}
                <span className="faint"> ▾</span>
              </button>
              {moreOpen && (
                <MoreMenu
                  anchor={moreButtonRef.current}
                  active={visibleSurface}
                  onPick={(entry) => {
                    setSurface(entry);
                    setMoreOpen(false);
                  }}
                />
              )}
            </div>
          </nav>

          <UpdateBanner />

          {surface === 'chat' && (
            <>
              <div className="convo">
                <div className="convo-inner">
                  {streamError ? (
                    // Before this, a failed replay left the conversation
                    // permanently blank and the user read that as "no history".
                    <div className="notice error">
                      <strong>{t('stream.errorTitle')}</strong>
                      <p>{streamError}</p>
                      <button onClick={() => window.location.reload()}>
                        {t('error.retry')}
                      </button>
                    </div>
                  ) : gaps.length > 0 ? (
                    <div className="notice">
                      {t('stream.gapWarning', { count: gaps.reduce((a, g) => a + g.count, 0) })}
                    </div>
                  ) : null}

                  {/*
                   * The reducer counts events it has no case for. That count was
                   * being computed and then thrown away, which is exactly the
                   * silent degradation forbids: a newer Main
                   * emitting an event this Renderer does not know would look
                   * identical to a turn that behaved correctly.
                   */}
                  {view.unmodelledEventCount > 0 && (
                    <div className="notice">
                      {t('stream.unmodelledWarning', {
                        count: view.unmodelledEventCount,
                      })}
                    </div>
                  )}

                  {replaying || data.loading ? (
                    /*
                     * A history that has not arrived yet is not an empty
                     * history. This block used to render the first-run pitch —
                     * "no conversation yet, here's what will happen" — over a
                     * window that had not finished loading, which is a confident
                     * claim about a conversation that may well exist. Two things
                     * have to be true before "there is none" is honest: the app
                     * data has arrived (so a session is known to exist or not),
                     * and this session's events have been replayed.
                     */
                    <div className="faint" style={{ padding: '20px 0' }}>
                      {t('common.loading')}
                    </div>
                  ) : view.messages.length === 0 && view.tools.length === 0 && !streamError ? (

                    <div className="first-run">
                      <div className="first-run-lead">{t('empty.chat')}</div>
                      <div className="block-title" style={{ marginTop: 22 }}>
                        {t('empty.chatSteps')}
                      </div>
                      <ol className="first-run-steps">
                        <li>
                          <span className="n">1</span>
                          <span>{t('empty.chatStep1')}</span>
                        </li>
                        <li>
                          <span className="n">2</span>
                          <span>{t('empty.chatStep2')}</span>
                        </li>
                        <li>
                          <span className="n">3</span>
                          <span>{t('empty.chatStep3')}</span>
                        </li>
                      </ol>
                    </div>
                  ) : (
                    <PanelBoundary label={t('tab.chat')} resetKey={sessionId}>
                      <ChatLog
                        messages={view.messages}
                        tools={view.tools}
                        commands={view.commands}
                        notices={view.notices}
                      />
                    </PanelBoundary>
                  )}
                </div>
              </div>

              <Composer
                ref={composerRef}
                value={objective}
                onChange={setObjective}
                onSend={() => void send(objective)}
                onStop={() => void stop()}
                running={running}
                busy={busy}
                interrupted={interrupted}
                agentId={agentId}
                onAgentChange={setAgentId}
                providerId={providerId}
                onProviderChange={chooseProvider}
                providers={providers}
                permissionMode={permissionMode}
                onPermissionModeChange={setPermissionMode}
                agents={data.agents}
                hasWorkspace={Boolean(data.workspace)}
                onOpenProject={() => void openProject()}
                workspacePath={data.workspace?.path ?? null}
              />
            </>
          )}

          {/*
            Every surface is wrapped in a boundary. One unguarded property
            access used to unmount the entire window — the user got a blank
            screen with the session still running in Main and nothing to click.
            The rail, the status bar and the composer stay alive, so a broken
            pane is a notice inside a working application.
          */}
          {surface === 'explorer' && (
            <PanelBoundary label={t('tab.explorer')} resetKey={selectedFile}>
              <Explorer data={data} selectedPath={selectedFile} onSelectFile={setSelectedFile} />
            </PanelBoundary>
          )}

          {surface === 'changes' && (
            <PanelBoundary label={t('tab.changes')}>
              <Changes data={data} />
            </PanelBoundary>
          )}
          {surface === 'context' && (
            <PanelBoundary label={t('tab.context')}>
              <ContextDrawer data={data} view={view} onEnsureSession={ensureSession} />
            </PanelBoundary>
          )}
          {surface === 'decision' && (
            <PanelBoundary label={t('tab.decision')} resetKey={sessionId}>
              <DecisionPanel
                data={data}
                view={view}
                onEnsureSession={ensureSession}
                onChanged={() => void data.refresh()}
              />
            </PanelBoundary>
          )}
          {surface === 'usage' && (
            <PanelBoundary label={t('tab.usage')}>
              <UsagePanel data={data} view={view} />
            </PanelBoundary>
          )}
          {surface === 'settings' && (
            <PanelBoundary label={t('tab.settings')}>
              {/*
                Stacked as ONE scroll region, not two panes.
                `.pane` is `flex: 1`, which is `flex-basis: 0` — two pane
                siblings therefore each got exactly half the column's height
                and the first one's content was clipped inside a scroll box the
                user cannot see the edges of. The settings cards were present in
                the DOM and simply unreachable.
              */}
              <div className="pane-stack">
                <SettingsPanel
                  data={data}
                  onChanged={() => void data.refresh()}
                  inUseProviderId={effectiveProviderId}
                />
                <PermissionsPanel />
              </div>
            </PanelBoundary>
          )}
          {surface === 'diagnostics' && (
            <PanelBoundary label={t('tab.diagnostics')}>
              <DiagnosticsPanel data={data} />
            </PanelBoundary>
          )}
          {surface === 'terminal' && (
            <PanelBoundary label={t('tab.terminal')}>
              {/*
                Lazy because `@xterm/xterm` is the single largest dependency in
                the renderer: 339 kB of the 725 kB chunk by source-map
                attribution, roughly 46% of it. The terminal lives behind the
                "更多" menu, so every launch was parsing an emulator that most
                sessions never open.

                There is no network here — this app loads from disk — so the
                saving is parse and compile time, not download. It is still
                real, and the measurement is what justified it rather than the
                size of the total.
              */}
              <Suspense
                fallback={
                  <div className="empty-block">
                    <p>{t('common.loading')}</p>
                  </div>
                }
              >
                <LazyTerminalPanel data={data} />
              </Suspense>
            </PanelBoundary>
          )}
          {surface === 'intelligence' && (
            <PanelBoundary label={t('tab.intelligence')}>
              <IntelligencePanel data={data} />
            </PanelBoundary>
          )}
          {surface === 'storage' && (
            <PanelBoundary label={t('tab.storage')}>
              <StoragePanel data={data} />
            </PanelBoundary>
          )}
          {surface === 'mcp' && (
            <PanelBoundary label={t('tab.mcp')}>
              <McpPanel data={data} />
            </PanelBoundary>
          )}
          {surface === 'handoff' && (
            <PanelBoundary label={t('tab.handoff')} resetKey={handoff}>
              <HandoffPanel
                handoff={handoff}
                history={handoffHistory}
                busy={handoffBusy}
                hasSession={Boolean(sessionId)}
                onRegenerate={() => void generateHandoff()}
                onClaim={(id) => void mutateHandoff('claim', id)}
                onComplete={(id) => void mutateHandoff('complete', id)}
                onStartWithHandoff={(value, sections) => {
                  /*
                   * Carry the record into the composer rather than opening a
                   * blank chat — that is the whole point of a handoff.
                   *
                   * This used to carry the objective alone, which threw away
                   * the decisions, the failed commands and the open work: the
                   * three things the user should never have to
                   * have to repeat. It also built the sentence inline in
                   * hardcoded Chinese, so switching the app to English opened
                   * the composer with a Chinese line. Both are now
                   * `buildHandoffPrompt`'s job, in a module with tests.
                   */
                  setObjective(
                    buildHandoffPrompt(value, sections, {
                      title: t('handoff.carryPromptTitle'),
                      sections: Object.fromEntries(
                        HANDOFF_SECTIONS.map((section) => [section, t(sectionLabelKey(section))]),
                      ),
                    }),
                  );
                  setSurface('chat');
                  flash(t('handoff.carried'));
                }}
              />
            </PanelBoundary>
          )}

          {surface === 'recent' && (
            <PanelBoundary label={t('tab.recent')}>
              <RecentProjects
                onActivated={() => {
                  // Switching project invalidates the session list, so the
                  // selection is cleared rather than left pointing at a chat that
                  // belongs to the previous folder.
                  setSessionId(null);
                  void data.refresh();
                  setSurface('chat');
                }}
                onOpenFolder={() => void openProject()}
              />
            </PanelBoundary>
          )}
          {surface === 'help' && (
            <PanelBoundary label={t('tab.help')}>
              <HelpPanel
                onOpenProject={() => void openProject()}
                onNewSession={() => void ensureSession().then(() => data.refresh())}
                onOpenSettings={() => setSurface('settings')}
                hasWorkspace={Boolean(data.workspace)}
                hasSession={Boolean(sessionId)}
              />
            </PanelBoundary>
          )}
        </main>

        {showPreview && (
          <PanelBoundary label={t('common.preview')}>
            <PreviewPane data={data} view={view} />
          </PanelBoundary>
        )}
      </div>

      <StatusBar data={data} view={view} onOpenHelp={() => setSurface('help')} />

      <PermissionDialog
        request={pending[0] ?? null}
        busy={permissionBusy}
        error={permissionError}
        onDecide={(requestId, decision: PermissionDecision) => void respond(requestId, decision)}
      />
    </div>
  );
}

/**
 * The overflow menu is rendered into `document.body` on purpose.
 *
 * `.surfaces` has `overflow-x: auto` (it has to, so a long primary row can
 * still scroll), and any `overflow` clips absolutely-positioned descendants —
 * so an in-place dropdown is cut off at the nav's edge and silently does
 * nothing. A portal escapes the clip, and lets the menu flip above the anchor
 * when there is not enough room below.
 */
function MoreMenu({
  anchor,
  active,
  onPick,
}: {
  anchor: HTMLButtonElement | null;
  active: Surface;
  onPick: (entry: Surface) => void;
}): JSX.Element | null {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    if (!anchor) return;
    const place = () => {
      const rect = anchor.getBoundingClientRect();
      const height = MORE_SURFACES.length * 30 + 8;
      const below = window.innerHeight - rect.bottom;
      const top = below < height ? Math.max(4, rect.top - height - 4) : rect.bottom + 4;
      setStyle({ top, left: Math.max(4, rect.right - 168) });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [anchor]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') (ref.current?.parentElement as HTMLElement | null)?.click();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!style) return null;

  return createPortal(
    <>
      <div
        className="more-scrim"
        onClick={() => onPick(active)}
        aria-hidden
      />
      <div
        className="more-menu"
        role="menu"
        ref={ref}
        style={{ top: style.top, left: style.left }}
      >
        {MORE_SURFACES.map((entry) => (
          <button
            key={entry}
            role="menuitem"
            className={active === entry ? 'active' : ''}
            data-surface={entry}
            onClick={() => onPick(entry)}
          >
            {t(`tab.${entry}`)}
          </button>
        ))}
      </div>
    </>,
    document.body,
  );
}

function ChangeCount(): JSX.Element | null {
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const list = await getApi().workspace.listRecent();
        if (cancelled || list.length === 0) return;
        const status = await getApi().git.status(list[0]!.id);
        if (!cancelled) {
          setCount(status.staged.length + status.unstaged.length + status.untracked.length);
        }
      } catch {
        /* not a git repo, or no workspace */
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);
  if (count === null || count === 0) return null;
  return <span className="count">{count}</span>;
}

function LocaleSwitch({
  locale,
  onChange,
}: {
  locale: Locale;
  onChange: (locale: Locale) => Promise<void>;
}): JSX.Element {
  const t = useT();
  return (
    <select
      className="locale"
      value={locale}
      onChange={(e) => void onChange(e.target.value as Locale)}
      aria-label={t('lang.label')}
      title={t('lang.label')}
    >
      <option value="zh-CN">{t('lang.zhCN')}</option>
      <option value="en-US">{t('lang.enUS')}</option>
    </select>
  );
}
