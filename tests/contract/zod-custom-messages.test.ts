/**
 * This app's schemas must not write English sentences.
 *
 * ## Why this file exists
 *
 * `ipc-errors.ts` decides whether an issue's message is Zod's own English or a
 * sentence this app wrote — and it decides by language, because that is what
 * separates them in practice (`isZodOwnText`). The rule is what keeps Zod's
 * library diagnostics out of the line a person reads, and it is safe *only*
 * while every custom message in this app is Chinese.
 *
 * Nothing enforced that. The rule's own comment says the two purge sentences
 * "must survive", which is a statement about two strings in one file; a third
 * schema written with `{ message: 'workspace is required' }` would be read as
 * Zod's wording, quietly replaced by 「不符合要求」, and every existing test
 * would stay green. The failure is invisible in exactly the way this repo has
 * been removing: a promise in a comment, with no test under it.
 *
 * So the convention is a scan over the source (`zod-message-scan.ts`), and the
 * scan is tested on fixtures first — a scanner that only ever runs over a code
 * base that passes has an unknown failure mode.
 *
 * The scan is deliberately pessimistic about what it can judge (see the limits
 * listed in the scanner). It reports a custom message it cannot resolve, and
 * it reports every message that has no Chinese in it; the one thing it must
 * never do is stay silent about a sentence a person would read in English.
 *
 * Two things about the scan itself are pinned here, because both were only
 * true in a comment: the shapes it *cannot* read (a blind spot the scan has
 * no way to report), and the directories it covers (a scan over the wrong
 * roots passes just as greenly as one over the right ones).
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  SCAN_ROOTS,
  customMessages,
  englishMessages,
  scanZodMessages,
  shippedSourceFiles,
  sourceFilesIn,
} from './zod-message-scan';

/** A file that imports Zod, since a file that does not cannot define a schema. */
const ZOD_FILE = `import { z } from 'zod';`;

describe('the scan recognises the shapes a schema can write a message in', () => {
  it('finds an options-object message', () => {
    const found = customMessages('fixture.ts', `${ZOD_FILE}
const schema = z.string({ required_error: 'cols is required' });
`);

    expect(found).toHaveLength(1);
    expect(found[0]?.key).toBe('required_error');
    expect(found[0]?.message).toBe('cols is required');
  });

  it('finds a second-argument message, including one written with double quotes', () => {
    const found = customMessages('fixture.ts', `${ZOD_FILE}
const schema = z.object({ cols: z.number().min(1, { message: 'too small' }) });
const other = z.string().min(3, "too short");
`);

    expect(found.map((one) => one.key)).toEqual(['message', 'min() argument']);
    expect(found.map((one) => one.message)).toEqual(['too small', 'too short']);
  });

  it('finds a first-argument message, the shape `.strict(sentence)` takes', () => {
    // `strict` has no value to check, so its only argument is the sentence.
    // This is the shape the purge schema uses, and a scan that only looked at
    // second arguments would miss it.
    const found = customMessages('fixture.ts', `${ZOD_FILE}
const schema = z.object({ scope: z.string() }).strict('unknown field');
`);

    expect(found).toHaveLength(1);
    expect(found[0]?.key).toBe('strict() argument');
    expect(found[0]?.message).toBe('unknown field');
  });

  it('resolves a message passed as a same-file constant', () => {
    // `ipc-storage.ts` writes its two sentences as constants beside the schema,
    // because they are long. A scan that only read literals would report
    // nothing about the one schema in this app that *does* write a message.
    const found = customMessages('fixture.ts', `${ZOD_FILE}
const PURGE_UNCONFIRMED = '清理未确认：请先预览要删除的内容。';
z.unknown().superRefine((value, ctx) => {
  ctx.addIssue({ code: z.ZodIssueCode.custom, message: PURGE_UNCONFIRMED });
});
`);

    expect(found).toHaveLength(1);
    expect(found[0]?.key).toBe('message (via PURGE_UNCONFIRMED)');
    expect(found[0]?.message).toContain('清理未确认');
  });

  it('reports a message position it cannot read, with the reason and the expression', () => {
    // The old scanner returned only what it could read. Every shape here sits
    // in a message position and was silently ignored, so a schema could write
    // an English sentence in one of them and the app-wide scan would stay
    // green. The list is the visible half of the same defence.
    const scan = scanZodMessages('fixture.ts', `${ZOD_FILE}
z.string({ message: IMPORTED_SENTENCE });
z.string().min(3, IMPORTED_SENTENCE);
z.string({ message: \`字段 \${name} 必填\` });
z.string({ message: MESSAGES.required });
z.string({ message: buildSentence() });
z.string({ message: 'half of it' + rest });
`);

    // Source order, so a failure names the shape in the fixture a reader
    // scrolls to. The two scan passes (keys, then positional arguments)
    // otherwise return findings in two groups.
    const findings = [...scan.unresolved].sort((a, b) => a.at - b.at);
    expect(findings.map((one) => [one.key, one.reason])).toEqual([
      ['message', 'unknown-constant'],
      ['min() argument', 'unknown-constant'],
      ['message', 'template-with-expression'],
      ['message', 'not-a-literal'],
      ['message', 'not-a-literal'],
      ['message', 'concatenated-literal'],
    ]);
    expect(findings.map((one) => one.expression)).toEqual([
      expect.stringContaining('IMPORTED_SENTENCE'),
      expect.stringContaining('IMPORTED_SENTENCE'),
      expect.stringContaining('${name}'),
      expect.stringContaining('MESSAGES.required'),
      expect.stringContaining('buildSentence()'),
      expect.stringContaining("'half of it' + rest"),
    ]);
    // Nothing was judged: a half-read sentence is not a sentence.
    expect(scan.messages).toEqual([]);
  });

  it('does not treat a `message` field outside a schema as a message position', () => {
    // A file that imports Zod also has log records and type declarations, and
    // both can have a field named `message`. Judging their language made the
    // scan police sentences that are not refusals — and, worse, report them as
    // unreadable schema messages once `unresolved` existed. Only a key inside
    // a schema expression is a message position; a field *named* message whose
    // value is itself a schema (`message: z.string()`) is a shape, not a
    // sentence option.
    const text = `${ZOD_FILE}
const schema = z.object({ message: z.string() });
logger.warn('x', { message: appError.message });
logger.warn('x', { message: 'an English log sentence' });
interface Warning { message: string }
`;

    expect(scanZodMessages('fixture.ts', text)).toEqual({ messages: [], unresolved: [] });
  });

  it('does not report a method call with no message argument', () => {
    // `.email()` and `.strict()` have no argument, and `.min(3)` has no
    // second one. There is no message position, so there is nothing to read
    // and nothing to report; an `unresolved` entry here would be noise that
    // makes the app-wide assertion impossible to keep at zero.
    const text = `${ZOD_FILE}
z.string().email();
z.string().min(3);
z.string().strict();
`;

    expect(scanZodMessages('fixture.ts', text)).toEqual({ messages: [], unresolved: [] });
  });

  it('keeps Chinese messages and reports English ones', () => {
    const text = `${ZOD_FILE}
z.string({ required_error: '必填' });
z.string().min(3, 'must be longer');
`;

    expect(customMessages('fixture.ts', text)).toHaveLength(2);
    expect(englishMessages('fixture.ts', text).map((one) => one.message)).toEqual([
      'must be longer',
    ]);
  });

  it('does not see a schema written through a renamed or destructured Zod', () => {
    // A KNOWN LIMIT, and a contract from now on.
    //
    // The scan opens a schema context on a literal `z.…` call, so a namespace
    // bound to another name is invisible to it: the message never enters a
    // schema span, so it is neither read nor reported as unreadable. An
    // English sentence in either of these shapes would reach a person
    // unchallenged.
    //
    // The alternative is a JavaScript parser in a contract test, which is a
    // much larger thing to keep correct than the rule it guards — so the limit
    // is accepted and *pinned* instead: this assertion is what a reader (and
    // a future change) can point at. If the scan ever learns to see these
    // shapes, this test fails and says the limit is gone, so the rule can be
    // lifted on purpose rather than by accident.
    const renamed = scanZodMessages('fixture.ts', `import { z as zod } from 'zod';
const schema = zod.string({ message: 'an English sentence' });
`);

    expect(renamed).toEqual({ messages: [], unresolved: [] });

    const destructured = scanZodMessages('fixture.ts', `${ZOD_FILE}
const { string } = z;
const schema = string({ message: 'an English sentence' });
`);

    expect(destructured).toEqual({ messages: [], unresolved: [] });
  });

  it('ignores prose, other files, and messages it cannot read as a sentence', () => {
    const prose = `${ZOD_FILE}
// z.string({ message: 'this is a comment, not a schema' });
/* The previous code used message: 'Expected string' and it reached users. */
`;

    expect(customMessages('fixture.ts', prose)).toEqual([]);

    // A file that does not import Zod cannot define a schema, so its `message:`
    // fields are something else — a log record, an IPC payload — and judging
    // their language would be a false positive that keeps the suite red for no
    // reason.
    expect(
      customMessages(
        'other.ts',
        `logger.warn('x', { message: 'no context pack is attached to this turn' });`,
      ),
    ).toEqual([]);
  });
});

describe('no schema in this app writes an English sentence', () => {
  it('finds the app’s custom messages, so the scan is not vacuous', () => {
    // The purge schema's two sentences are the only custom messages this app
    // ships, and both are Chinese. Asserting they are *found* is what
    // distinguishes "nothing is English" from "the scanner stopped
    // recognising messages", which is the failure this file would otherwise
    // hide.
    const file = 'apps/desktop/src/main/ipc-storage.ts';
    const found = customMessages(file, readFileSync(file, 'utf8'));

    expect(found.map((one) => one.message)).toEqual([
      '清理未确认：请先预览要删除的内容，再确认一次。',
      '请求里有未知的字段：请只发送 scope、workspaceId 和 confirm。',
    ]);
  });

  it('can read every message position in shipping source', () => {
    // The English assertion only covers messages the scan can *read*. A shape
    // it cannot read is a hole in the rule, so the hole is asserted empty
    // rather than left as a comment. A new runtime-built message must either
    // become one Chinese literal, or this assertion must learn about that
    // shape explicitly — with a test for the language it assembles.
    const files = shippedSourceFiles();
    expect(files.length).toBeGreaterThan(50);

    const unresolved = files
      .flatMap((file) => scanZodMessages(file, readFileSync(file, 'utf8')).unresolved)
      .map((one) => `${one.file}:${one.at}: ${one.key} [${one.reason}] = ${one.expression}`);

    expect(
      unresolved,
      'the scan saw a message position it could not judge, so the English check does not cover it — write the message as one Chinese literal, or put the constant beside the schema',
    ).toEqual([]);
  });

  it('passes over every shipping source file', () => {
    const files = shippedSourceFiles();
    // A scan over zero files is a gate that cannot fail.
    expect(files.length).toBeGreaterThan(50);

    const offenders = files
      .flatMap((file) => englishMessages(file, readFileSync(file, 'utf8')))
      .map((one) => `${one.file}:${one.at}: ${one.key} = ${JSON.stringify(one.message)}`);

    expect(
      offenders,
      'a custom message without Chinese is read as Zod’s own wording and replaced by 「不符合要求」 — write the sentence in Chinese, or the person who sees the refusal gets the generic one',
    ).toEqual([]);
  });
});

/**
 * The scan's scope, asked of the repository rather than of the scan.
 *
 * A scan over the wrong files is as green as a scan over the right ones: an
 * English sentence in a workspace the scan never opens is invisible, and the
 * invariant still passes. The scope therefore has to be checked against what
 * the repository actually contains — otherwise "we scan everything that
 * ships" is a claim about a list in a source file, which is the kind of claim
 * this repository keeps turning into a gate.
 */
describe('the scan covers every workspace in this repository', () => {
  /**
   * The `src` directories this repository has, wherever they are.
   *
   * Two levels: a workspace is either a top-level directory with its own
   * `src`, or a directory of workspaces (`packages/one/src`). `node_modules`
   * and dot-directories are not the repository's source and are left out.
   */
  function repositorySourceRoots(): string[] {
    const roots: string[] = [];

    for (const entry of readdirSync('.', { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;

      const own = join(entry.name, 'src');
      if (existsSync(own)) {
        roots.push(own);
        continue;
      }

      for (const child of readdirSync(entry.name, { withFileTypes: true })) {
        if (!child.isDirectory()) continue;
        const nested = join(entry.name, child.name, 'src');
        if (existsSync(nested)) roots.push(nested);
      }
    }

    return roots;
  }

  it('scans a root for every workspace, and every root holds source', () => {
    // A root that does not exist is a typo; a root with no source in it is a
    // workspace that moved. Either way the scan is not reading what it claims
    // to read, and nothing else here would say so.
    expect(SCAN_ROOTS.length, 'the scan has no roots at all').toBeGreaterThan(0);

    for (const root of SCAN_ROOTS) {
      expect(existsSync(root), `${root} is listed as a root but does not exist`).toBe(true);
      expect(sourceFilesIn(root).length, `${root} is listed as a root but holds no source`).toBeGreaterThan(
        0,
      );
    }
  });

  it('scans every source root the repository has', () => {
    // The question that keeps the scope honest: not "does the scan read what
    // it lists", but "is there source the scan does not list". A workspace
    // added as a new top-level directory would not be in `SCAN_ROOTS` — the
    // roots are derived from `packages/` and `apps/` — and would carry
    // schemas the English check never reads.
    const roots = repositorySourceRoots();

    expect(roots.length, 'the repository has no source roots at all').toBeGreaterThan(0);

    const unscanned = roots.filter((root) => !SCAN_ROOTS.includes(root));

    expect(
      unscanned,
      'a source root this repository has is not in the scan’s scope — add it to SCAN_ROOTS in tests/contract/zod-message-scan.ts (and to CONTRIBUTING.md’s “Adding a workspace package” if it is a new top-level directory)',
    ).toEqual([]);
  });
});
