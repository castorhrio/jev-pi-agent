/**
 * @ucad/session — §3 SessionStore: workspace / session / turn persistence, the
 * three state machines of §4.3, crash recovery (S-4/S-5), §4.12.1
 * `ContextHandoff` replay and the §7.2 settings snapshot.
 *
 * `seq` is never allocated here: the injected `SessionSequencer` is the only
 * allocator (§5.2 SEQ-1).
 */

export { SessionStore } from './session-store';
export type { SessionStoreOptions } from './session-store';

export { SessionError, fail } from './errors';

export { toMessageDto, toDecisionRecord } from './dto';
export type { DecisionRecordDto, MessageDto } from './dto';

export { buildContextHandoff } from './handoff';
export type { HandoffInput, HandoffSession, HandoffTurn } from './handoff';

export {
  applySettingsPatch,
  CONTEXT_STRATEGIES,
  deepMerge,
  DEFAULT_RETENTION_DAYS,
  DEFAULT_SETTINGS,
  normalizeSettings,
  PERMISSION_MODES,
  SETTINGS_KEY,
  TOKEN_ESTIMATE_SOURCES,
} from './defaults';

export type {
  AppendEventInputLike,
  AppendEventResultLike,
  DatabaseLike,
  EventLogLike,
  RunResultLike,
  SessionSequencerLike,
  SqlDriverLike,
} from './db-types';

// §8.4 存储保护与保留
export { RetentionService } from './retention';
export type { RetentionServiceOptions } from './retention';
