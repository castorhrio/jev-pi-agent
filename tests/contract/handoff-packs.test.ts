/**
 * The two handoff packs, and the lines they quote from the commands they hand off.
 *
 * ## Why this file exists
 *
 * Two of the three external blockers in `docs/blockers.md` are not waiting on
 * code — they are waiting on a person with a token and a person with a Windows
 * machine. `docs/blockers.md` says what to run and where the result goes, in one
 * paragraph each. That is enough to *understand* the blocker and not enough to
 * *execute* it: the person who picks one up is, by construction, someone who has
 * not read this repository, and the two things they need are a page they can
 * follow top to bottom and a way to tell "it worked" from "it printed something".
 *
 * So each blocker now has a pack:
 *
 *  - `docs/release/REPLACE-FEED.md` — replacing the published v1.0.0 feed asset;
 *  - `docs/manual-verification/README.md` — carrying a Windows run home.
 *
 * Both are prose, and prose about a command's output is coupled to the command by
 * nothing at all. That is the defect this file is for, and it is the same one
 * `manual-check-docs.test.ts` closed one level down: a document that quotes
 * `PASS — … now carries sha256=…` keeps reading as verified after the script's
 * message is reworded, and the reader who follows it concludes they are looking
 * at the wrong output. The flags are already pinned there; the *sentences* are
 * pinned here.
 *
 * ## What is checked
 *
 *  - both packs exist and are not empty;
 *  - every expected-output line a pack quotes is still in the source of the
 *    script that prints it — so a reworded message is a red run, not a stale
 *    document;
 *  - the return path a pack names (`docs/manual-verification/`) is a directory
 *    that exists, because a pack that sends a reader to a path they have to
 *    create is a pack that half-works;
 *  - the report naming convention `win-YYYYMMDD.json` is **one literal** in
 *    every document that names it, since three documents spelling three
 *    conventions is how a carried-home report gets filed where nobody looks;
 *  - `docs/blockers.md` — the page a reader starts from — leads to both packs.
 *
 * ## What is deliberately not asserted
 *
 * Wording, ordering, or that the commands work. The commands' flags belong to
 * `manual-check-docs.test.ts`, and the one blocker that can be exercised on this
 * machine is run by `replay-feed-local.test.ts`. This file only keeps the packs
 * from drifting away from the scripts they describe.
 *
 * The checks are pure functions of `(documents, sources, filesystem)`, so the
 * red direction is driven with mutated copies rather than argued about: a gate
 * whose failure path has never run is a gate that might be reporting `[]`
 * whatever it is handed.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(import.meta.dirname, '..', '..');

/** The directory a carried-home Windows report is filed in. */
const RETURN_DIR = 'docs/manual-verification';

/** The one spelling of a report's filename, in every document that names one. */
const REPORT_NAME = 'win-YYYYMMDD.json';

/** One line a pack quotes from a script's output, and the script that prints it. */
interface Quote {
  /** Repository-relative path of the script whose output is quoted. */
  readonly script: string;
  /** The quoted text, verbatim — the fragment, not the whole line. */
  readonly text: string;
}

/** One handoff pack: a page a reader follows, and what it promises they will see. */
interface Pack {
  /** Repository-relative path of the pack. */
  readonly path: string;
  /** The lines it quotes from commands, each with the script that prints it. */
  readonly quotes: readonly Quote[];
}

/**
 * The two packs, and the output lines each one promises.
 *
 * The fragments are the load-bearing half of each sentence: `now carries
 * sha256=` is what makes the publish line a verdict rather than a log line, and
 * `a claim, not a result` is the one judgement a carried-home report can fail.
 * Quoting the whole line would pin whitespace and punctuation that no reader
 * depends on; quoting nothing would pin the document to the script by habit.
 */
const PACKS: readonly Pack[] = [
  {
    path: 'docs/release/REPLACE-FEED.md',
    quotes: [
      { script: 'scripts/publish-feed.mjs', text: 'check 1 (already ran, before any token was read)' },
      { script: 'scripts/publish-feed.mjs', text: 'dry run — nothing was fetched and nothing was uploaded' },
      { script: 'scripts/publish-feed.mjs', text: 'now carries sha256=' },
      { script: 'scripts/publish-feed.mjs', text: 'blocked: no GitHub write token' },
      // The preflight step: the two lines a reader uses to tell "the published
      // feed is still broken" from "the host never answered", and the one that
      // says the run wrote nothing. A reworded verdict would leave the page
      // quoting a sentence the command no longer prints.
      { script: 'scripts/publish-feed.mjs', text: 'the published feed is still the broken one' },
      { script: 'scripts/publish-feed.mjs', text: 'writes: none — this run only read the published document' },
      { script: 'scripts/verify-release-feed.mjs', text: 'warning(s), nothing the app would refuse' },
    ],
  },
  {
    path: 'docs/manual-verification/README.md',
    quotes: [
      { script: 'scripts/verify-main-chain.mjs', text: 'the report covers steps' },
      { script: 'scripts/verify-main-chain.mjs', text: 'this judges what the file says, not that the run happened' },
      { script: 'scripts/verify-main-chain.mjs', text: 'a run on another platform is a real result about that platform' },
      { script: 'scripts/verify-main-chain.mjs', text: 'the row stays open' },
      { script: 'scripts/verify-main-chain.mjs', text: 'is not in the report' },
      { script: 'scripts/verify-main-chain.mjs', text: 'a claim, not a result' },
      // The boundary the pack used to leave to the reader's imagination: the
      // three screenshots sit next to the report and are the one part of the
      // pack `--judge` cannot read. The sentence is printed by the command, so
      // a pack that starts promising the images are checked goes red here
      // rather than being discovered by whoever trusted it.
      {
        script: 'scripts/verify-main-chain.mjs',
        text: 'the three screenshots a run carries home are evidence for a reader',
      },
    ],
  },
];

/** The documents the convention check reads: every one that names a report file. */
const CONVENTION_DOCUMENTS = [
  'docs/blockers.md',
  'docs/manual-verification.md',
  `${RETURN_DIR}/README.md`,
] as const;

/** The page a reader starts from, which has to lead to both packs. */
const BLOCKERS_PATH = 'docs/blockers.md';

const read = (relativePath: string): string =>
  existsSync(join(REPO_ROOT, relativePath)) ? readFileSync(join(REPO_ROOT, relativePath), 'utf8') : '';

/** What the checks compare the packs against. */
interface Repository {
  /** The text of a repository-relative document, or `''` when it is not there. */
  readonly document: (relativePath: string) => string;
  /** The source of a repository-relative script, or `null` when it is not there. */
  readonly scriptSource: (relativePath: string) => string | null;
  /** Whether a repository-relative path is a directory. */
  readonly isDirectory: (relativePath: string) => boolean;
}

/**
 * Every way a pack can promise output that its script no longer prints.
 *
 * Both directions are reported, because they need different fixes: a quote the
 * pack dropped is a pack that stopped telling the reader what success looks
 * like, and a quote the script dropped is a pack that now describes a message
 * nobody will ever see. Collapsing them into one "mismatch" would leave the
 * reader to work out which side moved.
 */
function quoteProblems(packs: readonly Pack[], repository: Repository): string[] {
  const problems: string[] = [];
  for (const pack of packs) {
    const text = repository.document(pack.path);
    if (text.trim().length === 0) {
      problems.push(`${pack.path}: is missing or empty, so the blocker it hands off has no page`);
      continue;
    }
    for (const quote of pack.quotes) {
      if (!text.includes(quote.text)) {
        problems.push(
          `${pack.path}: no longer quotes "${quote.text}", so the reader is not told what ` +
            `${quote.script} prints when it works`,
        );
      }
      const source = repository.scriptSource(quote.script);
      if (source === null) {
        problems.push(`${pack.path}: quotes ${quote.script}, which is not in the repository`);
        continue;
      }
      if (!source.includes(quote.text)) {
        problems.push(
          `${pack.path}: quotes "${quote.text}" from ${quote.script}, and that script no longer ` +
            'prints it — the pack describes output nobody will see',
        );
      }
    }
  }
  return problems;
}

/**
 * Every way a pack sends a reader somewhere that is not there.
 *
 * The return directory is the one path a pack asks the reader to *write* to, so
 * it is the one path that has to exist before they arrive: a reader who has to
 * create it is a reader deciding the name for themselves, and the next reader
 * looks in the place the document named.
 */
function returnPathProblems(packs: readonly Pack[], repository: Repository): string[] {
  const problems: string[] = [];
  if (!repository.isDirectory(RETURN_DIR)) {
    problems.push(
      `${RETURN_DIR}/: is not a directory, so the packs send a reader to a path they have to invent`,
    );
  }
  for (const pack of packs) {
    if (!repository.document(pack.path).includes(RETURN_DIR)) {
      problems.push(`${pack.path}: does not name ${RETURN_DIR}/, so its result has no home`);
    }
  }
  return problems;
}

/**
 * Every document that names a report file under a different convention.
 *
 * One literal, three documents. The failure this prevents is quiet: a report
 * filed as `win-2026-11-05.json` because one document spelled it that way is a
 * report the next reader does not find, and nothing about the run was wrong.
 */
function conventionProblems(documents: readonly string[], literal: string): string[] {
  const problems: string[] = [];
  for (const text of documents) {
    if (text.trim().length === 0) {
      problems.push('a document that names a report file is missing or empty');
      continue;
    }
    if (!text.includes(literal)) {
      problems.push(`a document names a report file but not as \`${literal}\``);
    }
  }
  return problems;
}

/** Every pack the starting page does not lead to. */
function pointerProblems(blockers: string, packs: readonly Pack[]): string[] {
  if (blockers.trim().length === 0) {
    return [`${BLOCKERS_PATH}: is missing or empty, so nothing leads to the packs`];
  }
  return packs
    .filter((pack) => !blockers.includes(pack.path))
    .map((pack) => `${BLOCKERS_PATH}: does not name ${pack.path}, so the pack is reachable only by luck`);
}

const REPOSITORY: Repository = {
  document: read,
  scriptSource: (relativePath) => {
    const absolute = join(REPO_ROOT, relativePath);
    return existsSync(absolute) ? readFileSync(absolute, 'utf8') : null;
  },
  isDirectory: (relativePath) => {
    const absolute = join(REPO_ROOT, relativePath);
    return existsSync(absolute) && statSync(absolute).isDirectory();
  },
};

describe('the two handoff packs', () => {
  it('exist, and quote output their scripts still print', () => {
    const problems = quoteProblems(PACKS, REPOSITORY);
    expect(problems, `the packs and the scripts disagree:\n  ${problems.join('\n  ')}`).toEqual([]);
  });

  it('send the reader to a directory that is already there', () => {
    const problems = returnPathProblems(PACKS, REPOSITORY);
    expect(problems, `the packs name a home that is not there:\n  ${problems.join('\n  ')}`).toEqual(
      [],
    );
  });

  it('spell the report filename one way in every document that names it', () => {
    const problems = conventionProblems(
      CONVENTION_DOCUMENTS.map((path) => read(path)),
      REPORT_NAME,
    );
    expect(
      problems,
      `the documents spell the report filename differently:\n  ${problems.join('\n  ')}`,
    ).toEqual([]);
  });

  it('are reachable from the page a reader starts on', () => {
    const problems = pointerProblems(read(BLOCKERS_PATH), PACKS);
    expect(problems, `the blocker page does not lead to the packs:\n  ${problems.join('\n  ')}`).toEqual(
      [],
    );
  });

  it('is not vacuous: the packs really carry the quotes being compared', () => {
    // Without this, a refactor that emptied `PACKS` would leave every case above
    // passing over nothing at all.
    expect(PACKS.length).toBe(2);
    for (const pack of PACKS) {
      expect(pack.quotes.length, `${pack.path} has no quotes to check`).toBeGreaterThan(2);
      expect(read(pack.path).length, `${pack.path} is empty`).toBeGreaterThan(500);
    }
    // And the extractor reads the real documents, rather than the files being
    // green because nothing matched.
    expect(read('docs/release/REPLACE-FEED.md')).toContain('node scripts/publish-feed.mjs');
    expect(read(`${RETURN_DIR}/README.md`)).toContain('node scripts/verify-main-chain.mjs');
  });
});

describe('the checks above, when the repository has drifted', () => {
  it('reports a quote the script no longer prints', () => {
    // The failure this file is for: the message is reworded in the script, the
    // pack keeps quoting the old one, and the reader who follows the pack
    // concludes they are looking at the wrong output.
    const pack: Pack = {
      path: 'docs/release/REPLACE-FEED.md',
      quotes: [{ script: 'scripts/publish-feed.mjs', text: 'now carries sha256=' }],
    };
    const problems = quoteProblems([pack], {
      document: () => 'PASS — update-feed.json now carries sha256=…',
      scriptSource: () => 'out(`PASS — ${ASSET_NAME} on ${repo} ${tag} now carries a digest`);',
      isDirectory: () => true,
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('no longer prints it');
  });

  it('reports a quote the pack dropped', () => {
    const pack: Pack = {
      path: 'docs/release/REPLACE-FEED.md',
      quotes: [{ script: 'scripts/publish-feed.mjs', text: 'now carries sha256=' }],
    };
    const problems = quoteProblems([pack], {
      document: () => 'run it and look at the output',
      scriptSource: () => 'out(`PASS — … now carries sha256=${document.sha256}`);',
      isDirectory: () => true,
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('no longer quotes');
  });

  it('reports a pack that is missing altogether', () => {
    const problems = quoteProblems(PACKS, {
      document: () => '',
      scriptSource: () => '',
      isDirectory: () => true,
    });
    expect(problems).toHaveLength(PACKS.length);
    expect(problems[0]).toContain('is missing or empty');
  });

  it('reports a return directory that does not exist', () => {
    const problems = returnPathProblems(PACKS, {
      document: () => `put it in ${RETURN_DIR}/`,
      scriptSource: () => '',
      isDirectory: () => false,
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('is not a directory');
  });

  it('reports a document that spells the report filename its own way', () => {
    const problems = conventionProblems(
      [`put it in ${RETURN_DIR}/win-2026-11-05.json`, `put it in ${RETURN_DIR}/${REPORT_NAME}`],
      REPORT_NAME,
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(REPORT_NAME);
  });

  it('reports a blocker page that leads to only one pack', () => {
    const problems = pointerProblems('see docs/release/REPLACE-FEED.md', PACKS);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('docs/manual-verification/README.md');
  });
});
