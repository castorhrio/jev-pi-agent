/** §4.3 the three state machines. All three gained `INTERRUPTED` (B10). */

export type SessionState =
  | 'CREATED'
  | 'READY'
  | 'RUNNING'
  | 'WAITING_PERMISSION'
  | 'CANCELLING'
  | 'INTERRUPTED'
  | 'FAILED'
  | 'CLOSED';

export type TurnState =
  | 'PENDING'
  | 'RUNNING'
  | 'WAITING_PERMISSION'
  | 'CANCELLING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'
  | 'INTERRUPTED';

export type AgentSessionState = 'active' | 'closed' | 'orphaned' | 'interrupted';

export type InterruptedReason =
  | 'host_exited'
  | 'host_unresponsive'
  | 'app_crash_recovery'
  | 'user_stop_timeout';

export const SESSION_TRANSITIONS: Readonly<Record<SessionState, ReadonlyArray<SessionState>>> = {
  CREATED: ['READY', 'FAILED', 'CLOSED'],
  READY: ['RUNNING', 'CLOSED', 'INTERRUPTED', 'FAILED'],
  RUNNING: ['READY', 'WAITING_PERMISSION', 'CANCELLING', 'INTERRUPTED', 'FAILED'],
  WAITING_PERMISSION: ['RUNNING', 'CANCELLING', 'INTERRUPTED', 'FAILED', 'READY'],
  CANCELLING: ['READY', 'INTERRUPTED', 'FAILED', 'CLOSED'],
  INTERRUPTED: ['READY', 'CLOSED'],
  FAILED: ['READY', 'CLOSED'],
  CLOSED: [],
};

export const TURN_TRANSITIONS: Readonly<Record<TurnState, ReadonlyArray<TurnState>>> = {
  PENDING: ['RUNNING', 'CANCELLED', 'INTERRUPTED', 'FAILED'],
  RUNNING: [
    'WAITING_PERMISSION',
    'CANCELLING',
    'COMPLETED',
    'FAILED',
    'INTERRUPTED',
  ],
  WAITING_PERMISSION: ['RUNNING', 'CANCELLING', 'INTERRUPTED', 'FAILED'],
  CANCELLING: ['CANCELLED', 'INTERRUPTED', 'FAILED'],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
  INTERRUPTED: [],
};

export function canTransitionSession(from: SessionState, to: SessionState): boolean {
  return SESSION_TRANSITIONS[from].includes(to);
}

export function canTransitionTurn(from: TurnState, to: TurnState): boolean {
  return TURN_TRANSITIONS[from].includes(to);
}

export function isTerminalSessionState(s: SessionState): boolean {
  return s === 'CLOSED';
}

export function isTerminalTurnState(t: TurnState): boolean {
  return t === 'COMPLETED' || t === 'FAILED' || t === 'CANCELLED' || t === 'INTERRUPTED';
}

/** S-4: turns left non-terminal by a crash are recovered this way on boot. */
export const CRASH_RECOVERABLE_TURN_STATES: ReadonlyArray<TurnState> = [
  'RUNNING',
  'WAITING_PERMISSION',
  'CANCELLING',
];

export type TrustState = 'untrusted' | 'trusted' | 'restricted';
