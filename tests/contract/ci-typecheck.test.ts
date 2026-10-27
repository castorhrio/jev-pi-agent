/**
 * CI runs the compile-time gate — or every compile-time assertion in this
 * repository is decoration.
 *
 * ## Why this file exists
 *
 * This codebase handles a growing share of its promises with the type system:
 * `satisfies` over the adapter candidate table, `Exclude<…>` aliases that must
 * be `never` (`update-controller.tsx`), `const`-asserted status vocabularies,
 * and the `TS extends never = …` style assertions in the main process. None of
 * them is visible at runtime, and `npm test` does not typecheck: the suite is
 * transformed by esbuild, which erases types without reading them. Every one
 * of those assertions is therefore enforced by exactly one command:
 *
 *     npm run typecheck
 *
 * That command used to be a step in `ci.yml` and a sentence in no test. Which
 * means the dangerous commit — deleting the step while "speeding up CI", or
 * commenting it out while debugging — left every other gate green: lint, knip,
 * unit/contract/E2E (which typecheck nothing), the build (which bundles the
 * renderer through vite), and the clean build. The repository would then go on
 * advertising guarantees that nothing checks, with the compiler never running.
 *
 * `ci-shape.test.ts` guards other promises about the workflow (that CI packages
 * nothing). It asserts `npm test` and `npm run build` are present, but its
 * reader is built to *find a command anywhere in the raw text* — the opposite
 * of what this gate needs. See "Why this reader does not match raw text" below.
 *
 * ## Why this reader does not match raw text
 *
 * The packaging gate matches the workflow's raw text on purpose: a comment
 * naming `npm run dist` is a false alarm whose fix is a reword, while a missed
 * step is a lie in three documents. Here the asymmetry inverts. A *commented
 * out* `# - run: npm run typecheck` is not a step GitHub runs, and a reader
 * that matched it would report "CI typechecks" over a workflow that does not —
 * the exact silent-zero failure this file exists to catch. So this reader reads
 * `run:` entries only: a line whose first non-space token is `run:` (optionally
 * behind a `-`), plus the indented body of a block scalar (`run: |`). A `#`
 * before `run:` makes the line invisible, which is the point.
 *
 * That has its own boundary, pinned below rather than described: a command
 * hidden behind a script (`run: ./scripts/check.sh`) is not visible to any text
 * match. The failure message says so and names the fix (call the script from a
 * `run:` line this reader can see, or extend the reader).
 *
 * ## Why a second file instead of a second case in `ci-shape.test.ts`
 *
 * The two gates answer different questions with different matching rules, and
 * merging them would put a comment-blind parser beside a comment-matching one
 * under one name. What they *do* share stays shared: `readWorkflowFiles()`, so
 * "CI" means every workflow GitHub runs, `.yml` and `.yaml`, symlinks followed,
 * and not one path. A second workflow (`release.yml`) gets this gate for free.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readWorkflowFiles, type WorkflowFile } from './ci-shape';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const WORKFLOWS_DIR = join(REPO_ROOT, '.github', 'workflows');

/** One `run:` entry of a workflow, as this gate sees it. */
interface RunStep {
  /** The command text, as a shell would receive it (block scalars joined). */
  readonly command: string;
  /** 1-based line of the command, so a failure about "the only occurrence" has an address. */
  readonly line: number;
}

/**
 * The `run:` entries of a workflow's text.
 *
 * Deliberately not a YAML parser — see the module doc. It recognises the two
 * spellings a step's command is written in:
 *
 *     - run: npm run typecheck
 *     - run: |
 *         npm run typecheck
 *
 * and nothing else. A `name:` or a `#` line is skipped because it is not a
 * `run:` entry, not because this reader strips comments: a line starting with
 * `#` cannot match, so a commented-out step is absent rather than exempted by
 * a rule this file would have to keep correct.
 *
 * A block scalar's body is everything indented deeper than its `run:` key,
 * joined with newlines so a `&&`-chained command stays one command. The line
 * reported is the body's first line, which is where the command actually is.
 */
function runSteps(text: string): RunStep[] {
  const lines = text.split('\n');
  const steps: RunStep[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const match = /^(?<indent>[ \t]*)(?:-[ \t]+)?run:[ \t]*(?<rest>.*)$/u.exec(line);
    if (match === null) continue;
    const indentation = match.groups?.['indent']?.length ?? 0;
    const rest = (match.groups?.['rest'] ?? '').trim();
    if (!/^[|>][+-]?[0-9]*$/u.test(rest)) {
      steps.push({ command: rest, line: index + 1 });
      continue;
    }
    // A block scalar: take the more-indented lines that follow, stop at the
    // first line that belongs to the workflow again (dedent or end of file).
    const body: { readonly command: string; readonly line: number }[] = [];
    let cursor = index + 1;
    for (; cursor < lines.length; cursor += 1) {
      const candidate = lines[cursor] ?? '';
      if (candidate.trim() === '') continue;
      const indent = /^[ \t]*/u.exec(candidate)?.[0].length ?? 0;
      if (indent <= indentation) break;
      body.push({ command: candidate.trim(), line: cursor + 1 });
    }
    if (body.length > 0) {
      steps.push({ command: body.map((entry) => entry.command).join('\n'), line: body[0]!.line });
    }
    // The body cannot be a `run:` entry of its own, and must not be read as
    // one: a nested `run:` line inside the block is command text, not a step.
    index = cursor - 1;
  }
  return steps;
}

/**
 * Whether a `run:` command is the compile-time gate.
 *
 * Two spellings, both accepted because both really typecheck:
 *
 *  - `npm run typecheck` — this repository's script, which builds the packages,
 *    builds main, and runs `tsc --project tsconfig.renderer.json --noEmit`;
 *  - a direct `tsc --build` / `tsc -b` / `--noEmit` invocation — the same
 *    command written inline, which a workflow may do after adding args.
 *
 * `npm run build` is deliberately not in this list, and the case below pins
 * that: the renderer is bundled by vite, which does not read types, so a build
 * step alone leaves every renderer-side compile-time assertion unenforced.
 */
function isTypecheckCommand(command: string): boolean {
  return (
    /\bnpm run typecheck\b/u.test(command) ||
    /\btsc\b[^\n]*(?:--build\b|\s-b\b|--noEmit\b)/u.test(command)
  );
}

/** Where the compile-time gate is run, across a set of workflow files. */
interface TypecheckStep extends RunStep {
  /** File name inside the workflows directory, e.g. `ci.yml`. */
  readonly workflow: string;
}

function typecheckSteps(workflows: readonly WorkflowFile[]): TypecheckStep[] {
  return workflows.flatMap((workflow) =>
    runSteps(workflow.text)
      .filter((step) => isTypecheckCommand(step.command))
      .map((step) => ({ ...step, workflow: workflow.name })),
  );
}

/**
 * The failure when no workflow runs the compile-time gate, or `undefined` when
 * one does.
 *
 * The message carries the step to add and the two readings that make this
 * green while being wrong, because the reader of a red run is not reading this
 * file: a commented-out step, and `npm run build` standing in for the
 * typecheck. Both are one-line fixes once named, and both are silent without
 * being named.
 */
function typecheckProblem(workflows: readonly WorkflowFile[]): string | undefined {
  if (typecheckSteps(workflows).length > 0) return undefined;
  return [
    'no workflow under `.github/workflows/` runs the compile-time gate (`npm run typecheck`).',
    'The `satisfies` tables, the `const`-asserted status vocabularies and the `Exclude<…> = never`',
    'aliases in this repository are enforced by `tsc` and by nothing else: `npm test`/`test:e2e`',
    'erase types through esbuild, `lint` has no type information, and the build bundles the',
    'renderer through vite. Without this step those assertions are comments that look like code.',
    'Add the step — in `ci.yml`, next to `npm test`:',
    '',
    '      - name: Typecheck',
    '        run: npm run typecheck',
    '',
    'Two spellings are recognised: `npm run typecheck`, and a direct `tsc --build` / `tsc -b` /',
    '`tsc … --noEmit` invocation. `npm run build` is not one of them (the renderer is not',
    'typechecked by its vite build), and a commented-out `# - run: npm run typecheck` does not',
    'count either: this reader only sees `run:` lines, because a gate that a `#` can satisfy is a',
    'gate that reports "CI typechecks" over a workflow that does not.',
  ].join('\n');
}

/** The real workflow set, read once by the cases that assert on the repository. */
function realWorkflows(): WorkflowFile[] {
  return readWorkflowFiles(WORKFLOWS_DIR);
}

/** A minimal workflow with whatever `run:` entries a case needs. */
function workflow(name: string, runs: readonly string[]): WorkflowFile {
  return {
    name,
    text: ['name: CI', 'jobs:', '  gates:', '    steps:', ...runs].join('\n'),
  };
}

describe('CI runs the compile-time gate', () => {
  it('finds `npm run typecheck` in the repository workflows, with a line number', () => {
    // Mirrors `ci-shape.test.ts`'s "reads a workflow directory that runs the
    // gates": the assertion below must not be green because the directory was
    // empty, renamed, or read as nothing.
    const workflows = realWorkflows();
    expect(workflows.length, `no workflow was read from ${WORKFLOWS_DIR}`).toBeGreaterThan(0);

    const steps = typecheckSteps(workflows);
    expect(
      steps.map((step) => step.workflow),
      `no workflow runs the compile-time gate; \`npm run typecheck\` is the only thing that ` +
        `enforces the compile-time assertions in this repository. Workflows read: ` +
        workflows.map((file) => file.name).join(', '),
    ).toContain('ci.yml');
    // The line is part of the finding, not decoration: it is what sends the
    // reader to the step when the command moves or gains flags.
    expect(steps[0]?.line).toBeGreaterThan(0);
    expect(typecheckProblem(workflows)).toBeUndefined();
  });

  it('fails on a workflow set where the step was deleted', () => {
    const problem = typecheckProblem([
      workflow('ci.yml', [
        '      - run: npm ci',
        '      - run: npm run lint',
        '      - run: npm test',
        '      - run: npm run build',
      ]),
    ]);
    expect(problem, 'a workflow set without the typecheck step passed').toBeDefined();
    // The fix, the reason, and both false greens, in the failure itself.
    expect(problem).toContain('npm run typecheck');
    expect(problem).toContain('tsc --build');
    expect(problem).toContain('npm run build');
    expect(problem).toContain('# - run: npm run typecheck');
  });

  it('does not count a commented-out step, unlike the packaging reader', () => {
    // The one direction this gate may not fail in: GitHub does not run a
    // comment. `ci-shape.test.ts` accepts a matching comment on purpose, which
    // is safe there because a false alarm asks for a reword; here a match means
    // "the guarantee is enforced", so a comment must not satisfy it.
    const problem = typecheckProblem([
      workflow('ci.yml', ['      # - run: npm run typecheck', '      - run: npm test']),
    ]);
    expect(problem, 'a commented-out typecheck step was reported as CI running it').toBeDefined();
    // The same text as a `name:` is not a step either.
    expect(
      typecheckProblem([workflow('ci.yml', ['      - name: npm run typecheck', '        run: npm test'])]),
    ).toBeDefined();
  });

  it('accepts the direct `tsc` spellings', () => {
    // `npm run typecheck` is a script name; a workflow that inlines the same
    // command after adding args is the same gate and must not go red.
    expect(typecheckProblem([workflow('ci.yml', ['      - run: tsc --build tsconfig.build.json'])]))
      .toBeUndefined();
    expect(typecheckProblem([workflow('ci.yml', ['      - run: npx tsc -b apps/desktop'])]))
      .toBeUndefined();
    expect(
      typecheckProblem([
        workflow('ci.yml', ['      - run: tsc --project apps/desktop/tsconfig.renderer.json --noEmit']),
      ]),
    ).toBeUndefined();
  });

  it('reads a block-scalar `run:` body, where a command with a comment hides', () => {
    // The spelling this repository already uses for `Install`; a step that
    // says `run: |` and then the command on its own line is a step GitHub runs.
    const block = [
      '      - name: Typecheck',
      '        run: |',
      '          npm ci',
      '          npm run typecheck',
      '      - run: npm test',
    ];
    expect(typecheckProblem([workflow('ci.yml', block)])).toBeUndefined();
    // And the line points into the block, at the command — not at `run: |`.
    // `workflow()` prepends four lines (`name`, `jobs`, `gates`, `steps`), so
    // the third line of `block` is line 7 of the file.
    expect(typecheckSteps([workflow('ci.yml', block)]).map((step) => step.line)).toEqual([7]);
  });

  it('does not accept `npm run build` standing in for the typecheck', () => {
    // The tempting substitution: the build does run `tsc --build` over the
    // packages and main. It does not typecheck the renderer (vite bundles it
    // without reading types), which is exactly where the `satisfies` tables in
    // `update-controller.tsx` live.
    expect(
      typecheckProblem([
        workflow('ci.yml', [
          '      - run: npm run build',
          '      - run: npm run build:packages',
          '      - run: npm run build:desktop',
        ]),
      ]),
    ).toBeDefined();
  });

  it('does not see a command hidden behind a script, which is its boundary', () => {
    // Pinned rather than described: no text match can read what a script does.
    // If the gate is ever moved into `./scripts/check.sh`, the fix is to call
    // it from a `run:` line this reader can see, or to extend the reader — not
    // to trust the green.
    expect(typecheckProblem([workflow('ci.yml', ['      - run: ./scripts/typecheck.sh'])])).toBeDefined();
  });

  it('keeps the renderer project inside the `typecheck` script', () => {
    // The step says `npm run typecheck`; what that script *does* is the other
    // half of the promise. The renderer is the project whose compile-time
    // assertions this repository leans on most, and the only project the
    // solution build (`tsconfig.build.json`) and the build steps do not cover —
    // vite bundles it. So the script must keep type-checking it, and a
    // restructure that does it another way has to update this case instead of
    // leaving a green "typecheck" that checks two of the three projects.
    const script = (
      JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
        scripts?: Record<string, string>;
      }
    ).scripts?.['typecheck'];
    expect(script, '`package.json` has no `typecheck` script; the CI step names one').toBeDefined();
    expect(
      script,
      'the `typecheck` script no longer type-checks the renderer project ' +
        '(`tsconfig.renderer.json` with `--noEmit`). The renderer has no other type gate: ' +
        '`npm run build` bundles it through vite, which erases types without reading them. ' +
        'If the renderer is now checked another way, assert that way here.',
    ).toContain('tsconfig.renderer.json');
    expect(script).toContain('--noEmit');
  });
});
