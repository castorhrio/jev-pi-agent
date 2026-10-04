/**
 * §3 `@ucad/session` — `SessionStore`.
 *
 * Owns `workspaces`, `sessions`, `agent_sessions`, `turns`, `decisions` and
 * `settings`. It reads `events` / `messages` through the
 * `EventLog` and the messages projection, and never writes another package's
 * table.
 *
 * Two invariants dominate the implementation:
 *
 * - **SEQ-1 / §5.1**: `SessionStore` allocates `turnId` (ULID) and persists the
 *   `turns` row inside one transaction, but `seq` is allocated by the injected
 *   `SessionSequencer` in that same transaction. It never computes a sequence
 *   number itself.
 * - **S-4 / S-5**: crash recovery flips a turn to `INTERRUPTED` and always
 *   updates the owning session *and* the owning agent session together.
 */

import { nowIso, ulid } from '@ucad/observability';
import type { Logger } from '@ucad/observability';
import {
  canTransitionSession,
  canTransitionTurn,
  CRASH_RECOVERABLE_TURN_STATES,
  isTerminalTurnState,
} from '@ucad/contracts';
import type {
  AgentSessionState,
  ContextHandoff,
  HandoffRecord,
  HandoffState,
  CreateSessionInput,
  DeepPartial,
  DecisionKind,
  DecisionOutcome,
  DecisionResult,
  InterruptedReason,
  SessionDto,
  SessionState,
  SettingsSnapshot,
  TurnState,
  TrustState,
  WorkspaceDto,
} from '@ucad/contracts';
import type { AppErrorCode } from '@ucad/contracts';
import { describeError, isContextHandoff } from '@ucad/contracts';
import type {
  DatabaseLike,
  EventLogLike,
  SessionSequencerLike,
} from './db-types';
import { fail, SessionError } from './errors';
import { toDecisionRecord, toMessageDto } from './dto';
import type { DecisionRecordDto, MessageDto } from './dto';
import { buildContextHandoff } from './handoff';
import type { HandoffTurn } from './handoff';
import { applySettingsPatch, DEFAULT_SETTINGS, normalizeSettings, SETTINGS_KEY } from './defaults';

/** A blob file the caller must unlink from disk once the rows are gone. */
export type BlobRefToPurge = string;

export interface SessionStoreOptions {
  db: DatabaseLike;
  logger: Logger;
  /**
   * Injected so the store shares the application's single `EventLog` (and
   * therefore its at-rest decryption, §2/§8.4). Required for `createHandoff`
   * and for writing the `turn.interrupted` recovery event.
   */
  eventLog?: EventLogLike;
  /** Injected so `seq` has exactly one allocator (§5.2 SEQ-1). */
  sequencer?: SessionSequencerLike;
}

/** §4.3 S-1: V1 allows one active turn per session. */
const SESSION_STATES_BLOCKING_NEW_TURN: ReadonlyArray<SessionState> = [
  'RUNNING',
  'WAITING_PERMISSION',
  'CANCELLING',
];

/** Session states that must never be overwritten by recovery. */
const SESSION_STATES_FROZEN: ReadonlyArray<SessionState> = ['INTERRUPTED', 'CLOSED'];

const SESSION_COLUMNS =
  'id, workspace_id, title, agent_id, provider_id, model_id, status, handoff_json, created_at, updated_at';

const WORKSPACE_COLUMNS = 'id, path, name, trust_state, created_at, last_opened_at';

const TURN_COLUMNS =
  'id, session_id, status, objective, started_at, completed_at, interrupted_reason, error_code';

const DECISION_COLUMNS =
  'id, session_id, turn_id, request_id, kind, outcome_json, confidence, rationale, engine_id, engine_version, fallback_json, latency_ms, created_at';

type Row = Record<string, unknown>;

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function int(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : 0;
}

function isRecoverable(status: string): boolean {
  return (CRASH_RECOVERABLE_TURN_STATES as ReadonlyArray<string>).includes(status);
}

export class SessionStore {
  private readonly db: DatabaseLike;
  private readonly logger: Logger;
  private readonly eventLog: EventLogLike | undefined;
  private readonly sequencer: SessionSequencerLike | undefined;
  private readonly columnCache = new Map<string, boolean>();

  constructor(opts: SessionStoreOptions) {
    this.db = opts.db;
    this.logger = opts.logger.child('session');
    this.eventLog = opts.eventLog;
    this.sequencer = opts.sequencer;
  }

  // =========================================================================
  // workspaces
  // =========================================================================

  /** `workspaces.path` is UNIQUE, so an existing path is reused (§8.1). */
  upsertWorkspace(input: { path: string; name: string; trustState?: TrustState }): WorkspaceDto {
    const now = nowIso();
    const existing = this.driver.get<Row>(
      `SELECT ${WORKSPACE_COLUMNS} FROM workspaces WHERE path = ?`,
      [input.path],
    );
    if (existing !== undefined) {
      const id = str(existing['id']) ?? '';
      const trust = input.trustState ?? (str(existing['trust_state']) as TrustState | undefined);
      this.driver.run(
        'UPDATE workspaces SET name = ?, trust_state = COALESCE(?, trust_state), last_opened_at = ? WHERE id = ?',
        [input.name, trust ?? null, now, id],
      );
      return this.requireWorkspace(id);
    }
    const id = ulid('ws_');
    this.driver.run(
      `INSERT INTO workspaces (${WORKSPACE_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?)`,
      [id, input.path, input.name, input.trustState ?? 'untrusted', now, now],
    );
    return this.requireWorkspace(id);
  }

  listWorkspaces(): WorkspaceDto[] {
    const rows = this.driver.all<Row>(
      `SELECT ${WORKSPACE_COLUMNS} FROM workspaces
        ORDER BY COALESCE(last_opened_at, created_at) DESC, id ASC`,
    );
    return rows.map((row) => this.toWorkspaceDto(row));
  }

  getWorkspace(id: string): WorkspaceDto | null {
    const row = this.driver.get<Row>(`SELECT ${WORKSPACE_COLUMNS} FROM workspaces WHERE id = ?`, [
      id,
    ]);
    return row === undefined ? null : this.toWorkspaceDto(row);
  }

  setWorkspaceTrust(id: string, state: TrustState): WorkspaceDto {
    this.requireWorkspace(id);
    this.driver.run('UPDATE workspaces SET trust_state = ? WHERE id = ?', [state, id]);
    return this.requireWorkspace(id);
  }

  // =========================================================================
  // sessions
  // =========================================================================

  createSession(input: CreateSessionInput): SessionDto {
    const now = nowIso();
    const id = ulid('ses_');
    this.driver.run(
      `INSERT INTO sessions
         (id, workspace_id, title, agent_id, provider_id, model_id, status, handoff_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'CREATED', NULL, ?, ?)`,
      [
        id,
        input.workspaceId,
        input.title ?? 'New session',
        input.agentId,
        input.providerId ?? null,
        input.modelId ?? null,
        now,
        now,
      ],
    );
    this.logger.info('session created', { sessionId: id, workspaceId: input.workspaceId });
    // `input.permissionMode` has no column in §8.1 and no field on `SessionDto`;
    // the Desktop keeps the per-session mode, Settings holds the default.
    return this.requireSession(id);
  }

  listSessions(workspaceId?: string): SessionDto[] {
    const rows =
      workspaceId === undefined
        ? this.driver.all<Row>(`SELECT ${SESSION_COLUMNS} FROM sessions ORDER BY updated_at DESC, id DESC`)
        : this.driver.all<Row>(
            `SELECT ${SESSION_COLUMNS} FROM sessions WHERE workspace_id = ? ORDER BY updated_at DESC, id DESC`,
            [workspaceId],
          );
    return rows.map((row) => this.toSessionDto(row, this.readLastSeq(row)));
  }

  getSession(id: string): SessionDto | null {
    const row = this.driver.get<Row>(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE id = ?`, [id]);
    return row === undefined ? null : this.toSessionDto(row, this.readLastSeq(row));
  }

  renameSession(id: string, title: string): SessionDto {
    this.requireSession(id);
    this.driver.run('UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?', [
      title,
      nowIso(),
      id,
    ]);
    return this.requireSession(id);
  }

  /**
   * §3 / §12.1 — removes the session and everything that points at it.
   *
   * This used to delete only the four rows this package owns and then translate
   * the resulting foreign-key error into an apology, which meant **deleting any
   * session that had actually done something always failed** — the sidebar's
   * 删除 button was broken for every real session. `PRAGMA foreign_keys = ON`
   * (storage/driver.ts) plus `events.turn_id REFERENCES turns(id)` is what made
   * it a hard failure rather than a leak.
   *
   * The order is children first. Every table below is listed because it carries
   * a `session_id` or a `turn_id` foreign key (storage/migrations.ts); miss one
   * and the delete fails again on the next session, which is exactly how this bug
   * survived. `context_items` is reached through its pack.
   */
  deleteSession(id: string): { events: number; blobs: BlobRefToPurge[] } {
    this.requireSession(id);
    // Collected before the transaction: blob files live on disk, outside SQLite,
    // so the rows that name them disappear with the rest.
    const blobRefs = this.driver.all<{ ref: string }>(
      `SELECT DISTINCT b.ref AS ref FROM blobs b
         JOIN events e ON e.id = b.event_id
        WHERE e.session_id = ?`,
      [id],
    );
    const eventCount =
      this.driver.get<{ n: number }>('SELECT COUNT(*) AS n FROM events WHERE session_id = ?', [id])
        ?.n ?? 0;

    try {
      this.db.transaction(() => {
        // depth 1: rows that point at this session's packs
        this.driver.run(
          `DELETE FROM context_items WHERE context_pack_id IN (SELECT id FROM context_packs WHERE session_id = ?)`,
          [id],
        );
        this.driver.run('DELETE FROM context_packs WHERE session_id = ?', [id]);
        this.driver.run('DELETE FROM permission_audit WHERE session_id = ?', [id]);
        this.driver.run('DELETE FROM tool_calls WHERE session_id = ?', [id]);
        this.driver.run('DELETE FROM file_changes WHERE session_id = ?', [id]);
        this.driver.run('DELETE FROM usage_records WHERE session_id = ?', [id]);
        this.driver.run('DELETE FROM decisions WHERE session_id = ?', [id]);
        // `messages` is derived (§8.3) and `events` is the fact stream (§8.1);
        // both go, and the transcript is rebuildable from events until it isn't.
        this.driver.run('DELETE FROM messages WHERE session_id = ?', [id]);
        this.driver.run('DELETE FROM blobs WHERE event_id IN (SELECT id FROM events WHERE session_id = ?)', [id]);
        this.driver.run('DELETE FROM events WHERE session_id = ?', [id]);
        this.driver.run('DELETE FROM agent_sessions WHERE session_id = ?', [id]);
        this.driver.run('DELETE FROM turns WHERE session_id = ?', [id]);
        this.driver.run('DELETE FROM sessions WHERE id = ?', [id]);
      });
    } catch (error) {
      if (error instanceof SessionError) {
        throw error;
      }
      fail(
        'STORAGE_ERROR',
        `cannot delete session ${id}: ${describeError(error)}`,
        'storage',
        { sessionId: id },
      );
    }
    this.logger.info('session deleted', {
      sessionId: id,
      events: eventCount,
      blobRefs: blobRefs.length,
    });
    return { events: eventCount, blobs: blobRefs.map((r) => r.ref) };
  }

  // =========================================================================
  // turns (§4.3 / §5.1)
  // =========================================================================

  /**
   * §5.1 ③ — allocate `turnId`, persist `turns(status='PENDING')` and let the
   * `SessionSequencer` allocate `seq`, all in one transaction (SEQ-2).
   *
   * §4.3 S-1: a session that is already RUNNING / WAITING_PERMISSION /
   * CANCELLING rejects a new turn (V1 allows one active turn).
   */
  beginTurn(input: { sessionId: string; objective: string }): { turnId: string; seq: number } {
    const session = this.requireSessionRow(input.sessionId);
    const status = str(session['status']) as SessionState | undefined;
    if (status !== undefined && SESSION_STATES_BLOCKING_NEW_TURN.includes(status)) {
      fail(
        'UNKNOWN',
        `session ${input.sessionId} is ${status}; a second turn is not allowed in V1 (§4.3 S-1)`,
        'agent',
        { sessionId: input.sessionId, status },
      );
    }
    if (this.sequencer === undefined) {
      fail(
        'STORAGE_ERROR',
        'SessionStore needs a SessionSequencer to allocate seq (§5.2 SEQ-1); seq is never allocated by the store',
        'storage',
      );
    }
    const sequencer = this.sequencer;
    const turnId = ulid('turn_');
    const now = nowIso();
    return this.db.transaction(() => {
      const seq = sequencer.next(input.sessionId);
      this.driver.run(
        `INSERT INTO turns (${TURN_COLUMNS}) VALUES (?, ?, 'PENDING', ?, ?, NULL, NULL, NULL)`,
        [turnId, input.sessionId, input.objective, now],
      );
      this.driver.run('UPDATE sessions SET updated_at = ? WHERE id = ?', [now, input.sessionId]);
      this.logger.info('turn begun', { sessionId: input.sessionId, turnId, seq });
      return { turnId, seq };
    });
  }

  /** §4.3 — validated with `canTransitionSession`; S-5 also syncs the agent session. */
  transitionSession(id: string, to: SessionState): SessionDto {
    const row = this.requireSessionRow(id);
    const from = str(row['status']) as SessionState | undefined;
    if (from === undefined || !canTransitionSession(from, to)) {
      fail('UNKNOWN', `illegal session transition ${String(from)} -> ${to} (§4.3)`, 'agent', {
        sessionId: id,
        from,
        to,
      });
    }
    this.driver.run('UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?', [
      to,
      nowIso(),
      id,
    ]);
    if (to === 'INTERRUPTED') {
      this.syncAgentSessionToInterrupted(id);
    }
    return this.requireSession(id);
  }

  /** §4.3 — validated with `canTransitionTurn`. */
  transitionTurn(
    id: string,
    to: TurnState,
    opts?: { reason?: InterruptedReason; errorCode?: AppErrorCode },
  ): void {
    const row = this.requireTurnRow(id);
    const from = str(row['status']) as TurnState | undefined;
    if (from === undefined || !canTransitionTurn(from, to)) {
      fail('UNKNOWN', `illegal turn transition ${String(from)} -> ${to} (§4.3)`, 'agent', {
        turnId: id,
        from,
        to,
      });
    }
    const now = nowIso();
    const sets: string[] = ['status = ?'];
    const params: unknown[] = [to];
    if (isTerminalTurnState(to)) {
      sets.push('completed_at = ?');
      params.push(now);
    }
    if (to === 'INTERRUPTED') {
      sets.push('interrupted_reason = ?');
      params.push(opts?.reason ?? 'host_exited');
    }
    if (opts?.errorCode !== undefined) {
      sets.push('error_code = ?');
      params.push(opts.errorCode);
    }
    params.push(id);
    this.driver.run(`UPDATE turns SET ${sets.join(', ')} WHERE id = ?`, params);
  }

  /**
   * §8.1 has no `sessions.last_seq` column, so when storage does not provide
   * one the authoritative value is `MAX(events.seq)`, read through the EventLog.
   * Never throws: a missing column must not break turn admission.
   */
  setSessionLastSeq(id: string, seq: number): void {
    this.requireSession(id);
    if (!this.hasColumn('sessions', 'last_seq')) {
      this.logger.debug('sessions.last_seq is not in the schema; lastSeq stays event-derived', {
        sessionId: id,
        seq,
      });
      return;
    }
    this.driver.run('UPDATE sessions SET last_seq = ?, updated_at = ? WHERE id = ?', [
      seq,
      nowIso(),
      id,
    ]);
  }

  /**
   * Marks the session INTERRUPTED together with its active turns and its agent
   * session (S-5). Returns the session's `lastSeq` so the caller can write a
   * `turn.interrupted` event payload.
   */
  markSessionInterrupted(sessionId: string, reason: InterruptedReason): number {
    this.requireSession(sessionId);
    const now = nowIso();
    return this.db.transaction(() => {
      this.driver.run(
        `UPDATE turns SET status = 'INTERRUPTED', interrupted_reason = ?, completed_at = ?
          WHERE session_id = ? AND status IN (?, ?, ?)`,
        [reason, now, sessionId, ...CRASH_RECOVERABLE_TURN_STATES],
      );
      this.interruptSessionRows(sessionId, now);
      return this.readLastSeq(sessionId);
    });
  }

  /**
   * §4.3 S-4 / §5.3 — boot-time crash recovery.
   *
   * Scans every turn left in a non-terminal state, writes a
   * `turn.interrupted{reason:'app_crash_recovery'}` event (with a `seq` from the
   * sequencer, in the same transaction), marks the turn `INTERRUPTED` and
   * updates the owning session **and** agent session (S-5). Safe on a clean
   * database: returns `[]`, and a second run is a no-op.
   */
  recoverInterruptedTurns(): Array<{ sessionId: string; turnId: string; lastSeq: number }> {
    const rows = this.driver.all<{ id: string; session_id: string }>(
      `SELECT id, session_id FROM turns WHERE status IN (?, ?, ?)
        ORDER BY session_id ASC, started_at ASC, id ASC`,
      [...CRASH_RECOVERABLE_TURN_STATES],
    );
    if (rows.length === 0) {
      return [];
    }

    const bySession = new Map<string, string[]>();
    for (const row of rows) {
      const sessionId = str(row.session_id);
      const turnId = str(row.id);
      if (sessionId === undefined || turnId === undefined) {
        continue;
      }
      const bucket = bySession.get(sessionId);
      if (bucket === undefined) {
        bySession.set(sessionId, [turnId]);
      } else {
        bucket.push(turnId);
      }
    }

    const recovered: Array<{ sessionId: string; turnId: string; lastSeq: number }> = [];
    for (const [sessionId, turnIds] of bySession) {
      const perSession = this.db.transaction(() => {
        const now = nowIso();
        const updated: Array<{ turnId: string; lastSeq: number }> = [];
        for (const turnId of turnIds) {
          const current = this.driver.get<Row>('SELECT status FROM turns WHERE id = ?', [turnId]);
          const status = current === undefined ? undefined : str(current['status']);
          if (status === undefined || !isRecoverable(status)) {
            continue;
          }
          const lastSeq = this.recoverTurn(sessionId, turnId, now);
          this.driver.run(
            `UPDATE turns SET status = 'INTERRUPTED', interrupted_reason = 'app_crash_recovery', completed_at = ?
              WHERE id = ?`,
            [now, turnId],
          );
          updated.push({ turnId, lastSeq });
        }
        if (updated.length > 0) {
          this.interruptSessionRows(sessionId, now);
        }
        return updated;
      });
      for (const entry of perSession) {
        recovered.push({ sessionId, turnId: entry.turnId, lastSeq: entry.lastSeq });
      }
    }

    if (recovered.length > 0) {
      this.logger.warn('recovered interrupted turns after an unclean shutdown', {
        turns: recovered.length,
      });
    }
    return recovered;
  }

  listTurns(
    sessionId: string,
  ): Array<{ id: string; status: TurnState; objective: string; startedAt: string; completedAt: string | null }> {
    const rows = this.driver.all<Row>(
      `SELECT ${TURN_COLUMNS} FROM turns WHERE session_id = ? ORDER BY started_at ASC, id ASC`,
      [sessionId],
    );
    return rows.map((row) => ({
      id: str(row['id']) ?? '',
      status: (str(row['status']) ?? 'PENDING') as TurnState,
      objective: str(row['objective']) ?? '',
      startedAt: str(row['started_at']) ?? '',
      completedAt: str(row['completed_at']) ?? null,
    }));
  }

  // =========================================================================
  // agent sessions (S-3)
  // =========================================================================

  /** S-3: the native id and the UCAD id stay separate for the whole lifetime. */
  recordAgentSession(input: {
    sessionId: string;
    adapterId: string;
    adapterVersion?: string;
    nativeSessionId?: string;
    capabilities: unknown;
  }): void {
    this.requireSession(input.sessionId);
    const existing = this.driver.get<Row>(
      'SELECT id FROM agent_sessions WHERE session_id = ?',
      [input.sessionId],
    );
    const id = str(existing?.['id']) ?? ulid('as_');
    const values = [
      input.nativeSessionId ?? null,
      input.adapterId,
      input.adapterVersion ?? null,
      JSON.stringify(input.capabilities ?? null),
      'active',
    ];
    if (existing !== undefined) {
      this.driver.run(
        `UPDATE agent_sessions
            SET native_session_id = ?, adapter_id = ?, adapter_version = ?,
                resume_capability_json = ?, status = ?
          WHERE id = ?`,
        [...values, id],
      );
      return;
    }
    this.driver.run(
      `INSERT INTO agent_sessions
         (id, session_id, native_session_id, adapter_id, adapter_version, resume_capability_json, status, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, input.sessionId, ...values, null],
    );
  }

  getAgentSession(sessionId: string): {
    adapterId: string;
    adapterVersion: string | null;
    nativeSessionId: string | null;
    capabilities: unknown;
    status: AgentSessionState;
  } | null {
    const row = this.driver.get<Row>(
      `SELECT session_id, native_session_id, adapter_id, adapter_version, resume_capability_json, status
         FROM agent_sessions WHERE session_id = ?`,
      [sessionId],
    );
    if (row === undefined) {
      return null;
    }
    let capabilities: unknown = null;
    const raw = str(row['resume_capability_json']);
    if (raw !== undefined && raw !== '') {
      try {
        capabilities = JSON.parse(raw);
      } catch {
        this.logger.warn('agent_sessions.resume_capability_json is not valid JSON', { sessionId });
      }
    }
    return {
      adapterId: str(row['adapter_id']) ?? '',
      adapterVersion: str(row['adapter_version']) ?? null,
      nativeSessionId: str(row['native_session_id']) ?? null,
      capabilities,
      status: (str(row['status']) ?? 'active') as AgentSessionState,
    };
  }

  setAgentSessionStatus(sessionId: string, status: AgentSessionState): void {
    const result = this.driver.run('UPDATE agent_sessions SET status = ? WHERE session_id = ?', [
      status,
      sessionId,
    ]);
    if (result.changes === 0) {
      this.logger.warn('no agent session row to update', { sessionId, status });
    }
  }

  // =========================================================================
  // decisions (NFR-16)
  // =========================================================================

  /** `decisions.request_id` is UNIQUE, so a re-record updates the row. */
  recordDecision(input: {
    sessionId: string;
    turnId: string;
    requestId: string;
    kind: DecisionKind;
    outcome: DecisionOutcome;
    confidence: number;
    rationale: string;
    engineId: string;
    engineVersion?: string;
    fallback?: DecisionResult['fallback'];
    latencyMs: number;
  }): void {
    this.driver.run(
      `INSERT OR REPLACE INTO decisions (${DECISION_COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        ulid('dec_'),
        input.sessionId,
        input.turnId,
        input.requestId,
        input.kind,
        JSON.stringify(input.outcome),
        input.confidence,
        input.rationale,
        input.engineId,
        input.engineVersion ?? null,
        input.fallback !== undefined ? JSON.stringify(input.fallback) : null,
        Math.max(0, Math.round(input.latencyMs)),
        nowIso(),
      ],
    );
  }

  listDecisions(sessionId: string): DecisionRecordDto[] {
    const rows = this.driver.all<Row>(
      `SELECT ${DECISION_COLUMNS} FROM decisions WHERE session_id = ? ORDER BY created_at ASC, id ASC`,
      [sessionId],
    );
    return rows.map((row) => toDecisionRecord(row));
  }

  // =========================================================================
  // handoff (§4.12.1)
  // =========================================================================

  /**
   * Deterministic replay of `events` + `decisions` + context-pack information.
   * `sessions.handoff_json` is refreshed as an optional cache (§4.12.1); the
   * event stream stays the authority.
   *
   * The result is also **appended** to the session's handoff chain
   * (`createHandoff` → `appendHandoffRecord`), which is what makes
   * supersede-not-delete real: a later handoff points at this one and the
   * earlier one stays readable forever.
   *
   * An unchanged replay does **not** append. The chain records transitions, not
   * polls — a handoff asked for twice in a row with no new events describes the
   * same state, and a chain of identical entries is noise that hides the one
   * entry that actually changed. Comparing the serialised bodies is sound here
   * precisely because `buildContextHandoff` is deterministic.
   */
  createHandoff(sessionId: string): ContextHandoff {
    const sessionRow = this.requireSessionRow(sessionId);
    const events = this.requireEventLog().all(sessionId);
    const handoff = buildContextHandoff({
      session: {
        id: sessionId,
        agentId: str(sessionRow['agent_id']) ?? '',
        status: (str(sessionRow['status']) ?? 'CREATED') as SessionState,
        updatedAt: str(sessionRow['updated_at']) ?? '',
        lastSeq: this.readLastSeq(sessionRow),
      },
      turns: this.handoffTurns(sessionId),
      events,
      decisions: this.listDecisions(sessionId),
      agentSessionStatus: this.getAgentSession(sessionId)?.status ?? null,
    });
    this.appendHandoffRecord(sessionId, handoff);
    this.cacheHandoff(sessionId, handoff);
    return handoff;
  }

  /**
   * The whole chain, newest first.
   *
   * Read-only on purpose. RESEARCH §2 pairs supersede-not-delete with a
   * `restore`; here restore needs no mutation, because an earlier handoff is
   * still a complete, readable description of that point in the session and can
   * be re-injected as-is. Implementing "go back" by truncating the event log
   * would be the destructive option the constraint exists to forbid.
   */
  listHandoffs(sessionId: string): HandoffRecord[] {
    const rows = this.driver.all<Row>(
      'SELECT * FROM handoffs WHERE session_id = ? ORDER BY sequence DESC',
      [sessionId],
    );
    return rows.map((row) => this.toHandoffRecord(row, this.handoffSuccessorIds(sessionId)));
  }

  /** The handoff a new agent would resume from, or null if none was ever made. */
  latestHandoff(sessionId: string): HandoffRecord | null {
    const row = this.driver.get<Row>(
      'SELECT * FROM handoffs WHERE session_id = ? ORDER BY sequence DESC LIMIT 1',
      [sessionId],
    );
    if (row === undefined) return null;
    return this.toHandoffRecord(row, this.handoffSuccessorIds(sessionId));
  }

  /**
   * `open` → `claimed`. The explicit handshake that stops two agents from
   * resuming the same work.
   *
   * Re-claiming by the same agent is idempotent, so a retrying agent does not
   * have to know whether its first call landed. Re-claiming by a *different*
   * agent is refused — that is the case this method exists for.
   */
  claimHandoff(sessionId: string, handoffId: string, agentId: string): HandoffRecord {
    const row = this.requireHandoffRow(sessionId, handoffId);
    const state = str(row['state']) as HandoffState;
    if (state === 'done') {
      fail('STORAGE_ERROR', `handoff ${handoffId} is already done and cannot be claimed`, 'storage');
    }
    const claimedBy = str(row['claimed_by']);
    if (state === 'claimed' && claimedBy !== null && claimedBy !== agentId) {
      fail(
        'STORAGE_ERROR',
        `handoff ${handoffId} is already claimed by ${claimedBy}; ` +
          `refusing to hand the same work to ${agentId}`,
        'storage',
      );
    }
    if (state === 'claimed' && claimedBy === agentId) {
      return this.toHandoffRecord(row, this.handoffSuccessorIds(sessionId));
    }
    this.driver.run(
      'UPDATE handoffs SET state = ?, claimed_by = ?, claimed_at = ? WHERE id = ?',
      ['claimed', agentId, nowIso(), handoffId],
    );
    return this.toHandoffRecord(
      this.requireHandoffRow(sessionId, handoffId),
      this.handoffSuccessorIds(sessionId),
    );
  }

  /**
   * `claimed` → `done`. Marking a handoff done requires having claimed it:
   * otherwise "done" would be a claim by another name, with none of the
   * accountability.
   */
  completeHandoff(sessionId: string, handoffId: string): HandoffRecord {
    const row = this.requireHandoffRow(sessionId, handoffId);
    const state = str(row['state']) as HandoffState;
    if (state === 'done') {
      return this.toHandoffRecord(row, this.handoffSuccessorIds(sessionId));
    }
    if (state !== 'claimed') {
      fail('STORAGE_ERROR', `handoff ${handoffId} must be claimed before it can be completed`, 'storage');
    }
    this.driver.run('UPDATE handoffs SET state = ?, completed_at = ? WHERE id = ?', [
      'done',
      nowIso(),
      handoffId,
    ]);
    return this.toHandoffRecord(
      this.requireHandoffRow(sessionId, handoffId),
      this.handoffSuccessorIds(sessionId),
    );
  }

  // =========================================================================
  // settings (§7.2)
  // =========================================================================

  getSettings(): SettingsSnapshot {
    const row = this.driver.get<Row>('SELECT value_json FROM settings WHERE key = ?', [SETTINGS_KEY]);
    let parsed: unknown;
    if (row !== undefined) {
      try {
        parsed = JSON.parse(str(row['value_json']) ?? '');
      } catch (error) {
        this.logger.warn('settings document is not valid JSON; falling back to defaults', {
          error: String(error),
        });
        parsed = undefined;
      }
    }
    const snapshot = normalizeSettings(parsed ?? DEFAULT_SETTINGS);
    const protection = this.readProtectionState();
    if (protection === undefined) {
      return snapshot;
    }
    // NFR-15: the Settings page must show the real state, never a guess.
    return { ...snapshot, storage: { ...snapshot.storage, encryptionEnabled: protection } };
  }

  patchSettings(patch: DeepPartial<SettingsSnapshot>): SettingsSnapshot {
    const current = this.getSettings();
    const next = applySettingsPatch(current, patch);
    this.driver.run(
      `INSERT OR REPLACE INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)`,
      [SETTINGS_KEY, JSON.stringify(next), nowIso()],
    );
    return next;
  }

  // =========================================================================
  // transcript projection (§8.3)
  // =========================================================================

  getMessages(sessionId: string): MessageDto[] {
    return this.queryMessages('session_id = ?', [sessionId]);
  }

  getMessagesForTurn(sessionId: string, turnId: string): MessageDto[] {
    return this.queryMessages('session_id = ? AND turn_id = ?', [sessionId, turnId]);
  }

  // =========================================================================
  // internals
  // =========================================================================

  private get driver() {
    return this.db.driver;
  }

  private queryMessages(where: string, params: unknown[]): MessageDto[] {
    const rows = this.driver.all<Row>(
      `SELECT * FROM messages WHERE ${where} ORDER BY produced_from_seq ASC, created_at ASC, id ASC`,
      params,
    );
    return rows.map((row) => toMessageDto(row));
  }

  private handoffTurns(sessionId: string): HandoffTurn[] {
    const rows = this.driver.all<Row>(
      'SELECT id, status, objective, started_at FROM turns WHERE session_id = ? ORDER BY started_at ASC, id ASC',
      [sessionId],
    );
    return rows.map((row) => ({
      id: str(row['id']) ?? '',
      status: (str(row['status']) ?? 'PENDING') as TurnState,
      objective: str(row['objective']) ?? null,
      startedAt: str(row['started_at']) ?? '',
    }));
  }

  /**
   * S-4: emit `turn.interrupted{reason:'app_crash_recovery'}` and return the
   * `lastSeq` the turn reached. `seq` comes from the sequencer inside the
   * caller's transaction (SEQ-2).
   */
  private recoverTurn(sessionId: string, turnId: string, now: string): number {
    if (this.sequencer === undefined) {
      this.logger.warn('no SessionSequencer injected; recovery cannot append turn.interrupted', {
        sessionId,
        turnId,
      });
      return this.readLastSeq(sessionId);
    }
    const seq = this.sequencer.next(sessionId);
    if (this.eventLog !== undefined) {
      const result = this.eventLog.append({
        sessionId,
        turnId,
        seq,
        proposal: {
          type: 'turn.interrupted',
          source: { kind: 'ucad' },
          payload: { reason: 'app_crash_recovery', lastSeq: seq, recoverable: true },
          ts: now,
        },
      });
      if (!result.ok) {
        this.logger.error('turn.interrupted was rejected on admission (SEQ-6)', {
          sessionId,
          turnId,
          seq,
          reason: result.rejectedReason,
        });
      }
    }
    this.setSessionLastSeq(sessionId, seq);
    return seq;
  }

  /**
   * S-5: `sessions.status='INTERRUPTED'` and `agent_sessions.status='interrupted'`
   * are always written together, and re-running converges instead of flipping
   * a CLOSED session.
   */
  private interruptSessionRows(sessionId: string, now: string): void {
    const row = this.driver.get<Row>('SELECT status FROM sessions WHERE id = ?', [sessionId]);
    const status = row === undefined ? undefined : (str(row['status']) as SessionState | undefined);
    if (status === undefined || (SESSION_STATES_FROZEN as ReadonlyArray<string>).includes(status)) {
      return;
    }
    if (status !== 'INTERRUPTED') {
      this.driver.run('UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?', [
        'INTERRUPTED',
        now,
        sessionId,
      ]);
    }
    this.syncAgentSessionToInterrupted(sessionId);
  }

  private syncAgentSessionToInterrupted(sessionId: string): void {
    this.driver.run("UPDATE agent_sessions SET status = 'interrupted' WHERE session_id = ?", [
      sessionId,
    ]);
  }

  private requireEventLog(): EventLogLike {
    if (this.eventLog === undefined) {
      fail(
        'STORAGE_ERROR',
        'SessionStore needs an EventLog to replay events (§2); none was injected',
        'storage',
      );
    }
    return this.eventLog;
  }

  private requireSessionRow(id: string): Row {
    const row = this.driver.get<Row>(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE id = ?`, [id]);
    if (row === undefined) {
      fail('UNKNOWN', `session not found: ${id}`, 'storage', { sessionId: id });
    }
    return row;
  }

  private requireSession(id: string): SessionDto {
    return this.toSessionDto(this.requireSessionRow(id), this.readLastSeq(id));
  }

  private requireTurnRow(id: string): Row {
    const row = this.driver.get<Row>(`SELECT ${TURN_COLUMNS} FROM turns WHERE id = ?`, [id]);
    if (row === undefined) {
      fail('UNKNOWN', `turn not found: ${id}`, 'storage', { turnId: id });
    }
    return row;
  }

  private requireWorkspace(id: string): WorkspaceDto {
    const workspace = this.getWorkspace(id);
    if (workspace === null) {
      fail('UNKNOWN', `workspace not found: ${id}`, 'storage', { workspaceId: id });
    }
    return workspace;
  }

  /** Column probe for the two columns §8.1 does not define. */
  private hasColumn(table: string, column: string): boolean {
    const key = `${table}.${column}`;
    const cached = this.columnCache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    if (!/^[a-z_]+$/.test(table)) {
      fail('STORAGE_ERROR', `invalid table name: ${table}`, 'storage');
    }
    let present = false;
    try {
      const rows = this.driver.all<{ name?: unknown }>(`PRAGMA table_info(${table})`);
      present = rows.some((row) => str(row.name) === column);
    } catch (error) {
      this.logger.warn('column probe failed; assuming the column is absent', {
        table,
        column,
        error: String(error),
      });
    }
    this.columnCache.set(key, present);
    return present;
  }

  /**
   * Table probe, for the same reason `hasColumn` exists: a database written by
   * an older build must keep working. `PRAGMA table_info` on a missing table
   * returns no rows rather than throwing, so absence is indistinguishable from
   * an empty table — which is exactly the answer we want here.
   */
  private hasTable(table: string): boolean {
    if (!/^[a-z_]+$/.test(table)) {
      fail('STORAGE_ERROR', `invalid table name: ${table}`, 'storage');
    }
    try {
      return this.driver.all<Row>(`PRAGMA table_info(${table})`).length > 0;
    } catch (error) {
      this.logger.warn('table probe failed; assuming the table is absent', {
        table,
        error: String(error),
      });
      return false;
    }
  }

  private readLastSeq(session: Row | string): number {
    const sessionId = typeof session === 'string' ? session : (str(session['id']) ?? '');

    if (this.hasColumn('sessions', 'last_seq')) {
      const stored = this.driver.get<Row>('SELECT last_seq FROM sessions WHERE id = ?', [sessionId]);
      if (stored !== undefined) {
        return int(stored['last_seq']);
      }
    }
    if (this.eventLog !== undefined) {
      try {
        return this.eventLog.latestSeq(sessionId);
      } catch (error) {
        this.logger.warn('latestSeq failed; reporting lastSeq 0', {
          sessionId,
          error: String(error),
        });
      }
    }
    return 0;
  }

  /** NFR-15 — the real protection state, or undefined when storage cannot report it. */
  private readProtectionState(): boolean | undefined {
    const probe = this.db as { isProtected?: () => boolean };
    if (typeof probe.isProtected !== 'function') {
      return undefined;
    }
    try {
      return probe.isProtected() === true;
    } catch (error) {
      this.logger.warn('Database.isProtected() threw; reporting the stored value', {
        error: String(error),
      });
      return undefined;
    }
  }

  /**
   * Append to the chain, unless the replay says nothing changed.
   *
   * `sequence` is allocated as `MAX(sequence) + 1` inside the same statement
   * that inserts, so two concurrent handoffs cannot pick the same position —
   * the UNIQUE(session_id, sequence) constraint turns a race into a loud
   * failure instead of a chain with two "latest" entries.
   */
  private appendHandoffRecord(sessionId: string, handoff: ContextHandoff): void {
    if (!this.hasTable('handoffs')) {
      // A database older than migration 4. The handoff still works — it is
      // event-derived — it just has no history yet, and that must not be a
      // reason to fail a handoff request.
      return;
    }
    try {
      const body = JSON.stringify(handoff);
      const latest = this.driver.get<Row>(
        'SELECT id, body_json FROM handoffs WHERE session_id = ? ORDER BY sequence DESC LIMIT 1',
        [sessionId],
      );
      if (latest !== undefined && str(latest['body_json']) === body) {
        this.logger.debug('handoff replay is unchanged; not appending to the chain', { sessionId });
        return;
      }
      this.driver.run(
        `INSERT INTO handoffs(id, session_id, sequence, state, supersedes_id, body_json, created_at)
         VALUES(?, ?, (SELECT COALESCE(MAX(sequence), 0) + 1 FROM handoffs WHERE session_id = ?), 'open', ?, ?, ?)`,
        [ulid('hnd_'), sessionId, sessionId, latest === undefined ? null : str(latest['id']), body, nowIso()],
      );
    } catch (error) {
      // The chain is an addition to a feature that already works. Losing the
      // history is bad; refusing to produce a handoff because of it is worse.
      this.logger.warn('could not append to the handoff chain; the replay still succeeds', {
        sessionId,
        error: String(error),
      });
    }
  }

  /** rowId → the id of the row that supersedes it. */
  private handoffSuccessorIds(sessionId: string): Map<string, string> {
    if (!this.hasTable('handoffs')) return new Map();
    const rows = this.driver.all<Row>(
      'SELECT id, supersedes_id FROM handoffs WHERE session_id = ? AND supersedes_id IS NOT NULL',
      [sessionId],
    );
    const out = new Map<string, string>();
    for (const row of rows) {
      const parent = str(row['supersedes_id']);
      const child = str(row['id']);
      if (parent !== undefined && child !== undefined) out.set(parent, child);
    }
    return out;
  }

  private requireHandoffRow(sessionId: string, handoffId: string): Row {
    const row = this.driver.get<Row>(
      'SELECT * FROM handoffs WHERE id = ? AND session_id = ?',
      [handoffId, sessionId],
    );
    if (row === undefined) {
      fail('STORAGE_ERROR', `no handoff ${handoffId} in session ${sessionId}`, 'storage');
    }
    return row;
  }

  private toHandoffRecord(row: Row, successors: Map<string, string>): HandoffRecord {
    const id = str(row['id']) ?? '';
    const body = str(row['body_json']);
    let handoff: ContextHandoff;
    try {
      const parsed: unknown = JSON.parse(body ?? '');
      // A body that parses but has the wrong shape is the same defect class as
      // one that does not parse: it was written by a different schema version
      // or by something that is not a handoff at all. Letting it through would
      // put confident holes into a document that claims to be complete.
      if (!isContextHandoff(parsed)) {
        throw new Error('stored handoff body does not match the ContextHandoff schema (v2)');
      }
      handoff = parsed;
    } catch (error) {
      // A body that will not parse must not take the whole list down with it.
      this.logger.warn('a stored handoff body is not a usable handoff; surfacing it as empty', {
        handoffId: id,
        error: String(error),
      });
      handoff = {
        schemaVersion: 2,
        objective: '',
        currentState: '',
        relevantFiles: [],
        decisions: [],
        changes: [],
        commandsRun: [],
        pendingWork: [],
        cautions: [],
        producedBy: { sessionId: str(row['session_id']) ?? '', turnId: '', agentId: '', at: '' },
      };
    }
    return {
      id,
      sessionId: str(row['session_id']) ?? '',
      sequence: int(row['sequence']),
      state: (str(row['state']) ?? 'open') as HandoffState,
      supersedes: str(row['supersedes_id']) ?? null,
      supersededBy: successors.get(id) ?? null,
      createdAt: str(row['created_at']) ?? '',
      claimedBy: str(row['claimed_by']) ?? null,
      claimedAt: str(row['claimed_at']) ?? null,
      completedAt: str(row['completed_at']) ?? null,
      handoff,
    };
  }

  private cacheHandoff(sessionId: string, handoff: unknown): void {
    if (!this.hasColumn('sessions', 'handoff_json')) {
      return;
    }
    try {
      this.driver.run('UPDATE sessions SET handoff_json = ? WHERE id = ?', [
        JSON.stringify(handoff),
        sessionId,
      ]);
    } catch (error) {
      this.logger.warn('could not cache the handoff; it stays event-derived', {
        sessionId,
        error: String(error),
      });
    }
  }

  private toWorkspaceDto(row: Row): WorkspaceDto {
    const lastOpenedAt = str(row['last_opened_at']);
    return {
      id: str(row['id']) ?? '',
      path: str(row['path']) ?? '',
      name: str(row['name']) ?? '',
      trustState: (str(row['trust_state']) ?? 'untrusted') as TrustState,
      ...(lastOpenedAt !== undefined ? { lastOpenedAt } : {}),
    };
  }

  private toSessionDto(row: Row, lastSeq: number): SessionDto {
    const providerId = str(row['provider_id']);
    const modelId = str(row['model_id']);
    return {
      id: str(row['id']) ?? '',
      workspaceId: str(row['workspace_id']) ?? '',
      title: str(row['title']) ?? '',
      agentId: str(row['agent_id']) ?? '',
      ...(providerId !== null && providerId !== undefined ? { providerId } : {}),
      ...(modelId !== null && modelId !== undefined ? { modelId } : {}),
      status: (str(row['status']) ?? 'CREATED') as SessionState,
      createdAt: str(row['created_at']) ?? '',
      updatedAt: str(row['updated_at']) ?? '',
      lastSeq,
    };
  }
}
