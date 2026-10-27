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
import type * as http from 'node:http';
import { describeError, type UpdateState, type UpdateStatus } from '@ucad/contracts';
import type { Logger } from '@ucad/observability';
import {
  checkChannelUrl,
  checkFeedUrl,
  checkOpenStagedInstaller,
  closeStagedInstaller,
  isUpdateChannelScheme,
  normalizeSha256,
  openStagedInstallerForLaunch,
  verifyInstaller,
  type ChannelUrlRejection,
  type InstallerVerification,
  type StagedFileCheck,
  type StagedInstallerHandle,
  type UpdateFeedDocument,
} from './update-feed';
import { UPDATE_FEED_REFUSAL_MESSAGE } from './update-feed-log';

// The service publishes the IPC contract's vocabulary rather than a second copy of
// it: `bootstrap.ts` imports the status type from here, and the renderer draws the
// same shape, so the two must be one type and not two lookalikes.
export type { UpdateState, UpdateStatus };

/**
 * What each update state may carry, as one table.
 *
 * The pairing this file is about — "`available` implies a document" — used to
 * be a comment on a field, then an overload on `set()` plus a hand-written
 * union listing the document-less states by name. Three spellings of one rule,
 * and only the overload was checked; the union's list of names was not tied to
 * anything, so a state added to the vocabulary could be left out of it and
 * still compile through the `as` in `set()`.
 *
 * The table is the fact now. `ServiceStatus` derives its document-less member
 * from it (`DocumentlessState`), the `set()` overloads are keyed by it, and
 * `statusAcceptsDocument()` asks it the one question `set()` has to answer
 * before it writes. A state added to `UPDATE_STATES` in `@ucad/contracts` fails
 * `npm run typecheck` here until it has a policy, which is the same
 * array-is-the-fact move `CHANNEL_URL_REJECTIONS` makes for the URL rule.
 *
 * **`required` has exactly one member, and `optional` has exactly one.**
 * `tests/contract/update-status.test.ts` pins both counts and names the members,
 * because the difference is not cosmetic: `available` without a document is a
 * version the user was told about and nothing to download, while `ready` may
 * arrive from outside with a `downloadedPath` and no document (see
 * `ServiceStatus`), and `installAndRestart()` refuses that shape by name rather
 * than by accident.
 */
export type StatusDocumentPolicy = 'required' | 'optional' | 'forbidden';

export const STATUS_DOCUMENT_POLICY = {
  idle: 'forbidden',
  checking: 'forbidden',
  'up-to-date': 'forbidden',
  available: 'required',
  downloading: 'forbidden',
  ready: 'optional',
  error: 'forbidden',
  unsupported: 'forbidden',
} as const satisfies Record<UpdateState, StatusDocumentPolicy>;

/**
 * The states the table says may not hold a document — derived, not listed.
 *
 * A mapped type rather than `Exclude<UpdateState, 'available' | 'ready'>`: the
 * exclusion would be a second place the two document-carrying states are named,
 * and a third state granted a document in the table above would leave it
 * behind.
 */
type DocumentlessState = {
  [State in UpdateState]: (typeof STATUS_DOCUMENT_POLICY)[State] extends 'forbidden'
    ? State
    : never;
}[UpdateState];

/**
 * Whether `state` may hold `document` — the table asked as one question.
 *
 * This is the rule the `set()` overloads express at compile time, in a form a
 * test can call: `tests/` is transpiled without typechecking, so an overload no
 * gate can reach is a rule nobody re-reads. `set()` asks it before every write,
 * which is also what makes the `as` in `set()` checked rather than merely
 * asserted — see the runtime half in `set()` itself.
 */
export function statusAcceptsDocument(
  state: UpdateState,
  document: UpdateFeedDocument | null,
): boolean {
  const policy = STATUS_DOCUMENT_POLICY[state];
  if (policy === 'optional') return true;
  return policy === 'required' ? document !== null : document === null;
}

/**
 * The status this service keeps: the public one, plus the document the check
 * read.
 *
 * The document used to be a field of its own (`private feed: … | null`) next to
 * a status whose `state` was a plain string, and the invariant tying them
 * together — "`state === 'available'` implies a document" — was a comment. Two
 * fields can disagree, and the comment is the only thing that could say which
 * one was right; `download()` kept a branch for the day they did.
 *
 * Merged, the pairing is the type: `available` *carries* the document, so
 * `check()` cannot write the state without the document it is about (the
 * transition overload on `set()` refuses it, and `STATUS_DOCUMENT_POLICY` is
 * the table both the overload and the runtime check read), and `download()`'s
 * read of that document is a narrowing of the same value it guarded — not a
 * second field that might be null while the first says otherwise.
 *
 * `ready` allows `null` on purpose, and it is not symmetry: `ready` is the one
 * state a *rebuilt* status can arrive in from outside (a later build that
 * persists the status hands over a `downloadedPath` and no feed document,
 * because nothing persists one). `installAndRestart()` is written for exactly
 * that reader and refuses it by name. `available` is never restored — a
 * restored pending install is `ready` — so it has no such case.
 */
type ServiceStatus =
  | (UpdateStatus & { readonly state: 'available'; readonly document: UpdateFeedDocument })
  | (UpdateStatus & {
      readonly state: 'ready';
      readonly document: UpdateFeedDocument | null;
    })
  | (UpdateStatus & { readonly state: DocumentlessState; readonly document: null });

/**
 * A status transition, as `set()` accepts it.
 *
 * `document` is not in here: it is a *parameter* of the transition rather than
 * a field a caller can pass in a patch, so a patch cannot carry a document that
 * disagrees with the state it is entering.
 */
type StatusPatch = Partial<UpdateStatus> & { readonly state?: UpdateState };

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
   *
   * **The scan is fail-closed on a non-literal argument.** A call site that
   * passes `makeOptions()` — or `{ ...sharedOptions }` — is reported, not
   * skipped: the seam can sit inside a value the scan cannot read, and a scan
   * whose response to "I cannot see this" is silence would be a gate that
   * exempts exactly the call sites a refactor produces. Object literals are
   * read; anything else is a failure naming the line and the fix.
   */
  beforeLaunch?: (target: string) => void | Promise<void>;
}

/** The HTTPS GET a download uses. Structurally `https.get`. */
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

/**
 * What the user is told when the document the update check read is gone.
 *
 * The staged installer can only be judged against the feed document the check
 * stored, so a status that offers an install without that document is a
 * question with no answer — and "check again" is the same fix whoever is
 * holding it. Its own sentence rather than `verificationMessage({ reason:
 * 'no-hash' })`: that one says the feed published no hash, which is a
 * statement about the publisher, while this one says the app lost the answer,
 * which is a statement about the app. The two send the reader to different
 * places.
 *
 * **It had two call sites and has one.** `download()` used to check for a
 * missing feed document too, because `state` and `feed` were separate fields
 * and "`available` with no feed" was a state the two could be in. Now
 * `available` *carries* the document (see `ServiceStatus`), so the download's
 * branch is not relaxed — it is unreachable, and the `as` in `set()` is
 * checked at runtime to keep it that way. What is left is the one shape a
 * status can arrive in from outside: `ready` with a `downloadedPath` and no
 * document, which a later build that persists the status would produce. That
 * reader is `installAndRestart()`, and `tests/contract/update-status.test.ts`
 * builds the shape directly (a `ready` status whose document was dropped) so
 * the sentence has a case that reaches it.
 */
export const STALE_UPDATE_DOCUMENT_MESSAGE = '更新信息已失效，请重新检查更新';

/**
 * What the update screen says when a configured feed was refused.
 *
 * A different sentence from 未配置更新源 on purpose. `check()` used to report a
 * refused feed as `unsupported` with 未配置更新源, which told a user who *had*
 * configured a feed to go and configure one, and left a support report unable
 * to say which of the two had happened. The reason is what makes the two fixes
 * distinguishable on screen: a typo in the address, or a channel somebody tried
 * to downgrade to cleartext.
 *
 * `Record<ChannelUrlRejection, string>`, so the table cannot fall behind the
 * vocabulary: `CHANNEL_URL_REJECTIONS` in `update-feed.ts` is the fact, and a
 * reason added there fails `npm run typecheck` here until it has a sentence for
 * the screen — the same shape as `UPDATE_FEED_REFUSAL_MESSAGE`, which is the
 * sentence the *log* gets for the same reason.
 */
export const FEED_REFUSAL_STATUS_MESSAGE: Readonly<Record<ChannelUrlRejection, string>> = {
  'invalid-url': '更新源地址无效，请检查 UCAD_UPDATE_FEED 或 update-config.json',
  'not-https': '更新源必须使用 https，请检查 UCAD_UPDATE_FEED 或 update-config.json',
};

/**
 * What `resolveFeed()` found: an address to fetch, nothing configured, or a
 * value that *was* configured and was refused.
 *
 * Two cases used to be one. `resolveFeed()` returned `string | null`, so
 * "nothing was configured" and "what was configured is not usable" reached
 * `check()` as the same value and got the same status (`unsupported`,
 * `feedConfigured: false`, 未配置更新源). The union names the case, `check()`
 * answers each one on purpose, and adding a refusal to
 * `CHANNEL_URL_REJECTIONS` is a compile error at
 * `FEED_REFUSAL_STATUS_MESSAGE` until the new case has a sentence.
 */
type FeedResolution =
  | { readonly kind: 'ok'; readonly url: string }
  | { readonly kind: 'none' }
  | { readonly kind: 'rejected'; readonly reason: ChannelUrlRejection };

/**
 * Whether a feed address was given at all — the constructor's reading of it.
 *
 * Asks `checkFeedUrl()` rather than testing for blank text here: "nothing was
 * configured" is one rule, and a second reading of it would be a second answer
 * to "should the app say 未配置更新源". A value that was provided and refused is
 * still provided; `false` here means the environment and the packaged file both
 * said nothing.
 */
function feedValueProvided(value: string | null | undefined): boolean {
  const verdict = checkFeedUrl(value);
  return verdict.ok || verdict.reason !== 'empty';
}

export class UpdateService {
  private readonly opts: UpdateServiceOptions;
  /**
   * The status, and — in the states that can use it — the feed document the
   * version check read (see `ServiceStatus`).
   *
   * The download uses *that* document rather than fetching the feed a second
   * time. Two reasons, and the second is the one that matters: the hash and
   * the URL then come from a single read of the feed, so a feed that changes
   * between the check and the download cannot point the download at a
   * different file than the one the user was shown; and the comparison the
   * user was shown — "1.1.0 is available" — is the comparison the download
   * is made against.
   *
   * **Lifetime.** Written by `check()` and by nothing else, passed to the
   * transition that sets `available`; carried into `ready` by the download, so
   * `installAndRestart()` re-verifies against the same document; and dropped
   * by every other transition, because no other state can use one. That is the
   * whole of the rule — there is no second field for a reader to consult, and
   * no place a document can survive a state that would not read it.
   */
  private status: ServiceStatus;
  private readonly listeners = new Set<(s: UpdateStatus) => void>();

  constructor(opts: UpdateServiceOptions) {
    this.opts = opts;
    this.status = {
      state: 'idle',
      currentVersion: opts.currentVersion,
      feedConfigured: feedValueProvided(opts.getFeedUrl()),
      document: null,
    };
  }

  /**
   * The status as the app sees it.
   *
   * The document is stripped here rather than left on the object: it is the
   * internal half of the state, it carries the feed's `sha256` and download URL,
   * and the IPC push sends this value to the renderer. A status that leaked it
   * would put the answer to "what is this install checked against" in a process
   * that only needs to draw a button.
   */
  get current(): UpdateStatus {
    const { document: _internal, ...visible } = this.status;
    return { ...visible };
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
   *
   * The refusal's sentence is not written here either. `update-feed-log.ts`
   * owns the one reason-to-sentence map, because the same two reasons are
   * announced for an unusable override; a service-local copy would be the same
   * security rule with two readings of it. This path is reached when a caller
   * bypasses `resolveUpdateFeed()`, and the sentence names both places a feed
   * is configured rather than assuming it was the environment variable.
   * `tests/contract/update-integrity.test.ts` compares the warning with that
   * table for every reason.
   *
   * **Three answers, because two of them are different sentences on screen.**
   * This used to return `string | null`, so "nothing was configured" and "what
   * was configured is not usable" arrived at `check()` as the same value: both
   * were reported `unsupported` with `feedConfigured: false` and the message
   * 未配置更新源. The refused case then told the user to configure a feed they
   * had already configured, and the status could not tell a support report
   * which of the two it was looking at. The union names the case, so `check()`
   * answers each one on purpose — and adding a refusal to
   * `CHANNEL_URL_REJECTIONS` is a compile error at `FEED_REFUSAL_STATUS_MESSAGE`
   * until it has a sentence for the screen.
   */
  private resolveFeed(): FeedResolution {
    const verdict = checkFeedUrl(this.opts.getFeedUrl());
    if (verdict.ok) return { kind: 'ok', url: verdict.url };
    // Nothing configured is not a refusal: the app says "未配置更新源" and
    // that is the whole story.
    if (verdict.reason === 'empty') return { kind: 'none' };
    this.opts.logger.warn(UPDATE_FEED_REFUSAL_MESSAGE[verdict.reason], {
      reason: verdict.reason,
    });
    return { kind: 'rejected', reason: verdict.reason };
  }

  /**
   * Writes one status transition, and is the only place the status is written.
   *
   * The document is a parameter rather than a field of `patch` for the reason
   * `ServiceStatus` gives: the states that carry one have to be entered *with*
   * one, so the first overload below makes `check()`'s `available` transition
   * fail `npm run typecheck` if it forgets the document — the invariant that
   * used to be a comment on a field. Every other transition passes none, and
   * gets `document: null`, which is what "no state but `available`/`ready` may
   * hold this" means in practice.
   *
   * **The `as` is checked, not only asserted.** The compiler cannot correlate
   * the spread of a union with a patch that narrows it, so the assignment below
   * has to claim "this transition entered the state it says". The three
   * overloads are that claim's compile-time half — they bind every caller in
   * this file — and `statusAcceptsDocument()` is the same table asked at
   * runtime, immediately before the write. The runtime half is not decoration:
   * the overloads say nothing about a call the compiler never saw (a cast, a
   * future subclass, a value assembled in a loop), and the state machine is the
   * one thing in this file whose violations are silent — an `available` with no
   * document is a version the user was shown and a download button that can
   * only fail.
   *
   * It **throws** rather than returning the old status. A refusal would leave
   * the caller believing the transition happened, and the callers here are
   * internal: the only way to reach this is a bug in this file, so the loud
   * answer is the one that gets fixed. The state is left untouched, which is
   * what makes the failure diagnosable — the last legal state is still there.
   * `tests/contract/update-status.test.ts` drives both directions of the matrix
   * through a cast, because the overloads themselves are only checked where
   * `tsc` runs and this suite is transpiled without typechecking.
   *
   * `tests/contract/update-integrity.test.ts` scans this file for a second
   * assignment to `status`, because a writer outside this method would be a
   * writer the overloads never saw — and would skip the check below too.
   */
  private set(
    patch: StatusPatch & { readonly state: 'available' },
    document: UpdateFeedDocument,
  ): UpdateStatus;
  private set(
    patch: StatusPatch & { readonly state: 'ready' },
    document: UpdateFeedDocument | null,
  ): UpdateStatus;
  private set(
    patch: StatusPatch & { readonly state?: DocumentlessState },
    document?: null,
  ): UpdateStatus;
  private set(patch: StatusPatch, document: UpdateFeedDocument | null = null): UpdateStatus {
    // The state this transition *enters*, which is the one the document has to
    // suit: a patch that carries no `state` keeps the current one, and dropping
    // the document on the way is exactly what `available` may not do.
    const nextState = patch.state ?? this.status.state;
    if (!statusAcceptsDocument(nextState, document)) {
      const policy = STATUS_DOCUMENT_POLICY[nextState];
      throw new Error(
        `update status '${nextState}' cannot hold this document (policy: ${policy}); ` +
          'STATUS_DOCUMENT_POLICY in update-service.ts is the rule, and set() is the only writer',
      );
    }
    this.status = { ...this.status, ...patch, document } as ServiceStatus;
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
    // "Nothing configured" and "what was configured is not usable" are two
    // answers, and the difference is what the user is told to do next: the
    // first is the development case the Settings screen names, the second is a
    // value somebody wrote that this app will not fetch. Reporting the second
    // as the first (`unsupported`, `feedConfigured: false`, 未配置更新源) is the
    // edit this branch exists to prevent — see `FEED_REFUSAL_STATUS_MESSAGE`.
    if (feed.kind === 'none') {
      return this.set({
        state: 'unsupported',
        feedConfigured: false,
        message: '未配置更新源',
        checkedAt: new Date().toISOString(),
      });
    }
    if (feed.kind === 'rejected') {
      return this.set({
        state: 'error',
        feedConfigured: true,
        message: FEED_REFUSAL_STATUS_MESSAGE[feed.reason],
        checkedAt: new Date().toISOString(),
      });
    }

    this.set({ state: 'checking', feedConfigured: true, message: undefined });

    try {
      const doFetch = this.opts.fetchImpl ?? fetch;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
      const response = await doFetch(feed.url, {
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

      const body = (await response.json()) as UpdateFeedDocument;
      const latest = typeof body.version === 'string' ? body.version.trim() : '';
      if (!latest) {
        return this.set({
          state: 'error',
          message: '更新源缺少 version 字段',
          checkedAt: new Date().toISOString(),
        });
      }

      // The document the user was shown is the document the download uses.
      const document: UpdateFeedDocument = { ...body, version: latest };

      if (compareVersions(latest, this.status.currentVersion) <= 0) {
        return this.set({
          state: 'up-to-date',
          latestVersion: latest,
          message: undefined,
          checkedAt: new Date().toISOString(),
        });
      }

      // The document is the second argument, not a field of the patch: the
      // overload of `set()` for `available` requires one, so this transition
      // cannot be written without the document it is about.
      return this.set(
        {
          state: 'available',
          latestVersion: latest,
          notes: typeof body.notes === 'string' ? body.notes : undefined,
          message: undefined,
          checkedAt: new Date().toISOString(),
        },
        document,
      );
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
    // One read of the status, and the document comes out of it. `available` is
    // *defined* as "there is a check behind this", so the document is not a
    // second field that might be null while the state says otherwise: it is
    // the same value, narrowed. The branch this replaces asked whether the
    // field was null and refused if it was — a check for a disagreement the
    // type no longer allows anything to produce.
    //
    // The document, not a second read of the feed, is what the download uses:
    // the hash and the URL the installer is fetched from must be the ones the
    // version the user was shown was compared against. An earlier build
    // re-fetched the feed here, which reopened exactly the window the stored
    // document exists to close (a feed that changed between the check and the
    // download could name a different file than the one the user was shown).
    const current = this.status;
    if (current.state !== 'available') {
      return this.set({
        state: 'error',
        message: '没有可下载的新版本',
      });
    }
    const info = current.document;
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
    return this.set(
      {
        state: 'ready',
        progress: 1,
        downloadedPath: target,
        verified: true,
        message: undefined,
      },
      // The document travels with the staged path it describes: the click that
      // launches this file re-verifies it against this document, and a `ready`
      // status carrying a path but no document would be exactly the restored
      // shape `installAndRestart()` refuses.
      info,
    );
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
   * gate is what the previous round of this work was about. So the file is
   * opened once, hashed through that descriptor, and the descriptor is *held
   * open* across the window. Immediately before the launch, the same
   * descriptor is `fstat`ed (an in-place rewrite keeps the inode and only the
   * size or mtime can see it) and the path is resolved once more (a rename
   * over the staged name leaves the same descriptor pointing at the old file,
   * so the path has to answer for itself). A file that is no longer that file
   * is deleted, and the refusal is logged with both readings.
   *
   * The residual gap is the one syscall between that last path check and the
   * OS resolving the same path inside the launcher. A path-based launch cannot
   * be atomic with a path check, and `FileIdentity` in `update-feed.ts` says
   * exactly what it does not catch. It is deliberately not "hash the installer
   * a second time": that would move the window rather than close it, and it
   * would double the wait on a button the user already waited on.
   *
   * That gap is not only written down — it is asserted, because a risk nobody
   * can fail is a risk nobody re-reads: `tests/contract/update-integrity.test.ts`
   * ("launches a file replaced after the last check — the window a path launch
   * leaves open") substitutes the staged file *inside* the launcher, after the
   * `fstat` and the path resolution, and pins that the launch proceeds. The
   * day the launch becomes atomic with the check, that test goes red, which is
   * where the paragraph above and the note on `FileIdentity` are to be
   * rewritten.
   *
   * **The feed document is required, and there is no second source for it.**
   * The hash this file is checked against is the one the update check stored;
   * `openStagedInstallerForLaunch()` would answer `no-hash` without it, which
   * is fail-closed but describes the publisher rather than the app. So the
   * document is required up front and the refusal names the real problem —
   * "check again" — instead of "your feed published no hash". That branch is
   * the only way a *restored* status can reach this method: a second process,
   * or a later build that persists `status`, hands this method a
   * `downloadedPath` and nothing else, and it must not launch a file it cannot
   * check. `tests/contract/update-integrity.test.ts` drives it by dropping the
   * document from a service whose download succeeded and pressing install.
   */
  async installAndRestart(): Promise<boolean> {
    const current = this.status;
    const target = current.downloadedPath;
    if (!target || !fs.existsSync(target)) {
      this.set({ state: 'error', message: '安装包不存在，请重新下载' });
      return false;
    }

    // The document the hash comes from. Without it there is nothing to verify
    // against — not a weaker check, no check — so the staged file is not
    // touched and nothing is launched. The file is left on disk rather than
    // deleted: it matched the document that was read when it landed, nothing
    // is known to be wrong with the bytes, and the next download overwrites the
    // same single-slot name. What is taken away is the status's claim that an
    // install is pending, because this method will not install it.
    // `ready` is the one state that may hold this method's answer *and* no
    // document, and `ServiceStatus` says why: a restored status arrives with a
    // `downloadedPath` and no feed document. Every other state reads as "no
    // document", which is the refusal below rather than a launch.
    const info = current.state === 'ready' ? current.document : null;
    if (!info) {
      this.opts.logger.error('update install without the document the update check read', {
        target,
      });
      this.set({
        state: 'error',
        verified: false,
        downloadedPath: undefined,
        message: STALE_UPDATE_DOCUMENT_MESSAGE,
      });
      return false;
    }

    // Verified through a descriptor that stays open until the launch decision.
    // The handle, not the path, is the thing that was hashed: closing and
    // re-opening the path here would leave a second window in which the name
    // could resolve somewhere else.
    const opened = await openStagedInstallerForLaunch(target, {
      sha256: info.sha256,
      size: info.size,
    });
    if (!opened.ok) {
      removeStagedInstaller(target);
      this.opts.logger.error('refusing to install an unverified update', {
        reason: opened.reason,
        expected: opened.expected,
        actual: opened.actual,
      });
      this.set({
        state: 'error',
        verified: false,
        downloadedPath: undefined,
        message: verificationMessage(opened),
      });
      return false;
    }

    // The window between the hash and the launch. Nothing in production runs
    // here (see `beforeLaunch`); the descriptor is held across it, and both
    // the file object and the path are asked again once it closes.
    const unchanged = await this.recheckBeforeLaunch(target, opened.handle);
    if (!unchanged.ok) {
      removeStagedInstaller(target);
      this.opts.logger.error('refusing to install an update that changed after it was verified', {
        reason: unchanged.reason,
        sha256: opened.handle.sha256,
        bytes: opened.handle.bytes,
      });
      this.set({
        state: 'error',
        verified: false,
        downloadedPath: undefined,
        message: changedMessage(unchanged),
      });
      return false;
    }

    this.opts.logger.info('installing update', {
      target,
      sha256: opened.handle.sha256,
    });
    // Launching must happen before quit, and a failed launch must be visible:
    // after quit() the process is going away, so an unchecked openPath would
    // end the app with the user never seeing an installer.
    const launcher = this.opts.openInstaller ?? ((file: string) => shell.openPath(file));
    void launcher(target).then((launchError) => {
      if (launchError) {
        this.opts.logger.error('update installer failed to launch', {
          target,
          reason: launchError,
        });
        this.set({ state: 'error', message: launchError });
      } else {
        // `app` is always present in the real main process; the guard keeps
        // a test that exercises the launch path from taking the process down
        // with it.
        app?.quit?.();
      }
    });
    return true;
  }

  /**
   * Runs the test seam and answers whether the open file is still the one it
   * was verified as.
   *
   * The descriptor is closed here, on every path, because the callers either
   * delete the staged file or hand it to the launcher immediately afterwards.
   * Keeping it open past the decision would only make `rmSync` fight an open
   * handle on Windows.
   */
  private async recheckBeforeLaunch(
    target: string,
    handle: StagedInstallerHandle,
  ): Promise<StagedFileCheck> {
    try {
      await this.opts.beforeLaunch?.(target);
      return checkOpenStagedInstaller(target, handle);
    } finally {
      closeStagedInstaller(handle);
    }
  }

  /** Used by the Settings screen when the user would rather do it themselves. */
  openFeed(): void {
    const feed = this.resolveFeed();
    if (feed.kind === 'ok') void shell.openExternal(feed.url);
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
 * The transport behind the default downloader: https, and only https.
 *
 * Every URL that reaches the downloader has already been through
 * `checkChannelUrl()` (the installer) or `resolveDownloadRedirect()` (each
 * hop), both of which refuse anything but https — so there is no branch on the
 * scheme here. The old code chose the `http` module for a non-https URL, on the
 * theory that a test seam could drive the download path with cleartext. That
 * made the plaintext transport a live value in the file that performs the
 * download: unreachable through the rule, but one edit away from being called.
 * `tests/contract/update-integrity.test.ts` scans this file for a plaintext
 * request, and `node:http` is a type-only import now.
 */
const defaultDownloadGet: DownloadGet = (url, options, onResponse) =>
  https.get(url, options, onResponse);

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
          // The hop number travels with the refusal: "which redirect" is what
          // turns "更新失败" into a report a publisher can act on, and the
          // count is the one fact in this message the server chose. `depth` is
          // the request that redirected, so the hop being judged is
          // `depth + 1` — the sixth for the sixth `Location`.
          //
          // The address goes with it for the same reason. "次数过多" alone
          // says the download gave up; it does not say *where*, and a redirect
          // loop is diagnosed from the one URL that kept answering 302. The
          // URL printed is the request's own — a URL that already passed the
          // channel's rule — not the header text, which is the value the
          // refusal exists to reject and is not something to hand to a reader
          // as if it were an address.
          reject(
            new Error(
              `${REDIRECT_MESSAGE[redirect.reason]}（第 ${depth + 1} 次跳转，请求地址 ${url.toString()}）`,
            ),
          );
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
