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
 *  - the count word the bullet states ("Two adapters are registered",
 *    "两个适配器") equals the table's size, because "Two" going stale is the
 *    same defect one sentence earlier;
 *  - every specifier in the table names a package that exists in this repo,
 *    so a candidate cannot point at a package nobody ships; and
 *  - `bootstrap.ts` still reads the table rather than re-inlining it, because
 *    a copied list would leave this gate green while the app loaded something
 *    else.
 *
 * The gate reads identifiers out of one bullet, not the whole README: a
 * backticked token there that is not an adapter id would be reported as an
 * extra adapter, which is the failure mode to keep in mind when editing that
 * paragraph. A whole-README scan would have to guess whether `` `https` `` is
 * an adapter, and a gate that guesses gets switched off.
 *
 * Deliberately **not** asserted: that the two languages say the same thing
 * about the adapters (that is `readme-parity.test.ts`), or anything about how
 * the sentences read.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ADAPTER_CANDIDATES } from '../../apps/desktop/src/main/adapter-candidates';

const here = import.meta.dirname;
const REPO_ROOT = join(here, '..', '..');
const README_PATH = join(REPO_ROOT, 'README.md');
const BOOTSTRAP_PATH = join(REPO_ROOT, 'apps', 'desktop', 'src', 'main', 'bootstrap.ts');
const PACKAGES_DIR = join(REPO_ROOT, 'packages');

const readme = existsSync(README_PATH) ? readFileSync(README_PATH, 'utf8') : '';
const bootstrap = existsSync(BOOTSTRAP_PATH) ? readFileSync(BOOTSTRAP_PATH, 'utf8') : '';

const EN_HEADING = '### Current limitations';
const ZH_HEADING = '### 当前局限';

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

/**
 * The count the bullet states, or `undefined` when it stopped stating one.
 *
 * Two patterns, one per language, because the two sections spell it
 * differently: "Two adapters are registered" counts forward, "两个适配器"
 * counts after the ids. Returns `NaN`-free numbers only; a word outside the
 * table is reported as an unreadable count rather than silently skipped.
 */
function statedCount(bullet: string, lang: Lang): number | undefined {
  const match =
    lang === 'en'
      ? /(\w+)\s+adapters?\s+(?:are|is)\s+registered/i.exec(bullet)
      : /([一二两三四五六七八九十]+)\s*个适配器/.exec(bullet);
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

/** What the checks read: the two bullets, the table, and the repo's packages. */
interface Facts {
  readonly bullets: Record<Lang, string | undefined>;
  readonly candidates: Readonly<Record<string, string>>;
  readonly packages: readonly string[];
}

/**
 * Every way the README's adapter paragraph and the table can disagree.
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
        `${lang}: the adapter text no longer states how many adapters ship (looked for "N adapters are registered" / "N 个适配器")`,
      );
    } else if (count !== ids.length) {
      problems.push(
        `${lang}: the adapter text says ${count} adapter(s) ship and the table registers ${ids.length}`,
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

/** The real README, split into the two bullets the gate reads. */
const facts: Facts = {
  bullets: {
    en: providerBullet(readme, EN_HEADING),
    zh: providerBullet(readme, ZH_HEADING),
  },
  candidates: ADAPTER_CANDIDATES,
  packages: workspacePackages(),
};

describe('README adapter paragraph ↔ ADAPTER_CANDIDATES', () => {
  it.skipIf(readme === '')('reads both paragraphs, so the checks below are not vacuous', () => {
    // A renamed heading or a reordered bullet would leave the checks comparing
    // an empty string, which matches nothing — and, with an empty table, it
    // would match everything.
    expect(facts.bullets.en, `the README no longer has a "${EN_HEADING}" section`).toBeDefined();
    expect(facts.bullets.zh, `the README no longer has a "${ZH_HEADING}" section`).toBeDefined();
    expect(Object.keys(ADAPTER_CANDIDATES).length, 'the table names no adapters').toBeGreaterThan(
      0,
    );
    // The ids have to survive the shape filter, otherwise "no extra adapters"
    // would pass for the wrong reason.
    expect(adapterIdsIn(facts.bullets.en!), 'no adapter id was read out of the English bullet')
      .not.toEqual([]);
    expect(adapterIdsIn(facts.bullets.zh!), 'no adapter id was read out of the Chinese bullet')
      .not.toEqual([]);
  });

  it.skipIf(readme === '')('states the same adapters, in both languages and in the table', () => {
    const problems = candidateProblems(facts);
    expect(
      problems,
      `the README and the adapter table disagree:\n  ${problems.join('\n  ')}`,
    ).toEqual([]);
  });

  it('reports an adapter added to the table and not to the README', () => {
    // The next vendor adapter: the table grows, the prose does not.
    const problems = candidateProblems({
      ...facts,
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
    const problems = candidateProblems({ ...facts, candidates: { universal: '@ucad/adapter-universal' } });
    expect(problems).toContain(
      'en: the adapter text names `mock`, which the table does not register',
    );
    expect(problems).toContain(
      'zh: the adapter text names `mock`, which the table does not register',
    );
    expect(problems).toContain('en: the adapter text says 2 adapter(s) ship and the table registers 1');
  });

  it('reports a paragraph that stopped stating a count', () => {
    const problems = candidateProblems({
      ...facts,
      bullets: {
        en: 'The bundled adapter speaks the OpenAI-compatible protocol. `universal` and `mock` ship.',
        zh: facts.bullets.zh,
      },
    });
    expect(problems).toContain(
      'en: the adapter text no longer states how many adapters ship (looked for "N adapters are registered" / "N 个适配器")',
    );
  });
});

describe('bootstrap.ts loads the table, not a copy of it', () => {
  it.skipIf(bootstrap === '')('reads ADAPTER_CANDIDATES', () => {
    expect(bootstrap).toContain('ADAPTER_CANDIDATES');
  });

  it.skipIf(bootstrap === '')('names no adapter package itself', () => {
    // A second copy of the list in `bootstrap.ts` would keep this gate green
    // while the app loaded a different set: the table would describe the
    // README, and the code would describe itself.
    expect(
      bootstrap.match(/@ucad\/adapter-[a-z-]+/g) ?? [],
      'bootstrap.ts spells out an adapter package; add it to ADAPTER_CANDIDATES instead',
    ).toEqual([]);
  });
});
