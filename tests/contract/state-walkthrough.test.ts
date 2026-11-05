/**
 * The five interface states have criteria a person can answer, two pictures
 * each, and a record table that has to be signed before the README stops
 * saying nobody looked.
 *
 * ## Why this file exists
 *
 * `docs/manual-verification.md` step 6 has carried the same sentence for several
 * rounds: the five states are asserted, measured and photographed, and nobody
 * has looked at them and said they read as a first run, a failure, a permission
 * prompt. The sentence was honest and it was also stuck, because "go and look"
 * is not something one person can hand to another — there was no list of
 * questions, no place to write the answers, and no consequence for either
 * answering or not.
 *
 * `docs/state-walkthrough.md` is that handover: three yes/no criteria per state,
 * a five-minute script that walks ten images in order, and a record table where
 * a dated row *is* the signature. This file keeps the halves of that promise
 * from drifting apart:
 *
 *  - every walkable state has a section, and every section has criteria that
 *    name something a person can actually find on screen (a backticked literal
 *    from `i18n.ts`, or the screenshot the section points at);
 *  - every screenshot a section names exists, so the remote path — "send the
 *    images to someone who has not installed the app" — cannot rot into a 404;
 *  - every screenshot a section names is also *recorded* in
 *    `docs/screenshots/sources.json`, so the sentence `node
 *    scripts/screenshot-sources.mjs --check` prints — "these images still match
 *    the renderer sources" — is a sentence about the ten images the walker is
 *    sent to. Without this, the walkthrough could name an image the manifest
 *    never hashed, and the check would be green about a different set of files
 *    than the one a person is asked to look at. That is the same shape as a
 *    README citing a test that was renamed: two lists that are supposed to be
 *    one, drifting apart quietly;
 *  - every state is photographed at **two** sizes, and the narrow one really is
 *    the narrow one: its filename and its pixels both have to equal the
 *    `minWidth`/`minHeight` the product declares. A walkthrough that only ever
 *    saw 1440x900 cannot answer "长中文在窄窗口是否撑破", which is the question
 *    step 6 has been asking since it was written;
 *  - the five-minute script lists exactly those ten images, in the order a
 *    walker should open them. A state added to the sections and forgotten in
 *    the script is a state nobody walks;
 *  - and the README and the record table agree about whether anyone has looked.
 *    While the table has no dated row, both language halves of the README must
 *    still say the states have not been walked by eye; once a row is dated, the
 *    README must carry that date. Either half alone is the failure this
 *    repository keeps finding: a green gate over an unwalked screen, or a
 *    README apologising for a walkthrough that already happened.
 *
 * ## Why the criteria are checked for a literal, not for quality
 *
 * "Is the guidance prominent enough" cannot be judged by a machine, and a gate
 * that pretended to would be the worst kind of green. What *can* be checked is
 * that each criterion points at something specific: a criterion that names no
 * on-screen text is a criterion a walker can answer from memory, which is how
 * "looks fine" gets written into a record. The literal is the anchor, not the
 * judgement.
 *
 * ## What is deliberately not asserted
 *
 * How many criteria a state has beyond the floor of three, what they say, or
 * whether a signed row's conclusion is true. A record is a person's statement;
 * this file only makes sure the statement has somewhere to live and that the
 * README cannot quietly disagree with it. Nor is the *content* of the narrow
 * screenshots judged — only that they are the size they claim to be. Whether
 * the guidance still reads at 768px is the question the walker answers.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { STATE_SCENARIOS } from '../../apps/desktop/src/renderer/src/dev/scenarios';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const WALKTHROUGH_PATH = join(REPO_ROOT, 'docs', 'state-walkthrough.md');
const README_PATH = join(REPO_ROOT, 'README.md');
const BOOTSTRAP_PATH = join(REPO_ROOT, 'apps', 'desktop', 'src', 'main', 'bootstrap.ts');
const MANIFEST_PATH = join(REPO_ROOT, 'docs', 'screenshots', 'sources.json');

/** The fewest criteria a state may carry and still be a walkthrough. */
const MIN_CRITERIA = 3;

/** A screenshot a section points at, e.g. `docs/screenshots/states/loading.png`. */
const SCREENSHOT = /docs\/screenshots\/[\w./-]+\.png/g;

/** A backticked literal: the on-screen text a criterion is anchored to. */
const LITERAL = /`[^`\n]+`/;

/** A dated record row, i.e. a signature. */
const SIGNED_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The narrow-window screenshot's name, which carries the size it was taken at. */
const TIGHT_NAME = /-(\d+)x(\d+)\.png$/;

/** The heading the five-minute script lives under. */
const SCRIPT_HEADING = '## 5 分钟走查脚本';

interface Size {
  readonly width: number;
  readonly height: number;
}

/** What the checks compare the document against. */
interface Repository {
  readonly fileExists: (relativePath: string) => boolean;
  /** A PNG's pixel size, or `null` when the file is missing or not a PNG. */
  readonly pngSize: (relativePath: string) => Size | null;
  /**
   * Whether `docs/screenshots/sources.json` records a hash for this image.
   *
   * The manifest is what `scripts/screenshot-sources.mjs --check` compares the
   * renderer sources against, so an image it does not record is an image that
   * check says nothing about — while the walkthrough still sends a person to
   * look at it.
   */
  readonly trackedScreenshot: (relativePath: string) => boolean;
}

/**
 * The two windows the walkthrough is taken at, read from the product itself.
 *
 * `bootstrap.ts` is the one place that decides how big the app opens and how
 * small it may get; a number copied into this file would be a second fact that
 * drifts from the first. Both are matched inside the `new BrowserWindow({…})`
 * call so that an unrelated `width:` elsewhere in the file cannot be picked up.
 */
function windows(): { opening: Size; min: Size } {
  const source = readFileSync(BOOTSTRAP_PATH, 'utf8');
  const start = source.indexOf('new BrowserWindow({');
  expect(start, 'bootstrap.ts no longer creates a BrowserWindow').toBeGreaterThan(-1);
  // Comments stripped first: `bootstrap.ts` explains the old `minWidth: 1080`
  // in prose right above the real declaration, and a regex over raw source
  // reads that sentence as the declaration. The layout gate learned this the
  // hard way; a comment is not a declaration.
  const options = source
    .slice(start, source.indexOf('});', start))
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  const read = (name: string): number => {
    const match = new RegExp(`\\b${name}:\\s*(\\d+)`).exec(options);
    expect(match, `bootstrap.ts no longer declares ${name}`).not.toBeNull();
    return Number(match![1]);
  };
  return {
    opening: { width: read('width'), height: read('height') },
    min: { width: read('minWidth'), height: read('minHeight') },
  };
}

const WINDOWS = windows();

/**
 * A PNG's pixel size, read from its IHDR chunk.
 *
 * The first eight bytes are the signature, then a four-byte length, the chunk
 * type `IHDR`, and the width and height as big-endian 32-bit integers. Reading
 * them costs no dependency, and a dependency for this would be the tail wagging
 * the dog.
 */
function pngSize(bytes: Buffer): Size | null {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(signature)) return null;
  if (bytes.subarray(12, 16).toString('ascii') !== 'IHDR') return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/**
 * The `### <name>` sections of the document, by name.
 *
 * A level-1/2 heading ends the current section, so the record table and the
 * closing notes are not read as part of the last state.
 */
function sections(markdown: string): Map<string, string> {
  const out = new Map<string, string>();
  let name: string | null = null;
  let body: string[] = [];
  const flush = (): void => {
    if (name !== null) out.set(name, body.join('\n'));
  };
  for (const line of markdown.split('\n')) {
    const heading = line.match(/^### (\S+)\s*$/);
    if (heading) {
      flush();
      name = heading[1]!;
      body = [];
      continue;
    }
    if (/^#{1,3} /.test(line)) {
      flush();
      name = null;
      body = [];
      continue;
    }
    if (name !== null) body.push(line);
  }
  flush();
  return out;
}

/** The body of the `## 5 分钟走查脚本` section, or `undefined` when it is gone. */
function scriptSection(markdown: string): string | undefined {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => line.trim() === SCRIPT_HEADING);
  if (start === -1) return undefined;
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,2} /.test(line)) break;
    body.push(line);
  }
  return body.join('\n');
}

/**
 * The `- [ ]` items of a section, with their wrapped continuation lines joined.
 *
 * The criteria are prose and markdown wraps them; reading only the first line
 * would report a criterion as unanchored when its literal is on the next line.
 */
function checklistItems(section: string): string[] {
  const items: string[] = [];
  let current: string | null = null;
  for (const line of section.split('\n')) {
    const start = line.match(/^\s*- \[ \] (.*)$/);
    if (start) {
      if (current !== null) items.push(current);
      current = start[1]!;
      continue;
    }
    if (current === null) continue;
    if (/^\s{2,}\S/.test(line) && !/^\s*- /.test(line)) {
      current = `${current} ${line.trim()}`;
      continue;
    }
    items.push(current);
    current = null;
  }
  if (current !== null) items.push(current);
  return items;
}

/** Every screenshot path a section names, in document order. */
function screenshotsIn(section: string): string[] {
  return [...section.matchAll(SCREENSHOT)].map((match) => match[0]);
}

/**
 * The dates of the record table's signed rows.
 *
 * A row is signed when its first cell is a date. The placeholder row the
 * document ships with has `—` there, which is the point: an unsigned table and
 * a signed one must not look the same to this gate. The sign template in the
 * five-minute script uses `YYYY-MM-DD`, which is deliberately not a date.
 */
function signedDates(markdown: string): string[] {
  const dates: string[] = [];
  for (const line of markdown.split('\n')) {
    if (!line.trim().startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
    if (cells.length === 0) continue;
    if (SIGNED_DATE.test(cells[0]!)) dates.push(cells[0]!);
  }
  return dates;
}

/**
 * The columns a record row has to carry, in the order a signer fills them.
 *
 * Four, not three. `看了哪几张` is the one that was missing from the check and
 * is the one that carries the walk: a row that says "signed, all satisfied"
 * without saying how many images were opened is a signature over an unknown
 * amount of looking, and the whole point of the ten-image script is that a
 * walker who opened five of them has not walked the states they did not open.
 * The column is in the document already; this makes dropping it a red run.
 */
const RECORD_COLUMNS = ['日期', '走查人', '看了哪几张', '结论'] as const;

/** Whether the record table has the columns a signer needs. */
function hasRecordColumns(markdown: string): boolean {
  return markdown
    .split('\n')
    .some(
      (line) =>
        line.trim().startsWith('|') &&
        RECORD_COLUMNS.every((column) => line.includes(column)),
    );
}

/** The two language halves of the README, or `undefined` when the split is gone. */
function languageHalves(markdown: string): { en: string; zh: string } | undefined {
  const en = markdown.indexOf('## English');
  const zh = markdown.indexOf('## 中文');
  if (en === -1 || zh === -1 || zh < en) return undefined;
  return { en: markdown.slice(en, zh), zh: markdown.slice(zh) };
}

/** `1440x900`, the way a person writes a window size. */
function sizeLabel(size: Size): string {
  return `${size.width}x${size.height}`;
}

/**
 * The two pictures a state has to carry, and every way they can be wrong.
 *
 * Split out because the same three questions are asked of every state and the
 * sentences have to name the state and the file: "the screenshot is the wrong
 * size" sends a reader looking through ten images.
 */
function pictureProblems(state: string, shots: string[], repository: Repository): string[] {
  const problems: string[] = [];
  const tight = shots.filter((shot) => TIGHT_NAME.test(shot));
  const wide = shots.filter((shot) => !TIGHT_NAME.test(shot));

  if (wide.length === 0) {
    problems.push(
      `docs/state-walkthrough.md: \`${state}\` names no full-window screenshot, so the ` +
        `walkthrough has no ${sizeLabel(WINDOWS.opening)} picture to judge`,
    );
  }
  for (const shot of wide) {
    const size = repository.pngSize(shot);
    if (size === null) {
      problems.push(`docs/state-walkthrough.md: \`${state}\` shows \`${shot}\`, which is not a PNG`);
      continue;
    }
    if (size.width === WINDOWS.opening.width && size.height === WINDOWS.opening.height) continue;
    problems.push(
      `docs/state-walkthrough.md: \`${shot}\` is ${sizeLabel(size)} and the app opens at ` +
        `${sizeLabel(WINDOWS.opening)} — retake it, or the walkthrough is judging a window ` +
        'the product does not open',
    );
  }

  if (tight.length === 0) {
    problems.push(
      `docs/state-walkthrough.md: \`${state}\` names no narrow-window screenshot, so nobody ` +
        `can answer "长中文在窄窗口是否撑破" at ${sizeLabel(WINDOWS.min)}`,
    );
    return problems;
  }
  if (tight.length > 1) {
    problems.push(
      `docs/state-walkthrough.md: \`${state}\` names ${tight.length} narrow-window screenshots ` +
        `(${tight.join(', ')}); a walkthrough needs exactly one`,
    );
  }
  for (const shot of tight) {
    const named = TIGHT_NAME.exec(shot)!;
    const namedSize = { width: Number(named[1]), height: Number(named[2]) };
    if (namedSize.width !== WINDOWS.min.width || namedSize.height !== WINDOWS.min.height) {
      problems.push(
        `docs/state-walkthrough.md: \`${shot}\` is named for ${sizeLabel(namedSize)} and the ` +
          `smallest window the product allows is ${sizeLabel(WINDOWS.min)}`,
      );
    }
    const size = repository.pngSize(shot);
    if (size === null) {
      problems.push(`docs/state-walkthrough.md: \`${state}\` shows \`${shot}\`, which is not a PNG`);
      continue;
    }
    if (size.width === WINDOWS.min.width && size.height === WINDOWS.min.height) continue;
    problems.push(
      `docs/state-walkthrough.md: \`${shot}\` is ${sizeLabel(size)} and the smallest window the ` +
        `product allows is ${sizeLabel(WINDOWS.min)} — the narrow picture is not narrow`,
    );
  }
  return problems;
}

/**
 * Every way the walkthrough document, the repository and the README disagree.
 *
 * Empty means the handover is intact. Pure in `(walkthrough, readme, repository)`
 * so the interesting cases — a state with no section, a criterion anchored to
 * nothing, a narrow picture that is not narrow, a script that skips an image, a
 * signed table next to a README that still says nobody looked — can be shown
 * producing a failure instead of being argued about.
 */
function walkthroughProblems(
  walkthrough: string,
  readme: string,
  repository: Repository,
): string[] {
  const problems: string[] = [];
  const found = sections(walkthrough);

  /** The order a walker should open the images in: state by state, wide then narrow. */
  const expectedOrder: string[] = [];

  for (const state of STATE_SCENARIOS) {
    const section = found.get(state);
    if (section === undefined) {
      problems.push(`docs/state-walkthrough.md: no \`### ${state}\` section, so nobody can walk it`);
      continue;
    }

    const items = checklistItems(section);
    if (items.length < MIN_CRITERIA) {
      problems.push(
        `docs/state-walkthrough.md: \`${state}\` has ${items.length} criteria, ` +
          `fewer than the ${MIN_CRITERIA} a walkthrough needs`,
      );
    }
    for (const item of items) {
      if (LITERAL.test(item)) continue;
      problems.push(
        `docs/state-walkthrough.md: a \`${state}\` criterion names nothing on screen ` +
          `(${JSON.stringify(item.slice(0, 48))}); anchor it to a literal a walker can find`,
      );
    }

    const shots = [...new Set(screenshotsIn(section))];
    if (shots.length === 0) {
      problems.push(
        `docs/state-walkthrough.md: \`${state}\` names no screenshot, so the remote ` +
          'walkthrough has nothing to look at',
      );
      continue;
    }
    for (const shot of shots) {
      if (!repository.fileExists(shot)) {
        problems.push(
          `docs/state-walkthrough.md: \`${state}\` shows \`${shot}\`, which is not in the repository`,
        );
        continue;
      }
      if (repository.trackedScreenshot(shot)) continue;
      problems.push(
        `docs/state-walkthrough.md: \`${state}\` shows \`${shot}\`, which ` +
          '`docs/screenshots/sources.json` does not record — an image the manifest never ' +
          'hashed is one `node scripts/screenshot-sources.mjs --check` cannot say is still ' +
          'the current screen, so the walker would be judging a picture no gate keeps honest',
      );
    }
    problems.push(...pictureProblems(state, shots, repository));

    const wide = shots.find((shot) => !TIGHT_NAME.test(shot));
    const tight = shots.find((shot) => TIGHT_NAME.test(shot));
    if (wide !== undefined) expectedOrder.push(wide);
    if (tight !== undefined) expectedOrder.push(tight);
  }

  const script = scriptSection(walkthrough);
  if (script === undefined) {
    problems.push(
      `docs/state-walkthrough.md: no \`${SCRIPT_HEADING}\` section, so the walkthrough is a ` +
        'pile of criteria rather than something a person can finish in five minutes',
    );
  } else {
    const listed = screenshotsIn(script);
    if (listed.join('\n') !== expectedOrder.join('\n')) {
      problems.push(
        `docs/state-walkthrough.md: the five-minute script lists ${listed.length} image(s) and ` +
          `the state sections call for ${expectedOrder.length}, in this order:\n    ` +
          expectedOrder.join('\n    '),
      );
    }
  }

  if (!hasRecordColumns(walkthrough)) {
    problems.push(
      `docs/state-walkthrough.md: the record table has no ${RECORD_COLUMNS.join(' / ')} ` +
        'columns, so a walkthrough has nowhere to be signed',
    );
  }

  const halves = languageHalves(readme);
  if (halves === undefined) {
    problems.push('README.md: no `## English` / `## 中文` split, so the two halves cannot be compared');
    return problems;
  }

  const dates = signedDates(walkthrough);
  if (dates.length === 0) {
    // Nobody has looked. Both halves have to say so: a limitation stated in one
    // language and dropped in the other is the defect `readme-parity.test.ts`
    // exists for, one document out.
    if (!halves.en.includes('by eye')) {
      problems.push(
        'README.md: the walkthrough table has no dated row, but the English half no longer ' +
          'says the five states have not been walked through by eye',
      );
    }
    if (!halves.zh.includes('人眼')) {
      problems.push(
        'README.md: the walkthrough table has no dated row, but the Chinese half no longer ' +
          'says the five states have not been walked through by eye',
      );
    }
    return problems;
  }

  // Someone signed. The README has to carry the date, in both halves, or the
  // document keeps apologising for a walkthrough that already happened.
  const latest = [...dates].sort().at(-1)!;
  for (const [language, half] of Object.entries(halves)) {
    if (half.includes(latest)) continue;
    problems.push(
      `README.md: the walkthrough was signed on ${latest}, but the ${language} half ` +
        'does not carry that date',
    );
  }

  return problems;
}

const walkthrough = existsSync(WALKTHROUGH_PATH) ? readFileSync(WALKTHROUGH_PATH, 'utf8') : '';
const readme = existsSync(README_PATH) ? readFileSync(README_PATH, 'utf8') : '';
/**
 * The screenshots `docs/screenshots/sources.json` records, by path.
 *
 * Read once, and read as a set of keys rather than as hashes: this file asks
 * whether an image is *accounted for*, not whether its bytes are current —
 * `tests/contract/screenshots.test.ts` and `scripts/screenshot-sources.mjs`
 * own the bytes.
 */
const TRACKED_SHOTS = new Set<string>(
  existsSync(MANIFEST_PATH)
    ? Object.keys(
        (JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as { screenshots?: object }).screenshots ??
          {},
      )
    : [],
);

const REPOSITORY: Repository = {
  fileExists: (relativePath) => existsSync(join(REPO_ROOT, relativePath)),
  pngSize: (relativePath) => {
    const full = join(REPO_ROOT, relativePath);
    return existsSync(full) ? pngSize(readFileSync(full)) : null;
  },
  trackedScreenshot: (relativePath) => TRACKED_SHOTS.has(relativePath),
};

/**
 * A repository that answers without touching the disk.
 *
 * The size it reports is derived from the filename, so a case can drive the
 * "the narrow picture is not narrow" branch by renaming a file in the document
 * rather than by writing a PNG. `overrides` is how a case makes one answer
 * wrong on purpose.
 */
function fakeRepo(overrides: Partial<Repository> = {}): Repository {
  return {
    fileExists: () => true,
    pngSize: (relativePath) => {
      const match = TIGHT_NAME.exec(relativePath);
      return match
        ? { width: Number(match[1]), height: Number(match[2]) }
        : { ...WINDOWS.opening };
    },
    trackedScreenshot: () => true,
    ...overrides,
  };
}

/** The document with one state's narrow-window line removed. */
function withoutTight(state: string): string {
  return walkthrough.replace(
    new RegExp(`(### ${state}\\n\\n- 图：[^\\n]*?)· 窄窗口：\`[^\`]+\`（[^）]*）`, 'u'),
    '$1',
  );
}

describe('the five states have criteria a person can answer', () => {
  it('the walkthrough document is present, so the checks below have a subject', () => {
    // Unconditional: a missing document is a red run, not a skip. This
    // repository has removed `skipIf` guards twice for exactly this reason.
    expect(existsSync(WALKTHROUGH_PATH), `docs/state-walkthrough.md is missing`).toBe(true);
    expect(walkthrough.length, 'docs/state-walkthrough.md is empty').toBeGreaterThan(0);
  });

  it('every walkable state has a section, criteria and two pictures', () => {
    const problems = walkthroughProblems(walkthrough, readme, REPOSITORY);
    expect(
      problems,
      `the walkthrough and the repository disagree:\n  ${problems.join('\n  ')}`,
    ).toEqual([]);
  });

  it('covers exactly the states the harness can install', () => {
    // The list is imported rather than restated: a sixth state added to
    // `scenarios.ts` must arrive here with criteria, and a state removed from
    // the harness must not leave a section nobody can reach.
    const found = sections(walkthrough);
    for (const state of STATE_SCENARIOS) {
      expect([...found.keys()], `no section for ${state}`).toContain(state);
    }
    expect(STATE_SCENARIOS.length, 'the walkable list is empty').toBeGreaterThan(0);
  });

  it('the five-minute script walks ten images, two per state', () => {
    // The count is the point: five states at two sizes is the whole walk, and a
    // script that lists nine of them is a walk that ends early without saying
    // so. The order is checked by `walkthroughProblems`; this case states the
    // arithmetic a reader can verify at a glance.
    const script = scriptSection(walkthrough);
    expect(script, `no \`${SCRIPT_HEADING}\` section`).toBeDefined();
    expect(screenshotsIn(script!)).toHaveLength(STATE_SCENARIOS.length * 2);
  });

  it('the narrow pictures are the smallest window the product allows', () => {
    // Read from `bootstrap.ts`, not written down here: the walkthrough's claim
    // is "this is the tightest window a user can produce", and that number
    // lives in the product. A capture at some other size would be a picture of
    // a window nobody can open.
    const tight = [...walkthrough.matchAll(/docs\/screenshots\/[\w./-]+-\d+x\d+\.png/g)].map(
      (match) => match[0],
    );
    expect(tight.length, 'the walkthrough names no narrow-window screenshot').toBeGreaterThan(0);
    for (const shot of tight) {
      expect(REPOSITORY.pngSize(shot), `${shot} is not a PNG`).toEqual(WINDOWS.min);
    }
  });

  it('the record table is unsigned, and the README says so in both languages', () => {
    // The state of the repository today: criteria written, nobody has looked.
    // If this case fails because a row was signed, the fix is the README — see
    // the case below, which is the other half of the same rule.
    expect(signedDates(walkthrough), 'a walkthrough row is dated').toEqual([]);
    const halves = languageHalves(readme)!;
    expect(halves.en).toContain('by eye');
    expect(halves.zh).toContain('人眼');
  });

  it('reports a state with no section', () => {
    const problems = walkthroughProblems(
      '# 走查\n\n## 判据\n\n### empty\n\n- 图：`docs/screenshots/empty.png`\n',
      readme,
      fakeRepo(),
    );
    expect(problems).toContain(
      'docs/state-walkthrough.md: no `### loading` section, so nobody can walk it',
    );
  });

  it('reports a criterion that names nothing on screen', () => {
    const doc = [
      '### empty',
      '- 图：`docs/screenshots/empty.png`',
      '- [ ] 引导语够醒目。',
      '- [ ] 三步可数。',
      '- [ ] 没有加载中。',
      '',
    ].join('\n');
    const problems = walkthroughProblems(doc, readme, fakeRepo());
    expect(problems.filter((problem) => problem.includes('names nothing on screen'))).toHaveLength(3);
  });

  it('reports a screenshot that is not in the repository', () => {
    const doc = [
      '### empty',
      '- 图：`docs/screenshots/gone.png`',
      '- [ ] 有 `还没有对话` 引导语。',
      '- [ ] 有 `发送之后会发生什么` 三步。',
      '- [ ] 没有 `加载中…`。',
      '',
    ].join('\n');
    const problems = walkthroughProblems(doc, readme, fakeRepo({ fileExists: () => false }));
    expect(problems).toContain(
      'docs/state-walkthrough.md: `empty` shows `docs/screenshots/gone.png`, which is not in the repository',
    );
  });

  it('every image the signature checklist names is recorded in the screenshot manifest', () => {
    // The assertion the brief asked for, stated on its own so the failure names
    // the checklist rather than a state: the ten images a signer is sent to are
    // exactly the ten `node scripts/screenshot-sources.mjs --check` hashes. If
    // one of them were missing from the manifest, that command would still print
    // PASS — about the other files — while the walker judged an image nothing
    // keeps in step with the renderer.
    expect(existsSync(MANIFEST_PATH), `missing ${MANIFEST_PATH}`).toBe(true);
    const script = scriptSection(walkthrough);
    expect(script, `no \`${SCRIPT_HEADING}\` section`).toBeDefined();
    const listed = screenshotsIn(script!);
    expect(listed).toHaveLength(STATE_SCENARIOS.length * 2);

    const untracked = listed.filter((shot) => !REPOSITORY.trackedScreenshot(shot));
    expect(
      untracked,
      `the walkthrough sends a person to image(s) \`docs/screenshots/sources.json\` does not ` +
        `record: ${untracked.join(', ')} — run \`node scripts/screenshot-sources.mjs --write\` ` +
        'after retaking them, or the check is green about a different set of files',
    ).toEqual([]);
  });

  it('reports a walkthrough image the screenshot manifest does not record', () => {
    // The red direction of the case above. Without it, the check could be
    // satisfied by a manifest that records everything and a walkthrough that
    // names nothing — the two lists would agree by both being empty.
    const problems = walkthroughProblems(
      walkthrough,
      readme,
      fakeRepo({ trackedScreenshot: () => false }),
    );
    const untracked = problems.filter((problem) => problem.includes('does not record'));
    expect(untracked, problems.join('\n')).toHaveLength(STATE_SCENARIOS.length * 2);
    expect(untracked[0]).toContain('docs/screenshots/sources.json');
    expect(untracked[0]).toContain('screenshot-sources.mjs --check');
  });

  it('reports a state that only has the wide picture', () => {
    // The defect this round exists for: five states photographed at 1440x900
    // and nowhere else, so "长中文在窄窗口是否撑破" could not be answered by
    // looking — only by trusting the geometry gate.
    const problems = walkthroughProblems(withoutTight('empty'), readme, fakeRepo());
    expect(
      problems.some(
        (problem) =>
          problem.includes('`empty` names no narrow-window screenshot') &&
          problem.includes(sizeLabel(WINDOWS.min)),
      ),
      problems.join('\n'),
    ).toBe(true);
  });

  it('reports a narrow picture that is not the smallest window', () => {
    // Both halves of the claim: the name says 768x700 and the pixels have to
    // agree. A file renamed to look narrow is the cheapest way to fake this.
    // The section's own line, not the script's row: the script is checked for
    // order separately, and renaming there would only move the image.
    const renamed = walkthrough.replace(
      '· 窄窗口：`docs/screenshots/states/empty-768x700.png`',
      '· 窄窗口：`docs/screenshots/states/empty-1024x768.png`',
    );
    const problems = walkthroughProblems(renamed, readme, fakeRepo());
    expect(
      problems.some((problem) => problem.includes('is named for 1024x768')),
      problems.join('\n'),
    ).toBe(true);

    const wrongPixels = walkthroughProblems(
      walkthrough,
      readme,
      fakeRepo({ pngSize: () => ({ width: 1024, height: 768 }) }),
    );
    expect(
      wrongPixels.some((problem) => problem.includes('the narrow picture is not narrow')),
      wrongPixels.join('\n'),
    ).toBe(true);
  });

  it('reports a five-minute script that skips an image', () => {
    const skipped = walkthrough.replace(
      '| 4 | `docs/screenshots/states/loading-768x700.png` | 768×700 | 同上，另加：两处「加载中…」都还在屏上 |\n',
      '',
    );
    expect(skipped, 'the script row this case removes is gone from the document').not.toBe(
      walkthrough,
    );
    const problems = walkthroughProblems(skipped, readme, fakeRepo());
    expect(
      problems.some((problem) => problem.includes('the five-minute script lists 9 image(s)')),
      problems.join('\n'),
    ).toBe(true);
  });

  it('reports a five-minute script that walks the images out of order', () => {
    // Order is not decoration: the script is read top to bottom by someone who
    // has five minutes, and a narrow picture listed before its wide one means
    // the walker judges the squeezed layout first and never sees the normal one.
    const swapped = walkthrough
      .replace(
        '| 1 | `docs/screenshots/empty.png` | 1440×900 | `empty` 的三条判据 |',
        '| 1 | `docs/screenshots/states/empty-768x700.png` | 768×700 | `empty` 的三条判据 |',
      )
      .replace(
        '| 2 | `docs/screenshots/states/empty-768x700.png` | 768×700 | 同上，另加：引导语与三步没有被挤到折叠线以下 |',
        '| 2 | `docs/screenshots/empty.png` | 1440×900 | 同上，另加：引导语与三步没有被挤到折叠线以下 |',
      );
    expect(swapped, 'the script rows this case swaps are gone from the document').not.toBe(
      walkthrough,
    );
    const problems = walkthroughProblems(swapped, readme, fakeRepo());
    expect(
      problems.some((problem) => problem.includes('the five-minute script lists')),
      problems.join('\n'),
    ).toBe(true);
  });

  it('reports a README that stopped admitting nobody has looked', () => {
    // The overclaim this file exists for: the table is empty, the README has
    // been reworded into "the states are covered".
    const problems = walkthroughProblems(walkthrough, readme.replace(/by eye/g, 'in the gate'), fakeRepo());
    expect(problems.some((problem) => problem.includes('English half'))).toBe(true);
  });

  it('reports a signed table the README does not carry', () => {
    // The other direction: someone walked it and signed, and the README still
    // apologises. Both halves are checked, because one of them is always the
    // one that gets forgotten.
    const signed = walkthrough.replace(
      '| — | — | — | — | — | **未走查**：判据已就位，等一个人按上面五节逐条回答 |',
      '| 2026-11-05 | 张三 | 十张 | 全满足 | 无 | 五态判据全满足 |',
    );
    const problems = walkthroughProblems(signed, readme, fakeRepo());
    expect(problems.some((problem) => problem.includes('signed on 2026-11-05'))).toBe(true);
    expect(problems.filter((problem) => problem.includes('signed on 2026-11-05'))).toHaveLength(2);
  });

  it('reports a README whose two halves carry different dates', () => {
    // The case the old check could not see. It asked "does each half carry the
    // latest date", which is the right question, but a version that asked "does
    // each half carry *a* date" would pass here — and two halves naming two
    // different days is two walkthroughs signed once, which is exactly the
    // state a reader cannot resolve. The literal has to be the same one.
    const signed = walkthrough.replace(
      '| — | — | — | — | — | **未走查**：判据已就位，等一个人按上面五节逐条回答 |',
      '| 2026-11-05 | 张三 | 十张 | 全满足 | 无 | 五态判据全满足 |',
    );
    const split = readme
      .replace(/by eye/g, 'by eye on 2026-11-05')
      .replace(/人眼/g, '人眼（2026-11-06）');
    expect(split, 'the README no longer carries both halves of the sentence').not.toBe(readme);
    const problems = walkthroughProblems(signed, split, fakeRepo());
    expect(problems, problems.join('\n')).toHaveLength(1);
    expect(problems[0]).toContain('signed on 2026-11-05');
    expect(problems[0]).toContain('zh half');
  });

  it('reports a record table that dropped the column saying how much was looked at', () => {
    // A signature over an unknown amount of looking. The ten-image script is
    // the walk; a table that does not record how many of them were opened lets
    // "signed, all satisfied" stand for five images as easily as ten.
    const narrowed = walkthrough.replace(
      '| 日期 | 走查人 | 看了哪几张 | 五态判据 | 不合格项 | 结论 |',
      '| 日期 | 走查人 | 五态判据 | 不合格项 | 结论 |',
    );
    expect(narrowed, 'the record table header this case edits is gone').not.toBe(walkthrough);
    const problems = walkthroughProblems(narrowed, readme, fakeRepo());
    expect(
      problems.some((problem) => problem.includes('日期 / 走查人 / 看了哪几张 / 结论')),
      problems.join('\n'),
    ).toBe(true);
  });

  it('accepts a signed table once the README carries the date', () => {
    // The green direction of the same rule, so the case above is not satisfied
    // by a check that always fails.
    const signed = walkthrough.replace(
      '| — | — | — | — | — | **未走查**：判据已就位，等一个人按上面五节逐条回答 |',
      '| 2026-11-05 | 张三 | 十张 | 全满足 | 无 | 五态判据全满足 |',
    );
    const dated = readme.replace(/by eye/g, 'by eye on 2026-11-05').replace(/人眼/g, '人眼（2026-11-05）');
    expect(walkthroughProblems(signed, dated, fakeRepo())).toEqual([]);
  });
});
