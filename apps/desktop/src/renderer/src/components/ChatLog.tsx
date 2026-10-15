import { useMemo } from 'react';
import type { ToolView, CommandView } from '../state/session-reducer';
import { useT } from '../i18n-context';

/**
 * The transcript.
 *
 * Grouped by turn rather than rendered as a flat feed: "what did I ask, what
 * did it do, what came back" is the unit a person actually reads, and a flat
 * stream of deltas and tool calls buries that.
 *
 * Two things follow from that and were not true of the first implementation:
 *
 *  - **Every message renders.** It used to draw a assistant message only if it
 *    was the newest one, so a three-turn conversation showed three questions
 *    and one answer — the history silently amputated to its tail.
 *  - **The four streams are interleaved by seq.** Messages, tool calls,
 *    commands and notices arrive as one event stream; seq is the only clock
 *    they share. Drawing all messages before all tools puts an agent's
 *    conclusion above the work that produced it, which inverts the causality
 *    this product exists to make checkable.
 */
export function ChatLog({
  messages,
  tools,
  commands,
  notices,
  agentName,
}: {
  messages: Array<{
    id: string;
    role: string;
    text: string;
    turnId: string;
    seq: number;
    interrupted?: boolean;
  }>;
  tools: ToolView[];
  commands: CommandView[];
  notices: Array<{ level: string; code: string; message: string; ts: string; seq: number }>;
  /** The session's agent, so an assistant line can be attributed to someone. */
  agentName: string;
}): JSX.Element {
  const t = useT();

  const timeline = useMemo(() => {
    type Entry =
      | { seq: number; kind: 'message'; value: (typeof messages)[number] }
      | { seq: number; kind: 'tool'; value: ToolView }
      | { seq: number; kind: 'command'; value: CommandView }
      | { seq: number; kind: 'notice'; value: (typeof notices)[number] };

    const out: Entry[] = [];
    messages.forEach((m) => out.push({ seq: m.seq, kind: 'message', value: m }));
    tools.forEach((tool) => out.push({ seq: tool.startedAtSeq, kind: 'tool', value: tool }));
    commands.forEach((c) =>
      out.push({ seq: c.startedAtSeq, kind: 'command', value: c }),
    );
    notices.forEach((n) => out.push({ seq: n.seq, kind: 'notice', value: n }));
    out.sort((a, b) => a.seq - b.seq);
    return out;
  }, [messages, tools, commands, notices]);

  type Turn = { items: JSX.Element[]; agentHeaded: boolean };
  const turns: Turn[] = [];
  const rendered = new Set<string>();

  for (const entry of timeline) {
    if (entry.kind === 'message' && entry.value.role === 'user') {
      const turn: Turn = { items: [], agentHeaded: false };
      turn.items.push(
        <div className="turn-head" key={`h-${entry.value.id}`}>
          <span className="who">{t('chat.you')}</span>
          <span className="faint">#{turns.length + 1}</span>
        </div>,
        <div className="msg user" key={`m-${entry.value.id}`}>
          {entry.value.text}
        </div>,
      );
      turns.push(turn);
      continue;
    }

    let turn = turns[turns.length - 1];
    if (!turn) {
      // Agent-side events with no question above them: a replay that starts
      // mid-turn, or a turn resumed after a crash. Attributed, not orphaned.
      turn = { items: [], agentHeaded: false };
      turns.push(turn);
    }
    if (!turn.agentHeaded) {
      turn.agentHeaded = true;
      turn.items.push(
        <div className="turn-head" key={`h-a-${turns.length}`}>
          <span className="who">{agentName}</span>
        </div>,
      );
    }

    if (entry.kind === 'message') {
      turn.items.push(
        <div
          className={`msg ${entry.value.role} ${entry.value.interrupted ? 'interrupted' : ''}`}
          key={`m-${entry.value.id}`}
        >
          {entry.value.text}
        </div>,
      );
      continue;
    }
    if (entry.kind === 'tool') {
      if (rendered.has(entry.value.toolCallId)) continue;
      rendered.add(entry.value.toolCallId);
      turn.items.push(<ToolCard key={`t-${entry.value.toolCallId}`} tool={entry.value} />);
      continue;
    }
    if (entry.kind === 'command') {
      turn.items.push(<CommandCard key={`c-${entry.value.commandId}`} cmd={entry.value} />);
      continue;
    }
    turn.items.push(
      <div
        className={`notice ${entry.value.level === 'error' ? 'error' : 'warn'}`}
        key={`n-${entry.value.code}-${entry.value.seq}`}
      >
        <span className="badge">{entry.value.code}</span>
        <span className="muted">{entry.value.message}</span>
      </div>,
    );
  }

  return (
    <>
      {turns.map((turn, index) => (
        <div className="turn" key={`turn-${index}`}>
          {turn.items}
        </div>
      ))}
    </>
  );
}

function ToolCard({ tool }: { tool: ToolView }): JSX.Element {
  return (
    <div className="tool">
      <div className="tool-head">
        <span className={`dot ${dotFor(tool.status)}`} />
        <span className="name">{tool.name}</span>
        {tool.origin === 'ucad' && <span className="badge accent">ucad.*</span>}
        {tool.durationMs !== undefined && (
          <span className="faint">{tool.durationMs}ms</span>
        )}
      </div>
      {tool.outputPreview ? <pre>{tool.outputPreview}</pre> : null}
    </div>
  );
}

function CommandCard({ cmd }: { cmd: CommandView }): JSX.Element {
  const t = useT();
  return (
    <div className="tool">
      <div className="tool-head">
        <span
          className={`dot ${cmd.exitCode === null ? 'running' : cmd.exitCode === 0 ? 'ok' : 'err'}`}
        />
        <span className="name">$ {cmd.command}</span>
        {cmd.exitCode !== null && <span className="faint">exit {cmd.exitCode}</span>}
      </div>
      {cmd.output.length > 0 ? (
        <pre>{cmd.output.map((o) => o.chunk).join('') || t('common.none')}</pre>
      ) : null}
    </div>
  );
}

function dotFor(status: string): string {
  switch (status) {
    case 'running':
      return 'running';
    case 'ok':
      return 'ok';
    case 'error':
    case 'denied':
      return 'err';
    default:
      return '';
  }
}
