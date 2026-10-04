/**
 * §6.1 protocol frame codec.
 *
 * Transport is `child_process.fork()` (§6.3) carrying **newline-delimited JSON
 * over the fork IPC channel** — never stdout parsing. `worker_threads`' implicit
 * MessagePort is explicitly not assumed (NFR-02: any adapter that executes user
 * code MUST run in a real child process).
 *
 * Every frame on the wire is `{ protocolVersion, op, payload }`. A frame whose
 * `protocolVersion` differs from `HOST_PROTOCOL_VERSION` is ignored on both
 * ends, so a stale host can never be mistaken for a live one.
 */

import { HOST_PROTOCOL_VERSION, isAgentHostMessage } from '@ucad/contracts';
import type { AgentHostToMain, MainToAgentHost } from '@ucad/contracts';

/** A wire frame is a contract message plus the protocol version tag. */
export type HostFrame<M> = { protocolVersion: number } & M;

/** Stamps a contract message into a wire frame. */
export function frame<M extends { op: string }>(msg: M): HostFrame<M> {
  return { ...msg, protocolVersion: HOST_PROTOCOL_VERSION };
}

interface UntaggedFrame {
  protocolVersion: number;
  op: string;
}

function asUntaggedFrame(value: unknown): UntaggedFrame | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as { protocolVersion?: unknown; op?: unknown };
  if (typeof candidate.protocolVersion !== 'number') return null;
  if (typeof candidate.op !== 'string') return null;
  return { protocolVersion: candidate.protocolVersion, op: candidate.op };
}

/** true when the frame carries the protocol version this build speaks. */
export function isProtocolFrame(value: unknown): value is UntaggedFrame {
  return asUntaggedFrame(value) !== null;
}

/** Host -> Main. Rejects version mismatches and structurally invalid frames. */
export function parseHostFrame(raw: unknown): AgentHostToMain | null {
  if (!isProtocolFrame(raw)) return null;
  if (raw.protocolVersion !== HOST_PROTOCOL_VERSION) return null;
  if (!isAgentHostMessage(raw)) return null;
  return raw;
}

/** Main -> Host. Mirrors `isAgentHostMessage` for the inbound direction. */
export function isMainFrame(value: unknown): value is UntaggedFrame & MainToAgentHost {
  if (!isProtocolFrame(value)) return false;
  if (value.protocolVersion !== HOST_PROTOCOL_VERSION) return false;
  if (!('payload' in (value as object))) return false;
  return true;
}
