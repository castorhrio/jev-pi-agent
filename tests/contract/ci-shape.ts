/**
 * What "CI packages the app" looks like in `.github/workflows/ci.yml`.
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
 * and is consumed by the gates that compare the claim with the workflow. The
 * matching is deliberately textual: it reads the *commands* in `ci.yml`, not
 * the job graph. A packaging command inside a composite action, a reusable
 * workflow, or another workflow file is a known blind spot — if that refactor
 * lands, add the new file to the readers rather than narrowing this list.
 */

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

/** Whether a workflow contains any packaging step. */
export function packagesTheApp(workflow: string): boolean {
  return packagingCommands(workflow).length > 0;
}
