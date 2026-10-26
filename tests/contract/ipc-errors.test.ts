/**
 * The rules of a refusal, asked directly instead of through a handler.
 *
 * ## Why this file exists
 *
 * The last commit moved `zodReason`, `schemaFailureFields` and `toUserError`
 * out of `ipc.ts` and into `apps/desktop/src/main/ipc-errors.ts`, and the
 * module's own header says why: the wording of a refusal used to be reachable
 * only by calling a registered handler, which meant every question about it
 * carried 1400 lines of channel registration and a mocked `electron` along for
 * the ride. "What does this schema failure say?" could not be asked without
 * also asking "is the IPC surface registerable?", and a rule about wording was
 * therefore checked indirectly or not at all.
 *
 * That separation is the point of the module, and until this file existed it
 * was a promise in a comment: `ipc-error-bridge.test.ts` still registers the
 * whole surface and mocks `electron`, and it only reaches the branches this
 * app's real schemas happen to produce. Branches a *real* schema cannot produce
 * — a `too_big` on a date, an issue with an empty path, a message from an
 * English schema — had no test at all, which is exactly where a `switch` rots.
 *
 * So nothing here is mocked. The module imports `zod` and `@ucad/contracts`,
 * and that is what this file imports; if that ever stops being true, this file
 * fails to run, which is the boundary being asserted.
 *
 * The wording still has an end-to-end test one file over: *this* file says what
 * each rule answers, that one says the answer reaches the person through the
 * bridge unchanged.
 */

import { describe, it, expect } from 'vitest';
import { ZodError, z } from 'zod';
import {
  ZOD_ISSUE_CODES,
  ZOD_REASON_BY_CODE,
  ZOD_REASON_GENERIC,
  schemaFailureFields,
  toUserError,
  zodReason,
} from '../../apps/desktop/src/main/ipc-errors';

/**
 * An issue shaped like the one Zod would raise, built by hand.
 *
 * Zod's issue types are a union of a dozen shapes, and the only fields
 * `zodReason` reads are `code`, `message` and — for three codes — `received` /
 * `type`. Hand-building them is how the branches a schema in *this* app cannot
 * produce get exercised at all: a `too_big` on a date needs a schema nobody
 * would write, and the branch still has to answer in Chinese.
 */
function issue(fields: {
  code: z.ZodIssueCode;
  message?: string;
  path?: Array<string | number>;
  received?: string;
  type?: string;
}): z.ZodIssue {
  return {
    // English by default, which is what Zod writes when a schema does not
    // write its own sentence — the state of almost every schema in this app.
    message: 'Expected string, received number',
    path: [],
    ...fields,
  } as unknown as z.ZodIssue;
}

/** An issue that has not reached any of `zodReason`'s refinements. */
function issueOutsideRefinements(code: z.ZodIssueCode): z.ZodIssue {
  if (code === 'invalid_type') return issue({ code, received: 'string' });
  if (code === 'too_small' || code === 'too_big') return issue({ code, type: 'string' });
  return issue({ code });
}

describe('schemaFailureFields — the field names, and never their values', () => {
  it('names a field by its path', () => {
    const error = new ZodError([
      issue({ code: 'invalid_type', received: 'string', path: ['terminalId'] }),
    ]);

    expect(schemaFailureFields(error)).toEqual(['terminalId']);
  });

  it('joins a nested path with dots, the way a reader addresses the field', () => {
    const error = new ZodError([
      issue({ code: 'invalid_type', received: 'number', path: ['input', 0, 'cols'] }),
    ]);

    expect(schemaFailureFields(error)).toEqual(['input.0.cols']);
  });

  it('says 整体 for an issue with no path, rather than naming the issue code', () => {
    // A whole-request failure (wrong type at the root, no branch of a union
    // matched) has no field to name. The issue's `code` was pushed here once,
    // which put `invalid_union` in a list of field names — an English
    // identifier reading as a field called "invalid_union", in a line written
    // for people. 「整体」 is the placeholder that replaced it.
    const error = new ZodError([issue({ code: 'invalid_union' })]);

    const fields = schemaFailureFields(error);

    expect(fields).toEqual(['整体']);
    expect(JSON.stringify(fields)).not.toContain('invalid_union');
  });

  it('expands the keys of an unrecognized_keys issue instead of its path', () => {
    // `strict()` reports one issue whose `path` is the *object's* path and
    // whose `keys` are the fields the schema did not know. The names are what a
    // log needs: "unknown fields: extra, force" says which field to remove,
    // while the object's path says only where the object was.
    const error = new ZodError([
      issue({
        code: 'unrecognized_keys',
        path: [],
        ...{ keys: ['extra', 'force'] },
      } as unknown as z.ZodIssue),
    ]);

    expect(schemaFailureFields(error)).toEqual(['extra', 'force']);
  });

  it('lists every failing field, in the order Zod reported them', () => {
    // The log line's `invalidFields` is a list, so more than one wrong field is
    // visible there even though the sentence names only the first (see
    // `toUserError`). Two fields, one of them unknown, in Zod's order: the
    // list is a report of the request, not of the first mistake.
    const error = new ZodError([
      issue({ code: 'invalid_type', received: 'string', path: ['cols'] }),
      issue({ code: 'too_small', type: 'number', path: ['rows'] }),
      issue({
        code: 'unrecognized_keys',
        path: [],
        ...{ keys: ['extra'] },
      } as unknown as z.ZodIssue),
    ]);

    expect(schemaFailureFields(error)).toEqual(['cols', 'rows', 'extra']);
  });
});

describe('zodReason — one Chinese reason per code, decided by the table', () => {
  it('has a Chinese reason for every code this build of Zod can raise', () => {
    // The table is typed `Record<z.ZodIssueCode, string>` and `tsc` checks it,
    // but the suite transpiles without typechecking — so the same question is
    // asked here at runtime, against the *running* Zod's own enum.
    for (const code of ZOD_ISSUE_CODES) {
      const reason = zodReason(issueOutsideRefinements(code));

      expect(reason, `${code} was not translated`).toBe(ZOD_REASON_BY_CODE[code]);
      // Nothing but Chinese characters: a stray English word is the original
      // bug (the library's diagnostics reaching a person) coming back through
      // the fix.
      expect(reason, `${code} is not a Chinese sentence`).toMatch(/^[\u4e00-\u9fff]+$/);
    }
  });

  it('tells "the field was not sent" apart from "the field has the wrong type"', () => {
    // `received: 'undefined'` is Zod's spelling of a missing field, and it is a
    // different mistake from a wrong type: one the caller can fix by sending
    // the field, the other by sending a different value. Both used to answer
    // the same sentence.
    expect(zodReason(issue({ code: 'invalid_type', received: 'undefined' }))).toBe('缺少必填字段');
    expect(zodReason(issue({ code: 'invalid_type', received: 'string' }))).toBe('类型不正确');
    // And the two are not the same words, which is the whole point.
    expect(zodReason(issue({ code: 'invalid_type', received: 'undefined' }))).not.toBe(
      ZOD_REASON_BY_CODE.invalid_type,
    );
  });

  it('refines too_small by what was too short', () => {
    // Three units of "too small": a list with too few items, a number or a date
    // below its bound, and a string shorter than its minimum. 「内容太短」 is
    // true of the third and wrong about the first two.
    expect(zodReason(issue({ code: 'too_small', type: 'array' }))).toBe('至少需要一项');
    expect(zodReason(issue({ code: 'too_small', type: 'number' }))).toBe('数值太小');
    expect(zodReason(issue({ code: 'too_small', type: 'date' }))).toBe('数值太小');
    // A string (and anything else Zod does not name) falls back to the table.
    expect(zodReason(issue({ code: 'too_small', type: 'string' }))).toBe(
      ZOD_REASON_BY_CODE.too_small,
    );
  });

  it('refines too_big by what was too long', () => {
    expect(zodReason(issue({ code: 'too_big', type: 'array' }))).toBe('项目太多');
    expect(zodReason(issue({ code: 'too_big', type: 'number' }))).toBe('数值太大');
    expect(zodReason(issue({ code: 'too_big', type: 'date' }))).toBe('数值太大');
    expect(zodReason(issue({ code: 'too_big', type: 'string' }))).toBe(ZOD_REASON_BY_CODE.too_big);
  });

  it('keeps a Chinese sentence a schema wrote itself', () => {
    // Two schemas in this app spell their refusal out in Chinese, and that
    // sentence is the only thing that can say *why* — the purge confirmation
    // and its unknown-field refusal. Replacing it with a phrase keyed by the
    // issue code would lose the instruction.
    expect(zodReason(issue({ code: 'custom', message: '请先确认要清空的项目' }))).toBe(
      '请先确认要清空的项目',
    );
    expect(zodReason(issue({ code: 'unrecognized_keys', message: '有未知的字段' }))).toBe(
      '有未知的字段',
    );
  });

  it('replaces an English sentence with the table, even one a schema wrote', () => {
    // `isZodOwnText` decides by *language*, because language is what actually
    // separates the two: every sentence this app shows a person is Chinese, so
    // an English one is either Zod's own wording or a sentence this app should
    // not be showing. The cost is that a schema which writes its refusal in
    // English gets 「不符合要求」 instead — accepted deliberately: the person
    // reading it gets a vague Chinese sentence rather than a precise English
    // one, and the fix belongs at the schema.
    expect(zodReason(issue({ code: 'custom', message: 'Purge requires confirm' }))).toBe(
      ZOD_REASON_GENERIC,
    );
  });

  it('still uses the table when a Zod default message happens to contain a CJK value', () => {
    // Zod quotes the value it received, so a default message can end up with
    // Chinese inside it: `received '红色'`. Judging by "does it contain CJK"
    // alone would keep that library sentence — value and the English around it
    // — and show it to a person. The message starts with an opening Zod owns,
    // so it is Zod's text no matter what it quotes.
    const quoted = issue({
      code: 'invalid_enum_value',
      message: "Invalid enum value. Expected 'a', received '红色'",
    });

    expect(zodReason(quoted)).toBe(ZOD_REASON_BY_CODE.invalid_enum_value);
    // And the value is not carried into the reason.
    expect(zodReason(quoted)).not.toContain('红色');
  });
});

describe('toUserError — the one line that crosses the bridge', () => {
  it('names the first failing field, and the reason, in Chinese', () => {
    const error = new ZodError([
      issue({ code: 'invalid_type', received: 'string', path: ['cols'] }),
    ]);

    expect(toUserError(error).message).toBe('输入无效 (cols)：类型不正确');
  });

  it('leaves the parentheses off when there is no field to name', () => {
    const error = new ZodError([issue({ code: 'invalid_union' })]);

    // `输入无效 (整体)` would read as a field called 整体; the placeholder
    // belongs in the log's field list, not in the sentence.
    expect(toUserError(error).message).toBe('输入无效：格式不匹配');
  });

  it('says 输入无效 alone for a ZodError that reported no issues', () => {
    // An empty issue list is not something Zod raises in practice, and it is
    // the shape that produced `输入无效 (undefined)` in a construction this
    // file can reach: no first issue means no field and no reason to append.
    expect(toUserError(new ZodError([])).message).toBe('输入无效');
  });

  it('reports only the first issue, and documents that the rest are in the log', () => {
    // One sentence is the contract (§7.2), so a request with three bad fields
    // names one: the first. The full list is the log line's `invalidFields`
    // (`schemaFailureFields` above), which is where a report reads it.
    const error = new ZodError([
      issue({ code: 'invalid_type', received: 'string', path: ['cols'] }),
      issue({ code: 'too_small', type: 'number', path: ['rows'] }),
    ]);

    const message = toUserError(error).message;

    expect(message).toBe('输入无效 (cols)：类型不正确');
    expect(message).not.toContain('rows');
    expect(message).not.toContain('\n');
  });

  it('passes a non-schema failure through the app error, message intact', () => {
    // A `ZodError` is the only special case: everything else is already an
    // app error (or was turned into one) and its message is the sentence.
    expect(toUserError(new Error('工作区不可用')).message).toBe('工作区不可用');
  });

  it('hands over an Error with a message and nothing else', () => {
    // Electron carries an `Error` to the Renderer as its message; an own
    // enumerable field would be the shape a "let's also pass the code" change
    // takes, and the Renderer would then branch on `undefined` forever. The
    // end-to-end half of this is in `ipc-error-bridge.test.ts`.
    const thrown = toUserError(new ZodError([issue({ code: 'invalid_type', path: ['cols'] })]));

    expect(thrown).toBeInstanceOf(Error);
    expect(Object.keys(thrown)).toEqual([]);
    expect(JSON.parse(JSON.stringify(thrown))).toEqual({});
  });
});
