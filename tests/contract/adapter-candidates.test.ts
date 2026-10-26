/**
 * The README's adapter list and `ADAPTER_CANDIDATES` must be the same list.
 *
 * ## Why this exists
 *
 * The provider limitation is the one place where the README asks a reader to
 * trust a specific, checkable fact: *which* adapters ship, how many, and which
 * of them actually talks to a model. It says it twice — `### Current
 * limitations` and `### 当前局限` — and the same two ids again in
 * `apps/desktop/src/main/adapter-candidates.ts`, which is what the app really
 * loads. Nothing compared the three. `readme-parity.test.ts` next door only
 * checks that the two languages carry the same *keywords* in the same
 * *positions*: it would stay green if the table grew an `anthropic` entry that
 * neither paragraph mentioned, or if both paragraphs dropped `mock` while the
 * table kept it.
 *
 * So this file asserts the cross-file fact instead of the shape:
 *
 *  - the backticked ids named in the provider bullet, in **each** language,
 *    are exactly the keys of `ADAPTER_CANDIDATES` — both directions, so adding
 *    an adapter or removing one is red until the prose says the same thing;
 *  - the count the bullet states ("Two adapters are registered",
 *    "两个适配器", "2 个适配器") equals the table's size, because "Two" going
 *    stale is the same defect one sentence earlier;
 *  - the ids named in a `### What it does` / `### 它能做什么` bullet that
 *    talks about adapters are a **subset** of the table. That prose may name
 *    fewer adapters than the table registers (it is a summary, not the list),
 *    but it may not name an id the table has never heard of: that is the
 *    reader being promised a thing the app does not load, and it is exactly
 *    the direction `readme-parity.test.ts` cannot see (both languages can
 *    agree on a name that does not exist);
 *  - every specifier in the table names a package that exists in this repo,
 *    so a candidate cannot point at a package nobody ships; and
 *  - `bootstrap.ts` still reads the table rather than re-inlining it, because
 *    a copied list would leave this gate green while the app loaded something
 *    else;
 *  - the ids are tried in the order `ADAPTER_LOAD_ORDER` states, because the
 *    table's declaration order *is* the attempt order (`bootstrap.ts` walks
 *    `Object.entries`) and "in the order they are tried" used to live only in
 *    a doc comment; and
 *  - the bullet this gate reads is the adapter bullet: it says
 *    adapter/适配器, so a new bullet inserted above it turns the gate red
 *    instead of quietly making it read a different sentence.
 *
 * The gate reads identifiers out of one bullet, and out of the "what it does"
 * bullets that call the thing an adapter, not the whole README. That last
 * restriction is not caution, it was measured: scanning the whole feature list
 * for adapter-shaped backticks reported `` `rationale` `` and `` `confidence` ``
 * — the decision-record fields in the Chinese summary — as adapters the table
 * had forgotten. A gate that reports field names as missing adapters gets
 * switched off within a week, so the rule is "a sentence that says
 * adapter/适配器 may only name adapters the table knows", and the price is
 * stated plainly: a summary that names a vendor without calling it an adapter
 * is left to the reader. A whole-README scan would have to guess whether
 * `` `node-pty` `` is an adapter, and guessing is how gates die.
 *
 * ## Why nothing here skips
 *
 * These checks used to run under `it.skipIf(readme === '')`. A deleted, moved
 * or renamed README was therefore a *green* run in which the only surviving
 * tests compared fixtures against themselves — the gate's subject could
 * disappear without a single red test. The file now asserts the inputs it
 * reads (`beforeAll`) and lets the checks fail: "the README is gone" is a
 * failure of the promise this file exists to keep, not a reason to be quiet.
 *
 * Deliberately **not** asserted: that the two languages say the same thing
 * about the adapters (that is `readme-parity.test.ts`), or anything about how
 * the sentences read.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  ADAPTER_CANDIDATES,
  ADAPTER_LOAD_ORDER,
} from '../../apps/desktop/src/main/adapter-candidates';

const here = import.meta.dirname;
const REPO_ROOT = join(here, '..', '..');
const README_PATH = join(REPO_ROOT, 'README.md');
const BOOTSTRAP_PATH = join(REPO_ROOT, 'apps', 'desktop', 'src', 'main', 'bootstrap.ts');
const PACKAGES_DIR = join(REPO_ROOT, 'packages');

const readme = existsSync(README_PATH) ? readFileSync(README_PATH, 'utf8') : '';
const bootstrap = existsSync(BOOTSTRAP_PATH) ? readFileSync(BOOTSTRAP_PATH, 'utf8') : '';

const EN_HEADING = '### Current limitations';
const ZH_HEADING = '### 当前局限';
const EN_PROSE_HEADING = '### What it does';
const ZH_PROSE_HEADING = '### 它能做什么';

type Lang = 'en' | 'zh';
const LANGS: readonly Lang[] = ['en', 'zh'];

/** The body under a heading, up to the next heading of the same or a higher level. */
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
 * The top-level bullets of a section, with continuation lines joined in.
 *
 * Same rule as `readme-parity.test.ts`: these bullets wrap, and the adapter
 * list sits on the second and third line of the English one.
 */
function bullets(body: string): string[] {
  const out: string[] = [];
  for (const line of body.split('\n')) {
    if (/^- /.test(line)) out.push(line.slice(2).trim());
    else if (out.length > 0 && /^\s+\S/.test(line)) out[out.length - 1] += ' ' + line.trim();
  }
  return out;
}

/** The provider limitation is the first bullet in both languages. */
function providerBullet(markdown: string, heading: string): string | undefined {
  const body = sectionBody(markdown, heading);
  return body === undefined ? undefined : bullets(body)[0];
}

/** Backticked inline-code tokens in a bullet, in the order they appear. */
function backticked(text: string): string[] {
  return [...text.matchAll(/`([^`\n]+)`/g)].map((match) => match[1]!.trim());
}

/**
 * Adapter ids named by a bullet: the backticked tokens shaped like one.
 *
 * An id is lower-case ASCII with dashes — the spelling `ADAPTER_CANDIDATES`
 * uses. Everything else a bullet might quote is excluded by shape rather than
 * by a list of exceptions.
 */
function adapterIdsIn(bullet: string): string[] {
  const ids = backticked(bullet).filter((token) => /^[a-z][a-z0-9-]*$/.test(token));
  return [...new Set(ids)].sort();
}

/** The word that makes a summary bullet a statement about adapters. */
const ADAPTER_WORD = /adapters?|适配器/i;

/**
 * Adapter ids named by the bullets of a prose section that talk about adapters,
 * or `undefined` when the section is gone.
 *
 * `undefined` and `[]` mean different things here: the first is "there is no
 * such paragraph, so this check has nothing to read" and is reported as a
 * problem; the second is "the paragraph exists and says nothing about
 * adapters", which is allowed — today's feature summary describes the protocol
 * and never names a package id.
 *
 * Why the bullet has to *say* "adapter": the same sections quote other
 * identifiers in backticks — `rationale`, `confidence`, the skills path — and
 * those are shaped exactly like an adapter id. Reading them as adapters makes
 * the gate red about a field name, which is how a gate loses its audience.
 */
function adapterIdsInProse(markdown: string, heading: string): string[] | undefined {
  const body = sectionBody(markdown, heading);
  if (body === undefined) return undefined;
  const named = bullets(body)
    .filter((bullet) => ADAPTER_WORD.test(bullet))
    .flatMap((bullet) => adapterIdsIn(bullet));
  return [...new Set(named)].sort();
}

/** Number words a limitation bullet can spell its count with, both languages. */
const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
};

/** What the count check accepts as a number, spelled out for its failure message. */
const COUNT_SPELLINGS =
  '"Two adapters are registered" / "两个适配器" / "2 个适配器" (a number word or an Arabic numeral)';

/**
 * The count the bullet states, or `undefined` when it stopped stating one.
 *
 * Two patterns, one per language, because the two sections spell it
 * differently: "Two adapters are registered" counts forward, "两个适配器"
 * counts after the ids.
 *
 * Both patterns accept Arabic numerals as well as number words. The Chinese
 * one used to accept only `[一二两三四五六七八九十]`, so a paragraph edited to
 * say "2 个适配器" — the same sentence, spelled the way a reader is most likely
 * to type it — was reported as *not stating a count at all*: a false red whose
 * message sent the editor looking for a deleted sentence that was still there.
 * The English pattern's `\w+` already matched digits; this made the two
 * languages read counts differently for no reason.
 */
function statedCount(bullet: string, lang: Lang): number | undefined {
  const match =
    lang === 'en'
      ? /(\w+)\s+adapters?\s+(?:are|is)\s+registered/i.exec(bullet)
      : /(\d+|[一二两三四五六七八九十]+)\s*个适配器/.exec(bullet);
  if (match === null) return undefined;
  const word = match[1]!.toLowerCase();
  if (/^\d+$/.test(word)) return Number(word);
  return NUMBER_WORDS[word];
}

/** Package names this repo actually contains, read from each `package.json`. */
function workspacePackages(): string[] {
  if (!existsSync(PACKAGES_DIR)) return [];
  const names: string[] = [];
  for (const entry of readdirSync(PACKAGES_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = join(PACKAGES_DIR, entry.name, 'package.json');
    if (!existsSync(manifest)) continue;
    try {
      const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: unknown };
      if (typeof parsed.name === 'string') names.push(parsed.name);
    } catch {
      // An unparsable manifest is not this file's subject; the build says so.
    }
  }
  return names;
}

/** What the checks read: the two bullets, the two prose summaries, the table, the packages. */
interface Facts {
  readonly bullets: Record<Lang, string | undefined>;
  readonly proseIds: Record<Lang, readonly string[] | undefined>;
  readonly candidates: Readonly<Record<string, string>>;
  readonly packages: readonly string[];
}

/**
 * Every way the README's adapter prose and the table can disagree.
 *
 * A pure function of its inputs so the fixtures below can show it answering
 * something other than `[]` — a gate about two copies of one fact has to prove
 * it can see them diverge.
 */
function candidateProblems(facts: Facts): string[] {
  const problems: string[] = [];
  const ids = Object.keys(facts.candidates).sort();

  for (const lang of LANGS) {
    const bullet = facts.bullets[lang];
    if (bullet === undefined) {
      problems.push(`${lang}: the limitations section has no provider bullet`);
      continue;
    }

    const stated = adapterIdsIn(bullet);
    const missing = ids.filter((id) => !stated.includes(id));
    const extra = stated.filter((id) => !ids.includes(id));
    if (missing.length > 0) {
      problems.push(
        `${lang}: the adapter text does not name ${missing.map((id) => `\`${id}\``).join(', ')}, which the table registers`,
      );
    }
    if (extra.length > 0) {
      problems.push(
        `${lang}: the adapter text names ${extra.map((id) => `\`${id}\``).join(', ')}, which the table does not register`,
      );
    }

    const count = statedCount(bullet, lang);
    if (count === undefined) {
      problems.push(
        `${lang}: the adapter text no longer states how many adapters ship (looked for ${COUNT_SPELLINGS})`,
      );
    } else if (count !== ids.length) {
      problems.push(
        `${lang}: the adapter text says ${count} adapter(s) ship and the table registers ${ids.length}`,
      );
    }
  }

  // The feature summary, in both languages. Subset, not equality: it may
  // mention one adapter where the table registers two, but every id it does
  // mention has to be one the table knows.
  for (const lang of LANGS) {
    const named = facts.proseIds[lang];
    if (named === undefined) {
      problems.push(
        `${lang}: the "what it does" section is missing, so the adapter ids it names are unchecked`,
      );
      continue;
    }
    const stranger = named.filter((id) => !ids.includes(id));
    if (stranger.length > 0) {
      problems.push(
        `${lang}: a "what it does" bullet talks about adapters and names ${stranger.map((id) => `\`${id}\``).join(', ')}, which the table does not register`,
      );
    }
  }

  for (const [id, specifier] of Object.entries(facts.candidates)) {
    if (!facts.packages.includes(specifier)) {
      problems.push(
        `candidate "${id}" resolves to ${specifier}, which is not a package in packages/`,
      );
    }
  }

  return problems;
}

/** The real README, split into the paragraphs the gate reads. */
const facts: Facts = {
  bullets: {
    en: providerBullet(readme, EN_HEADING),
    zh: providerBullet(readme, ZH_HEADING),
  },
  proseIds: {
    en: adapterIdsInProse(readme, EN_PROSE_HEADING),
    zh: adapterIdsInProse(readme, ZH_PROSE_HEADING),
  },
  candidates: ADAPTER_CANDIDATES,
  packages: workspacePackages(),
};

describe('README adapter paragraph ↔ ADAPTER_CANDIDATES', () => {
  // The subject itself. A missing README used to turn this whole block into
  // skips; now it is the first thing that fails, with the path in the message.
  beforeAll(() => {
    expect(readme, `README.md is missing or empty (${README_PATH})`).not.toBe('');
  });

  it('reads both paragraphs, so the checks below are not vacuous', () => {
    // A renamed heading or a reordered bullet would leave the checks comparing
    // an empty string, which matches nothing — and, with an empty table, it
    // would match everything.
    expect(facts.bullets.en, `the README no longer has a "${EN_HEADING}" section`).toBeDefined();
    expect(facts.bullets.zh, `the README no longer has a "${ZH_HEADING}" section`).toBeDefined();
    expect(
      facts.proseIds.en,
      `the README no longer has a "${EN_PROSE_HEADING}" section`,
    ).toBeDefined();
    expect(
      facts.proseIds.zh,
      `the README no longer has a "${ZH_PROSE_HEADING}" section`,
    ).toBeDefined();
    expect(Object.keys(ADAPTER_CANDIDATES).length, 'the table names no adapters').toBeGreaterThan(
      0,
    );
    // `bullets(body)[0]` is a hardcoded assumption: the adapter paragraph is
    // the *first* bullet under "Current limitations". If someone inserts a new
    // limitation above it, the checks below read the new bullet — which names
    // no adapters, so the gate says "the text does not name `universal`" and
    // sends the editor to the wrong sentence. This assertion names the real
    // defect: the bullet the gate reads is no longer the adapter bullet.
    expect(
      facts.bullets.en,
      `the first "${EN_HEADING}" bullet is no longer the adapter one; the adapter bullet moved down`,
    ).toMatch(ADAPTER_WORD);
    expect(
      facts.bullets.zh,
      `the first "${ZH_HEADING}" bullet is no longer the adapter one; the adapter bullet moved down`,
    ).toMatch(ADAPTER_WORD);
    // The ids have to survive the shape filter, otherwise "no extra adapters"
    // would pass for the wrong reason.
    expect(adapterIdsIn(facts.bullets.en!), 'no adapter id was read out of the English bullet')
      .not.toEqual([]);
    expect(adapterIdsIn(facts.bullets.zh!), 'no adapter id was read out of the Chinese bullet')
      .not.toEqual([]);
  });

  it('states the same adapters, in both languages and in the table', () => {
    const problems = candidateProblems(facts);
    expect(
      problems,
      `the README and the adapter table disagree:\n  ${problems.join('\n  ')}`,
    ).toEqual([]);
  });
});

/**
 * A stand-in README for the fixtures: one that states what the table says.
 *
 * The fixtures are the proof that the checks above can answer anything but
 * `[]`, so they read this instead of the repository's prose. When the real
 * README is missing or its paragraphs drift, the gate is red *once*, at the
 * assertion about the file — not six times with fixture messages about
 * adapters the fixture never mentioned.
 */
const fixtureFacts: Facts = {
  bullets: {
    en:
      'One provider protocol ships. Two adapters are registered — `universal` is the one ' +
      'that sends real requests, and `mock` is the protocol’s executable specification.',
    zh:
      '只随包发布一种厂商协议。随包同时注册 `universal` 与 `mock` 两个适配器：' +
      '前者是真正发出请求的那一个。',
  },
  proseIds: { en: ['universal'], zh: [] },
  candidates: ADAPTER_CANDIDATES,
  packages: workspacePackages(),
};

/** Replace one fixture bullet, leaving the rest as `fixtureFacts` states it. */
function withBullet(lang: Lang, bullet: string): Facts {
  return { ...fixtureFacts, bullets: { ...fixtureFacts.bullets, [lang]: bullet } };
}

/** Replace the ids one fixture prose summary names. */
function withProse(lang: Lang, ids: readonly string[]): Facts {
  return { ...fixtureFacts, proseIds: { ...fixtureFacts.proseIds, [lang]: ids } };
}

describe('the checks can see the README diverge', () => {
  it('reports an adapter added to the table and not to the README', () => {
    // The next vendor adapter: the table grows, the prose does not.
    const problems = candidateProblems({
      ...fixtureFacts,
      candidates: { ...ADAPTER_CANDIDATES, anthropic: '@ucad/adapter-anthropic' },
    });
    expect(problems).toContain(
      'en: the adapter text does not name `anthropic`, which the table registers',
    );
    expect(problems).toContain(
      'zh: the adapter text does not name `anthropic`, which the table registers',
    );
    expect(problems).toContain('en: the adapter text says 2 adapter(s) ship and the table registers 3');
    expect(problems).toContain('zh: the adapter text says 2 adapter(s) ship and the table registers 3');
    expect(problems).toContain(
      'candidate "anthropic" resolves to @ucad/adapter-anthropic, which is not a package in packages/',
    );
  });

  it('reports an adapter removed from the table and left in the README', () => {
    // The other direction, and the one a reader is worse off for: the README
    // promises an offline reference adapter the app no longer loads.
    const problems = candidateProblems({
      ...fixtureFacts,
      candidates: { universal: '@ucad/adapter-universal' },
    });
    expect(problems).toContain(
      'en: the adapter text names `mock`, which the table does not register',
    );
    expect(problems).toContain(
      'zh: the adapter text names `mock`, which the table does not register',
    );
    expect(problems).toContain('en: the adapter text says 2 adapter(s) ship and the table registers 1');
  });

  it('reports an adapter named in the feature summary that the table does not register', () => {
    // The direction the limitation bullets cannot cover: the summary promises
    // an adapter that was never in the table at all. Both languages can say it
    // in the same words — `readme-parity.test.ts` stays green — and the reader
    // still cannot find it in the build.
    const problems = candidateProblems(withProse('en', [...fixtureFacts.proseIds.en!, 'anthropic']));
    expect(problems).toContain(
      'en: a "what it does" bullet talks about adapters and names `anthropic`, which the table does not register',
    );
    // And the summary naming *fewer* adapters than the table stays allowed.
    expect(
      candidateProblems({ ...fixtureFacts, proseIds: { en: ['universal'], zh: ['mock'] } }),
    ).toEqual([]);
    // The rule is the word "adapter", not the shape of the token: this is the
    // sentence that produced the red this gate must not produce.
    expect(
      adapterIdsInProse('### 它能做什么\n\n- **决策可解释。** 记录 `rationale` 与 `confidence`。\n', ZH_PROSE_HEADING),
    ).toEqual([]);
    // …while a bullet that does talk about adapters is read.
    expect(
      adapterIdsInProse('### 它能做什么\n\n- **任意厂商。** `anthropic` 适配器不在本版本内。\n', ZH_PROSE_HEADING),
    ).toEqual(['anthropic']);
  });

  it('reports a feature summary that vanished', () => {
    const problems = candidateProblems({
      ...fixtureFacts,
      proseIds: { en: undefined, zh: undefined },
    });
    expect(problems).toContain(
      'en: the "what it does" section is missing, so the adapter ids it names are unchecked',
    );
    expect(problems).toContain(
      'zh: the "what it does" section is missing, so the adapter ids it names are unchecked',
    );
  });

  it('reports a paragraph that stopped stating a count', () => {
    const problems = candidateProblems(
      withBullet(
        'en',
        'The bundled adapter speaks the OpenAI-compatible protocol. `universal` and `mock` ship.',
      ),
    );
    expect(problems).toContain(
      `en: the adapter text no longer states how many adapters ship (looked for ${COUNT_SPELLINGS})`,
    );
  });

  it('reads the count whether it is spelled with a word or a numeral', () => {
    // The false red this used to produce: "2 个适配器" is the same sentence as
    // "两个适配器", and it was reported as no count at all.
    expect(statedCount('Two adapters are registered — `universal`, `mock`.', 'en')).toBe(2);
    expect(statedCount('2 adapters are registered — `universal`, `mock`.', 'en')).toBe(2);
    expect(statedCount('随包同时注册 `universal` 与 `mock` 两个适配器。', 'zh')).toBe(2);
    expect(statedCount('随包同时注册 `universal` 与 `mock` 2 个适配器。', 'zh')).toBe(2);
    expect(statedCount('随包同时注册 `universal` 与 `mock` 2个适配器。', 'zh')).toBe(2);
    // A count word outside the table is still "a count we cannot read", not a
    // number the checks then compare.
    expect(statedCount('Several adapters are registered.', 'en')).toBeUndefined();
  });
});

/**
 * A stand-in README whose first "Current limitations" bullet is *not* the
 * adapter one — the shape a new limitation inserted above it produces.
 */
const README_WITH_LEADING_BULLET = [
  '### Current limitations',
  '',
  '- **The installer is unsigned.** Windows SmartScreen warns on first run.',
  '- **One provider protocol ships.** Two adapters are registered — `universal`, `mock`.',
  '',
].join('\n');

describe('the adapter bullet is identified, not assumed', () => {
  it('reports the wrong bullet when a new limitation is inserted above it', () => {
    // Same helper, a README whose adapter paragraph moved down: the gate reads
    // the unsigned-installer bullet. Without the assertion above that shows up
    // as "the adapter text does not name `universal`" — a true statement about
    // the wrong sentence — so this pins what the helper does with the shape
    // the README is about to have.
    const leading = providerBullet(README_WITH_LEADING_BULLET, EN_HEADING);
    expect(leading).toBeDefined();
    expect(leading).not.toMatch(ADAPTER_WORD);
    // …and it is the sentence the count check would then read, which states no
    // count at all: the two failure messages point at a bullet that has nothing
    // to do with adapters.
    expect(statedCount(leading!, 'en')).toBeUndefined();
  });
});

/**
 * `ADAPTER_CANDIDATES`'s declaration order is behaviour, not presentation.
 *
 * `bootstrap.ts` walks `Object.entries(ADAPTER_CANDIDATES)`, so the order of
 * the keys in that object literal is the order the app tries adapters: which
 * one wins when both resolve, which id a resolution failure names first, and
 * the order of the "adapters resolved" log line a person reads in a bug
 * report. Until this suite existed, that contract lived only in the phrase
 * "in the order they are tried" in the module's doc comment, and `tsc` sees
 * an object literal as unordered — so reordering the table was silently
 * legal, and so was adding an adapter without saying where it belongs in the
 * sequence.
 *
 * `ADAPTER_LOAD_ORDER` writes the order down a second time; these checks keep
 * the two copies equal. The constant's type already ties each entry to a key
 * of the table, so a rename or a removal is a compile error; an *addition* is
 * only visible here, which is why the comparison is equality of the whole
 * list in both directions rather than a subset test.
 */
describe('ADAPTER_CANDIDATES is tried in the order ADAPTER_LOAD_ORDER states', () => {
  it('declares the table in the documented order', () => {
    expect(
      Object.keys(ADAPTER_CANDIDATES),
      'the table declaration order and ADAPTER_LOAD_ORDER disagree',
    ).toEqual([...ADAPTER_LOAD_ORDER]);
  });

  it('keeps the order list exhaustive and duplicate-free', () => {
    // A subset check on the other side: every adapter in the table is named in
    // the order list exactly once. `toEqual` above already implies this, but
    // the message here says *which* adapter was forgotten, and a duplicated id
    // in the order list would make the attempt order ambiguous.
    expect([...ADAPTER_LOAD_ORDER].sort()).toEqual(Object.keys(ADAPTER_CANDIDATES).sort());
    expect(new Set(ADAPTER_LOAD_ORDER).size).toBe(ADAPTER_LOAD_ORDER.length);
  });

  it('is what a reordered table would break', () => {
    // The counter-example, so the two assertions above are known to be able to
    // fail: an alphabetised table — the exact edit a tidy-up PR makes — is a
    // different attempt order and is reported as one.
    const alphabetised = { mock: ADAPTER_CANDIDATES.mock, universal: ADAPTER_CANDIDATES.universal };
    expect(Object.keys(alphabetised)).not.toEqual([...ADAPTER_LOAD_ORDER]);
    // …and a table that grew without the order list growing with it is
    // reported by the exhaustive check, not by the equality one alone.
    const grown = { ...ADAPTER_CANDIDATES, anthropic: '@ucad/adapter-anthropic' };
    expect([...ADAPTER_LOAD_ORDER].sort()).not.toEqual(Object.keys(grown).sort());
  });
});

describe('bootstrap.ts loads the table, not a copy of it', () => {
  beforeAll(() => {
    expect(bootstrap, `bootstrap.ts is missing (${BOOTSTRAP_PATH})`).not.toBe('');
  });

  it('reads ADAPTER_CANDIDATES', () => {
    expect(bootstrap).toContain('ADAPTER_CANDIDATES');
  });

  it('names no adapter package itself', () => {
    // A second copy of the list in `bootstrap.ts` would keep this gate green
    // while the app loaded a different set: the table would describe the
    // README, and the code would describe itself.
    expect(
      bootstrap.match(/@ucad\/adapter-[a-z-]+/g) ?? [],
      'bootstrap.ts spells out an adapter package; add it to ADAPTER_CANDIDATES instead',
    ).toEqual([]);
  });
});
