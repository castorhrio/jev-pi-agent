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
import type { RetentionServiceOptions } from '@ucad/session';
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
import { JevDecisionEngine } from '@ucad/decision';
import { AgentHostProcess, resolveHostEntry } from '@ucad/agent-host';
import { BUILTIN_PROVIDERS, ModelRegistry, ProviderClient, getProvider } from '@ucad/providers';
import { SkillRegistry, defaultSkillRoots } from '@ucad/skills';
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
  WorkspaceActivationDto,
} from '@ucad/contracts';
import { IPC_PUSH, codedError, describeError } from '@ucad/contracts';
import type { AppPaths } from './paths';
import { DecisionFacade } from './decision-facade';
import { GitLikeBridge } from './git-bridge';
import {
  WorkspaceActivator,
  toWorkspaceActivationDto,
  type WorkspaceActivationOutcome,
} from './workspace-activation';

export interface UcadAppOptions {
  paths: AppPaths;
  /** compiled adapter entry points, keyed by adapter id */
  adapterModules?: Record<string, string>;
}

/**
 * The mark a checked field carries.
 *
 * `requireStarted()` is the only thing that hands one out, so a dependency
 * that reaches a service without passing the guard is a compile error rather
 * than a runtime surprise: `eventLog: this.eventLog` does not type-check
 * where a `Started<…>` is expected, and
 * `eventLog: this.requireStarted('eventLog', this.eventLog)` does.
 *
 * The mark is a fiction the type system believes — at runtime the field is
 * the same object it always was.
 *
 * **Scope.** The guard protects the dependencies of lazily built services
 * (today only `retentionDeps()`). It is deliberately not a blanket wrapper
 * around every `!` field: callers of the other subsystems only exist after
 * `start()`. Those fields are covered at runtime instead: the scanner in
 * `tests/contract/app-container-started.test.ts` requires every `field!: T`
 * to be on its checklist and to be non-null after a real `start()`. Adding a
 * field to the guard's scope therefore means widening `retentionDeps()`, not
 * assuming this mark already reaches it.
 */
const STARTED = Symbol('ucad.container.started');

/** A field `requireStarted()` has vouched for. */
type Started<T> = T & { readonly [STARTED]: true };

/**
 * The container's field names, as a type.
 *
 * Every list of container fields is written against this, so a name that is
 * not a field — a rename that was not carried through, a typo — does not
 * compile instead of being discovered at runtime. `RETENTION_DEPENDENCIES`
 * below is one such list; the scan-and-run contract test's checklist is the
 * other, declared `satisfies readonly ContainerField[]`.
 *
 * The two lists are not enforced by the same gate, and that is worth knowing
 * when reading the test. This file is part of
 * `apps/desktop/tsconfig.main.json`, so a bad name on
 * `RETENTION_DEPENDENCIES` fails `npm run typecheck`. `tests/` belongs to no
 * tsc project (the contract suite carries pre-existing type errors), so for
 * the test's checklist the `satisfies` is an editor/on-demand check and the
 * runtime assertions are what CI actually runs.
 */
export type ContainerField = keyof UcadApp;

/**
 * The container fields the retention service is built from (§8.4).
 *
 * The list is the contract, and it is deliberately the *only* place the names
 * are written down:
 *
 *  - it is checked against the container (`keyof UcadApp`), so a name on it
 *    that is not a real field does not compile;
 *  - the bag below is typed by it, so a name on it has to be supplied — and
 *    supplied *through the guard*, because the bag holds `Started<…>` values;
 *  - the contract test walks it one field at a time, so a field the guard
 *    forgot is a test that fails.
 */
export const RETENTION_DEPENDENCIES = [
  'db',
  'sessionStore',
  'blobs',
  'logger',
] as const satisfies readonly ContainerField[];

/**
 * The bag the retention service is built from: one *checked* field per name
 * on the list.
 *
 * If the service gains a dependency, `retentionDeps()` stops satisfying the
 * service's own options until the dependency is on the list above — and until
 * it goes through `requireStarted()`. A dependency nobody checks is a
 * dependency that reaches a subsystem as `undefined`.
 */
type RetentionDeps = {
  readonly [F in (typeof RETENTION_DEPENDENCIES)[number]]: Started<UcadApp[F]>;
};

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
  /** §8.4 retention and cleanup — one instance, see `getRetention()`. */
  get retention(): RetentionService {
    return this.getRetention();
  }
  private retentionService: RetentionService | null = null;
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
  /** the workspace the user is currently working in; set by `activateWorkspace` */
  private activeWorkspaceId: string | undefined;
  /** serialises activation so the *last* request is the one in force */
  private workspaceActivator: WorkspaceActivator | null = null;

  constructor(opts: UcadAppOptions) {
    this.paths = opts.paths;
    this.adapterModules = opts.adapterModules ?? {};
  }

  get encryptionEnabled(): boolean {
    return this.db.isProtected();
  }

  /**
   * The one retention service (§8.4).
   *
   * It used to be built twice: once here, and once inside the storage IPC
   * layer, which lazily created its own on first use. Two instances are two
   * views of the same database, and the two views can disagree — a purge that
   * ran in one and a retention sweep that ran in the other would each believe
   * they had the last word about what is left on disk. Main owns the
   * instance; everybody else asks for it.
   *
   * A container that has not run `start()` is refused rather than served a
   * service built over `undefined` — see `requireStarted()`.
   */
  getRetention(): RetentionService {
    if (this.retentionService === null) {
      // Every dependency is checked, not assumed. The fields are `db!: Database`
      // declarations whose initialisation order is a promise `start()` keeps,
      // so before that call they are `undefined` at runtime while the type
      // system says otherwise. Building the service from them produced a
      // RetentionService over `undefined`: nothing threw, and every later
      // `usage()`/`purge()` failed somewhere inside the storage layer with a
      // message about SQLite rather than about the container. A refusal here
      // names the field and the call that is missing.
      const deps = this.retentionDeps();
      this.retentionService = new RetentionService({
        ...deps,
        logger: deps.logger.child('retention'),
        dbPath: this.paths.dbPath,
      });
    }
    return this.retentionService;
  }

  /**
   * The checked dependency bag the retention service is built from.
   *
   * The return type is the *service's* own dependency set (`dbPath` is the
   * one option the container does not own), so a dependency the service gains
   * does not compile here until this bag supplies it — and the bag only
   * accepts fields that went through `requireStarted()`.
   */
  private retentionDeps(): Omit<RetentionServiceOptions, 'dbPath'> {
    const deps: RetentionDeps = {
      db: this.requireStarted('db', this.db),
      sessionStore: this.requireStarted('sessionStore', this.sessionStore),
      blobs: this.requireStarted('blobs', this.blobs),
      logger: this.requireStarted('logger', this.logger),
    };
    return deps;
  }

  /**
   * A field `start()` is responsible for, refused rather than passed on as
   * `undefined`.
   *
   * Only the dependencies that pass through `retentionDeps()` reach this
   * function. That is intentional — see the scope note on `STARTED` — so this
   * is not the container's general start-up check; the remaining `!` fields
   * are checked by the scan-and-run contract test.
   *
   * The container declares its subsystems as `field!: T` because they are
   * built in order by `start()`; the `!` is a claim, not a guarantee, and any
   * caller that reaches a subsystem before `start()` (a test, a second entry
   * point, a future main-process path that constructs the container early)
   * gets `undefined` with a `Database` type on it. Downstream that becomes a
   * fault report about the wrong layer. The code is `CONTAINER_NOT_STARTED`
   * and the component is `'container'`: the fault is the container's
   * lifecycle, not the storage the caller would have used, and a report that
   * filters on `STORAGE_ERROR` or `component: 'storage'` must not collect it.
   * The message names the field, which is the part a support report needs.
   *
   * `field` is typed as a real field of this class, and the value has to be
   * the field it names: `requireStarted('db', this.sessionStore)` is a type
   * error, and so is a name that is not a field at all. The `Started<…>` the
   * call returns is what makes "this dependency went through the guard" a
   * compile-time fact instead of a comment.
   */
  private requireStarted<K extends keyof UcadApp>(
    field: K,
    value: UcadApp[K] | undefined | null,
  ): Started<UcadApp[K]> {
    if (value === undefined || value === null) {
      throw codedError(
        'CONTAINER_NOT_STARTED',
        `容器尚未初始化：${field} 在 start() 之前被读取。`,
        'container',
      );
    }
    // The mark is added here and nowhere else. At runtime this is the same
    // object the field always was; the only thing that changed is that it
    // came through this function, and that is exactly what the type system
    // needs to know.
    return value as Started<UcadApp[K]>;
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
    // Built here so the first sweep has one to use — and so it is the same
    // instance the storage IPC layer asks for.
    this.getRetention();
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
    //
    // The roots are the documented convention (`<workspace>/.ucad/skills` and
    // `~/.ucad/skills`) plus the directory next to the app's own database.
    // The workspace half is moved by `activateWorkspace`; it is deliberately
    // *not* pinned to whatever happened to be first at start-up.
    this.skills = new SkillRegistry({
      logger: this.logger.child('skills'),
      roots: defaultSkillRoots(undefined, this.extraSkillRoots()),
    });
  }

  /**
   * The user-scope skill roots UCAD adds on top of the documented ones.
   *
   * The app-local directory sits next to the database, so a skill placed there
   * keeps working across releases instead of disappearing when the documented
   * roots move.
   */
  private extraSkillRoots(): { path: string; scope: 'user' }[] {
    return [{ path: path.join(this.paths.userData, 'skills'), scope: 'user' }];
  }

  /**
   * The one place a workspace becomes "the project we are working on".
   *
   * §4.8 / §4.5: code intelligence and skills are both rooted in the project.
   * A provider that was initialised for project A answers nothing for project
   * B, and a skill registry still pointing at A injects A's rules into B's
   * context. Both used to be pinned once at start-up to whichever project was
   * first in the list, so opening a second project changed the folder in the
   * Explorer and nothing else.
   *
   * Opening, switching and restoring a project all come through here, so
   * there is exactly one answer to "what is this app working on".
   */
  async activateWorkspace(workspaceId: string): Promise<WorkspaceActivationDto> {
    const workspace = this.sessionStore.getWorkspace(workspaceId);
    if (!workspace) {
      throw codedError('WORKSPACE_NOT_FOUND', `项目不存在：${workspaceId}`, 'ipc');
    }
    // Recorded synchronously, before any await, so "which project am I working
    // on" is decided by the last request rather than by whichever activation
    // finishes last. Every workspace-scoped IPC handler reads this value.
    const previous = this.activeWorkspaceId;
    this.activeWorkspaceId = workspace.id;

    let outcome: WorkspaceActivationOutcome;
    try {
      outcome = await this.activator.activate({
        id: workspace.id,
        path: workspace.path,
        trustState: workspace.trustState,
      });
    } catch (error) {
      // Activation threw, so this project never went into force: the skills
      // were not moved (or the queue itself failed). Keeping
      // `activeWorkspaceId` on it would point every workspace-scoped handler —
      // setTrust, MCP upsert, file writes — at a project the activation never
      // reached, which is the split between "what the app works on" and "what
      // the UI shows" this whole path exists to prevent. The previous value is
      // restored instead, and only if a newer request has not already claimed
      // the field: that request is the one in force, and this failure is not
      // its problem.
      if (this.activeWorkspaceId === workspace.id) {
        this.activeWorkspaceId = previous;
      }
      throw error;
    }

    // The answer is the activation's, not the request's: when a newer request
    // took over, this call did not put its project in force, and the Renderer
    // navigates on `id`/`name`. `toWorkspaceActivationDto` names the project
    // that is actually loaded and keeps the requested one beside it.
    const dto = toWorkspaceActivationDto(
      workspace,
      outcome,
      (id) => this.sessionStore.getWorkspace(id) ?? undefined,
    );
    if (dto === null) {
      // The project that took over was removed while this activation was in
      // flight. There is no row to answer with, and the requested project is
      // explicitly *not* the one in force, so naming it would navigate the user
      // to the project whose code and rules were never loaded. Say that instead
      // of guessing.
      throw codedError(
        'WORKSPACE_NOT_FOUND',
        `激活被更新的请求取代，但该项目已不存在：${outcome.supersededBy ?? workspace.id}`,
        'ipc',
      );
    }
    return dto;
  }

  /**
   * The single activation queue (§4.5 / §4.8).
   *
   * Activation is asynchronous and moves two subsystems, so two overlapping
   * requests — opening a project while the previous one is still initialising
   * its provider, or a trust change arriving with a project switch — used to
   * interleave and let the *slower* provider win. The queue makes the later
   * request the one in force; see `WorkspaceActivator`.
   */
  private get activator(): WorkspaceActivator {
    if (this.workspaceActivator === null) {
      this.workspaceActivator = new WorkspaceActivator({
        logger: this.logger,
        intelligence: this.intelligence,
        skills: this.skills,
        configDir: this.paths.userData,
        cacheDir: this.paths.cacheDir,
        providerId: 'basic',
        extraSkillRoots: this.extraSkillRoots(),
      });
    }
    return this.workspaceActivator;
  }

  /**
   * The workspace the user is working in, if there is one.
   *
   * Not "the most recently opened one": that inference is what put a session's
   * file writes and permission requests on somebody else's project.
   */
  get currentWorkspaceId(): string | undefined {
    return this.activeWorkspaceId;
  }

  /**
   * Restores the project the user had open at the last exit.
   *
   * A provider that is registered but not initialised answers every query with
   * `INTELLIGENCE_UNAVAILABLE`, which reads exactly like "code intelligence is
   * broken". Restoring it here means the first turn of the new session already
   * has the project's files.
   */
  async activateMostRecentWorkspace(): Promise<WorkspaceActivationDto | null> {
    const mostRecent = this.sessionStore.listWorkspaces()[0];
    if (!mostRecent) {
      this.logger.info('no workspace yet; code intelligence waits for one');
      return null;
    }
    return this.activateWorkspace(mostRecent.id);
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
      // The engines the user may put in the chain. The rule engine is always
      // present (the facade adds it); `jev` is the second one ADR-016 left room
      // for — it scores `route`/`risk` and abstains when it is not sure, so
      // putting it in front of the rule engine is the user's call to make.
      engines: [new JevDecisionEngine({ logger: this.logger })],
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
      // turn boundary. A timeout is a missing fact, not a clean tree: the catch
      // resolves to `undefined` and `DecisionFacts.git` stays unset, which the
      // engines are required to read as "no signal", never as zeros.
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
          return undefined;
        }),
      this.latestContextFacts(input.sessionId),
    ]);

    return this.decisions.facts({
      workspaceId: input.workspaceId,
      trusted: input.trusted,
      agents: this.catalogEntries(),
      ...(git !== undefined ? { git } : {}),
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
    if (!session) throw codedError('NOT_FOUND', '会话不存在', 'ipc');

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
      // The Host needs the credential the user saved in Settings, and only
      // Main can read the keychain. It asks for a reference over the protocol
      // and Main answers — the key itself is never in the fork's environment,
      // never in the `initialize` payload and never in a log line.
      secretResolver: async (ref) => this.secrets.get(ref),
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
