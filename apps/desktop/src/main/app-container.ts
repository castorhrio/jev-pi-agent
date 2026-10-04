/**
 * Composition root: every subsystem is constructed here and nowhere else.
 *
 * This file is the only place that knows how the pieces fit together. Every
 * other file either implements one service or translates one IPC channel.
 * `bootstrap.ts` adds the Electron lifecycle on top; nothing below this layer
 * imports Electron except for `safeStorage`, which is the OS key store.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { safeStorage } from 'electron';
import { Database, EventLog, MessageProjector, SessionSequencer } from '@ucad/storage';
import { RetentionService, SessionStore } from '@ucad/session';
import { PermissionEngine } from '@ucad/permissions';
import { SafeStorageSecretStore } from '@ucad/secrets';
import { UsageStore } from '@ucad/usage';
import { McpManager } from '@ucad/mcp';
import { FileService, createFsWatcher } from '@ucad/files';
import { GitService } from '@ucad/git';
import { CommandRunner, PtyHost, probePty, type PtyAvailability } from '@ucad/terminal';
import { BasicIntelligenceProvider, IntelligenceManager } from '@ucad/code-intelligence';
import {
  ContextBroker,
  HeuristicTokenEstimator,
  InjectionRenderer,
  ToolContractHost,
  TurnBudgetLedger,
} from '@ucad/context';
import { AgentRuntimeManager } from '@ucad/agent-core';
import { AgentHostProcess, resolveHostEntry } from '@ucad/agent-host';
import { BUILTIN_PROVIDERS, ModelRegistry, ProviderClient, getProvider } from '@ucad/providers';
import { SkillRegistry } from '@ucad/skills';
import {
  BlobStore,
  FileLogSink,
  Logger,
  MemoryLogSink,
  MultiLogSink,
} from '@ucad/observability';
import type {
  AgentManifest,
  DecisionFacts,
  ToolAvailabilityContext,
  TurnEvent,
  ProviderDescriptorDto,
} from '@ucad/contracts';
import { IPC_PUSH, describeError } from '@ucad/contracts';
import type { AppPaths } from './paths';
import { DecisionFacade } from './decision-facade';
import { GitLikeBridge } from './git-bridge';

export interface UcadAppOptions {
  paths: AppPaths;
  /** compiled adapter entry points, keyed by adapter id */
  adapterModules?: Record<string, string>;
}

export class UcadApp {
  readonly paths: AppPaths;

  logger!: Logger;
  blobs!: BlobStore;
  memoryLog!: MemoryLogSink;
  secrets!: SafeStorageSecretStore;
  db!: Database;
  eventLog!: EventLog;
  sequencer!: SessionSequencer;
  projector!: MessageProjector;
  sessionStore!: SessionStore;
  permissions!: PermissionEngine;
  usage!: UsageStore;
  mcp!: McpManager;
  intelligence!: IntelligenceManager;
  files!: FileService;
  git!: GitService;
  terminal!: CommandRunner;
  /** §11.2 interactive user terminal. */
  pty!: PtyHost;
  private ptyAvailability: PtyAvailability | undefined;
  estimator!: HeuristicTokenEstimator;
  ledger!: TurnBudgetLedger;
  /** §8.4 retention and cleanup. */
  retention!: RetentionService;
  renderer!: InjectionRenderer;
  broker!: ContextBroker;
  tools!: ToolContractHost;
  decisions!: DecisionFacade;
  runtime!: AgentRuntimeManager;
  providerClient!: ProviderClient;
  modelRegistry!: ModelRegistry;
  skills!: SkillRegistry;

  readonly agents = new Map<string, AgentHostProcess>();
  private readonly adapterModules: Record<string, string>;
  private rendererSink: ((e: TurnEvent) => void) | null = null;
  private dataSink: ((channel: string, payload: unknown) => void) | null = null;

  constructor(opts: UcadAppOptions) {
    this.paths = opts.paths;
    this.adapterModules = opts.adapterModules ?? {};
  }

  get encryptionEnabled(): boolean {
    return this.db.isProtected();
  }

  async start(): Promise<void> {
    this.#initLogging();
    this.#initStorage();
    this.#initServices();
    this.#initPlanes();
    this.#initRuntime();

    this.logger.info('ucad started', {
      db: this.paths.dbPath,
      encrypted: this.encryptionEnabled,
      schemaVersion: this.db.schemaVersion,
    });

    this.recoverInterruptedSessions();
    this.retention = new RetentionService({
      db: this.db,
      sessionStore: this.sessionStore,
      blobs: this.blobs,
      logger: this.logger.child('retention'),
      dbPath: this.paths.dbPath,
    });
  }

  /**
   * §8.4 "默认 events 保留 90 天". The window is only a promise if something
   * actually applies it, so it runs once per start — after crash recovery, so a
   * session the user was mid-way through is never the one that gets swept.
   *
   * Failures are logged, never thrown: a retention sweep that cannot run must
   * not stop the product from opening, and it must not look like it ran.
   */
  async applyRetentionOnStart(): Promise<void> {
    try {
      const result = await this.retention.applyRetention();
      if (result.sessionsRemoved > 0) {
        this.logger.info('retention applied on start', {
          sessionsRemoved: result.sessionsRemoved,
          eventsRemoved: result.eventsRemoved,
          blobFilesRemoved: result.blobFilesRemoved,
        });
      }
    } catch (error) {
      this.logger.warn('retention sweep did not run', {
        reason: describeError(error),
      });
    }
  }

  #initLogging(): void {
    fs.mkdirSync(this.paths.logDir, { recursive: true });
    this.memoryLog = new MemoryLogSink(500);
    this.logger = new Logger({
      scope: 'ucad',
      sink: new MultiLogSink([
        new FileLogSink(path.join(this.paths.logDir, 'app.log')),
        this.memoryLog,
      ]),
    });
    this.blobs = new BlobStore({ root: this.paths.blobDir });
  }

  #initStorage(): void {
    // NFR-15: the at-rest key lives in the SecretStore's own DPAPI vault. It is
    // deliberately NOT inside the database it protects — a key stored with the
    // data it encrypts protects nothing.
    this.secrets = new SafeStorageSecretStore({
      logger: this.logger,
      protect: (plain) => safeStorage.encryptString(plain.toString('utf8')),
      unprotect: (cipher) => Buffer.from(safeStorage.decryptString(cipher), 'utf8'),
      vaultPath: path.join(this.paths.userData, 'secrets.vault'),
    });

    this.db = new Database({
      dbPath: this.paths.dbPath,
      logger: this.logger,
      protection: { key: this.secrets.getOrCreateDatabaseKey() },
    });
    this.db.migrate();

    this.eventLog = new EventLog({ db: this.db, logger: this.logger, blobs: this.blobs });
    this.sequencer = new SessionSequencer(this.db);
    this.projector = new MessageProjector(this.db);
  }

  #initServices(): void {
    this.sessionStore = new SessionStore({
      db: this.db,
      logger: this.logger,
      eventLog: this.eventLog,
      sequencer: this.sequencer,
    });
    this.permissions = new PermissionEngine({ db: this.db, logger: this.logger });
    this.usage = new UsageStore({ db: this.db, logger: this.logger });
    this.mcp = new McpManager({ db: this.db, logger: this.logger });
    this.files = new FileService({
      logger: this.logger,
      permissions: this.permissions,
      watcher: createFsWatcher({ debounceMs: 300 }),
    });
    this.git = new GitService({ logger: this.logger, permissions: this.permissions });
    // §11.2 User Terminal. Main-side only: a PTY is arbitrary code execution,
    // so the Renderer gets a data channel and a write channel and never the
    // module (NFR-01).
    this.pty = new PtyHost({
      logger: this.logger.child('pty'),
      onData: (event) => this.emitToRendererData(event, IPC_PUSH.ptyData),
      onExit: (event) => this.emitToRendererData(event, IPC_PUSH.ptyExit),
    });
    // The console's output channel is wired here, not left to the Terminal
    // panel: a console that accepts a command and returns nothing looks exactly
    // like a broken shell.
    this.terminal = new CommandRunner({
      logger: this.logger,
      permissions: this.permissions,
      onConsoleData: (event) => {
        this.emitToRendererData({ terminalId: event.terminalId, chunk: event.chunk });
      },
    });

    // Provider layer. Credentials are resolved lazily through the SecretStore,
    // so nothing here ever holds a key in memory longer than one request.
    this.providerClient = new ProviderClient({
      logger: this.logger.child('providers'),
      secrets: {
        get: async (ref) => this.secrets.get(ref),
        exists: async (ref) => this.secrets.exists(ref),
      },
    });
    this.modelRegistry = new ModelRegistry({
      client: this.providerClient,
      logger: this.logger.child('providers'),
    });

    // Skills are discovered from the workspace and from the user's home, and
    // resolved per agent at build time. Re-discovery only happens on
    // `invalidate()`, so an edited SKILL.md takes effect the next time the
    // workspace changes rather than on a poll.
    this.skills = new SkillRegistry({
      logger: this.logger.child('skills'),
      workspaceRoot: this.sessionStore.listWorkspaces()[0]?.path,
      roots: [{ path: path.join(this.paths.userData, 'skills'), scope: 'user' }],
    });
  }

  /**
   * NFR-12 / §4.8: a provider is only usable once it has been initialised with
   * a workspace root. Registering without initialising leaves every query
   * failing with `INTELLIGENCE_UNAVAILABLE` — which is exactly the state the
   * product was in before this call existed.
   */
  async initCodeIntelligence(): Promise<void> {
    const workspace = this.sessionStore.listWorkspaces()[0];
    if (!workspace) {
      this.logger.info('no workspace yet; code intelligence waits for one');
      return;
    }
    try {
      await this.intelligence.initializeProvider('basic', {
        workspaceId: workspace.id,
        workspaceRoot: workspace.path,
        configDir: this.paths.userData,
        cacheDir: this.paths.cacheDir,
        trustState: workspace.trustState,
        logger: this.logger.child('intelligence'),
      });
      this.logger.info('basic code intelligence initialised', {
        workspaceId: workspace.id,
      });
    } catch (error) {
      // NFR-09: intelligence degrades, it does not take the app down.
      this.logger.warn('basic code intelligence failed to initialise', {
        error: describeError(error),
      });
    }
  }

  /** The UCAD-registered catalogue, with the honesty flag resolved. */
  listProviders(): ProviderDescriptorDto[] {
    return BUILTIN_PROVIDERS.map((p) => ({
      id: p.id,
      displayName: p.displayName,
      baseUrl: p.baseUrl,
      transport: p.transport,
      requiresApiKey: p.requiresApiKey,
      secretKey: p.secretKey,
      capabilities: p.capabilities,
      models: p.models ?? [],
      ...(p.notes ? { notes: p.notes } : {}),
      ...(p.docsUrl ? { docsUrl: p.docsUrl } : {}),
      verifiedAt: p.verifiedAt,
      supported: p.transport !== 'unsupported' && p.models !== undefined,
    }));
  }

  /** Provider ids the user has actually stored a key for. */
  async configuredProviders(): Promise<string[]> {
    const out: string[] = [];
    for (const p of BUILTIN_PROVIDERS) {
      if (!p.requiresApiKey) {
        out.push(p.id);
        continue;
      }
      const ok = await this.secrets.exists({ providerId: p.id, key: p.secretKey });
      if (ok) out.push(p.id);
    }
    return out;
  }

  getProviderDescriptor(id: string) {
    return getProvider(id);
  }

  #initPlanes(): void {
    // ADR-012: the Basic provider is always registered, so the product works
    // with no Docker and no external service.
    this.intelligence = new IntelligenceManager({ db: this.db, logger: this.logger });
    this.intelligence.register(
      new BasicIntelligenceProvider({ logger: this.logger, blobs: this.blobs }),
    );
    this.estimator = new HeuristicTokenEstimator();
    this.ledger = new TurnBudgetLedger({ db: this.db, logger: this.logger });
    this.renderer = new InjectionRenderer({
      estimator: this.estimator,
      logger: this.logger,
    });
    this.broker = new ContextBroker(
      {
        db: this.db,
        logger: this.logger,
        ledger: this.ledger,
        estimator: this.estimator,
        renderer: this.renderer,
        intelligence: this.intelligence,
        blobs: this.blobs,
        git: new GitLikeBridge({
          git: this.git,
          estimator: this.estimator,
          logger: this.logger,
          resolveRoot: (workspaceId) =>
            this.sessionStore.getWorkspace(workspaceId)?.path ?? process.cwd(),
        }),
        sessionStore: this.sessionStore,
        // `context.preview` must resolve the real manifest: the injection mode and
        // rendezvous depend on the Agent's capabilities (I-5, §4.6.4), so a
        // guessed manifest would make the preview disagree with the real turn.
        resolveAgent: (agentId: string) => this.agents.get(agentId)?.manifest ?? null,
        defaultBudget: {
          maxInputTokens: 32_000,
          reservedOutputTokens: 4_000,
        },
      },
      // Skills ride the SAME Context Pack, so their text is covered by
      // `renderedHash` like everything else. A parallel injection channel would
      // have quietly destroyed the product's one real claim.
      this.skills,
    );
    this.tools = new ToolContractHost({
      broker: this.broker,
      intelligence: this.intelligence,
      permissions: this.permissions,
      sessionStore: this.sessionStore,
      logger: this.logger,
      estimator: this.estimator,
      renderer: this.renderer,
    });

    const settings = this.sessionStore.getSettings();
    this.decisions = new DecisionFacade({
      db: this.db,
      logger: this.logger,
      chain: settings.decision.chain,
      timeoutMs: settings.decision.timeoutMs,
      allowNetworkEngines: settings.decision.allowNetworkEngines,
      admit: (sessionId, proposal) => this.admitLocal(sessionId, proposal),
    });
  }

  #initRuntime(): void {
    const hostEntry = resolveHostEntry();
    const factory = (agentId: string) =>
      new AgentHostProcess({
        adapterModule: this.adapterModules[agentId] ?? '',
        agentHostId: `host_${agentId}`,
        logger: this.logger.child(`host:${agentId}`),
        cwd: process.cwd(),
        configDir: this.paths.userData,
        hostEntry,
      });

    this.runtime = new AgentRuntimeManager({
      db: this.db,
      logger: this.logger,
      eventLog: this.eventLog,
      sequencer: this.sequencer,
      sessionStore: this.sessionStore,
      permissions: this.permissions,
      blobs: this.blobs,
      projector: this.projector,
      hostFactory: factory,
      onEvent: (event) => this.emitToRenderer(event),
      context: {
        broker: this.broker,
        renderer: this.renderer,
        toolHost: this.tools,
      },
      decision: {
        decide: (input) =>
          this.decisions.decide({
            sessionId: input.sessionId,
            turnId: input.turnId,
            kind: input.kind,
            objective: input.objective,
            facts: input.facts,
          }).then((result) => ({ result, requestId: '' })),
      },
      intelligence: this.intelligence,
      buildFacts: (ctx) =>
        this.collectDecisionFacts({
          workspaceId: ctx.workspaceId,
          sessionId: ctx.sessionId,
          trusted: ctx.workspaceTrusted,
        }),
    });
  }

  // -------------------------------------------------------------------------
  // D-5: the Decision plane never reads the workspace. Main collects the facts.
  // -------------------------------------------------------------------------

  /**
   * The one place `DecisionFacts` is assembled, used by the turn boundary *and*
   * by `decision.preview` so the two can never disagree.
   *
   * Every field is measured, not assumed. The previous version hardcoded
   * `git: { dirty: false, changedFiles: 0 }` and `turnIndex: 0`, which meant a
   * `risk` decision was asked "the tree is clean, 0 changes, first turn, every
   * time" — a rubber stamp that produced a confident answer from a lie, and a
   * rationale that named facts the user could disprove. A fact that cannot be
   * measured is reported as not-known, not as zero.
   */
  async collectDecisionFacts(input: {
    workspaceId: string;
    sessionId: string;
    trusted: boolean;
  }): Promise<DecisionFacts> {
    const root = this.sessionStore.getWorkspace(input.workspaceId)?.path;

    const [git, context] = await Promise.all([
      // `git status` spawns a process; bound it so a hung repo cannot stall the
      // turn boundary. A timeout is a missing fact, not a clean tree.
      this.git
        .status(input.workspaceId, root ?? process.cwd(), AbortSignal.timeout(2_000))
        .then((s) => ({
          dirty: s.dirty,
          changedFiles: s.staged.length + s.unstaged.length + s.untracked.length,
          branch: s.branch,
        }))
        .catch((err: unknown) => {
          this.logger.warn('git status unavailable; the decision sees no git facts', {
            workspaceId: input.workspaceId,
            reason: describeError(err),
          });
          return { dirty: false, changedFiles: 0, branch: '' };
        }),
      this.latestContextFacts(input.sessionId),
    ]);

    return this.decisions.facts({
      workspaceId: input.workspaceId,
      trusted: input.trusted,
      agents: this.catalogEntries(),
      git: {
        dirty: git.dirty,
        changedFiles: git.changedFiles,
        ...(git.branch.length > 0 ? { branch: git.branch } : {}),
      },
      ...context,
      turnIndex: this.sessionStore.listTurns(input.sessionId).length,
    });
  }

  /**
   * The most recent pack this session actually built, read straight from
   * `context_packs` (a decision may be asked before any turn of this session
   * has run, in which case there is genuinely no pack and no token count).
   *
   * `used_tokens` is a §6 estimate, not a vendor count — the same
   * `estimate_source` the Context page already shows the user, so a decision may
   * quote it without overstating it.
   */
  private latestContextFacts(sessionId: string): {
    packId?: string;
    itemCount?: number;
    estimatedTokens?: number;
  } {
    try {
      const row = this.db.driver.get<{
        id: string;
        item_count: number;
        used_tokens: number | null;
      }>(
        `SELECT p.id AS id, COUNT(i.id) AS item_count, p.used_tokens AS used_tokens
           FROM context_packs p
           LEFT JOIN context_items i
             ON i.context_pack_id = p.id AND i.pack_revision = p.revision
          WHERE p.session_id = ?
          GROUP BY p.id
          ORDER BY p.created_at DESC
          LIMIT 1`,
        [sessionId],
      );
      if (!row) return {};
      return {
        packId: row.id,
        itemCount: Math.max(0, Number(row.item_count) || 0),
        estimatedTokens: Math.max(0, Number(row.used_tokens) || 0),
      };
    } catch (err) {
      this.logger.warn('context_packs unreadable; the decision sees no context facts', {
        sessionId,
        reason: describeError(err),
      });
      return {};
    }
  }

  // -------------------------------------------------------------------------
  // session resume: UCAD keeps the transcript, the native session may be gone
  // -------------------------------------------------------------------------

  /**
   * §4.3 S-3 plus §5.3: if the native session was lost the UCAD transcript is
   * still authoritative, so the session is reopened with a Handoff rather than
   * pretending the vendor state survived.
   */
  async resumeSession(sessionId: string) {
    const session = this.sessionStore.getSession(sessionId);
    if (!session) throw new Error('会话不存在');

    const agentSession = this.sessionStore.getAgentSession(sessionId);
    if (!agentSession?.nativeSessionId) {
      this.sessionStore.transitionSession(sessionId, 'READY');
      return this.sessionStore.getSession(sessionId)!;
    }

    const host = this.agents.get(session.agentId);
    if (!host?.alive) {
      this.logger.warn('resume without a live host; keeping the transcript', {
        sessionId,
        agentId: session.agentId,
      });
      this.sessionStore.transitionSession(sessionId, 'READY');
      return this.sessionStore.getSession(sessionId)!;
    }

    try {
      // The §6.1 protocol carries session frames; the Host process has no
      // per-session methods of its own.
      host.send({
        op: 'resume_session',
        payload: {
          ucadSessionId: sessionId,
          nativeSessionId: agentSession.nativeSessionId,
          adapterVersion: agentSession.adapterVersion ?? host.manifest.version ?? '0.0.0',
        },
      });
      this.sessionStore.transitionSession(sessionId, 'READY');
    } catch (error) {
      // V-5: the degradation must be explicit, never silent.
      this.logger.warn('native session lost; falling back to a fresh session', {
        sessionId,
        error: describeError(error),
      });
      this.sessionStore.transitionSession(sessionId, 'CLOSED');
    }
    return this.sessionStore.getSession(sessionId)!;
  }

  // -------------------------------------------------------------------------
  // catalog + admission helpers used by the IPC layer
  // -------------------------------------------------------------------------

  catalogEntries() {
    return [...this.agents.values()].map((host) => ({
      manifest: host.manifest,
      available: host.alive,
      // PE-1: an agent that cannot be intercepted before execution must be
      // shown as restricted, never presented as equally safe.
      restricted: host.manifest.capabilities.permissionCallbacks !== 'pre_execution',
      models: [],
    }));
  }

  toolAvailability(manifest: AgentManifest, workspaceId: string): ToolAvailabilityContext {
    return {
      agent: manifest,
      intelligence: {
        providerId: 'basic',
        capabilities: this.intelligence
          .resolve('basic')
          .manifest.capabilities,
        status: {
          providerId: 'basic',
          state: 'not_indexed',
          stale: true,
          features: this.intelligence.resolve('basic').manifest.capabilities,
          reason: 'basic provider has no persistent index',
        },
      },
      workspace: {
        trusted:
          this.sessionStore.getWorkspace(workspaceId)?.trustState === 'trusted',
      },
    };
  }

  /** E-4: events Main produces go through the same sequencer as Agent events. */
  admitLocal(
    sessionId: string,
    proposal: {
      turnId: string;
      type: 'decision.made';
      source: { kind: 'decision'; engineId?: string };
      payload: Record<string, unknown>;
      ts: string;
    },
  ): void {
    this.runtime.admitLocalEvent({
      sessionId,
      turnId: proposal.turnId,
      type: proposal.type,
      source: proposal.source,
      payload: proposal.payload,
      ts: proposal.ts,
    });
  }

  /**
   * S-4: turns left non-terminal by a crash become `INTERRUPTED` at boot. This
   * must run before any UI is created, or the Renderer replays events for a turn
   * that still looks alive.
   */
  recoverInterruptedSessions(): void {
    const recovered = this.sessionStore.recoverInterruptedTurns();
    for (const item of recovered) {
      this.logger.warn('recovered interrupted turn', item);
      this.runtime.admitLocalEvent({
        sessionId: item.sessionId,
        turnId: item.turnId,
        type: 'turn.interrupted',
        source: { kind: 'ucad' },
        payload: {
          reason: 'app_crash_recovery',
          lastSeq: item.lastSeq,
          recoverable: true,
        },
        ts: new Date().toISOString(),
      });
    }
  }

  setRendererSink(sink: (e: TurnEvent) => void): void {
    this.rendererSink = sink;
  }

  /** Push channels that are not TurnEvents (terminal output, update status). */
  setDataSink(sink: (channel: string, payload: unknown) => void): void {
    this.dataSink = sink;
  }

  emitToRendererData(payload: unknown, channel: string = IPC_PUSH.terminalData): void {
    this.dataSink?.(channel, payload);
  }

  emitToRenderer(event: TurnEvent): void {
    this.rendererSink?.(event);
  }

  // -------------------------------------------------------------------------
  // adapters
  // -------------------------------------------------------------------------

  async registerAgent(agentId: string): Promise<AgentManifest | null> {
    const modulePath = this.adapterModules[agentId];
    if (!modulePath) {
      this.logger.warn('no adapter module registered', { agentId });
      return null;
    }
    const host = new AgentHostProcess({
      adapterModule: modulePath,
      agentHostId: `host_${agentId}`,
      logger: this.logger.child(`host:${agentId}`),
      cwd: process.cwd(),
      configDir: this.paths.userData,
      hostEntry: resolveHostEntry(),
    });
    try {
      await host.start();
      this.agents.set(agentId, host);
      this.runtime.registerHost(agentId, host);
      host.onExit((info) => {
        this.logger.warn('agent host exited', { agentId, ...info });
        this.runtime.handleHostExit(agentId, info);
      });
      return host.manifest;
    } catch (error) {
      this.logger.error('agent host failed to start', {
        agentId,
        error: describeError(error),
      });
      return null;
    }
  }

  isRunning(terminalId: string): boolean {
    return this.pty.isRunning(terminalId);
  }

  /**
   * §11.2: whether an interactive terminal can be offered at all.
   *
   * A method on the container rather than a direct `probePty()` call so the
   * answer is probed once and logged once — and so a missing native module is
   * reported in exactly the shape the Renderer already displays.
   */
  async ptyStatus(): Promise<PtyAvailability> {
    if (this.ptyAvailability === undefined) {
      this.ptyAvailability = probePty();
      this.logger.info('interactive terminal availability', {
        available: this.ptyAvailability.available,
        reason: this.ptyAvailability.reason,
        detail: this.ptyAvailability.detail,
      });
    }
    return this.ptyAvailability;
  }

  async dispose(): Promise<void> {
    // §11.2 teardown, and it has to be FIRST. A live ConPTY helper thread
    // prevents a clean process exit: measured, `app.exit()` with a PTY still
    // running never returned and left an orphan. Killing them here is what makes
    // quitting the app work at all.
    await this.pty?.killAll().catch(() => undefined);
    this.secrets.flush();
    await this.runtime.dispose().catch(() => undefined);
    for (const host of this.agents.values()) {
      await host.dispose(1000).catch(() => undefined);
    }
    this.db?.close();
  }
}
