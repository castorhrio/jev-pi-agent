/**
 * The update status machine: which state may carry the feed document, and what
 * happens when a transition tries to enter one with the wrong half.
 *
 * ## Why this file exists
 *
 * `UpdateService` used to keep `status` and `feed` as two fields with
 * "`state === 'available'` implies a document" promised in a comment. The
 * previous round merged them into a discriminated union and gave `set()` an
 * overload per document-carrying state, so the promise became a compile error
 * inside `update-service.ts`. What nothing did was *enumerate* the transitions:
 * the overloads are described in a comment, and `tests/` is transpiled without
 * typechecking, so an overload this suite cannot reach is a rule nobody
 * re-reads. The two cases the union was built for — `available` with no
 * document, and a *restored* `ready` whose document was never persisted — had
 * no test that names them.
 *
 * ## What is pinned, and where the second half lives
 *
 * `STATUS_DOCUMENT_POLICY` is the table (`required` / `optional` / `forbidden`)
 * and `statusAcceptsDocument()` is that table asked as one question. The
 * compile-time half is the `set()` overloads, checked by `npm run typecheck`
 * where `tsc` runs. This file is the runtime half, and it is deliberately not a
 * copy of the table: `CARRYING` below is hand-written, so a state whose rule
 * changed has to be changed here on purpose, and a state added to the
 * vocabulary has to be given a row (both directions are compared against
 * `UPDATE_STATES`, which is the same array the type is derived from in
 * `@ucad/contracts`).
 *
 * The last two cases drive the product rather than the predicate: a legal
 * transition is entered and observed, an illegal one throws and leaves the last
 * legal state in place, and the restored `ready` shape reaches
 * `STALE_UPDATE_DOCUMENT_MESSAGE` instead of launching a file nothing can
 * verify.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { silentLogger } from '@ucad/observability';
import { UPDATE_STATES, type UpdateState } from '@ucad/contracts';

import {
  STATUS_DOCUMENT_POLICY,
  STALE_UPDATE_DOCUMENT_MESSAGE,
  UpdateService,
  statusAcceptsDocument,
} from '../../apps/desktop/src/main/update-service';
import type { UpdateFeedDocument } from '../../apps/desktop/src/main/update-feed';

const FEED_URL = 'https://example.test/update-feed.json';
const INSTALLER_URL = 'https://example.test/UCAD-Setup-9.9.9.exe';
const INSTALLER = 'the genuine installer';

function sha256Of(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

const DOCUMENT: UpdateFeedDocument = {
  version: '9.9.9',
  url: INSTALLER_URL,
  sha256: sha256Of(INSTALLER),
  size: INSTALLER.length,
};

/**
 * What one state does with a document, hand-written.
 *
 * Two booleans per state rather than a copy of the policy table: `without` is
 * "may hold no document", `with` is "may hold one". `required` is therefore
 * `{ without: false, with: true }`, `forbidden` is `{ true, false }` and
 * `optional` is `{ true, true }` — but writing the table out twice would make
 * this file agree with a bug in the policy by construction.
 */
const CARRYING: Record<UpdateState, { readonly without: boolean; readonly with: boolean }> = {
  idle: { without: true, with: false },
  checking: { without: true, with: false },
  'up-to-date': { without: true, with: false },
  // The one state that is *defined* as "there is a check behind this".
  available: { without: false, with: true },
  downloading: { without: true, with: false },
  // The one state a rebuilt status can arrive in: a path, and no document.
  ready: { without: true, with: true },
  error: { without: true, with: false },
  unsupported: { without: true, with: false },
};

/** The state and document a service's private status holds, read for assertions. */
interface InternalStatus {
  readonly state: UpdateState;
  readonly document: UpdateFeedDocument | null;
}

/**
 * The private surface this file drives.
 *
 * `set()` is private because nothing outside `update-service.ts` may write a
 * transition — that is the point of the funnel. The two things a test needs
 * from it are the ones the compiler cannot check here: entering an illegal
 * shape on purpose (to prove the runtime check answers), and writing the
 * restored status a future build would hand over.
 */
interface InternalService {
  status: InternalStatus;
  set(patch: Record<string, unknown>, document?: unknown): unknown;
}

const internal = (instance: UpdateService): InternalService =>
  instance as unknown as InternalService;

/** A transport that answers one feed request with `document`. */
function feedFetch(document: unknown): { fetchImpl: typeof fetch; calls: () => number } {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return new Response(JSON.stringify(document), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls: () => calls };
}

describe('the update vocabulary is one array, and every state has a policy', () => {
  it('names each state once and gives every one of them a document policy', () => {
    expect(new Set(UPDATE_STATES).size, 'a state is listed twice').toBe(UPDATE_STATES.length);
    expect(
      Object.keys(STATUS_DOCUMENT_POLICY).sort(),
      'a state exists with no document policy, or a policy exists for a state that is gone',
    ).toEqual([...UPDATE_STATES].sort());
    // Non-vacuous: an empty vocabulary would satisfy both checks above.
    expect(UPDATE_STATES.length).toBeGreaterThan(4);
  });

  it('says which state requires a document and which merely allows one', () => {
    const required = UPDATE_STATES.filter((state) => STATUS_DOCUMENT_POLICY[state] === 'required');
    const optional = UPDATE_STATES.filter((state) => STATUS_DOCUMENT_POLICY[state] === 'optional');

    // Exactly one of each, and named: the two are not interchangeable, and a
    // third state granted either policy is a change to the state machine that
    // has to be a decision. `available` without a document is a version the
    // user was shown and nothing to download; `ready` without one is a
    // restored pending install.
    expect(required, 'the "must have a document" states are not exactly [available]').toEqual([
      'available',
    ]);
    expect(optional, 'the "may have a document" states are not exactly [ready]').toEqual(['ready']);
  });
});

/**
 * The matrix, asked of the predicate *and* of the product.
 *
 * The table above is a value, so this block can ask it 16 times; the `set()`
 * calls then prove the funnel reads the same answer before it writes, which is
 * the half the overloads cannot be checked for in a suite that is transpiled
 * without typechecking.
 */
describe('every state × document combination answers the way the rule says', () => {
  it('accepts and refuses the same combinations in statusAcceptsDocument()', () => {
    expect(
      Object.keys(CARRYING).sort(),
      'the hand-written matrix and UPDATE_STATES disagree about which states exist',
    ).toEqual([...UPDATE_STATES].sort());

    for (const state of UPDATE_STATES) {
      const expected = CARRYING[state];
      expect(
        statusAcceptsDocument(state, null),
        `${state}: a document-free status was judged ${expected.without ? 'refused' : 'accepted'}`,
      ).toBe(expected.without);
      expect(
        statusAcceptsDocument(state, DOCUMENT),
        `${state}: a status carrying a document was judged ${expected.with ? 'accepted' : 'refused'}`,
      ).toBe(expected.with);
    }
  });
});

describe('set() refuses a transition the document does not suit', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ucad-status-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** A service in `idle`, with a feed that would report 9.9.9 as available. */
  function service(): UpdateService {
    const fetched = feedFetch(DOCUMENT);
    return new UpdateService({
      logger: silentLogger('test'),
      getFeedUrl: () => FEED_URL,
      downloadDir: dir,
      currentVersion: '1.0.0',
      fetchImpl: fetched.fetchImpl,
    });
  }

  it('enters every legal transition and refuses every illegal one, leaving the status alone', () => {
    for (const state of UPDATE_STATES) {
      const expected = CARRYING[state];

      for (const document of [null, DOCUMENT] as const) {
        const instance = service();
        const label = `${state} ${document === null ? 'without' : 'with'} a document`;
        const accepted = document === null ? expected.without : expected.with;

        // `idle` is where every one of these starts, so "the status was left
        // alone" is a claim about a state that is not the one being entered.
        const before = internal(instance).status;

        const attempt = (): unknown => internal(instance).set({ state }, document ?? undefined);

        if (accepted) {
          expect(attempt, `${label} was refused by set()`).not.toThrow();
          expect(internal(instance).status.state, `${label} did not enter the state`).toBe(state);
          expect(internal(instance).status.document).toBe(document);
        } else {
          // The name of the state is in the failure: a reader should not have
          // to bisect the matrix to find the row that broke.
          expect(attempt, `${label} was accepted by set()`).toThrow(state);
          expect(internal(instance).status, `${label} was half-written`).toBe(before);
        }
      }
    }
  });

  it('cannot enter available without the document the check read', () => {
    // The transition the union was built for. The compile-time half is the
    // `set()` overload (`available` needs a second argument); this is the
    // runtime half, reached the way a cast or an untyped caller would reach it.
    const instance = service();

    expect(() => internal(instance).set({ state: 'available', latestVersion: '9.9.9' })).toThrow(
      /available/,
    );
    expect(internal(instance).status.state, 'an illegal transition was written anyway').toBe('idle');
    expect(internal(instance).status.document).toBeNull();

    // And the app does not pretend: with no check behind it, the download
    // refuses instead of re-reading the feed to rescue itself.
    expect(instance.current.state).toBe('idle');
  });
});

/**
 * The shape the union exists for on the other side: `ready` without a document.
 *
 * Nothing in this process can produce it — `download()` carries the document it
 * verified into `ready` — which is why the old test for this refusal drove an
 * `error` status that happened to keep a `downloadedPath`. The shape is the one
 * a later build that persists the status would hand over (a path, and no
 * document, because nothing persists one), so it is built here directly. The
 * pair of cases is deliberate: the same file, the same status, one field
 * different, and the two answers are "launch" and "refuse with the sentence
 * about checking again".
 */
describe('a ready status with no document is a refusal, and with one is a launch', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ucad-restored-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function staged(): Promise<{ instance: UpdateService; launched: string[] }> {
    const fetched = feedFetch(DOCUMENT);
    const launched: string[] = [];
    const instance = new UpdateService({
      logger: silentLogger('test'),
      getFeedUrl: () => FEED_URL,
      downloadDir: dir,
      currentVersion: '1.0.0',
      fetchImpl: fetched.fetchImpl,
      downloadImpl: async (_url, target) => {
        writeFileSync(target, INSTALLER);
      },
      openInstaller: async (target) => {
        launched.push(target);
        return '';
      },
    });
    expect((await instance.check()).state).toBe('available');
    expect((await instance.download()).state).toBe('ready');
    return { instance, launched };
  }

  it('launches the staged installer while the document is there', async () => {
    // The positive control: without it, the refusal below would also pass for a
    // status that can never launch.
    const { instance, launched } = await staged();

    expect(await instance.installAndRestart()).toBe(true);
    expect(launched).toEqual([join(dir, 'UCAD-setup.exe')]);
  });

  it('asks for a fresh check instead of launching a file nothing describes', async () => {
    const { instance, launched } = await staged();

    // What a restored status looks like: the path survives, the document does
    // not (nothing persists one). Not produced by this process's own code —
    // written here, because that is the reader `installAndRestart()` is written
    // for.
    const current = internal(instance).status;
    internal(instance).status = { ...current, document: null };

    expect(await instance.installAndRestart()).toBe(false);
    expect(launched, 'a file no document describes was launched').toEqual([]);

    const status = instance.current;
    expect(status.state).toBe('error');
    expect(status.verified, 'the status still claims a file was checked').toBe(false);
    expect(status.downloadedPath, 'the status still offers an install it will not perform').toBe(
      undefined,
    );
    // "check again", not "your feed published no hash": the feed is fine, the
    // app lost the answer — so the staged file is kept rather than deleted.
    expect(status.message).toBe(STALE_UPDATE_DOCUMENT_MESSAGE);
    expect(
      existsSync(join(dir, 'UCAD-setup.exe')),
      'a download that verified when it landed was deleted over a lost document',
    ).toBe(true);
  });
});
