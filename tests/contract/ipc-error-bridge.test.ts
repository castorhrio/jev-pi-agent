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
});
