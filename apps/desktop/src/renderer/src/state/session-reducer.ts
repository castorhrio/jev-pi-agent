/**
 * The event reducer that turns the persisted event stream into view state.
 *
 * §12.2 requires two layers: persisted-entity queries plus a reducer over the
 * CURRENT session's events. This file is that reducer. It is deliberately pure
 * so it can be replayed, which is what makes NFR-03 recovery work: after a
 * crash the Renderer re-reads `events.since()` and folds the same events into
 * the same state.
 *
 * The reducer never invents data. If an event type is not handled here it is
 * simply not reflected in this projection — the events table remains the audit
 * source of truth.
 */

import type { TurnEvent } from '@ucad/contracts';

export interface ToolView {
  toolCallId: string;
  name: string;
  origin: 'vendor' | 'ucad';
  status: 'running' | 'ok' | 'error' | 'denied';
  input?: unknown;
  outputPreview?: string;
  durationMs?: number;
  startedAtSeq: number;
}

interface PermissionView {
  requestId: string;
  category: string;
  risk: 'low' | 'medium' | 'high';
  resource?: string;
  command?: string;
  reason?: string;
  resolved?: { decision: string; decider: 'user' | 'policy' };
}

export interface CommandView {
  commandId: string;
  command: string;
  cwd: string;
  output: Array<{ stream: 'stdout' | 'stderr'; chunk: string }>;
  exitCode: number | null;
  durationMs?: number;
}

interface DecisionView {
  requestId: string;
  kind: string;
  summary: string;
  confidence: number;
  rationale: string;
  engineId: string;
  fallbackUsed: boolean;
  ts: string;
}

interface ContextView {
  packId: string;
  revision: number;
  itemCount: number;
  omittedCount: number;
  estimatedTokens: number;
  estimateSource: string;
  strategy: string;
  renderedHash: string;
  injectionMode: string;
}

/**
 * Per-turn view caps.
 *
 * The event log is the source of truth; these are a projection, so an unbounded
 * projection is a memory leak with a slow fuse. A 2 000-delta turn must not
 * leave 2 000 live React rows, and command output must not accumulate for the
 * lifetime of the process.
 */
const MAX_COMMAND_OUTPUT_CHARS = 64 * 1024;
const MAX_TOOLS_PER_TURN = 200;
const MAX_NOTICES = 50;
const MAX_MESSAGES = 500;

interface ChatMessageView {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  ts: string;
  turnId: string;
  interrupted?: boolean;
}

export interface SessionViewState {
  sessionId: string;
  /** highest seq folded in — drives gap detection */
  lastSeq: number;
  status: string;
  messages: ChatMessageView[];
  tools: ToolView[];
  permissions: PermissionView[];
  commands: CommandView[];
  decisions: DecisionView[];
  context: ContextView | null;
  notices: Array<{ level: 'warn' | 'error'; code: string; message: string; ts: string }>;
  usage: { inputTokens: number; outputTokens: number; estimated: boolean } | null;
  /** set when the stream contains an event this reducer does not model */
  unmodelledEventCount: number;
}

/**
 * Merge one streaming delta into the transcript without touching `lastSeq`.
 *
 * `useSessionEvents` coalesces deltas in a buffer and folds them here when the
 * buffer commits. The deltas' seqs were already accounted for when they
 * arrived, so the commit must not advance seq accounting — a commit that
 * invented a seq would collide with the next real event and get that event
 * dropped by the `seq <= lastSeq` guard above.
 *
 * Shared with `reduceEvent`'s `text.delta` case so the merge rules — append to
 * the streaming tail, otherwise open a new assistant message, cap the
 * transcript — cannot drift between the direct path and the buffered one.
 */
export function mergeDeltaText(
  state: SessionViewState,
  delta: { messageId: string; text: string; turnId: string; ts: string },
): ChatMessageView[] {
  const last = state.messages[state.messages.length - 1];
  if (last && last.id === delta.messageId && last.role === 'assistant') {
    // Appending to the streaming tail. This replaces exactly one slot, so
    // the caller (see `useSessionEvents`) is responsible for not re-copying
    // the whole array once per delta — at 40 deltas/second that copy is the
    // difference between a smooth transcript and a quadratic renderer.
    const merged: ChatMessageView = { ...last, text: last.text + delta.text };
    return [...state.messages.slice(0, -1), merged].slice(-MAX_MESSAGES);
  }
  const created: ChatMessageView = {
    id: delta.messageId,
    role: 'assistant',
    text: delta.text,
    ts: delta.ts,
    turnId: delta.turnId,
  };
  return [...state.messages, created].slice(-MAX_MESSAGES);
}

export function emptySessionView(sessionId: string): SessionViewState {
  return {
    sessionId,
    lastSeq: 0,
    status: 'READY',
    messages: [],
    tools: [],
    permissions: [],
    commands: [],
    decisions: [],
    context: null,
    notices: [],
    usage: null,
    unmodelledEventCount: 0,
  };
}

const HANDLED: ReadonlySet<string> = new Set([
  'turn.started',
  'turn.completed',
  'turn.interrupted',
  'text.delta',
  'tool.started',
  'tool.updated',
  'tool.completed',
  'command.started',
  'command.output',
  'command.completed',
  'permission.requested',
  'permission.resolved',
  'decision.made',
  'context.pack.built',
  'context.pack.extended',
  'usage',
  'warning',
  'error',
  'session.started',
]);

/**
 * Fold one event into the view. Returns a new state object; never mutates.
 * Events with `seq <= lastSeq` are ignored, which makes replay idempotent.
 */
export function reduceEvent(state: SessionViewState, event: TurnEvent): SessionViewState {
  if (event.seq <= state.lastSeq) return state;

  const next: SessionViewState = {
    ...state,
    lastSeq: event.seq,
  };

  if (!HANDLED.has(event.type)) {
    next.unmodelledEventCount += 1;
    return next;
  }

  switch (event.type) {
    case 'session.started': {
      next.status = 'READY';
      return next;
    }

    case 'turn.started': {
      const payload = event.payload as { objective: string };
      next.status = 'RUNNING';
      next.messages = [
        ...next.messages,
        {
          id: `msg_user_${event.turnId}`,
          role: 'user',
          text: payload.objective,
          ts: event.ts,
          turnId: event.turnId,
        },
      ];
      return next;
    }

    case 'text.delta': {
      const payload = event.payload as { text: string; messageId: string };
      next.messages = mergeDeltaText(next, {
        messageId: payload.messageId,
        text: payload.text,
        turnId: event.turnId,
        ts: event.ts,
      });
      return next;
    }

    case 'turn.completed': {
      const payload = event.payload as { status: string };
      next.status =
        payload.status === 'completed'
          ? 'READY'
          : payload.status === 'cancelled'
            ? 'READY'
            : 'FAILED';
      return next;
    }

    case 'turn.interrupted': {
      const payload = event.payload as { reason: string; recoverable: boolean };
      next.status = 'INTERRUPTED';
      next.messages = next.messages.map((m) =>
        m.turnId === event.turnId ? { ...m, interrupted: true } : m,
      );
      next.notices = [
        ...next.notices,
        {
          level: 'warn',
          code: `INTERRUPTED_${payload.reason.toUpperCase()}`,
          message: `轮次被中断（${payload.reason}），${
            payload.recoverable ? '历史已保留，可继续会话。' : '该会话已无法恢复。'
          }`,
          ts: event.ts,
        },
      ];
      return next;
    }

    case 'tool.started': {
      const payload = event.payload as {
        toolCallId: string;
        name: string;
        input: unknown;
        origin: 'vendor' | 'ucad';
      };
      const started: ToolView = {
        toolCallId: payload.toolCallId,
        name: payload.name,
        origin: payload.origin,
        status: 'running',
        input: payload.input,
        startedAtSeq: event.seq,
      };
      next.tools = [
        ...next.tools.filter((t) => t.toolCallId !== payload.toolCallId),
        started,
      ].slice(-MAX_TOOLS_PER_TURN);
      return next;
    }

    case 'tool.updated': {
      const payload = event.payload as {
        toolCallId: string;
        partialOutput?: string;
        progress?: string;
      };
      next.tools = next.tools.map((t) =>
        t.toolCallId === payload.toolCallId
          ? { ...t, outputPreview: payload.partialOutput ?? t.outputPreview }
          : t,
      );
      return next;
    }

    case 'tool.completed': {
      const payload = event.payload as {
        toolCallId: string;
        status: 'ok' | 'error' | 'denied';
        outputPreview?: string;
        durationMs: number;
      };
      next.tools = next.tools.map((t) =>
        t.toolCallId === payload.toolCallId
          ? {
              ...t,
              status: payload.status,
              outputPreview: payload.outputPreview ?? t.outputPreview,
              durationMs: payload.durationMs,
            }
          : t,
      );
      return next;
    }

    case 'command.started': {
      const payload = event.payload as { commandId: string; command: string; cwd: string };
      next.commands = [
        ...next.commands.filter((c) => c.commandId !== payload.commandId),
        {
          commandId: payload.commandId,
          command: payload.command,
          cwd: payload.cwd,
          output: [],
          exitCode: null,
        },
      ].slice(-MAX_TOOLS_PER_TURN);
      return next;
    }

    case 'command.output': {
      const payload = event.payload as {
        commandId: string;
        stream: 'stdout' | 'stderr';
        chunk: string;
      };
      next.commands = next.commands.map((c) => {
        if (c.commandId !== payload.commandId) return c;
        // Command output is capped like tool output (NFR-06): a `npm install`
        // that prints 40 MB must not sit in the Renderer for the whole session.
        const kept = c.output;
        const spent = kept.reduce((sum, o) => sum + o.chunk.length, 0);
        if (spent >= MAX_COMMAND_OUTPUT_CHARS) return c;
        return {
          ...c,
          output: [...kept, { stream: payload.stream, chunk: payload.chunk }],
        };
      });
      return next;
    }

    case 'command.completed': {
      const payload = event.payload as {
        commandId: string;
        exitCode: number | null;
        durationMs: number;
      };
      next.commands = next.commands.map((c) =>
        c.commandId === payload.commandId
          ? { ...c, exitCode: payload.exitCode, durationMs: payload.durationMs }
          : c,
      );
      return next;
    }

    case 'permission.requested': {
      const payload = event.payload as unknown as {
        requestId: string;
        request: Record<string, string>;
      };
      if (next.permissions.some((p) => p.requestId === payload.requestId)) return next;
      next.permissions = [
        ...next.permissions,
        {
          requestId: payload.requestId,
          category: payload.request.category ?? 'UNKNOWN',
          risk: (payload.request.risk as PermissionView['risk']) ?? 'medium',
          resource: payload.request.resource,
          command: payload.request.command,
          reason: payload.request.reason,
        },
      ];
      return next;
    }

    case 'permission.resolved': {
      const payload = event.payload as {
        requestId: string;
        decision: string;
        decider: 'user' | 'policy';
      };
      next.permissions = next.permissions.map((p) =>
        p.requestId === payload.requestId
          ? { ...p, resolved: { decision: payload.decision, decider: payload.decider } }
          : p,
      );
      return next;
    }

    case 'decision.made': {
      const payload = event.payload as {
        requestId: string;
        kind: string;
        outcome: { kind: string; [k: string]: unknown };
        confidence: number;
        rationale: string;
        engineId: string;
        fallback?: { used: true; reason: string };
      };
      next.decisions = [
        ...next.decisions,
        {
          requestId: payload.requestId,
          kind: payload.kind,
          summary: describeOutcome(payload.outcome),
          confidence: payload.confidence,
          rationale: payload.rationale,
          engineId: payload.engineId,
          fallbackUsed: Boolean(payload.fallback?.used),
          ts: event.ts,
        },
      ];
      return next;
    }

    case 'context.pack.built': {
      const payload = event.payload as unknown as Record<string, string | number>;
      next.context = {
        packId: String(payload.packId),
        revision: Number(payload.revision),
        itemCount: Number(payload.itemCount),
        omittedCount: Number(payload.omittedCount),
        estimatedTokens: Number(payload.estimatedTokens),
        estimateSource: String(payload.estimateSource),
        strategy: String(payload.strategy),
        renderedHash: String(payload.renderedHash),
        injectionMode: String(payload.injectionMode),
      };
      return next;
    }

    case 'context.pack.extended': {
      const payload = event.payload as unknown as Record<string, string | number>;
      if (next.context && next.context.packId === payload.packId) {
        next.context = {
          ...next.context,
          revision: Number(payload.revision),
        };
      }
      return next;
    }

    case 'usage': {
      const payload = event.payload as {
        record: {
          inputTokens?: number;
          outputTokens?: number;
          source: 'vendor' | 'computed' | 'unknown';
        };
      };
      const record = payload.record;
      next.usage = {
        inputTokens: (next.usage?.inputTokens ?? 0) + (record.inputTokens ?? 0),
        outputTokens: (next.usage?.outputTokens ?? 0) + (record.outputTokens ?? 0),
        // T-3 / §4.12.2: a computed count must never be shown as exact.
        estimated:
          (next.usage?.estimated ?? false) ||
          record.source === 'computed' ||
          record.source === 'unknown',
      };
      return next;
    }

    case 'warning': {
      const payload = event.payload as { code: string; message: string };
      next.notices = [
        ...next.notices,
        { level: 'warn' as const, code: payload.code, message: payload.message, ts: event.ts },
      ].slice(-MAX_NOTICES);
      return next;
    }

    case 'error': {
      const payload = event.payload as { code: string; message: string };
      next.notices = [
        ...next.notices,
        { level: 'error' as const, code: payload.code, message: payload.message, ts: event.ts },
      ].slice(-MAX_NOTICES);
      return next;
    }

    default:
      return next;
  }
}

function describeOutcome(outcome: { kind: string; [k: string]: unknown }): string {
  switch (outcome.kind) {
    case 'route':
      return `路由 → ${String(outcome.agentId)}${outcome.modelId ? ` / ${String(outcome.modelId)}` : ''}`;
    case 'risk':
      return `风险 ${String(outcome.risk)} · ${(outcome.categories as string[] | undefined)?.join(', ') ?? ''}`;
    case 'continue_or_stop':
      return `${String(outcome.action)} · ${String(outcome.reason)}`;
    case 'clarify':
      return `需要澄清：${String(outcome.question)}`;
    case 'option_select':
      return `选择 ${String(outcome.optionId)}`;
    case 'context_relevance':
      return `相关项 ${(outcome.relevantItemIds as string[] | undefined)?.length ?? 0} 个`;
    default:
      return outcome.kind;
  }
}
