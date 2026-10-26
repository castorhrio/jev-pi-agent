/**
 * How a refusal is worded on its way out of Main.
 *
 * §7.2 promises every IPC failure reaches a person as *one* user-safe sentence,
 * and the `code` stays on Main's side of the bridge (see
 * `tests/contract/ipc-error-bridge.test.ts`). Two questions decide that
 * sentence, and both of them are about a `ZodError`:
 *
 *  1. which fields were wrong (`schemaFailureFields`) — the log line's business,
 *     because a field *name* belongs in a log and its *value* does not;
 *  2. why, in Chinese (`zodReason`) — the sentence's business, because Zod's own
 *     wording is English diagnostics and a person cannot act on
 *     `Expected string`.
 *
 * Both used to live inside `ipc.ts`, in the middle of 1400 lines of channel
 * registration. That made the rules harder to test than to break: the only way
 * to reach `zodReason` was to call a registered handler, so "what does a code
 * this table has no entry for say" could not be asked at all. The module
 * boundary is the point of this file — it imports `zod` and nothing of
 * Electron, so the wording can be exercised directly.
 *
 * Nothing here may echo a caller's value: Zod's messages quote the input, and a
 * refusal is not a place to repeat it back.
 */

import { ZodError, z } from 'zod';
import { toAppError } from '@ucad/contracts';

/**
 * How a schema failure with no field is named in the log.
 *
 * The issue `code` used to be pushed here, which meant the log line for a bad
 * union carried `invalid_union` — an English identifier in a list of field
 * names, indistinguishable from a field that happens to be spelled that way.
 * The reason for the refusal is already in `message` (see `zodReason`), so the
 * field list only has to say "not one field in particular".
 */
const WHOLE_REQUEST_FIELD = '整体';

/**
 * The field names a schema failure is about.
 *
 * Zod reports each problem as an issue: a path to the field, and — for a key
 * the schema does not know — the list of keys it did not recognise. The
 * *names* are what a log line needs to say which fields were wrong; the
 * values are what a log must not repeat, so the issue messages themselves
 * stay out of it. Zod's own `.message` is a JSON dump of every issue, which
 * is unreadable in a log line and echoes the input back.
 */
export function schemaFailureFields(error: ZodError): string[] {
  const fields: string[] = [];
  for (const issue of error.issues) {
    if (issue.code === 'unrecognized_keys') {
      fields.push(...issue.keys);
      continue;
    }
    const path = issue.path.join('.');
    // A path can be empty: the whole request failed, either because it was the
    // wrong type at the root or because it matched no branch of a union. The
    // field list then has nothing to name, and the issue's own `code` is
    // English — pushing it put `invalid_union` in the log beside real field
    // names, where it reads as a field called "invalid_union" and puts a
    // library identifier into a line written for people. A Chinese placeholder
    // says "the request as a whole" without inventing a field.
    fields.push(path.length > 0 ? path : WHOLE_REQUEST_FIELD);
  }
  return fields;
}

/**
 * Whether an issue's message is Zod's own wording rather than a sentence this
 * app wrote.
 *
 * Zod writes its messages in English (`Expected string, received number`), and
 * `toUserError` pasted that straight into the line a person reads. Two schemas
 * in this app do spell their refusal out in Chinese — the purge confirmation and
 * its unknown-field refusal — and those sentences must survive, so the two have
 * to be told apart rather than blindly replaced.
 *
 * The test is language, because that is what actually separates them: every
 * sentence this app shows a person is Chinese, and Zod's are not. The second
 * check exists because Zod quotes the value it received, so a default message
 * can end up with CJK inside it (`Invalid enum value. Expected 'a' | 'b',
 * received '值'`); its openings are named rather than guessed at.
 *
 * This is a heuristic, and a heuristic is the weakest thing in this file: the
 * cases that matter are an English sentence (overridden), a Zod default that
 * happens to contain CJK (still Zod's, so overridden) and a sentence this app
 * wrote (kept). It is exercised through {@link zodReason} and
 * {@link zodReasonSource} — the wording a person sees is the thing worth
 * asserting, and it is asserted through the registered handlers in
 * `tests/contract/ipc-error-bridge.test.ts`.
 *
 * The opening list is exported because it is the part that rots. Zod writes
 * these sentences, so a bump can reword one, and the only symptom would be a
 * library sentence in English reaching a person through the branch that keeps
 * CJK. A test cannot read Zod's *future* wordings, but it can make this
 * build's Zod raise an issue per opening and check both directions — see
 * `tests/contract/ipc-errors.test.ts`: every message Zod writes is recognised
 * here, *and* every entry here is one this build's Zod actually says. Without
 * that test the list is a reminder; with it, an upgrade that rewords a message
 * is a red test that names the message.
 *
 * The reverse direction is why the list is only as long as it needs to be.
 * Five entries once stood here for wordings this build's Zod never produces —
 * `Too small` / `Too big` / `Value must` / `Set must` / `Not ` — written in case
 * an upgrade started saying them. Nothing could confirm them: each was a prefix
 * no message ever matched, so a typo in one would have been invisible and the
 * list was only ever checked in one direction. They are gone, and the guesswork
 * is what the forward check replaced — an upgrade that starts saying
 * `Too small` fails a test that names the message, which is a better reminder
 * than an entry lying in wait.
 */
export const ZOD_OWN_OPENINGS: readonly string[] = [
  'Expected',
  'Invalid',
  'Required',
  'Unrecognized key',
  'String must',
  'Number must',
  'Array must',
  'Date must',
  // `Intersection results could not be merged` — raised by `.and()` when two
  // branches produce values that cannot be combined. Found by the test below
  // rather than by reading Zod's source, which is the point of the test.
  'Intersection',
];

function isZodOwnText(message: string): boolean {
  // "Chinese" here means a CJK *ideograph*, not any full-width character.
  // Chinese punctuation (`，。？！`) is outside the range, so a message made
  // only of it is read as "not a sentence this app wrote" and replaced by the
  // table. That is the deliberate side of the boundary: punctuation alone is
  // not an instruction a person can act on, and widening the range to
  // punctuation would keep strings that contain no Chinese words. Pinned in
  // `tests/contract/ipc-errors.test.ts`, so an i18n change has to flip it on
  // purpose.
  if (!/[\u4e00-\u9fff]/.test(message)) return true;
  return ZOD_OWN_OPENINGS.some((opening) => message.startsWith(opening));
}

/**
 * Where the reason in a refusal's sentence came from.
 *
 * - `schema` — the schema wrote its own sentence and it was kept;
 * - `table` — the sentence came from {@link ZOD_REASON_BY_CODE}, because the
 *   issue carried Zod's own English wording.
 *
 * The refusal itself says which sentence the person got, but not *why* that
 * sentence reads the way it does — and a support report has to answer "why
 * does this schema's carefully written message not appear?" There are two
 * possible answers: the schema wrote no message at all, or the heuristic
 * mistook a Chinese sentence for Zod's English. They need different fixes —
 * one is a missing message, the other a wrong rule — and before this field
 * the only way to tell them apart was to read the code and work out which
 * schemas had messages.
 */
export type ZodReasonSource = 'schema' | 'table';

/**
 * Where the reason for this issue's refusal came from.
 *
 * The same decision {@link zodReason} makes, exposed on its own so that the
 * log can say it: a schema's own sentence is kept (`schema`), and anything
 * Zod wrote is replaced by the table's Chinese (`table`).
 */
export function zodReasonSource(issue: z.ZodIssue): ZodReasonSource {
  return isZodOwnText(issue.message) ? 'table' : 'schema';
}

/**
 * Where the reason in the sentence for this failure came from.
 *
 * The sentence a person reads is built from the *first* issue (see
 * `toUserError`), so this is that issue's source and not a second, separate
 * decision: the log must not claim a source the sentence does not have.
 * `undefined` when the failure reported no issues at all — the one case where
 * there is no reason to explain.
 */
export function zodFailureSource(error: ZodError): ZodReasonSource | undefined {
  const first = error.issues[0];
  return first === undefined ? undefined : zodReasonSource(first);
}

/**
 * What 「输入无效」 says when this build has nothing more precise to add.
 *
 * A code lands here only when it is listed below with this reason: `custom` is
 * a schema's own refusal, which normally carries the sentence it was given, and
 * the other three are codes this app's schemas cannot produce at all. The list
 * is asserted in `tests/contract/ipc-error-bridge.test.ts`, so a Zod upgrade
 * that adds a code has to be an explicit decision here instead of silently
 * becoming 「不符合要求」.
 */
export const ZOD_REASON_GENERIC = '不符合要求';

/**
 * One Chinese reason per issue `code` — the whole table Zod can raise.
 *
 * It was a `switch` with a `default`, and the `default` is what made it rot: a
 * code the switch did not list became 「不符合要求」 with nothing anywhere
 * saying a translation was missing. Keyed as `Record<z.ZodIssueCode, …>` it is
 * now exhaustive — a Zod upgrade that adds a code fails `npm run typecheck`
 * before the app can ship a generic sentence for it — and the exported table
 * lets a test ask the same question at runtime, because the suite transpiles
 * without typechecking.
 *
 * Three codes need more than their code to decide (`invalid_type`'s
 * "not sent", `too_small`/`too_big`'s "how many / how long"), so `zodReason`
 * refines those and falls back to the entry here.
 */
export const ZOD_REASON_BY_CODE: Record<z.ZodIssueCode, string> = {
  invalid_type: '类型不正确',
  invalid_literal: '取值不在允许的范围内',
  invalid_enum_value: '取值不在允许的范围内',
  invalid_union: '格式不匹配',
  invalid_union_discriminator: '格式不匹配',
  unrecognized_keys: '包含未知字段',
  invalid_string: '格式不正确',
  invalid_date: '日期无效',
  too_small: '内容太短',
  too_big: '内容太长',
  not_finite: '数值无效',
  not_multiple_of: '数值无效',
  custom: ZOD_REASON_GENERIC,
  invalid_arguments: ZOD_REASON_GENERIC,
  invalid_return_type: ZOD_REASON_GENERIC,
  invalid_intersection_types: ZOD_REASON_GENERIC,
};

/**
 * Every issue code this build's Zod knows, at runtime.
 *
 * Exported for the meta-test only: the type of {@link ZOD_REASON_BY_CODE} is
 * checked by `tsc`, and this is how the same check is made by a test run.
 */
export const ZOD_ISSUE_CODES: readonly z.ZodIssueCode[] = Object.keys(
  z.ZodIssueCode,
) as z.ZodIssueCode[];

/**
 * The reason half of 「输入无效」, in Chinese.
 *
 * A schema failure reaches a person as one sentence — `输入无效 (cols)：…` — and
 * the part after the field name was `issue.message`: Zod's English, on every
 * schema that did not write its own. That is almost all of them, so the whole
 * IPC surface told a user things like `Expected number, received string` while
 * §7.2 promised a user-safe sentence. The field name was translated and the
 * reason was the library's diagnostics.
 *
 * Giving every schema a custom message is the other fix, and the one that rots:
 * a sentence to repeat on forty schemas, and English again the moment one is
 * added without it. So the translation is keyed by the issue `code` — always
 * present, and the only stable thing across Zod's wording — while a schema that
 * *did* write a sentence keeps it (`isZodOwnText`).
 *
 * The value the caller sent is never part of it: Zod's own messages quote it,
 * and a refusal is not a place to echo an input back.
 */
export function zodReason(issue: z.ZodIssue): string {
  // The same test the log's `reasonSource` reports, so the sentence and the
  // record of where it came from cannot drift apart.
  if (zodReasonSource(issue) === 'schema') return issue.message;
  switch (issue.code) {
    case 'invalid_type':
      // `received: 'undefined'` is how Zod spells "the field was not sent" — a
      // different mistake from a wrong type, and one the caller can fix.
      return issue.received === 'undefined'
        ? '缺少必填字段'
        : ZOD_REASON_BY_CODE.invalid_type;
    case 'too_small':
      if (issue.type === 'array') return '至少需要一项';
      if (issue.type === 'number' || issue.type === 'date') return '数值太小';
      return ZOD_REASON_BY_CODE.too_small;
    case 'too_big':
      if (issue.type === 'array') return '项目太多';
      if (issue.type === 'number' || issue.type === 'date') return '数值太大';
      return ZOD_REASON_BY_CODE.too_big;
  }
  // Every other code has exactly one reason, in the table above — and the
  // lookup is not allowed to answer `undefined`. Indexing with a code the table
  // does not have (a Zod upgrade that landed between builds, or an issue built
  // by hand somewhere far from the schemas) typed as a `string` but is not one:
  // the template literal in `toUserError` would then spell out the word
  // "undefined" in the sentence a person reads. The table is exhaustive for
  // `tsc`; this `??` is what keeps the *runtime* honest when it is not.
  return ZOD_REASON_BY_CODE[issue.code] ?? ZOD_REASON_GENERIC;
}

/**
 * The last narrowing before the bridge: one user-safe sentence, and no fields.
 *
 * The `code` was already logged by `handle()` (in `ipc.ts`); it is dropped here
 * on purpose. Electron carries an `Error` to the Renderer as its message, so a
 * `code` on the rejection would arrive as `undefined` and invite a Renderer
 * branch that never matches. The message is the whole contract — see
 * `tests/contract/ipc-error-bridge.test.ts`.
 */
export function toUserError(error: unknown): Error {
  // A ZodError's .message is a multi-line JSON dump of every issue — valid in
  // a log, hostile in a toast, and it echoes the raw input. One line naming
  // the first failing field, and why in Chinese, is what §7.2 means by
  // user-safe; the full issues stay in the log above.
  //
  // A request with several bad fields therefore names only the *first* one.
  // That is deliberate and is what the sentence is allowed to say: one
  // sentence, no field list, because the Renderer shows the message and has
  // nothing to parse it with. The whole list is the log line's
  // `invalidFields` (`schemaFailureFields`), which is where a support report
  // reads it — see `tests/contract/ipc-errors.test.ts`.
  if (error instanceof ZodError) {
    const first = error.issues[0];
    const where = first && first.path.length > 0 ? ` (${first.path.join('.')})` : '';
    return new Error(`输入无效${where}${first ? `：${zodReason(first)}` : ''}`);
  }
  const appError = toAppError(error, 'ipc');
  return new Error(appError.message);
}
