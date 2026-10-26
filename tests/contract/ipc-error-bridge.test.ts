/**
 * Where the §4.11 code stops.
 *
 * ## Why this file exists
 *
 * The last three commits gave every Main refusal a code (`codedError()`) so the
 * log line stops saying `UNKNOWN`. That fix is only correct if the code stays on
 * Main's side of the bridge: the Renderer must keep receiving *one user-safe
 * sentence*, because the sentence is what a person reads and the code is what
 * the log, the support report and any later statistics read.
 *
 * Nothing pinned that boundary. `error.ts` described `codedError()` as carrying
 * `code`/`component`/`retryable`, which reads as if the code travelled to the
 * Renderer; `toUserError()` in `ipc.ts` converts the rejection back to a plain
 * `new Error(message)` a few lines below the logging, and no test noticed.
 * The two halves of the claim — "the log has the code" and "the user sees the
 * sentence" — are asserted here against the *registered* handler, so the
 * wrapper's behaviour is what is being tested, not a copy of it.
 *
 * ## What actually crosses
 *
 * Electron's `ipcMain.handle` carries a rejection to the Renderer as an `Error`,
 * and an `Error` crosses as its message (plus stack): custom own properties do
 * not survive. That is not a detail to be clever about — it is the reason the
 * code is dropped deliberately here rather than left to serialisation. A
 * Renderer that started branching on `error.code` would branch on `undefined`
 * forever, so the shape below (an `Error` with a message and nothing else) is
 * the contract, and a future "improvement" that attaches fields to it should
 * fail here.
 */

import { describe, it, expect, vi } from 'vitest';

const { handlers, log } = vi.hoisted(() => ({
  /** channel -> the function `ipcMain.handle` was given */
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  /** every `logger.error(...)` call, in order */
  log: [] as Array<{ event: string; fields?: Record<string, unknown> }>,
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    },
    removeHandler: (channel: string) => {
      handlers.delete(channel);
    },
  },
  dialog: {
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    showSaveDialog: async () => ({ canceled: true }),
    showMessageBox: async () => ({ response: 1 }),
  },
  BrowserWindow: class {},
}));

import { IPC_CHANNELS } from '@ucad/contracts';
// The reason table comes from its own module, not from `ipc.ts`: the wording of
// a refusal no longer needs the whole IPC surface registered (and Electron
// mocked) to be asked a question, and the table's tests below are the reason
// that separation exists.
import {
  ZOD_ISSUE_CODES,
  ZOD_REASON_BY_CODE,
  ZOD_REASON_GENERIC,
  zodReason,
} from '../../apps/desktop/src/main/ipc-errors';
import { registerIpc } from '../../apps/desktop/src/main/ipc';
import type { UcadApp } from '../../apps/desktop/src/main/app-container';
import type { Locale } from '../../apps/desktop/src/shared/i18n';

/**
 * The real registration, with a container that can only do what a refusal
 * needs: log. Every case below is decided before `db`, `blobs` or the session
 * store are touched, so this stub is complete rather than convenient.
 */
registerIpc(
  {
    logger: {
      error: (event: string, fields?: Record<string, unknown>) => {
        log.push({ event, fields });
      },
    },
  } as unknown as UcadApp,
  () => null,
  {
    getLocale: (): Locale => 'zh-CN',
    setLocale: () => {},
    // No update service wired up in this test: `app.checkUpdate` refuses with
    // FEATURE_UNAVAILABLE, which is a coded refusal that needs no dependencies.
    getUpdates: () => null,
    getVersion: () => '1.0.0',
  },
);

/** Calls the handler the way Electron would: (event, ...args). */
async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = handlers.get(channel);
  expect(handler, `${channel} is not registered`).toBeDefined();
  try {
    return await handler!(undefined, ...args);
  } catch (error) {
    return error;
  }
}

describe('a coded refusal crosses the bridge as one sentence', () => {
  it('refuses with a code on the log line', async () => {
    log.length = 0;
    await invoke(IPC_CHANNELS.app.checkUpdate);

    const entry = log.find((line) => line.fields?.channel === IPC_CHANNELS.app.checkUpdate);
    expect(entry, 'the refusal produced no log line').toBeDefined();
    // The whole point of `codedError()`: a refusal is distinguishable from a
    // crash in the log.
    expect(entry!.fields?.code).toBe('FEATURE_UNAVAILABLE');
    expect(entry!.fields?.message).toBe('更新服务不可用');
  });

  it('hands the Renderer the sentence alone', async () => {
    const rejection = await invoke(IPC_CHANNELS.app.checkUpdate);

    // An `Error`, because that is the only thing Electron carries faithfully;
    // a thrown plain object arrives as unhelpful text.
    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toBe('更新服务不可用');
    // Neither the code nor a formatting artifact reaches the user.
    expect((rejection as Error).message).not.toContain('FEATURE_UNAVAILABLE');
    expect((rejection as Error).message).not.toContain('[object Object]');
    expect((rejection as Error).message).not.toBe('UNKNOWN');
  });

  it('carries no code, component or retryable across — the code ends at the log', async () => {
    const rejection = (await invoke(IPC_CHANNELS.app.checkUpdate)) as Error;

    // `code`/`component`/`retryable` are exactly what `codedError()` attaches on
    // Main. None of them may survive the wrapper.
    expect('code' in rejection, 'the code leaked to the Renderer').toBe(false);
    expect('component' in rejection).toBe(false);
    expect('retryable' in rejection).toBe(false);
    // And nothing enumerable rides along either: Electron's serialisation of an
    // `Error` keeps the message, so an own enumerable field is the shape a
    // "let's also pass the code" change would take.
    //
    // This line's meaning depends on a contract one file over: `codedError()`
    // attaches `code`/`component`/`retryable` as *enumerable*, and
    // `toUserError()` rebuilds a clean `new Error(message)`. Make those fields
    // non-enumerable and this assertion stops proving anything while still
    // passing. `error-formatting.test.ts` pins the enumerable half.
    expect(Object.keys(rejection)).toEqual([]);
    // Same statement from the Renderer's side of a structured clone.
    expect(JSON.parse(JSON.stringify(rejection))).toEqual({});
  });
});

describe('input mistakes are not refusals with codes', () => {
  it('reports a Zod failure as 输入无效 with the failing field named', async () => {
    log.length = 0;
    // `42` is not a locale string, so the schema rejects it before the handler
    // reaches its own `codedError('INVALID_INPUT', …)`.
    const rejection = (await invoke(IPC_CHANNELS.app.setLocale, 42)) as Error;

    expect(rejection).toBeInstanceOf(Error);
    expect(rejection.message).toContain('输入无效');
    // The multi-line JSON dump Zod puts in `.message` must not be what a toast
    // shows, and the raw input must not be echoed back.
    expect(rejection.message).not.toContain('\n');
    expect(rejection.message).not.toContain('42');
    expect('code' in rejection).toBe(false);
  });
});

/**
 * The sentence is Chinese — including the reason, not just the label.
 *
 * ## Why this file exists
 *
 * `toUserError` built its line as 「输入无效 (field): <issue.message>」, and
 * `issue.message` is Zod's own text unless the schema wrote one. Two schemas in
 * this app write theirs (the purge confirmation and its unknown-field refusal);
 * the rest do not, which is nearly all of the IPC surface. So a user who sent
 * the wrong type to `terminal:ptyResize` was shown
 *
 *     输入无效 (cols): Expected number, received string
 *
 * — the field name translated, the reason left in the library's English, and
 * arguably the wrong half translated. §7.2 promises a *user-safe* sentence;
 * "the diagnostics of a validation library" is not one, and a person cannot act
 * on `Expected number`.
 *
 * The fix belongs in the wrapper, not on forty schemas: the reason is now
 * derived from the issue `code` (see `zodReason`), and a schema that did write a
 * sentence keeps it. Both halves are asserted below, because the fix for the
 * first is one line away from destroying the second.
 */
describe('a schema failure reaches the person in Chinese', () => {
  /**
   * One failing payload per shape, each refused by the schema before its handler
   * touches a service — the container in this file only has a logger, so any
   * case that got further would throw something other than a schema failure and
   * fail the `输入无效` assertion rather than pass quietly.
   */
  const cases: Array<{ name: string; channel: string; args: unknown[]; reason: string }> = [
    // whole payload of the wrong type: no field to name, so the reason is all
    { name: 'wrong type', channel: IPC_CHANNELS.app.setLocale, args: [42], reason: '类型不正确' },
    // an enum field: Zod's own message would quote the value back
    {
      name: 'value outside an enum',
      channel: IPC_CHANNELS.workspace.setTrust,
      args: ['sure'],
      reason: '取值不在允许的范围内',
    },
    // a string that is too short
    { name: 'empty string', channel: IPC_CHANNELS.sessions.resume, args: [''], reason: '内容太短' },
    // a field inside an object, which is what the `(field)` part is for
    {
      name: 'wrong type in a field',
      channel: IPC_CHANNELS.terminal.ptyResize,
      args: [{ terminalId: 't1', cols: '80', rows: 24 }],
      reason: '类型不正确',
    },
    // a number below its minimum
    {
      name: 'number below its minimum',
      channel: IPC_CHANNELS.events.since,
      args: [{ sessionId: 's1', afterSeq: -1 }],
      reason: '数值太小',
    },
    // "the field was not sent" is a different mistake from "the wrong type"
    {
      name: 'missing field',
      channel: IPC_CHANNELS.events.since,
      args: [{ afterSeq: 0 }],
      reason: '缺少必填字段',
    },
  ];

  for (const item of cases) {
    it(`keeps ${item.name} in Chinese, and names the reason`, async () => {
      log.length = 0;
      const rejection = (await invoke(item.channel, ...item.args)) as Error;

      expect(rejection, `${item.name} was not refused`).toBeInstanceOf(Error);
      expect(rejection.message).toContain('输入无效');
      expect(rejection.message).toContain(item.reason);
      // The boundary: no English reaching the Renderer. Zod's own wording is
      // what this guards against, so the check is for the words Zod uses, not
      // for "some translation happened" — a schema failure that says
      // `Expected string` has failed a person whether or not 「输入无效」 leads
      // the line.
      expect(rejection.message).not.toMatch(/expected|invalid|required|must contain/i);
      // And still one line: the multi-line JSON dump stays in the log.
      expect(rejection.message).not.toContain('\n');
    });
  }

  it('keeps a sentence the schema wrote itself', async () => {
    // The purge refusal is Chinese at the source, and it is the case the
    // wrapper must not overwrite: `PURGE_UNCONFIRMED` is a sentence about
    // confirming a deletion, which no phrase keyed by an issue code can say.
    const unconfirmed = (await invoke(IPC_CHANNELS.storage.purge, { scope: 'all' })) as Error;
    expect(unconfirmed.message).toContain('确认');

    // `strict(msg)` is the same shape with a different code
    // (`unrecognized_keys`), and the same requirement: the field list it spells
    // out survives the wrapper.
    const unknownField = (await invoke(IPC_CHANNELS.storage.purge, {
      scope: 'all',
      confirm: true,
      force: true,
    })) as Error;
    expect(unknownField.message).toContain('未知的字段');
    expect(unknownField.message).not.toMatch(/unrecognized/i);
  });
});

/**
 * The code of a malformed request, on the log side of the bridge.
 *
 * ## Why this file exists
 *
 * `toAppError()` reads a `code` and a `component` off the error it is given,
 * and a `ZodError` has neither — so every schema failure was logged as
 * `UNKNOWN`, side by side with the crashes it is nothing like. A log in which
 * "the client sent the wrong fields" and "the app fell over" are the same
 * entry cannot answer either question: the first is fixable by the caller,
 * the second is a bug.
 *
 * So a schema failure gets the code it always should have had,
 * `INVALID_INPUT` — the code the app already uses for a payload it refuses.
 * The *Renderer* still receives the one user-safe sentence and no code; that
 * boundary is the one above and it does not move.
 */
describe('a malformed request is logged as INVALID_INPUT, not as a crash', () => {
  it('gives a schema failure a code of its own', async () => {
    log.length = 0;
    const rejection = (await invoke(IPC_CHANNELS.app.setLocale, 42)) as Error;

    expect(rejection.message).toContain('输入无效');
    const entry = log.find((line) => line.fields?.channel === IPC_CHANNELS.app.setLocale);
    expect(entry, 'the refusal produced no log line').toBeDefined();
    expect(entry!.fields?.code).toBe('INVALID_INPUT');
    // The log line is the sentence a person reads, not Zod's JSON dump of
    // every issue: the dump is unreadable in a log line and it echoes the
    // input back.
    expect(String(entry!.fields?.message)).toContain('输入无效');
    expect(String(entry!.fields?.message)).not.toContain('42');
    expect(String(entry!.fields?.message)).not.toContain('\n');
  });

  it('names the field that was wrong, and not its value', async () => {
    log.length = 0;
    // A purge request with a field the schema does not know. The field name
    // is what a log needs; the value must not be repeated back into it.
    await invoke(IPC_CHANNELS.storage.purge, { scope: 'all', confirm: true, extra: 1 });

    const entry = log.find((line) => line.fields?.channel === IPC_CHANNELS.storage.purge);
    expect(entry, 'the refusal produced no log line').toBeDefined();
    expect(entry!.fields?.code).toBe('INVALID_INPUT');
    expect(entry!.fields?.invalidFields).toEqual(['extra']);
    expect(String(entry!.fields?.message)).not.toContain('extra');
  });

  it('names the field of a missing confirmation too', async () => {
    log.length = 0;
    await invoke(IPC_CHANNELS.storage.purge, { scope: 'all' });

    const entry = log.find((line) => line.fields?.channel === IPC_CHANNELS.storage.purge);
    expect(entry).toBeDefined();
    expect(entry!.fields?.code).toBe('INVALID_INPUT');
    expect(entry!.fields?.invalidFields).toEqual(['confirm']);
  });

  it('says where the reason in the sentence came from', async () => {
    // The sentence does not say *why* it reads the way it does — it is Chinese
    // either way. So the log has to answer that, or a support report cannot
    // tell "this schema wrote no message" from "this schema's message was
    // swallowed and replaced by the table's Chinese". The second is a bug in
    // the wording rule and the first is not, and only the second is invisible
    // in the sentence: both refusals look identical to the person reading
    // them.
    log.length = 0;
    await invoke(IPC_CHANNELS.app.setLocale, 42);

    const entry = log.find((line) => line.fields?.channel === IPC_CHANNELS.app.setLocale);
    expect(entry, 'the refusal produced no log line').toBeDefined();
    // The locale schema writes no message, so Zod's own wording was replaced
    // by the table's Chinese.
    expect(entry!.fields?.reasonSource).toBe('table');
  });

  it('says "schema" when the schema wrote the sentence itself', async () => {
    // The purge confirmation is the one sentence in this app that says what
    // the person has to do, and the log has to be able to say that it
    // survived rather than infer it.
    log.length = 0;
    await invoke(IPC_CHANNELS.storage.purge, { scope: 'all' });

    const entry = log.find((line) => line.fields?.channel === IPC_CHANNELS.storage.purge);
    expect(entry, 'the refusal produced no log line').toBeDefined();
    expect(entry!.fields?.reasonSource).toBe('schema');
    // And the sentence it explains is that sentence, not a table entry.
    expect(String(entry!.fields?.message)).toContain('清理未确认');
  });

  it('names the request as a whole when no one field is at fault', async () => {
    log.length = 0;
    // `storage:setRetention` takes a union: a positive day count, or `null` for
    // "keep forever". A string matches neither branch, so the issue has no
    // path — and the field list used to carry the issue `code` instead, so the
    // log line said the wrong fields were `['invalid_union']`: an English
    // identifier in a list of field names, reading as a field called
    // "invalid_union". The reason is already in the sentence; the field list
    // only has to say "not one field in particular".
    const rejection = (await invoke(IPC_CHANNELS.storage.setRetention, 'forever')) as Error;

    expect(rejection.message).toBe('输入无效：格式不匹配');
    const entry = log.find((line) => line.fields?.channel === IPC_CHANNELS.storage.setRetention);
    expect(entry, 'the refusal produced no log line').toBeDefined();
    expect(entry!.fields?.code).toBe('INVALID_INPUT');
    expect(entry!.fields?.invalidFields).toEqual(['整体']);
    // The code stays out of the line a person reads a log to understand.
    expect(JSON.stringify(entry!.fields)).not.toContain('invalid_union');
  });
});

/**
 * The reason table covers every code this build's Zod can raise.
 *
 * ## Why this file exists
 *
 * `zodReason` used to be a `switch` with a `default`. The `default` was the
 * quiet failure mode: a code the switch did not list — a Zod upgrade adding
 * one, or a schema raising one this build never translated — answered
 * 「不符合要求」 and nothing anywhere said a translation was missing. The only
 * way to notice was to open the source and compare it by hand with the
 * library's enum, which is not a check.
 *
 * The table is now `Record<z.ZodIssueCode, string>`, so a new code fails
 * `npm run typecheck`. That is necessary and not sufficient: this suite runs
 * through vitest, which transpiles without typechecking, so a type error alone
 * would never fail a test run. The two assertions below make the same question
 * a runtime one — every code the *running* Zod knows has an entry, and the
 * codes that answer with the generic reason are exactly the listed ones, so
 * "translated" cannot decay into "silently generic".
 */
describe('every Zod issue code has a Chinese reason of its own', () => {
  it('has an entry for every code this build of Zod can raise', () => {
    // Both directions: an entry for a code that no longer exists is dead
    // weight that makes the table look more complete than it is.
    expect([...ZOD_ISSUE_CODES].sort()).toEqual(Object.keys(ZOD_REASON_BY_CODE).sort());
  });

  it('gives the generic reason only to the codes that say so', () => {
    const generic = Object.entries(ZOD_REASON_BY_CODE)
      .filter(([, reason]) => reason === ZOD_REASON_GENERIC)
      .map(([code]) => code)
      .sort();

    // `custom` is a schema's own refusal, which normally carries the sentence
    // it was given — the generic reason is only what is left when it was not.
    // The other three belong to Zod's own type machinery (`.function()`
    // argument/return checks, intersections), which none of this app's schemas
    // produce, so there is no sentence to invent for them.
    //
    // A code added to this list is a decision that a person sees 「不符合要求」
    // and nothing more specific; that decision has to be written here.
    expect(generic).toEqual([
      'custom',
      'invalid_arguments',
      'invalid_intersection_types',
      'invalid_return_type',
    ]);
  });

  it('writes every reason in Chinese, with no library wording left in it', () => {
    for (const [code, reason] of Object.entries(ZOD_REASON_BY_CODE)) {
      // Nothing but Chinese characters: a stray English word here is the
      // original bug (the library's diagnostics reaching a person) coming back
      // through the fix.
      expect(reason, `${code} is not a Chinese sentence`).toMatch(/^[\u4e00-\u9fff]+$/);
    }
  });

  it('answers a code the table has no entry for, instead of `undefined`', () => {
    // The table is exhaustive for `tsc`, and `tsc` is not what runs the app: a
    // Zod upgrade that adds a code, or an issue constructed by hand somewhere
    // far from the schemas, indexes the table with a key that is not there. The
    // lookup then answers `undefined`, and `toUserError` puts it through a
    // template literal — so the sentence a person reads is
    // 「输入无效 (cols)：undefined」, an English word where the reason belongs.
    // The fallback used to sit in the `??`-less return of a `switch`, which is
    // exactly the shape that reads as total and is not.
    const outOfTable = {
      code: 'not_a_code_this_build_knows',
      // English, so `isZodOwnText` says it is Zod's wording and the reason has
      // to be derived from the code — the path that reaches the table.
      message: 'Expected number, received string',
      path: ['cols'],
      // Typed off `zodReason`'s own parameter rather than imported from `zod`:
      // the point is "the reason function refuses to answer `undefined`", and
      // naming the issue type from here would also mean this test depends on
      // the library directly.
    } as unknown as Parameters<typeof zodReason>[0];

    const reason = zodReason(outOfTable);

    expect(reason, 'a code outside the table produced no reason at all').not.toBeUndefined();
    expect(reason).toBe(ZOD_REASON_GENERIC);
    // Chinese, like every other reason: the fallback must not be the place the
    // library's wording (or `undefined`) survives.
    expect(reason).toMatch(/^[\u4e00-\u9fff]+$/);
  });
});
