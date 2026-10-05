/**
 * §7 IPC registration.
 *
 * Rules enforced here (§7.2):
 *  - every input is validated before it reaches a service
 *  - every path goes through FileService.canonicalize before touching disk
 *  - every failure is returned as a plain `Error` whose message is already
 *    user-safe; vendor errors and AppError internals never cross the bridge
 *  - no response ever carries secret plaintext
 */

import { BrowserWindow, dialog, ipcMain } from 'electron';
import * as path from 'node:path';
import { ZodError, z } from 'zod';
import { IPC_CHANNELS, appError, toAppError } from '@ucad/contracts';
import type { UcadApp } from './app-container';
import { requestHighRiskPermission } from './local-permission';
import type { UpdateService } from './update-service';
import { registerStorageIpc } from './ipc-storage';
import { registerMcpIpc } from './ipc-mcp';
import { recentLogEntries } from './log-tail';
import { isLocale, type Locale } from '../shared/i18n';

const sessionIdSchema = z.string().min(1);
const handoffIdSchema = z.string().min(1);
/** A handoff reference: which session, and which entry inside it. */
const handoffRefSchema = z.object({ sessionId: sessionIdSchema, handoffId: handoffIdSchema });
const claimHandoffSchema = handoffRefSchema.extend({ agentId: z.string().min(1) });
const requestIdSchema = z.string().min(1);
const workspaceIdSchema = z.string().min(1);
const trustSchema = z.enum(['untrusted', 'trusted', 'restricted']);
const permissionDecisionSchema = z.enum([
  'allow_once',
  'allow_session',
  'allow_workspace',
  'deny',
]);
const secretRefSchema = z.object({
  providerId: z.string().min(1).max(64),
  key: z.string().min(1).max(64),
});

function toUserError(error: unknown): Error {
  // A ZodError's .message is a multi-line JSON dump of every issue — valid in
  // a log, hostile in a toast, and it echoes the raw input. One line naming
  // the first failing field is what §7.2 means by user-safe; the full issues
  // stay in the log above.
  if (error instanceof ZodError) {
    const first = error.issues[0];
    const where = first && first.path.length > 0 ? ` (${first.path.join('.')})` : '';
    return new Error(`输入无效${where}${first ? `: ${first.message}` : ''}`);
  }
  const appError = toAppError(error, 'ipc');
  return new Error(appError.message);
}

/**
 * Identity wrapper kept for readability at the call sites: every handler is
 * written as `handle(CHANNEL, ok(async (…) => …))` so the validation body is
 * visually separated from the registration. Error handling lives in `handle`.
 */
function ok<A extends unknown[], R>(fn: (...args: A) => R | Promise<R>) {
  return fn;
}

export interface IpcDeps {
  getLocale: () => Locale;
  setLocale: (locale: Locale) => void;
  getUpdates: () => UpdateService | null;
  /** the product's own version, not Electron's */
  getVersion: () => string;
}

export function registerIpc(
  ucad: UcadApp,
  getWindow: () => BrowserWindow | null,
  deps: IpcDeps,
): void {
  /**
   * Every handler is wrapped once. Inputs are validated inside the handler body
   * with Zod, and any failure is converted to a user-safe `Error` here — the
   * full `AppError` stays in the log so a vendor stack never reaches the
   * Renderer (§7.2).
   */
  const handle = <A extends unknown[]>(
    channel: string,
    fn: (...args: A) => unknown,
  ) => {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (_e, ...args: unknown[]) => {
      try {
        return await fn(...(args as A));
      } catch (error) {
        const appError = toAppError(error, 'ipc');
        ucad.logger.error('ipc handler failed', {
          channel,
          code: appError.code,
          message: appError.message,
        });
        throw toUserError(error);
      }
    });
  };

  // ---------------------------------------------------------------- workspace
  handle(
    IPC_CHANNELS.workspace.open,
    ok(async () => {
      const win = getWindow();
      if (!win) return null;
      const result = await dialog.showOpenDialog(win, {
        properties: ['openDirectory'],
        title: '打开项目文件夹',
      });
      if (result.canceled || result.filePaths.length === 0) return null;
      const dir = result.filePaths[0] as string;
      return ucad.sessionStore.upsertWorkspace({
        path: dir,
        name: path.basename(dir),
      });
    }),
  );

  handle(IPC_CHANNELS.workspace.listRecent, ok(() => ucad.sessionStore.listWorkspaces()));

  /**
   * §12.1 "Recent projects". Without this the only way to change project was the
   * OS folder dialog, so a user with two projects could never go back to the
   * first one — they had to remember its path.
   *
   * The path is re-checked before it is activated: a row can outlive the folder
   * (an unmounted drive, a deleted checkout), and silently "opening" a project
   * that is not there would put the user in an empty Explorer wondering why.
   */
  handle(
    IPC_CHANNELS.workspace.activate,
    ok(async (workspaceId: unknown) => {
      const id = workspaceIdSchema.parse(workspaceId);
      const existing = ucad.sessionStore.getWorkspace(id);
      if (!existing) throw new Error(`项目不存在：${id}`);

      const fs = await import('node:fs');
      if (!fs.existsSync(existing.path) || !fs.statSync(existing.path).isDirectory()) {
        throw new Error(
          `找不到文件夹「${existing.path}」。它可能已被移动、重命名，或者所在的磁盘没有挂载。请重新打开项目。`,
        );
      }
      return ucad.sessionStore.upsertWorkspace({
        path: existing.path,
        name: existing.name,
        trustState: existing.trustState,
      });
    }),
  );

  handle(
    IPC_CHANNELS.workspace.setTrust,
    ok(async (state: unknown) => {
      const parsed = trustSchema.parse(state);
      const list = ucad.sessionStore.listWorkspaces();
      const target = list[0];
      if (!target) {
        throw new Error('没有已打开的项目');
      }
      return ucad.sessionStore.setWorkspaceTrust(target.id, parsed);
    }),
  );

  // ----------------------------------------------------------------- sessions
  handle(
    IPC_CHANNELS.sessions.create,
    ok(async (input: unknown) => {
      const parsed = z
        .object({
          workspaceId: workspaceIdSchema,
          agentId: z.string().min(1),
          providerId: z.string().optional(),
          modelId: z.string().optional(),
          title: z.string().optional(),
          permissionMode: z.enum(['read_only', 'ask', 'workspace_write']),
        })
        .parse(input);
      return ucad.sessionStore.createSession(parsed);
    }),
  );

  handle(
    IPC_CHANNELS.sessions.resume,
    ok(async (sessionId: unknown) => ucad.resumeSession(sessionIdSchema.parse(sessionId))),
  );

  handle(
    IPC_CHANNELS.sessions.list,
    ok((workspaceId: unknown) => {
      // Scoped to the open project. Returning every session from every project
      // put Project B's conversations in Project A's sidebar, and the Renderer
      // auto-selects the first row — so opening one project could land the user
      // in a chat for a different one, with that project's files in the
      // Explorer beside it.
      if (workspaceId === undefined || workspaceId === null) return [];
      return ucad.sessionStore.listSessions(workspaceIdSchema.parse(workspaceId));
    }),
  );

  handle(
    IPC_CHANNELS.sessions.rename,
    ok(async (sessionId: unknown, title: unknown) => {
      ucad.sessionStore.renameSession(sessionIdSchema.parse(sessionId), z.string().min(1).parse(title));
    }),
  );

  handle(
    IPC_CHANNELS.sessions.delete,
    ok(async (sessionId: unknown) => {
      const id = sessionIdSchema.parse(sessionId);
      // §8.4: "清理必须同时清理 blob 目录". The rows that name a blob disappear
      // with the session; the file on disk is what actually holds the bytes, so
      // the delete is only finished once they are unlinked too.
      const purged = ucad.sessionStore.deleteSession(id);
      const blobs = ucad.blobs.deleteMany(purged.blobs);
      ucad.logger.info('session deleted with its blobs', {
        sessionId: id,
        events: purged.events,
        blobFilesRemoved: blobs.removed,
        blobFilesAlreadyGone: blobs.alreadyGone,
      });
    }),
  );

  handle(
    IPC_CHANNELS.sessions.export,
    ok(async (sessionId: unknown, format: unknown) => {
      const id = sessionIdSchema.parse(sessionId);
      const fmt = z.enum(['json', 'markdown']).parse(format);
      const win = getWindow();
      if (!win) throw new Error('窗口不可用');

      const result = await dialog.showSaveDialog(win, {
        title: '导出会话',
        defaultPath: `${id}.${fmt}`,
        filters:
          fmt === 'json'
            ? [{ name: 'JSON', extensions: ['json'] }]
            : [{ name: 'Markdown', extensions: ['md'] }],
      });
      if (result.canceled || !result.filePath) {
        // A user who dismisses the save dialog did not hit an error. Returning a
        // marker instead of throwing keeps "I changed my mind" distinguishable
        // from "the write failed" all the way to the Renderer.
        return { canceled: true as const };
      }

      const body =
        fmt === 'json'
          ? JSON.stringify(
              {
                session: ucad.sessionStore.getSession(id),
                messages: ucad.sessionStore.getMessages(id),
                decisions: ucad.sessionStore.listDecisions(id),
                handoff: ucad.sessionStore.createHandoff(id),
                exportedAt: new Date().toISOString(),
                notice: '此文件包含对话明文与源码片段。',
              },
              null,
              2,
            )
          : renderMarkdownExport(ucad, id);

      // NFR-15: the export warning is shown before the file is written.
      const confirm = await dialog.showMessageBox(win, {
        type: 'warning',
        buttons: ['继续导出', '取消'],
        defaultId: 1,
        cancelId: 1,
        title: '导出包含敏感内容',
        message: '导出文件包含对话明文与源码片段。',
        detail: '请妥善保管该文件。',
      });
      if (confirm.response !== 0) return { canceled: true as const };

      const fs = await import('node:fs');
      fs.writeFileSync(result.filePath, body, 'utf8');
      return { path: result.filePath };
    }),
  );

  handle(
    IPC_CHANNELS.sessions.createHandoff,
    ok(async (sessionId: unknown) =>
      ucad.sessionStore.createHandoff(sessionIdSchema.parse(sessionId)),
    ),
  );

  handle(
    IPC_CHANNELS.sessions.listHandoffs,
    ok(async (sessionId: unknown) =>
      ucad.sessionStore.listHandoffs(sessionIdSchema.parse(sessionId)),
    ),
  );

  handle(
    IPC_CHANNELS.sessions.claimHandoff,
    ok(async (input: unknown) => {
      const { sessionId, handoffId, agentId } = claimHandoffSchema.parse(input);
      return ucad.sessionStore.claimHandoff(sessionId, handoffId, agentId);
    }),
  );

  handle(
    IPC_CHANNELS.sessions.completeHandoff,
    ok(async (input: unknown) => {
      const { sessionId, handoffId } = handoffRefSchema.parse(input);
      return ucad.sessionStore.completeHandoff(sessionId, handoffId);
    }),
  );

  handle(
    IPC_CHANNELS.sessions.send,
    ok(async (input: unknown) => {
      const parsed = z
        .object({
          sessionId: sessionIdSchema,
          objective: z.string().min(1),
          attachments: z
            .array(z.object({ path: z.string(), kind: z.enum(['image', 'file']) }))
            .optional(),
          override: z
            .object({ agentId: z.string().optional(), modelId: z.string().optional() })
            .optional(),
        })
        .parse(input);

      // No adapter consumes attachments yet — they were forwarded into the
      // host payload and dropped there, a silent no-op wearing a wire type.
      // Until one ships, accepting them would be the product pretending.
      if (parsed.attachments && parsed.attachments.length > 0) {
        throw new Error('附件暂未实现：当前没有任何 Agent 会读取它们，已拒绝而不是静默丢弃');
      }

      // `agentId` is not part of the wire DTO: the session already knows which
      // Agent it belongs to, and an explicit `override.agentId` (D-4) wins.
      const session = ucad.sessionStore.getSession(parsed.sessionId);
      if (!session) throw new Error('会话不存在');
      return ucad.runtime.sendTurn({
        ...parsed,
        agentId: parsed.override?.agentId ?? session.agentId,
      });
    }),
  );

  handle(
    IPC_CHANNELS.sessions.cancel,
    ok(async (sessionId: unknown) => {
      await ucad.runtime.cancelTurn(sessionIdSchema.parse(sessionId));
    }),
  );

  // ------------------------------------------------------------------- events
  handle(
    IPC_CHANNELS.events.since,
    ok(async (input: unknown) => {
      const parsed = z
        .object({
          sessionId: sessionIdSchema,
          afterSeq: z.number().int().nonnegative(),
          limit: z.number().int().positive().max(1000).optional(),
        })
        .parse(input);
      return ucad.eventLog.since(parsed);
    }),
  );

  handle(
    IPC_CHANNELS.events.latestSeq,
    ok(async (sessionId: unknown) => ucad.eventLog.latestSeq(sessionIdSchema.parse(sessionId))),
  );

  // ------------------------------------------------------------------- agents
  handle(
    IPC_CHANNELS.agents.list,
    ok(async () => {
      // Read and discarded: the catalogue below is built from the hosts that are
      // actually running, not from the settings document.
      ucad.sessionStore.getSettings();
      // The catalogue is whatever actually started, not a hard-coded list: an
      // adapter that is not installed must not appear as a broken picker entry,
      // and an adapter that was just added must not need a second edit here.
      const order = [
        'universal',
        'mock',
        'pi',
        'codex',
        'claude',
        'qwen',
        'grok',
      ].filter((id) => ucad.agents.has(id));
      const entries = [];
      for (const id of order) {
        const host = ucad.agents.get(id);
        if (!host) continue;
        entries.push({
          manifest: host.manifest,
          available: true,
          // PE-1: an agent that cannot be intercepted before execution must be
          // marked restricted rather than presented as equally safe.
          restricted: host.manifest.capabilities.permissionCallbacks !== 'pre_execution',
          models: host.manifest.capabilities.modelSelection
            ? await safeListModels(ucad, id)
            : [],
        });
      }
      if (entries.length === 0) {
        // No host is running. The UI still needs *something* to render, but it
        // must be an honest placeholder: an empty `defaultAgentId` used as an id
        // produces a blank dropdown, and inventing a vendor id would violate
        // NFR-04. So the entry names the reference adapter and says plainly that
        // it is not available.
        entries.push({
          manifest: {
            id: 'mock',
            displayName: 'Mock Agent (未启动)',
            kind: 'mock' as const,
            isDefaultRuntime: true,
            transport: 'child_process' as const,
            providerBinding: 'both' as const,
            pinned: [],
            capabilities: {
              streaming: true,
              sessionResume: true,
              modelSelection: true,
              fileTools: false,
              shellTools: false,
              permissionCallbacks: 'none' as const,
              nativeSandbox: false,
              mcp: false,
              skills: false,
              subagents: false,
              usageReporting: 'none' as const,
              injectionModes: ['prompt_prefix' as const],
              toolContract: 'none' as const,
            },
          },
          available: false,
          unavailableReason: 'Agent Host 尚未启动',
          restricted: true,
          models: [],
        });
      }
      return entries;
    }),
  );

  // -------------------------------------------------------------- permissions
  handle(
    IPC_CHANNELS.permissions.respond,
    ok(async (requestId: unknown, decision: unknown) => {
      const id = requestIdSchema.parse(requestId);
      const parsed = permissionDecisionSchema.parse(decision);
      await ucad.runtime.respondToPermission(id, parsed);
    }),
  );

  handle(
    IPC_CHANNELS.permissions.listRules,
    ok(async (scope: unknown) => {
      const parsed =
        scope === undefined
          ? undefined
          : z.enum(['session', 'workspace', 'global']).parse(scope);
      return ucad.permissions.listRules(parsed);
    }),
  );

  handle(
    IPC_CHANNELS.permissions.revokeRule,
    ok(async (ruleId: unknown) => {
      ucad.permissions.revokeRule(z.string().min(1).parse(ruleId));
    }),
  );

  // ------------------------------------------------------------------ secrets
  // There is intentionally no `secrets.get` channel (NFR-01).
  handle(
    IPC_CHANNELS.secrets.set,
    ok(async (ref: unknown, value: unknown) => {
      const parsed = secretRefSchema.parse(ref);
      const val = z.string().min(1).parse(value);
      await ucad.secrets.set(parsed, val);
    }),
  );

  handle(
    IPC_CHANNELS.secrets.delete,
    ok(async (ref: unknown) => {
      await ucad.secrets.delete(secretRefSchema.parse(ref));
    }),
  );

  handle(
    IPC_CHANNELS.secrets.describe,
    ok(async (ref: unknown) => ucad.secrets.describe(secretRefSchema.parse(ref))),
  );

  // -------------------------------------------------------------------- files
  handle(
    IPC_CHANNELS.files.read,
    ok(async (p: unknown, opts: unknown) => {
      const root = requireActiveWorkspaceRoot(ucad);
      const parsed = z.string().min(1).parse(p);
      const parsedOpts = z
        .object({ maxBytes: z.number().int().positive().optional() })
        .optional()
        .parse(opts);
      return ucad.files.read({
        workspaceRoot: root,
        path: parsed,
        maxBytes: parsedOpts?.maxBytes,
      });
    }),
  );

  handle(
    IPC_CHANNELS.files.write,
    ok(async (p: unknown, content: unknown, opts: unknown) => {
      const root = requireActiveWorkspaceRoot(ucad);
      const parsedPath = z.string().min(1).parse(p);
      const parsedContent = z.string().parse(content);
      const parsedOpts = z
        .object({ expectedRevision: z.string().optional() })
        .parse(opts);
      const session = ucad.sessionStore.listSessions()[0];
      return ucad.files.write({
        workspaceRoot: root,
        path: parsedPath,
        content: parsedContent,
        expectedRevision: parsedOpts.expectedRevision,
        sessionId: session?.id,
      });
    }),
  );

  handle(
    IPC_CHANNELS.files.list,
    ok(async (dir: unknown) =>
      ucad.files.list({
        workspaceRoot: requireActiveWorkspaceRoot(ucad),
        dir: z.string().min(1).parse(dir),
      }),
    ),
  );

  // ---------------------------------------------------------------------- git
  handle(
    IPC_CHANNELS.git.status,
    ok(async (workspaceId: unknown) =>
      ucad.git.status(workspaceIdSchema.parse(workspaceId), activeRoot(ucad)),
    ),
  );

  handle(
    IPC_CHANNELS.git.diff,
    ok(async (input: unknown) => {
      const parsed = z
        .object({ path: z.string().optional(), staged: z.boolean().optional() })
        .parse(input);
      return ucad.git.diff({
        workspaceRoot: activeRoot(ucad),
        path: parsed.path,
        staged: parsed.staged ?? false,
      });
    }),
  );

  handle(
    IPC_CHANNELS.git.stage,
    ok(async (paths: unknown) => {
      ucad.git.stage(activeRoot(ucad), z.array(z.string()).parse(paths));
    }),
  );

  handle(
    IPC_CHANNELS.git.unstage,
    ok(async (paths: unknown) => {
      ucad.git.unstage(activeRoot(ucad), z.array(z.string()).parse(paths));
    }),
  );

  handle(
    IPC_CHANNELS.git.discard,
    ok(async (paths: unknown) => {
      const session = ucad.sessionStore.listSessions()[0];
      const list = z.array(z.string()).min(1).parse(paths);
      if (!session) throw new Error('没有活动会话');
      // discard destroys work, so it goes through the Permission Engine
      const allowed = await requestHighRiskPermission(ucad, session.id, `discard: ${list.join(', ')}`, list);
      if (!allowed) throw new Error(appError('PERMISSION_DENIED', '已拒绝丢弃修改', 'ipc').message);
      ucad.git.discard(activeRoot(ucad), list);
    }),
  );

  handle(
    IPC_CHANNELS.git.commit,
    ok(async (message: unknown) => {
      const session = ucad.sessionStore.listSessions()[0];
      const msg = z.string().min(1).parse(message);
      if (!session) throw new Error('没有活动会话');
      const allowed = await requestHighRiskPermission(ucad, session.id, `commit: ${msg}`, [`commit:${msg}`]);
      if (!allowed) throw new Error(appError('PERMISSION_DENIED', '已拒绝提交', 'ipc').message);
      return ucad.git.commit(activeRoot(ucad), msg);
    }),
  );

  // ----------------------------------------------------------------- terminal
  handle(
    IPC_CHANNELS.terminal.create,
    ok(async (input: unknown) => {
      const parsed = z
        .object({ cwd: z.string().min(1), cols: z.number().int().positive(), rows: z.number().int().positive() })
        .parse(input);
      const session = ucad.sessionStore.listSessions()[0];
      if (!session) throw new Error('没有活动会话');
      return ucad.terminal.create({
        sessionId: session.id,
        workspaceRoot: activeRoot(ucad),
        ...parsed,
      });
    }),
  );

  handle(
    IPC_CHANNELS.terminal.write,
    ok(async (terminalId: unknown, data: unknown) => {
      ucad.terminal.write(
        z.string().min(1).parse(terminalId),
        z.string().parse(data),
      );
    }),
  );

  handle(
    IPC_CHANNELS.terminal.kill,
    ok(async (terminalId: unknown) => {
      ucad.terminal.kill(z.string().min(1).parse(terminalId));
    }),
  );

  // ------------------------------------------------------------------- §11.2
  // Both terminal transports above AND below are the user's own shell, and
  // neither is permission-gated: the pipe channel and the PTY are what the
  // terminal panel drives, and the panel says so in as many words ("这是你的
  // 控制台，不是 Agent 的命令工具"). The agent's command path is a different
  // plane entirely — the tool contract (`command.*` cards), which evaluates the
  // PermissionEngine before anything spawns (NFR-02). An earlier version of
  // this comment claimed the pipe channel was the gated agent shell, which was
  // the one story that would make a renderer-driven ungated shell sound
  // reviewed. The UI keeps the layers apart because conflating them is exactly
  // the confusion §11.2 warns about.
  handle(IPC_CHANNELS.terminal.ptyStatus, ok(async () => ucad.ptyStatus()));

  handle(
    IPC_CHANNELS.terminal.ptyCreate,
    ok(async (input: unknown) => {
      const parsed = z
        .object({
          cwd: z.string().min(1),
          cols: z.number().int().positive(),
          rows: z.number().int().positive(),
        })
        .parse(input);
      const session = ucad.sessionStore.listSessions()[0];
      return ucad.pty.create({
        workspaceRoot: activeRoot(ucad),
        cwd: parsed.cwd,
        cols: parsed.cols,
        rows: parsed.rows,
        ...(session ? { sessionId: session.id } : {}),
      });
    }),
  );

  handle(
    IPC_CHANNELS.terminal.ptyWrite,
    ok(async (input: unknown) => {
      const parsed = z
        .object({ terminalId: z.string().min(1), data: z.string() })
        .parse(input);
      ucad.pty.write(parsed.terminalId, parsed.data);
    }),
  );

  handle(
    IPC_CHANNELS.terminal.ptyResize,
    ok(async (input: unknown) => {
      const parsed = z
        .object({
          terminalId: z.string().min(1),
          cols: z.number().int().positive(),
          rows: z.number().int().positive(),
        })
        .parse(input);
      ucad.pty.resize(parsed.terminalId, parsed.cols, parsed.rows);
    }),
  );

  handle(
    IPC_CHANNELS.terminal.ptyKill,
    ok(async (terminalId: unknown) => {
      await ucad.pty.kill(z.string().min(1).parse(terminalId));
    }),
  );

  // ------------------------------------------------------------- intelligence
  handle(
    IPC_CHANNELS.intelligence.listProviders,
    ok(() => ucad.intelligence.listProviders()),
  );

  handle(
    IPC_CHANNELS.intelligence.status,
    ok(async (workspaceId: unknown, providerId: unknown) => {
      const ws = workspaceIdSchema.parse(workspaceId);
      return ucad.intelligence.status(ws, providerId as string | undefined);
    }),
  );

  handle(
    IPC_CHANNELS.intelligence.index,
    ok(async (workspaceId: unknown, providerId: unknown) => {
      const ws = workspaceIdSchema.parse(workspaceId);
      return ucad.intelligence.index({
        workspaceId: ws,
        workspaceRoot: activeRoot(ucad),
        providerId: z.string().min(1).parse(providerId),
        full: true,
      });
    }),
  );

  handle(
    IPC_CHANNELS.intelligence.refresh,
    ok(async (workspaceId: unknown, providerId: unknown) => {
      const ws = workspaceIdSchema.parse(workspaceId);
      return ucad.intelligence.refresh({
        workspaceId: ws,
        providerId: z.string().min(1).parse(providerId),
      });
    }),
  );

  handle(
    IPC_CHANNELS.intelligence.query,
    ok(async (input: unknown) => {
      const parsed = z
        .object({
          workspaceId: workspaceIdSchema,
          kind: z.enum(['search', 'locate', 'overview', 'callers', 'callees', 'trace', 'impact']),
          input: z.unknown(),
        })
        .parse(input);
      const result = await ucad.intelligence.query({
        kind: parsed.kind,
        providerId: 'basic',
        input: { workspaceId: parsed.workspaceId, ...(parsed.input as object) },
      });
      return { operationId: result.providerId, result };
    }),
  );

  handle(
    IPC_CHANNELS.intelligence.cancel,
    ok(async (operationId: unknown) =>
      ucad.intelligence.cancel(z.string().min(1).parse(operationId)),
    ),
  );

  // ------------------------------------------------------------------ context
  handle(
    IPC_CHANNELS.context.preview,
    ok(async (input: unknown) => {
      const parsed = z
        .object({
          workspaceId: workspaceIdSchema,
          sessionId: sessionIdSchema,
          objective: z.string().min(1),
          agentId: z.string().min(1),
          modelId: z.string().optional(),
          budget: z
            .object({
              maxInputTokens: z.number().int().positive().optional(),
              reservedOutputTokens: z.number().int().nonnegative().optional(),
              estimateSource: z
                .enum(['provider_tokenizer', 'heuristic_chars_div_4', 'unknown'])
                .optional(),
            })
            .optional(),
          strategy: z.enum(['text_first', 'graph_first', 'hybrid', 'auto']).optional(),
        })
        .parse(input);
      return ucad.broker.preview(parsed);
    }),
  );

  handle(
    IPC_CHANNELS.context.getPack,
    ok(async (packId: unknown) => {
      const pack = ucad.broker.getPack(z.string().min(1).parse(packId));
      if (!pack) throw new Error('Context Pack 不存在');
      return pack;
    }),
  );

  handle(
    IPC_CHANNELS.context.extend,
    ok(async (input: unknown) => {
      const parsed = z
        .object({
          packId: z.string().min(1),
          request: z.string().min(1),
          maxItems: z.number().int().positive().optional(),
        })
        .parse(input);
      const session = ucad.sessionStore.listSessions()[0];
      if (!session) throw new Error('没有活动会话');
      return ucad.broker.extend({
        packId: parsed.packId,
        sessionId: session.id,
        turnId: `turn_preview_${Date.now()}`,
        trigger: 'user_action',
        request: parsed.request,
        maxItems: parsed.maxItems,
      });
    }),
  );

  handle(
    IPC_CHANNELS.context.getInjection,
    ok(async (turnId: unknown) => ucad.broker.getInjection(z.string().min(1).parse(turnId))),
  );

  // ----------------------------------------------------------------- decision
  handle(IPC_CHANNELS.decision.listEngines, ok(() => ucad.decisions.listEngines()));

  handle(
    IPC_CHANNELS.decision.setChain,
    ok(async (engineIds: unknown) => {
      const parsed = z.array(z.string().min(1)).parse(engineIds);
      const settings = ucad.sessionStore.patchSettings({ decision: { chain: parsed } });
      ucad.decisions.setChain(parsed);
      return settings;
    }),
  );

  handle(
    IPC_CHANNELS.decision.preview,
    ok(async (input: unknown) => {
      const parsed = z
        .object({
          sessionId: sessionIdSchema,
          objective: z.string().min(1),
          kind: z.enum([
            'route',
            'risk',
            'continue_or_stop',
            'context_relevance',
            'clarify',
            'option_select',
          ]),
        })
        .parse(input);

      // A preview is the same decision, surfaced before the turn runs. It goes
      // through the same engine and the same mandatory rationale/confidence
      // (NFR-16) — it is not a weaker, separate code path. It is a *dry run*:
      // no `decisions` row, no `decision.made` event, and no `turnId`, because a
      // decision asked at the composer has no turn to belong to yet.
      const session = ucad.sessionStore.getSession(parsed.sessionId);
      if (!session) throw new Error('会话不存在');
      return ucad.decisions.preview({
        sessionId: parsed.sessionId,
        objective: parsed.objective,
        kind: parsed.kind,
        facts: await ucad.collectDecisionFacts({
          workspaceId: session.workspaceId,
          sessionId: session.id,
          trusted:
            ucad.sessionStore.getWorkspace(session.workspaceId)?.trustState === 'trusted',
        }),
      });
    }),
  );

  // -------------------------------------------------------------------- usage
  handle(
    IPC_CHANNELS.usage.query,
    ok(async (filter: unknown) =>
      ucad.usage.query(
        z
          .object({
            sessionId: z.string().optional(),
            workspaceId: z.string().optional(),
            from: z.string().optional(),
            to: z.string().optional(),
          })
          .parse(filter),
      ),
    ),
  );

  handle(
    IPC_CHANNELS.usage.summary,
    ok(async (filter: unknown) =>
      ucad.usage.summary(
        z
          .object({
            workspaceId: z.string().optional(),
            from: z.string().optional(),
            to: z.string().optional(),
          })
          .parse(filter),
      ),
    ),
  );

  // -------------------------------------------------------------------- tools
  handle(
    IPC_CHANNELS.tools.list,
    ok(async () => {
      const session = ucad.sessionStore.listSessions()[0];
      const host = session ? ucad.agents.get(session.agentId) : undefined;
      const workspaceId = session?.workspaceId ?? activeWorkspaceId(ucad);
      // `describe` returns DTOs; `list` returns the executable definitions the
      // Agent sees. The UI wants the former.
      return ucad.tools.describe(
        ucad.toolAvailability(host?.manifest ?? fallbackManifest(), workspaceId),
      );
    }),
  );

  // ----------------------------------------------------------------- settings
  handle(IPC_CHANNELS.settings.get, ok(() => ucad.sessionStore.getSettings()));

  handle(
    IPC_CHANNELS.settings.patch,
    ok(async (patch: unknown) => ucad.sessionStore.patchSettings(patch as never)),
  );

  // -------------------------------------------------------------- diagnostics
  handle(
    IPC_CHANNELS.diagnostics.info,
    ok(async () => ({
      version: deps.getVersion(),
      schemaVersion: ucad.db.schemaVersion,
      dbPath: ucad.paths.dbPath,
      logDir: ucad.paths.logDir,
      userDataDir: ucad.paths.userData,
      platform: `${process.platform} ${process.arch}`,
      encryptionEnabled: ucad.encryptionEnabled,
      locale: deps.getLocale(),
      electron: process.versions.electron,
      node: process.versions.node,
      journalMode: ucad.db.journalMode(),
      /*
       * The tail of the log, newest first, so the Diagnostics page can answer
       * "what just happened" without the user opening a file.
       *
       * Read from the in-memory sink rather than the file on disk: the logger
       * redacts every record before any sink sees it (NFR-08), and going back
       * to the file would bypass that guarantee for no benefit. The mapping is
       * in its own module so a test can reach it — see `log-tail.ts`.
       */
      recentLog: recentLogEntries(ucad.memoryLog.records),
    })),
  );

  // ----------------------------------------------------------------- locale
  handle(IPC_CHANNELS.app.locale, ok(async () => deps.getLocale()));

  handle(
    IPC_CHANNELS.app.setLocale,
    ok(async (next: unknown) => {
      const parsed = z.string().parse(next);
      if (!isLocale(parsed)) throw new Error(`不支持的语言：${parsed}`);
      deps.setLocale(parsed);
      // Persisted so the choice survives a restart; the menu reads it back on
      // the next launch through the same settings document.
      ucad.sessionStore.patchSettings({ locale: parsed } as never);
      return parsed;
    }),
  );

  // ----------------------------------------------------------------- providers
  handle(IPC_CHANNELS.providers.list, ok(async () => ucad.listProviders()));

  handle(
    IPC_CHANNELS.providers.models,
    ok(async (providerId: unknown) => {
      const id = z.string().min(1).parse(providerId);
      // The built-in catalogue is returned first so the UI has something to
      // show instantly; the live list is merged in when the vendor answers.
      const built = ucad.getProviderDescriptor(id);
      try {
        return await ucad.modelRegistry.refresh(id);
      } catch {
        return built?.models ?? [];
      }
    }),
  );

  handle(
    IPC_CHANNELS.providers.probe,
    ok(async (providerId: unknown) => {
      const id = z.string().min(1).parse(providerId);
      // A probe sends no prompt and spends no tokens — it is "is this
      // configured and reachable", not "does a completion work".
      return ucad.providerClient.probe(id);
    }),
  );

  handle(
    IPC_CHANNELS.providers.configured,
    ok(async () => ucad.configuredProviders()),
  );

  // ----------------------------------------------------------------- update
  handle(
    IPC_CHANNELS.app.updateStatus,
    ok(async () => deps.getUpdates()?.current ?? null),
  );

  handle(
    IPC_CHANNELS.app.checkUpdate,
    ok(async () => {
      const service = deps.getUpdates();
      if (!service) throw new Error('更新服务不可用');
      return service.check();
    }),
  );

  handle(
    IPC_CHANNELS.app.downloadUpdate,
    ok(async () => {
      const service = deps.getUpdates();
      if (!service) throw new Error('更新服务不可用');
      return service.download();
    }),
  );

  handle(
    IPC_CHANNELS.app.installUpdate,
    ok(async () => {
      const service = deps.getUpdates();
      if (!service) throw new Error('更新服务不可用');
      service.installAndRestart();
      return true;
    }),
  );

  // §8.4 and §10 get the *same* `handle` wrapper rather than their own, so a new
  // surface cannot grow a second, weaker error path (§7.2).
  registerStorageIpc({ handle, ucad, getWindow });
  registerMcpIpc({ handle, ucad, getWindow });
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function activeWorkspace(ucad: UcadApp) {
  return ucad.sessionStore.listWorkspaces()[0] ?? null;
}

function activeWorkspaceId(ucad: UcadApp): string {
  return activeWorkspace(ucad)?.id ?? '';
}

function activeRoot(ucad: UcadApp): string {
  const workspace = activeWorkspace(ucad);
  if (!workspace) {
    throw new Error('请先打开一个项目');
  }
  return workspace.path;
}

function requireActiveWorkspaceRoot(ucad: UcadApp): string {
  return activeRoot(ucad);
}

function fallbackManifest() {
  return {
    id: 'mock',
    displayName: 'Mock Agent',
    kind: 'mock' as const,
    isDefaultRuntime: false,
    transport: 'child_process' as const,
    providerBinding: 'both' as const,
    pinned: [],
    capabilities: {
      streaming: true,
      sessionResume: true,
      modelSelection: true,
      fileTools: false,
      shellTools: false,
      permissionCallbacks: 'none' as const,
      nativeSandbox: false,
      mcp: false,
      skills: false,
      subagents: false,
      usageReporting: 'none' as const,
      injectionModes: ['prompt_prefix' as const],
      toolContract: 'none' as const,
    },
  };
}

async function safeListModels(
  ucad: UcadApp,
  agentId: string,
): Promise<Array<{ id: string; providerId: string; displayName: string }>> {
  const host = ucad.agents.get(agentId);
  if (!host) return [];
  try {
    return await ucad.runtime.listModels(agentId);
  } catch {
    return [];
  }
}

function renderMarkdownExport(ucad: UcadApp, sessionId: string): string {
  const session = ucad.sessionStore.getSession(sessionId);
  const messages = ucad.sessionStore.getMessages(sessionId);
  const lines: string[] = [
    `# ${session?.title ?? sessionId}`,
    '',
    `- Session: \`${sessionId}\``,
    `- Agent: \`${session?.agentId ?? 'unknown'}\``,
    `- 导出时间: ${new Date().toISOString()}`,
    '',
    '> 本文件包含对话明文与源码片段。',
    '',
    '## 对话',
    '',
  ];
  for (const message of messages) {
    lines.push(`### ${message.role}`);
    if (message.toolName) lines.push(`\`\`\`json\n{"tool":"${message.toolName}","status":"${message.toolStatus ?? 'unknown'}"}\n\`\`\``);
    lines.push('', message.text, '');
  }
  return lines.join('\n');
}
