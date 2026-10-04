import { useMemo } from 'react';
import type { ToolView, CommandView } from '../state/session-reducer';
import { useT } from '../i18n-context';

/**
 * The transcript.
 *
 * Grouped by turn rather than rendered as a flat feed: "what did I ask, what
 * did it do, what came back" is the unit a person actually reads, and a flat
 * stream of deltas and tool calls buries that.
 */
export function ChatLog({
  messages,
  tools,
  commands,
  notices,
}: {
  messages: Array<{
    id: string;
    role: string;
    text: string;
    turnId: string;
    interrupted?: boolean;
  }>;
  tools: ToolView[];
  commands: CommandView[];
  notices: Array<{ level: string; code: string; message: string; ts: string }>;
}): JSX.Element {
  // Preserve arrival order across all three streams — a tool call that happened
  // between two deltas belongs between them, not in a separate column.
  const timeline = useMemo(() => {
    type Entry =
      | { at: number; kind: 'message'; value: (typeof messages)[number] }
      | { at: number; kind: 'tool'; value: ToolView }
      | { at: number; kind: 'command'; value: CommandView }
      | { at: number; kind: 'notice'; value: (typeof notices)[number] };

    const out: Entry[] = [];
    messages.forEach((m, i) => out.push({ at: i, kind: 'message', value: m }));
    tools.forEach((tool, i) => out.push({ at: tools.length + i, kind: 'tool', value: tool }));
    commands.forEach((c, i) =>
      out.push({ at: messages.length + tools.length + i, kind: 'command', value: c }),
    );
    notices.forEach((n, i) =>
      out.push({
        at: messages.length + tools.length + commands.length + i,
        kind: 'notice',
        value: n,
      }),
    );
    return out;
  }, [messages, tools, commands, notices]);

  const lastMessageId = messages[messages.length - 1]?.id;
  const rendered = new Set<string>();
  const out: JSX.Element[] = [];

  for (const entry of timeline) {
    if (entry.kind === 'message') {
      // a streaming message is a single block that grows; don't repeat the head
      if (entry.value.id === lastMessageId || entry.value.role === 'user') {
        out.push(
          <div className={`msg ${entry.value.role}`} key={`m-${entry.value.id}`}>
            {entry.value.text}
          </div>,
        );
      }
      continue;
    }
    if (entry.kind === 'tool') {
      if (rendered.has(entry.value.toolCallId)) continue;
      rendered.add(entry.value.toolCallId);
      out.push(<ToolCard key={`t-${entry.value.toolCallId}`} tool={entry.value} />);
      continue;
    }
    if (entry.kind === 'command') {
      out.push(<CommandCard key={`c-${entry.value.commandId}`} cmd={entry.value} />);
      continue;
    }
    out.push(
      <div className={`notice ${entry.value.level === 'error' ? 'error' : 'warn'}`} key={`n-${entry.value.code}-${entry.value.ts}`}>
        <span className="badge">{entry.value.code}</span>
        <span className="muted">{entry.value.message}</span>
      </div>,
    );
  }

  return <>{out}</>;
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
