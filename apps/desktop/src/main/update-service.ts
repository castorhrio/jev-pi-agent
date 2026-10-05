/**
 * Update service.
 *
 * A desktop app that can never be updated is a desktop app users will delete
 * the first time something breaks. This implements the whole loop — check,
 * report, download, install on restart — against a configurable release feed,
 * and degrades honestly when no feed is configured rather than pretending to
 * check.
 *
 * The feed is a static JSON document (the shape GitHub/GitLab release pages
 * already expose, and the shape a self-hosted one usually does too):
 *
 * ```json
 * { "version": "0.2.0", "notes": "…", "url": "https://…/UCAD-0.2.0-setup.exe" }
 * ```
 *
 * `version` is compared with `semver`-style dotted numbers. Anything unparsable
 * is reported as an error, never as "up to date".
 */

import { app, shell } from 'electron';
import { createWriteStream } from 'node:fs';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import * as https from 'node:https';
import * as http from 'node:http';
import { describeError } from '@ucad/contracts';
import type { Logger } from '@ucad/observability';

type UpdateState =
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'error'
  | 'unsupported';

export interface UpdateInfo {
  version: string;
  notes?: string;
  url?: string;
}

export interface UpdateStatus {
  state: UpdateState;
  currentVersion: string;
  latestVersion?: string;
  notes?: string;
  /** 0..1, only meaningful while `downloading` */
  progress?: number;
  /** where the installer was written, when `ready` */
  downloadedPath?: string;
  message?: string;
  checkedAt?: string;
  feedConfigured: boolean;
}

export interface UpdateServiceOptions {
  logger: Logger;
  /** resolves the configured feed URL, or null when none is set */
  getFeedUrl: () => string | null;
  /** where a downloaded installer is staged */
  downloadDir: string;
  /** the product's own version; `app.getVersion()` is the Electron version in dev */
  currentVersion: string;
  /** test seam */
  fetchImpl?: typeof fetch;
}

const CHECK_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;

export class UpdateService {
  private readonly opts: UpdateServiceOptions;
  private status: UpdateStatus;
  private readonly listeners = new Set<(s: UpdateStatus) => void>();

  constructor(opts: UpdateServiceOptions) {
    this.opts = opts;
    this.status = {
      state: 'idle',
      currentVersion: opts.currentVersion,
      feedConfigured: Boolean(opts.getFeedUrl()),
    };
  }

  get current(): UpdateStatus {
    return { ...this.status };
  }

  onChange(cb: (s: UpdateStatus) => void): () => void {
    this.listeners.add(cb);
    cb(this.current);
    return () => this.listeners.delete(cb);
  }

  /** Feeds that are not plain HTTPS are refused: an update channel is a
   *  remote-code-execution surface and must not be downgradeable to cleartext. */
  private resolveFeed(): string | null {
    const raw = this.opts.getFeedUrl()?.trim();
    if (!raw) return null;
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      this.opts.logger.warn('update feed is not a valid URL; ignoring');
      return null;
    }
    if (parsed.protocol !== 'https:') {
      this.opts.logger.warn('update feed must be https; ignoring', { protocol: parsed.protocol });
      return null;
    }
    return parsed.toString();
  }

  private set(patch: Partial<UpdateStatus>): UpdateStatus {
    this.status = { ...this.status, ...patch };
    for (const listener of this.listeners) {
      try {
        listener(this.current);
      } catch {
        /* a broken listener must not break the updater */
      }
    }
    return this.current;
  }

  async check(): Promise<UpdateStatus> {
    const feed = this.resolveFeed();
    if (!feed) {
      return this.set({
        state: 'unsupported',
        feedConfigured: false,
        message: '未配置更新源',
        checkedAt: new Date().toISOString(),
      });
    }

    this.set({ state: 'checking', feedConfigured: true, message: undefined });

    try {
      const doFetch = this.opts.fetchImpl ?? fetch;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
      const response = await doFetch(feed, {
        signal: controller.signal,
        headers: { accept: 'application/json' },
      });
      clearTimeout(timer);

      if (!response.ok) {
        return this.set({
          state: 'error',
          message: `更新源返回 HTTP ${response.status}`,
          checkedAt: new Date().toISOString(),
        });
      }

      const body = (await response.json()) as Partial<UpdateInfo>;
      const latest = typeof body.version === 'string' ? body.version.trim() : '';
      if (!latest) {
        return this.set({
          state: 'error',
          message: '更新源缺少 version 字段',
          checkedAt: new Date().toISOString(),
        });
      }

      if (compareVersions(latest, this.status.currentVersion) <= 0) {
        return this.set({
          state: 'up-to-date',
          latestVersion: latest,
          message: undefined,
          checkedAt: new Date().toISOString(),
        });
      }

      return this.set({
        state: 'available',
        latestVersion: latest,
        notes: typeof body.notes === 'string' ? body.notes : undefined,
        message: undefined,
        checkedAt: new Date().toISOString(),
      });
    } catch (error) {
      const message = describeError(error);
      this.opts.logger.warn('update check failed', { message });
      return this.set({
        state: 'error',
        message,
        checkedAt: new Date().toISOString(),
      });
    }
  }

  /** Downloads the staged installer. Refuses when there is nothing to fetch. */
  async download(): Promise<UpdateStatus> {
    if (this.status.state !== 'available') {
      return this.set({
        state: 'error',
        message: '没有可下载的新版本',
      });
    }
    const info = await this.fetchLatest();
    if (!info?.url) {
      return this.set({ state: 'error', message: '更新源未提供下载地址' });
    }

    let url: URL;
    try {
      url = new URL(info.url);
    } catch {
      return this.set({ state: 'error', message: '下载地址无效' });
    }
    if (url.protocol !== 'https:') {
      return this.set({ state: 'error', message: '下载地址必须使用 https' });
    }

    // The feed never names the file. An earlier build joined the feed's
    // `version` and the URL's extension into the staged path; a version like
    // `1.0.0/../../..` compares as 1.0.0 (the parser stops at the first
    // non-digit) while path normalization turns the dots into an arbitrary
    // write target. Staging is single-slot — one pending update at a time — so
    // the name is a constant and no feed-controlled string ever becomes a path
    // component. The version stays a display fact, and still has to be sane
    // for the comparison above to have meant anything.
    if (!isSafeVersion(info.version)) {
      return this.set({ state: 'error', message: '更新源返回的版本号无效' });
    }

    this.set({ state: 'downloading', progress: 0, message: undefined });

    // Containment by construction, then verified anyway so the guarantee is
    // visible at the write site: the staging root is resolved on its own, the
    // file name is a constant, and the result must still sit under the root.
    const stageRoot = path.resolve(this.opts.downloadDir);
    const target = `${stageRoot}${path.sep}${STAGED_INSTALLER_NAME}`;
    if (path.basename(target) !== STAGED_INSTALLER_NAME || !target.startsWith(stageRoot + path.sep)) {
      return this.set({ state: 'error', message: '下载路径无效' });
    }
    try {
      fs.mkdirSync(this.opts.downloadDir, { recursive: true });
      await downloadTo(url, target, (received, total) => {
        this.set({ progress: total > 0 ? Math.min(1, received / total) : 0 });
      });
      this.opts.logger.info('update downloaded', { target, version: info.version });
      return this.set({ state: 'ready', progress: 1, downloadedPath: target });
    } catch (error) {
      const message = describeError(error);
      return this.set({ state: 'error', progress: 0, message });
    }
  }

  private async fetchLatest(): Promise<UpdateInfo | null> {
    const feed = this.resolveFeed();
    if (!feed) return null;
    try {
      const doFetch = this.opts.fetchImpl ?? fetch;
      const response = await doFetch(feed);
      return (await response.json()) as UpdateInfo;
    } catch {
      return null;
    }
  }

  /** Launches the staged installer and restarts. Windows: the installer takes over. */
  installAndRestart(): void {
    const target = this.status.downloadedPath;
    if (!target || !fs.existsSync(target)) {
      this.set({ state: 'error', message: '安装包不存在，请重新下载' });
      return;
    }
    this.opts.logger.info('installing update', { target });
    // Launching must happen before quit, and a failed launch must be visible:
    // after quit() the process is going away, so an unchecked openPath would
    // end the app with the user never seeing an installer.
    void shell.openPath(target).then((opened) => {
      if (opened) {
        this.opts.logger.error('update installer failed to launch', { target, reason: opened });
        this.set({ state: 'error', message: opened });
      } else {
        app.quit();
      }
    });
  }

  /** Used by the Settings screen when the user would rather do it themselves. */
  openFeed(): void {
    const feed = this.resolveFeed();
    if (feed) void shell.openExternal(feed);
  }
}

async function downloadTo(
  url: URL,
  target: string,
  onProgress: (received: number, total: number) => void,
): Promise<void> {
  const client = url.protocol === 'https:' ? https : http;
  await new Promise<void>((resolve, reject) => {
    const request = client.get(url, { timeout: DOWNLOAD_TIMEOUT_MS }, (response) => {
      if (response.statusCode && response.statusCode >= 300 && response.headers.location) {
        response.resume();
        const next = new URL(response.headers.location, url);
        // Same rule as the feed itself: the bytes being downloaded are the RCE
        // surface, so no hop may downgrade to cleartext.
        if (next.protocol !== 'https:') {
          reject(new Error('下载重定向必须使用 https'));
          return;
        }
        void downloadTo(next, target, onProgress).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        reject(new Error(`下载失败：HTTP ${response.statusCode}`));
        return;
      }
      const total = Number(response.headers['content-length'] ?? 0);
      let received = 0;
      response.on('data', (chunk: Buffer) => {
        received += chunk.length;
        onProgress(received, total);
      });
      pipeline(Readable.from(response), createWriteStream(target)).then(resolve, reject);
    });
    request.on('timeout', () => request.destroy(new Error('下载超时')));
    request.on('error', reject);
  });
}

/**
 * Compares dotted numeric versions. Returns >0 when `a` is newer.
 * A non-numeric component sorts as 0, so `1.2.x` does not outrank `1.2.0`.
 */
function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.\-+]/);
  const pb = b.split(/[.\-+]/);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = Number.parseInt(pa[i] ?? '0', 10);
    const nb = Number.parseInt(pb[i] ?? '0', 10);
    const va = Number.isFinite(na) ? na : 0;
    const vb = Number.isFinite(nb) ? nb : 0;
    if (va !== vb) return va > vb ? 1 : -1;
  }
  return 0;
}

/**
 * A version the feed may compare and display. The comparison above stops at
 * the first non-digit, so `1.0.0/../../..` parses as 1.0.0; such a string says
 * the feed is broken or hostile, and it is refused before anything downloads.
 */
export function isSafeVersion(version: string): boolean {
  return /^[0-9A-Za-z.-]+$/.test(version) && !version.includes('..');
}

/**
 * Single-slot staging: one pending update at a time, under a constant name no
 * feed-controlled string can influence. A re-download replaces its own file.
 */
const STAGED_INSTALLER_NAME = 'UCAD-setup.exe';
