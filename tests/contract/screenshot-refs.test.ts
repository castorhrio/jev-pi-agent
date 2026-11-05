/**
 * Every screenshot a document sends a reader to has to be there.
 *
 * ## Why this file exists
 *
 * `screenshots.test.ts` next door asks the reverse question — does every
 * committed picture have a reader — and `state-walkthrough.test.ts` asks it for
 * the ten images a walker opens. Neither asks the question a reader actually
 * hits: **does the path in this table resolve**. A document is a set of links,
 * and a link to a file that is not there is the loudest way a document lies;
 * it is also the one failure that no hash can catch, because the file the hash
 * describes is the one that is missing.
 *
 * The gap was real and it was in the documents nobody had wired up:
 * `docs/demo-script.md` names five narrow-window pictures in one brace group,
 * `docs/manual-verification.md` names ten in a table, and nothing resolved
 * either list. Renaming a picture and forgetting one of the two documents that
 * point at it left the repository green — the manifest still recorded the file,
 * the orphan check still found a mention, and the reader got a 404.
 *
 * ## The two shorthands a naive scan gets wrong
 *
 * **Brace expansion.** `docs/screenshots/states/{empty,error}-768x700.png` is
 * how a document writes two paths without writing two paths. A scan that does
 * not expand it reports one missing file whose name contains braces, which is
 * both a false red and a missed check on the two files it really names.
 *
 * **Dated sections are a log.** `docs/dod-status.md` and the dated sections of
 * `docs/manual-verification.md` record what each round did, and part of what a
 * round does is delete a picture nobody pointed at — those two documents name
 * `docs/screenshots/states/empty.png` and `states/error.png` precisely because
 * they were removed. Reading a log as an instruction would make the log
 * un-writable, and rewriting history to keep a gate green is the failure this
 * repository refuses everywhere else. So the rule is: a heading that carries a
 * date is a log entry, an undated heading is an instruction, and only
 * instructions have to resolve.
 *
 * The rule is not a licence to hide a reference in a log. The second case below
 * is the other half: a picture whose only mention is inside a log has no reader
 * *today*, so it is an orphan — the log says it was deleted, and a file that is
 * still committed after its own obituary is a file nothing keeps honest.
 *
 * ## What is deliberately not asserted
 *
 * Whether the picture shows what the caption says. That is `state-walkthrough.md`
 * and a person's eyes; this file only asks whether the file a caption points at
 * exists.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  collectDocScreenshotRefs,
  expandBraces,
  markdownDocuments,
  screenshotFiles,
} from '../../scripts/screenshot-sources.mjs';

const REPO_ROOT = join(import.meta.dirname, '..', '..');

/** One place a document points at a screenshot. */
interface Ref {
  /** The document, repo-relative. */
  doc: string;
  /** The path it names, repo-relative. */
  path: string;
  /** The line the reference sits on, 1-based. */
  line: number;
  /** True when the reference is inside a dated section, i.e. a log entry. */
  inLog: boolean;
}

const documents = markdownDocuments(REPO_ROOT);
const refs: Ref[] = documents.flatMap((doc) =>
  collectDocScreenshotRefs(readFileSync(join(REPO_ROOT, doc), 'utf8')).map((ref) => ({
    ...ref,
    doc,
  })),
);

/** The references a reader is expected to follow today. */
function liveRefs(list: readonly Ref[]): Ref[] {
  return list.filter((ref) => !ref.inLog);
}

/**
 * The live references whose file is not there, as sentences that name them.
 *
 * Pure in `(refs, exists)` so the red direction can be driven without writing a
 * document or deleting a picture: a gate whose failure path is only reachable by
 * damaging the checkout is a gate nobody proves.
 */
function danglingRefs(list: readonly Ref[], exists: (path: string) => boolean): string[] {
  return liveRefs(list)
    .filter((ref) => !exists(ref.path))
    .map(
      (ref) =>
        `${ref.doc}:${ref.line} sends a reader to ${ref.path}, which is not in the repository`,
    );
}

/** The committed pictures no live reference names. */
function picturesWithoutReader(list: readonly Ref[], shots: readonly string[]): string[] {
  const named = new Set(liveRefs(list).map((ref) => ref.path));
  return shots.filter((shot) => !named.has(shot));
}

describe('the screenshots the documents point at', () => {
  it('reads documents and references, so the checks below are not vacuous', () => {
    // Unconditional and first, the house rule for every document gate here: a
    // deleted document must be the first red, not a run in which every case
    // below compares an empty list with itself.
    expect(documents.length, 'no markdown document was found to search').toBeGreaterThan(0);
    expect(refs.length, 'no document names a screenshot path').toBeGreaterThan(0);
    expect(
      liveRefs(refs).length,
      'every screenshot reference in the repository sits inside a dated section, so the ' +
        'instruction/log rule has swallowed the whole tree',
    ).toBeGreaterThan(0);
  });

  it('resolves every screenshot a document sends a reader to', () => {
    const dangling = danglingRefs(refs, (path) => existsSync(join(REPO_ROOT, path)));
    expect(
      dangling,
      `these references point at files that are not in the repository — fix the path, or ` +
        `restore the picture:\n  ${dangling.join('\n  ')}`,
    ).toEqual([]);
  });

  it('gives every committed picture a reader that is not a log entry', () => {
    // The orphan check in `screenshots.test.ts` counts any mention, including
    // one inside a dated section. That is the loophole this case closes: a
    // picture whose only mention is the log entry that deleted it is a picture
    // nothing keeps honest, and the log is not a reader — it is an obituary.
    const shots = screenshotFiles(REPO_ROOT);
    expect(shots.length, 'no screenshot is committed').toBeGreaterThan(0);
    const orphans = picturesWithoutReader(refs, shots);
    expect(
      orphans,
      `these pictures are committed and only a dated section mentions them, so no document ` +
        `sends a reader to them today — name each one in an undated section, or delete it:\n  ` +
        orphans.join('\n  '),
    ).toEqual([]);
  });
});

describe('the shorthands a document uses to name pictures', () => {
  it('expands a brace group into the files it names', () => {
    // The form `docs/demo-script.md` uses for the five narrow-window pictures.
    expect(expandBraces('docs/screenshots/states/{empty,error}-768x700.png')).toEqual([
      'docs/screenshots/states/empty-768x700.png',
      'docs/screenshots/states/error-768x700.png',
    ]);
    // Nested, because a group inside a group is the same shorthand one level
    // down and a single-pass expansion would leave braces in the result.
    expect(expandBraces('a/{b,{c,d}}/x.png')).toEqual(['a/b/x.png', 'a/c/x.png', 'a/d/x.png']);
    // Total: a pattern with no group, or with an unclosed one, comes back as
    // itself. Dropping it would hide the file it names.
    expect(expandBraces('docs/screenshots/empty.png')).toEqual(['docs/screenshots/empty.png']);
    expect(expandBraces('docs/screenshots/{empty.png')).toEqual(['docs/screenshots/{empty.png']);
  });

  it('reads a brace group in a document as the files it names', () => {
    const found = collectDocScreenshotRefs(
      '窄窗口：`docs/screenshots/states/{empty,error}-768x700.png`。\n',
    );
    expect(found.map((ref) => ref.path)).toEqual([
      'docs/screenshots/states/empty-768x700.png',
      'docs/screenshots/states/error-768x700.png',
    ]);
    expect(found.map((ref) => ref.line)).toEqual([1, 1]);
  });
});

describe('a dated section is a log, an undated one is an instruction', () => {
  const markdown = [
    '# 文档',
    '',
    '## 判据',
    '',
    '看 `docs/screenshots/empty.png`。',
    '',
    '## 本轮（2026-11-05）删掉两张没人点名的截图',
    '',
    '`docs/screenshots/states/empty.png` 与 `docs/screenshots/states/error.png` 已删除。',
    '',
    '### 顺带量到的真缺陷',
    '',
    '`docs/screenshots/states/orphan-demo.png` 是合成输入。',
    '',
  ].join('\n');

  it('marks the references under a dated heading, at any depth', () => {
    const found = collectDocScreenshotRefs(markdown);
    const byPath = new Map(found.map((ref) => [ref.path, ref.inLog]));
    expect(byPath.get('docs/screenshots/empty.png'), 'the undated section is an instruction')
      .toBe(false);
    expect(
      byPath.get('docs/screenshots/states/empty.png'),
      'the dated section is a log entry',
    ).toBe(true);
    // The `###` under the dated `##` is still a log: the nearest heading is not
    // enough, which is exactly the shape `docs/manual-verification.md` has.
    expect(
      byPath.get('docs/screenshots/states/orphan-demo.png'),
      'a subsection of a dated section is still a log',
    ).toBe(true);
  });

  it('does not report a log entry as a dangling reference', () => {
    // The whole point of the rule: history may name a file that is gone.
    const dangling = danglingRefs(collectDocScreenshotRefs(markdown).map((ref) => ({
      ...ref,
      doc: 'docs/example.md',
    })), () => false);
    expect(dangling).toEqual([
      'docs/example.md:5 sends a reader to docs/screenshots/empty.png, which is not in the repository',
    ]);
  });

  it('names the document and the line when a reference dangles', () => {
    // The sentence a red run prints is the gate's value: "a screenshot is
    // missing" sends a reader through eleven documents.
    const dangling = danglingRefs(
      [
        { doc: 'docs/demo-script.md', path: 'docs/screenshots/states/partial.png', line: 144, inLog: false },
        { doc: 'docs/state-walkthrough.md', path: 'docs/screenshots/empty.png', line: 33, inLog: false },
      ],
      (path) => path.endsWith('empty.png'),
    );
    expect(dangling).toEqual([
      'docs/demo-script.md:144 sends a reader to docs/screenshots/states/partial.png, which is ' +
        'not in the repository',
    ]);
  });

  it('counts a picture named only by a log as having no reader', () => {
    // The reverse direction, driven on the same synthetic document: the two
    // pictures the log says were deleted are orphans if they are still on disk,
    // and the one the instruction names is not.
    const orphans = picturesWithoutReader(collectDocScreenshotRefs(markdown).map((ref) => ({
      ...ref,
      doc: 'docs/example.md',
    })), [
      'docs/screenshots/empty.png',
      'docs/screenshots/states/empty.png',
      'docs/screenshots/states/orphan-demo.png',
    ]);
    expect(orphans).toEqual([
      'docs/screenshots/states/empty.png',
      'docs/screenshots/states/orphan-demo.png',
    ]);
  });
});
