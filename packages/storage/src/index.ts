/**
 * @ucad/storage — the schema owner of the UCAD desktop app.
 *
 * Implements the @ucad/contracts DTOs:
 *  - `openDatabase` / `SqlDriver`  : the single node-sqlite3-wasm wrapper
 *  - `Database`                    : schema, migrations (NFR-07), at-rest (NFR-15)
 *  - `SessionSequencer`            : §5.2 SEQ-1, the only allocator of `seq`
 *  - `EventLog`                    : §8.2 writes, SEQ-6 admission, NFR-06 blobs
 *  - `MessageProjector`            : §8.3 events -> messages, purely derived
 *
 * Table ownership (§0): this package writes `schema_version`, `events`,
 * `messages` and `blobs`; every other table is created by the same ordered
 * migration set but is only ever written by the package that owns it.
 */

export { openDatabase } from './driver';
export type { RunResult, SqlDriver } from './driver';

export { Database } from './database';
export type { DatabaseOptions, DatabaseProtection, MigrationResult } from './database';

export { SessionSequencer } from './sequencer';
export { MessageProjector } from './message-projector';
export type { MessageContent, MessageRole } from './message-projector';
export { EventLog } from './event-log';
export type { AppendEventInput, AppendEventResult } from './event-log';
export type { CoalescedDeltaMeta, EventRow, StoredEnvelope } from './event-row';
export { MessageProjectorOptions } from './message-projector';
