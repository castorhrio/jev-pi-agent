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
  ZOD_OWN_OPENINGS,
  ZOD_REASON_BY_CODE,
  ZOD_REASON_GENERIC,
  schemaFailureFields,
  toUserError,
  zodFailureSource,
  zodReason,
  zodReasonSource,
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

/**
 * The two halves of a refusal are built from different questions, and are
 * allowed to answer differently — but never to be spliced together.
 *
 * `toUserError` names the first issue's path, and `schemaFailureFields` names
 * 「整体」 when an issue has none. Each has its own case above; what none of them
 * asserted is that the placeholder cannot reach the sentence, and that the
 * sentence's parentheses appear exactly when there is a field to put in them.
 * The failure that shape allows is specific and ugly: `输入无效 (整体)：格式不匹配`,
 * read as a field called 「整体」, which is the same misreading `schemaFailureFields`
 * replaced `invalid_union` to avoid — moved one layer out, into the line a
 * person sees.
 */
describe('the sentence and the log’s field list never contaminate each other', () => {
  it('keeps the placeholder out of the sentence, for every kind of failure', () => {
    // Every code this build of Zod can raise, each asked twice: with a field to
    // name and without. `unrecognized_keys` is left out because its field list
    // comes from `keys` and not from the path (pinned in its own case above) —
    // it is the one code where the two questions do not even have the same
    // input, and it cannot produce the placeholder at all.
    for (const code of ZOD_ISSUE_CODES) {
      if (code === 'unrecognized_keys') continue;

      const withField = toUserError(
        new ZodError([issue({ code, path: ['cols'] })]),
      ).message;
      const wholeRequest = toUserError(new ZodError([issue({ code })])).message;

      // The field is named, in parentheses, and only there.
      expect(withField, `${code}: field form`).toMatch(/^输入无效 \(cols\)：/);
      // No field => no parentheses at all: `输入无效 (整体)` would read as a field
      // called 整体, and `输入无效 ()` as a field with no name.
      expect(wholeRequest, `${code}: whole-request form`).toMatch(/^输入无效：/);
      expect(wholeRequest, `${code}: brackets without a field`).not.toContain('(');
      for (const message of [withField, wholeRequest]) {
        expect(message, `${code}: the placeholder leaked into the sentence`).not.toContain(
          '整体',
        );
        expect(message, `${code}: the sentence is not one line`).not.toContain('\n');
      }
    }
  });

  it('names the first issue’s field even when the list also says 整体', () => {
    // The two answers, side by side, on one error: the list says a field *and*
    // "the request as a whole" (the second issue has no path), while the
    // sentence names the first issue's field. Neither is wrong — they answer
    // different questions — but the placeholder staying in the list is what
    // makes "the sentence never carries it" a real constraint rather than a
    // side effect of the placeholder never being produced.
    const error = new ZodError([
      issue({ code: 'invalid_type', received: 'string', path: ['cols'] }),
      issue({ code: 'invalid_union' }),
    ]);

    expect(schemaFailureFields(error)).toEqual(['cols', '整体']);
    expect(toUserError(error).message).toBe('输入无效 (cols)：类型不正确');
    expect(toUserError(error).message).not.toContain('输入无效 (整体)');
  });
});

describe('zodReasonSource — where the reason in the sentence came from', () => {
  it('says "schema" for a sentence the schema wrote itself', () => {
    // The purge confirmation is the reason this rule exists: its message says
    // what the person has to do, and it is the only sentence in the app that
    // can. So the app has to know it kept it — not guess it from the log.
    expect(zodReasonSource(issue({ code: 'custom', message: '请先确认要清空的项目' }))).toBe('schema');
  });

  it('says "table" for a message Zod wrote', () => {
    // Almost every schema in this app writes no message at all, so almost every
    // refusal in the log has its reason from the table.
    expect(zodReasonSource(issue({ code: 'invalid_type', received: 'number' }))).toBe('table');
  });

  it('says "table" for a Zod message that happens to quote a Chinese value', () => {
    // The same case `zodReason` handles: CJK inside the message does not make
    // it the app's sentence. The source has to agree with the wording, or the
    // log would claim a schema wrote a sentence it did not write.
    const quoted = issue({
      code: 'invalid_enum_value',
      message: "Invalid enum value. Expected 'a', received '红色'",
    });

    expect(zodReasonSource(quoted)).toBe('table');
  });

  it('says "schema" exactly when the sentence kept is the schema’s own', () => {
    // The point of the field: it is the same decision the wording makes, and
    // not a second one that could drift. A `schema` source means the schema's
    // own words reached the person; a `table` source means they did not — so
    // the two questions must answer `⟺` and not merely "usually agree".
    //
    // Asked of every code this build of Zod can raise, and of both kinds of
    // message, because a rule that holds for `custom` and `invalid_type` can
    // still be wrong for the eleven codes nobody writes by hand.
    const sentences = [
      '请先确认要清空的项目',
      '有未知的字段',
      'Expected string, received number',
      "Invalid enum value. Expected 'a', received '红色'",
    ];

    for (const code of ZOD_ISSUE_CODES) {
      for (const message of sentences) {
        const one = issue({ code, message });
        const keptTheSchema = zodReason(one) === one.message;

        expect(
          zodReasonSource(one) === 'schema',
          `${code} / ${JSON.stringify(message)}: the source and the sentence disagree`,
        ).toBe(keptTheSchema);
      }
    }
  });
});

describe('zodFailureSource — the source of the sentence that actually crosses', () => {
  it('follows the first issue, the one the sentence is built from', () => {
    // `toUserError` names the first failing field and nothing else, so the
    // log's `reasonSource` has to describe *that* sentence. Reporting the
    // source of a later issue would claim a sentence the person never saw.
    const error = new ZodError([
      issue({ code: 'custom', message: '请先确认要清空的项目', path: ['confirm'] }),
      issue({ code: 'invalid_type', received: 'number', path: ['cols'] }),
    ]);

    expect(zodFailureSource(error)).toBe('schema');
    expect(toUserError(error).message).toBe('输入无效 (confirm)：请先确认要清空的项目');
  });

  it('says "table" when the first issue carried Zod’s wording', () => {
    const error = new ZodError([
      issue({ code: 'invalid_type', received: 'number', path: ['cols'] }),
      issue({ code: 'custom', message: '请先确认要清空的项目', path: ['confirm'] }),
    ]);

    expect(zodFailureSource(error)).toBe('table');
  });

  it('has no source for a failure that reported no issues', () => {
    // The one case where there is no sentence to explain: `toUserError` says
    // 「输入无效」 alone, so there is no reason, and none may be invented.
    expect(zodFailureSource(new ZodError([]))).toBeUndefined();
  });
});

describe('the sentence and its `reasonSource` describe the same issue', () => {
  /**
   * The two issues whose answers differ, so that a crossed wire is visible.
   *
   * One carries a sentence the app wrote (`schema`), the other Zod's English
   * that the table replaces (`table`). Built per test rather than shared,
   * because a `ZodError` holds these by identity and a reused issue would let
   * an ordering mistake pass as the right one.
   */
  function appSentence(): z.ZodIssue {
    return issue({ code: 'custom', message: '请先确认要清空的项目', path: ['confirm'] });
  }

  function zodSentence(): z.ZodIssue {
    return issue({ code: 'invalid_type', received: 'number', path: ['cols'] });
  }

  it('follows the first issue whichever way round the two are, both answers together', () => {
    // This is the pair the comment in `ipc-errors.ts` promises and nothing
    // asserted: `zodFailureSource` and `toUserError` each pick an issue, they
    // are separate code paths, and "both take the first one" is currently a
    // coincidence of two `issues[0]` lines. Reversing the order has to flip
    // the source *and* the sentence's field and reason together — so a future
    // "prefer the first issue with a path" in `toUserError` fails here rather
    // than quietly logging a source the person's sentence never had.
    const cases = [
      {
        issues: [appSentence(), zodSentence()],
        source: 'schema' as const,
        field: 'confirm',
      },
      {
        issues: [zodSentence(), appSentence()],
        source: 'table' as const,
        field: 'cols',
      },
    ];

    for (const { issues, source, field } of cases) {
      const error = new ZodError(issues);
      const [first, second] = issues as [z.ZodIssue, z.ZodIssue];
      const message = toUserError(error).message;

      expect(zodFailureSource(error), `${field}: source`).toBe(source);
      expect(message).toBe(`输入无效 (${field})：${zodReason(first)}`);
      // The other issue's reason is not in the sentence, which is what makes
      // the check above about *this* issue rather than about either of them.
      expect(message, `${field}: the sentence used the other issue`).not.toContain(
        zodReason(second),
      );
      // And the reason quoted is the one the source claims: a kept sentence is
      // the schema's own words, a replaced one is not.
      expect(message.includes(first.message), `${field}: source vs sentence`).toBe(
        source === 'schema',
      );
    }
  });
});

describe('ZOD_OWN_OPENINGS — the list of wordings Zod writes itself', () => {
  /**
   * One real schema failure per issue code, run against the *installed* Zod.
   *
   * The list in `ipc-errors.ts` decides which messages the app may show, and
   * it is a transcription of what one version of Zod happens to say. A bump
   * that rewords a message would leave the list silently stale — every symptom
   * of that is a library sentence in English reaching a person — so the check
   * is made against the library rather than against a comment. `custom` is
   * absent on purpose: its message is the schema's own, which is the one case
   * the list must *not* claim (asserted below).
   */
  const ZOD_DEFAULT_FAILURES: Record<Exclude<z.ZodIssueCode, 'custom'>, () => unknown> = {
    invalid_type: () => z.object({ cols: z.number() }).safeParse({ cols: 'red' }),
    invalid_literal: () => z.literal('a').safeParse('b'),
    // A Chinese value on purpose: this is also the case where a Zod message
    // contains CJK and must still be read as Zod's.
    invalid_enum_value: () => z.enum(['a', 'b']).safeParse('红色'),
    invalid_union: () => z.union([z.string(), z.number()]).safeParse(true),
    invalid_union_discriminator: () =>
      z
        .discriminatedUnion('kind', [z.object({ kind: z.literal('a') })])
        .safeParse({ kind: 'b' }),
    unrecognized_keys: () =>
      z.object({ cols: z.number() }).strict().safeParse({ cols: 1, extra: 2 }),
    invalid_string: () => z.string().email().safeParse('not-an-address'),
    invalid_date: () => z.date().safeParse(new Date('nonsense')),
    too_small: () => z.string().min(5).safeParse('ab'),
    too_big: () => z.string().max(1).safeParse('abc'),
    not_finite: () => z.number().finite().safeParse(Number.POSITIVE_INFINITY),
    not_multiple_of: () => z.number().multipleOf(3).safeParse(4),
    // These three only exist as thrown `ZodError`s from a called function or a
    // merged intersection, which is why they are the codes nobody translates
    // and everybody assumes are unreachable.
    invalid_arguments: () =>
      (z.function().args(z.string()).implement((value: string) => value) as (
        value: unknown,
      ) => unknown)(1),
    invalid_return_type: () =>
      z
        .function()
        .args()
        .returns(z.string())
        .implement((() => 1) as () => string)(),
    invalid_intersection_types: () =>
      z
        .object({ n: z.number().transform(() => 'x') })
        .and(z.object({ n: z.number().transform(() => 1) }))
        .parse({ n: 1 }),
  };

  /** The issues a sample raised, whether it returned a failure or threw one. */
  function issuesFrom(run: () => unknown): z.ZodIssue[] {
    try {
      const result = run() as { success?: boolean; error?: unknown };
      if (result?.success === false && result.error instanceof ZodError) {
        return result.error.issues;
      }
    } catch (error) {
      if (error instanceof ZodError) return error.issues;
      throw error;
    }
    // A sample that passes proves nothing about wording, and would leave the
    // loop below checking an empty list — a gate that cannot fail.
    throw new Error('this sample no longer fails to parse, so it says nothing about the wording');
  }

  it('recognises every message this build of Zod writes, for every code', () => {
    const covered = new Set<z.ZodIssueCode>();

    for (const [code, run] of Object.entries(ZOD_DEFAULT_FAILURES)) {
      const issues = issuesFrom(run);

      expect(issues.length, `${code}: the sample raised no issue`).toBeGreaterThan(0);
      for (const one of issues) {
        expect(one.code, `${code}: the sample raised ${one.code}`).toBe(code);
        // The failure this guards: Zod says something new, the list does not
        // know it, and `isZodOwnText` reads the English as the app's sentence.
        expect(
          ZOD_OWN_OPENINGS.some((opening) => one.message.startsWith(opening)),
          `${code} now says ${JSON.stringify(one.message)}, which no ZOD_OWN_OPENINGS entry starts — add the new opening (and this failure is what an upgrade looks like)`,
        ).toBe(true);
        expect(zodReasonSource(one), `${code}: Zod's own wording was kept as a schema's`).toBe(
          'table',
        );
      }
      covered.add(code as z.ZodIssueCode);
    }

    // Every code but `custom` has a sample, so a code added by an upgrade
    // fails here as well as in the reason-table test — and the failure says
    // "write a sample", which is what makes the list above stay true.
    expect([...covered].sort()).toEqual(
      ZOD_ISSUE_CODES.filter((code) => code !== 'custom').sort(),
    );
  });

  /**
   * One real schema per opening, so no entry can be speculation.
   *
   * The forward test asks "is every message this build of Zod writes in the
   * list". This is the other question — "does this build of Zod say every entry
   * in the list" — and it needs a schema per entry, because no single schema
   * covers them: `Required` is what an absent root object says, `Date must` a
   * bounded date, `Intersection` a merged-and-unmergeable pair.
   */
  const OPENING_SAMPLES: Record<string, () => unknown> = {
    Expected: () => z.object({ cols: z.number() }).safeParse({ cols: 'red' }),
    Invalid: () => z.literal('a').safeParse('b'),
    // Not `Expected object, received undefined`: an undefined root object is
    // the one `invalid_type` Zod words as `Required`.
    Required: () => z.object({ cols: z.number() }).safeParse(undefined),
    'Unrecognized key': () =>
      z.object({ cols: z.number() }).strict().safeParse({ cols: 1, extra: 2 }),
    'String must': () => z.string().min(5).safeParse('ab'),
    'Number must': () => z.number().multipleOf(3).safeParse(4),
    'Array must': () => z.array(z.string()).min(2).safeParse([]),
    'Date must': () =>
      z.date().min(new Date('2030-01-01')).safeParse(new Date('2020-01-01')),
    Intersection: () =>
      z
        .object({ n: z.number().transform(() => 'x') })
        .and(z.object({ n: z.number().transform(() => 1) }))
        .parse({ n: 1 }),
  };

  it('makes this build of Zod say every opening in the list', () => {
    // The failure this test exists for: an entry nothing can confirm. Five of
    // them stood here — `Too small`, `Too big`, `Value must`, `Set must`,
    // `Not ` — wordings this build's Zod never produces, written in case an
    // upgrade started saying them. A prefix no message matches is
    // indistinguishable from a prefix that matches, so a typo in one, or a
    // sixth added "just in case", would never have been noticed: the list was
    // only ever checked in one direction, and only a list checked both ways can
    // be wrong.
    for (const opening of ZOD_OWN_OPENINGS) {
      const run = OPENING_SAMPLES[opening];
      if (run === undefined) {
        expect.fail(
          `${JSON.stringify(opening)} is in the list but no sample makes Zod say it — delete the entry or add a sample`,
        );
      }

      const [first] = issuesFrom(run);

      expect(first, `${opening}: the sample raised no issue`).toBeDefined();
      // The sample has to say *this* opening, not merely fail: a `Date must`
      // entry "confirmed" by a sample that says `Expected` would pass a check
      // that only asks "did something fail".
      expect(
        first?.message.startsWith(opening),
        `${opening}: the sample says ${JSON.stringify(first?.message)} instead`,
      ).toBe(true);
      // And a sample is not proof the *list* knows the wording: this is the
      // judgement the app actually makes, on the message the sample produced.
      expect(zodReasonSource(first as z.ZodIssue), `${opening}: not read as Zod's`).toBe(
        'table',
      );
    }

    // The samples do not outnumber the list either: a sample left behind for a
    // deleted entry is a test that no longer tests anything.
    expect(Object.keys(OPENING_SAMPLES).sort()).toEqual([...ZOD_OWN_OPENINGS].sort());
  });

  it('keeps a Chinese sentence this app wrote out of the list', () => {
    // The other half of the rule, and the reason it is not just "starts with a
    // known word but always": 「请先确认要清空的项目」 is a schema's own
    // instruction and replacing it would remove the only sentence that says
    // what to do. Both of this app's own messages are checked against the list
    // itself, not only through the judgement that uses it.
    for (const message of ['请先确认要清空的项目', '有未知的字段']) {
      expect(
        ZOD_OWN_OPENINGS.some((opening) => message.startsWith(opening)),
        `${JSON.stringify(message)} looks like Zod's wording`,
      ).toBe(false);
      expect(zodReasonSource(issue({ code: 'custom', message }))).toBe('schema');
    }
  });
});
