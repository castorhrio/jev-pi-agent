/**
 * `@ucad/agent-core` — §5.1, the Agent Runtime plane.
 *
 * One turn, end to end, in the order the design fixes:
 *
 * ```
 *  ①  turnId allocated synchronously at the sendTurn entry, before any await  (B7)
 *  ②  turns row + first seq + `turn.started`, one transaction                 (SEQ-2)
 *  ③  Decision plane: route / risk, surfaced as a suggestion by default       (D-4)
 *  ④  ContextBroker.build                                                     (§6.1)
 *  ⑤  InjectionRenderer.render -> the plan reaches the adapter byte-identical  (I-3)
 *  ⑥  native session (create/resume) then `send_turn`                         (S-3, §6.1)
 *  ⑦  every `InboundEventProposal` goes through `admit()`                     (E-1/E-4)
 *  ⑧  terminal `turn.completed` / `turn.interrupted`, then budget release     (T-4)
 * ```
 *
 * One Stop cuts three boundaries (NFR-05 / §6.4): the Host turn, the in-flight
 * Intelligence operations and the ContextBroker build/extend.
 */

import { nowIso, sha256Hex } from '@ucad/observability';
import type { Logger } from '@ucad/observability';
import { isTerminalTurnState } from '@ucad/contracts';
import type {
  AgentHostToMain,
  AgentManifest,
  AgentTurnInput,
  AppError,
  ContextBudget,
  ContextInjectionPlan,
  ContextPack,
  DecisionFacts,
  DecisionKind,
  DecisionResult,
  EventSource,
  InboundEventProposal,
  InjectionProfile,
  InterruptedReason,
  ModelDescriptor,
  PermissionDecision,
  PermissionRequest,
  SessionDto,
  SessionState,
  SettingsSnapshot,
  TurnEvent,
  TurnEventType,
  TurnState,
  WorkspaceDto,
} from '@ucad/contracts';
import { EventAdmissionPipeline } from './admission';
import { asAppError, runtimeError } from './error';
import type {
  AgentHostExitInfo,
  AgentHostLike,
  AgentRuntimeManagerOptions,
  HostRegistration,
  HostStatus,
  PendingPermission,
  SendTurnRequest,
  SessionCreatedFrame,
  TurnOutcome,
} from './types';

// ---------------------------------------------------------------------------
// constants & small helpers
// ---------------------------------------------------------------------------

/** NFR-05 §6.4: host cancel grace window. */
const DEFAULT_CANCEL_GRACE_MS = 2000;
/** How long an acked cancel is given to produce its own terminal event. */
const DEFAULT_CANCEL_SETTLE_MS = 300;
const DEFAULT_PERMISSION_TIMEOUT_MS = 120_000;
const DEFAULT_NATIVE_SESSION_TIMEOUT_MS = 10_000;
/** Bounded so a long-lived session cannot grow these maps without limit. */
const MAX_REMEMBERED = 200;

/** Live turn bookkeeping. Never persisted; the `turns` table is the truth. */
interface ActiveTurn {
  turnId: string;
  sessionId: string;
  /** may change once, when `settings.decision.autoRoute` is on (D-4) */
  agentId: string;
  objective: string;
  startedAtMs: number;
  /** NFR-05: aborts the context build and the intelligence work (② + ③) */
  controller: AbortController;
  cancelling: boolean;
  finalised: boolean;
  /** intelligence `operationId`s observed on the admitted stream (§5) */
  intelligenceOps: Set<string>;
  settleTimer?: NodeJS.Timeout;
  resolveOutcome?: (outcome: TurnOutcome) => void;
}

/** Resolves when the Host answers `create_session` / `resume_session` (S-3). */
interface SessionWaiter {
  agentId: string;
  resolve(frame: SessionCreatedFrame): void;
  reject(err: Error): void;
  timer: NodeJS.Timeout;
}

/** §4.6.4 profile, used only when no `InjectionRenderer` is injected (I-5). */
function fallbackProfile(manifest: AgentManifest): InjectionProfile {
  const modes = manifest.capabilities.injectionModes;
  const mode: InjectionProfile['mode'] =
    modes.includes('prompt_prefix') ? 'prompt_prefix' : (modes[0] ?? 'prompt_prefix');
  return {
    agentId: manifest.id,
    mode,
    rendezvous: 'system_prompt',
    includeItemIds: true,
    includeFreshness: true,
    maxIndexEntries: 40,
    includeFullSlices: mode === 'prompt_prefix',
  };
}

/** The injection plan for a turn that ran without a Context plane. */
function emptyPlan(turnId: string, manifest: AgentManifest): ContextInjectionPlan {
  return {
    turnId,
    packId: 'pack_none',
    packRevision: 0,
    profile: fallbackProfile(manifest),
    rendered: '',
    renderedHash: sha256Hex(''),
    index: [],
    omitted: [],
    estTokens: 0,
    estimateSource: 'heuristic_chars_div_4',
  };
}

/** Reads an `operationId` out of an admitted intelligence payload, defensively. */
function readOperationId(payload: unknown): string | null {
  if (payload === null || typeof payload !== 'object') return null;
  const value = (payload as { operationId?: unknown }).operationId;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function firstOf<T>(iterable: IterableIterator<T>): T | undefined {
  const next = iterable.next();
  return next.done === true ? undefined : next.value;
}

// ---------------------------------------------------------------------------
// the manager
// ---------------------------------------------------------------------------

export class AgentRuntimeManager {
  private readonly opts: AgentRuntimeManagerOptions;
  private readonly log: Logger;
  private readonly pipeline: EventAdmissionPipeline;

  private readonly hosts = new Map<string, HostRegistration>();
  private readonly activeBySession = new Map<string, ActiveTurn>();
  private readonly activeByTurn = new Map<string, ActiveTurn>();
  private readonly outcomes = new Map<string, TurnOutcome>();
  private readonly outcomeOrder: string[] = [];
  private readonly sessionWaiters = new Map<string, SessionWaiter>();
  private readonly pendingPermissions = new Map<string, PendingPermission>();
  private readonly permissionDecisions = new Map<string, PermissionDecision>();
  private readonly deliveredPermissions = new Set<string>();

  private disposed = false;
  private modelCatalogWarned = false;

  constructor(opts: AgentRuntimeManagerOptions) {
    this.opts = opts;
    this.log = opts.logger.child('agent-core');
    this.pipeline = new EventAdmissionPipeline({
      db: opts.db,
      logger: opts.logger,
      eventLog: opts.eventLog,
      sequencer: opts.sequencer,
      sessionStore: opts.sessionStore,
      ...(opts.projector !== undefined ? { projector: opts.projector } : {}),
      ...(opts.deltaCoalescing !== undefined
        ? { deltaCoalescing: opts.deltaCoalescing }
        : {}),
      blobs: opts.blobs,
      onEvent: opts.onEvent,
    });
  }

  // =========================================================================
  // hosts (§7.1)
  // =========================================================================

  registerHost(agentId: string, host: AgentHostLike): void {
    const previous = this.hosts.get(agentId);
    if (previous !== undefined) this.unwire(previous);
    this.hosts.set(agentId, this.wire(agentId, host));
    this.log.info('host registered', { agentId, alive: host.alive });
  }

  listHosts(): HostStatus[] {
    return [...this.hosts.values()].map((registration) => ({
      agentId: registration.agentId,
      alive: registration.host.alive,
      manifest: registration.host.manifest,
    }));
  }

  /**
   * §4.1.1 `AgentAdapter.listModels`. The §6.1 protocol carries no
   * `list_models` frame, so the Desktop injects the catalogue (it owns the
   * provider registry). No live host, no catalogue, or a failing catalogue all
   * yield `[]` — never a throw into the UI.
   */
  async listModels(agentId: string): Promise<ModelDescriptor[]> {
    const registration = this.hosts.get(agentId);
    if (registration === undefined || !registration.host.alive) {
      this.log.debug('listModels: no live host for this agent', { agentId });
      return [];
    }
    if (this.opts.modelCatalog === undefined) {
      if (!this.modelCatalogWarned) {
        this.modelCatalogWarned = true;
        this.log.warn(
          'listModels returns [] until a model catalogue is injected: §6.1 has no list_models frame',
          { agentId },
        );
      }
      return [];
    }
    try {
      const models = await this.opts.modelCatalog(agentId);
      return Array.isArray(models) ? models : [];
    } catch (err) {
      this.log.warn('model catalogue lookup failed', { agentId, reason: asAppError(err).message });
      return [];
    }
  }

  // =========================================================================
  // §5.1 the turn lifecycle
  // =========================================================================

  /**
   * §5.1 ①→⑧.
   *
   * The promise resolves once the Host has been handed `send_turn`; the rest of
   * the turn is reported through the admitted event stream. It rejects when the
   * turn could not be started at all (no context, no native session, dead host)
   * — and in that case a terminal event has already been emitted.
   */
  async sendTurn(input: SendTurnRequest): Promise<{ turnId: string }> {
    // ① + ② — synchronous: no `await` has run yet. That is the whole point of
    // B7. `BuildContextInput.turnId` and `context_packs.turn_id` must not depend
    // on each other, so `turnId` exists before anything asynchronous starts.
    const rec = this.beginTurn(input);
    return await this.runTurn(rec, input);
  }

  /** ① + ②. Allocates the id, persists the turn, admits `turn.started` at seq 1. */
  private beginTurn(input: SendTurnRequest): ActiveTurn {
    if (this.disposed) {
      throw runtimeError('UNKNOWN', 'the agent runtime is disposed', 'agent');
    }
    const session = this.requireSession(input.sessionId);
    this.assertSessionCanStartTurn(session);

    const agentId = input.override?.agentId ?? input.agentId;

    // SEQ-2: `SessionStore.beginTurn` allocates the turnId, inserts the row and
    // allocates seq 1; `turn.started` reuses that very number, so the first
    // event of a session carries seq 1 and the allocation and the write share
    // one transaction.
    const begun = this.pipeline.transaction(() => {
      const started = this.opts.sessionStore.beginTurn({
        sessionId: input.sessionId,
        objective: input.objective,
      });
      const admitted = this.admitLocalEvent({
        sessionId: input.sessionId,
        turnId: started.turnId,
        type: 'turn.started',
        source: { kind: 'agent', agentId },
        payload: { objective: input.objective },
        ts: nowIso(),
        seq: started.seq,
      });
      if (admitted === null) {
        throw runtimeError('STORAGE_ERROR', `could not admit turn.started for ${started.turnId}`, 'storage', {
          turnId: started.turnId,
        });
      }
      return { turnId: started.turnId, seq: started.seq };
    });

    const rec: ActiveTurn = {
      turnId: begun.turnId,
      sessionId: input.sessionId,
      agentId,
      objective: input.objective,
      startedAtMs: Date.now(),
      controller: new AbortController(),
      cancelling: false,
      finalised: false,
      intelligenceOps: new Set(),
    };
    this.activeBySession.set(input.sessionId, rec);
    this.activeByTurn.set(rec.turnId, rec);
    this.transitionSessionSafe(input.sessionId, 'RUNNING');
    this.transitionTurnSafe(rec.turnId, 'RUNNING');
    this.log.info('turn started', {
      turnId: rec.turnId,
      sessionId: rec.sessionId,
      agentId: rec.agentId,
      seq: begun.seq,
    });
    return rec;
  }

  /** ③ → ⑧. Everything that has to await lives here. */
  private async runTurn(rec: ActiveTurn, input: SendTurnRequest): Promise<{ turnId: string }> {
    try {
      const settings = this.opts.sessionStore.getSettings();
      const session = this.requireSession(rec.sessionId);
      const workspace = this.opts.sessionStore.getWorkspace(session.workspaceId);
      if (workspace === null) {
        throw runtimeError(
          'UNKNOWN',
          `workspace ${session.workspaceId} of session ${session.id} no longer exists`,
          'agent',
          { sessionId: session.id },
        );
      }

      // ③ Decision plane. Never fatal: a decision failure degrades the turn.
      await this.runDecisionPhase(rec, input, { workspace, settings });

      const host = await this.ensureHost(rec.agentId);
      const manifest = host.manifest;

      // ④ Context.
      const pack = await this.buildPack(rec, input, settings, session, manifest);

      // ⑤ Render. I-3: the renderer's bytes are the adapter's bytes.
      const plan = this.renderPlan(rec, pack, manifest);

      if (input.beforeInject !== undefined && pack !== null) {
        const gate = await input.beforeInject(pack, plan);
        if (!gate.continue) {
          this.admitLocalEvent({
            sessionId: rec.sessionId,
            turnId: rec.turnId,
            type: 'warning',
            source: { kind: 'ucad' },
            payload: {
              code: 'INJECTION_DECLINED',
              message: 'the turn was abandoned before injection',
              detail: gate.reason ?? null,
            },
            ts: nowIso(),
          });
          this.admitLocalEvent({
            sessionId: rec.sessionId,
            turnId: rec.turnId,
            type: 'turn.completed',
            source: { kind: 'ucad' },
            payload: { status: 'cancelled', durationMs: this.elapsedMs(rec) },
            ts: nowIso(),
          });
          this.finalise(rec, 'CANCELLED', { status: 'cancelled' });
          return { turnId: rec.turnId };
        }
      }

      if (pack !== null) this.admitContextPackBuilt(rec, pack, plan);

      // ⑥ S-3: create or resume the native session, then keep the ids apart.
      await this.ensureNativeSession(rec, { host, session, workspace, settings, input, manifest });

      // ⑥ §6.1 `send_turn`.
      host.send({ op: 'send_turn', payload: this.buildTurnInput(rec, input, plan, manifest, settings) });
      this.log.info('turn dispatched', { turnId: rec.turnId, agentId: rec.agentId });
      return { turnId: rec.turnId };
    } catch (err) {
      this.failBeforeDispatch(rec, err);
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // ③ decision plane
  // -------------------------------------------------------------------------

  private async runDecisionPhase(
    rec: ActiveTurn,
    input: SendTurnRequest,
    ctx: { workspace: WorkspaceDto; settings: SettingsSnapshot },
  ): Promise<void> {
    if (this.opts.decision === undefined) return;

    // D-4: an explicit choice always beats a route suggestion.
    if (input.override?.agentId === undefined) {
      const route = await this.runOneDecision(rec, 'route', input.objective, ctx);
      const suggested = route !== null && route.outcome.kind === 'route' ? route.outcome.agentId : null;
      if (suggested !== null && suggested !== '' && suggested !== rec.agentId) {
        if (ctx.settings.decision.autoRoute) {
          this.log.info('autoRoute selected another agent', {
            turnId: rec.turnId,
            from: rec.agentId,
            to: suggested,
          });
          rec.agentId = suggested;
        } else {
          // V1 default: the suggestion is surfaced through `decision.made`; the
          // agent is NOT switched behind the user's back.
          this.log.info('route suggestion recorded but not applied (D-4)', {
            turnId: rec.turnId,
            current: rec.agentId,
            suggested,
          });
        }
      }
    }

    const runRisk = this.opts.runRiskDecision ?? ctx.settings.agent.permissionMode !== 'read_only';
    if (runRisk) await this.runOneDecision(rec, 'risk', input.objective, ctx);
  }

  /** Runs one decision, persists the rationale (NFR-16) and admits the event. */
  private async runOneDecision(
    rec: ActiveTurn,
    kind: DecisionKind,
    objective: string,
    ctx: { workspace: WorkspaceDto; settings: SettingsSnapshot },
  ): Promise<DecisionResult | null> {
    const service = this.opts.decision;
    if (service === undefined) return null;
    const trusted = ctx.workspace.trustState === 'trusted';
    // Collected facts must be real: a `risk` decision that always sees a clean
    // tree is not a decision, it is a rubber stamp. A collector that throws
    // falls back to the all-zero set and says so, rather than feeding a
    // half-truth in.
    let facts: DecisionFacts;
    try {
      facts = this.opts.buildFacts
        ? await this.opts.buildFacts({
            sessionId: rec.sessionId,
            turnId: rec.turnId,
            workspaceId: ctx.workspace.id,
            workspaceTrusted: trusted,
          })
        : this.defaultFacts(ctx.workspace.id, trusted);
    } catch (err) {
      this.log.warn('buildFacts failed; falling back to all-zero facts', {
        turnId: rec.turnId,
        kind,
        reason: asAppError(err).message,
      });
      facts = this.defaultFacts(ctx.workspace.id, trusted);
    }

    let envelope: { result: DecisionResult; requestId: string };
    try {
      envelope = await service.decide({
        sessionId: rec.sessionId,
        turnId: rec.turnId,
        kind,
        objective,
        facts,
        timeoutMs: ctx.settings.decision.timeoutMs,
        signal: rec.controller.signal,
      });
    } catch (err) {
      this.log.warn('decision engine failed; the turn continues without it', {
        turnId: rec.turnId,
        kind,
        reason: asAppError(err).message,
      });
      return null;
    }

    const result = envelope.result;
    const requestId = envelope.requestId !== '' ? envelope.requestId : result.requestId;

    // NFR-16: a decision without a persisted rationale is not auditable.
    try {
      this.opts.sessionStore.recordDecision({
        sessionId: rec.sessionId,
        turnId: rec.turnId,
        requestId,
        kind,
        outcome: result.outcome,
        confidence: result.confidence,
        rationale: result.rationale,
        engineId: result.producedBy.engineId,
        engineVersion: result.producedBy.version,
        fallback: result.fallback,
        latencyMs: result.latencyMs,
      });
    } catch (err) {
      this.log.warn('decision record could not be persisted', {
        turnId: rec.turnId,
        kind,
        reason: asAppError(err).message,
      });
    }

    // E-4: Main's own event, admitted through the same sequencer.
    this.admitLocalEvent({
      sessionId: rec.sessionId,
      turnId: rec.turnId,
      type: 'decision.made',
      source: { kind: 'decision', engineId: result.producedBy.engineId },
      payload: {
        requestId,
        kind,
        outcome: result.outcome,
        confidence: result.confidence,
        rationale: result.rationale,
        engineId: result.producedBy.engineId,
        fallback: result.fallback,
      },
      ts: nowIso(),
    });
    return result;
  }

  // -------------------------------------------------------------------------
  // ④ ⑤ context & injection
  // -------------------------------------------------------------------------

  /** ④ §6.1 deterministic context build. */
  private async buildPack(
    rec: ActiveTurn,
    input: SendTurnRequest,
    settings: SettingsSnapshot,
    session: SessionDto,
    manifest: AgentManifest,
  ): Promise<ContextPack | null> {
    const context = this.opts.context;
    if (context === undefined) {
      // E-3: a missing plane is reported, never silently skipped.
      this.admitLocalEvent({
        sessionId: rec.sessionId,
        turnId: rec.turnId,
        type: 'warning',
        source: { kind: 'context' },
        payload: {
          code: 'CONTEXT_PLANE_UNAVAILABLE',
          message: 'no ContextBroker is injected; the turn runs with an empty injection plan',
          detail: null,
        },
        ts: nowIso(),
      });
      return null;
    }
    const budget: ContextBudget = settings.context.budget;
    return await context.broker.build(
      {
        workspaceId: session.workspaceId,
        sessionId: session.id,
        // §5.1 ① — already allocated, so `context_packs.turn_id` resolves.
        turnId: rec.turnId,
        objective: input.objective,
        agent: manifest,
        budget,
        strategy: settings.context.strategy,
        // NFR-05 boundary 3
        signal: rec.controller.signal,
      },
      rec.controller.signal,
    );
  }

  /** ⑤ NFR-13 / I-3. The plan is never post-processed. */
  private renderPlan(
    rec: ActiveTurn,
    pack: ContextPack | null,
    manifest: AgentManifest,
  ): ContextInjectionPlan {
    const context = this.opts.context;
    if (context === undefined || pack === null) return emptyPlan(rec.turnId, manifest);

    let profile = fallbackProfile(manifest);
    let warning: string | undefined;
    if (context.renderer.resolveProfile !== undefined) {
      // I-5: an unsupported mode falls back to `prompt_prefix`, with a warning.
      const resolved = context.renderer.resolveProfile(manifest);
      profile = resolved.profile;
      warning = resolved.warning;
    } else if (context.renderer.defaultProfile !== undefined) {
      profile = context.renderer.defaultProfile(manifest);
    }
    if (warning !== undefined) {
      this.admitLocalEvent({
        sessionId: rec.sessionId,
        turnId: rec.turnId,
        type: 'warning',
        source: { kind: 'context' },
        payload: {
          code: 'INJECTION_MODE_FALLBACK',
          message: warning,
          detail: { mode: profile.mode },
        },
        ts: nowIso(),
      });
    }
    // I-3: returned exactly as rendered. No trimming, no re-encoding, no merge.
    return context.renderer.render(pack, profile);
  }

  /** E-4: Main's own event, same sequencer as the agent's. */
  private admitContextPackBuilt(rec: ActiveTurn, pack: ContextPack, plan: ContextInjectionPlan): void {
    this.admitLocalEvent({
      sessionId: rec.sessionId,
      turnId: rec.turnId,
      type: 'context.pack.built',
      source: { kind: 'context' },
      payload: {
        packId: pack.id,
        revision: pack.revision,
        strategy: pack.strategy,
        strategyReason: pack.strategyReason,
        itemCount: pack.items.length,
        omittedCount: pack.omitted.length,
        estimatedTokens: plan.estTokens,
        estimateSource: plan.estimateSource,
        renderedHash: plan.renderedHash,
        injectionMode: plan.profile.mode,
      },
      ts: pack.createdAt,
    });
  }

  // -------------------------------------------------------------------------
  // ⑥ S-3 native session
  // -------------------------------------------------------------------------

  private async ensureNativeSession(
    rec: ActiveTurn,
    ctx: {
      host: AgentHostLike;
      session: SessionDto;
      workspace: WorkspaceDto;
      settings: SettingsSnapshot;
      input: SendTurnRequest;
      manifest: AgentManifest;
    },
  ): Promise<void> {
    const { host, session, workspace, settings, input, manifest } = ctx;
    const existing = this.opts.sessionStore.getAgentSession(session.id);
    const resumable =
      existing !== null &&
      existing.nativeSessionId !== null &&
      existing.adapterId === manifest.id &&
      manifest.capabilities.sessionResume;

    const waiter = this.armSessionWaiter(session.id, rec.agentId);
    try {
      if (resumable && existing.nativeSessionId !== null) {
        host.send({
          op: 'resume_session',
          payload: {
            ucadSessionId: session.id,
            nativeSessionId: existing.nativeSessionId,
            adapterVersion: existing.adapterVersion ?? manifest.version ?? 'unknown',
          },
        });
      } else {
        host.send({
          op: 'create_session',
          payload: {
            ucadSessionId: session.id,
            workspaceId: session.workspaceId,
            workspaceRoot: workspace.path,
            providerId: input.providerId ?? session.providerId,
            modelId: input.modelId ?? session.modelId,
            // §8.1 has no per-session permission column; Settings holds the mode.
            permissionMode: settings.agent.permissionMode,
            trustState: workspace.trustState,
          },
        });
      }

      const frame = await waiter.promise;

      // S-3: this mapping is what makes `resumeSession` possible later, and it
      // is the only place the native id is ever persisted.
      this.opts.sessionStore.recordAgentSession({
        sessionId: session.id,
        adapterId: manifest.id,
        adapterVersion: frame.adapterVersion ?? manifest.version,
        nativeSessionId: frame.nativeSessionId,
        capabilities: manifest.capabilities,
      });
      this.opts.sessionStore.setAgentSessionStatus(session.id, 'active');

      this.admitLocalEvent({
        sessionId: session.id,
        turnId: rec.turnId,
        type: 'session.started',
        source: { kind: 'agent', agentId: manifest.id },
        payload: {
          agentId: manifest.id,
          nativeSessionId: frame.nativeSessionId,
          adapterVersion: frame.adapterVersion ?? manifest.version,
          resumed: frame.resumed,
        },
        ts: nowIso(),
      });
      this.log.info('native session bound', {
        sessionId: session.id,
        turnId: rec.turnId,
        adapterId: manifest.id,
        resumed: frame.resumed,
        hasNativeId: frame.nativeSessionId !== undefined,
      });
    } finally {
      this.disarmSessionWaiter(session.id);
    }
  }

  private armSessionWaiter(sessionId: string, agentId: string): { promise: Promise<SessionCreatedFrame> } {
    let resolveFn: (frame: SessionCreatedFrame) => void = () => undefined;
    let rejectFn: (err: Error) => void = () => undefined;
    const promise = new Promise<SessionCreatedFrame>((res, rej) => {
      resolveFn = res;
      rejectFn = rej;
    });
    const timeout = this.opts.nativeSessionTimeoutMs ?? DEFAULT_NATIVE_SESSION_TIMEOUT_MS;
    const timer = setTimeout(() => {
      this.sessionWaiters.delete(sessionId);
      rejectFn(
        runtimeError(
          'AGENT_START_FAILED',
          `the host did not answer create_session/resume_session for ${sessionId} within ${timeout}ms`,
          'agent',
          { sessionId },
        ),
      );
    }, timeout);
    timer.unref?.();
    this.sessionWaiters.set(sessionId, { agentId, resolve: resolveFn, reject: rejectFn, timer });
    return { promise };
  }

  private disarmSessionWaiter(sessionId: string): void {
    const waiter = this.sessionWaiters.get(sessionId);
    if (waiter === undefined) return;
    clearTimeout(waiter.timer);
    this.sessionWaiters.delete(sessionId);
  }

  private buildTurnInput(
    rec: ActiveTurn,
    input: SendTurnRequest,
    plan: ContextInjectionPlan,
    manifest: AgentManifest,
    settings: SettingsSnapshot,
  ): AgentTurnInput {
    const payload: AgentTurnInput = {
      turnId: rec.turnId,
      objective: input.objective,
      // I-3: byte-identical to the renderer's output. Never post-processed.
      injection: plan,
      permissionMode: settings.agent.permissionMode,
    };
    const toolContract = this.opts.context?.toolHost?.bindingFor(manifest);
    if (toolContract !== undefined) payload.toolContract = toolContract;
    if (input.attachments !== undefined) payload.attachments = input.attachments;
    return payload;
  }

  // -------------------------------------------------------------------------
  // ⑦ the proposal stream
  // -------------------------------------------------------------------------

  private onHostMessage(agentId: string, msg: AgentHostToMain): void {
    try {
      switch (msg.op) {
        case 'event':
          this.onProposal(agentId, msg.payload);
          break;
        case 'session_created':
          this.onSessionCreated(msg.payload);
          break;
        case 'permission_request':
          void this.onHostPermissionRequest(agentId, msg.payload);
          break;
        case 'adapter_error':
          this.onAdapterError(agentId, msg.payload);
          break;
        case 'health':
          this.log.debug('host health', {
            agentId,
            rssBytes: msg.payload.rssBytes ?? null,
            activeTurnId: msg.payload.activeTurnId ?? null,
          });
          break;
        case 'ready':
        case 'exited':
          // `exited` is delivered through onExit; `ready` is consumed by start().
          break;
        default:
          // E-3: an op this Main does not know is reported, not swallowed.
          this.log.warn('unknown host frame op', { agentId });
          break;
      }
    } catch (err) {
      this.log.error('host message handling failed', { agentId, reason: asAppError(err).message });
    }
  }

  private onProposal(agentId: string, proposal: InboundEventProposal): void {
    const rec = this.activeByTurn.get(proposal.turnId);
    if (rec === undefined) {
      this.log.warn('proposal for a turn that is not active', {
        agentId,
        turnId: proposal.turnId,
        type: proposal.type,
        hostSeq: proposal.hostSeq,
      });
      // E-3: never a silent drop. The owning session is resolved read-only
      // through `Database.driver` (§0) so the warning lands in the transcript.
      const sessionId = this.findSessionOfTurn(proposal.turnId);
      if (sessionId !== null) {
        this.admitLocalEvent({
          sessionId,
          turnId: proposal.turnId,
          type: 'warning',
          source: { kind: 'agent', agentId, nativeType: proposal.source.nativeType },
          payload: {
            code: 'PROPOSAL_WITHOUT_ACTIVE_TURN',
            message: 'a proposal arrived for a turn this Main is not running',
            detail: { type: proposal.type, hostSeq: proposal.hostSeq },
          },
          ts: proposal.ts,
        });
      }
      return;
    }
    if (rec.finalised) {
      this.log.debug('proposal after the terminal event; ignored', {
        turnId: rec.turnId,
        type: proposal.type,
        hostSeq: proposal.hostSeq,
      });
      return;
    }

    const source: EventSource = {
      kind: 'agent',
      agentId: proposal.source.agentId ?? agentId,
      ...(proposal.source.providerId !== undefined ? { providerId: proposal.source.providerId } : {}),
      ...(proposal.source.nativeType !== undefined ? { nativeType: proposal.source.nativeType } : {}),
    };

    // E-1 / E-4: the Host proposes, Main allocates.
    const admitted = this.pipeline.admit({
      sessionId: rec.sessionId,
      turnId: proposal.turnId,
      type: proposal.type,
      source,
      payload: proposal.payload,
      ts: proposal.ts,
    });
    if (!admitted.ok) {
      this.log.warn('host proposal was not admitted', {
        turnId: rec.turnId,
        type: proposal.type,
        reason: admitted.reason,
      });
      return;
    }
    this.afterAdmitted(rec, admitted.event);
  }

  /** What an admitted event changes about the turn. */
  private afterAdmitted(rec: ActiveTurn, event: TurnEvent): void {
    if (event.type === 'turn.completed') {
      const status = event.payload.status;
      const state: TurnState =
        status === 'completed' ? 'COMPLETED' : status === 'failed' ? 'FAILED' : 'CANCELLED';
      this.finalise(rec, state, { status });
      return;
    }
    if (event.type === 'turn.interrupted') {
      this.finalise(rec, 'INTERRUPTED', { reason: event.payload.reason });
      return;
    }
    if (event.type.startsWith('intelligence.')) {
      // NFR-05 boundary 2 bookkeeping: remember the work so Stop can cancel it
      // even if it ignores the AbortSignal.
      const operationId = readOperationId(event.payload);
      if (operationId !== null) rec.intelligenceOps.add(operationId);
      return;
    }
    // E-5: `reasoning.delta` is only ever admitted when the vendor produced one.
    // This package never synthesises reasoning.
  }

  private onSessionCreated(frame: SessionCreatedFrame): void {
    const waiter = this.sessionWaiters.get(frame.ucadSessionId);
    if (waiter === undefined) {
      this.log.debug('session_created for a session that is not waiting', {
        ucadSessionId: frame.ucadSessionId,
      });
      return;
    }
    clearTimeout(waiter.timer);
    this.sessionWaiters.delete(frame.ucadSessionId);
    waiter.resolve(frame);
  }

  private onAdapterError(agentId: string, error: AppError): void {
    for (const rec of this.activeByTurn.values()) {
      if (rec.agentId !== agentId) continue;
      this.admitLocalEvent({
        sessionId: rec.sessionId,
        turnId: rec.turnId,
        type: 'error',
        source: { kind: 'agent', agentId },
        payload: {
          code: error.code,
          message: error.message,
          retryable: error.retryable,
          component: 'agent',
        },
        ts: nowIso(),
      });
      return;
    }
    this.log.error('adapter error with no active turn', { agentId, code: error.code });
  }

  // -------------------------------------------------------------------------
  // NFR-05 §6.4 cancellation — three boundaries, one Stop
  // -------------------------------------------------------------------------

  async cancelTurn(sessionId: string, reason?: string): Promise<void> {
    const rec = this.activeBySession.get(sessionId);
    if (rec === undefined) {
      this.log.warn('cancel requested for a session with no active turn', { sessionId });
      return;
    }
    if (rec.cancelling) {
      this.log.debug('cancel already in flight', { turnId: rec.turnId, sessionId });
      return;
    }
    rec.cancelling = true;
    const grace = this.opts.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS;

    // Boundaries 2 + 3: one controller aborts the in-flight intelligence work
    // and the ContextBroker build/extend.
    this.abortIntelligence(rec);
    rec.controller.abort();

    this.transitionTurnSafe(rec.turnId, 'CANCELLING');
    this.transitionSessionSafe(sessionId, 'CANCELLING');

    // Boundary 1: the Host.
    const registration = this.hosts.get(rec.agentId);
    let outcome: 'acked' | 'killed';
    try {
      outcome =
        registration !== undefined && registration.host.alive
          ? await registration.host.cancelTurn(rec.turnId, reason, grace)
          : 'killed';
    } catch (err) {
      this.log.error('host cancel failed; escalating to a kill', {
        turnId: rec.turnId,
        reason: asAppError(err).message,
      });
      outcome = 'killed';
    }

    if (outcome === 'acked') {
      this.log.info('cancel acknowledged by the host', { turnId: rec.turnId, sessionId });
      this.settleCancelledTurn(rec);
      return;
    }

    // Escalation (§6.4): no ack inside the grace window => dispose the host and
    // close the turn as INTERRUPTED / user_stop_timeout.
    await this.disposeHost(rec.agentId);
    this.interruptTurn(rec, 'user_stop_timeout');
  }

  /**
   * An acked cancel is contractually followed by the adapter's own
   * `turn.completed{status:'cancelled'}` (§7.2). The settle window guarantees a
   * terminal event even when a vendor adapter stays silent.
   */
  private settleCancelledTurn(rec: ActiveTurn): void {
    if (rec.finalised) return;
    const settle = this.opts.cancelSettleMs ?? DEFAULT_CANCEL_SETTLE_MS;
    rec.settleTimer = setTimeout(() => {
      if (rec.finalised) return;
      this.admitLocalEvent({
        sessionId: rec.sessionId,
        turnId: rec.turnId,
        type: 'turn.completed',
        source: { kind: 'agent', agentId: rec.agentId },
        payload: { status: 'cancelled', durationMs: this.elapsedMs(rec) },
        ts: nowIso(),
      });
      this.finalise(rec, 'CANCELLED', { status: 'cancelled' });
    }, settle);
    rec.settleTimer.unref?.();
  }

  /** NFR-05 boundary 2: AbortSignal plus an explicit cancel per live operation. */
  private abortIntelligence(rec: ActiveTurn): void {
    const manager = this.opts.intelligence;
    if (manager === undefined) return;
    for (const operationId of rec.intelligenceOps) {
      void manager.cancel(operationId).catch((err: unknown) => {
        this.log.warn('intelligence cancel failed', {
          turnId: rec.turnId,
          operationId,
          reason: asAppError(err).message,
        });
      });
    }
  }

  // -------------------------------------------------------------------------
  // permissions (§4.9, M26)
  // -------------------------------------------------------------------------

  /**
   * §4.9: deterministic policy first (D-3), then the user. Resolves to the
   * effective decision; an unanswered request **rejects** rather than allowing.
   */
  async requestPermission(request: PermissionRequest): Promise<boolean> {
    const session = this.opts.sessionStore.getSession(request.sessionId);
    const workspace =
      session === null ? null : this.opts.sessionStore.getWorkspace(session.workspaceId);
    const workspaceId = session?.workspaceId ?? '';
    const mode = this.opts.sessionStore.getSettings().agent.permissionMode;
    const rec = this.activeByTurn.get(request.turnId);

    let decision: PermissionDecision;
    let decider: 'user' | 'policy';
    try {
      const evaluation = this.opts.permissions.evaluate({
        request,
        sessionPermissionMode: mode,
        workspaceId,
        sessionId: request.sessionId,
        workspaceTrusted: workspace?.trustState === 'trusted',
      });
      if (evaluation.outcome === 'ask_user') {
        this.markWaiting(rec, 'WAITING_PERMISSION');
        this.admitLocalEvent({
          sessionId: request.sessionId,
          turnId: request.turnId,
          type: 'permission.requested',
          source: { kind: 'agent', agentId: request.agentId },
          payload: { requestId: request.id, request },
          ts: nowIso(),
        });
        decision = await this.awaitUserDecision(request);
        decider = 'user';
        this.markWaiting(rec, 'RUNNING');
      } else {
        decision = evaluation.decision ?? (evaluation.outcome === 'auto_allow' ? 'allow_once' : 'deny');
        decider = 'policy';
      }
    } catch (err) {
      // Fail closed: the trail records the denial and the caller still gets the
      // real reason (a permission timeout must not be swallowed).
      this.recordAudit(request, 'deny', 'policy');
      this.rememberDecision(request.id, 'deny');
      this.admitPermissionResolved(request, 'deny', 'policy');
      throw err;
    }

    this.persistAllowRule(request, decision, workspaceId);
    this.recordAudit(request, decision, decider);
    this.rememberDecision(request.id, decision);
    this.admitPermissionResolved(request, decision, decider);
    return decision !== 'deny';
  }

  /** Renderer-facing entry point (§8). A late or unknown id is a warning. */
  async respondToPermission(requestId: string, decision: PermissionDecision): Promise<void> {
    const entry = this.pendingPermissions.get(requestId);
    if (entry === undefined) {
      this.log.warn('permission response for an unknown or expired request', { requestId });
      return;
    }
    this.pendingPermissions.delete(requestId);
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    entry.resolve(decision);
    this.deliverPermissionResponse(requestId, decision, entry.agentId);
  }

  private awaitUserDecision(request: PermissionRequest): Promise<PermissionDecision> {
    const timeout = this.opts.permissionTimeoutMs ?? DEFAULT_PERMISSION_TIMEOUT_MS;
    return new Promise<PermissionDecision>((resolve, reject) => {
      const entry: PendingPermission = {
        requestId: request.id,
        sessionId: request.sessionId,
        turnId: request.turnId,
        agentId: request.agentId,
        resolve: (value) => resolve(value as PermissionDecision),
        reject,
      };
      entry.timer = setTimeout(() => {
        this.pendingPermissions.delete(request.id);
        reject(
          runtimeError(
            'PERMISSION_DENIED',
            `permission request ${request.id} was not answered within ${timeout}ms`,
            'agent',
            { requestId: request.id },
          ),
        );
      }, timeout);
      entry.timer.unref?.();
      this.pendingPermissions.set(request.id, entry);
    });
  }

  /** A Host asked for permission: run the engine, then answer the frame (M26). */
  private async onHostPermissionRequest(agentId: string, request: PermissionRequest): Promise<void> {
    let decision: PermissionDecision = 'deny';
    try {
      const allowed = await this.requestPermission(request);
      decision = allowed ? (this.permissionDecisions.get(request.id) ?? 'allow_once') : 'deny';
    } catch (err) {
      this.log.warn('permission request failed; the host is told to deny', {
        requestId: request.id,
        reason: asAppError(err).message,
      });
      decision = 'deny';
    } finally {
      this.deliverPermissionResponse(request.id, decision, agentId);
    }
  }

  /** §6.1 `permission_response`, sent at most once per request id. */
  private deliverPermissionResponse(
    requestId: string,
    fallback: PermissionDecision,
    agentId: string,
  ): void {
    if (this.deliveredPermissions.has(requestId)) return;
    this.deliveredPermissions.add(requestId);
    const oldest = firstOf(this.deliveredPermissions.values());
    if (oldest !== undefined && this.deliveredPermissions.size > MAX_REMEMBERED) {
      this.deliveredPermissions.delete(oldest);
    }
    const decision = this.permissionDecisions.get(requestId) ?? fallback;
    this.permissionDecisions.delete(requestId);
    const registration = this.hosts.get(agentId);
    if (registration === undefined || !registration.host.alive) {
      this.log.debug('permission response had no live host to forward to', { requestId });
      return;
    }
    registration.host.send({ op: 'permission_response', payload: { requestId, decision } });
  }

  private rememberDecision(requestId: string, decision: PermissionDecision): void {
    this.permissionDecisions.set(requestId, decision);
    const oldest = firstOf(this.permissionDecisions.keys());
    if (oldest !== undefined && this.permissionDecisions.size > MAX_REMEMBERED) {
      this.permissionDecisions.delete(oldest);
    }
  }

  private admitPermissionResolved(
    request: PermissionRequest,
    decision: PermissionDecision,
    decider: 'user' | 'policy',
  ): void {
    this.admitLocalEvent({
      sessionId: request.sessionId,
      turnId: request.turnId,
      type: 'permission.resolved',
      source: { kind: 'agent', agentId: request.agentId },
      payload: { requestId: request.id, decision, decider },
      ts: nowIso(),
    });
  }

  private recordAudit(
    request: PermissionRequest,
    decision: PermissionDecision,
    decider: 'user' | 'policy',
  ): void {
    try {
      this.opts.permissions.recordAudit({
        requestId: request.id,
        sessionId: request.sessionId,
        turnId: request.turnId,
        category: request.category,
        risk: request.risk,
        resource: request.resource,
        command: request.command,
        decision,
        decider,
      });
    } catch (err) {
      this.log.warn('permission audit could not be written', {
        requestId: request.id,
        reason: asAppError(err).message,
      });
    }
  }

  /** `allow_session` / `allow_workspace` only mean something once persisted. */
  private persistAllowRule(
    request: PermissionRequest,
    decision: PermissionDecision,
    workspaceId: string,
  ): void {
    if (decision !== 'allow_session' && decision !== 'allow_workspace') return;
    const subject = request.resource ?? request.command ?? request.mcpToolName;
    // A rule with no subject would be a blanket allow: never invent one.
    if (subject === undefined || subject === '') return;
    try {
      this.opts.permissions.addRule({
        scope: decision === 'allow_session' ? 'session' : 'workspace',
        scopeRef: decision === 'allow_session' ? request.sessionId : workspaceId,
        category: request.category,
        matcher: { kind: 'prefix', value: subject },
        decision,
      });
    } catch (err) {
      this.log.warn('permission rule could not be persisted', {
        requestId: request.id,
        reason: asAppError(err).message,
      });
    }
  }

  private markWaiting(rec: ActiveTurn | undefined, state: 'WAITING_PERMISSION' | 'RUNNING'): void {
    if (rec === undefined || rec.finalised) return;
    this.transitionTurnSafe(rec.turnId, state);
    this.transitionSessionSafe(rec.sessionId, state);
  }

  // -------------------------------------------------------------------------
  // host crash (§8 / S-5)
  // -------------------------------------------------------------------------

  /**
   * A crashed Host must never throw out of here: every active turn on that host
   * becomes `turn.interrupted{reason:'host_exited'}`, the session becomes
   * INTERRUPTED, and S-5 keeps `agent_sessions.status` in step.
   */
  handleHostExit(agentId: string, info: { code: number | null; signal?: string }): void {
    try {
      this.log.warn('agent host exited', { agentId, code: info.code, signal: info.signal ?? null });

      const registration = this.hosts.get(agentId);
      if (registration !== undefined) {
        this.unwire(registration);
        this.hosts.delete(agentId);
      }

      for (const [sessionId, waiter] of [...this.sessionWaiters]) {
        if (waiter.agentId !== agentId) continue;
        clearTimeout(waiter.timer);
        this.sessionWaiters.delete(sessionId);
        waiter.reject(
          runtimeError('PROCESS_EXITED', `the host for ${sessionId} exited`, 'agent', {
            agentId,
            code: info.code,
            signal: info.signal ?? null,
          }),
        );
      }

      for (const rec of [...this.activeByTurn.values()]) {
        if (rec.agentId !== agentId || rec.finalised) continue;
        if (rec.cancelling) {
          // The cancel path owns a turn that is already being stopped; it will
          // emit `user_stop_timeout` or close it as CANCELLED.
          this.log.debug('host exited during an in-flight cancel', { turnId: rec.turnId });
          continue;
        }
        try {
          this.interruptTurn(rec, 'host_exited');
        } catch (err) {
          this.log.error('could not close a turn after a host exit', {
            turnId: rec.turnId,
            reason: asAppError(err).message,
          });
        }
      }
    } catch (err) {
      this.log.error('handleHostExit failed', { agentId, reason: asAppError(err).message });
    }
  }

  /** Admit the terminal event first, so `lastSeq` describes the pre-crash run. */
  private interruptTurn(rec: ActiveTurn, reason: InterruptedReason): void {
    if (rec.finalised) return;
    const lastSeq = this.opts.eventLog.latestSeq(rec.sessionId);
    this.admitLocalEvent({
      sessionId: rec.sessionId,
      turnId: rec.turnId,
      type: 'turn.interrupted',
      source: { kind: 'agent', agentId: rec.agentId },
      payload: { reason, lastSeq, recoverable: true },
      ts: nowIso(),
    });
    this.finalise(rec, 'INTERRUPTED', { reason });
  }

  // -------------------------------------------------------------------------
  // §8 public surface
  // -------------------------------------------------------------------------

  /**
   * Reusable admission entry point for Main's own events. The app container
   * calls this at boot for `turn.interrupted{reason:'app_crash_recovery'}`.
   */
  admitLocalEvent(input: {
    sessionId: string;
    turnId: string;
    type: TurnEventType;
    source: EventSource;
    payload: unknown;
    ts?: string;
    seq?: number;
  }): TurnEvent | null {
    const result = this.pipeline.admit({
      sessionId: input.sessionId,
      turnId: input.turnId,
      type: input.type,
      source: input.source,
      payload: input.payload,
      ...(input.ts !== undefined ? { ts: input.ts } : {}),
      ...(input.seq !== undefined ? { seq: input.seq } : {}),
    });
    if (!result.ok) {
      this.log.warn('local event was not admitted', {
        sessionId: input.sessionId,
        turnId: input.turnId,
        type: input.type,
        reason: result.reason,
      });
      return null;
    }
    return result.event;
  }

  /** Resolves once a turn reaches a terminal state. Never rejects. */
  waitForTurn(turnId: string, timeoutMs?: number): Promise<TurnOutcome> {
    const known = this.outcomes.get(turnId);
    if (known !== undefined) return Promise.resolve(known);
    const rec = this.activeByTurn.get(turnId);
    if (rec === undefined) {
      return Promise.reject(
        runtimeError('UNKNOWN', `turn ${turnId} is not active in this runtime`, 'agent', { turnId }),
      );
    }
    return new Promise<TurnOutcome>((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const previous = rec.resolveOutcome;
      rec.resolveOutcome = (outcome) => {
        if (timer !== undefined) clearTimeout(timer);
        previous?.(outcome);
        resolve(outcome);
      };
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          resolve({
            turnId,
            sessionId: rec.sessionId,
            state: 'RUNNING',
            lastSeq: this.opts.eventLog.latestSeq(rec.sessionId),
          });
        }, timeoutMs);
        timer.unref?.();
      }
    });
  }

  /** Idempotent turn shutdown: state machines, ledger release, bookkeeping. */
  private finalise(
    rec: ActiveTurn,
    state: TurnState,
    opts: { status?: 'completed' | 'failed' | 'cancelled'; reason?: InterruptedReason } = {},
  ): TurnOutcome {
    if (rec.finalised) {
      return (
        this.outcomes.get(rec.turnId) ?? {
          turnId: rec.turnId,
          sessionId: rec.sessionId,
          state,
          lastSeq: this.opts.eventLog.latestSeq(rec.sessionId),
        }
      );
    }
    rec.finalised = true;
    if (rec.settleTimer !== undefined) clearTimeout(rec.settleTimer);
    // Releases the context build and any intelligence work still in flight.
    rec.controller.abort();

    this.transitionTurnSafe(rec.turnId, state, opts.reason);
    this.closeSession(rec, state, opts.reason);

    this.activeBySession.delete(rec.sessionId);
    this.activeByTurn.delete(rec.turnId);
    void this.releaseBudget(rec.turnId);

    const outcome: TurnOutcome = {
      turnId: rec.turnId,
      sessionId: rec.sessionId,
      state,
      lastSeq: this.opts.eventLog.latestSeq(rec.sessionId),
    };
    if (opts.status !== undefined) outcome.status = opts.status;
    if (opts.reason !== undefined) outcome.reason = opts.reason;
    this.remember(rec.turnId, outcome);
    rec.resolveOutcome?.(outcome);
    this.log.info('turn finalised', {
      turnId: rec.turnId,
      sessionId: rec.sessionId,
      state,
      lastSeq: outcome.lastSeq,
      terminal: isTerminalTurnState(state),
    });
    return outcome;
  }

  /** S-5: the session and its agent session always move together. */
  private closeSession(rec: ActiveTurn, state: TurnState, reason: InterruptedReason | undefined): void {
    try {
      if (state === 'INTERRUPTED') {
        this.opts.sessionStore.markSessionInterrupted(rec.sessionId, reason ?? 'host_exited');
        this.opts.sessionStore.setAgentSessionStatus(rec.sessionId, 'interrupted');
      } else {
        this.opts.sessionStore.transitionSession(rec.sessionId, 'READY');
      }
    } catch (err) {
      this.log.warn('session could not be closed', {
        sessionId: rec.sessionId,
        state,
        reason: asAppError(err).message,
      });
    }
  }

  private failBeforeDispatch(rec: ActiveTurn, err: unknown): void {
    if (rec.finalised) return;
    const error = asAppError(err, 'agent');
    this.admitLocalEvent({
      sessionId: rec.sessionId,
      turnId: rec.turnId,
      type: 'error',
      source: { kind: 'agent', agentId: rec.agentId },
      payload: {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        component: 'agent',
      },
      ts: nowIso(),
    });
    if (rec.cancelling) {
      this.finalise(rec, 'CANCELLED', { status: 'cancelled' });
      return;
    }
    this.admitLocalEvent({
      sessionId: rec.sessionId,
      turnId: rec.turnId,
      type: 'turn.completed',
      source: { kind: 'agent', agentId: rec.agentId },
      payload: { status: 'failed', durationMs: this.elapsedMs(rec) },
      ts: nowIso(),
    });
    this.finalise(rec, 'FAILED', { status: 'failed' });
  }

  private async releaseBudget(turnId: string): Promise<void> {
    const context = this.opts.context;
    if (context === undefined) return;
    try {
      await context.broker.release({ turnId });
    } catch (err) {
      this.log.warn('turn budget ledger was not released', {
        turnId,
        reason: asAppError(err).message,
      });
    }
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  private requireSession(sessionId: string): SessionDto {
    const session = this.opts.sessionStore.getSession(sessionId);
    if (session === null) {
      throw runtimeError('UNKNOWN', `unknown session ${sessionId}`, 'agent', { sessionId });
    }
    return session;
  }

  private assertSessionCanStartTurn(session: SessionDto): void {
    // S-1: one active turn per session in V1. Rejected loudly, never queued.
    const active = this.activeBySession.get(session.id);
    if (active !== undefined) {
      throw runtimeError(
        'UNKNOWN',
        `session ${session.id} already runs turn ${active.turnId}; §4.3 S-1 allows one active turn per session`,
        'agent',
        { sessionId: session.id, turnId: active.turnId },
      );
    }
    if (session.status === 'CLOSED') {
      throw runtimeError('UNKNOWN', `session ${session.id} is CLOSED`, 'agent', {
        sessionId: session.id,
      });
    }
    if (
      session.status === 'RUNNING' ||
      session.status === 'WAITING_PERMISSION' ||
      session.status === 'CANCELLING'
    ) {
      throw runtimeError(
        'UNKNOWN',
        `session ${session.id} is ${session.status}; a second turn is not allowed in V1 (§4.3 S-1)`,
        'agent',
        { sessionId: session.id, status: session.status },
      );
    }
    // CREATED -> READY, and INTERRUPTED / FAILED recover to READY (§4.3).
    if (session.status !== 'READY') this.transitionSessionSafe(session.id, 'READY');
  }

  private wire(agentId: string, host: AgentHostLike): HostRegistration {
    const onMessage = host.onMessage((msg) => {
      this.onHostMessage(agentId, msg);
    });
    const onExit = host.onExit((info: AgentHostExitInfo) => {
      this.handleHostExit(agentId, info);
    });
    return { agentId, host, unsubscribes: [onMessage, onExit] };
  }

  private unwire(registration: HostRegistration): void {
    for (const off of registration.unsubscribes) {
      try {
        off();
      } catch {
        this.log.debug('unsubscribe threw', { agentId: registration.agentId });
      }
    }
    registration.unsubscribes.length = 0;
  }

  private async ensureHost(agentId: string): Promise<AgentHostLike> {
    const existing = this.hosts.get(agentId);
    if (existing !== undefined) {
      if (existing.host.alive) return existing.host;
      this.unwire(existing);
      this.hosts.delete(agentId);
    }
    let host: AgentHostLike;
    try {
      host = this.opts.hostFactory(agentId);
    } catch (err) {
      throw runtimeError('ADAPTER_NOT_AVAILABLE', `no host could be created for ${agentId}`, 'agent', {
        agentId,
        reason: asAppError(err).message,
      });
    }
    this.hosts.set(agentId, this.wire(agentId, host));
    try {
      await host.start();
    } catch (err) {
      this.unwire({ agentId, host, unsubscribes: [] });
      this.hosts.delete(agentId);
      throw runtimeError('AGENT_START_FAILED', `the host for ${agentId} failed to start`, 'agent', {
        agentId,
        reason: asAppError(err).message,
      });
    }
    this.log.info('host started', { agentId, kind: host.manifest.kind });
    return host;
  }

  private async disposeHost(agentId: string): Promise<void> {
    const registration = this.hosts.get(agentId);
    if (registration === undefined) return;
    // Unsubscribe first: `dispose()` makes the Host exit, and this manager must
    // not mistake its own escalation for a crash.
    this.unwire(registration);
    this.hosts.delete(agentId);
    try {
      await registration.host.dispose();
    } catch (err) {
      this.log.warn('host dispose failed', { agentId, reason: asAppError(err).message });
    }
  }

  /** Read-only lookup through `Database.driver` (§0). */
  private findSessionOfTurn(turnId: string): string | null {
    try {
      const row = this.opts.db.driver.get<{ session_id?: unknown }>(
        'SELECT session_id FROM turns WHERE id = ?',
        [turnId],
      );
      const value = row?.['session_id'];
      return typeof value === 'string' && value !== '' ? value : null;
    } catch (err) {
      this.log.debug('turn lookup failed', { turnId, reason: asAppError(err).message });
      return null;
    }
  }

  private defaultFacts(workspaceId: string, trusted: boolean): DecisionFacts {
    return {
      workspace: { id: workspaceId, trusted, languageHints: [] },
      availableAgents: this.listHosts().map((entry) => ({
        id: entry.manifest.id,
        kind: entry.manifest.kind,
        isDefaultRuntime: entry.manifest.isDefaultRuntime,
        capabilities: {
          streaming: entry.manifest.capabilities.streaming,
          modelSelection: entry.manifest.capabilities.modelSelection,
          usageReporting: entry.manifest.capabilities.usageReporting,
        },
      })),
      availableModels: [],
      git: { dirty: false, changedFiles: 0 },
      context: { itemCount: 0, estimatedTokens: 0, freshness: 'unknown' },
      signals: { consecutiveFailures: 0, permissionDenials: 0, elapsedMs: 0, turnIndex: 0 },
    };
  }

  private transitionSessionSafe(sessionId: string, to: SessionState): void {
    try {
      this.opts.sessionStore.transitionSession(sessionId, to);
    } catch (err) {
      this.log.warn('session transition refused', { sessionId, to, reason: asAppError(err).message });
    }
  }

  private transitionTurnSafe(turnId: string, to: TurnState, reason?: InterruptedReason): void {
    try {
      this.opts.sessionStore.transitionTurn(turnId, to, reason !== undefined ? { reason } : {});
    } catch (err) {
      this.log.warn('turn transition refused', { turnId, to, reason });
    }
  }

  private elapsedMs(rec: ActiveTurn): number {
    return Math.max(0, Date.now() - rec.startedAtMs);
  }

  private remember(turnId: string, outcome: TurnOutcome): void {
    this.outcomes.set(turnId, outcome);
    this.outcomeOrder.push(turnId);
    while (this.outcomeOrder.length > MAX_REMEMBERED) {
      const oldest = this.outcomeOrder.shift();
      if (oldest !== undefined) this.outcomes.delete(oldest);
    }
  }

  /** Idempotent; never throws. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const rec of [...this.activeByTurn.values()]) {
      try {
        rec.controller.abort();
      } catch {
        this.log.debug('abort failed during dispose', { turnId: rec.turnId });
      }
    }
    for (const [sessionId, waiter] of [...this.sessionWaiters]) {
      clearTimeout(waiter.timer);
      this.sessionWaiters.delete(sessionId);
      waiter.reject(runtimeError('UNKNOWN', 'the agent runtime is disposing', 'agent', { sessionId }));
    }
    for (const [requestId, entry] of [...this.pendingPermissions]) {
      this.pendingPermissions.delete(requestId);
      if (entry.timer !== undefined) clearTimeout(entry.timer);
      entry.reject(
        runtimeError('PERMISSION_DENIED', 'the agent runtime is disposing', 'agent', { requestId }),
      );
    }
    for (const [agentId, registration] of [...this.hosts]) {
      this.unwire(registration);
      this.hosts.delete(agentId);
      try {
        await registration.host.dispose();
      } catch {
        this.log.warn('host dispose failed during shutdown', { agentId });
      }
    }
    this.activeBySession.clear();
    this.activeByTurn.clear();
    // §8.2: a clean shutdown must not lose a delta window. A crash may lose at
    // most one; this is the boundary that makes even that avoidable.
    this.pipeline.shutdown();
    this.log.info('agent runtime disposed');
  }
}
