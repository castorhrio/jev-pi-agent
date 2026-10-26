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
 * Deliberately **not** asserted: that the two sentences mean the same thing,
 * that they are the same length, or anything else about how they read.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';

const README = 'README.md';
const readme = existsSync(README) ? readFileSync(README, 'utf8') : '';

const EN_HEADING = '### Current limitations';
const ZH_HEADING = '### 当前局限';

type Lang = 'en' | 'zh';
const LANGS: readonly Lang[] = ['en', 'zh'];

/**
 * One limitation, and the words that identify it in each language.
 *
 * One entry per bullet, in the order the two sections state them. `id` is for
 * failure messages only; it is never matched against the README.
 */
interface Limitation {
  readonly id: string;
  readonly en: readonly string[];
  readonly zh: readonly string[];
}

const LIMITATIONS: readonly Limitation[] = [
  { id: 'one provider protocol; `mock` is not a real model', en: ['mock'], zh: ['mock'] },
  { id: 'the installer is unsigned', en: ['unsigned'], zh: ['未签名'] },
  // Two keywords, because the Chinese section states a fact this row exists to
  // keep: the override must be `https`, and a cleartext address is refused
  // rather than quietly falling back to the bundled feed. English only carried
  // that in the Installers section above, so the limitation itself read as if
  // any feed URL would do.
  { id: 'auto-update reads an `https` feed', en: ['feed', 'cleartext'], zh: ['feed', '明文'] },
  { id: 'the terminal needs `node-pty`', en: ['node-pty'], zh: ['node-pty'] },
  { id: 'adapter resolution inside a real asar is a packaging check', en: ['asar'], zh: ['asar'] },
];

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
  it.skipIf(readme === '')('finds both sections, so the checks below are not vacuous', () => {
    // A section that was renamed or deleted would make every assertion below
    // trivially green, which is the shape of a gate that has stopped gating.
    expect(en, `the README no longer has a "${EN_HEADING}" section`).toBeDefined();
    expect(zh, `the README no longer has a "${ZH_HEADING}" section`).toBeDefined();
    // Two bullets each is the floor, not a target: it is what makes "the same
    // limitations in both languages" a claim about more than one sentence.
    expect(sections.en.length).toBeGreaterThan(1);
    expect(sections.zh.length).toBeGreaterThan(1);
  });

  it.skipIf(readme === '')('names a limitation in the table at all', () => {
    // Same anti-vacuity rule, applied to the table: an empty list would make
    // `parityProblems` return `[]` whatever the README says.
    expect(LIMITATIONS.length).toBeGreaterThan(2);
  });

  it.skipIf(readme === '')('states each limitation in both languages', () => {
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
      [LIMITATIONS[1]!, LIMITATIONS[3]!],
    );
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain('zh: limitation 1 does not state "the installer is unsigned"');
    expect(problems[0]).toContain('交互式终端依赖 `node-pty`'); // the bullet it found instead
    expect(problems[1]).toContain('zh: limitation 2 does not state "the terminal needs `node-pty`"');
  });
});
