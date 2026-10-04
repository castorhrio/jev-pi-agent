/**
 * §7.2 `file.changed` production. Injected into `FileService` so Main owns the
 * lifecycle (and can swap in a chokidar-backed implementation later) while the
 * path rules stay in one place.
 *
 * The watcher is deliberately non-recursive: `fs.watch` on the workspace root
 * only, and every event is canonicalized again by the caller before it is
 * trusted, so a rename into the tree cannot smuggle an external path through.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Unsubscribe } from '@ucad/contracts';

export type FileOperation = 'create' | 'modify' | 'delete';

export interface FileChangeEvent {
  path: string;
  operation: FileOperation;
}

/** The seam `FileService` consumes (§9 constructor). */
export interface FsWatcherLike {
  watch(dir: string, cb: (event: FileChangeEvent) => void): Unsubscribe;
}

export interface FsWatcherOptions {
  /** Coalescing window; editors emit several raw events per save. */
  debounceMs?: number;
}

/**
 * Within one debounce window the strongest transition wins:
 * `create` beats `modify` (a file written twice in one window was created), and
 * `delete` beats both (it is the only state the user cannot undo from the
 * Change list).
 */
const OPERATION_RANK: Readonly<Record<FileOperation, number>> = {
  modify: 1,
  create: 2,
  delete: 3,
};

/**
 * Raw `fs.watch` events carry `rename` for create/delete and `change` for
 * content. Which one it was can only be told apart by looking at the disk, so
 * that is exactly what this does.
 */
function operationFor(eventType: string, fullPath: string): FileOperation {
  const exists = fs.existsSync(fullPath);
  if (eventType === 'rename') {
    return exists ? 'create' : 'delete';
  }
  return exists ? 'modify' : 'delete';
}

export function createFsWatcher(opts: FsWatcherOptions = {}): FsWatcherLike {
  const debounceMs = opts.debounceMs ?? 50;

  return {
    watch(dir: string, cb: (event: FileChangeEvent) => void): Unsubscribe {
      if (typeof dir !== 'string' || dir.length === 0) {
        throw new Error('watch: dir must be a non-empty string');
      }

      const pending = new Map<string, FileOperation>();
      let timer: NodeJS.Timeout | null = null;

      const flush = (): void => {
        timer = null;
        const batch = [...pending.entries()];
        pending.clear();
        for (const [fullPath, operation] of batch) {
          try {
            cb({ path: fullPath, operation });
          } catch {
            // a broken consumer must not take the watcher down
          }
        }
      };

      const watcher = fs.watch(dir, { persistent: false }, (eventType, fileName) => {
        if (typeof fileName !== 'string' || fileName.length === 0) {
          return;
        }
        const fullPath = path.join(dir, fileName);
        const next = operationFor(eventType, fullPath);
        const previous = pending.get(fullPath);
        if (previous === undefined || OPERATION_RANK[next] > OPERATION_RANK[previous]) {
          pending.set(fullPath, next);
        }
        if (timer !== null) {
          clearTimeout(timer);
        }
        timer = setTimeout(flush, debounceMs);
      });

      return () => {
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        watcher.close();
      };
    },
  };
}
