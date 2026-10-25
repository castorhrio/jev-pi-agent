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
