/**
 * @ucad/files — §7.2 Renderer / Agent file channel.
 *
 * The only package in UCAD allowed to turn a caller-supplied string into a
 * filesystem path.
 */

export { FileService } from './file-service';
export type {
  FileListInput,
  FileReadInput,
  FileServiceOptions,
  FileWriteInput,
  FileWriteSessionContext,
} from './file-service';

export { canonicalize, isInside, realpathBestEffort } from './paths';
export type { CanonicalPath } from './paths';

export { createFsWatcher } from './watcher';
export type { FileChangeEvent, FileOperation, FsWatcherLike, FsWatcherOptions } from './watcher';

export { AppErrorThrow, isAppError } from './errors';
