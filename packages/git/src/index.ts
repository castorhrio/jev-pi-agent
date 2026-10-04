/**
 * @ucad/git — §9 GitService over the system Git CLI.
 *
 * Every invocation is an argv array with `shell: false`; there is no code path
 * in this package that builds a command string (§11.1).
 */

export { GitService } from './git-service';
export type { GitDiffInput, GitServiceOptions } from './git-service';

export { createGitCli, sanitiseStderr } from './git-cli';
export type { GitCli, GitCliOptions, GitRunOptions } from './git-cli';

export {
  EMPTY_HEAD,
  parseBranchHeader,
  parsePorcelainStatus,
  toGitStatusDto,
  unquotePorcelainPath,
} from './porcelain';
export type { PorcelainParseResult, PorcelainStatusEntry } from './porcelain';

export { AppErrorThrow, isAppError } from './errors';
