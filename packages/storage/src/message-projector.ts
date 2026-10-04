/**
 * §8.3 — the producer of the `messages` projection.
 *
 * `messages` is PURELY DERIVED: if it ever disagrees with `events`, `events`
 * wins and `rebuildSession` is the repair. Incremental `apply` never invents
 * content: a turn that produced no assistant text gets no assistant row.
 *
 * Blob restore is deliberately not performed here. A transcript is a UI view,
 * so the persisted (preview) form of an oversized field is what belongs in a
 * message row; the full body stays behind its `outputRef`.
 *
 * ## Why this used to be quadratic (§8.2)
 *
 * Every `text.delta` re-`SELECT`ed the turn's messages, re-parsed the growing
 * `content_json` and rewrote the whole row — so streaming N bytes cost
 * O(N²) bytes written. Two changes remove it:
 *
 *  1. the open assistant row is held in memory (`openByTurn`), so a delta costs
 *     one string append instead of a query plus a parse;
 *  2. with `maxPendingChars > 0` the row is only rewritten once that many
 *     characters have accumulated (and always on a non-delta event, on
 *     `turn.completed`, on `flush()` and on rebuild), so the rewrite count is
 *     bounded by the message size rather than by the number of deltas.
 *
 * Both are transparent to the §8.3 invariant: the in-memory content is a cache
 * of the row, it is flushed before anything reads the table for that turn, and
 * `rebuildSession` always reproduces the same result from `events` alone.
 */

import { nowIso, ulid } from '@ucad/observability';
import type {
  FileChangedPayload,
  TextDeltaPayload,
  ToolCompletedPayload,
  ToolStartedPayload,
  ToolUpdatedPayload,
  TurnEvent,
} from '@ucad/contracts';
import type { Database } from './database';
import { rowToTurnEvents } from './event-row';
import type { EventRow } from './event-row';

export type MessageRole = 'user' | 'assistant' | 'tool' | 'system';

/** Matches the `MessageDto` content shape consumed by `@ucad/session` (§3). */
export interface MessageContent {
  text: string;
  toolCallId?: string;
  toolName?: string;
  toolStatus?: string;
  outputRef?: string;
  fileChanges?: Array<{
    path: string;
    operation: string;
    previousPath?: string;
    diffRef?: string;
    detectedBy: string;
  }>;
  /** §8.3: written by `turn.completed`; after sealing a turn starts a new row */
  sealed?: boolean;
}

/** Upper bound on the text a single tool message keeps inline. */
const MAX_TOOL_TEXT_CHARS = 4000;

/**
 * §8.2 — characters of buffered assistant text before the row is rewritten.
 *
 * The default is `0`, i.e. "rewrite the row on every delta", which is the
 * historical behaviour and what a caller that reads the table straight after
 * `apply()` (as the contract tests do) expects. `EventAdmissionPipeline`
 * enables buffering for the real streaming path; see the report for why the
 * default could not change without breaking that contract.
 */
const DEFAULT_MAX_PENDING_CHARS = 0;

export interface MessageProjectorOptions {
  /**
   * §8.2 — how much assistant text may accumulate in memory before the
   * `messages` row is rewritten. `0` writes on every delta.
   */
  maxPendingChars?: number;
}

interface MessageRow {
  id: string;
  session_id: string;
  turn_id: string;
  role: string;
  content_json: string;
  produced_from_seq: number | null;
  created_at: string;
}

/** The in-memory view of the open assistant row of one turn (§8.2 hot path). */
interface OpenMessage {
  /** the agent's own `text.delta.messageId`; also the row id on first write */
  messageId: string;
  /** `undefined` until the first delta creates the row */
  row: MessageRow | undefined;
  content: MessageContent;
  /** characters appended since the row was last written */
  pendingChars: number;
  /** highest seq folded into `content` */
  seq: number;
}

/** Cache key: one open assistant row per turn. */
function turnKey(sessionId: string, turnId: string): string {
  return `${sessionId}\u0000${turnId}`;
}

function parseContent(json: string): MessageContent {
  try {
    const parsed = JSON.parse(json) as Partial<MessageContent>;
    return { ...parsed, text: typeof parsed.text === 'string' ? parsed.text : '' };
  } catch {
    return { text: '' };
  }
}

function clip(text: string): string {
  return text.length <= MAX_TOOL_TEXT_CHARS
    ? text
    : `${text.slice(0, MAX_TOOL_TEXT_CHARS)}… [${text.length} chars]`;
}

export class MessageProjector {
  /** turn key -> its open assistant row. Cleared on seal / rebuild. */
  private readonly openByTurn = new Map<string, OpenMessage>();
  private readonly maxPendingChars: number;

  constructor(private readonly db: Database, opts: MessageProjectorOptions = {}) {
    this.maxPendingChars = Math.max(0, opts.maxPendingChars ?? DEFAULT_MAX_PENDING_CHARS);
  }

  /** Incremental projection of one already-persisted event. */
  async apply(event: TurnEvent): Promise<void> {
    this.applySync(event);
  }

  /**
   * §8.3: `messages` must be reconstructible from the event stream alone.
   * Replay is ordered by `seq` and runs in one transaction.
   */
  async rebuildSession(sessionId: string): Promise<void> {
    this.db.transaction(() => {
      // The cache describes rows that the replay is about to delete.
      this.openByTurn.clear();
      this.db.driver.run('DELETE FROM messages WHERE session_id = ?', [sessionId]);
      const rows = this.db.driver.all<EventRow>(
        'SELECT * FROM events WHERE session_id = ? ORDER BY seq ASC',
        [sessionId],
      );
      for (const row of rows) {
        for (const event of rowToTurnEvents(this.db, row)) {
          this.applySync(event);
        }
      }
    });
  }

  /**
   * Writes every buffered row. Shutdown and any caller that needs the
   * transcript to be on disk before reading it must call this; §8.3 makes the
   * buffer safe because `rebuildSession` can always reproduce it.
   */
  flush(): void {
    for (const [key, open] of [...this.openByTurn]) {
      if (open.pendingChars > 0) this.persist(key, open);
    }
  }

  // -------------------------------------------------------------------------

  private applySync(event: TurnEvent): void {
    switch (event.type) {
      case 'text.delta':
        this.onTextDelta(event);
        return;
      case 'tool.started':
      case 'tool.updated':
      case 'tool.completed':
        this.onToolEvent(event);
        return;
      case 'file.changed':
        this.onFileChanged(event);
        return;
      case 'turn.completed':
        this.onTurnCompleted(event);
        return;
      default:
        // context.* / permission.* / decision.* / usage / error / ... are
        // surfaced through events and the activity tables, not the transcript.
        return;
    }
  }

  /** §8.3: append to the current turn's assistant message. O(1) per delta. */
  private onTextDelta(event: TurnEvent): void {
    const payload = event.payload as TextDeltaPayload;
    const key = turnKey(event.sessionId, event.turnId);
    const open = this.openAssistant(key, event, payload.messageId);

    open.content.text += payload.text;
    open.pendingChars += payload.text.length;
    open.seq = event.seq;

    if (this.maxPendingChars === 0 || open.pendingChars >= this.maxPendingChars) {
      this.persist(key, open);
    }
  }

  /**
   * The turn's open assistant row, loaded from the table at most once per turn.
   * A `messageId` change starts a new row, so the previous one is written out
   * first — exactly what the query-based path used to do implicitly.
   */
  private openAssistant(
    key: string,
    event: TurnEvent,
    messageId: string,
  ): OpenMessage {
    const cached = this.openByTurn.get(key);
    if (cached !== undefined) {
      if (cached.messageId === messageId) return cached;
      this.persist(key, cached);
      this.openByTurn.delete(key);
    }

    const existing = this.findMessage(
      event,
      (content) => content.sealed !== true && content.toolCallId === undefined,
    );
    const open: OpenMessage = {
      messageId,
      row: existing,
      content: existing ? parseContent(existing.content_json) : { text: '' },
      pendingChars: 0,
      seq: existing?.produced_from_seq ?? 0,
    };
    this.openByTurn.set(key, open);
    return open;
  }

  /** Writes the cached content back to `messages` (or creates the row). */
  private persist(key: string, open: OpenMessage): void {
    const row = open.row;
    if (row !== undefined) {
      this.update(row, open.content, open.seq);
      open.pendingChars = 0;
      return;
    }

    // §0: ids come from `ulid('prefix_')`; `text.delta` supplies the agent's
    // own messageId, which is already a Ucad id.
    const parts = key.split('\u0000');
    const createdAt = nowIso();
    const json = JSON.stringify(open.content);
    this.db.driver.run(
      `INSERT INTO messages(id, session_id, turn_id, role, content_json, produced_from_seq, created_at)
       VALUES(?, ?, ?, ?, ?, ?, ?)`,
      [open.messageId, parts[0] ?? '', parts[1] ?? '', 'assistant', json, open.seq, createdAt],
    );
    open.row = {
      id: open.messageId,
      session_id: parts[0] ?? '',
      turn_id: parts[1] ?? '',
      role: 'assistant',
      content_json: json,
      produced_from_seq: open.seq,
      created_at: createdAt,
    };
    open.pendingChars = 0;
  }

  /** §8.3: create / update a tool message part. */
  private onToolEvent(event: TurnEvent): void {
    const toolCallId =
      event.type === 'tool.started'
        ? (event.payload as ToolStartedPayload).toolCallId
        : event.type === 'tool.updated'
          ? (event.payload as ToolUpdatedPayload).toolCallId
          : (event.payload as ToolCompletedPayload).toolCallId;

    const existing = this.findMessage(
      event,
      (content) => content.toolCallId === toolCallId,
    );
    const content: MessageContent = existing ? parseContent(existing.content_json) : { text: '' };
    content.toolCallId = toolCallId;

    if (event.type === 'tool.started') {
      const payload = event.payload as ToolStartedPayload;
      content.toolName = payload.name;
      content.toolStatus = 'running';
    } else if (event.type === 'tool.updated') {
      const payload = event.payload as ToolUpdatedPayload;
      if (payload.progress !== undefined) content.text = clip(payload.progress);
      if (payload.partialOutput !== undefined) {
        content.text = clip(`${content.text}${payload.partialOutput}`);
      }
    } else {
      const payload = event.payload as ToolCompletedPayload;
      content.toolStatus = payload.status;
      if (payload.outputPreview !== undefined && payload.outputPreview !== '') {
        content.text = clip(payload.outputPreview);
      }
      if (payload.outputRef !== undefined) content.outputRef = payload.outputRef;
    }

    this.write(existing, event, 'tool', content);
  }

  /** §8.3: file-change message part (one accumulating row per turn). */
  private onFileChanged(event: TurnEvent): void {
    const payload = event.payload as FileChangedPayload;
    const existing = this.findMessage(
      event,
      (content) => content.toolCallId === undefined && content.fileChanges !== undefined,
    );
    const content: MessageContent = existing ? parseContent(existing.content_json) : { text: '' };
    const changes = content.fileChanges ?? [];
    changes.push({
      path: payload.path,
      operation: payload.operation,
      ...(payload.previousPath !== undefined ? { previousPath: payload.previousPath } : {}),
      ...(payload.diffRef !== undefined ? { diffRef: payload.diffRef } : {}),
      detectedBy: payload.detectedBy,
    });
    content.fileChanges = changes;

    this.write(existing, event, 'tool', content);
  }

  /**
   * §8.3: seal the turn's messages. Nothing is created here — a turn that
   * produced no assistant content must not gain a message row.
   */
  private onTurnCompleted(event: TurnEvent): void {
    // §8.2: the buffered assistant text has to reach the table before the
    // seal, otherwise the sealed row would be missing its last window.
    const key = turnKey(event.sessionId, event.turnId);
    const open = this.openByTurn.get(key);
    if (open !== undefined) {
      this.persist(key, open);
      this.openByTurn.delete(key);
    }

    const rows = this.db.driver.all<MessageRow>(
      `SELECT * FROM messages
        WHERE session_id = ? AND turn_id = ?
        ORDER BY created_at ASC, rowid ASC`,
      [event.sessionId, event.turnId],
    );

    for (const row of rows) {
      const content = parseContent(row.content_json);
      if (content.sealed === true) continue;
      // `turn.completed.messageId` names the final assistant message; every
      // other part of the turn is sealed with it, so no row is ever dropped.
      content.sealed = true;
      this.update(row, content, event.seq);
    }
  }

  /** The open (unsealed) message of this turn that satisfies `match`. */
  private findMessage(
    event: TurnEvent,
    match: (content: MessageContent) => boolean,
  ): MessageRow | undefined {
    // A row this turn's cache still owns may be behind in the table, so it is
    // not a candidate: its content is authoritative in memory, not on disk.
    const owned = this.openByTurn.get(turnKey(event.sessionId, event.turnId))?.row?.id;
    const rows = this.db.driver.all<MessageRow>(
      `SELECT * FROM messages
        WHERE session_id = ? AND turn_id = ?
        ORDER BY created_at ASC, rowid ASC`,
      [event.sessionId, event.turnId],
    );
    for (const row of rows) {
      if (row.id === owned) continue;
      const content = parseContent(row.content_json);
      if (content.sealed === true) continue;
      if (match(content)) return row;
    }
    return undefined;
  }

  private write(
    existing: MessageRow | undefined,
    event: TurnEvent,
    role: MessageRole,
    content: MessageContent,
    preferredId?: string,
  ): void {
    if (existing !== undefined) {
      this.update(existing, content, event.seq);
      return;
    }
    // §0: ids always come from `ulid('prefix_')`; `text.delta` supplies the
    // agent's own messageId, which is already a Ucad id.
    const id = preferredId !== undefined && preferredId !== '' ? preferredId : ulid('msg_');
    this.db.driver.run(
      `INSERT INTO messages(id, session_id, turn_id, role, content_json, produced_from_seq, created_at)
       VALUES(?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        event.sessionId,
        event.turnId,
        role,
        JSON.stringify(content),
        event.seq,
        nowIso(),
      ],
    );
  }

  /** `produced_from_seq` always names the highest seq that shaped the row. */
  private update(row: MessageRow, content: MessageContent, seq: number): void {
    this.db.driver.run(
      'UPDATE messages SET content_json = ?, produced_from_seq = ? WHERE id = ?',
      [JSON.stringify(content), seq, row.id],
    );
  }
}
