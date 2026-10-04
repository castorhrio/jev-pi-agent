/**
 * §3 DTOs exposed by `SessionStore`, and the tolerant row mappers behind them.
 *
 * `messages` is a *derived* projection owned by `@ucad/storage`
 * (`MessageProjector`, §8.3); the row shape therefore depends on the storage
 * schema version. The mappers read whatever the row provides instead of
 * assuming one fixed column set, so a projection layout change cannot produce
 * `undefined` fields in the Renderer-facing DTOs.
 */

import type {
  DecisionKind,
  DecisionOutcome,
  DecisionResult,
  FileChangeNotice,
} from '@ucad/contracts';

/** §3 `MessageDto`. */
export interface MessageDto {
  id: string;
  sessionId: string;
  turnId: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  text: string;
  toolName?: string;
  toolStatus?: string;
  fileChanges?: FileChangeNotice[];
  producedFromSeq: number;
  createdAt: string;
}

/** §3 `DecisionRecordDto` — a `decisions` row with its parsed payload. */
export interface DecisionRecordDto {
  id: string;
  sessionId: string;
  turnId: string;
  requestId: string;
  kind: DecisionKind;
  outcome: DecisionOutcome;
  confidence: number;
  /** NFR-16: a decision without a rationale is not recorded. */
  rationale: string;
  engineId: string;
  engineVersion: string | null;
  /** D-2: a fallback must leave a trace. */
  fallback?: DecisionResult['fallback'];
  latencyMs: number;
  createdAt: string;
}

const MESSAGE_ROLES = new Set(['user', 'assistant', 'tool', 'system']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(source: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string') {
      return value;
    }
  }
  return undefined;
}

function readNumber(source: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function readFileChanges(source: Record<string, unknown>): FileChangeNotice[] | undefined {
  for (const key of ['fileChanges', 'file_changes', 'changes']) {
    const value = source[key];
    if (!Array.isArray(value)) {
      continue;
    }
    const changes: FileChangeNotice[] = [];
    for (const item of value) {
      if (!isRecord(item)) {
        continue;
      }
      const path = readString(item, ['path']);
      if (path === undefined) {
        continue;
      }
      changes.push({ path, operation: readString(item, ['operation']) ?? 'modify' });
    }
    return changes;
  }
  return undefined;
}

function parseJson(text: unknown): Record<string, unknown> {
  if (isRecord(text)) {
    return text;
  }
  if (typeof text !== 'string' || text === '') {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Map a `messages` row to {@link MessageDto}. Never returns undefined members. */
export function toMessageDto(row: Record<string, unknown>): MessageDto {
  const content = parseJson(row['content_json'] ?? row['contentJson']);
  const rawRole = readString(row, ['role']) ?? readString(content, ['role']);
  const role = rawRole !== undefined && MESSAGE_ROLES.has(rawRole)
    ? (rawRole as MessageDto['role'])
    : 'system';

  const text =
    readString(content, ['text', 'content', 'body']) ??
    readString(row, ['text', 'content']) ??
    '';

  const toolName = readString(content, ['toolName', 'tool_name', 'name']) ?? readString(row, ['tool_name']);
  const toolStatus =
    readString(content, ['toolStatus', 'tool_status', 'status']) ?? readString(row, ['tool_status']);
  const fileChanges = readFileChanges(content) ?? readFileChanges(row);

  return {
    id: readString(row, ['id']) ?? '',
    sessionId: readString(row, ['session_id']) ?? readString(row, ['sessionId']) ?? '',
    turnId: readString(row, ['turn_id']) ?? readString(row, ['turnId']) ?? '',
    role,
    text,
    ...(toolName !== undefined ? { toolName } : {}),
    ...(toolStatus !== undefined ? { toolStatus } : {}),
    ...(fileChanges !== undefined ? { fileChanges } : {}),
    producedFromSeq: readNumber(row, ['produced_from_seq', 'producedFromSeq']) ?? 0,
    createdAt: readString(row, ['created_at', 'createdAt']) ?? '',
  };
}

/** Map a `decisions` row to {@link DecisionRecordDto}. */
export function toDecisionRecord(row: Record<string, unknown>): DecisionRecordDto {
  const outcome = parseJson(row['outcome_json'] ?? row['outcomeJson']);
  const fallbackRaw = row['fallback_json'] ?? row['fallbackJson'];
  const fallbackParsed = parseJson(fallbackRaw);
  const fallback =
    fallbackParsed['used'] === true
      ? (fallbackParsed as unknown as DecisionResult['fallback'])
      : undefined;

  return {
    id: readString(row, ['id']) ?? '',
    sessionId: readString(row, ['session_id']) ?? '',
    turnId: readString(row, ['turn_id']) ?? '',
    requestId: readString(row, ['request_id']) ?? '',
    kind: (readString(row, ['kind']) ?? 'clarify') as DecisionKind,
    outcome: outcome as unknown as DecisionOutcome,
    confidence: readNumber(row, ['confidence']) ?? 0,
    rationale: readString(row, ['rationale']) ?? '',
    engineId: readString(row, ['engine_id']) ?? '',
    engineVersion: readString(row, ['engine_version']) ?? null,
    ...(fallback !== undefined ? { fallback } : {}),
    latencyMs: readNumber(row, ['latency_ms']) ?? 0,
    createdAt: readString(row, ['created_at']) ?? '',
  };
}
