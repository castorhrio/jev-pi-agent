/**
 * What "CI packages the app" looks like in `.github/workflows/`.
 *
 * ## Why this is a module rather than a regex in one test
 *
 * Two documents and one source comment make the same claim — the packaged asar
 * check is manual because no CI job packages the app. That claim is only worth
 * what can falsify it, and it was previously checked by three copies of a
 * regex: one in `adapter-resolution.test.ts`, one in
 * `verify-packaged-adapters.test.ts`, and each quietly narrower than the other.
 * A `npm run dist` job would have been missed by both, leaving the documents
 * promising "CI does not cover it" beside a CI run that did.
 *
 * So the definition lives once, names every entry point an Electron packaging
 * step is written as, and is consumed by the gates that compare the claim with
 * the workflows. The matching is deliberately textual: it reads the *commands*
 * in the workflow files, not the job graph.
 *
 * "Every entry point" is not "every command that produces a package" — that
 * claim was in this paragraph and no test could hold it. A step that hides the
 * command behind a script (`run: ./scripts/package.sh`) is outside any text
 * match, and `tests/contract/ci-shape.test.ts` pins that boundary (see *cannot
 * see a command hidden behind a script*) instead of leaving the stronger
 * sentence in a comment.
 *
 * ## Why the directory, not `ci.yml`
 *
 * The claim the documents make is about **CI**, and CI is whatever GitHub runs
 * from `.github/workflows/` — not one file that happens to be called `ci.yml`.
 * Reading a single path left the obvious next commit invisible: a
 * `release.yml` with an `electron-builder` step would have started packaging
 * the app in CI while every gate went on passing, and the sentence "no CI job
 * packages the app" would have been false in a way nothing could see. The
 * readers below therefore take the *directory*, and a failure names the file
 * the command was found in.
 *
 * ## What is still a blind spot, and where it is pinned
 *
 * Two shapes are not read here:
 *
 *  - a packaging step hidden inside a **composite action**
 *    (`.github/actions/<name>/action.yml`);
 *  - a **reusable workflow in another repository**, invoked with
 *    `uses: owner/repo/.github/workflows/x.yml@ref`.
 *
 * Neither is a file in this directory. Stating that in a paragraph was the
 * whole treatment until now, and a paragraph cannot fail: the next reader who
 * moves a step into an action would leave the gate green and the documents
 * promising CI packages nothing. `tests/contract/ci-shape.test.ts` therefore
 * asserts the gap — *does not read a composite action* and *cannot see a
 * reusable workflow in another repository* show the command present and the
 * reader answering `[]` — and a third case asserts that this repository
 * installs neither shape today, so extending the readers is a red test with
 * these names in it rather than a comment somebody may notice.
 *
 * One narrowing worth knowing, because it makes the second gap smaller than it
 * sounds: a reusable workflow **in this repository** is a top-level file under
 * `.github/workflows/`, so it *is* read, and a packaging step inside it is
 * caught. Only the remote case is invisible. *does read a reusable workflow
 * that lives in this directory* pins that half.
 *
 * A *symlinked* workflow file is the third declared gap — see
 * {@link readWorkflowFiles}. If any of these lands, extend the readers and the
 * cases together; do not narrow this list.
 *
 * ## What the matching cannot tell apart, and why it does not need to
 *
 * The patterns read the workflow's raw text. They are not YAML parsers and they
 * do not know a `run:` from a `#`: a comment that spells out the command —
 * "we do not run `npm run dist` here, the asar check is manual" — matches, and a
 * gate consuming this module goes red on a workflow that packages nothing.
 *
 * That is the safe direction, and it is the reason this is a text match rather
 * than a parse:
 *
 *  - A **false positive** costs a sentence in a comment and a minute of
 *    confusion; the fix is to reword the comment, and {@link packagingProblem}
 *    says so in the failure itself — with the file *and* the line it matched,
 *    so the reword has an address instead of a search.
 *  - A **false negative** — a packaging step this vocabulary did not recognise
 *    — leaves every document promising "CI does not cover it" beside a CI run
 *    that does. That is the failure this module exists to prevent, and no
 *    amount of parsing buys back the certainty, because the step can hide in a
 *    script file (`run: ./scripts/package.sh`) that no pattern in either
 *    approach would see.
 *
 * So the rule for a reader is: if the gate names your workflow and the only
 * occurrence is prose, reword the prose. Do not narrow the pattern, and do not
 * add an exemption for comments — a comment matcher is a one-line parser whose
 * own blind spots (block scalars, quoted strings that look like comments) would
 * be new. `tests/contract/ci-shape.test.ts` records the current behaviour with
 * a case, so "comments match too" is asserted rather than left to be
 * rediscovered: see *matches a comment that names a packaging command*.
 *
 * One more thing this gate is not: a YAML validator. It never fails a workflow
 * for being malformed, and it cannot tell a `run:` from a `uses:`. CI's ability
 * to run at all is GitHub's answer to that question, not this module's.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** One way the workflow could package the app, and the command that betrays it. */
interface PackagingCommand {
  /** The literal command, as a workflow step writes it. */
  readonly command: string;
  /**
   * Matched against the workflow's raw text — a step's `run:`, a `name:`, and a
   * `#` comment alike. See "What the matching cannot tell apart" above: the
   * blind spot that costs is a missed command, not a comment that trips the
   * gate.
   */
  readonly pattern: RegExp;
}

/**
 * The entry points a packaging step is written as.
 *
 * Each pattern ends in `\b` and is not anchored to the end of the command, so
 * the variants a prefix match would otherwise slip through — `npm run
 * package:dir`, `npm run dist:win`, `npx electron-builder --dir` — are still
 * recognised as packaging. `npm run build` is deliberately absent: it is what
 * the gates themselves run, and treating it as packaging would make the
 * assertion vacuous.
 *
 * This repository packages with electron-builder (`npm run package`, `npm run
 * dist`), and the list also names the entry points of the other two toolchains
 * an Electron project reaches for: electron-forge (`npm run make`,
 * `electron-forge`) and `electron-packager`. They are here because the module's
 * asymmetry argues for it — a false alarm is reworded in a minute, while a
 * packaging step nobody recognised is the failure this module exists to
 * prevent. `tests/contract/ci-shape.test.ts` asserts each entry is matched
 * (*recognises the other ways an Electron packaging step is written*), so
 * adding a toolchain is a line here plus a case there.
 *
 * What the list still cannot see is a step whose command is in a file:
 * `run: ./scripts/package.sh`. No pattern can, and the case *cannot see a
 * command hidden behind a script* pins that boundary rather than leaving it
 * implied by an absent line.
 */
export const PACKAGING_COMMANDS: readonly PackagingCommand[] = [
  { command: 'npm run package', pattern: /\bnpm run package\b/u },
  { command: 'npm run dist', pattern: /\bnpm run dist\b/u },
  { command: 'electron-builder', pattern: /\belectron-builder\b/u },
  { command: 'npm run make', pattern: /\bnpm run make\b/u },
  { command: 'electron-forge', pattern: /\belectron-forge\b/u },
  { command: 'electron-packager', pattern: /\belectron-packager\b/u },
];

/** A workflow file as the readers below see it: its name and its raw text. */
export interface WorkflowFile {
  /** File name inside the workflows directory, e.g. `ci.yml`. */
  readonly name: string;
  /** The file's raw text. */
  readonly text: string;
}

/**
 * The workflow files GitHub reads from a directory, sorted by name.
 *
 * `.yml` and `.yaml` both, because both are workflows to GitHub and a gate that
 * recognised only the spelling in the tree today would stop reading the moment
 * someone wrote the other one. Regular files only: GitHub does not read
 * subdirectories under `.github/workflows/`, so a `nested/ci.yml` is not a
 * workflow and is not read here. (`notes.md` is skipped for the same reason —
 * it is not run.)
 *
 * A missing directory throws rather than returning `[]`: an empty list would
 * satisfy "no workflow packages the app" for the wrong reason, which is the
 * failure this module exists to prevent. The caller asserts the directory
 * first, so the red names the path.
 *
 * **A symlinked workflow file is skipped**, because `isFile()` is false for a
 * link and this function does not follow it. That is a declared gap rather than
 * a decision: GitHub does not document whether it reads a symlinked workflow,
 * so the honest options are "read it" or "say it is not read", and the second is
 * the one that can be stated without guessing. The cost is real and it falls in
 * the failing direction — a `release.yml` that is a symlink to a packaging job
 * would leave this gate green while the documents go on promising CI packages
 * nothing. `tests/contract/ci-shape.test.ts` pins the current behaviour in
 * *skips a symlinked workflow file*; if a symlink is ever installed under
 * `.github/workflows/`, extend this reader (`entry.isSymbolicLink()` plus
 * `statSync`) before relying on the gate.
 */
export function readWorkflowFiles(dir: string): WorkflowFile[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.ya?ml$/u.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .map((name) => ({ name, text: readFileSync(join(dir, name), 'utf8') }));
}

/**
 * Where one entry of {@link PACKAGING_COMMANDS} was found.
 *
 * The line matters because the match is textual: a failure that says only
 * "`release.yml` mentions `npm run dist`" leaves the reader searching a file
 * for a line that may be prose. The line number is the difference between an
 * address and a hint.
 */
export interface PackagingFinding {
  /** The literal command, in backticks — the form a failure quotes. */
  readonly command: string;
  /** File name inside the workflows directory, e.g. `release.yml`. */
  readonly workflow: string;
  /** 1-based line of the first occurrence in that file. */
  readonly line: number;
}

/**
 * The packaging commands present in a workflow, in {@link PACKAGING_COMMANDS}
 * order; an empty list means the workflow packages nothing.
 *
 * Returning the names rather than a boolean is what lets a failure say *which*
 * step appeared, instead of only that the claim was broken.
 */
export function packagingCommands(workflow: string): string[] {
  return PACKAGING_COMMANDS.filter(({ pattern }) => workflow.search(pattern) !== -1).map(
    ({ command }) => `\`${command}\``,
  );
}

/** The 1-based line `index` falls on in `text`. */
function lineOf(text: string, index: number): number {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (text[cursor] === '\n') line += 1;
  }
  return line;
}

/**
 * Every packaging command found across a set of workflow files, with the file
 * and line it was found on.
 *
 * Structured rather than formatted so callers can report the fact their way:
 * {@link packagingCommandsIn} quotes it in a one-line list, and
 * {@link packagingProblem} builds the failure a contributor reads.
 */
export function packagingFindings(workflows: readonly WorkflowFile[]): PackagingFinding[] {
  return workflows.flatMap(({ name, text }) =>
    PACKAGING_COMMANDS.flatMap(({ command, pattern }) => {
      const index = text.search(pattern);
      if (index === -1) return [];
      return [{ command: `\`${command}\``, workflow: name, line: lineOf(text, index) }];
    }),
  );
}

/**
 * The packaging commands present across a set of workflow files, each qualified
 * with the file and line it was found on.
 *
 * Qualified, because "a packaging step appeared" is only actionable together
 * with *where*: `release.yml:5` is a different conversation from `ci.yml:20`,
 * and the line is what turns "the gate named my file" into a fix. The format is
 * `` `command` at `file:line` `` — tests assert it, so a failure message and a
 * fixture cannot drift apart.
 */
export function packagingCommandsIn(workflows: readonly WorkflowFile[]): string[] {
  return packagingFindings(workflows).map(
    ({ command, workflow, line }) => `${command} at \`${workflow}:${line}\``,
  );
}

/**
 * Whether any workflow in the set packages the app.
 *
 * The boolean is what the claim checks need; {@link packagingProblem} is the
 * failure they report, and it carries the file, the line and the fix.
 */
export function workflowsPackageTheApp(workflows: readonly WorkflowFile[]): boolean {
  return packagingFindings(workflows).length > 0;
}

/**
 * The failure a gate reports when a workflow packages the app, or `undefined`
 * when none does.
 *
 * ## Why the failure carries the fix, not only the fact
 *
 * Two very different edits reach this line of output: a comment (or a step's
 * `name:`) that spells out the command, and a real packaging step. The match
 * cannot tell them apart — that is {@link PACKAGING_COMMANDS}'s declared
 * asymmetry — so a message that only names the file and the command sends the
 * reader to the module doc to work out which one they are looking at. Naming
 * both readings and what each costs is the difference between a red gate and a
 * puzzle, and it keeps the fix inside the workflow (reword the prose) when the
 * workflow is the thing that is wrong.
 *
 * The line number is part of the same rule: a text match inside a long workflow
 * is not findable by `grep`-ing the command alone once the reader is told only
 * "this file".
 *
 * The exact wording is asserted in `ci-shape.test.ts` (*reports the file, the
 * line and the fix*), because advice nobody tests is advice that quietly stops
 * being printed.
 */
export function packagingProblem(workflows: readonly WorkflowFile[]): string | undefined {
  const findings = packagingCommandsIn(workflows);
  if (findings.length === 0) return undefined;
  return [
    `a workflow under \`.github/workflows/\` names a packaging command: ${findings.join(', ')}.`,
    'The packaged asar check is documented as manual, so one of these lines is now false.',
    'If it is a comment or a `name:` string — the match is textual and cannot tell a comment ' +
      'from a step — reword that line; no document needs to change.',
    'If it is a real step, update README.md (both languages), CONTRIBUTING.md and ' +
      'adapter-resolution.ts to say what CI checks instead of only adding the job.',
  ].join('\n');
}
