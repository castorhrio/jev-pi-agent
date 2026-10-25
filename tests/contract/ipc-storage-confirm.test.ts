/**
 * An unconfirmed purge is a malformed request, not a permission problem.
 *
 * ## Why this file exists
 *
 * `storage:purge` deletes transcripts and blobs, so it is refused unless the
 * caller has previewed the scope and said yes — that part was always true. What
 * was not: the "yes" was checked by hand, after the request had already passed
 * validation, and the refusal answered `PERMISSION_DENIED`.
 *
 * Both halves of that are the same bug from a distance. Every other IPC channel
 * in this app rejects a bad payload as 「输入无效」 because the payload is
 * described by a schema; the purge channel described `confirm` as an optional
 * boolean (so `false`, `"true"` and *missing* all validated) and then refused it
 * as a permission decision. A user whose client forgot the field got told the
 * app would not let them do something, which is not what happened and not
 * something they can fix.
 *
 * The confirmation now lives in the schema, which is the one place the Renderer
 * contract is written down. These tests are what keeps it there: they call the
 * handler registered on the real channel, and assert that an unconfirmed purge
 * fails in validation — before the retention service is ever constructed — while
 * a confirmed one gets through to the next rule.
 */

import { describe, expect, it } from 'vitest';
import { IPC_CHANNELS } from '@ucad/contracts';
import { registerStorageIpc } from '../../apps/desktop/src/main/ipc-storage';
import type { UcadApp } from '../../apps/desktop/src/main/app-container';

/** The handlers `registerStorageIpc` registers, by channel. */
function registeredHandlers(ucad: UcadApp = {} as UcadApp): Map<string, (...args: unknown[]) => unknown> {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  registerStorageIpc({
    handle: (channel, fn) => {
      handlers.set(channel, fn);
    },
    // Nothing here should reach the container: every case below is decided by
    // validation (or by the "no project open" rule), both of which run before
    // the retention service touches `db`, `blobs` or `sessionStore`.
    ucad,
    getWindow: () => null,
  });
  return handlers;
}

const handlers = registeredHandlers();
const purge = handlers.get(IPC_CHANNELS.storage.purge);

/**
 * A Zod failure, recognised by shape rather than by `instanceof`.
 *
 * The Renderer side is out of reach here (this test loads a Main module), and
 * the app keeps `zod` as a workspace dependency of the app itself rather than a
 * root one, so an import of it from a test would be an undeclared dependency —
 * `npm run knip` says so. The shape is stable and narrow enough: an `issues`
 * array whose first entry names the failing field is exactly what `toUserError`
 * reads when it renders 「输入无效 (confirm)」.
 */
interface ValidationFailure {
  issues: Array<{ path: Array<string | number>; message: string }>;
}

function isValidationFailure(error: unknown): error is ValidationFailure {
  const issues = (error as { issues?: unknown } | null)?.issues;
  return Array.isArray(issues) && issues.length > 0;
}

async function rejection(payload: unknown): Promise<unknown> {
  expect(purge, 'storage:purge is not registered').toBeDefined();
  try {
    await purge!(payload);
    return null;
  } catch (error) {
    return error;
  }
}

describe('storage:purge refuses an unconfirmed request at the schema', () => {
  it('registers the channel', () => {
    // Guard: if registration changed shape and the map went empty, every
    // assertion below would be vacuous.
    expect(handlers.size).toBeGreaterThan(0);
    expect(typeof purge).toBe('function');
  });

  it('rejects a request with no confirm field', async () => {
    const error = await rejection({ scope: 'all' });

    expect(isValidationFailure(error), 'an unconfirmed purge was accepted').toBe(true);
    const issue = (error as ValidationFailure).issues[0];
    expect(issue?.path).toEqual(['confirm']);
    // The message a person sees: `toUserError` renders a ZodError as
    // 「输入无效 (confirm): …」 with this text after the colon.
    expect(issue?.message).toContain('确认');
  });

  it('rejects confirm: false and confirm: "true" with the same sentence', async () => {
    // `false` is the value a UI actually sends when the user has not ticked the
    // box, so it is the case that has to read like a sentence, not like a type
    // error. `z.literal(true, { message })` answered a *missing* field in
    // Chinese and every wrong value in English; this loop is what catches a
    // return to that.
    for (const confirm of [false, 'true', 1, null]) {
      const error = await rejection({ scope: 'all', confirm });
      expect(isValidationFailure(error), `confirm: ${String(confirm)} was accepted`).toBe(true);
      const issue = (error as ValidationFailure).issues[0];
      expect(issue?.path, `confirm: ${String(confirm)} blamed the wrong field`).toEqual(['confirm']);
      expect(issue?.message, `confirm: ${String(confirm)} got no Chinese prompt`).toContain(
        '确认',
      );
      expect(issue?.message).not.toMatch(/invalid|Invalid|expected/i);
    }
  });

  it('does not report an input mistake as PERMISSION_DENIED', async () => {
    const error = await rejection({ scope: 'all' });

    expect(isValidationFailure(error)).toBe(true);
    // A hand-written appError('PERMISSION_DENIED', …) is a plain Error whose
    // message is already user-facing; that shape must not come back.
    expect((error as Error).message).not.toContain('PERMISSION_DENIED');
    expect((error as Error).message).not.toContain('权限');
  });

  it('lets a confirmed request through to the next rule', async () => {
    // `workspace` scope without a workspace id is refused by the storage rule
    // that sits *after* validation, so reaching it proves the schema accepted
    // `confirm: true` — no database is needed to see that.
    const error = await rejection({ scope: 'workspace', confirm: true });

    expect(error).toBeInstanceOf(Error);
    expect(isValidationFailure(error), 'a confirmed purge was rejected as malformed').toBe(false);
    expect((error as Error).message).toContain('没有已打开的项目');
  });
});

/**
 * There is one retention service, and it is Main's.
 *
 * The storage IPC layer used to build its own, lazily, on first use — a second
 * instance of a service the container had already built, with its own view of
 * the same database. A purge that ran in one and a retention sweep that ran in
 * the other could each believe they had the last word about what was left on
 * disk. The container now hands out the one instance; these tests are what
 * keeps it that way.
 */
describe('storage:purge uses the one retention service', () => {
  it('runs two purges through the same instance', async () => {
    const purges: Array<{ scope: string; workspaceId?: string }> = [];
    /** how many retention services were built — one is the answer */
    let built = 0;

    const instance = {
      purge: async (scope: string, workspaceId?: string) => {
        purges.push({ scope, workspaceId });
        return { sessions: 0, turns: 0, events: 0, messages: 0, blobFiles: 0 };
      },
    };

    const ucad = {
      getRetention: () => {
        // The container builds one instance and hands out that one.
        if (built === 0) built += 1;
        return instance;
      },
      // If the IPC layer built a service of its own it would have to read
      // these — and building one is exactly the bug this test is about.
      get db(): never {
        throw new Error('the storage IPC layer must not build its own retention service');
      },
      get sessionStore(): never {
        throw new Error('the storage IPC layer must not build its own retention service');
      },
      get blobs(): never {
        throw new Error('the storage IPC layer must not build its own retention service');
      },
      get paths(): never {
        throw new Error('the storage IPC layer must not build its own retention service');
      },
    } as unknown as UcadApp;

    const handlers = registeredHandlers(ucad);
    const purge = handlers.get(IPC_CHANNELS.storage.purge);
    expect(typeof purge).toBe('function');

    await purge!({ scope: 'all', confirm: true });
    await purge!({ scope: 'expired', confirm: true });

    expect(purges).toEqual([
      { scope: 'all', workspaceId: undefined },
      { scope: 'expired', workspaceId: undefined },
    ]);
    expect(built, 'the two purges did not share one retention service').toBe(1);
  });
});
