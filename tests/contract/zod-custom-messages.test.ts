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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

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

  it('does not judge a message that follows a regex literal containing a comma', () => {
    // A KNOWN LIMIT, pinned beside the renamed/destructured pair above.
    //
    // `secondArgument` finds the separator by walking characters and counting
    // nesting; a regular-expression literal is not a quote it knows, so the
    // comma inside `/a,b/` reads as the argument separator. The sentence is
    // never read — an English one passes the check that exists to find it —
    // and the only trace is an unresolved entry that names `b`, the text after
    // the comma inside the regex.
    //
    // Unlike the two shapes above, this one does reach the app-wide gate: the
    // `unresolved` list is asserted empty for shipping source, so this fixture
    // could not ship silently. What is lost is the language check, and the
    // report misnames the shape. Teaching the walk about regex literals is the
    // fix; until then the cost is a contract, and this assertion is where a
    // future change meets it.
    const text = `${ZOD_FILE}
const schema = z.string().regex(/a,b/, 'must be longer');
`;

    const scan = scanZodMessages('fixture.ts', text);

    // An English sentence in a message position, and the English check finds
    // nothing: this is the miss the limit is about.
    expect(scan.messages).toEqual([]);
    expect(englishMessages('fixture.ts', text)).toEqual([]);
    // What the scan reports instead is not the message: the argument walk
    // stopped at the comma inside the regex, so the "unknown constant" is a
    // fragment of the pattern.
    expect(scan.unresolved).toEqual([
      {
        file: 'fixture.ts',
        at: 2,
        key: 'regex() argument',
        reason: 'unknown-constant',
        expression: "b/, 'must be longer');",
      },
    ]);
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
   * The `src` directories under `dir`, at any depth.
   *
   * The question is asked of the *repository*, not of the rule that derives the
   * scan's roots. A walk that stopped where the rule stops would report
   * exactly the roots the rule reaches — and a root the rule misses would be
   * neither scanned nor reported: `apps/desktop/worker/src` is not
   * `apps/<name>/src` and not under one, so an English sentence there passed
   * this gate untouched, in a test whose subject is "the scan covers every
   * workspace".
   *
   * The directories left out are build output and the test tree, and each for a
   * reason:
   *
   *  - `node_modules`, `dist`, `out`, `release`, `coverage` — the names in
   *    `.gitignore`; they are output, not this repository's source;
   *  - dot-directories — the tool's own (`.git`, `.run-logs`);
   *  - `tests` — the test tree ships nothing, and it carries English sentences
   *    on purpose: they are the fixtures that prove the scan can read and
   *    judge one.
   */
  function sourceRootsUnder(dir: string): string[] {
    const roots: string[] = [];

    const walk = (current: string): void => {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith('.')) continue;
        if (
          entry.name === 'node_modules' ||
          entry.name === 'dist' ||
          entry.name === 'out' ||
          entry.name === 'release' ||
          entry.name === 'coverage' ||
          entry.name === 'tests'
        ) {
          continue;
        }

        const full = join(current, entry.name);
        if (entry.name === 'src') roots.push(full);
        // A `src` directory is descended into as well: a root may hold
        // another one (`apps/desktop/src/renderer/src`), and that one is a
        // root of its own.
        walk(full);
      }
    };

    walk(dir);

    return roots;
  }

  /** Every source root this repository has. */
  function repositorySourceRoots(): string[] {
    return sourceRootsUnder('.');
  }

  /**
   * The source roots the scan does not read.
   *
   * A root is read when it *is* one of the scanned roots or sits under one of
   * them — the scan walks a root recursively, so a root nested inside a
   * scanned root is covered by it (`apps/desktop/src/renderer/src` is read by
   * `apps/desktop/src`). The separator matters: `packages/bench/src-extra` is
   * not under `packages/bench/src`.
   */
  function unreadSourceRoots(roots: readonly string[], scanned: readonly string[]): string[] {
    return roots.filter((root) => !scanned.some((one) => root === one || root.startsWith(one + sep)));
  }

  it('finds a source root at any depth, and skips the build output', () => {
    // The walk is the fix, so the walk is what is tested: a version that
    // stopped at the depth the scan's own rule reaches would pass the
    // assertion below on this repository and miss a root the rule misses.
    const dir = mkdtempSync(join(tmpdir(), 'ucad-scan-roots-'));
    try {
      mkdirSync(join(dir, 'apps', 'desktop', 'src'), { recursive: true });
      mkdirSync(join(dir, 'apps', 'desktop', 'src', 'renderer', 'src'), { recursive: true });
      mkdirSync(join(dir, 'packages', 'one', 'src'), { recursive: true });
      mkdirSync(join(dir, 'node_modules', 'pkg', 'src'), { recursive: true });
      mkdirSync(join(dir, 'dist', 'src'), { recursive: true });
      mkdirSync(join(dir, 'tests', 'src'), { recursive: true });
      mkdirSync(join(dir, '.hidden', 'src'), { recursive: true });

      const roots = sourceRootsUnder(dir)
        .map((root) => root.slice(dir.length + 1))
        .sort();

      expect(roots).toEqual(
        [
          join('apps', 'desktop', 'src'),
          join('apps', 'desktop', 'src', 'renderer', 'src'),
          join('packages', 'one', 'src'),
        ].sort(),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports a source root the scan does not read', () => {
    // The red-proof for the assertion below: a coverage rule that reported
    // nothing would leave "every source root is read" true for any
    // repository, including one with an unread root.
    //
    // The paths are joined rather than written out, because the coverage rule
    // compares against the platform's separator.
    const bench = join('packages', 'bench', 'src');
    const desktop = join('apps', 'desktop', 'src');
    const scanned = [bench, desktop];

    // Read: the root itself, and a root nested inside a scanned one.
    expect(unreadSourceRoots([bench, join('apps', 'desktop', 'src', 'renderer', 'src')], scanned)).toEqual(
      [],
    );
    // Not read: a root that is not under any scanned root — the shape that
    // used to pass this gate untouched.
    expect(unreadSourceRoots([join('apps', 'desktop', 'worker', 'src')], scanned)).toEqual([
      join('apps', 'desktop', 'worker', 'src'),
    ]);
    // Not read: a name that merely starts with a scanned root.
    expect(unreadSourceRoots([`${bench}-extra`], scanned)).toEqual([`${bench}-extra`]);
  });

  it('reads a file nested under a scanned root', () => {
    // The coverage rule above says a root *under* a scanned root is read.
    // That is only true while the scan walks a root recursively, so the
    // recursion is pinned here on a fixture rather than assumed.
    const dir = mkdtempSync(join(tmpdir(), 'ucad-scan-files-'));
    try {
      mkdirSync(join(dir, 'a', 'b'), { recursive: true });
      writeFileSync(join(dir, 'a', 'b', 'deep.ts'), 'export const x = 1;\n');

      expect(sourceFilesIn(dir)).toContain(join(dir, 'a', 'b', 'deep.ts'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

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

  it('reads every source root the repository has', () => {
    // The question that keeps the scope honest: not "does the scan read what
    // it lists", but "is there source the scan does not read". A workspace
    // added as a new top-level directory, or nested deeper than the rule that
    // derives the roots reaches, is not in `SCAN_ROOTS` — and its schemas
    // would never be read by the English check.
    const roots = repositorySourceRoots();

    expect(roots.length, 'the repository has no source roots at all').toBeGreaterThan(0);

    const unread = unreadSourceRoots(roots, SCAN_ROOTS);

    expect(
      unread,
      'a source root this repository has is not read by the scan — add it to EXTRA_SCAN_ROOTS in tests/contract/zod-message-scan.ts (and to CONTRIBUTING.md’s “Adding a workspace package” if it is a new top-level directory)',
    ).toEqual([]);
  });
});
