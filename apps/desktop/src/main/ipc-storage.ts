/**
 * §8.4 存储保护与保留 — IPC surface for the Settings / Storage pane.
 *
 * Split out of `ipc.ts` because `ipc.ts` owns the `handle` wrapper (which
 * converts an `AppError` into a user-safe `Error` before it crosses the bridge,
 * §7.2) and this file only declares what the storage channels do. The wrapper
 * is injected rather than re-implemented, so the storage handlers cannot
 * accidentally grow a second, weaker error path.
 *
 * The one rule this layer adds on top of `ipc.ts`: a purge is irreversible, so
 * it is refused unless the caller has previewed it and confirmed. `confirm` is
 * not a formality — it is the only thing standing between a mis-clicked button
 * and a deleted transcript.
 */

import type { BrowserWindow } from 'electron';
import { z } from 'zod';
import { IPC_CHANNELS, appError } from '@ucad/contracts';
import { RetentionService } from '@ucad/session';
import type { StoragePurgeScope } from '@ucad/contracts';
import type { UcadApp } from './app-container';

/** Identity wrapper kept for the same readability reason as in `ipc.ts`. */
function ok<A extends unknown[], R>(fn: (...args: A) => R | Promise<R>) {
  return fn;
}

const purgeScopeSchema = z.enum(['expired', 'workspace', 'all']);

/** §8.4: a positive number of days, or `null` for "keep forever". */
const retentionSchema = z.union([z.number().int().positive(), z.null()]);

const purgeRequestSchema = z.object({
  scope: purgeScopeSchema,
  workspaceId: z.string().min(1).optional(),
  confirm: z.boolean().optional(),
});

export interface StorageIpcDeps {
  /**
   * The same wrapper `registerIpc` builds: it logs the full `AppError` and
   * rejects with a user-safe `Error` message.
   */
  handle: (channel: string, fn: (...args: unknown[]) => unknown) => void;
  ucad: UcadApp;
  getWindow: () => BrowserWindow | null;
}

export function registerStorageIpc(deps: StorageIpcDeps): void {
  const { handle, ucad } = deps;
  let retention: RetentionService | null = null;

  /**
   * Built on first use, not at registration: `UcadApp` fills `db`, `blobs` and
   * `sessionStore` in `start()`, and a service constructed earlier would hold
   * them undefined.
   */
  const service = (): RetentionService => {
    if (retention === null) {
      retention = new RetentionService({
        db: ucad.db,
        sessionStore: ucad.sessionStore,
        blobs: ucad.blobs,
        logger: ucad.logger,
        dbPath: ucad.paths.dbPath,
      });
    }
    return retention;
  };

  // ------------------------------------------------------------------ usage
  handle(
    IPC_CHANNELS.storage.usage,
    ok(async () => service().usage()),
  );

  // -------------------------------------------------------------- retention
  handle(
    IPC_CHANNELS.storage.setRetention,
    ok(async (days: unknown) => {
      const parsed = retentionSchema.parse(days);
      return ucad.sessionStore.patchSettings({ storage: { retentionDays: parsed } });
    }),
  );

  // ----------------------------------------------------------------- purges
  handle(
    IPC_CHANNELS.storage.previewPurge,
    ok(async (scope: unknown, workspaceId?: unknown) => {
      const parsedScope: StoragePurgeScope = purgeScopeSchema.parse(scope);
      const parsedWorkspace =
        workspaceId === undefined || workspaceId === null
          ? undefined
          : z.string().min(1).parse(workspaceId);
      return service().preview(parsedScope, parsedWorkspace);
    }),
  );

  handle(
    IPC_CHANNELS.storage.purge,
    ok(async (request: unknown) => {
      const parsed = purgeRequestSchema.parse(request);
      // Irreversible, so the UI has to have previewed and the user confirmed.
      // Refusing here is what makes `previewPurge` a promise rather than a
      // suggestion.
      if (parsed.confirm !== true) {
        throw new Error(
          appError(
            'PERMISSION_DENIED',
            '清理未确认：请先预览要删除的内容，再确认一次。',
            'ipc',
          ).message,
        );
      }
      if (parsed.scope === 'workspace' && parsed.workspaceId === undefined) {
        throw new Error(
          appError('STORAGE_ERROR', '没有已打开的项目，无法清理本项目的对话。', 'ipc').message,
        );
      }
      return service().purge(parsed.scope, parsed.workspaceId);
    }),
  );

  handle(
    IPC_CHANNELS.storage.collectOrphanBlobs,
    ok(async () => service().collectOrphanBlobs()),
  );
}
