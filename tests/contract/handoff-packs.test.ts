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

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
      // The rehearsal section: the two lines that say what the block is. A page
      // that quoted a rehearsal without saying it touches nothing would read as
      // a run that had already happened, which is the one thing it is not.
      { script: 'scripts/publish-feed.mjs', text: 'this run touches nothing' },
      { script: 'scripts/publish-feed.mjs', text: 'verdict: the runbook is complete' },
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
      // The red sample the pack now shows next to the green one. A reader who
      // has never seen a red run has to be able to tell "the report is red"
      // from "the command did not run", and the two lines that say which are
      // the verdict and the note under it.
      { script: 'scripts/verify-main-chain.mjs', text: 'thing(s) in this report keep the row open' },
      { script: 'scripts/verify-main-chain.mjs', text: 'a red report is still evidence' },
    ],
  },
];

/**
 * The one command that turns a run into something a reader can open.
 *
 * The pack used to end at "carry the report home", which is a sentence, not a
 * step: the person on the Windows machine has a report, three screenshots and a
 * log file in three different places, and decides for themselves what to send.
 * The next reader then gets a JSON with no screenshots, or a zip with a report
 * filed under a name nobody looks for. So the pack carries one archiver command
 * per platform, and this is what it has to put in the archive.
 */
const PACKAGING = {
  path: 'docs/manual-verification/README.md',
  /** The archiver a Windows reader has without installing anything. */
  archiver: 'Compress-Archive',
  /** The portable alternative, for a reader on git-bash, WSL or Linux. */
  fallback: 'tar -czf',
  /** What the archive has to contain: the report and the three screenshots. */
  members: [
    /win-\d{8}\.json/,
    /win-\d{8}-dpapi\.png/,
    /win-\d{8}-tray\.png/,
    /win-\d{8}-nsis\.png/,
  ],
} as const;

/**
 * Every way the pack's packaging command fails to carry the run home.
 *
 * Checked per line rather than over the whole page: a page that names the
 * screenshots in one paragraph and archives only the report in another reads as
 * complete and produces a zip with one file in it.
 */
function packagingProblems(document: string, packaging: typeof PACKAGING): string[] {
  const problems: string[] = [];
  if (document.trim().length === 0) {
    return [`${packaging.path}: is missing or empty, so there is no command to check`];
  }
  const lines = document
    .split('\n')
    .filter((line) => line.includes(packaging.archiver) || line.includes(packaging.fallback));
  if (lines.length === 0) {
    return [
      `${packaging.path}: gives no \`${packaging.archiver}\` or \`${packaging.fallback}\` command, ` +
        'so "carry it home" is a sentence rather than a step',
    ];
  }
  for (const line of lines) {
    for (const member of packaging.members) {
      if (member.test(line)) continue;
      problems.push(
        `${packaging.path}: the packaging command does not include ${member.source}, so the ` +
          'archive it produces is missing part of the run',
      );
    }
  }
  return problems;
}

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

  it('carry one command that puts the whole run in an archive', () => {
    const problems = packagingProblems(read(PACKAGING.path), PACKAGING);
    expect(
      problems,
      `the pack's packaging command does not carry the run home:\n  ${problems.join('\n  ')}`,
    ).toEqual([]);
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

/**
 * The archive the pack's command actually produces.
 *
 * `packagingProblems` reads the command as text: it can say "this line names the
 * report and the three screenshots", and it cannot say "running it produces an
 * archive with those five files in it". Those are different claims, and the
 * second one is the one the reader depends on — a `tar` invocation with a typo
 * in a filename still contains every member name the text check looks for, and
 * fails at the moment somebody is standing over a Windows machine that is about
 * to be shut down.
 *
 * So this case runs the documented command for real, against a fixture report
 * and three placeholder images, and lists the archive it produced. The
 * PowerShell line is checked as text only — there is no PowerShell on this
 * machine, and pretending otherwise would be the kind of green this repository
 * keeps removing.
 */
const FIXTURE_REPORT = 'tests/fixtures/judge/green.json';

/** A 1x1 PNG: enough for `tar` to carry a file named `*.png`, and nothing more. */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/** The date the pack's examples use, so the fixture files carry the same names. */
const PACK_DATE = '20261105';

/** The log file the command carries, at the path the pack says the app writes it. */
const LOG_PATH = 'ucad-main-chain/AppData/Roaming/ucad/logs/app.log';

describe('the packaging command really puts the run in an archive', () => {
  it('produces an archive containing the report, the three screenshots and the log', () => {
    const document = read(PACKAGING.path);
    const line = document
      .split('\n')
      .map((candidate) => candidate.trim())
      .find((candidate) => candidate.startsWith(PACKAGING.fallback));
    expect(line, `${PACKAGING.path} no longer carries a \`${PACKAGING.fallback}\` command`).toBeDefined();

    const dir = mkdtempSync(join(tmpdir(), 'ucad-pack-'));
    try {
      copyFileSync(join(REPO_ROOT, FIXTURE_REPORT), join(dir, `win-${PACK_DATE}.json`));
      for (const suffix of ['dpapi', 'tray', 'nsis']) {
        writeFileSync(join(dir, `win-${PACK_DATE}-${suffix}.png`), TINY_PNG);
      }
      mkdirSync(join(dir, 'ucad-main-chain', 'AppData', 'Roaming', 'ucad', 'logs'), { recursive: true });
      writeFileSync(join(dir, LOG_PATH), 'tray menu built\n');

      // The command is run as written, with `$TMPDIR` pointed at the scratch
      // directory: the pack's line is the thing under test, not a copy of it.
      const packed = spawnSync('bash', ['-c', line!], {
        cwd: dir,
        env: { ...process.env, TMPDIR: dir },
        encoding: 'utf8',
      });
      expect(packed.status, `the pack's command failed:\n${packed.stderr}`).toBe(0);

      const listed = spawnSync('tar', ['-tzf', `win-${PACK_DATE}.tar.gz`], {
        cwd: dir,
        encoding: 'utf8',
      });
      expect(listed.status, `the archive could not be listed:\n${listed.stderr}`).toBe(0);
      const members = listed.stdout.split('\n').filter((member) => member.length > 0);

      for (const member of PACKAGING.members) {
        expect(
          members.some((name) => member.test(name)),
          `the archive has no member matching ${member.source}: ${members.join(', ')}`,
        ).toBe(true);
      }
      expect(
        members.some((name) => name.endsWith('app.log')),
        `the archive carries no application log: ${members.join(', ')}`,
      ).toBe(true);
      // Five files, not "at least the ones we looked for": a command that
      // archives the whole directory would pass the checks above and ship a
      // scratch tree to the next reader.
      expect(members, `the archive carries ${members.length} member(s)`).toHaveLength(5);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

  it('reports a packaging command that archives only the report', () => {
    // The failure this check is for: the page still says "carry the report
    // home", the command still runs, and the zip has one file in it — so the
    // reader gets a verdict with none of the evidence behind it.
    const problems = packagingProblems(
      'Compress-Archive -Path win-20261105.json -DestinationPath win-20261105.zip',
      PACKAGING,
    );
    expect(problems).toHaveLength(3);
    expect(problems[0]).toContain('missing part of the run');
  });

  it('reports a pack that stopped giving a packaging command at all', () => {
    const problems = packagingProblems('carry the report home', PACKAGING);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('is a sentence rather than a step');
  });

  it('reports a blocker page that leads to only one pack', () => {
    const problems = pointerProblems('see docs/release/REPLACE-FEED.md', PACKS);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('docs/manual-verification/README.md');
  });
});
