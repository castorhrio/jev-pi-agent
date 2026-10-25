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
import { IPC_CHANNELS, codedError } from '@ucad/contracts';
import type { RetentionService } from '@ucad/session';
import type { StoragePurgeScope } from '@ucad/contracts';
import type { UcadApp } from './app-container';

/** Identity wrapper kept for the same readability reason as in `ipc.ts`. */
function ok<A extends unknown[], R>(fn: (...args: A) => R | Promise<R>) {
  return fn;
}

const purgeScopeSchema = z.enum(['expired', 'workspace', 'all']);

/** §8.4: a positive number of days, or `null` for "keep forever". */
const retentionSchema = z.union([z.number().int().positive(), z.null()]);

/**
 * `confirm` is a literal `true`, not a boolean.
 *
 * A field that only ever means "yes" should not be able to carry "no": with
 * `z.boolean().optional()` the two failure modes — a caller that forgot the
 * field and a caller that sent `false` — both arrived as a well-formed request
 * and were refused by a hand-written branch below, which is a second, weaker
 * input contract next to the one every other channel has. The hand-written
 * branch also answered `PERMISSION_DENIED`, so a request the schema could have
 * rejected as malformed was reported as a permission problem — and that is the
 * code a person reads as "the app does not let me do this", not "the request
 * was wrong".
 *
 * So the refusal happens where every other input refusal happens: here, in Zod,
 * which `toUserError` turns into 「输入无效 (confirm)」. A real permission
 * decision (the project is untrusted, the path is outside the workspace) keeps
 * its own code unchanged.
 *
 * The sentence is the one a person reads, so it is written once here and it has
 * to come out in Chinese for *every* way of not confirming. `z.literal(true,
 * { message })` did not: a missing field produced the sentence, but `false`,
 * `"true"`, `1` and `null` fell through to Zod's own `Invalid literal value,
 * expected true` — English, and about a type rather than about confirming a
 * deletion. The realistic caller is a UI that sends `confirm: false`, so the
 * half that worked was the half that never happens. An explicit refinement is
 * the version that covers the whole field: `unknown`, so no shape gets past it
 * with a second opinion, then a transform so the parsed type is still exactly
 * `true`.
 */
const PURGE_UNCONFIRMED = '清理未确认：请先预览要删除的内容，再确认一次。';

const confirmSchema = z
  .unknown()
  .superRefine((value, ctx) => {
    if (value !== true) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: PURGE_UNCONFIRMED });
    }
  })
  .transform(() => true as const);

const purgeRequestSchema = z.object({
  scope: purgeScopeSchema,
  workspaceId: z.string().min(1).optional(),
  confirm: confirmSchema,
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

  /**
   * The retention service Main owns.
   *
   * This layer used to build its own, lazily, on first use — a second instance
   * of a service that already existed, with its own view of the same
   * database. A purge and the retention sweep could then disagree about what
   * was left on disk. Main hands out the one instance instead, so there is a
   * single answer to "what is still stored".
   */
  const service = (): RetentionService => ucad.getRetention();

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
      // Irreversible, so the UI has to have previewed and the user confirmed.
      // The confirmation is now part of the schema, which is what makes
      // `previewPurge` a promise rather than a suggestion — and what makes an
      // unconfirmed purge a malformed request rather than a permission problem.
      const parsed = purgeRequestSchema.parse(request);
      if (parsed.scope === 'workspace' && parsed.workspaceId === undefined) {
        // Not a storage fault: there is simply no project to scope the purge
        // to. Wrapping the sentence in `new Error(...)` kept the message and
        // dropped the code, so the log line for this refusal read `UNKNOWN`.
        throw codedError(
          'NO_ACTIVE_WORKSPACE',
          '没有已打开的项目，无法清理本项目的对话。',
          'ipc',
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
