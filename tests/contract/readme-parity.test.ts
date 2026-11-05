/**
 * The two language versions of the README must state the same limitations.
 *
 * ## Why this exists
 *
 * `README.md` is written twice: English above, Chinese below. Nothing in the
 * build compares them, and the same defect has now happened twice. Both
 * sections listed four limitations, but the English provider bullet stopped at
 * "native vendor adapters are not implemented" while the Chinese one went on to
 * say that `mock` calls no vendor — so the Chinese reader was told the answer
 * they might get is not a real model's, and the English reader was not. It was
 * fixed by hand. The round before it fixed a different sentence in the same
 * pair of sections.
 *
 * Prose in two languages is not something a test can compare semantically, and
 * a version of this file that tried would be edited until it stopped trying
 * (the README citation gate records exactly that history: fourteen false
 * positives on its first run). So this file judges structure instead:
 *
 *  - the two sections list the **same number** of limitations;
 *  - the limitation at each position carries the words `LIMITATIONS` names for
 *    that position, in **both** languages.
 *
 * Positional, not keyword-set matching, because the failure this replaces was
 * positional in practice: both sections had four bullets and one of them had
 * lost a sentence. Indexing also gives a message that names the bullet ("the
 * third limitation does not mention `feed`") instead of one that reports a set
 * difference, and it needs no "this keyword is too general" rule — the word
 * `feed` appears in two bullets of the real README, which a set-matching
 * version would have had to work around.
 *
 * The price is that reordering one section means rewriting `LIMITATIONS`. That
 * is a sentence-order edit, and the table sitting next to the check that keeps
 * it true is the point: a new limitation is added to both languages *and* to
 * the table, or this file goes red.
 *
 * ## Why nothing here skips
 *
 * Every case in this file used to sit behind `it.skipIf(readme === '')`. A
 * deleted, moved or renamed README therefore produced a green run: the one case
 * that could say "the sections are gone" was skipped by the same condition that
 * made it true, and the rest compared fixtures against themselves. That is the
 * house rule this repository already states for its other document gates — a
 * check that cannot fail is not a check — so the file now asserts its own
 * subject first, unconditionally, and lets every later case fail when the
 * README is not there. `readme.test.ts` next door had the same guard and got the
 * same fix in the same commit.
 *
 * Deliberately **not** asserted: that the two sentences mean the same thing,
 * that they are the same length, or anything else about how they read.
 *
 * ## The numbers
 *
 * The same document states two figures a build decides: the Node.js floor
 * ("Requires Node.js 22.12 or newer" / "需要 Node.js 22.12 或更高版本") and the
 * Electron major the packaging toolchain brings. Both are written twice, in two
 * languages, and both are copied from `package.json` — so a Node upgrade that
 * edits `engines.node` and forgets the prose leaves the README telling readers
 * to install a version the toolchain no longer accepts, in one language only.
 * The second half of this file compares every such number with `package.json`,
 * per language and then in every other place the document mentions it.
 *
 * ## The third question: is the document finished?
 *
 * The two halves can agree with each other and with `package.json` and still be
 * the wrong document — a file that stops mid-sentence, or one that grew a third
 * top-level section after the Chinese half. Both happened: a review tool cut the
 * English half at "matches this reposi…", and a note about which work the next
 * round may pick up was appended after `### 许可`. Neither was visible to any
 * gate here, because every other check reads *inside* a section. The last
 * describe block in this file asks the document-level question instead: exactly
 * two halves, nothing after them, every paragraph finished, and the same number
 * of promises in each half.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The README this file reads, anchored at the repository rather than the cwd.
 *
 * `readFileSync('README.md')` resolved against whatever directory the runner
 * was started in. From the repository root that is the same file; from
 * anywhere else the gate silently read *nothing* — and, with a `skipIf` guard in
 * front of every case, reported a green run about a document it never opened.
 */
const README_PATH = join(import.meta.dirname, '..', '..', 'README.md');
const readme = existsSync(README_PATH) ? readFileSync(README_PATH, 'utf8') : '';

const EN_HEADING = '### Current limitations';
const ZH_HEADING = '### 当前局限';

type Lang = 'en' | 'zh';
const LANGS: readonly Lang[] = ['en', 'zh'];

/**
 * One limitation, and the words that identify it in each language.
 *
 * One entry per bullet, in the order the two sections state them. `id` is for
 * failure messages only; it is never matched against the README.
 *
 * The README groups these into two subsections — gaps that close in this
 * repository, then blockers that need a token, a Windows machine or a person.
 * The order below follows the document, so the three external blockers sit at
 * the end in both languages; the gate still compares the bullets one position
 * at a time, which is what catches a language that kept a sentence the other
 * one dropped.
 */
interface Limitation {
  readonly id: string;
  readonly en: readonly string[];
  readonly zh: readonly string[];
}

const LIMITATIONS: readonly Limitation[] = [
  { id: 'one provider protocol; `mock` is not a real model', en: ['mock'], zh: ['mock'] },
  { id: 'the installer is unsigned', en: ['unsigned'], zh: ['未签名'] },
  // Three keywords, because the Chinese section states two facts this row
  // exists to keep: the override must be `https`, and a cleartext address is
  // refused rather than quietly falling back to the bundled feed; and with no
  // feed the app says so instead of reporting "up to date". English only
  // carried the first in the Installers section above, so the limitation
  // itself read as if any feed URL would do — and a reader with no feed was
  // told nothing about what the button would answer.
  {
    id: 'auto-update reads an `https` feed and says so when there is none',
    en: ['feed', 'cleartext', 'failing quietly'],
    zh: ['feed', '明文', '静默'],
  },
  { id: 'the terminal needs `node-pty`', en: ['node-pty'], zh: ['node-pty'] },
  // Five keywords, because "verified somehow" is not the claim that matters.
  // The bullet has to say (a) there is no CI job, and (b) how a reader closes
  // the gap themselves: a limitation that only admits the gap is a disclaimer;
  // the manual command and the line to read are what make it actionable. A
  // README that drifted back to "covered by the packaged smoke run" would
  // promise a gate that does not exist, and one that dropped the steps would
  // leave the reader with no way to check it.
  //
  // The fifth keyword is the step's own precondition on Windows: the line goes
  // to the process's stderr, and a double-clicked build has no console to write
  // it to. Without "from a terminal" the instructions read as complete and
  // leave a Windows reader looking for a line that was never printed — the same
  // failure as a missing gate, one layer out.
  //
  // These keywords keep the two sections saying the same thing; whether the
  // sentence is *true* of CI is a second gate, in
  // `adapter-resolution.test.ts`: each language's bullet is compared with the
  // workflows. Words-to-words parity cannot see one language go on promising a
  // manual step while the other was corrected, so both are needed.
  {
    id: 'adapter resolution inside a real asar is verified by hand, not by CI',
    en: ['asar', 'ci does not cover', 'npm run package', 'adapters resolved', 'from a terminal'],
    zh: ['asar', 'ci 不覆盖', 'npm run package', 'adapters resolved', '从命令行'],
  },
  // The defect that is in a *shipped* release, not in the code: the v1.0.0
  // asset on the Releases page predates the feed check and carries no digest.
  // It is stated in the README rather than only in `docs/`, because a reader
  // deciding whether to trust the update channel is the person it affects —
  // and because "we know, here is what it means, here is when it is fixed" is
  // the honest form of a limitation. The three keywords are the three facts
  // that make it actionable: which release, what is missing, when it is fixed.
  //
  // The fourth keyword is the holder. A bullet that says "this is blocked" and
  // stops leaves the reader asking the question a reviewer asks next — *whose*
  // is it — and the answer used to live only in `docs/blockers.md`. The same
  // phrase is now on screen (`diag.env.<id>.who`) and pinned to the blockers
  // page's heading by `demo-boundaries.test.ts`; this row keeps the two
  // languages from dropping it on one side.
  {
    id: 'the published v1.0.0 feed has no `sha256`',
    en: ['v1.0.0', 'sha256', '1.1.0', 'write token'],
    zh: ['v1.0.0', 'sha256', '1.1.0', '写权限令牌'],
  },
  // The Windows row of the DoD table, stated where a reader deciding whether the
  // release was ever run on Windows will see it. `docs/dod-status.md` tells the
  // person who runs it to carry a report home and judge it, but the README named
  // neither half, so a reader could learn "Windows is unverified" and stop there
  // with no way to close it. The keywords are the two halves of that route: a
  // file being carried (`win-report.json`), and the command that judges it
  // (`--judge`); `evidence` is the sentence that stops five bare `pass` lines
  // from reading like a run. Both languages carry the same four facts, because a
  // Windows reader gets whichever half they opened.
  {
    id: 'the Windows run of steps 1-5 has not happened, and a report can close it',
    en: ['windows', 'win-report.json', '--judge', 'evidence', 'windows machine'],
    zh: ['windows', 'win-report.json', '--judge', '证据', 'windows 机器'],
  },
  // The one limitation that is about a *person*, not a gate. The five states
  // are asserted, measured and photographed, and every one of those is a
  // machine answering a machine's question; whether they read as a first run,
  // a failure and a permission prompt is a judgement no gate can make. It is
  // stated in the README because a reader deciding whether to trust the
  // screenshots is the person it affects — and because a green gate over an
  // unwalked screen is the kind of quiet overclaim this repository keeps
  // finding in itself.
  //
  // Three keywords per language, and they are the three facts that make it
  // checkable rather than a disclaimer: which states, that nobody has looked,
  // and where the omission is recorded. A bullet that drifted back to "the
  // states are covered" would drop the middle one and go red here.
  {
    id: 'the five interface states have not been walked through by eye',
    en: ['five interface states', 'by eye', 'step 6', 'needs a person'],
    zh: ['五个界面状态', '人眼', '步骤 6', '需要一个人'],
  },
];

/**
 * One row of the table, by `id`.
 *
 * The cases below used to index `LIMITATIONS` positionally, so inserting a row
 * anywhere above them changed what they were testing while their names and
 * assertions stayed the same — a fixture that quietly stops being the fixture.
 * Looking the row up by the id it declares makes an inserted row a no-op here
 * and a deleted one a loud failure.
 */
function row(id: string): Limitation {
  const found = LIMITATIONS.find((limitation) => limitation.id === id);
  if (found === undefined) throw new Error(`LIMITATIONS has no row "${id}"`);
  return found;
}

/**
 * The body under a heading, up to the next heading of the same or a higher
 * level. Returns `undefined` when the heading is gone — a renamed section must
 * fail here rather than pass over an empty body.
 */
function sectionBody(markdown: string, heading: string): string | undefined {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start === -1) return undefined;
  const level = heading.match(/^#+/)?.[0].length ?? 3;
  const nextHeading = new RegExp(`^#{1,${level}} `);
  const end = lines.findIndex((line, index) => index > start && nextHeading.test(line));
  return lines.slice(start + 1, end === -1 ? undefined : end).join('\n');
}

/**
 * The top-level bullets of a section, with their continuation lines joined in.
 *
 * A bullet wraps across several lines in this README (`- **The installer is
 * unsigned.** Windows SmartScreen warns…`), and a keyword that fell on a later
 * line would be invisible to a check that read the first line only.
 */
function bullets(body: string): string[] {
  const out: string[] = [];
  for (const line of body.split('\n')) {
    if (/^- /.test(line)) out.push(line.slice(2).trim());
    else if (out.length > 0 && /^\s+\S/.test(line)) out[out.length - 1] += ' ' + line.trim();
  }
  return out;
}

/** Whether a bullet states a limitation, i.e. carries every keyword for that language. */
function claims(bullet: string, keywords: readonly string[]): boolean {
  const text = bullet.toLowerCase();
  return keywords.every((keyword) => text.includes(keyword.toLowerCase()));
}

/** A short, quoted form of a bullet for a failure message. */
function excerpt(bullet: string | undefined): string {
  if (bullet === undefined) return 'nothing (the section is shorter than the table)';
  return `"${bullet.slice(0, 80)}${bullet.length > 80 ? '…' : ''}"`;
}

/**
 * Every way the sections and the table can disagree.
 *
 * A pure function of its inputs so a fixture can show it answering something
 * other than `[]` — the one thing a gate about alignment must be able to prove.
 */
function parityProblems(
  sections: Record<Lang, readonly string[]>,
  limitations: readonly Limitation[],
): string[] {
  const problems: string[] = [];

  for (const lang of LANGS) {
    if (sections[lang].length !== limitations.length) {
      problems.push(
        `${lang}: the section states ${sections[lang].length} limitation(s) and LIMITATIONS names ${limitations.length}`,
      );
    }
  }

  // Grouped by language: a reader fixing one of the two sections gets its
  // problems together, in the order the section states them.
  for (const lang of LANGS) {
    for (let index = 0; index < limitations.length; index += 1) {
      const limitation = limitations[index]!;
      const bullet = sections[lang][index];
      if (bullet === undefined) continue; // already reported as a count mismatch
      if (claims(bullet, limitation[lang])) continue;
      problems.push(
        `${lang}: limitation ${index + 1} does not state "${limitation.id}" — looked for ${limitation[
          lang
        ]
          .map((keyword) => `"${keyword}"`)
          .join(' + ')} in ${excerpt(bullet)}`,
      );
    }
  }

  return problems;
}

const en = sectionBody(readme, EN_HEADING);
const zh = sectionBody(readme, ZH_HEADING);
const sections: Record<Lang, readonly string[]> = {
  en: bullets(en ?? ''),
  zh: bullets(zh ?? ''),
};

describe('README limitations, English and Chinese', () => {
  it('finds README.md and both sections, so the checks below are not vacuous', () => {
    // Unconditional, and first. Every other case here reads `readme`, and all of
    // them used to sit behind a `skipIf` guard on `readme === ''` — including
    // this one, which asserted `existsSync` from behind the same skip. A
    // deleted, moved or renamed README was therefore a *green* run in which the
    // only surviving assertions compared fixtures with themselves: a gate that
    // switches itself off when its subject disappears is not a gate.
    // `adapter-candidates.test.ts` and `scanner-registry.test.ts` already follow
    // this rule; this file was the remaining place that did not.
    expect(existsSync(README_PATH), `README.md is missing (${README_PATH})`).toBe(true);
    expect(readme.trim().length, `README.md is empty (${README_PATH})`).toBeGreaterThan(0);
    // A section that was renamed or deleted would make every assertion below
    // trivially green, which is the shape of a gate that has stopped gating.
    expect(en, `the README no longer has a "${EN_HEADING}" section`).toBeDefined();
    expect(zh, `the README no longer has a "${ZH_HEADING}" section`).toBeDefined();
    // Two bullets each is the floor, not a target: it is what makes "the same
    // limitations in both languages" a claim about more than one sentence.
    expect(sections.en.length).toBeGreaterThan(1);
    expect(sections.zh.length).toBeGreaterThan(1);
  });

  it('names a limitation in the table at all', () => {
    // Same anti-vacuity rule, applied to the table: an empty list would make
    // `parityProblems` return `[]` whatever the README says.
    expect(LIMITATIONS.length).toBeGreaterThan(2);
  });

  it('states each limitation in both languages', () => {
    const problems = parityProblems(sections, LIMITATIONS);
    expect(
      problems,
      `the two limitations sections disagree:\n  ${problems.join('\n  ')}`,
    ).toEqual([]);
  });

  it('reports a bullet that lost a sentence the other language kept', () => {
    // The historical defect: the English provider bullet stopped short of the
    // `mock` sentence the Chinese one carried. Both sections still had four
    // bullets, so nothing about their shape looked wrong.
    const table = LIMITATIONS.slice(0, 1);
    expect(
      parityProblems(
        {
          en: ['**One provider protocol ships.** `mock` is not a real model.'],
          zh: ['**只随包发布一种厂商协议。** `mock` 不代表真实模型。'],
        },
        table,
      ),
    ).toEqual([]);

    const problems = parityProblems(
      {
        en: ['**One provider protocol ships.** `mock` is not a real model.'],
        zh: ['**只随包发布一种厂商协议。** 厂商原生适配器未实现。'],
      },
      table,
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('zh: limitation 1 does not state');
    expect(problems[0]).toContain('"mock"');
  });

  it('reports a feed bullet that dropped the "no feed" answer in one language', () => {
    // The sentence a reader with no feed depends on: the button says so rather
    // than reporting the app is up to date. Both languages carried it, but
    // only the `https` half was in the table — so one language could drop the
    // other half and stay green. This is the case that makes the new keyword
    // fail, and it fails on the language that lost the sentence.
    const table = [LIMITATIONS[2]!];
    expect(
      parityProblems(
        {
          en: [
            '**Auto-update needs a feed URL.** The variable must be `https`: a cleartext ' +
              'address is refused. With no feed the app says so rather than failing quietly.',
          ],
          zh: ['**自动更新需要一个 feed 地址。** 这个变量只接受 `https`：明文地址会被拒绝。'],
        },
        table,
      ),
    ).toEqual([
      'zh: limitation 1 does not state "auto-update reads an `https` feed and says so when ' +
        'there is none" — looked for "feed" + "明文" + "静默" in ' +
        '"**自动更新需要一个 feed 地址。** 这个变量只接受 `https`：明文地址会被拒绝。"',
    ]);
  });

  it('reports a section with a different number of limitations', () => {
    // The other half of the same defect: a limitation added to one language
    // only. Nothing else catches this — the bullets that *are* in both
    // languages still match perfectly.
    const problems = parityProblems(
      {
        en: [
          '**One provider protocol ships.** `mock` is not a real model.',
          '**Telemetry is not built in.** Nothing is uploaded.',
        ],
        zh: ['**只随包发布一种厂商协议。** `mock` 不代表真实模型。'],
      },
      LIMITATIONS.slice(0, 1),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toBe('en: the section states 2 limitation(s) and LIMITATIONS names 1');
  });

  it('reports a table row that no bullet states any more', () => {
    // A row left behind after a limitation is dropped points this file at a
    // sentence that no longer exists. It shows up as a count: the section has
    // one bullet fewer than the table has rows, and the fix is to delete the
    // row rather than to find a bullet that carries its words.
    const problems = parityProblems(
      {
        en: ['**The installer is unsigned.** Windows SmartScreen warns on first run.'],
        zh: ['**安装包未签名。** Windows 首次运行会有 SmartScreen 提示。'],
      },
      [LIMITATIONS[1]!, LIMITATIONS[0]!],
    );
    expect(problems).toEqual([
      'en: the section states 1 limitation(s) and LIMITATIONS names 2',
      'zh: the section states 1 limitation(s) and LIMITATIONS names 2',
    ]);
  });

  it('names the bullet it could not match, so the fix is local', () => {
    // Reordering one section is the one thing positional matching makes a
    // deliberate edit: the message has to say which bullet is wrong, or the
    // next person will rewrite the table to match the mistake.
    const problems = parityProblems(
      {
        en: [
          '**The installer is unsigned.** Windows SmartScreen warns on first run.',
          '**The interactive terminal needs `node-pty`.** It is optional.',
        ],
        zh: [
          '**交互式终端依赖 `node-pty`。** 它是可选依赖。',
          '**安装包未签名。** Windows 首次运行会有 SmartScreen 提示。',
        ],
      },
      // Indexed by `id`, not by position: this case is about the *message*, and
      // a row inserted above these two must not silently change what it tests.
      [row('the installer is unsigned'), row('the terminal needs `node-pty`')],
    );
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain('zh: limitation 1 does not state "the installer is unsigned"');
    expect(problems[0]).toContain('交互式终端依赖 `node-pty`'); // the bullet it found instead
    expect(problems[1]).toContain('zh: limitation 2 does not state "the terminal needs `node-pty`"');
  });
});

/**
 * `package.json`, read for the two numbers the README states.
 *
 * Anchored at the repository for the same reason `README_PATH` is: the runner's
 * cwd is not a fact this gate should depend on.
 */
const PACKAGE_PATH = join(import.meta.dirname, '..', '..', 'package.json');
const pkg = existsSync(PACKAGE_PATH)
  ? (JSON.parse(readFileSync(PACKAGE_PATH, 'utf8')) as {
      engines?: { node?: string };
      devDependencies?: Record<string, string>;
    })
  : null;

/** The first `parts` dotted components of a version range, as the README spells them. */
function declaredNumber(declared: string | undefined, parts: 1 | 2): string | null {
  if (typeof declared !== 'string') return null;
  const match = declared.match(/^[^\d]*(\d+(?:\.\d+)?)/);
  if (match === null) return null;
  const components = match[1]!.split('.');
  if (components.length < parts) return null;
  return components.slice(0, parts).join('.');
}

/**
 * One number the README states in both languages, and the field that decides it.
 *
 * `stated` is matched against the whole document rather than one section: the
 * sentences that carry these numbers sit in the "Getting started" prose, not in
 * the limitations sections above, and the language is identified by the wording
 * of the sentence ("or newer" versus "或更高版本") because the two languages do
 * not otherwise mark their boundaries.
 *
 * `mention` is the same tool named with any number anywhere in the document. It
 * exists because fixing the sentence in one place is exactly how a second,
 * stale mention survives: a reader who scrolls to the upgrade paragraph must not
 * find a different figure there.
 */
interface NumberClaim {
  readonly id: string;
  /** the `package.json` field, for the failure message */
  readonly source: string;
  /** what that field says, verbatim */
  readonly declared: string | undefined;
  /** the number it means, as the README writes it; null when the field states none */
  readonly number: string | null;
  readonly stated: Record<Lang, RegExp>;
  readonly mention: RegExp;
}

const NUMBER_CLAIMS: readonly NumberClaim[] = [
  {
    id: 'the Node.js floor',
    source: 'engines.node',
    declared: pkg?.engines?.node,
    number: declaredNumber(pkg?.engines?.node, 2),
    stated: {
      en: /Node\.js (\d+\.\d+) or newer/,
      zh: /Node\.js (\d+\.\d+) 或更高版本/,
    },
    mention: /Node\.js (\d+\.\d+)/g,
  },
  {
    id: 'the Electron major',
    source: 'devDependencies.electron',
    declared: pkg?.devDependencies?.electron,
    number: declaredNumber(pkg?.devDependencies?.electron, 1),
    // The toolchain sentence, in the two languages' own words — the same reason
    // `stated` is per language above: `Electron 44` alone appears in both and
    // would not say which sentence was found.
    stated: {
      en: /Electron (\d+) packaging toolchain/,
      zh: /Electron (\d+) 打包工具链/,
    },
    mention: /Electron (\d+)/g,
  },
];

/**
 * Every way one claimed number and the document can disagree.
 *
 * A pure function of its inputs, so the cases below can show it answering
 * something other than `[]` — see `parityProblems` above for the same rule.
 */
function numberParityProblems(claim: NumberClaim, markdown: string): string[] {
  if (claim.number === null) {
    return [
      `package.json ${claim.source} is ${JSON.stringify(
        claim.declared,
      )}, which states no number for the README to match`,
    ];
  }

  const problems: string[] = [];
  for (const lang of LANGS) {
    const match = markdown.match(claim.stated[lang]);
    if (match === null) {
      problems.push(
        `${lang}: the README no longer states ${claim.id} (looked for ${claim.stated[lang]})`,
      );
    } else if (match[1] !== claim.number) {
      problems.push(
        `${lang}: the README says ${claim.id} is ${match[1]}, and package.json ${claim.source} says ${claim.declared}`,
      );
    }
  }

  // A stale figure elsewhere in the document, which the per-language sentences
  // above cannot see: the sentence can be correct while a later paragraph still
  // names the version the upgrade replaced.
  const mentioned = [...markdown.matchAll(claim.mention)].map((match) => match[1]!);
  if (mentioned.length === 0) {
    problems.push(`${claim.id}: the README names no number at all (looked for ${claim.mention})`);
  }
  const stale = [...new Set(mentioned.filter((number) => number !== claim.number))];
  if (stale.length > 0) {
    problems.push(
      `${claim.id}: the README mentions ${stale.join(
        ', ',
      )} somewhere, and package.json ${claim.source} says ${claim.declared}`,
    );
  }

  return problems;
}

describe('the numbers the README states, and package.json', () => {
  it('finds package.json and a number for every claim', () => {
    // Unconditional, for the same reason the limitations section above is: a
    // claim whose `number` is null would make every comparison below trivially
    // green, and a missing `package.json` would do it to every claim at once.
    expect(existsSync(PACKAGE_PATH), `package.json is missing (${PACKAGE_PATH})`).toBe(true);
    const numberless = NUMBER_CLAIMS.filter((claim) => claim.number === null).map(
      (claim) => `${claim.source} = ${JSON.stringify(claim.declared)}`,
    );
    expect(
      numberless,
      `these package.json fields state no number the README could be compared with: ${numberless.join(
        ', ',
      )}`,
    ).toEqual([]);
  });

  it('states the same numbers as package.json, in both languages', () => {
    const problems = NUMBER_CLAIMS.flatMap((claim) => numberParityProblems(claim, readme));
    expect(
      problems,
      `the README and package.json disagree about a version:\n  ${problems.join('\n  ')}`,
    ).toEqual([]);
  });

  it('reports a language left behind by a version upgrade', () => {
    // The edit this gate exists for: `engines.node` is raised, the English
    // sentence is updated, and the Chinese one still tells readers the old
    // floor. Both sentences are grammatically fine and the document looks
    // maintained.
    const node = NUMBER_CLAIMS[0]!;
    const upgraded: NumberClaim = { ...node, declared: '>=24.1.0', number: '24.1' };

    const problems = numberParityProblems(
      upgraded,
      [
        'Requires Node.js 24.1 or newer (the Electron 44 packaging toolchain).',
        '需要 Node.js 22.12 或更高版本（Electron 44 打包工具链）。',
      ].join('\n'),
    );

    expect(problems).toEqual([
      'zh: the README says the Node.js floor is 22.12, and package.json engines.node says >=24.1.0',
      'the Node.js floor: the README mentions 22.12 somewhere, and package.json engines.node says >=24.1.0',
    ]);
  });

  it('reports a stale figure in a second paragraph', () => {
    // The sentence can be right while a later mention is wrong. Nothing about a
    // per-language sentence comparison sees this one, which is why the mention
    // scan is separate.
    const electron = NUMBER_CLAIMS[1]!;
    expect(
      numberParityProblems(
        electron,
        [
          'Requires Node.js 22.12 or newer (the Electron 44 packaging toolchain).',
          '需要 Node.js 22.12 或更高版本（Electron 44 打包工具链）。',
          '',
          'The Electron 42 build is not supported.',
        ].join('\n'),
      ),
    ).toEqual([
      'the Electron major: the README mentions 42 somewhere, and package.json devDependencies.electron says ^44.5.1',
    ]);
  });

  it('reports a field that states no number at all', () => {
    const node: NumberClaim = { ...NUMBER_CLAIMS[0]!, declared: '*', number: null };
    expect(numberParityProblems(node, readme)).toEqual([
      'package.json engines.node is "*", which states no number for the README to match',
    ]);
  });

  it('reports a document that stopped stating the number', () => {
    // A README that dropped the sentence entirely: the failure has to name the
    // claim and the pattern, or the reader is told "the README is wrong" about a
    // document they cannot diff against a regex.
    const zhMissing = ['Requires Node.js 22.12 or newer.', ''].join('\n');
    const problems = numberParityProblems(NUMBER_CLAIMS[0]!, zhMissing);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('zh: the README no longer states the Node.js floor');
  });
});

// ---------------------------------------------------------------------------
// The document's shape: two halves, and both of them finished
// ---------------------------------------------------------------------------

/**
 * The README is one document written twice, and this section is about the
 * document rather than about either half.
 *
 * ## The defect it was written for
 *
 * The file ended with a `## 产品过线标准（2026-10-31）` section: two lines of
 * instructions about which work the *next* round is allowed to pick up. It was
 * appended after the Chinese half's `### 许可`, so the document had three
 * top-level sections where it promises two, and the last thing a reader saw was
 * a note about the repository's own workflow rather than about the product.
 * Nothing in the build noticed, because every gate here reads *inside* a
 * section: `readme.test.ts` resolves the paths a section cites, the limitations
 * gate compares the two `### 当前局限` bodies, and a paragraph after the last
 * heading belongs to no section at all.
 *
 * The same shape is what a truncated file looks like from the other end. A
 * review tool that cut the document at "matches this reposi…" produced a file
 * whose last paragraph stops mid-sentence, and a reader cannot tell that from a
 * sentence that was written that way. So the two checks below are one idea:
 * **the document ends where it says it ends, and it ends on a finished
 * sentence.**
 *
 * ## What is asserted
 *
 *  - the top-level sections are exactly `## English` then `## 中文`, in that
 *    order, with nothing after them — a third section is either a workflow note
 *    that does not belong in a product README or a half that started again;
 *  - every paragraph ends on terminal punctuation, a lead-in colon, a heading, a
 *    horizontal rule or a table row — anything else is a fragment, and a
 *    fragment at the end of the file is what truncation looks like;
 *  - the two halves have the same number of `###` subsections, and the same
 *    number of top-level bullets in their first subsection (the "what it does"
 *    list, which is the document's promise in one screen).
 *
 * ## What is deliberately not asserted
 *
 * That the two halves say the same thing — that is the limitations gate above,
 * and it works because the limitations are a list with a table beside it. The
 * rest of the prose is not comparable, and a gate that tried would be edited
 * until it stopped trying. Nor is the *order* of the subsections compared: the
 * two halves are translations, and a translator moving a paragraph is not a
 * defect this file can see.
 */

const EN_HALF = '## English';
const ZH_HALF = '## 中文';

/** A line that ends a paragraph without ending a sentence: the lead-in colon. */
const LEAD_IN = /[:：]$/u;

/**
 * Terminal punctuation in both languages, plus the delimiters a finished line
 * can end on: a closing bracket (`[MIT](LICENSE)`), a closing backtick, a
 * closing quote.
 */
const FINISHED = /[.!?。！？)\]`”’]$/u;

/** One paragraph: where it starts, and the line it ends on. */
interface Paragraph {
  /** 1-based line number of the paragraph's first line. */
  readonly line: number;
  /** The paragraph's last non-empty line, trimmed. */
  readonly last: string;
}

/**
 * The paragraphs of a document, skipping fenced code blocks.
 *
 * A fenced block is not prose and its lines end however the code ends; counting
 * them would make this gate red over a shell snippet that finishes on `fi`.
 */
function paragraphs(markdown: string): Paragraph[] {
  const out: Paragraph[] = [];
  let start = 0;
  let last = '';
  let fenced = false;
  const flush = (): void => {
    if (last !== '') out.push({ line: start, last });
    last = '';
  };
  markdown.split('\n').forEach((raw, index) => {
    const line = raw.trim();
    if (/^```/u.test(line)) {
      flush();
      fenced = !fenced;
      return;
    }
    if (fenced) return;
    if (line === '') {
      flush();
      return;
    }
    if (last === '') start = index + 1;
    last = line;
  });
  flush();
  return out;
}

/** The end of a line, for a failure message: the reader needs the tail, not the head. */
function tail(line: string): string {
  return line.length > 60 ? `…${line.slice(-60)}` : line;
}

/**
 * Every paragraph that stops without finishing.
 *
 * The last paragraph of the document is included by construction, which is the
 * case that matters: a file cut mid-sentence has exactly one such paragraph and
 * it is the final one.
 */
function danglingProblems(markdown: string): string[] {
  const problems: string[] = [];
  for (const paragraph of paragraphs(markdown)) {
    const { last } = paragraph;
    if (/^#{1,6} /u.test(last)) continue; // a heading is finished by definition
    if (/^(?:-{3,}|\*{3,}|_{3,})$/u.test(last)) continue; // a horizontal rule
    if (/^\|/u.test(last)) continue; // a table row
    // A closing emphasis marker is not part of the sentence: the README's own
    // tagline ends `…against their hash.**`, which is a finished sentence with
    // a bold run around it. Stripping the markers first keeps the check about
    // the sentence rather than about the markup.
    const sentence = last.replace(/[*_]+$/u, '');
    if (FINISHED.test(sentence) || LEAD_IN.test(sentence)) continue;
    problems.push(
      `line ${paragraph.line}: the paragraph ends on "${tail(last)}", which is neither a ` +
        'finished sentence nor a lead-in — a document that stops mid-sentence reads as complete',
    );
  }
  return problems;
}

/** The `## ` headings of a document, in order. */
function topLevelSections(markdown: string): string[] {
  return markdown
    .split('\n')
    .filter((line) => /^## /u.test(line))
    .map((line) => line.trim());
}

/** The `### ` headings of a half, in order. */
function subsectionHeadings(body: string): string[] {
  return body
    .split('\n')
    .filter((line) => /^### /u.test(line))
    .map((line) => line.trim());
}

/**
 * The top-level bullets of a half's first `###` subsection.
 *
 * The first subsection is the "what it does" list in both languages, which is
 * the document's promise in one screen. Counting it is the cheapest way to
 * notice that one half lost a promise the other kept — the limitations gate
 * covers the same question for the limitations, and nothing covered it here.
 */
function firstSubsectionBullets(body: string): number {
  const lines = body.split('\n');
  const start = lines.findIndex((line) => /^### /u.test(line));
  if (start === -1) return 0;
  const end = lines.findIndex((line, index) => index > start && /^#{1,3} /u.test(line));
  return lines
    .slice(start + 1, end === -1 ? undefined : end)
    .filter((line) => /^- /.test(line)).length;
}

/**
 * Every way the document's shape can disagree with what it promises.
 *
 * A pure function of its input, so the fixtures below can show it answering
 * something other than `[]` — the one thing a gate about shape must be able to
 * prove.
 */
function shapeProblems(markdown: string): string[] {
  const problems: string[] = [];

  const sections = topLevelSections(markdown);
  if (sections.length !== 2 || sections[0] !== EN_HALF || sections[1] !== ZH_HALF) {
    problems.push(
      `the top-level sections are ${
        sections.length === 0 ? 'none' : sections.map((section) => `"${section}"`).join(', ')
      }; the document is exactly "${EN_HALF}" then "${ZH_HALF}", with nothing after them`,
    );
  }

  const en = sectionBody(markdown, EN_HALF);
  const zh = sectionBody(markdown, ZH_HALF);
  if (en === undefined || zh === undefined) return problems; // already reported above

  const enSubsections = subsectionHeadings(en);
  const zhSubsections = subsectionHeadings(zh);
  if (enSubsections.length !== zhSubsections.length) {
    problems.push(
      `en: ${enSubsections.length} subsection(s) (${enSubsections.join(', ')}) and zh: ` +
        `${zhSubsections.length} (${zhSubsections.join(', ')}) — one half has a section the other does not`,
    );
  }

  const enPromises = firstSubsectionBullets(en);
  const zhPromises = firstSubsectionBullets(zh);
  if (enPromises !== zhPromises) {
    problems.push(
      `en: the first subsection lists ${enPromises} item(s) and zh lists ${zhPromises} — ` +
        'the two halves promise a different number of things',
    );
  }

  return problems;
}

describe('the README is two halves, and both of them are finished', () => {
  it('ends on a finished sentence, in both halves', () => {
    const problems = danglingProblems(readme);
    expect(
      problems,
      `the README stops mid-sentence:\n  ${problems.join('\n  ')}`,
    ).toEqual([]);
  });

  it('is exactly the English half and the Chinese half, with nothing after them', () => {
    const problems = shapeProblems(readme);
    expect(
      problems,
      `the README's shape disagrees with what it promises:\n  ${problems.join('\n  ')}`,
    ).toEqual([]);
  });

  it('is not vacuous: the document really has two halves and a paragraph list', () => {
    // Without this, an emptied or renamed README would make both cases above
    // pass over nothing at all — the same anti-vacuity rule the rest of this
    // file follows.
    expect(topLevelSections(readme)).toEqual([EN_HALF, ZH_HALF]);
    expect(paragraphs(readme).length, 'the README has no paragraphs').toBeGreaterThan(20);
    // The two halves are read as bodies, not as empty strings: a `sectionBody`
    // that returned `''` would make the subsection counts agree at zero.
    expect(subsectionHeadings(sectionBody(readme, EN_HALF) ?? '').length).toBeGreaterThan(4);
    expect(firstSubsectionBullets(sectionBody(readme, EN_HALF) ?? '')).toBeGreaterThan(4);
  });

  it('reports a document that was cut mid-sentence', () => {
    // The shape a review tool leaves behind: the last paragraph stops on an
    // ellipsis, and every other check in this repository still passes because
    // the truncation is after the last section it reads.
    const truncated = [
      '## English',
      '',
      '### What it does',
      '',
      '- **Verifiable injection.** The context pack is a pure function.',
      '',
      '### License',
      '',
      'The licence is MIT and the repository matches this reposi…',
      '',
      '## 中文',
      '',
      '### 它能做什么',
      '',
      '- **注入可验证。** Context Pack 是纯函数。',
      '',
      '### 许可',
      '',
      '[MIT](LICENSE)',
    ].join('\n');

    const problems = danglingProblems(truncated);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('line 9');
    expect(problems[0]).toContain('matches this reposi…');
    expect(problems[0]).toContain('neither a finished sentence nor a lead-in');
  });

  it('accepts a lead-in colon, a heading, a rule and a table row as finished', () => {
    // The four shapes the real README uses to end a paragraph without ending a
    // sentence. A gate that called these fragments would be red over the
    // document it is supposed to protect, and the fix would be to weaken it.
    const document = [
      '## English',
      '',
      '### Installers',
      '',
      'The build produces one file:',
      '',
      '```bash',
      'npm run dist',
      '```',
      '',
      '---',
      '',
      '| Target | Output |',
      '|---|---|',
      '| Windows | `UCAD-Setup.exe` |',
      '',
      '## 中文',
      '',
      '### 安装包',
      '',
      '构建只产出一个文件：',
      '',
      '[MIT](LICENSE)',
    ].join('\n');

    expect(danglingProblems(document)).toEqual([]);
  });

  it('reports a section appended after the Chinese half', () => {
    // The defect this round removed: a note about which work the next round may
    // pick up, appended after `### 许可`. Every other gate in this repository
    // reads inside a section, so nothing else could see it.
    const withNote = [
      readme.trimEnd(),
      '',
      '## 产品过线标准（2026-10-31）',
      '必读 `docs/PRODUCT-DOD.md`。下一刀只许 DoD 未勾选。',
    ].join('\n');

    const problems = shapeProblems(withNote);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('"## 产品过线标准（2026-10-31）"');
    expect(problems[0]).toContain('with nothing after them');
  });

  it('reports a half that lost a subsection', () => {
    const problems = shapeProblems(
      [
        '## English',
        '',
        '### What it does',
        '',
        '- **Verifiable injection.** The context pack is a pure function.',
        '',
        '### License',
        '',
        '[MIT](LICENSE)',
        '',
        '## 中文',
        '',
        '### 它能做什么',
        '',
        '- **注入可验证。** Context Pack 是纯函数。',
      ].join('\n'),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('en: 2 subsection(s)');
    expect(problems[0]).toContain('zh: 1');
  });

  it('reports a half that lost a promise from the first subsection', () => {
    // The other half of the same defect: both halves keep their subsections and
    // one of them drops a bullet, which is how a promise disappears from one
    // language only.
    const problems = shapeProblems(
      [
        '## English',
        '',
        '### What it does',
        '',
        '- **Verifiable injection.** The context pack is a pure function.',
        '- **Explainable routing.** Every decision records its engine.',
        '',
        '## 中文',
        '',
        '### 它能做什么',
        '',
        '- **注入可验证。** Context Pack 是纯函数。',
      ].join('\n'),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('en: the first subsection lists 2 item(s) and zh lists 1');
  });

  it('reports a document with no halves at all', () => {
    // A README that was replaced by something else entirely: the failure has to
    // say what the document is supposed to be, not only that it is wrong.
    const problems = shapeProblems('# UCAD\n\nA one-line README.\n');
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('the top-level sections are none');
    expect(problems[0]).toContain('"## English" then "## 中文"');
  });
});

// ---------------------------------------------------------------------------
// The three states, in both halves
// ---------------------------------------------------------------------------

/**
 * The README shows the happy path, and the happy path is the one screen a
 * reader can already picture.
 *
 * ## The defect this block is written for
 *
 * "This product is honest about empty, failed and loading screens" is the
 * strongest thing the front page can say about a control plane, and for several
 * rounds it was said nowhere a reader would meet it: the Screenshots table
 * showed the populated conversation, the decision plane and the handoff chain,
 * and the three states lived in `docs/state-walkthrough.md` — a page a reader
 * opens *after* deciding the product is worth their time. A reader who never
 * scrolled that far had no way to know the app says "no project open yet, here
 * are the three steps" instead of handing them an empty input box.
 *
 * So the two halves now carry a row of three state pictures under the
 * Screenshots table, each with one sentence saying what that screen proves. The
 * sentences are the claim; the pictures are the evidence. Both are pinned here,
 * per language, because the failure this replaces is one half being updated and
 * the other left describing a screen that no longer exists.
 *
 * ## What is asserted
 *
 *  - both halves have the states section, and it lists exactly the three
 *    pictures `STATE_SHOTS` names, in that order — a half that dropped one, or
 *    added a fourth nobody wrote a sentence for, is red;
 *  - each picture's caption is **verbatim** the sentence in `STATE_SHOTS` for
 *    that language. Verbatim rather than keyword-matched, because the caption
 *    is one sentence: there is no second half of it to keep, and a keyword
 *    match would let the sentence be replaced by three words that happen to
 *    contain the keyword — which is exactly the "空态" caption this block
 *    exists to forbid;
 *  - the caption is a sentence, not a label: it has to be longer than the state
 *    name and longer than `MIN_CAPTION` characters. A caption that says "空态"
 *    is a caption that proves nothing, and the brief for this row was
 *    explicitly "not the two characters 空态";
 *  - the two halves list the same pictures in the same order, so a translator
 *    cannot quietly swap the loading picture for the error one.
 *
 * ## What is deliberately not asserted
 *
 * That the pictures show what the captions say — that is a person's judgement,
 * recorded in `docs/state-walkthrough.md`, and `screenshots.test.ts` already
 * holds the files to the window size and to the renderer's bytes. Nor that the
 * English and Chinese sentences are translations of each other: they are two
 * sentences, and the table below is the one place that says which two.
 */

/** The heading of the states section in each half. */
const STATES_HEADING: Record<Lang, string> = {
  en: '### States',
  zh: '### 状态',
};

/** One state picture, and the one sentence each half says about it. */
interface StateShot {
  /** The state's name, for failure messages only. */
  readonly id: string;
  /** The committed picture, as both halves spell it. */
  readonly path: string;
  /** The caption, verbatim, in each language. */
  readonly caption: Record<Lang, string>;
}

/**
 * The three states, in the order both halves show them.
 *
 * Empty, failed, loading — the three screens a reader cannot picture from the
 * happy path, and the three the product is most likely to get wrong quietly.
 */
const STATE_SHOTS: readonly StateShot[] = [
  {
    id: 'empty',
    path: 'docs/screenshots/empty.png',
    caption: {
      en:
        'First run: it tells you where to start — open a project, pick an agent, send a turn — ' +
        'instead of handing you an empty input box.',
      zh: '首次启动：它告诉你从哪开始——打开项目、选智能体、发一轮——而不是丢给你一个空输入框。',
    },
  },
  {
    id: 'error',
    path: 'docs/screenshots/error.png',
    caption: {
      en:
        'A load that failed: what broke, in the words the failure used, and the retry — not a ' +
        'blank panel.',
      zh: '一次彻底失败的加载：坏在哪、失败原文怎么说的、以及重试——不是一个空白面板，也不是一句「出错了」。',
    },
  },
  {
    id: 'loading',
    path: 'docs/screenshots/states/loading.png',
    caption: {
      en:
        'A read still in flight: the screen says it is waiting, so a slow disk never looks like ' +
        'an empty project.',
      zh: '读取还没返回：屏幕明说它在等，所以一块慢磁盘不会被看成空项目，也不会被当成没有内容。',
    },
  },
];

/**
 * The shortest caption that can be a sentence rather than a label.
 *
 * The row exists because "空态" is not an explanation; a caption shorter than
 * this is the label coming back.
 */
const MIN_CAPTION = 40;

/** The cells of one markdown table row, trimmed, without the outer pipes. */
function tableCells(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|')) return [];
  return trimmed
    .replace(/^\|/u, '')
    .replace(/\|$/u, '')
    .split('|')
    .map((cell) => cell.trim());
}

/** The image path in a cell, if the cell is an image. */
function imagePath(cell: string): string | undefined {
  return cell.match(/!\[[^\]]*\]\((docs\/screenshots\/[^)\s]+)\)/u)?.[1];
}

/**
 * The pictures a states section shows, each with the caption under it.
 *
 * The table is read as pairs of rows: a row of images, then the row of captions
 * beneath it, matched by column. A row with no image in it (the header, the
 * `|---|` rule) is skipped rather than misread, and a caption row that is
 * missing leaves the caption empty — which the comparison below reports as a
 * caption that is not the sentence.
 */
function stateTable(body: string): Array<{ path: string; caption: string }> {
  const rows = body.split('\n').filter((line) => line.trim().startsWith('|'));
  const out: Array<{ path: string; caption: string }> = [];
  for (let index = 0; index < rows.length; index += 1) {
    const cells = tableCells(rows[index]!);
    const images = cells.map(imagePath);
    if (images.every((path) => path === undefined)) continue;
    const captions = tableCells(rows[index + 1] ?? '');
    images.forEach((path, column) => {
      if (path !== undefined) out.push({ path, caption: captions[column] ?? '' });
    });
  }
  return out;
}

/**
 * Every way a half's states section and `STATE_SHOTS` disagree.
 *
 * Pure in `(markdown, shots)` so the red directions below are driven with
 * mutated copies instead of argued about — the rule the rest of this file
 * follows.
 */
function stateProblems(markdown: string, shots: readonly StateShot[]): string[] {
  const problems: string[] = [];

  for (const lang of LANGS) {
    const body = sectionBody(markdown, STATES_HEADING[lang]);
    if (body === undefined) {
      problems.push(
        `${lang}: the README has no "${STATES_HEADING[lang]}" section, so the three states are ` +
          'shown to one language only',
      );
      continue;
    }
    const rows = stateTable(body);
    if (rows.length !== shots.length) {
      problems.push(
        `${lang}: the states section shows ${rows.length} picture(s) and STATE_SHOTS names ` +
          `${shots.length} — a state a reader cannot see is a state the page does not claim`,
      );
    }
    shots.forEach((shot, index) => {
      const row = rows[index];
      if (row === undefined) return; // already reported as a count mismatch
      if (row.path !== shot.path) {
        problems.push(
          `${lang}: state ${index + 1} is ${row.path} and STATE_SHOTS names ${shot.path} — the ` +
            'two halves are showing different screens',
        );
        return;
      }
      const wanted = shot.caption[lang];
      if (row.caption !== wanted) {
        problems.push(
          `${lang}: the caption under ${shot.path} is "${row.caption}" and STATE_SHOTS says ` +
            `"${wanted}" — the sentence a reader is given is not the one this file pins`,
        );
      }
      if (wanted.length < MIN_CAPTION) {
        problems.push(
          `${lang}: the caption for ${shot.id} is ${wanted.length} characters — a caption that ` +
            'short is a label ("空态"), not a sentence saying what the screen proves',
        );
      }
    });
  }

  return problems;
}

describe('the three states, in both halves', () => {
  it('names three states, so the checks below are not vacuous', () => {
    expect(STATE_SHOTS.length).toBe(3);
    for (const shot of STATE_SHOTS) {
      expect(shot.path, `${shot.id} names no picture`).toMatch(/^docs\/screenshots\/.+\.png$/u);
      for (const lang of LANGS) {
        expect(shot.caption[lang].length, `${shot.id} has no ${lang} caption`).toBeGreaterThan(
          MIN_CAPTION,
        );
      }
    }
  });

  it('shows the same three pictures, with the same sentences, in both halves', () => {
    const problems = stateProblems(readme, STATE_SHOTS);
    expect(
      problems,
      `the two halves disagree about the states:\n  ${problems.join('\n  ')}`,
    ).toEqual([]);
  });

  it('reports a half that dropped the states section', () => {
    const problems = stateProblems(readme.replace(STATES_HEADING.zh, '### 别的标题'), STATE_SHOTS);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('zh: the README has no "### 状态" section');
  });

  it('reports a caption that was replaced by a label', () => {
    // The exact regression this row was written against: the sentence is
    // shortened to the state's name, which still "describes" the picture and
    // proves nothing.
    const shortened = readme.replace(STATE_SHOTS[0]!.caption.en, 'Empty state.');
    expect(shortened, 'the caption this case rewrites is gone').not.toBe(readme);
    const problems = stateProblems(shortened, STATE_SHOTS);
    expect(problems.some((problem) => problem.includes('is not the one this file pins'))).toBe(true);
  });

  it('reports a half that shows the pictures in a different order', () => {
    const swapped = readme.replace(
      `| ![空态](${STATE_SHOTS[0]!.path}) | ![失败态](${STATE_SHOTS[1]!.path})`,
      `| ![失败态](${STATE_SHOTS[1]!.path}) | ![空态](${STATE_SHOTS[0]!.path})`,
    );
    expect(swapped, 'the image row this case swaps is gone').not.toBe(readme);
    const problems = stateProblems(swapped, STATE_SHOTS);
    expect(problems.some((problem) => problem.includes('showing different screens'))).toBe(true);
  });

  it('reports a half that shows two states instead of three', () => {
    const dropped = readme.replace(
      ` | ![加载态](${STATE_SHOTS[2]!.path}) |`,
      ' | |',
    );
    expect(dropped, 'the loading picture this case removes is gone').not.toBe(readme);
    const problems = stateProblems(dropped, STATE_SHOTS);
    expect(problems.some((problem) => problem.includes('shows 2 picture(s)'))).toBe(true);
  });
});
