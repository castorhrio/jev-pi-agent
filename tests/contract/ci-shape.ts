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
 * So the definition lives once, names every command that produces a package,
 * and is consumed by the gates that compare the claim with the workflows. The
 * matching is deliberately textual: it reads the *commands* in the workflow
 * files, not the job graph.
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
 * What is still a blind spot, stated rather than implied: a packaging step
 * hidden inside a composite action (`.github/actions/**`) or a reusable
 * workflow invoked with `uses: owner/repo/.github/workflows/x.yml@ref`. Neither
 * is a file in this directory, so neither is read here. If that refactor
 * lands, extend the readers — do not narrow this list.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** One way the workflow could package the app, and the command that betrays it. */
interface PackagingCommand {
  /** The literal command, as a workflow step writes it. */
  readonly command: string;
  /** Matched against the workflow's raw text. */
  readonly pattern: RegExp;
}

/**
 * The commands that build a release artifact.
 *
 * Each pattern ends in `\b` and is not anchored to the end of the command, so
 * the variants a prefix match would otherwise slip through — `npm run
 * package:dir`, `npm run dist:win`, `npx electron-builder --dir` — are still
 * recognised as packaging. `npm run build` is deliberately absent: it is what
 * the gates themselves run, and treating it as packaging would make the
 * assertion vacuous.
 */
export const PACKAGING_COMMANDS: readonly PackagingCommand[] = [
  { command: 'npm run package', pattern: /\bnpm run package\b/u },
  { command: 'npm run dist', pattern: /\bnpm run dist\b/u },
  { command: 'electron-builder', pattern: /\belectron-builder\b/u },
];

/**
 * The packaging commands present in a workflow, in {@link PACKAGING_COMMANDS}
 * order; an empty list means the workflow packages nothing.
 *
 * Returning the names rather than a boolean is what lets a failure say *which*
 * step appeared, instead of only that the claim was broken.
 */
export function packagingCommands(workflow: string): string[] {
  return PACKAGING_COMMANDS.filter(({ pattern }) => pattern.test(workflow)).map(
    ({ command }) => `\`${command}\``,
  );
}

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
 */
export function readWorkflowFiles(dir: string): WorkflowFile[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.ya?ml$/u.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .map((name) => ({ name, text: readFileSync(join(dir, name), 'utf8') }));
}

/**
 * The packaging commands present across a set of workflow files, each qualified
 * with the file it was found in.
 *
 * Qualified, because "a packaging step appeared" is only actionable together
 * with *where*: `release.yml` is a different conversation from `ci.yml`.
 */
export function packagingCommandsIn(workflows: readonly WorkflowFile[]): string[] {
  return workflows.flatMap(({ name, text }) =>
    packagingCommands(text).map((command) => `${command} in \`${name}\``),
  );
}

/**
 * Whether any workflow in the set packages the app.
 *
 * The boolean is what the claim checks need; {@link packagingCommandsIn} is
 * what their failure messages quote.
 */
export function workflowsPackageTheApp(workflows: readonly WorkflowFile[]): boolean {
  return workflows.some(({ text }) => packagingCommands(text).length > 0);
}
