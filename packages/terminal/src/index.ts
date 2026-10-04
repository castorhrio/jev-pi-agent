/**
 * @ucad/terminal — §9 CommandRunner.
 *
 * The only package in UCAD that executes a command on the user's machine.
 */

export { CommandRunner, isAllowDecision } from './command-runner';
export type {
  CommandEventProposal,
  CommandEventSink,
  CommandOutputChunk,
  CommandRunnerOptions,
  CommandRunInput,
  ConsoleDataEvent,
  CreateConsoleInput,
} from './command-runner';

export { killProcessTree, runTaskkill } from './process-tree';

export { AppErrorThrow, isAppError } from './errors';

// §11.2 User Terminal. Additive and separate from the CommandRunner above: this
// is the user's own PTY, not the UCAD-managed agent shell.
export { PtyHost, probePty, resetPtyModuleCache } from './pty-host';
export type {
  PtyAvailability,
  PtyCreateInput,
  PtyDataEvent,
  PtyExitEvent,
  PtyHostOptions,
} from './pty-host';
