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

/** A `scripts/…` path named in prose, e.g. `` `scripts/make-update-feed.mjs` ``. */
const SCRIPT_REFERENCE = /\bscripts\/[\w.-]+\.(?:mjs|cjs|js|ts)\b/gu;

/** An `npm run <name>` the documents tell the reader to type. */
const NPM_RUN = /\bnpm run ([\w:.-]+)/gu;

function scriptReferences(text: string): string[] {
  return [...text.matchAll(SCRIPT_REFERENCE)].map((match) => match[0]);
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
const SCRIPT_MENTION = /(?<![\w./-])scripts\//gu;

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

const DOCUMENTS: readonly Document[] = ['README.md', 'CONTRIBUTING.md'].map(readDocument);
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
