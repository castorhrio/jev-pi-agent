/**
 * The README's update channel must describe the rules `update-feed.ts` enforces.
 *
 * ## Why this exists
 *
 * The updater's safety rules live in code and are tested there: the channel is
 * https-only, a value that is not a URL is refused, a feed must publish a
 * `sha256` before anything is installed, and with no feed the app says so
 * rather than reporting "up to date". The README states the same rules twice,
 * in English and Chinese, and nothing compared the two. A prose edit is the
 * cheapest way to weaken a promise the build enforces: "the override must be
 * an `https` URL" becomes "the override may point anywhere", every gate stays
 * green, and the documentation now advertises a hole the code closed.
 *
 * So the facts are a table, matching the shape `readme-parity.test.ts` uses for
 * the limitations sections: each row names the words both languages must use,
 * and a drift fails with the fact and the language named. The refusal list is
 * derived from `CHANNEL_URL_REJECTIONS` rather than written out again, so a
 * third reason in `update-feed.ts` fails the Record here until the README says
 * what it means. That is deliberately the same tie `update-integrity.test.ts`
 * keeps between the reason vocabulary and its sentences.
 *
 * ## What it does not judge
 *
 * Whether a sentence reads well, or whether it is true of a particular release
 * (the release process is not a fact the repository can read). It checks that
 * the four rules and every refusal reason are present, in both languages, and
 * that the no-feed statement has not been fused into a refusal fix — "configure
 * an https feed" is the answer to a *typo*, and telling a reader with no feed
 * to check the scheme sends them looking for a value they never set.
 *
 * ## Why nothing here skips
 *
 * The same house rule as the two README gates next door: the first case asserts
 * the file and both sections unconditionally. A deleted or renamed README must
 * be the first red, not a run in which every comparison below is vacuous.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CHANNEL_URL_REJECTIONS,
  type ChannelUrlRejection,
} from '../../apps/desktop/src/main/update-feed';
import { FEED_REFUSAL_STATUS_MESSAGE } from '../../apps/desktop/src/main/update-service';
import { UPDATE_FEED_REFUSAL_MESSAGE } from '../../apps/desktop/src/main/update-feed-log';

/** Anchored at the repository, for the same reason the other README gates are. */
const README_PATH = join(import.meta.dirname, '..', '..', 'README.md');
const readme = existsSync(README_PATH) ? readFileSync(README_PATH, 'utf8') : '';

const EN_HEADING = '### Installers';
const ZH_HEADING = '### 安装包';

type Lang = 'en' | 'zh';
const LANGS: readonly Lang[] = ['en', 'zh'];

/** One rule the update channel enforces, and the words that state it. */
interface UpdateFact {
  readonly id: string;
  readonly en: readonly string[];
  readonly zh: readonly string[];
}

const UPDATE_FACTS: readonly UpdateFact[] = [
  {
    id: 'the override variable',
    en: ['UCAD_UPDATE_FEED'],
    zh: ['UCAD_UPDATE_FEED'],
  },
  {
    // Both halves matter: the rule is "https", and the *answer* to cleartext
    // is a refusal, not a fallback to the bundled feed. A README that dropped
    // "refused" would still mention https while telling the reader the wrong
    // thing about what happens next.
    id: 'the channel is https-only',
    en: ['must be an `https`', 'cleartext', 'refused'],
    zh: ['必须是 `https`', '明文', '被拒'],
  },
  {
    id: 'a value that is not a URL',
    en: ['not a url', 'refused'],
    zh: ['不是 url', '被拒'],
  },
  {
    id: 'no feed is announced, not failed quietly',
    en: ['with no feed', 'says so'],
    zh: ['没有配置时', '直说'],
  },
  {
    // "sha256" alone is not enough: the point is that the file is checked and
    // a mismatch is not launched, and that a feed without one installs nothing.
    id: 'an installer needs a published sha256',
    en: ['must carry a `sha256`', 'nothing is installed'],
    zh: ['必须带 `sha256`', '不会从中安装'],
  },
];

/**
 * How each refusal reason is described in each language.
 *
 * `Record<ChannelUrlRejection, …>` is the compile-time half: a new reason in
 * `CHANNEL_URL_REJECTIONS` does not compile until it has README wording here.
 * The first case compares the keys at runtime too, because `tests/` is
 * transpiled without typechecking and `update-feed-log.test.ts` already relies
 * on that second direction for the same reason.
 */
const REJECTION_DOC_WORDS: Readonly<
  Record<ChannelUrlRejection, Readonly<Record<Lang, string>>>
> = {
  'invalid-url': { en: 'not a url', zh: '不是 url' },
  'not-https': { en: 'cleartext', zh: '明文' },
};

const NO_FEED_ANCHOR: Readonly<Record<Lang, string>> = {
  en: 'with no feed',
  zh: '没有配置时',
};

/**
 * Words a *no-feed* statement must not carry.
 *
 * They are the vocabulary of a refusal: the scheme nobody has to set, and the
 * two refusal-specific phrases. The sentence may sit beside an example https
 * URL, which is why the check reads the clause from the anchor onward rather
 * than the whole sentence.
 */
const REFUSAL_FIX_WORDS: Readonly<Record<Lang, readonly string[]>> = {
  en: ['https', 'must be an https', 'not a valid url'],
  zh: ['https', '必须使用', '地址无效'],
};

/** The refusal sentence each language already has, for the non-containment half. */
const REFUSAL_SENTENCES: Readonly<
  Record<Lang, Readonly<Record<ChannelUrlRejection, string>>>
> = {
  en: UPDATE_FEED_REFUSAL_MESSAGE,
  zh: FEED_REFUSAL_STATUS_MESSAGE,
};

/** Whitespace-normalised text, so a keyword wrapped across lines still matches. */
function flatten(markdown: string): string {
  return markdown.replace(/\s+/g, ' ').trim();
}

function sentences(markdown: string, lang: Lang): string[] {
  const flat = flatten(markdown);
  const parts = lang === 'zh' ? flat.split(/(?<=[。！？])/u) : flat.split(/(?<=[.!?]) /u);
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

/** The sentence containing `needle`, or undefined when none does. */
function sentenceWith(markdown: string, needle: string, lang: Lang): string | undefined {
  const lower = needle.toLowerCase();
  return sentences(markdown, lang).find((sentence) => sentence.toLowerCase().includes(lower));
}

/** The no-feed statement from its anchor to the end of its sentence. */
function noFeedClause(markdown: string, lang: Lang): string | undefined {
  const sentence = sentenceWith(markdown, NO_FEED_ANCHOR[lang], lang);
  if (sentence === undefined) return undefined;
  const start = sentence.toLowerCase().indexOf(NO_FEED_ANCHOR[lang].toLowerCase());
  return sentence.slice(start).trim();
}

/**
 * Every way the README can omit or contradict an update rule.
 *
 * A pure function of its inputs, so the cases below can show it answering
 * something other than `[]` — the one property a gate must be able to prove.
 */
function updateParityProblems(
  markdown: string,
  facts: readonly UpdateFact[],
  rejectionWords: Readonly<Record<ChannelUrlRejection, Readonly<Record<Lang, string>>>>,
): string[] {
  const text = flatten(markdown).toLowerCase();
  const problems: string[] = [];

  for (const fact of facts) {
    for (const lang of LANGS) {
      const missing = fact[lang].filter((keyword) => !text.includes(keyword.toLowerCase()));
      if (missing.length > 0) {
        problems.push(
          `${lang}: does not state ${fact.id} — missing ${missing
            .map((keyword) => `"${keyword}"`)
            .join(', ')}`,
        );
      }
    }
  }

  for (const reason of CHANNEL_URL_REJECTIONS) {
    for (const lang of LANGS) {
      const wording = rejectionWords[reason]?.[lang];
      if (wording === undefined) {
        problems.push(`${lang}: no README wording names the "${reason}" refusal`);
      } else if (!text.includes(wording.toLowerCase())) {
        problems.push(
          `${lang}: does not describe the "${reason}" refusal (looked for "${wording}")`,
        );
      }
    }
  }

  return problems;
}

/**
 * Every way the "no feed" sentence and the refusal sentences can be conflated.
 *
 * The two answers send a reader to different places — "set a feed" versus "fix
 * what you set" — so the no-feed clause must not carry a refusal fix, and the
 * two must not be the same text with one of them pasted into the other.
 */
function noFeedProblems(
  markdown: string,
  refusals: Readonly<Record<Lang, Readonly<Record<ChannelUrlRejection, string>>>>,
): string[] {
  const problems: string[] = [];
  for (const lang of LANGS) {
    const clause = noFeedClause(markdown, lang);
    if (clause === undefined) {
      problems.push(`${lang}: no sentence says what the app does with no feed`);
      continue;
    }
    const lower = clause.toLowerCase();

    for (const word of REFUSAL_FIX_WORDS[lang]) {
      if (lower.includes(word.toLowerCase())) {
        problems.push(`${lang}: the no-feed statement carries a refusal fix ("${word}")`);
      }
    }

    for (const reason of CHANNEL_URL_REJECTIONS) {
      const refusal = refusals[lang][reason].toLowerCase();
      if (lower.includes(refusal) || refusal.includes(lower)) {
        problems.push(
          `${lang}: the no-feed statement and the "${reason}" refusal are the same text`,
        );
      }
    }
  }
  return problems;
}

describe('the README update channel and the rules the code enforces', () => {
  it('finds README.md and both installers sections, so the checks below are not vacuous', () => {
    expect(existsSync(README_PATH), `README.md is missing (${README_PATH})`).toBe(true);
    expect(readme.trim().length, `README.md is empty (${README_PATH})`).toBeGreaterThan(0);

    // A renamed section would leave the prose this file describes elsewhere,
    // while a whole-document keyword search kept passing.
    expect(readme, `the README no longer has a "${EN_HEADING}" section`).toContain(EN_HEADING);
    expect(readme, `the README no longer has a "${ZH_HEADING}" section`).toContain(ZH_HEADING);
    expect(flatten(readme).toLowerCase()).toContain('ucad_update_feed');

    // Rows and reasons below are loops; an empty subject would make them green.
    expect(UPDATE_FACTS.length).toBeGreaterThan(3);
    expect(CHANNEL_URL_REJECTIONS.length).toBeGreaterThan(1);
    expect(
      Object.keys(REJECTION_DOC_WORDS).sort(),
      'a refusal reason has no README wording, or wording exists for a reason that is gone',
    ).toEqual([...CHANNEL_URL_REJECTIONS].sort());
  });

  it('states every update rule in both languages', () => {
    const problems = updateParityProblems(readme, UPDATE_FACTS, REJECTION_DOC_WORDS);
    expect(
      problems,
      `the README and the update channel disagree:\n  ${problems.join('\n  ')}`,
    ).toEqual([]);
  });

  it('keeps the no-feed answer separate from a refusal fix', () => {
    const problems = noFeedProblems(readme, REFUSAL_SENTENCES);
    expect(
      problems,
      `the README conflates "no feed" with "a refused feed":\n  ${problems.join('\n  ')}`,
    ).toEqual([]);
  });

  it('reports a language that lost the https rule', () => {
    // The edit this gate exists for: the code still refuses cleartext, and one
    // language now tells readers any address will do.
    const broken = [
      EN_HEADING,
      'Set `UCAD_UPDATE_FEED` to any URL.',
      'It must carry a `sha256`: nothing is installed without a hash.',
      ZH_HEADING,
      '`UCAD_UPDATE_FEED` 可以是任意地址。它必须带 `sha256`：没有哈希时不会从中安装任何东西。',
      '### Current limitations',
      '- **Auto-update needs a feed URL.** With no feed the app says so rather than failing quietly.',
      '### 当前局限',
      '- **自动更新需要一个 feed 地址。** 没有配置时应用会直说，而不是静默失败。',
    ].join('\n');

    const problems = updateParityProblems(broken, UPDATE_FACTS, REJECTION_DOC_WORDS);
    expect(
      problems.some((problem) => problem.startsWith('en: does not state the channel is https-only')),
    ).toBe(true);
    expect(
      problems.some((problem) => problem.startsWith('zh: does not state the channel is https-only')),
    ).toBe(true);
    // The invalid-URL rule is the one that used to be absent from the README
    // entirely, so a fixture without it must fail for that reason too.
    expect(problems.some((problem) => problem.includes('"invalid-url"'))).toBe(true);
  });

  it('reports a no-feed sentence that starts prescribing https', () => {
    // The conflation: a reader with no feed is sent to fix a scheme they never
    // chose. Both languages must fail here, or the gate only covers one.
    const broken = [
      'With no feed, set an https feed URL rather than failing quietly.',
      '没有配置时请设置 https feed 地址，而不是静默失败。',
    ].join('\n');

    const problems = noFeedProblems(broken, REFUSAL_SENTENCES);
    expect(problems).toContain('en: the no-feed statement carries a refusal fix ("https")');
    expect(problems).toContain('zh: the no-feed statement carries a refusal fix ("https")');
    expect(problems).toHaveLength(2);
  });
});
