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
import { UpdateControllerProvider } from './update-controller';
import {
  HANDOFF_SECTIONS,
  buildHandoffPrompt,
  sectionLabelKey,
} from '../../shared/handoff-prompt';
import { describeError } from './error-message';

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
      <UpdateControllerProvider>
        <Shell />
      </UpdateControllerProvider>
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
  const [handoffHistoryError, setHandoffHistoryError] = useState<string | null>(null);
  const [handoffBusy, setHandoffBusy] = useState(false);
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('ask');
  /**
   * `''` = no explicit agent choice yet; the effect below seeds it from
   * settings, then from the catalogue. It is not a fabricated id: an empty
   * value means "not chosen", exactly like `providerId`.
   */
  const [agentId, setAgentId] = useState<string>('');
  const [providers, setProviders] = useState<ProviderDescriptorDto[]>([]);
  /**
   * `''` = do not override; the session's own provider decides. Sending an
   * explicit provider here would change behaviour for a user who never touched
   * the picker, so the default has to be "no opinion".
   */
  const [providerId, setProviderId] = useState<string>('');
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  /** Ctrl+L pressed while the composer is not mounted (a non-chat surface). */
  const pendingComposerFocus = useRef(false);

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

  /**
   * The agent a new turn or session will use: the picker's explicit choice,
   * else the remembered default, else the first catalogued agent.
   *
   * The state is seeded by the effect below, but this value is what the send
   * path reads, so a click that lands in the same frame as the first settings
   * load still names a real agent rather than an empty string.
   */
  const effectiveAgentId =
    agentId || data.settings?.agent.defaultAgentId || data.agents[0]?.manifest.id || 'mock';

  const { view, error: streamError, gaps, replaying } = useSessionEvents(sessionId);
  const { pending, respond, busy: permissionBusy, error: permissionError } =
    usePermissionQueue(view);

  useEffect(() => {
    if (!sessionId && data.sessions.length > 0) setSessionId(data.sessions[0]!.id);
  }, [data.sessions, sessionId]);

  /**
   * A handoff belongs to one session.
   *
   * The document used to survive a switch: selecting another session kept the
   * previous one's summary on screen, so the panel described work that session
   * had never done. The chain has its own read, keyed on `sessionId`, but the
   * document is only written by `generateHandoff` — nothing retired it. Both
   * the document and the chain readout are cleared here so the new session
   * starts from "not read yet", not from its neighbour's answer.
   */
  useEffect(() => {
    setHandoff(null);
    setHandoffHistory([]);
    setHandoffHistoryError(null);
  }, [sessionId]);

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

  /**
   * Seed the agent picker once, from the remembered default or the first
   * catalogued agent.
   *
   * Guarded on the current value being empty, like `providerId`. Without the
   * guard every settings refresh — a provider patch, the settings card saving
   * anything — reset the composer to the default agent under the user, even
   * though they had already chosen one for this session.
   */
  useEffect(() => {
    if (agentId !== '') return;
    const fallback =
      data.settings?.agent.defaultAgentId || data.agents[0]?.manifest.id;
    if (fallback) setAgentId(fallback);
  }, [data.settings, data.agents, agentId]);

  useEffect(() => {
    if (data.settings?.agent.permissionMode) setPermissionMode(data.settings.agent.permissionMode);
  }, [data.settings]);

  useEffect(() => {
    if (data.loadError) setFatal(data.loadError);
  }, [data.loadError]);

  /**
   * Reads the chain and records whether the read itself succeeded.
   *
   * A failed read is a fact, not an empty list: `.catch(() => undefined)` left
   * `[]` in place, and `[]` is exactly what "this session has no handoffs"
   * looks like, so the panel made a confident false statement. Usage and
   * diagnostics already render read failures as themselves; the handoff
   * history was the one surface that did not.
   *
   * `isCancelled` is how the opening effect keeps a slow read for a previous
   * session from landing under the current one.
   */
  const refreshHandoffHistory = useCallback(
    async (id: string, isCancelled: () => boolean = () => false): Promise<void> => {
      try {
        const list = await api.sessions.listHandoffs(id);
        if (isCancelled()) return;
        setHandoffHistory(list);
        setHandoffHistoryError(null);
      } catch (error) {
        if (!isCancelled()) setHandoffHistoryError(describeError(error));
      }
    },
    [api],
  );

  /*
   * The handoff chain is read when the surface opens, not when a handoff is
   * generated.
   *
   * It used to be read only as the step after a write, so a session that
   * already held three handoffs opened onto "还没有交接摘要" — a confident
   * claim that is false, and the one class of bug this renderer everywhere
   * else refuses to ship: an empty read rendered as an empty fact. Worse, the
   * only route to the existing records was the button that creates a *new*
   * one, so looking at the history meant appending to it.
   */
  useEffect(() => {
    if (surface !== 'handoff' || !sessionId) return;
    let cancelled = false;
    void refreshHandoffHistory(sessionId, () => cancelled);
    return () => {
      cancelled = true;
    };
  }, [surface, sessionId, refreshHandoffHistory]);

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
      setFatal(describeError(error));
    }
  }, [api, data, flash]);

  /**
   * Actually creates a session and selects it. This is what the menu's
   * "new session" command and the rail's "+" promise: a session the user asked
   * for must appear even when one is already open, which is why both call
   * sites route here rather than through `ensureSession`.
   */
  const createSession = useCallback(async (): Promise<string | null> => {
    /*
     * No workspace means no session, and that used to be a bare `return null`.
     *
     * The guard is correct; returning silently was not. It is reached from the
     * rail's "+" and the menu item, both of which the user clicks expecting a
     * session — and on a first run, with no project open, nothing happened at
     * all: no row, no notice, no reason. The `catch` below already carries the
     * comment that an action which looks like it did nothing is the bug; the
     * guard clause was that bug.
     *
     * A session is scoped to a workspace, so the reason has to be stated. The
     * rail shows the same sentence as its empty note, so the answer is on
     * screen before the click as well as after it.
     */
    if (!data.workspace) {
      flash(t('empty.sessionsNoWorkspace'));
      return null;
    }
    try {
      const created = await api.sessions.create({
        workspaceId: data.workspace.id,
        agentId: effectiveAgentId,
        permissionMode,
        title: t('session.new'),
        // The session records the vendor it was opened with, so a later turn
        // without an explicit choice still has one to fall back to. `''` means
        // "no preference" and is never sent as a provider id.
        ...(providerId !== '' ? { providerId } : {}),
      });
      setSessionId(created.id);
      await data.refresh();
      return created.id;
    } catch (error) {
      // This is reached from the menu item, the rail's "+" and `send()` alike.
      // An unhandled rejection here looked to the user like a button that did
      // nothing, so the reason is surfaced and the typed text is kept.
      flash(t('session.createFailed', { reason: describeError(error) }));
      return null;
    }
  }, [api, data, effectiveAgentId, permissionMode, providerId, t, flash]);

  const ensureSession = useCallback(async (): Promise<string | null> => {
    if (!data.workspace) return null;
    if (sessionId) return sessionId;
    return createSession();
  }, [data, sessionId, createSession]);

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
        setFatal(describeError(error));
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
      .catch((error: unknown) => flash(t('session.stopFailed', { reason: describeError(error) })));
  }, [api, sessionId, t, flash]);

  const renameSession = useCallback(
    (id: string, title: string) => {
      void api.sessions
        .rename(id, title)
        .then(() => data.refresh())
        .catch((error: unknown) => flash(t('session.renameFailed', { reason: describeError(error) })));
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
        .catch((error: unknown) => flash(t('session.deleteFailed', { reason: describeError(error) })));
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
      // A failure here must not sink the handoff the user just asked for; it
      // is reported beside the document instead.
      await refreshHandoffHistory(sessionId);
    } catch (error) {
      flash(t('handoff.failed', { reason: describeError(error) }));
    } finally {
      setHandoffBusy(false);
    }
  }, [api, sessionId, t, flash, refreshHandoffHistory]);

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
          await api.sessions.claimHandoff(sessionId, handoffId, effectiveAgentId);
          flash(t('handoff.claimed'));
        } else {
          await api.sessions.completeHandoff(sessionId, handoffId);
          flash(t('handoff.completed'));
        }
        // Read inside the helper so a failed refresh is reported as a read
        // failure, not as a refusal of the claim that just succeeded.
        await refreshHandoffHistory(sessionId);
      } catch (error) {
        // A refusal here is information, not a crash: it is how the user
        // learns another agent already holds this handoff.
        flash(t('handoff.claimFailed', { reason: describeError(error) }));
        // Re-read the truth even after a refusal, but report a read failure
        // rather than presenting the previous list as current.
        await refreshHandoffHistory(sessionId);
      }
    },
    [api, sessionId, effectiveAgentId, t, flash, refreshHandoffHistory],
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
          void createSession();
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
                    reason: describeError(error),
                  }),
                );
              });
          }
          break;
        default:
          break;
      }
    });
  }, [api, openProject, createSession, data, stop, sessionId, setLocale, generateHandoff, t, flash]);

  // In-window keys a menu item cannot express.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && view.status === 'RUNNING') {
        void stop();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key === 'l') {
        event.preventDefault();
        if (composerRef.current) {
          composerRef.current.focus();
        } else {
          // The composer only exists on the chat surface. The help page offers
          // Ctrl+L without a surface qualifier, so from another surface the key
          // returns to the conversation and focuses there — it must not be a
          // silent no-op on ten of the eleven surfaces.
          pendingComposerFocus.current = true;
          setSurface('chat');
        }
      }
      if ((event.ctrlKey || event.metaKey) && event.key === 'k') {
        event.preventDefault();
        setSurface('explorer');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [view.status, stop]);

  // The deferred half of Ctrl+L: the composer mounts one render after the
  // surface switches to chat, so the focus call waits for that mount.
  useEffect(() => {
    if (!pendingComposerFocus.current) return;
    if (!composerRef.current) return;
    pendingComposerFocus.current = false;
    composerRef.current.focus();
  }, [surface]);

  const running = view.status === 'RUNNING';
  const interrupted = view.status === 'INTERRUPTED';
  const showPreview = !FULL_SURFACES.has(surface);
  const visibleSurface = surface === 'chat' ? 'chat' : surface;

  /**
   * Whose words the assistant lines are. A transcript where only the user is
   * named leaves every other line unattributed, in a product that runs several
   * agents; the session's own agent wins over the composer's current pick.
   */
  const activeAgentName = useMemo(() => {
    const id = data.activeSession?.agentId ?? effectiveAgentId;
    return data.agents.find((a) => a.manifest.id === id)?.manifest.displayName ?? id;
  }, [data.activeSession, data.agents, effectiveAgentId]);

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
          <div className="row-gap">
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

        {/*
          The toast used to sit in the topbar, between the spacer and the
          locale switch. A title bar is where a user looks to change the
          language or drag the window, not where they look for the result of
          the action they just took — and on a wide window it landed in the
          empty middle of the bar, as far from the click as the layout allows.
          It now rides above the status bar, in the corner the eye returns to,
          and is a polite live region so a screen reader hears it at all.
        */}
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
          onNewSession={() => {
            void createSession();
            setSurface('chat');
          }}
          onResume={() => {
            // §5.3: a session can be left RUNNING by a crash. Resuming is a
            // real action, not a view toggle — it goes through Main so the
            // INTERRUPTED -> READY transition and the native-session probe
            // actually happen.
            //
            // Both guards used to return silently, so on a first run (no
            // project, no session) the ⟳ button was inert with no explanation.
            if (!data.workspace) {
              flash(t('empty.sessionsNoWorkspace'));
              return;
            }
            if (!sessionId) {
              flash(t('session.resumeNeedsSession'));
              return;
            }
            void api.sessions
              .resume(sessionId)
              .then(() => data.refresh())
              .catch((error) =>
                setFatal(describeError(error)),
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
                    <div className="faint">
                      {t('common.loading')}
                    </div>
                  ) : view.messages.length === 0 && view.tools.length === 0 && !streamError ? (

                    <div className="first-run">
                      <div className="first-run-lead">{t('empty.chat')}</div>
                      <div className="block-title mt-5">
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
                        agentName={activeAgentName}
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
                agentId={effectiveAgentId}
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
                historyError={handoffHistoryError}
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
                currentId={data.workspace?.id ?? null}
                onActivated={(next, requested) => {
                  // Switching project invalidates the session list, so the
                  // selection is cleared rather than left pointing at a chat that
                  // belongs to the previous folder.
                  setSessionId(null);
                  void data.refresh();
                  setSurface('chat');
                  /*
                   * Confirmed here, not in the panel: the panel is unmounted by
                   * the `setSurface` above, so a notice it set for itself was
                   * never rendered. This toast outlives the navigation.
                   *
                   * The message distinguishes the two cases because the answer
                   * is not always the row that was clicked. When a newer request
                   * took over, Main loads that project and says so
                   * (`activation: 'superseded'` plus `requestedWorkspaceId`).
                   * Navigating silently in that case is the failure the whole
                   * activation queue guards against, one layer out: the user
                   * clicks A, lands in B, and is told — by a toast naming B —
                   * that everything went as asked.
                   */
                  const superseded = next.activation === 'superseded' || next.id !== requested.id;
                  flash(
                    superseded
                      ? t('recent.switchedSuperseded', {
                          requested: requested.name,
                          name: next.name,
                        })
                      : t('recent.switched', { name: next.name }),
                  );
                }}
                onOpenFolder={() => void openProject()}
              />
            </PanelBoundary>
          )}
          {surface === 'help' && (
            <PanelBoundary label={t('tab.help')}>
              <HelpPanel
                onOpenProject={() => void openProject()}
                onNewSession={() => {
                  void createSession();
                  setSurface('chat');
                }}
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

      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}

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
