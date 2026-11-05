/**
 * The local-test workaround is a command, and a command nobody can run is a disclaimer.
 *
 * ## Why this file exists
 *
 * Three commit messages in a row carried the same sentence: the full suite fails
 * on this machine because `/tmp` is not writable, unrelated to the change. A
 * sentence repeated three times stops being read, and the thing it excuses stops
 * being measured — which is the failure `docs/blockers.md` exists to prevent.
 * The page now carries a section that names the machine, the two `df` readings,
 * the errno a reader will actually see, and one command that runs the suite with
 * its scratch files inside the checkout.
 *
 * A documented workaround has one way to be worthless: the command in the prose
 * is not a command in `package.json`. Then the reader types it, gets
 * `Missing script`, and the page that sent them there is green. So the section
 * and the repository are compared:
 *
 *  - the section exists, and it names `npm run test:local`;
 *  - `test:local` is a key in `package.json#scripts`, and it runs
 *    `scripts/test-local.mjs`;
 *  - that script exists, and it points `TMPDIR` at a directory inside the
 *    checkout rather than at `/tmp`;
 *  - `.gitignore` covers that directory, so a run cannot leave a committed
 *    scratch tree behind;
 *  - the section names the error a reader will search for (`Unknown system error
 *    -122`) and both `df` commands, because a section that describes the symptom
 *    in its own words is a section a reader cannot match against their terminal;
 *  - and the script's own `--dry-run` reports a temp directory inside the
 *    repository — the one assertion here that runs the thing instead of reading
 *    it.
 *
 * The checks are a pure function of `(documents, package.json, script source)`
 * so the red direction is driven on a mutated copy rather than argued about.
 *
 * Deliberately not asserted: that the suite is green under the workaround. That
 * is what running it says, and a test that ran the whole suite inside the suite
 * would be measuring the machine it happens to be on.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const BLOCKERS_PATH = join(REPO_ROOT, 'docs', 'blockers.md');
const PACKAGE_PATH = join(REPO_ROOT, 'package.json');
const GITIGNORE_PATH = join(REPO_ROOT, '.gitignore');
const SCRIPT_PATH = join(REPO_ROOT, 'scripts', 'test-local.mjs');

const read = (path: string): string => (existsSync(path) ? readFileSync(path, 'utf8') : '');

const BLOCKERS = read(BLOCKERS_PATH);
const GITIGNORE = read(GITIGNORE_PATH);
const SCRIPT = read(SCRIPT_PATH);

/** The heading the section starts at. */
const SECTION_HEADING = '## 本机全量测试的已知环境约束';

/** The command the section tells the reader to run. */
const LOCAL_COMMAND = 'npm run test:local';

/** The script that command has to reach. */
const LOCAL_SCRIPT = 'scripts/test-local.mjs';

/** The scratch directory the script uses, as `.gitignore` spells it. */
const TEMP_DIR_ENTRY = '.tmp/';

/** What the checks read. */
interface Facts {
  readonly blockers: string;
  readonly scripts: Readonly<Record<string, string>>;
  readonly gitignore: string;
  readonly scriptSource: string;
}

/** The section body, from its heading to the next `## `, or undefined. */
function sectionBody(markdown: string): string | undefined {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => line.startsWith(SECTION_HEADING));
  if (start === -1) return undefined;
  const body: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index]!.startsWith('## ')) break;
    body.push(lines[index]!);
  }
  return body.join('\n');
}

/**
 * Every way the documented workaround and the repository disagree.
 *
 * Empty means the section exists, names a command that `package.json` really
 * declares, that command reaches a script which relocates the temp directory
 * into the checkout, and the checkout ignores that directory.
 */
function localTestEnvProblems(facts: Facts): string[] {
  const problems: string[] = [];
  const body = sectionBody(facts.blockers);
  if (body === undefined) {
    return [
      `docs/blockers.md: has no \`${SECTION_HEADING}\` section, so the local-test ` +
        'constraint is a commit message again instead of a page',
    ];
  }

  if (!body.includes(LOCAL_COMMAND)) {
    problems.push(
      `docs/blockers.md: the local-test section does not name \`${LOCAL_COMMAND}\`, so the ` +
        'reader is told the suite fails and not what to run instead',
    );
  }

  const declared = facts.scripts['test:local'];
  if (declared === undefined) {
    problems.push(
      'package.json: declares no `test:local` script, so the command the blockers page gives ' +
        'exits with `Missing script` — a workaround nobody can run',
    );
  } else if (!declared.includes(LOCAL_SCRIPT)) {
    problems.push(
      `package.json: \`test:local\` runs \`${declared}\` and not \`${LOCAL_SCRIPT}\`, so the ` +
        'documented command and the script this gate reads are two different things',
    );
  }

  if (facts.scriptSource.trim().length === 0) {
    problems.push(`scripts/${LOCAL_SCRIPT.split('/').pop()}: is missing, so \`test:local\` runs nothing`);
  } else {
    if (!facts.scriptSource.includes('TMPDIR')) {
      problems.push(
        `${LOCAL_SCRIPT}: never sets \`TMPDIR\`, so it runs the suite against the same \`/tmp\` ` +
          'the section says is full',
      );
    }
    if (!facts.scriptSource.includes(TEMP_DIR_ENTRY.replace('/', ''))) {
      problems.push(
        `${LOCAL_SCRIPT}: does not use a \`${TEMP_DIR_ENTRY}\` directory inside the checkout, so ` +
          'the scratch files land wherever the machine puts them',
      );
    }
  }

  if (!facts.gitignore.split('\n').some((line) => line.trim() === TEMP_DIR_ENTRY)) {
    problems.push(
      `.gitignore: does not ignore \`${TEMP_DIR_ENTRY}\`, so a run leaves a scratch tree that ` +
        'the next `git add -A` commits',
    );
  }

  // The two readings and the error string, because a reader matches their own
  // terminal against these literals and not against a paraphrase.
  for (const literal of ['df -h /tmp', 'df -i /tmp', 'Unknown system error -122']) {
    if (!body.includes(literal)) {
      problems.push(
        `docs/blockers.md: the local-test section does not quote \`${literal}\`, so a reader ` +
          'cannot tell whether their failure is this one',
      );
    }
  }

  return problems;
}

/** The real repository, as the checks see it. */
const facts: Facts = {
  blockers: BLOCKERS,
  scripts: (JSON.parse(read(PACKAGE_PATH) || '{}') as { scripts?: Record<string, string> }).scripts ?? {},
  gitignore: GITIGNORE,
  scriptSource: SCRIPT,
};

describe('the local-test constraint is a command, not a disclaimer', () => {
  it('reads the section, the script and the ignore file, so the checks are not vacuous', () => {
    expect(sectionBody(BLOCKERS), `docs/blockers.md has no \`${SECTION_HEADING}\` section`).toBeDefined();
    expect(SCRIPT, `${LOCAL_SCRIPT} is missing`).not.toBe('');
    expect(GITIGNORE, '.gitignore is missing').not.toBe('');
    expect(Object.keys(facts.scripts).length, 'package.json declares no scripts').toBeGreaterThan(0);
  });

  it('names a command that package.json really declares, and a script that relocates temp', () => {
    const problems = localTestEnvProblems(facts);
    expect(
      problems,
      `the documented workaround and the repository disagree:\n  ${problems.join('\n  ')}`,
    ).toEqual([]);
  });

  it('reports a section whose command is not a script in package.json', () => {
    const problems = localTestEnvProblems({
      ...facts,
      scripts: { ...facts.scripts, 'test:local': undefined } as unknown as Record<string, string>,
    });
    expect(problems).toContain(
      'package.json: declares no `test:local` script, so the command the blockers page gives ' +
        'exits with `Missing script` — a workaround nobody can run',
    );
  });

  it('reports a script that leaves the temp directory where the machine put it', () => {
    const problems = localTestEnvProblems({
      ...facts,
      scriptSource: SCRIPT.replaceAll('TMPDIR', 'SOMETHING_ELSE'),
    });
    expect(problems.some((problem) => problem.includes('never sets `TMPDIR`'))).toBe(true);
  });

  it('reports a scratch directory the checkout would commit', () => {
    const problems = localTestEnvProblems({
      ...facts,
      gitignore: GITIGNORE.replace(TEMP_DIR_ENTRY, ''),
    });
    expect(problems).toContain(
      '.gitignore: does not ignore `.tmp/`, so a run leaves a scratch tree that the next ' +
        '`git add -A` commits',
    );
  });

  it('reports a section that describes the failure without quoting it', () => {
    const problems = localTestEnvProblems({
      ...facts,
      blockers: BLOCKERS.replaceAll('Unknown system error -122', 'a write error'),
    });
    expect(problems.some((problem) => problem.includes('Unknown system error -122'))).toBe(true);
  });

  it('runs the script dry, and the directory it reports is inside the checkout', () => {
    // The one assertion that executes the workaround instead of reading it: a
    // script whose `--dry-run` prints a path outside the repository would be a
    // workaround that relocates nothing.
    const run = spawnSync(process.execPath, [SCRIPT_PATH, '--dry-run'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    expect(run.status, `\`node ${LOCAL_SCRIPT} --dry-run\` exited ${run.status}: ${run.stderr}`).toBe(0);
    const reported = /^TMPDIR=(.+)$/mu.exec(run.stdout)?.[1]?.trim();
    expect(reported, `--dry-run printed no TMPDIR line:\n${run.stdout}`).toBeDefined();
    expect(reported!.startsWith(REPO_ROOT), `--dry-run points TMPDIR at ${reported}, outside the checkout`).toBe(
      true,
    );
  });
});
