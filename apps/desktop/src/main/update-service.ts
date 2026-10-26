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
 * {
 *   "version": "0.2.0",
 *   "notes": "…",
 *   "url": "https://…/UCAD-Setup-0.2.0.exe",
 *   "sha256": "9f86d0…",
 *   "size": 91234567
 * }
 * ```
 *
 * `version` is compared with `semver`-style dotted numbers. Anything unparsable
 * is reported as an error, never as "up to date".
 *
 * `sha256` and `size` are what make the download checkable: the installer is
 * hashed before it is ever launched, and a file that does not match is
 * deleted rather than run. A feed that carries no hash can still announce a
 * version, but it cannot be installed from — see `update-feed.ts` for why
 * that is a refusal and not a warning.
 */

import { app, shell } from 'electron';
import { createWriteStream } from 'node:fs';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pipeline } from 'node:stream/promises';
import * as https from 'node:https';
import * as http from 'node:http';
import { describeError } from '@ucad/contracts';
import type { Logger } from '@ucad/observability';
import {
  checkChannelUrl,
  checkFeedUrl,
  checkStagedFileUnchanged,
  isUpdateChannelScheme,
  normalizeSha256,
  verifyInstaller,
  verifyStagedInstallerForLaunch,
  type InstallerVerification,
  type StagedFileCheck,
  type UpdateFeedDocument,
} from './update-feed';

type UpdateState =
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'error'
  | 'unsupported';

export interface UpdateStatus {
  state: UpdateState;
  currentVersion: string;
  latestVersion?: string;
  notes?: string;
  /** 0..1, only meaningful while `downloading` */
  progress?: number;
  /** where the installer was written, when `ready` */
  downloadedPath?: string;
  /** true once the staged installer matched the feed's SHA-256 */
  verified?: boolean;
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
  /**
   * test seam: fetches the installer to `target`.
   *
   * The default is the real network download. The seam exists because the
   * behaviour worth gating — a package that does not match its hash is
   * deleted and never launched — happens *after* the bytes land, and a gate
   * that cannot reach that point proves nothing.
   */
  downloadImpl?: (
    url: URL,
    target: string,
    onProgress: (received: number, total: number) => void,
  ) => Promise<void>;
  /**
   * test seam: the HTTP GET behind the default downloader.
   *
   * The redirect rules run in the response callback, which only a request
   * reaches. Injecting the transport lets a gate drive a 302 to cleartext — or
   * six hops — through the same listener the app uses, without a certificate
   * or a network.
   */
  downloadGet?: DownloadGet;
  /**
   * test seam: launches the staged installer. Resolves with an error string
   * when the launch failed, and with an empty string when it started.
   */
  openInstaller?: (target: string) => Promise<string>;
  /**
   * test seam: runs after the staged installer has been verified and before
   * it is launched.
   *
   * It exists for one assertion — "a file replaced *after* the hash was taken
   * is not launched" — because that window has nothing a test can interleave
   * with: the product code goes from the last chunk of the digest to
   * `openPath` with nothing in between. A promise about a window that no gate
   * can open is the shape this repository keeps finding and deleting, so the
   * window is openable on purpose. Production passes nothing; the check that
   * follows it runs either way. The "production passes nothing" half is a
   * gate rather than a note: `tests/contract/update-integrity.test.ts` scans
   * every main-process `new UpdateService({…})` and fails, naming the file and
   * line, if one passes this seam.
   */
  beforeLaunch?: (target: string) => void | Promise<void>;
}

/** The HTTP GET a download uses. Structurally `https.get`/`http.get`. */
export type DownloadGet = (
  url: URL,
  options: { readonly timeout: number },
  onResponse: (response: http.IncomingMessage) => void,
) => http.ClientRequest;

const CHECK_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
/**
 * How many redirects a download may follow. The old code followed them
 * without a limit, so a feed that pointed at a redirect loop turned the
 * download into an infinite loop rather than an error.
 */
const MAX_DOWNLOAD_REDIRECTS = 5;

export class UpdateService {
  private readonly opts: UpdateServiceOptions;
  private status: UpdateStatus;
  private readonly listeners = new Set<(s: UpdateStatus) => void>();
  /**
   * The feed document the version check read.
   *
   * The download uses *this* document rather than fetching the feed a second
   * time. Two reasons, and the second is the one that matters: the hash and
   * the URL then come from a single read of the feed, so a feed that changes
   * between the check and the download cannot point the download at a
   * different file than the one the user was shown; and the comparison the
   * user was shown — "1.1.0 is available" — is the comparison the download
   * is made against.
   *
   * **Lifetime.** Written by `check()` and by nothing else, in the same
   * statement block that sets `available`; cleared by the paths that take the
   * status away from `available` because the check failed. It is not cleared
   * by `download()`, which keeps it for `installAndRestart()` — the hash the
   * staged file is re-verified against is this document's. So
   * `state === 'available'` implies this is non-null, which is why `download()`
   * refuses rather than re-reads when it is missing.
   */
  private feed: UpdateFeedDocument | null = null;

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

  /**
   * Feeds that are not plain HTTPS are refused: an update channel is a
   * remote-code-execution surface and must not be downgradeable to cleartext.
   *
   * The rule itself is `checkFeedUrl()`'s — and underneath it
   * `checkChannelUrl()`'s — not a copy of it. This service is handed its feed
   * by a caller (`getFeedUrl`) and used to re-implement the protocol check
   * here, which made the third implementation of one rule: next to the packaged
   * file's and the override's. Two copies of a security rule drift quietly, so
   * the second gate a caller can reach is now the same function, and
   * `tests/contract/update-integrity.test.ts` asserts every entry point accepts
   * and refuses the same values.
   *
   * This covers the feed address only. The other two URLs on the channel — the
   * installer the feed names, and each redirect hop — are judged by the same
   * rule at their own sites, so no place in this file writes a scheme
   * comparison down.
   */
  private resolveFeed(): string | null {
    const verdict = checkFeedUrl(this.opts.getFeedUrl());
    if (verdict.ok) return verdict.url;
    // Nothing configured is not a refusal: the app says "未配置更新源" and
    // that is the whole story.
    if (verdict.reason === 'empty') return null;
    this.opts.logger.warn(
      verdict.reason === 'invalid-url'
        ? 'update feed is not a valid URL; ignoring'
        : 'update feed must be https; ignoring',
      { reason: verdict.reason },
    );
    return null;
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
      this.feed = null;
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
        this.feed = null;
        return this.set({
          state: 'error',
          message: `更新源返回 HTTP ${response.status}`,
          checkedAt: new Date().toISOString(),
        });
      }

      const body = (await response.json()) as UpdateFeedDocument;
      const latest = typeof body.version === 'string' ? body.version.trim() : '';
      if (!latest) {
        this.feed = null;
        return this.set({
          state: 'error',
          message: '更新源缺少 version 字段',
          checkedAt: new Date().toISOString(),
        });
      }

      // The document the user was shown is the document the download uses.
      this.feed = { ...body, version: latest };

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
      this.feed = null;
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
    // The document the check read, not a second read of the feed: the hash
    // and the URL the installer is fetched from must be the ones the version
    // the user was shown was compared against.
    //
    // `available` is only ever set by `check()`, in the same statement block
    // that stores this document, and every path that clears the document also
    // moves the state off `available` — so the two cannot disagree today.
    // That makes the branch below unreachable *by construction*, and it is
    // kept as a refusal rather than a second read of the feed: an earlier
    // build re-fetched here, which reopened exactly the window this field
    // exists to close (a feed that changed between the check and the download
    // could name a different file than the one the user was shown), and a
    // fallback is also what would let the two disagree silently the day a
    // caller starts writing to the status. `tests/contract/update-integrity.test.ts`
    // drives this branch and asserts the feed is not read again.
    const info = this.feed;
    if (!info) {
      this.opts.logger.error('update download without the document the update check read');
      return this.set({ state: 'error', message: '更新信息已失效，请重新检查更新' });
    }
    if (!info.url) {
      return this.set({ state: 'error', message: '更新源未提供下载地址' });
    }

    // The installer is only ever installed if it can be checked against a
    // hash the feed published. A feed without one announces a version and
    // nothing more: the bytes it points at cannot be told apart from the
    // bytes an attacker would serve, so they are not fetched at all.
    const expectedSha256 = normalizeSha256(info.sha256);
    if (expectedSha256 === null) {
      this.opts.logger.warn('update feed carries no sha256; refusing to download');
      return this.set({
        state: 'error',
        message: '更新源未提供 SHA-256 校验值，已拒绝下载未经验证的安装包',
      });
    }

    // The installer URL is the second of the channel's three URLs, and it is
    // judged by the channel's one rule rather than by a copy of it. The hash
    // proves the bytes match what the feed named; it does not make a cleartext
    // transfer acceptable, so a feed that names `http://` is refused before a
    // request is made — the same refusal the feed address and every redirect
    // hop get, in the words this screen uses for it.
    const installer = checkChannelUrl(info.url);
    if (!installer.ok) {
      return this.set({
        state: 'error',
        message:
          installer.reason === 'not-https' ? '下载地址必须使用 https' : '下载地址无效',
      });
    }
    // `checkChannelUrl()` parsed this exact string a line ago, so this cannot
    // throw; taking the parsed form is what the downloader needs, not a second
    // judgement.
    const url = new URL(installer.url);

    // The feed never names the file. An earlier build joined the feed's
    // `version` and the URL's extension into the staged path; a version like
    // `1.0.0/../../..` compares as 1.0.0 (the parser stops at the first
    // non-digit) while path normalization turns the dots into an arbitrary
    // write target. Staging is single-slot — one pending update at a time — so
    // the name is a constant and no feed-controlled string ever becomes a path
    // component. The version stays a display fact, and still has to be sane
    // for the comparison above to have meant anything.
    if (!isSafeVersion(info.version ?? '')) {
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
      const onProgress = (received: number, total: number) => {
        this.set({ progress: total > 0 ? Math.min(1, received / total) : 0 });
      };
      if (this.opts.downloadImpl) {
        await this.opts.downloadImpl(url, target, onProgress);
      } else {
        await downloadTo(url, target, onProgress, 0, this.opts.downloadGet);
      }
    } catch (error) {
      // A half-written file is not an update, and it must not be left on disk
      // under the name that means "pending update".
      removeStagedInstaller(target);
      const message = describeError(error);
      return this.set({ state: 'error', progress: 0, message });
    }

    // The bytes are now on disk and have never been checked. They are checked
    // now, before anything is allowed to treat them as an installer.
    const verification = await verifyInstaller(target, {
      sha256: expectedSha256,
      size: info.size,
    });
    if (!verification.ok) {
      removeStagedInstaller(target);
      this.opts.logger.error('update verification failed', {
        reason: verification.reason,
        expected: verification.expected,
        actual: verification.actual,
      });
      return this.set({
        state: 'error',
        progress: 0,
        verified: false,
        message: verificationMessage(verification),
      });
    }

    this.opts.logger.info('update downloaded', {
      target,
      version: info.version,
      sha256: verification.sha256,
    });
    return this.set({
      state: 'ready',
      progress: 1,
      downloadedPath: target,
      verified: true,
      message: undefined,
    });
  }

  /**
   * Launches the staged installer and restarts. Windows: the installer takes over.
   *
   * The staged file is verified again here, and the answer is returned rather
   * than assumed: the file sat on disk between the download and this click,
   * in the user's own profile directory, and the promise that it was the
   * file the feed named was made at a different moment. A file that no
   * longer matches is deleted and never launched.
   *
   * **The verification is not the same question as the launch.** A digest says
   * "these bytes are the bytes the feed published"; it does not say "the file
   * about to run is the file those bytes came from". Those are two reads of one
   * path, and a path is resolved twice: once by the hash, once by the OS at
   * launch. Everything that happens between them — a rename over the staged
   * name, a rewrite in place, a deletion — is a window, and a window with no
   * gate is what the previous round of this work was about. So the check
   * returns the *identity* of the file object it hashed (device, inode, size,
   * mtime) and it is compared against the path once more, immediately before
   * the launch. A file that is no longer that file is deleted, and the refusal
   * is logged with both readings.
   *
   * The residual gap is one `stat` call wide, and `FileIdentity` in
   * `update-feed.ts` says exactly what it does not catch. It is deliberately
   * not "hash the installer a second time": that would move the window rather
   * than close it, and it would double the wait on a button the user already
   * waited on.
   */
  async installAndRestart(): Promise<boolean> {
    const target = this.status.downloadedPath;
    if (!target || !fs.existsSync(target)) {
      this.set({ state: 'error', message: '安装包不存在，请重新下载' });
      return false;
    }

    // Verified through a descriptor and answered with the file's identity, so
    // the launch below can ask whether the path still names that file.
    const verification = await verifyStagedInstallerForLaunch(target, {
      sha256: this.feed?.sha256,
      size: this.feed?.size,
    });
    if (!verification.ok) {
      removeStagedInstaller(target);
      this.opts.logger.error('refusing to install an unverified update', {
        reason: verification.reason,
        expected: verification.expected,
        actual: verification.actual,
      });
      this.set({
        state: 'error',
        verified: false,
        downloadedPath: undefined,
        message: verificationMessage(verification),
      });
      return false;
    }

    // The window between the hash and the launch. Nothing in production runs
    // here (see `beforeLaunch`); the check below runs whatever happened in it.
    await this.opts.beforeLaunch?.(target);

    const unchanged = checkStagedFileUnchanged(target, verification.identity);
    if (!unchanged.ok) {
      removeStagedInstaller(target);
      this.opts.logger.error('refusing to install an update that changed after it was verified', {
        reason: unchanged.reason,
        sha256: verification.sha256,
        bytes: verification.bytes,
      });
      this.set({
        state: 'error',
        verified: false,
        downloadedPath: undefined,
        message: changedMessage(unchanged),
      });
      return false;
    }

    this.opts.logger.info('installing update', { target, sha256: verification.sha256 });
    // Launching must happen before quit, and a failed launch must be visible:
    // after quit() the process is going away, so an unchecked openPath would
    // end the app with the user never seeing an installer.
    const launcher = this.opts.openInstaller ?? ((file: string) => shell.openPath(file));
    void launcher(target).then((opened) => {
      if (opened) {
        this.opts.logger.error('update installer failed to launch', { target, reason: opened });
        this.set({ state: 'error', message: opened });
      } else {
        // `app` is always present in the real main process; the guard keeps
        // a test that exercises the launch path from taking the process down
        // with it.
        app?.quit?.();
      }
    });
    return true;
  }

  /** Used by the Settings screen when the user would rather do it themselves. */
  openFeed(): void {
    const feed = this.resolveFeed();
    if (feed) void shell.openExternal(feed);
  }
}

/** What a redirect may not be, and what the user is told about it. */
export type DownloadRedirect =
  | { readonly ok: true; readonly url: URL; readonly depth: number }
  | {
      readonly ok: false;
      readonly reason: 'too-many-redirects' | 'invalid-location' | 'not-https';
    };

const REDIRECT_MESSAGE: Readonly<Record<Extract<DownloadRedirect, { ok: false }>['reason'], string>> =
  {
    'too-many-redirects': '下载重定向次数过多',
    'invalid-location': '下载重定向地址无效',
    'not-https': '下载重定向必须使用 https',
  };

/**
 * Where one redirect hop is allowed to go, or why it is not.
 *
 * This used to live inline in the response listener, and the parse was
 * unguarded: `new URL(location, url)` threw inside an event callback, outside
 * the promise's executor, so a malformed `Location` header escaped as an
 * uncaught exception instead of failing the download. Two rules were checked
 * and one was not; the missing one is the one a broken or hostile server
 * controls. Keeping the decision here makes all three refusal cases
 * (`too-many-redirects`, `invalid-location`, `not-https`) assertable without a
 * server, a certificate, or a network.
 */
export function resolveDownloadRedirect(
  location: string,
  base: URL,
  depth: number,
): DownloadRedirect {
  // A feed that points at a redirect loop used to be followed forever, which
  // turned a broken update into a download that never ends and never fails.
  if (depth >= MAX_DOWNLOAD_REDIRECTS) {
    return { ok: false, reason: 'too-many-redirects' };
  }
  let next: URL;
  try {
    next = new URL(location, base);
  } catch {
    return { ok: false, reason: 'invalid-location' };
  }
  // Same rule as the feed itself: the bytes being downloaded are the RCE
  // surface, so no hop may downgrade to cleartext. The rule is the channel's
  // one implementation, not a copy of it — a hop is the third URL on the
  // channel, and the copy that used to sit here is exactly the kind of drift
  // `checkChannelUrl()` exists to prevent.
  if (!isUpdateChannelScheme(next.protocol)) {
    return { ok: false, reason: 'not-https' };
  }
  return { ok: true, url: next, depth: depth + 1 };
}

/**
 * The transport behind the default downloader: the https agent for an https
 * URL, and the http agent otherwise.
 *
 * The `http` branch is not a policy: every URL that reaches the downloader has
 * already been through `checkChannelUrl()` (the installer) or
 * `resolveDownloadRedirect()` (each hop), both of which refuse anything but
 * https. It stays a choice of module rather than an assertion so a test that
 * drives this seam with a plain-http URL exercises the download path instead of
 * throwing here — the refusal belongs to the rule, not to the socket.
 */
const defaultDownloadGet: DownloadGet = (url, options, onResponse) =>
  (isUpdateChannelScheme(url.protocol) ? https : http).get(url, options, onResponse);

async function downloadTo(
  url: URL,
  target: string,
  onProgress: (received: number, total: number) => void,
  depth = 0,
  getImpl: DownloadGet = defaultDownloadGet,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = getImpl(url, { timeout: DOWNLOAD_TIMEOUT_MS }, (response) => {
      if (response.statusCode && response.statusCode >= 300 && response.headers.location) {
        response.resume();
        const redirect = resolveDownloadRedirect(response.headers.location, url, depth);
        if (!redirect.ok) {
          reject(new Error(REDIRECT_MESSAGE[redirect.reason]));
          return;
        }
        void downloadTo(redirect.url, target, onProgress, redirect.depth, getImpl).then(
          resolve,
          reject,
        );
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
      // Pipe the response itself, not `Readable.from(response)`. The progress
      // listener above already put the stream into flowing mode; iterating the
      // same stream a second time races that listener for its chunks, and the
      // file can end up empty while every byte was counted. A pipe shares the
      // flowing stream, so the progress count and the bytes written agree.
      pipeline(response, createWriteStream(target)).then(resolve, reject);
    });
    request.on('timeout', () => request.destroy(new Error('下载超时')));
    request.on('error', reject);
  });
}

/**
 * Removes a staged file that must not be launched.
 *
 * The staged name is a constant, so this cannot be pointed at anything else —
 * and if it ever is, `path.basename` is checked again here, because a
 * cleanup routine that deletes by path is the last place a bug would be
 * harmless.
 */
function removeStagedInstaller(target: string): void {
  if (path.basename(target) !== STAGED_INSTALLER_NAME) return;
  try {
    fs.rmSync(target, { force: true });
  } catch {
    /* a file we cannot delete is a file we also never launch */
  }
}

/**
 * What the user is told when the installer did not check out.
 *
 * The wording names the reason rather than saying "update failed", because
 * the three failures mean different things to the person reading them: the
 * feed said nothing about the file, the file is not the file, or the file
 * could not be read at all.
 */
function verificationMessage(verification: Extract<InstallerVerification, { ok: false }>): string {
  switch (verification.reason) {
    case 'no-hash':
      return '更新源未提供 SHA-256 校验值，安装包未经验证';
    case 'hash-mismatch':
      return '安装包校验失败：SHA-256 不匹配，已删除该文件';
    case 'size-mismatch':
      return '安装包校验失败：文件大小与更新源不符，已删除该文件';
    case 'unreadable':
      return '安装包校验失败：无法读取已下载的文件';
  }
}

/**
 * What the user is told when the file stopped being the file that was checked.
 *
 * Its own message rather than a verification failure, because nothing was
 * found wrong with the bytes: the download was fine and the file it produced
 * was fine, and *then* the path changed under it. "校验失败" would send the
 * reader looking for a broken release; the truth is that the file in the
 * download directory was replaced or removed after it was checked, which is
 * what the sentence says.
 */
function changedMessage(check: Extract<StagedFileCheck, { ok: false }>): string {
  return check.reason === 'replaced'
    ? '安装包在启动前发生变化，已删除该文件，请重新下载'
    : '安装包在启动前已无法读取，请重新下载';
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
