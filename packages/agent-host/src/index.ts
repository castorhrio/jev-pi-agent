/**
 * `@ucad/agent-host` — §6.1 Agent Host process and Host-side runner.
 *
 * Main owns {@link AgentHostProcess} (fork + handshake + NFR-05 cancel
 * escalation); the forked child runs {@link AgentHostRunner} over a real
 * `AgentAdapter`. `child_process` is mandatory (NFR-02).
 */

export { frame, isProtocolFrame, isMainFrame, parseHostFrame } from './frame';
export type { HostFrame } from './frame';

export {
  AgentHostProcess,
  resolveHostEntry,
  DEFAULT_HANDSHAKE_TIMEOUT_MS,
  DEFAULT_CANCEL_GRACE_MS,
  DEFAULT_DISPOSE_GRACE_MS,
} from './agent-host-process';
export type { AgentHostOptions, AgentHostExitInfo, HostInitializePayload } from './agent-host-process';

export {
  AgentHostRunner,
  processTransport,
  normalizePermissionRequest,
  DEFAULT_HEARTBEAT_MS,
  DEFAULT_PERMISSION_TIMEOUT_MS,
} from './agent-host-runner';
export type { AgentHostRunnerOptions, HostTransport } from './agent-host-runner';

export { main as runHostEntry, parseHostArgs, resolveAdapterFactory } from './host-entry';
export type { HostEntryArgs } from './host-entry';
