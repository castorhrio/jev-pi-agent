/**
 * §4.12.1 `ContextHandoff` — deterministic replay of `events` + `decisions` +
 * context-pack information.
 *
 * Determinism is the contract: the same event history must always produce the
 * same handoff, so nothing here reads the clock, a random source or mutable
 * state. Timestamps come from the events themselves (and from the session row
 * when the session has no events yet).
 *
 * The receiving Agent gets a structured summary, never the vendor transcript —
 * that is what keeps the token cost and the vendor coupling under control (§4.12.1).
 */

import type {
  AgentSessionState,
  ContextHandoff,
  FreshnessState,
  SessionState,
  TurnEvent,
  TurnState,
} from '@ucad/contracts';
import type { DecisionRecordDto } from './dto';

export interface HandoffTurn {
  id: string;
  status: TurnState;
  objective: string | null;
  startedAt: string;
}

export interface HandoffSession {
  id: string;
  agentId: string;
  status: SessionState;
  updatedAt: string;
  lastSeq: number;
}

export interface HandoffInput {
  session: HandoffSession;
  turns: readonly HandoffTurn[];
  events: readonly TurnEvent[];
  decisions: readonly DecisionRecordDto[];
  agentSessionStatus: AgentSessionState | null;
}

function pushUnique(list: string[], value: string): void {
  if (value !== '' && !list.includes(value)) {
    list.push(value);
  }
}

export function buildContextHandoff(input: HandoffInput): ContextHandoff {
  const events = [...input.events].sort((a, b) => a.seq - b.seq);
  const lastEvent = events[events.length - 1];
  const lastTurn = input.turns[input.turns.length - 1];

  let objective = '';
  const relevantFiles: ContextHandoff['relevantFiles'] = [];
  const changes: ContextHandoff['changes'] = [];
  const decisions: string[] = [];
  const commandsRun: ContextHandoff['commandsRun'] = [];
  const pendingWork: string[] = [];
  const cautions: string[] = [];

  /** commandId -> index into `commandsRun`, so started/completed pair up. */
  const openCommands = new Map<string, number>();
  const finishedCommands = new Set<string>();
  const permissionCategories = new Map<string, string>();
  const seenFiles = new Set<string>();
  const deniedPermissions = new Set<string>();

  let contextRef: ContextHandoff['contextRef'];
  let contextRevision = -1;
  let freshness: FreshnessState | undefined;

  for (const event of events) {
    switch (event.type) {
      case 'turn.started': {
        if (objective === '') {
          objective = event.payload.objective;
        }
        break;
      }
      case 'file.changed': {
        const { path, operation, previousPath } = event.payload;
        if (!seenFiles.has(path)) {
          seenFiles.add(path);
          relevantFiles.push({ path, reason: `${operation} (turn ${event.turnId})` });
        }
        changes.push({
          path,
          summary:
            previousPath !== undefined && previousPath !== ''
              ? `${operation}, previously ${previousPath} (turn ${event.turnId})`
              : `${operation} (turn ${event.turnId})`,
        });
        break;
      }
      case 'decision.made': {
        pushUnique(decisions, event.payload.rationale);
        break;
      }
      case 'permission.requested': {
        permissionCategories.set(event.payload.requestId, event.payload.request.category);
        break;
      }
      case 'permission.resolved': {
        if (event.payload.decision === 'deny') {
          deniedPermissions.add(event.payload.requestId);
        }
        break;
      }
      case 'command.started': {
        if (!openCommands.has(event.payload.commandId)) {
          openCommands.set(event.payload.commandId, commandsRun.length);
          commandsRun.push({ command: event.payload.command, result: 'no result recorded' });
        }
        break;
      }
      case 'command.completed': {
        const index = openCommands.get(event.payload.commandId);
        const entry = index === undefined ? undefined : commandsRun[index];
        if (entry !== undefined) {
          entry.result =
            event.payload.exitCode === null ? 'exited without a code' : `exit ${event.payload.exitCode}`;
          finishedCommands.add(event.payload.commandId);
        }
        break;
      }
      case 'context.pack.built': {
        if (event.payload.revision >= contextRevision) {
          contextRevision = event.payload.revision;
          contextRef = { packId: event.payload.packId, revision: event.payload.revision };
        }
        break;
      }
      case 'context.pack.extended': {
        if (event.payload.revision >= contextRevision) {
          contextRevision = event.payload.revision;
          contextRef = { packId: event.payload.packId, revision: event.payload.revision };
        }
        break;
      }
      case 'intelligence.query.completed': {
        freshness = event.payload.freshness;
        break;
      }
      case 'error': {
        cautions.push(`[error ${event.payload.code}] ${event.payload.message}`);
        break;
      }
      case 'warning': {
        cautions.push(`[warning ${event.payload.code}] ${event.payload.message}`);
        break;
      }
      case 'turn.interrupted': {
        cautions.push(`[interrupted] turn ended with reason ${event.payload.reason}`);
        break;
      }
      default:
        break;
    }
  }

  // Decisions persisted without a `decision.made` event still belong in the
  // handoff (the table is the NFR-16 record of truth).
  for (const decision of input.decisions) {
    pushUnique(decisions, decision.rationale);
  }

  if (objective === '') {
    objective = lastTurn?.objective ?? '';
  }

  for (const [commandId, index] of openCommands) {
    if (finishedCommands.has(commandId)) {
      continue;
    }
    const entry = commandsRun[index];
    if (entry !== undefined) {
      pushUnique(
        pendingWork,
        `command "${entry.command}" was started but no completion event was recorded`,
      );
    }
  }
  if (lastTurn !== undefined && !isTerminal(lastTurn.status)) {
    pushUnique(pendingWork, `turn ${lastTurn.id} is still ${lastTurn.status}`);
  }
  if (input.session.status === 'INTERRUPTED') {
    pushUnique(pendingWork, 'the session was interrupted; verify state before continuing');
  }
  if (input.agentSessionStatus === 'interrupted') {
    pushUnique(pendingWork, 'the native agent session is interrupted and must be resumed');
  }
  if (input.agentSessionStatus === 'orphaned') {
    pushUnique(pendingWork, 'the native agent session is orphaned; its transcript cannot be resumed');
  }

  for (const requestId of deniedPermissions) {
    const category = permissionCategories.get(requestId) ?? requestId;
    pushUnique(cautions, `the user denied a ${category} request`);
  }
  if (freshness?.stale === true) {
    pushUnique(
      cautions,
      `code intelligence is stale (${freshness.stalenessReason ?? 'unknown reason'})`,
    );
  }
  if (lastTurn?.status === 'FAILED') {
    pushUnique(cautions, 'the previous turn failed; re-read the transcript before assuming success');
  }

  const currentState =
    lastTurn === undefined
      ? `session=${input.session.status}; no turn recorded; lastSeq=${input.session.lastSeq}`
      : `session=${input.session.status}; turn=${lastTurn.id}:${lastTurn.status}; lastSeq=${input.session.lastSeq}`;

  return {
    schemaVersion: 2,
    objective,
    currentState,
    relevantFiles,
    decisions,
    changes,
    commandsRun,
    pendingWork,
    cautions,
    producedBy: {
      sessionId: input.session.id,
      turnId: lastEvent?.turnId ?? lastTurn?.id ?? '',
      agentId: input.session.agentId,
      at: lastEvent?.ts ?? input.session.updatedAt,
    },
    ...(contextRef !== undefined ? { contextRef } : {}),
    ...(freshness !== undefined ? { intelligenceFreshness: freshness } : {}),
  };
}

function isTerminal(status: TurnState): boolean {
  return status === 'COMPLETED' || status === 'FAILED' || status === 'CANCELLED' || status === 'INTERRUPTED';
}
