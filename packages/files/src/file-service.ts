/**
 * §7.2 FileService — the ONLY component that reads or writes the user's disk
 * on behalf of the Renderer or an Agent.
 *
 * Security invariants (each one is asserted by the smoke checks):
 *  - every path goes through {@link canonicalize} before any syscall, and an
 *    `external` result is refused here (the caller may still have raised an
 *    `EXTERNAL_PATH` prompt first)
 *  - writes are optimistic-concurrency checked on a content hash, so an Agent
 *    and a user editing the same file cannot silently clobber each other
 *    (§11.3)
 *  - the Service never prompts. It refuses what policy refuses and records the
 *    decision; `AgentRuntimeManager` owns the prompt (§4.9).
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ulid } from '@ucad/observability';
import { sha256Hex } from '@ucad/observability';
import type { Logger } from '@ucad/observability';
import type { FileEntry, FileReadResult, FileWriteResult, PermissionMode, Unsubscribe } from '@ucad/contracts';
import type { PermissionEngine } from '@ucad/permissions';
import { AppErrorThrow, errnoOf, fail } from './errors';
import { canonicalize, realpathBestEffort } from './paths';
import type { CanonicalPath } from './paths';
import { createFsWatcher } from './watcher';
import type { FileChangeEvent, FsWatcherLike } from './watcher';

/** NFR-06: a file preview is bounded even when the file is not. */
const DEFAULT_MAX_BYTES = 512 * 1024;

/** A NUL byte in this window means "not text" with very high confidence. */
const BINARY_SNIFF_BYTES = 8 * 1024;

/** Resolves the session facts `PermissionEngine.evaluate` needs. */
export interface FileWriteSessionContext {
  workspaceId: string;
  permissionMode: PermissionMode;
  workspaceTrusted: boolean;
}

export interface FileServiceOptions {
  logger: Logger;
  permissions: PermissionEngine;
  /** §9: injected so Main owns watcher lifecycle; defaults to `fs.watch`. */
  watcher?: FsWatcherLike;
  /**
   * Optional. Without it the Permission Engine is evaluated with the strictest
   * inputs that cannot silently allow anything (`ask` mode, trusted workspace,
   * no workspace scope).
   */
  sessionContext?: (sessionId: string) => FileWriteSessionContext | undefined;
}

export interface FileReadInput {
  workspaceRoot: string;
  path: string;
  maxBytes?: number;
}

export interface FileWriteInput {
  workspaceRoot: string;
  path: string;
  content: string;
  /** Content hash the caller believes is on disk (§11.3). */
  expectedRevision?: string;
  sessionId?: string;
  /** Present when the write came from a turn; enables the audit trail. */
  turnId?: string;
  agentId?: string;
}

export interface FileListInput {
  workspaceRoot: string;
  dir: string;
}

export class FileService {
  private readonly logger: Logger;
  private readonly permissions: PermissionEngine;
  private readonly watcher: FsWatcherLike;
  private readonly sessionContext: ((sessionId: string) => FileWriteSessionContext | undefined) | null;

  constructor(opts: FileServiceOptions) {
    this.logger = opts.logger.child('files');
    this.permissions = opts.permissions;
    this.watcher = opts.watcher ?? createFsWatcher();
    this.sessionContext = opts.sessionContext ?? null;
  }

  /** §7.2 — exposed so the IPC layer can canonicalize before it does anything else. */
  canonicalize(workspaceRoot: string, input: string): CanonicalPath {
    return canonicalize(workspaceRoot, input);
  }

  // -------------------------------------------------------------------------
  // read
  // -------------------------------------------------------------------------

  async read(input: FileReadInput): Promise<FileReadResult> {
    const target = this.requireInside(input.workspaceRoot, input.path, 'read');
    const maxBytes = this.resolveMaxBytes(input.maxBytes);

    let handle: fs.promises.FileHandle;
    try {
      handle = await fs.promises.open(target, 'r');
    } catch (err) {
      throw this.ioFailure(err, target);
    }

    try {
      const stat = await handle.stat();
      if (!stat.isFile()) {
        throw fail('UNKNOWN', '目标不是文件，无法以文本方式打开');
      }

      // NUL byte in the first 8 KiB => binary. Refusing is better than handing
      // the Renderer mojibake and a revision computed over replacement chars.
      const sniffLength = Math.min(stat.size, BINARY_SNIFF_BYTES);
      const sniff = Buffer.alloc(sniffLength);
      if (sniffLength > 0) {
        await this.readFully(handle, sniff, sniffLength);
      }
      if (sniff.includes(0)) {
        throw fail('UNKNOWN', '该文件是二进制文件，无法以文本方式打开');
      }

      const want = Math.min(stat.size, maxBytes);
      const content_ = Buffer.alloc(want);
      if (want > 0) {
        await this.readFully(handle, content_, want);
      }

      const content = content_.toString('utf8');
      // The revision hashes the WHOLE file, not the returned window: a
      // truncated preview that later failed the write-back check would make
      // large files permanently unwritable (§11.3).
      const revision = await this.hashFile(target);
      this.logger.debug('file read', { path: target, bytes: want, truncated: stat.size > maxBytes });
      return { content, truncated: stat.size > maxBytes, revision };
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  // -------------------------------------------------------------------------
  // write
  // -------------------------------------------------------------------------

  async write(input: FileWriteInput): Promise<FileWriteResult> {
    if (typeof input.content !== 'string') {
      throw fail('UNKNOWN', '写入内容必须是文本');
    }
    const target = this.requireInside(input.workspaceRoot, input.path, 'write');

    this.checkPermission(target, input);

    // §11.3 optimistic concurrency. A missing file has no revision, so any
    // expectation about it is a conflict by definition.
    if (input.expectedRevision !== undefined) {
      const current = await this.currentRevision(target);
      if (current !== input.expectedRevision) {
        this.logger.warn('write rejected: revision conflict', {
          path: target,
          expected: input.expectedRevision,
          actual: current ?? null,
        });
        throw fail('UNKNOWN', '文件已被其他方修改，请重新加载后再试', {
          path: target,
          expectedRevision: input.expectedRevision,
          actualRevision: current ?? null,
        });
      }
    }

    try {
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      await fs.promises.writeFile(target, input.content, 'utf8');
    } catch (err) {
      throw this.ioFailure(err, target);
    }

    const revision = sha256Hex(input.content);
    this.logger.info('file written', {
      path: target,
      bytes: Buffer.byteLength(input.content, 'utf8'),
      sessionId: input.sessionId ?? null,
    });
    return { revision };
  }

  // -------------------------------------------------------------------------
  // list
  // -------------------------------------------------------------------------

  async list(input: FileListInput): Promise<FileEntry[]> {
    const target = this.requireInside(input.workspaceRoot, input.dir, 'list');
    const workspaceReal = realpathBestEffort(input.workspaceRoot);

    let dirents: fs.Dirent[];
    try {
      dirents = await fs.promises.readdir(target, { withFileTypes: true });
    } catch (err) {
      throw this.ioFailure(err, target);
    }

    const entries: FileEntry[] = [];
    for (const dirent of dirents) {
      const full = path.join(target, dirent.name);
      try {
        const kind = await this.classify(workspaceReal, full, dirent);
        if (kind !== null) {
          entries.push({ name: dirent.name, path: full, kind });
        }
      } catch {
        // A single unreadable entry (a broken link, a permission error) must
        // not fail the whole listing; the Explorer refreshes on the next tick.
        this.logger.debug('list: entry skipped', { path: full });
      }
    }

    // Directories first, then alphabetical — the Explorer's grouping order.
    entries.sort((a, b) => {
      if (a.kind !== b.kind) {
        return a.kind === 'dir' ? -1 : 1;
      }
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });
    return entries;
  }

  // -------------------------------------------------------------------------
  // watch
  // -------------------------------------------------------------------------

  /**
   * §7.2 `files.watch`. The directory is canonicalized first, so the Renderer
   * can never start a watcher outside the workspace; every event is
   * re-canonicalized so a symlink swapped in mid-watch cannot escape either.
   */
  watch(input: { workspaceRoot: string; dir: string }, cb: (event: FileChangeEvent) => void): Unsubscribe {
    const target = this.requireInside(input.workspaceRoot, input.dir, 'watch');
    const rootReal = realpathBestEffort(input.workspaceRoot);
    return this.watcher.watch(target, (event) => {
      const canonical = canonicalize(rootReal, event.path);
      if (canonical.external) {
        this.logger.warn('watch: dropped an event outside the workspace', { path: event.path });
        return;
      }
      cb({ path: canonical.path, operation: event.operation });
    });
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  /** Canonicalize + refuse anything that leaves the workspace. */
  private requireInside(workspaceRoot: string, input: string, action: string): string {
    const canonical = canonicalize(workspaceRoot, input);
    if (canonical.external) {
      this.logger.warn(`${action} refused for an external path`, { path: canonical.path });
      throw fail('PERMISSION_DENIED', '该路径不在当前工作区内', { path: canonical.path });
    }
    return canonical.path;
  }

  private resolveMaxBytes(maxBytes: number | undefined): number {
    if (maxBytes === undefined) {
      return DEFAULT_MAX_BYTES;
    }
    if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
      throw fail('UNKNOWN', 'maxBytes 必须是正整数');
    }
    return maxBytes;
  }

  private async readFully(handle: fs.promises.FileHandle, buffer: Buffer, length: number): Promise<void> {
    let filled = 0;
    while (filled < length) {
      const { bytesRead } = await handle.read(buffer, filled, length - filled, filled);
      if (bytesRead <= 0) {
        break;
      }
      filled += bytesRead;
    }
  }

  private async currentRevision(target: string): Promise<string | undefined> {
    try {
      return await this.hashFile(target);
    } catch {
      return undefined;
    }
  }

  /** Streaming hash so a 500 MB file never lands in memory. */
  private hashFile(target: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const hash = createHash('sha256');
      const stream = fs.createReadStream(target);
      stream.on('error', reject);
      stream.on('data', (chunk: string | Buffer) => {
        hash.update(chunk);
      });
      stream.on('end', () => {
        resolve(hash.digest('hex'));
      });
    });
  }

  /**
   * §4.9. Runs the write through the Permission Engine when the caller named a
   * session, and honours an `auto_deny`. `ask_user` is NOT a refusal here: the
   * prompt belongs to `AgentRuntimeManager`, so this method logs that the
   * caller owns the decision and proceeds.
   */
  private checkPermission(target: string, input: FileWriteInput): void {
    const sessionId = input.sessionId;
    if (sessionId === undefined || sessionId.length === 0) {
      return;
    }

    const context = this.sessionContext?.(sessionId) ?? {
      workspaceId: '',
      permissionMode: 'ask' as PermissionMode,
      workspaceTrusted: true,
    };

    const request = {
      id: ulid('perm_'),
      sessionId,
      turnId: input.turnId ?? 'ui',
      agentId: input.agentId ?? 'ucad',
      category: 'FILE_WRITE' as const,
      risk: this.permissions.assess({
        category: 'FILE_WRITE',
        resource: target,
        sessionPermissionMode: context.permissionMode,
        workspaceTrusted: context.workspaceTrusted,
      }),
      resource: target,
    };

    const evaluation = this.permissions.evaluate({
      request,
      sessionPermissionMode: context.permissionMode,
      workspaceId: context.workspaceId,
      sessionId,
      workspaceTrusted: context.workspaceTrusted,
    });

    this.logger.info('file write permission evaluated', {
      path: target,
      sessionId,
      outcome: evaluation.outcome,
      risk: evaluation.risk,
      reason: evaluation.reason,
    });

    if (evaluation.outcome !== 'auto_deny') {
      return;
    }

    // `permission_audit.session_id` / `turn_id` are foreign keys, so a trail is
    // only written when the caller gave a real turn. An audit failure (e.g. a
    // missing session row) must never turn a clean refusal into an SQL error.
    if (input.turnId !== undefined && input.turnId.length > 0) {
      try {
        this.permissions.recordAudit({
          requestId: request.id,
          sessionId,
          turnId: input.turnId,
          category: 'FILE_WRITE',
          risk: evaluation.risk,
          resource: target,
          decision: 'deny',
          decider: 'policy',
        });
      } catch (err) {
        this.logger.warn('permission audit write failed', {
          path: target,
          sessionId,
          errno: errnoOf(err) ?? 'unknown',
        });
      }
    }
    throw fail('PERMISSION_DENIED', '写入被权限策略拒绝', { path: target, reason: evaluation.reason });
  }

  /**
   * `kind` is null when the entry must not be shown: a symlink whose target
   * leaves the workspace. Symlinks are never followed out of the root (§7.2);
   * `workspaceReal` is the boundary, not the directory being listed.
   */
  private async classify(
    workspaceReal: string,
    full: string,
    dirent: fs.Dirent,
  ): Promise<FileEntry['kind'] | null> {
    const stat = await fs.promises.lstat(full);
    if (stat.isSymbolicLink()) {
      if (canonicalize(workspaceReal, realpathBestEffort(full)).external) {
        this.logger.warn('list: symlink points outside the workspace', { path: full });
        return null;
      }
      return stat.isDirectory() ? 'dir' : 'file';
    }
    if (dirent.isDirectory() || stat.isDirectory()) {
      return 'dir';
    }
    return 'file';
  }

  /** `fs` errnos become short, user-safe messages (NFR-08 redaction is the logger's job). */
  private ioFailure(err: unknown, target: string): AppErrorThrow {
    if (err instanceof AppErrorThrow) {
      return err;
    }
    switch (errnoOf(err)) {
      case 'ENOENT':
        return fail('UNKNOWN', '文件或目录不存在', { path: target });
      case 'EACCES':
      case 'EPERM':
        return fail('PERMISSION_DENIED', '没有访问该路径的权限', { path: target });
      case 'EISDIR':
        return fail('UNKNOWN', '目标是一个目录');
      case 'ENOTDIR':
        return fail('UNKNOWN', '路径中的某一段不是目录', { path: target });
      case 'ELOOP':
        return fail('PERMISSION_DENIED', '路径包含循环链接', { path: target });
      default:
        this.logger.warn('file io failed', { path: target, errno: errnoOf(err) ?? 'unknown' });
        return fail('UNKNOWN', '文件操作失败');
    }
  }
}
