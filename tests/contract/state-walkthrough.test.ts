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
 *  - and that literal is *in the dictionary*. Until this round the check only
 *    asked whether a criterion quoted something in backticks, which meant a
 *    criterion could quote copy the product no longer ships and stay green:
 *    `250ddb4` rewrote the interface copy, and the walkthrough's criteria were
 *    kept in step by hand. The document says so itself — "改文案会让判据读起来
 *    对不上，那时该改的是这份文件" — and a rule that lives in a sentence is a
 *    rule that holds until the round nobody reads the sentence. Each criterion
 *    now has to quote at least one string the dictionary actually carries, so
 *    renaming `empty.title` fails this file and names the criterion that went
 *    stale. Fixture text (`[fixture:error] …`), the project name and the
 *    permission category/risk values are legitimately not dictionary copy, so
 *    the rule is "at least one", not "all of them";
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
import { walkthroughScreenshots } from '../../scripts/screenshot-sources.mjs';
// The owner/deadline parser is shared with `blocker-freshness.test.ts`: both
// documents ask "who is on the hook, and by when", and two parsers would let one
// of them drift into a shape the other gate cannot read.
import { isPlaceholderOwner, ownerLines, utcDays } from './blockers-doc.ts';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const WALKTHROUGH_PATH = join(REPO_ROOT, 'docs', 'state-walkthrough.md');
const README_PATH = join(REPO_ROOT, 'README.md');
const BOOTSTRAP_PATH = join(REPO_ROOT, 'apps', 'desktop', 'src', 'main', 'bootstrap.ts');
const MANIFEST_PATH = join(REPO_ROOT, 'docs', 'screenshots', 'sources.json');
const I18N_PATH = join(REPO_ROOT, 'apps', 'desktop', 'src', 'shared', 'i18n.ts');

/** The fewest criteria a state may carry and still be a walkthrough. */
const MIN_CRITERIA = 3;

/** A screenshot a section points at, e.g. `docs/screenshots/states/loading.png`. */
const SCREENSHOT = /docs\/screenshots\/[\w./-]+\.png/g;

/** Every backticked literal in a criterion, without the backticks. */
const LITERALS = /`([^`\n]+)`/g;

/**
 * Backticked words that are identifiers rather than prose.
 *
 * The same short list `ui-copy.test.ts` keeps for the same reason: `UCAD` is the
 * product's name and `ctx` is a token the interface shows verbatim, so neither
 * is copy the dictionary could carry. Everything else a criterion quotes has to
 * be a string the product ships — a fixture's failure text and the permission
 * category/risk values are the two legitimate exceptions, and they are covered
 * by the rule being "at least one literal is dictionary copy" rather than "all
 * of them are".
 */
const NON_PROSE_LITERALS = new Set(['UCAD', 'ctx']);

/**
 * What makes a backticked literal *prose*: a Han character, or a space.
 *
 * The distinction is what keeps the rule honest in both directions. `jev-pi-agent`
 * is a project name, `SHELL` and `high` are a permission category and risk level,
 * `UCAD` and `ctx` are the product's name and a token — none of them is copy the
 * dictionary could carry, and a criterion that names one of them is still naming
 * something a walker can find on screen. A literal with a Han character or a
 * space is a sentence the interface says, and the interface's sentences live in
 * `i18n.ts`.
 */
const PROSE_LITERAL = /[\u3400-\u9fff]|\s/;

/** A dated record row, i.e. a signature. */
const SIGNED_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The narrow-window screenshot's name, which carries the size it was taken at. */
const TIGHT_NAME = /-(\d+)x(\d+)\.png$/;

/** The heading the five-minute script lives under. */
const SCRIPT_HEADING = '## 5 分钟走查脚本';

/**
 * The heading of the handover section: how the ten images reach a person who
 * has not installed the app.
 *
 * The walkthrough has been answerable from a distance since the criteria were
 * written, and the one step that was never written down is the step that makes
 * it remote: getting the ten files to the person. "Send them the images" is not
 * an instruction — the ten paths live in a table, and a handover that copies
 * them by hand loses one, which is a state that was never walked and a row that
 * still reads "all satisfied".
 */
const HANDOFF_HEADING = '## 怎么把十张图 + 判据发给一个没装应用的人';

/** The command that lists the ten images, as the handover section spells it. */
const HANDOFF_COMMAND = 'node scripts/screenshot-sources.mjs --walkthrough';

/** The one command that turns that list into something sendable. */
const HANDOFF_PACK = `tar -czf walkthrough.tar.gz $(${HANDOFF_COMMAND})`;

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
  /**
   * Every string the interface dictionary ships, in both locales.
   *
   * The criteria quote the copy a walker will look for on screen, and the copy
   * lives in `i18n.ts`. Comparing the two is what turns "the criteria are kept
   * in step with the copy by hand" into a red run: a renamed string leaves the
   * criterion quoting something no screen shows any more.
   */
  readonly dictionary: readonly string[];
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
 * Every string the interface dictionary ships, in both locales.
 *
 * Read out of `i18n.ts` rather than imported, for the same reason the window
 * sizes are read out of `bootstrap.ts`: the question is whether the criteria
 * quote the copy the product ships, and importing a copy of the dictionary
 * would answer a different question. Both dictionary blocks are parsed, so a
 * criterion anchored to a string that exists in either language counts — the
 * walkthrough is written in Chinese, and the two halves of the README are
 * compared by `readme-parity.test.ts`, not here.
 *
 * Values may be single- or double-quoted, and may sit on the line after their
 * key (`'terminal.distinct':` then the string), which is why the pattern allows
 * whitespace — newlines included — between the two.
 */
function dictionaryValues(): string[] {
  const source = readFileSync(I18N_PATH, 'utf8');
  const values: string[] = [];
  for (const name of ['zhCN', 'enUS']) {
    const start = source.indexOf(`const ${name}: Dictionary = {`);
    expect(start, `i18n.ts no longer declares ${name}`).toBeGreaterThan(-1);
    const end = source.indexOf('\n};', start);
    expect(end, `i18n.ts no longer closes ${name}`).toBeGreaterThan(start);
    const block = source.slice(start, end);
    for (const match of block.matchAll(
      /'[^'\n]+':\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/gs,
    )) {
      values.push((match[1] ?? match[2] ?? '').replace(/\\(['"\\])/g, '$1'));
    }
  }
  expect(values.length, 'no dictionary value was read out of i18n.ts').toBeGreaterThan(0);
  return values;
}

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

/** The body of the handover section, or `undefined` when it is gone. */
function handoffSection(markdown: string): string | undefined {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => line.trim() === HANDOFF_HEADING);
  if (start === -1) return undefined;
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,2} /.test(line)) break;
    body.push(line);
  }
  return body.join('\n');
}

/**
 * Every way the handover section stops being something a stranger can follow.
 *
 * `listed` is what `node scripts/screenshot-sources.mjs --walkthrough` prints
 * today, so the section and the command are compared rather than assumed to
 * agree: a section that tells the reader to run a command whose output is not
 * the ten images is a handover that ships the wrong files, and the reader has
 * no second list to check it against.
 */
function handoffProblems(
  markdown: string,
  repository: Repository,
  listed: readonly string[],
): string[] {
  const problems: string[] = [];
  const section = handoffSection(markdown);
  if (section === undefined) {
    return [
      `docs/state-walkthrough.md: no \`${HANDOFF_HEADING}\` section, so the ten images have ` +
        'no way to reach a person who has not installed the app',
    ];
  }

  if (!section.includes(HANDOFF_COMMAND)) {
    problems.push(
      `docs/state-walkthrough.md: the handover section no longer names \`${HANDOFF_COMMAND}\`, ` +
        'so the reader is back to copying ten paths out of a table by hand',
    );
  }
  if (!section.includes(HANDOFF_PACK)) {
    problems.push(
      `docs/state-walkthrough.md: the handover section no longer names \`${HANDOFF_PACK}\`, ` +
        'so "send the images" is an instruction with no command behind it',
    );
  }
  // The three things that have to travel together: the images, the criteria,
  // and the row the answer comes back in. One of them missing is a handover
  // that ends in a question nobody can answer or an answer nobody can file.
  for (const [what, literal] of [
    ['the criteria section', '`## 判据`'],
    ['the record row template', '| YYYY-MM-DD |'],
    ['the fact that the reader needs no app', '不需要装应用'],
  ] as const) {
    if (!section.includes(literal)) {
      problems.push(
        `docs/state-walkthrough.md: the handover section does not name ${what} ` +
          `(\`${literal}\`), so the pack it describes is incomplete`,
      );
    }
  }

  /*
   * The third thing that travels: the row the answer comes back in.
   *
   * The images are checked against the script table and the manifest, and the
   * criteria against the dictionary. The receipt was the one part of the
   * handover that was still prose — "他答完照着填，把这一行发回来" — so the
   * columns a remote walker fills were whatever the sender remembered, and the
   * person filing the answer had to guess which cell meant what. The template
   * is a table now, and its header has to be the record table's header cell for
   * cell: sending and receiving are the same fact, or the answer arrives in a
   * shape the record cannot hold.
   */
  const record = recordHeaderCells(markdown);
  const template = receiptTemplate(markdown);
  if (record === undefined) {
    problems.push(
      `docs/state-walkthrough.md: no \`${RECORD_HEADING}\` table, so the receipt template ` +
        'has no columns to match',
    );
  } else if (template === undefined) {
    problems.push(
      'docs/state-walkthrough.md: the handover section carries no receipt template ' +
        '(`| YYYY-MM-DD | …`), so the answer comes back in whatever shape the walker invents',
    );
  } else if (template.header === null) {
    problems.push(
      'docs/state-walkthrough.md: the receipt template has no header row, so the walker is ' +
        'filling cells whose names only the sender knows',
    );
  } else if (template.header.join('|') !== record.join('|')) {
    problems.push(
      `docs/state-walkthrough.md: the receipt template's columns are ` +
        `\`${template.header.join(' | ')}\` and the record table's are ` +
        `\`${record.join(' | ')}\` — the row a walker sends back has to be the row the ` +
        'record table can hold, so fix whichever of the two moved',
    );
  } else if (template.row.length !== record.length) {
    problems.push(
      `docs/state-walkthrough.md: the receipt template's placeholder row has ` +
        `${template.row.length} cell(s) and its header has ${record.length}, so a walker ` +
        'copying it fills a row that does not line up with the columns',
    );
  }

  for (const shot of new Set(screenshotsIn(section))) {
    if (repository.trackedScreenshot(shot)) continue;
    problems.push(
      `docs/state-walkthrough.md: the handover section names \`${shot}\`, which ` +
        '`docs/screenshots/sources.json` does not record — the pack would ship a picture no ' +
        'gate keeps honest',
    );
  }

  if (listed.length === 0) {
    problems.push(
      `docs/state-walkthrough.md: \`${HANDOFF_COMMAND}\` lists no image, so the handover ` +
        'section describes a command that hands over nothing',
    );
  }
  return problems;
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

/** The heading the record table lives under. */
const RECORD_HEADING = '## 记录';

/** A markdown table's separator row: `|---|---|`. */
const TABLE_SEPARATOR = /^\|[\s:|-]+\|$/;

/** The cells of a markdown table row, trimmed and without the outer pipes. */
function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

/**
 * The body of the level-2 section whose heading starts with `heading`.
 *
 * `## 记录（走查人填，只追加）` carries a parenthetical, so the heading is
 * matched by prefix rather than by equality — the same reason `scriptSection`
 * and `handoffSection` exist, generalised so the record table can be read
 * without a fourth copy of the same loop.
 */
function sectionBody(markdown: string, heading: string): string | undefined {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => line.trim().startsWith(heading));
  if (start === -1) return undefined;
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,2} /.test(line)) break;
    body.push(line);
  }
  return body.join('\n');
}

/**
 * The record table's header cells, or `undefined` when the table is gone.
 *
 * Read from the `## 记录` section rather than from the whole document, because
 * the handover section now carries a copy of the same header (the receipt
 * template). A scan over the whole file would find the template's header and
 * call the record table intact after the record table itself lost a column —
 * two lists that are supposed to be one, agreeing by accident.
 */
function recordHeaderCells(markdown: string): string[] | undefined {
  const body = sectionBody(markdown, RECORD_HEADING);
  if (body === undefined) return undefined;
  const header = body.split('\n').find((line) => line.trim().startsWith('|'));
  return header === undefined ? undefined : cells(header);
}

/**
 * The document with the record table's header row replaced.
 *
 * The header line now appears twice — once in the record table, once in the
 * receipt template the handover section carries — so a plain `String.replace`
 * edits whichever comes first, which is the template. A case that means "the
 * record table lost a column" has to say so, or it tests the template instead
 * and passes for the wrong reason.
 */
function withRecordHeader(markdown: string, header: string): string {
  const at = markdown.indexOf(RECORD_HEADING);
  if (at === -1) return markdown;
  const head = markdown.slice(0, at);
  const tail = markdown.slice(at);
  const line = tail.split('\n').find((candidate) => candidate.trim().startsWith('|'));
  if (line === undefined) return markdown;
  return head + tail.replace(line, header);
}

/** The receipt template a remote walker fills in and sends back. */
interface ReceiptTemplate {
  /** The template's column names, or `null` when the header row is missing. */
  readonly header: string[] | null;
  /** The placeholder row: one cell per column, `YYYY-MM-DD` first. */
  readonly row: string[];
}

/**
 * The receipt template in the handover section.
 *
 * The handover sends three things: the images, the criteria, and the row the
 * answer comes back in. The first two are already checked against the document
 * they come from (`--walkthrough` reads the script table, the criteria are
 * compared with the dictionary). The third was prose — "他答完照着填，把这一行
 * 发回来" — and a row that is copied out of a sentence is a row whose columns
 * are whatever the sender remembered. So the template is a table now, and its
 * header has to be the record table's header, cell for cell: the person who
 * fills it in and the person who files it are reading the same six words.
 */
function receiptTemplate(markdown: string): ReceiptTemplate | undefined {
  const section = handoffSection(markdown);
  if (section === undefined) return undefined;
  const lines = section.split('\n');
  const start = lines.findIndex((line) => line.trim().startsWith('| YYYY-MM-DD |'));
  if (start === -1) return undefined;
  const row = cells(lines[start]!);
  let header: string[] | null = null;
  for (let i = start - 1; i >= 0; i -= 1) {
    const line = lines[i]!.trim();
    if (TABLE_SEPARATOR.test(line)) continue;
    if (!line.startsWith('|')) break;
    header = cells(line);
    break;
  }
  return { header, row };
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
 * One row of the five-minute script's table: `| 1 | `path` | 1440×900 | … |`.
 *
 * The size is written the way a person writes it (`×`, or `x` in a hurry), and
 * the row number is required so a prose line that happens to carry a path and a
 * size is not read as a table row.
 */
const SIZE_ROW = /^\|\s*\d+\s*\|\s*`(docs\/screenshots\/[^`]+\.png)`\s*\|\s*(\d+)\s*[×x]\s*(\d+)\s*\|/;

/**
 * The size the script table claims for each picture, against the picture.
 *
 * `pictureProblems` reads the *sections* — "this state has a wide picture and a
 * narrow one, and each is the size the product opens at". It says nothing about
 * the table, which is the part a walker actually reads: a row that says
 * `1440×900` next to a 768×700 file was green, and the person who opened the
 * image expecting a wide window was told the wrong thing about the thing they
 * were judging. The claim and the file are two facts; this compares them.
 */
function sizeClaimProblems(script: string, repository: Repository): string[] {
  const problems: string[] = [];
  for (const line of script.split('\n')) {
    const row = SIZE_ROW.exec(line.trim());
    if (row === null) continue;
    const shot = row[1]!;
    const claimed = { width: Number(row[2]), height: Number(row[3]) };
    const actual = repository.pngSize(shot);
    if (actual === null) {
      problems.push(
        `docs/state-walkthrough.md: the script table lists \`${shot}\`, which is not a PNG`,
      );
      continue;
    }
    if (actual.width === claimed.width && actual.height === claimed.height) continue;
    problems.push(
      `docs/state-walkthrough.md: the script table says \`${shot}\` is ${sizeLabel(claimed)} ` +
        `and the picture is ${sizeLabel(actual)} — a walker opening it is told the wrong size`,
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
      const literals = [...item.matchAll(LITERALS)].map((match) => match[1]!);
      if (literals.length === 0) {
        problems.push(
          `docs/state-walkthrough.md: a \`${state}\` criterion names nothing on screen ` +
            `(${JSON.stringify(item.slice(0, 48))}); anchor it to a literal a walker can find`,
        );
        continue;
      }
      /*
       * The literal has to be copy the product ships.
       *
       * "Quotes something in backticks" was the whole check until this round,
       * and it is satisfied by a criterion quoting a string that was renamed
       * two rounds ago — the walker then looks for text no screen shows and
       * answers "否" about a screen that is correct. The dictionary is the only
       * list of what the interface actually says, so a criterion has to name at
       * least one of its strings. Fixture failure text, the project name and
       * the permission category/risk values are not dictionary copy, which is
       * why the rule is "at least one" rather than "all of them".
       */
      const prose = literals.filter(
        (literal) => !NON_PROSE_LITERALS.has(literal) && PROSE_LITERAL.test(literal),
      );
      // Identifiers only: the criterion names something on screen that is not a
      // sentence, so there is no copy for the dictionary to carry.
      if (prose.length === 0) continue;
      const anchored = prose.filter((literal) =>
        repository.dictionary.some((value) => value.includes(literal)),
      );
      if (anchored.length > 0) continue;
      problems.push(
        `docs/state-walkthrough.md: a \`${state}\` criterion quotes ` +
          `${prose.map((literal) => `\`${literal}\``).join(' / ')}, and none of them is ` +
          'copy `apps/desktop/src/shared/i18n.ts` ships — the criterion is pointing a walker ' +
          'at a screen that no longer exists, so fix the criterion (or the copy), not the gate',
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

  const record = recordHeaderCells(walkthrough);
  if (record === undefined) {
    problems.push(
      `docs/state-walkthrough.md: no \`${RECORD_HEADING}\` table, so a walkthrough has ` +
        'nowhere to be signed',
    );
  } else if (!RECORD_COLUMNS.every((column) => record.includes(column))) {
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

/** The dictionary, read once: every criterion is compared against the same list. */
const DICTIONARY = dictionaryValues();

const REPOSITORY: Repository = {
  fileExists: (relativePath) => existsSync(join(REPO_ROOT, relativePath)),
  pngSize: (relativePath) => {
    const full = join(REPO_ROOT, relativePath);
    return existsSync(full) ? pngSize(readFileSync(full)) : null;
  },
  trackedScreenshot: (relativePath) => TRACKED_SHOTS.has(relativePath),
  dictionary: DICTIONARY,
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
    dictionary: DICTIONARY,
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

  it('the size the script table claims for each picture is the picture', () => {
    // The table is what a walker reads before opening an image, so its `尺寸`
    // column is a claim about a file, not a caption. Ten rows, because the walk
    // is five states at two sizes — a table that declares a size for nine of
    // them has one row a reader has to guess at.
    const script = scriptSection(walkthrough);
    expect(script, `no \`${SCRIPT_HEADING}\` section`).toBeDefined();
    const rows = script!.split('\n').filter((line) => SIZE_ROW.test(line.trim()));
    expect(rows, 'the script table declares a size for every picture').toHaveLength(
      STATE_SCENARIOS.length * 2,
    );
    expect(sizeClaimProblems(script!, REPOSITORY)).toEqual([]);
  });

  it('names the picture whose declared size is not its size', () => {
    // The red direction, driven on a repository that answers 1024x768 for
    // everything: every row is wrong, and the sentence names the file and both
    // numbers rather than saying "the table is stale".
    const problems = sizeClaimProblems(
      scriptSection(walkthrough)!,
      fakeRepo({ pngSize: () => ({ width: 1024, height: 768 }) }),
    );
    expect(problems).toHaveLength(STATE_SCENARIOS.length * 2);
    expect(problems[0]).toContain('docs/screenshots/empty.png');
    expect(problems[0]).toContain('1024x768');
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

  it('reports a criterion quoting copy the dictionary no longer ships', () => {
    // The red direction of the anchor rule, driven without editing `i18n.ts`:
    // the dictionary is a parameter, so a case can hand the check a list that
    // has lost one string and watch the criteria that quote it go red. This is
    // the shape `250ddb4` left behind — the copy was rewritten and the criteria
    // were kept in step by hand, because nothing compared the two.
    //
    // `empty.chat` is the string two criteria quote: the first-run criterion
    // quotes it whole, and the loading criterion quotes the first half of it to
    // say what must *not* be on screen. Renaming it therefore breaks both, and
    // the failure names both — which is the point: one renamed string can leave
    // two questions pointing at a screen that no longer exists.
    const renamed = DICTIONARY.filter((value) => !value.includes('在下面说清要做什么'));
    expect(renamed.length, 'the dictionary no longer carries empty.chat').toBeLessThan(
      DICTIONARY.length,
    );
    const problems = walkthroughProblems(walkthrough, readme, fakeRepo({ dictionary: renamed }));
    expect(problems, problems.join('\n')).toHaveLength(2);
    expect(problems.some((problem) => problem.includes('a `empty` criterion quotes'))).toBe(true);
    expect(problems.some((problem) => problem.includes('a `loading` criterion quotes'))).toBe(true);
    expect(problems[0]).toContain('apps/desktop/src/shared/i18n.ts');
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
    const narrowed = withRecordHeader(
      walkthrough,
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

/** The heading of the answer sheet: ten images, three questions each. */
const QUICK_HEADING = '## 10 分钟速查表：十张图 × 三问';

/** The heading of the section that says who is supposed to sign. */
const UNSIGNED_HEADING = '## 还没有人签';

/** One row of the answer sheet: `| 7 | `path` | question | 是 / 否 / 说不清 |`. */
const QUICK_ROW = /^\|\s*(\d+)\s*\|\s*`(docs\/screenshots\/[^`]+\.png)`\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|$/;

/** The only three answers the sheet accepts. */
const QUICK_ANSWER = '是 / 否 / 说不清';

/** The sentence that makes 「说不清」 a failure rather than a shrug. */
const UNSURE_RULE = '答「说不清」按**未过**算';

/** The shortest question that can still be a question rather than a word. */
const MIN_QUESTION = 6;

/**
 * Prose with the markdown emphasis removed and the wrapping collapsed.
 *
 * The criteria are written with `**…**` around the load-bearing half and are
 * wrapped across lines; the answer sheet quotes them as plain sentences. Both
 * sides are normalised the same way, so the comparison is about the words and
 * not about where a line happened to break.
 */
function normalizeProse(text: string): string {
  return text.replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
}

/** One row of the answer sheet, as read. */
interface QuickRow {
  readonly number: number;
  readonly shot: string;
  readonly question: string;
  readonly answer: string;
}

/** The answer sheet's rows, in document order. */
function quickRows(section: string): QuickRow[] {
  const rows: QuickRow[] = [];
  for (const line of section.split('\n')) {
    const match = QUICK_ROW.exec(line.trim());
    if (match === null) continue;
    rows.push({
      number: Number(match[1]),
      shot: match[2]!,
      question: match[3]!,
      answer: match[4]!,
    });
  }
  return rows;
}

/**
 * Every way the answer sheet stops being the criteria, asked of the images.
 *
 * The walkthrough has had fifteen criteria and a ten-image script for several
 * rounds, and the two were only ever joined by a sentence: "每张图回答它那一态
 * 的三条判据". A signer therefore had to hold three criteria in their head while
 * looking at an image, and a criterion that changed left the sheet saying
 * something the criteria no longer said — with nothing to notice it.
 *
 * The sheet is the join, written down: thirty rows, one question each, and every
 * question has to be a phrase from the criterion it claims to be asking. That is
 * what makes "the table and the criteria are one source" a red run instead of a
 * promise, and it is why the questions are quoted rather than paraphrased.
 */
function quickProblems(markdown: string, repository: Repository): string[] {
  const problems: string[] = [];
  const body = sectionBody(markdown, QUICK_HEADING);
  if (body === undefined) {
    return [
      `docs/state-walkthrough.md: no \`${QUICK_HEADING}\` section, so a signer is back to ` +
        'holding three criteria in their head while looking at an image',
    ];
  }
  if (!body.includes(UNSURE_RULE)) {
    problems.push(
      `docs/state-walkthrough.md: the answer sheet no longer says ${UNSURE_RULE} — without it ` +
        '「说不清」 reads as a third kind of answer instead of a failure',
    );
  }

  // The order the sheet has to follow: state by state, wide image then narrow,
  // three questions each. Read from the state sections rather than restated, so
  // a state that gains a picture moves the sheet with it.
  const found = sections(markdown);
  const expected: Array<{ state: string; shot: string; criterion: string }> = [];
  for (const state of STATE_SCENARIOS) {
    const section = found.get(state);
    if (section === undefined) continue;
    const shots = [...new Set(screenshotsIn(section))];
    const wide = shots.find((shot) => !TIGHT_NAME.test(shot));
    const tight = shots.find((shot) => TIGHT_NAME.test(shot));
    const items = checklistItems(section);
    for (const shot of [wide, tight]) {
      if (shot === undefined) continue;
      for (const criterion of items) expected.push({ state, shot, criterion });
    }
  }

  const rows = quickRows(body);
  if (rows.length !== expected.length) {
    problems.push(
      `docs/state-walkthrough.md: the answer sheet has ${rows.length} row(s) and the walk is ` +
        `${expected.length} (${STATE_SCENARIOS.length} states × 2 sizes × 3 criteria) — a sheet ` +
        'with a row missing is a question nobody answers',
    );
  }

  for (const [index, row] of rows.entries()) {
    const want = expected[index];
    if (want === undefined) {
      problems.push(
        `docs/state-walkthrough.md: the answer sheet has a row ${row.number} beyond the walk ` +
          `(${row.shot}), so it asks about an image the script does not send anyone to`,
      );
      continue;
    }
    if (row.shot !== want.shot) {
      problems.push(
        `docs/state-walkthrough.md: answer sheet row ${row.number} is about \`${row.shot}\` and ` +
          `the walk order says \`${want.shot}\` — the sheet and the five-minute script ` +
          'disagree about which image comes next',
      );
      continue;
    }
    if (row.answer !== QUICK_ANSWER) {
      problems.push(
        `docs/state-walkthrough.md: answer sheet row ${row.number} offers \`${row.answer}\` as ` +
          `its answers; the only three are \`${QUICK_ANSWER}\``,
      );
    }
    if (row.question.length < MIN_QUESTION) {
      problems.push(
        `docs/state-walkthrough.md: answer sheet row ${row.number} asks ` +
          `\`${row.question}\`, which is too short to be the criterion it claims to be`,
      );
      continue;
    }
    if (!normalizeProse(want.criterion).includes(normalizeProse(row.question))) {
      problems.push(
        `docs/state-walkthrough.md: answer sheet row ${row.number} asks ` +
          `\`${row.question}\`, which is not a phrase from the \`${want.state}\` criterion it ` +
          'is supposed to be asking — the criteria moved and the sheet did not',
      );
    }
    if (!repository.fileExists(row.shot)) {
      problems.push(
        `docs/state-walkthrough.md: answer sheet row ${row.number} points at \`${row.shot}\`, ` +
          'which is not in the repository',
      );
    }
  }
  return problems;
}

/**
 * Every way the walkthrough stops naming who is supposed to sign it.
 *
 * The page has said "等一个人" for several rounds, which is a role: nobody can be
 * asked whether they have done it. The owner line is the same shape the blockers
 * page uses, parsed by the same function, so the two documents cannot drift into
 * two spellings of "who is on the hook".
 */
function signerProblems(markdown: string): string[] {
  const body = sectionBody(markdown, UNSIGNED_HEADING);
  if (body === undefined) {
    return [
      `docs/state-walkthrough.md: no \`${UNSIGNED_HEADING}\` section, so the page says nobody ` +
        'has signed without saying who is supposed to',
    ];
  }
  const owners = ownerLines(body);
  if (owners.length === 0) {
    return [
      'docs/state-walkthrough.md: the unsigned section carries no **责任人** line, so "等一个人" ' +
        'is still a role rather than a person',
    ];
  }
  if (owners.length > 1) {
    return [
      `docs/state-walkthrough.md: the unsigned section carries ${owners.length} **责任人** lines; ` +
        'one walkthrough has one signer',
    ];
  }
  const [owner] = owners as [ReturnType<typeof ownerLines>[number]];
  const problems: string[] = [];
  if (isPlaceholderOwner(owner.owner)) {
    problems.push(
      `docs/state-walkthrough.md: the unsigned section names \`${owner.owner}\` as its 责任人, ` +
        'which is a role or a placeholder rather than a person',
    );
  }
  if (owner.deadline.length === 0) {
    problems.push(
      'docs/state-walkthrough.md: the unsigned section names a 责任人 without a **截止** date, ' +
        'so "before the defence" is the only thing the reader can hold them to',
    );
  } else if (utcDays(owner.deadline) === null) {
    problems.push(
      `docs/state-walkthrough.md: the unsigned section writes 截止 as \`${owner.deadline}\`, ` +
        'which is not a real `YYYY-MM-DD` day on the calendar',
    );
  }
  return problems;
}

describe('the walkthrough is a form somebody can fill in ten minutes', () => {
  it('the answer sheet asks the criteria, of the ten images, in walk order', () => {
    // Thirty rows: five states, two sizes, three criteria. The questions are
    // quoted from the criteria rather than paraphrased, so this case is what
    // makes "the table and the criteria are one source" a red run.
    const problems = quickProblems(walkthrough, REPOSITORY);
    expect(
      problems,
      `the answer sheet and the criteria disagree:\n  ${problems.join('\n  ')}`,
    ).toEqual([]);
    const body = sectionBody(walkthrough, QUICK_HEADING);
    expect(body, `no \`${QUICK_HEADING}\` section`).toBeDefined();
    expect(quickRows(body!)).toHaveLength(STATE_SCENARIOS.length * 2 * 3);
  });

  it('reports a question the criteria no longer say', () => {
    // The drift this sheet exists to catch: a criterion is reworded, the sheet
    // keeps asking the old question, and the signer answers a question the
    // document no longer asks.
    const drifted = walkthrough.replace(
      '| 1 | `docs/screenshots/empty.png` | 引导语在折叠线以上，且比周围文字更醒目 |',
      '| 1 | `docs/screenshots/empty.png` | 引导语要够醒目 |',
    );
    expect(drifted, 'the answer sheet row this case edits is gone').not.toBe(walkthrough);
    const problems = quickProblems(drifted, REPOSITORY);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('is not a phrase from the `empty` criterion');
  });

  it('reports a sheet that skips a row, and one that walks the images out of order', () => {
    const skipped = walkthrough.replace(
      '| 4 | `docs/screenshots/states/empty-768x700.png` | 引导语在折叠线以上，且比周围文字更醒目 | 是 / 否 / 说不清 |\n',
      '',
    );
    expect(skipped, 'the answer sheet row this case removes is gone').not.toBe(walkthrough);
    // The count is reported first, and every row after the gap is then off by
    // one — which is the point: a missing row is not one unanswered question,
    // it is every question below it answered about the wrong image.
    const missing = quickProblems(skipped, REPOSITORY);
    expect(missing[0]).toContain('the answer sheet has 29 row(s)');
    expect(missing.length).toBeGreaterThan(1);

    // Same rows, two of them swapped: the count is right and the order is not,
    // which is the failure a count alone cannot see.
    const swapped = walkthrough
      .replace(
        '| 1 | `docs/screenshots/empty.png` | 引导语在折叠线以上，且比周围文字更醒目 | 是 / 否 / 说不清 |',
        '| 1 | `docs/screenshots/states/empty-768x700.png` | 引导语在折叠线以上，且比周围文字更醒目 | 是 / 否 / 说不清 |',
      )
      .replace(
        '| 4 | `docs/screenshots/states/empty-768x700.png` | 引导语在折叠线以上，且比周围文字更醒目 | 是 / 否 / 说不清 |',
        '| 4 | `docs/screenshots/empty.png` | 引导语在折叠线以上，且比周围文字更醒目 | 是 / 否 / 说不清 |',
      );
    expect(swapped, 'the answer sheet rows this case swaps are gone').not.toBe(walkthrough);
    const outOfOrder = quickProblems(swapped, REPOSITORY);
    expect(outOfOrder.some((problem) => problem.includes('the walk order says'))).toBe(true);
  });

  it('reports a fourth answer, and a sheet that dropped the 说不清 rule', () => {
    // 「说不清」 is the answer that has to count as a failure. A sheet that
    // offers 「还行」 instead is a sheet that lets a shrug be filed as a pass.
    const fourth = walkthrough.replace(
      '| 2 | `docs/screenshots/empty.png` | 一眼能数出三步，读完知道第一步要做什么 | 是 / 否 / 说不清 |',
      '| 2 | `docs/screenshots/empty.png` | 一眼能数出三步，读完知道第一步要做什么 | 是 / 否 / 还行 |',
    );
    expect(fourth, 'the answer sheet row this case edits is gone').not.toBe(walkthrough);
    expect(quickProblems(fourth, REPOSITORY)).toEqual([
      expect.stringContaining('the only three are'),
    ]);

    const shrug = walkthrough.replace(UNSURE_RULE, '答「说不清」也算看过');
    expect(shrug, 'the 说不清 rule this case edits is gone').not.toBe(walkthrough);
    expect(quickProblems(shrug, REPOSITORY)).toEqual([
      expect.stringContaining('no longer says'),
    ]);
  });

  it('reports a sheet that is gone altogether', () => {
    const problems = quickProblems(
      walkthrough.replace(QUICK_HEADING, '## 走查表'),
      REPOSITORY,
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(QUICK_HEADING);
  });

  it('names the person who is supposed to sign, and the day they committed to', () => {
    // The page said "等一个人" for several rounds. A role cannot be asked
    // whether it has looked, so the section names a person and a date — the
    // same shape the blockers page uses, parsed by the same function.
    expect(signerProblems(walkthrough)).toEqual([]);
    const body = sectionBody(walkthrough, UNSIGNED_HEADING);
    expect(body, `no \`${UNSIGNED_HEADING}\` section`).toBeDefined();
    const [owner] = ownerLines(body!) as ReturnType<typeof ownerLines>;
    expect(owner, 'the unsigned section has no 责任人 line').toBeDefined();
    expect(isPlaceholderOwner(owner.owner)).toBe(false);
    expect(utcDays(owner.deadline)).not.toBeNull();
  });

  it('reports a role where a name belongs, and a deadline that is not a day', () => {
    const role = walkthrough.replace(
      '- **责任人**：castorhrio ｜ **截止**：2026-11-19',
      '- **责任人**：仓库所有者 ｜ **截止**：2026-11-19',
    );
    expect(role, 'the owner line this case edits is gone').not.toBe(walkthrough);
    expect(signerProblems(role)).toEqual([
      expect.stringContaining('is a role or a placeholder rather than a person'),
    ]);

    const undated = walkthrough.replace(
      '- **责任人**：castorhrio ｜ **截止**：2026-11-19',
      '- **责任人**：castorhrio',
    );
    expect(signerProblems(undated)).toEqual([
      expect.stringContaining('without a **截止** date'),
    ]);

    const impossible = walkthrough.replace('**截止**：2026-11-19', '**截止**：2026-02-30');
    expect(signerProblems(impossible)).toEqual([
      expect.stringContaining('writes 截止 as `2026-02-30`'),
    ]);
  });
});

/**
 * The handover: the ten images, the fifteen questions, and the row that comes back.
 *
 * The walkthrough has been answerable from a distance since the criteria were
 * written — the document says so itself, in the "只有图" half of 怎么走. What it
 * never said is how the images get to the person answering, and that is the one
 * step where a remote walkthrough quietly loses a state: ten paths in a table,
 * copied by hand, is nine images and a row that still reads "all satisfied".
 *
 * So the section is checked against the command it names, and the command is
 * checked against the document it reads. Neither half alone is enough: a
 * section naming a command that prints something else is a pack of the wrong
 * files, and a command whose list nobody sends is a list nobody uses.
 */
describe('the ten images can be handed to somebody who has not installed the app', () => {
  it('the handover section is there, and names the command, the pack and the row', () => {
    const problems = handoffProblems(walkthrough, REPOSITORY, walkthroughScreenshots());
    expect(
      problems,
      `the handover section and the command disagree:\n  ${problems.join('\n  ')}`,
    ).toEqual([]);
  });

  it('the command lists exactly the ten images the five-minute script walks', () => {
    // The list is read from the document by the command, so this is the check
    // that the reading works: a parser that returned nine paths would leave the
    // section green and the pack one image short.
    const script = scriptSection(walkthrough);
    expect(script, `no \`${SCRIPT_HEADING}\` section`).toBeDefined();
    const listed = walkthroughScreenshots();
    expect(listed).toEqual(screenshotsIn(script!));
    expect(listed).toHaveLength(STATE_SCENARIOS.length * 2);
    for (const shot of listed) {
      expect(TRACKED_SHOTS.has(shot), `${shot} is not in sources.json`).toBe(true);
    }
  });

  it('reports the section being deleted', () => {
    const problems = handoffProblems(
      walkthrough.replace(HANDOFF_HEADING, '## 怎么把图发出去'),
      REPOSITORY,
      walkthroughScreenshots(),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(HANDOFF_HEADING);
  });

  it('reports a renamed command, and a pack line that lost its command', () => {
    const renamed = handoffProblems(
      walkthrough.replaceAll(HANDOFF_COMMAND, 'node scripts/screenshot-sources.mjs --list'),
      REPOSITORY,
      walkthroughScreenshots(),
    );
    expect(renamed.some((problem) => problem.includes(HANDOFF_COMMAND))).toBe(true);

    const unpacked = handoffProblems(
      walkthrough.replace(HANDOFF_PACK, 'tar -czf walkthrough.tar.gz docs/screenshots'),
      REPOSITORY,
      walkthroughScreenshots(),
    );
    expect(unpacked.some((problem) => problem.includes(HANDOFF_PACK))).toBe(true);
  });

  it('reports a pack that would ship an image no gate keeps honest', () => {
    const withGhost = walkthrough.replace(
      HANDOFF_PACK,
      `${HANDOFF_PACK}\n\n另附 \`docs/screenshots/states/ghost.png\`。`,
    );
    expect(withGhost, 'the pack line this case edits is gone').not.toBe(walkthrough);
    const problems = handoffProblems(
      withGhost,
      fakeRepo({ trackedScreenshot: () => false }),
      walkthroughScreenshots(),
    );
    expect(problems.some((problem) => problem.includes('ghost.png'))).toBe(true);
  });

  it('the receipt template carries the record table\'s columns, cell for cell', () => {
    // The third thing that travels with the images and the criteria. The
    // template is what a remote walker fills in, and the record table is where
    // the answer is filed; if the two disagree about the columns, the answer
    // arrives in a shape the record cannot hold and the person filing it has to
    // guess which cell meant what.
    const record = recordHeaderCells(walkthrough);
    expect(record, `no \`${RECORD_HEADING}\` table header`).toBeDefined();
    const template = receiptTemplate(walkthrough);
    expect(template, 'the handover section carries no receipt template').toBeDefined();
    expect(template!.header, 'the receipt template has no header row').not.toBeNull();
    expect(
      template!.header,
      'the receipt template and the record table name different columns',
    ).toEqual(record);
    expect(
      template!.row,
      'the receipt template\'s placeholder row does not fill every column',
    ).toHaveLength(record!.length);
  });

  it('reports a receipt template whose columns drifted from the record table', () => {
    // The red direction, and the reason this is a gate rather than a sentence:
    // renaming one column in the template is a one-word edit that leaves the
    // walker filling a cell the record table does not have.
    const drifted = walkthrough.replace(
      '| 日期 | 走查人 | 看了哪几张 | 五态判据 | 不合格项 | 结论 |\n|---|---|---|---|---|---|\n| YYYY-MM-DD |',
      '| 日期 | 走查人 | 看了几张 | 五态判据 | 不合格项 | 结论 |\n|---|---|---|---|---|---|\n| YYYY-MM-DD |',
    );
    expect(drifted, 'the receipt template this case edits is gone').not.toBe(walkthrough);
    const problems = handoffProblems(drifted, REPOSITORY, walkthroughScreenshots());
    expect(
      problems.some((problem) => problem.includes('the receipt template\'s columns are')),
      problems.join('\n'),
    ).toBe(true);
  });

  it('reports a record table that moved while the template stayed put', () => {
    // The other direction: the record table gains a column and the template
    // does not. Same failure, and the message has to name both lists so the
    // reader can see which one moved.
    const widened = withRecordHeader(
      walkthrough,
      '| 日期 | 走查人 | 看了哪几张 | 五态判据 | 不合格项 | 结论 | 备注 |',
    );
    expect(widened, 'the record table header this case edits is gone').not.toBe(walkthrough);
    const problems = handoffProblems(widened, REPOSITORY, walkthroughScreenshots());
    expect(
      problems.some((problem) => problem.includes('the receipt template\'s columns are')),
      problems.join('\n'),
    ).toBe(true);
  });

  it('reports a receipt template whose placeholder row lost a cell', () => {
    // A walker copies the placeholder row and fills it. A row with five cells
    // under a six-column header is a row that silently shifts every answer one
    // column to the left.
    const short = walkthrough.replace(
      '| YYYY-MM-DD | 你的名字 | 10 张（五态 × 两个尺寸） | 30 条全满足 / 第 N 条不满足 | 无 / <屏幕上看到什么> | 五态判据全满足 / 第 N 条不满足：<屏幕上看到什么> |',
      '| YYYY-MM-DD | 你的名字 | 10 张（五态 × 两个尺寸） | 30 条全满足 / 第 N 条不满足 | 无 / <屏幕上看到什么> |',
    );
    expect(short, 'the receipt template row this case edits is gone').not.toBe(walkthrough);
    const problems = handoffProblems(short, REPOSITORY, walkthroughScreenshots());
    expect(
      problems.some((problem) => problem.includes('placeholder row has')),
      problems.join('\n'),
    ).toBe(true);
  });

  it('reports a command that lists nothing, rather than passing over an empty pack', () => {
    const problems = handoffProblems(walkthrough, REPOSITORY, []);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('lists no image');
  });
});
