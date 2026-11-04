/**
 * The manual packaged-adapter check, as one command every document spells the
 * same way.
 *
 * ## Why this file exists
 *
 * The check itself is now a script with tests (`verify-packaged-adapters.test.ts`,
 * `scripts/verify-packaged-adapters.mjs`), and the documents have been brought
 * in line with it by hand: `README.md` in both languages and `CONTRIBUTING.md`
 * each tell the reader to run `npm run package` and then `node
 * scripts/verify-packaged-adapters.mjs`. That last sentence is the fragile part.
 *
 * The instructions are prose, and prose about a filename is coupled to the
 * filesystem by nothing at all. Rename or move the script and every gate here
 * stays green while three documents tell the reader to run a command that exits
 * with `MODULE_NOT_FOUND` — the same shape of failure the check was written to
 * end ("read the line it prints" was another instruction that nobody re-verified
 * after the code changed). A command that does not exist is a worse instruction
 * than a vague one: it looks authoritative and fails at the shell.
 *
 * So this file compares the documents to the repository:
 *
 *  - every `scripts/…` path a document names has to exist, and a mention the
 *    extractor cannot read — a path wrapped across a line, or split by markup —
 *    is reported instead of being skipped, because "the extractor read nothing"
 *    and "there is nothing to read" must not look the same in the document that
 *    was reflowed;
 *  - every `npm run …` a document names has to be a key in `package.json`;
 *  - every `--flag` a document puts after `node scripts/<name>.mjs` has to be a
 *    flag that script accepts, because a documented command with a stale flag
 *    is the same defect one level down: the reader types it, the script exits 1
 *    with `unknown option(s)`, and the document that sent them there is green;
 *  - the manual check is never named without `npm run package`, because the
 *    script refuses to run without the build that command writes; and
 *  - both language halves of the README carry the command, since a limitation
 *    that is actionable in one language and vague in the other is the defect
 *    `readme-parity.test.ts` exists for, one level down.
 *
 * The checks are a pure function of `(documents, filesystem, package.json)` so
 * the interesting case — a document pointing at something that is not there —
 * can be shown producing a failure instead of being argued about. Deliberately
 * not asserted: which documents mention the check at all, how often, or in what
 * words. Prose belongs to the people writing it; only the literals are pinned.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dirname, '..', '..');

/** The command the READMEs and CONTRIBUTING tell the operator to run. */
const MANUAL_COMMAND = 'node scripts/verify-packaged-adapters.mjs';

/** The script that command names, as it appears in a path reference. */
const MANUAL_SCRIPT = 'scripts/verify-packaged-adapters.mjs';

/** The command that produces the build the manual check launches. */
const PACKAGING_COMMAND = 'npm run package';

/** A document, as the checks see it: a name for messages and its text. */
interface Document {
  readonly name: string;
  readonly text: string;
}

/** What the documents are compared against. */
interface Repository {
  /** Whether a repository-relative path exists. */
  readonly fileExists: (relativePath: string) => boolean;
  /** The keys of `package.json#scripts`, i.e. what `npm run` can accept. */
  readonly npmScripts: readonly string[];
}

/**
 * A `scripts/…` path named in prose, e.g. `` `scripts/make-update-feed.mjs` ``.
 *
 * Both separators are read. The Windows rows in `docs/dod-status.md` and
 * `docs/manual-verification.md` spell the command the way a Windows reader
 * types it — `node scripts\verify-main-chain.mjs --exec …` — and a gate that
 * only understood `/` would be blind to the one platform whose row is still
 * open. The separator is normalised away by {@link scriptReferences}, so the
 * existence check still compares one path.
 */
const SCRIPT_REFERENCE = /\bscripts[\\/][\w.-]+\.(?:mjs|cjs|js|ts)\b/gu;

/** An `npm run <name>` the documents tell the reader to type. */
const NPM_RUN = /\bnpm run ([\w:.-]+)/gu;

/**
 * A command line that runs one of this repository's scripts.
 *
 * The `node ` prefix is part of the pattern on purpose. Without it, prose that
 * merely *names* a script would have its `--flags` read as command-line flags —
 * `docs/dod-status.md` writes `--measure-prose: 36em` (a CSS custom property)
 * on a line that names `scripts/layout-page-scripts.mjs`, and a gate that
 * reported that as a bad flag would be reporting its own extractor. A command
 * is what a reader can type, so a command is what is read.
 */
const SCRIPT_COMMAND = /\bnode\s+scripts[\\/]([\w.-]+\.(?:mjs|cjs|js|ts))\b/gu;

/** A `--flag` on such a line. */
const FLAG = /(?<![\w-])--([a-z][\w-]*)/gu;

function scriptReferences(text: string): string[] {
  // Normalised to `/` so a Windows-spelled command and a POSIX-spelled one are
  // one reference to one file, not two.
  return [...text.matchAll(SCRIPT_REFERENCE)].map((match) => match[0].replaceAll('\\', '/'));
}

function npmRunNames(text: string): string[] {
  return [...text.matchAll(NPM_RUN)].map((match) => match[1]!);
}

/**
 * Where a `scripts/` mention begins, without matching inside another token.
 *
 * The lookbehind keeps this off a path that merely contains `scripts/` as a
 * segment (`docs/scripts/…`), which is not a reference to this repository's
 * scripts directory.
 */
const SCRIPT_MENTION = /(?<![\w./\\-])scripts[\\/]/gu;

/**
 * `scripts/` mentions {@link scriptReferences} could not read, as quotable snippets.
 *
 * The extractor recognizes one form and only one: an unbroken literal such as
 * `` `scripts/verify-packaged-adapters.mjs` ``. That is a deliberate trade —
 * a fuzzy matcher that accepted any `scripts/` followed by anything would read
 * prose about "the scripts directory" as a file reference — but it has a blind
 * spot with the same shape as the defect this file exists for: a document that
 * wraps the path across a line (markdown does it for long lines) or splits it
 * with markup is *silently skipped* by the loop in `referenceProblems`, so the
 * rename it should have reported stays green in exactly the document that was
 * hardest to read.
 *
 * Closing that by widening the extractor would trade one false-negative shape
 * for a family of false positives. So the trade is made checkable instead: the
 * document may keep its prose, but a `scripts/` mention the extractor cannot
 * read is itself reported. The gate then says "I cannot read this line" rather
 * than quietly reading nothing.
 *
 * A snippet rather than the whole line, because the failure names a location:
 * `JSON.stringify` renders a newline as `\n`, which is the fact being
 * reported — the path is broken across lines.
 */
function unmatchedScriptMentions(text: string): string[] {
  const readable = new Set([...text.matchAll(SCRIPT_REFERENCE)].map((match) => match.index ?? -1));
  const mentions: string[] = [];
  for (const match of text.matchAll(SCRIPT_MENTION)) {
    const start = match.index ?? 0;
    if (readable.has(start)) continue;
    mentions.push(JSON.stringify(text.slice(start, start + 48)));
  }
  return mentions;
}

/**
 * Every way a document can name something that is not there.
 *
 * Empty means the documents agree with the repository. Deduplicated per
 * document, because a command repeated in a checklist and in a paragraph is one
 * fact about the repository, and reporting it twice makes the failure look
 * bigger than the fix.
 */
function referenceProblems(
  documents: readonly Document[],
  repository: Repository,
): string[] {
  const problems: string[] = [];

  for (const document of documents) {
    for (const reference of new Set(scriptReferences(document.text))) {
      if (repository.fileExists(reference)) continue;
      problems.push(`${document.name}: names \`${reference}\`, which is not in the repository`);
    }
    for (const script of new Set(npmRunNames(document.text))) {
      if (repository.npmScripts.includes(script)) continue;
      problems.push(
        `${document.name}: tells the reader to run \`npm run ${script}\`, which ` +
          '`package.json` does not define',
      );
    }
    // A mention the extractor cannot read is not silence: the loop above would
    // skip a wrapped path, so this says so instead of comparing nothing.
    for (const mention of new Set(unmatchedScriptMentions(document.text))) {
      problems.push(
        `${document.name}: mentions a path starting \`scripts/\` in a form this check cannot ` +
          `read (${mention}); keep it on one line, as a plain literal`,
      );
    }
    // The manual check and its precondition travel together: the script exits
    // with "run `npm run package` first" when there is no build, so a document
    // that only names the check sends the reader to that error message.
    if (document.text.includes(MANUAL_SCRIPT) && !document.text.includes(PACKAGING_COMMAND)) {
      problems.push(
        `${document.name}: names the packaged adapter check without ` +
          `\`${PACKAGING_COMMAND}\`, which is what produces the build it launches`,
      );
    }
  }

  return problems;
}

/** What the flag check compares the documents against. */
interface FlagRepository {
  /** The source of a repository-relative script, or null when it is not there. */
  readonly scriptSource: (relativePath: string) => string | null;
}

/** One documented command: the script it runs and the flags it passes. */
interface DocumentedCommand {
  readonly script: string;
  readonly flags: readonly string[];
}

/**
 * The commands a document tells the reader to type, one per line.
 *
 * A line naming two different scripts is skipped rather than guessed at: which
 * flag belongs to which command is not in the text, and a gate that attributed
 * them by position would report a defect the document does not have. The
 * boundary is stated here and pinned by a case below, because an extractor's
 * blind spot that nobody wrote down is how a gate goes quiet.
 */
function documentedCommands(text: string): DocumentedCommand[] {
  const commands: DocumentedCommand[] = [];
  for (const line of text.split('\n')) {
    const scripts = [...line.matchAll(SCRIPT_COMMAND)].map((match) => match[1]!);
    if (scripts.length === 0) continue;
    const flags = [...line.matchAll(FLAG)].map((match) => match[1]!);
    if (flags.length === 0) continue;
    const unique = [...new Set(scripts)];
    if (unique.length > 1) continue;
    commands.push({ script: `scripts/${unique[0]!}`, flags: [...new Set(flags)] });
  }
  return commands;
}

/**
 * Whether a script's source mentions this flag at all.
 *
 * Four shapes, because the scripts in this repository read their arguments in
 * four ways: a `KNOWN_FLAGS` array (`'apply'`), a `flag('judge', …)` helper, a
 * generic `parseArgs` whose result is read as `args.version`, and a bare
 * `argv.includes('--check')`. Any of them is evidence that the flag is real;
 * none of them is evidence about what it does, which is not this gate's job.
 */
function acceptsFlag(source: string, flag: string): boolean {
  return (
    source.includes(`'${flag}'`) ||
    source.includes(`"${flag}"`) ||
    source.includes(`.${flag}`) ||
    source.includes(`--${flag}`)
  );
}

/**
 * Every flag a document puts after a script that the script does not accept.
 *
 * Empty means the documented commands are commands the scripts would run. The
 * failure this exists for is one level below the missing-file case: the script
 * is there, the document is confident, and the reader gets
 * `unknown option(s): --aply` from a command the release notes told them to
 * type.
 */
function flagProblems(
  documents: readonly Document[],
  repository: FlagRepository,
): string[] {
  const problems: string[] = [];
  for (const document of documents) {
    for (const command of documentedCommands(document.text)) {
      const source = repository.scriptSource(command.script);
      // A script that is not there is already reported by `referenceProblems`;
      // reporting it twice would make one missing file look like two defects.
      if (source === null) continue;
      for (const flag of command.flags) {
        if (acceptsFlag(source, flag)) continue;
        problems.push(
          `${document.name}: tells the reader to run \`${command.script} --${flag}\`, and that ` +
            'script does not accept it',
        );
      }
    }
  }
  return problems;
}

/**
 * The two language halves of the README, split at their own headings.
 *
 * `undefined` when a heading is gone, on purpose: a README that dropped the
 * split would otherwise make "both halves say it" true of one half.
 */
function languageHalves(markdown: string): { en: string; zh: string } | undefined {
  const en = markdown.indexOf('## English');
  const zh = markdown.indexOf('## 中文');
  if (en === -1 || zh === -1 || zh < en) return undefined;
  return { en: markdown.slice(en, zh), zh: markdown.slice(zh) };
}

function readDocument(name: string): Document {
  return { name, text: readFileSync(join(REPO_ROOT, name), 'utf8') };
}

/**
 * Every document that tells a reader to run something.
 *
 * The manual verification checklist is included because it is the document a
 * release is signed off against: a renamed script there sends the person doing
 * the final pass to a command that does not exist, at the point where no gate
 * is left to catch it.
 */
const DOCUMENTS: readonly Document[] = [
  'README.md',
  'CONTRIBUTING.md',
  'docs/manual-verification.md',
  // The status document is where the three external blockers live, and each of
  // them is now stated as a command a reader can run. That is exactly the kind
  // of sentence that rots: the row keeps saying "run this" after the flag it
  // names was renamed, and the row is the last thing anyone re-reads.
  'docs/dod-status.md',
].map(readDocument);
const README = DOCUMENTS[0]!;

const PACKAGE_SCRIPTS: readonly string[] = Object.keys(
  (
    JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    }
  ).scripts,
);

const REPOSITORY: Repository = {
  fileExists: (relativePath) => existsSync(join(REPO_ROOT, relativePath)),
  npmScripts: PACKAGE_SCRIPTS,
};

const FLAG_REPOSITORY: FlagRepository = {
  scriptSource: (relativePath) => {
    const absolute = join(REPO_ROOT, relativePath);
    return existsSync(absolute) ? readFileSync(absolute, 'utf8') : null;
  },
};

describe('the commands the release documents tell a reader to run', () => {
  it('all name something that exists', () => {
    const problems = referenceProblems(DOCUMENTS, REPOSITORY);
    expect(
      problems,
      `the documents and the repository disagree:\n  ${problems.join('\n  ')}`,
    ).toEqual([]);
  });

  it('includes the manual packaged-adapter check, so the check above is not vacuous', () => {
    // Without this, a refactor that reworded every document into prose about
    // "the packaged check" would leave the comparison passing over nothing.
    expect(scriptReferences(README.text)).toContain(MANUAL_SCRIPT);
    expect(existsSync(join(REPO_ROOT, MANUAL_SCRIPT))).toBe(true);
    const contributing = DOCUMENTS[1]!.text;
    expect(scriptReferences(contributing)).toContain(MANUAL_SCRIPT);
    // The packaging command is a literal in both documents, not an implied
    // `npm run build`-and-hope.
    expect(README.text).toContain(PACKAGING_COMMAND);
    expect(contributing).toContain(PACKAGING_COMMAND);
    // And the extractor really reads them, rather than the file being green
    // because nothing matched.
    expect(npmRunNames(README.text).length).toBeGreaterThan(1);
  });

  it('states the manual check in both languages of the README', () => {
    const halves = languageHalves(README.text);
    expect(halves, 'README.md no longer has both `## English` and `## 中文`').toBeDefined();
    for (const [language, half] of Object.entries(halves!)) {
      expect(half, `the ${language} half of the README no longer names the check`).toContain(
        MANUAL_COMMAND,
      );
      expect(half, `the ${language} half no longer names the packaging command`).toContain(
        PACKAGING_COMMAND,
      );
    }
  });

  it('reports the script reference a rename would leave behind', () => {
    // The failure this file is for: the command stays in the prose, the file
    // moves. Written against the real literal so the message is the one a
    // reader would actually get.
    const problems = referenceProblems(
      [{ name: 'README.md', text: `Run \`${PACKAGING_COMMAND}\`, then \`${MANUAL_COMMAND}\`.` }],
      { fileExists: (relativePath) => relativePath !== MANUAL_SCRIPT, npmScripts: ['package'] },
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toBe(
      'README.md: names `scripts/verify-packaged-adapters.mjs`, which is not in the repository',
    );
  });

  it('reports an npm script the package no longer defines', () => {
    const problems = referenceProblems(
      [{ name: 'CONTRIBUTING.md', text: 'Run `npm run package` and `npm run package:dir`.' }],
      { fileExists: () => true, npmScripts: ['package'] },
    );
    expect(problems).toEqual([
      'CONTRIBUTING.md: tells the reader to run `npm run package:dir`, which `package.json` ' +
        'does not define',
    ]);
  });

  it('reports the check named without the command that produces its build', () => {
    // The script refuses to launch without `release/`, so this is not a style
    // point: the reader follows the document straight into the script's own
    // "run `npm run package` first" error.
    const problems = referenceProblems(
      [{ name: 'README.md', text: `Run \`${MANUAL_COMMAND}\`.` }],
      { fileExists: () => true, npmScripts: ['package'] },
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('without `npm run package`');
  });

  it('reads a script path only when it is one unbroken literal', () => {
    // The extractor's boundary, stated as a test rather than as a comment: it
    // recognizes `scripts/name.mjs` and nothing else. A path wrapped across a
    // line — which is what a long markdown line turns into — is not read.
    expect(scriptReferences(`Run \`${MANUAL_SCRIPT}\`, then read the summary.`)).toEqual([
      MANUAL_SCRIPT,
    ]);
    expect(scriptReferences('Run `scripts/\nverify-packaged-adapters.mjs`.')).toEqual([]);
    expect(scriptReferences('Run `scripts/<wbr>verify-packaged-adapters.mjs`.')).toEqual([]);
  });

  it('reports a path the extractor cannot read instead of silently skipping it', () => {
    // The blind spot this closes. The earlier cases prove the extractor reads
    // nothing from a wrapped path; without this one, a document that wrapped
    // the command would be *green* — no reference to compare with the
    // filesystem, so a renamed script would go unreported in that document.
    const wrapped = referenceProblems(
      [{ name: 'README.md', text: `Run \`scripts/\nverify-packaged-adapters.mjs\`.` }],
      // The file being absent is irrelevant here: the complaint is about the
      // form, not about what it names.
      { fileExists: () => true, npmScripts: ['package'] },
    );
    expect(wrapped).toHaveLength(1);
    expect(wrapped[0]).toContain('README.md');
    expect(wrapped[0]).toContain('cannot read');
    expect(wrapped[0]).toContain('scripts/');

    // Markup that splits the path is the same blind spot, and gets the same
    // answer: the gate cannot compare what it cannot see.
    const markedUp = referenceProblems(
      [{ name: 'CONTRIBUTING.md', text: 'Run `scripts/<span>verify-packaged-adapters.mjs</span>`.' }],
      { fileExists: () => true, npmScripts: ['package'] },
    );
    expect(markedUp).toHaveLength(1);
    expect(markedUp[0]).toContain('CONTRIBUTING.md');
    expect(markedUp[0]).toContain('cannot read');

    // A readable reference is still judged by existence alone, not reported
    // twice: one path, one problem.
    const renamed = referenceProblems(
      [{ name: 'README.md', text: `Run \`${PACKAGING_COMMAND}\`, then \`${MANUAL_COMMAND}\`.` }],
      { fileExists: () => false, npmScripts: ['package'] },
    );
    expect(renamed).toHaveLength(1);
    expect(renamed[0]).toContain('which is not in the repository');
  });

  it('reads every `scripts/` mention in the real documents', () => {
    // The documents as they are. This is the case that would go red if someone
    // wrapped a long command line in the README — the gate would then be blind
    // to that document, so it is a failure rather than a reflow.
    for (const document of DOCUMENTS) {
      expect(
        unmatchedScriptMentions(document.text),
        `${document.name} wraps or splits a \`scripts/\` path, which this check cannot read`,
      ).toEqual([]);
    }
  });

  it('has no opinion about the prose around the literals', () => {
    // The boundary of this gate: a document may say anything it likes about the
    // check, as long as what it tells the reader to type is real.
    const problems = referenceProblems(
      [
        {
          name: 'README.md',
          text:
            `The manual step is the one nobody automates. Run \`${PACKAGING_COMMAND}\`, then\n` +
            `\`${MANUAL_COMMAND}\` and read the summary it prints.\n`,
        },
      ],
      { fileExists: () => true, npmScripts: ['package'] },
    );
    expect(problems).toEqual([]);
  });
});

describe('the flags the release documents put after a script', () => {
  it('are flags those scripts accept', () => {
    const problems = flagProblems(DOCUMENTS, FLAG_REPOSITORY);
    expect(
      problems,
      `the documents and the scripts disagree:\n  ${problems.join('\n  ')}`,
    ).toEqual([]);
  });

  it('reads the commands the documents actually contain, so the check is not vacuous', () => {
    // A gate over an empty set is green for the same reason a missing gate is:
    // nothing was compared. The three commands below are the ones the external
    // blockers are stated as, so they are the ones that must be read.
    const commands = DOCUMENTS.flatMap((document) => documentedCommands(document.text));
    const pairs = commands.map((command) => `${command.script} ${command.flags.join(' ')}`);

    expect(pairs).toContain('scripts/publish-feed.mjs apply verify');
    // The safe half of the same command: "look before you press" is only a
    // plan if the command that prints the plan accepts being asked for it.
    expect(pairs).toContain('scripts/publish-feed.mjs dry-run');
    expect(pairs).toContain('scripts/verify-main-chain.mjs judge');
    expect(pairs).toContain('scripts/verify-main-chain.mjs exec report');
    expect(commands.length).toBeGreaterThan(5);
  });

  it('reads the Windows handoff as commands, not as a paragraph about commands', () => {
    // The section that hands the repository to a Windows machine is the last
    // document anyone re-reads, and its whole value is that the lines can be
    // copied. A paragraph saying "clone it, install, package and run the check"
    // would leave every flag in it uncompared with the script that has to
    // accept them — this case is what keeps that section typed out.
    const doc = DOCUMENTS.find((document) => document.name === 'docs/manual-verification.md')!;
    const start = doc.text.indexOf('### 把仓库交到 Windows 机器上的最短路径');
    expect(start, 'the Windows handoff heading moved; this gate must move with it').toBeGreaterThan(-1);
    const section = doc.text.slice(start, doc.text.indexOf('把 `win-report.json` 原样带回', start));

    const commands = documentedCommands(section);
    expect(commands.map((command) => `${command.script} ${command.flags.join(' ')}`)).toEqual([
      'scripts/verify-main-chain.mjs exec report',
    ]);
    // And the steps before it are the shortest path, in order, not a summary of
    // one: clone, install, package, run.
    const lines = section.split('\n').map((line) => line.trim());
    const order = ['git clone', 'npm install', 'npm run package', 'verify-main-chain.mjs'];
    let at = -1;
    for (const step of order) {
      const next = lines.findIndex((line, index) => index > at && line.includes(step));
      expect(next, `the Windows handoff no longer states \`${step}\` after the previous step`).toBeGreaterThan(at);
      at = next;
    }
  });

  it('reports a flag the script does not accept', () => {
    // The failure this half exists for: the script is there, the document is
    // confident, and the reader gets `unknown option(s): --aply` from a command
    // the release notes told them to type.
    const problems = flagProblems(
      [{ name: 'README.md', text: 'Run `node scripts/publish-feed.mjs --aply --verify`.\n' }],
      { scriptSource: () => "export const KNOWN_FLAGS = ['feed-file', 'apply', 'verify'];" },
    );

    expect(problems).toEqual([
      'README.md: tells the reader to run `scripts/publish-feed.mjs --aply`, and that ' +
        'script does not accept it',
    ]);
  });

  it('accepts the four ways this repository reads its arguments', () => {
    // One flag per shape, so a script that switches from `KNOWN_FLAGS` to
    // `parseArgs` does not turn every document red for a reason that is not a
    // defect.
    const shapes: readonly (readonly [string, string])[] = [
      ["const KNOWN_FLAGS = ['apply'];", '--apply'],
      ["const JUDGE_IN = flag('judge', null);", '--judge'],
      ["const version = typeof args.version === 'string' ? args.version : '';", '--version'],
      ["const check = argv.includes('--check');", '--check'],
    ];
    for (const [source, flag] of shapes) {
      const problems = flagProblems(
        [{ name: 'README.md', text: `Run \`node scripts/x.mjs ${flag}\`.\n` }],
        { scriptSource: () => source },
      );
      expect(problems, `${flag} against ${source}`).toEqual([]);
    }
  });

  it('does not read a CSS custom property as a flag', () => {
    // The false positive that would get this gate switched off: `dod-status.md`
    // writes `--measure-prose: 36em` on a line that names a script, and it is a
    // token in `styles.css`, not an argument to anything.
    const problems = flagProblems(
      [
        {
          name: 'docs/dod-status.md',
          text: '| 行长 | `styles.css` 的 `--measure-prose`；常量在 `scripts/layout-page-scripts.mjs` |\n',
        },
      ],
      { scriptSource: () => 'export const MAX_PROSE_LINE_CJK = 40;' },
    );

    expect(problems).toEqual([]);
  });

  it('skips a line that names two scripts, instead of guessing which flag belongs to which', () => {
    // The extractor's boundary, stated as a case: attribution is not in the
    // text, so the line is not judged. Written down because a blind spot nobody
    // recorded is how a gate goes quiet.
    const problems = flagProblems(
      [
        {
          name: 'docs/dod-status.md',
          text: '`node scripts/a.mjs --apply`，然后 `node scripts/b.mjs --judge`\n',
        },
      ],
      { scriptSource: () => 'export const nothing = true;' },
    );

    expect(problems).toEqual([]);
    expect(
      documentedCommands('`node scripts/a.mjs --apply`，然后 `node scripts/b.mjs --judge`'),
    ).toEqual([]);
  });

  it('does not report a missing script twice', () => {
    // `referenceProblems` owns "the file is not there"; this half owns "the flag
    // is not there". One missing file must not read as two defects.
    const problems = flagProblems(
      [{ name: 'README.md', text: 'Run `node scripts/gone.mjs --apply`.\n' }],
      { scriptSource: () => null },
    );

    expect(problems).toEqual([]);
  });
});
