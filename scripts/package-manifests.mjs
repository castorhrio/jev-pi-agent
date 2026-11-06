/**
 * The three manifests that have to agree about the packaged app, derived from one.
 *
 * ## The defect this replaces
 *
 * `electron-builder` reads the **root** `package.json` as the app manifest and
 * copies *its* dependency graph into `app.asar`. The shell's own manifest,
 * `apps/desktop/package.json`, is a workspace member: a package declared only
 * there is not in the archive, and the failure exists only after packaging.
 * `db9b379` was exactly that — the shipped build died on
 * `Cannot find module '@ucad/usage'` — and the fix added three packages to the
 * root manifest by hand.
 *
 * Adding them by hand left a second problem: `npm run knip` then exited 1,
 * because no root-level script or test imports those three. `a1ad2cd` fixed
 * that by adding them to `knip.json`'s `ignoreDependencies` — also by hand.
 *
 * So the same fact lived in three files, and each round of the defect was
 * repaired by editing the two files the previous round had not touched:
 *
 *   1. `apps/desktop/package.json` — what the shell actually requires;
 *   2. `package.json` (root) — what `electron-builder` copies into the archive;
 *   3. `knip.json` — which of those the static analyser cannot see.
 *
 * `tests/contract/desktop-runtime-deps.test.ts` and
 * `tests/contract/package-manifest.test.ts` each compare two of the three, so a
 * missing entry is caught — but only *after* someone has already written the
 * wrong pair. They are a patch, not a source. This file is the source: (2) and
 * (3) are **derived** from (1) plus the source trees, and
 * `tests/contract/manifest-single-source.test.ts` asserts the files on disk are
 * what the derivation produces. Editing one of the three without the others is
 * now a red gate, and `npm run manifests:write` is the one command that fixes it.
 *
 * ## What is derived, and from what
 *
 *  - **The root `@ucad/*` section** is the `@ucad/*` section of
 *    `apps/desktop/package.json`, pinned to the root version. The shell's
 *    manifest is the human-authored statement of what the packaged app needs;
 *    the root manifest is a copy of it, because that is the graph
 *    `electron-builder` walks. Non-`@ucad` dependencies are left alone: the
 *    root manifest carries `zod` for the same reason, and the renderer's
 *    `@xterm/*` packages are bundled by Vite and never resolved from
 *    `node_modules` at run time, so declaring them at the root would be noise.
 *  - **`knip.json`'s `ignoreDependencies`** is every `@ucad/*` package that knip
 *    reports as unused, which is two different facts with one shape:
 *      * declared in `apps/desktop/package.json` but never named by a `from`
 *        clause in `apps/desktop/src` — the adapters are required **by name**
 *        (`adapter-candidates.ts`), so no static import names them;
 *      * declared at the root but never named by a `from` clause in
 *        `scripts/` or `tests/` — the root workspace's project files, which is
 *        what knip analyses there.
 *
 * ## Why the derivation is allowed to disagree with knip
 *
 * It is not: `npm run knip` is a CI gate, so a derivation that mis-reads knip's
 * rule turns CI red on the next run and the rule gets fixed here. The two are a
 * pair — this file says *which* entries the list must have, knip says whether
 * the list is still the right shape at all. Neither is a second opinion about
 * the other; they fail in different directions.
 *
 * ## What it proves, and what it does not
 *
 * It proves the three files agree, and that they agree with the source trees
 * they are derived from. It does **not** prove the archive boots — that is
 * `scripts/verify-packaged-adapters.mjs` and `scripts/verify-main-chain.mjs`,
 * which need a packaged build and, for the second, a Windows machine. A
 * manifest can be perfectly consistent and still be missing a package the
 * source requires at run time in a way no `from` clause shows; the scan in
 * `desktop-runtime-deps.test.ts` covers that half.
 *
 * ## Usage
 *
 *   node scripts/package-manifests.mjs            # --check: exit 1 and name every disagreement
 *   node scripts/package-manifests.mjs --check    # the same, spelled out
 *   node scripts/package-manifests.mjs --print    # the derived sections, writes nothing
 *   node scripts/package-manifests.mjs --write    # regenerate both files from apps/desktop/package.json
 *
 * An unrecognised flag is an error rather than a default: `--chek` silently
 * running the check, or `--writ` silently writing, is the class of defect this
 * repository keeps naming (`--steps 6`, `--no-installers`, `--requires`).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** The repository root, so a copy of this script is a whole repository. */
export const REPO_ROOT = path.resolve(here, '..');

/** The manifest `electron-builder` reads: the app's dependency graph. */
export const ROOT_MANIFEST_PATH = 'package.json';

/** The shell's own manifest: the human-authored statement of what it requires. */
export const DESKTOP_MANIFEST_PATH = 'apps/desktop/package.json';

/** The static analyser's configuration, whose ignore list is a claim about the artifact. */
export const KNIP_CONFIG_PATH = 'knip.json';

/** The workspace packages are all in this scope. */
export const UCAD_SCOPE = '@ucad/';

/** The root workspace's project files — what knip analyses at the root. */
export const ROOT_SOURCE_DIRS = ['scripts', 'tests'];

/** The desktop workspace's project files — what knip analyses for the shell. */
export const DESKTOP_SOURCE_DIR = 'apps/desktop/src';

/** The extensions knip's `project` globs cover in the two workspaces. */
const SOURCE_FILE = /\.(?:mjs|cjs|ts|tsx)$/u;

/** A `from '<specifier>'` clause, which is the only shape knip counts as usage. */
const FROM_CLAUSE = /from\s+['"]([^'"]+)['"]/gu;

/** Every `@ucad/*` name in a dependency map, sorted. */
export function ucadNames(dependencies) {
  return Object.keys(dependencies ?? {})
    .filter((name) => name.startsWith(UCAD_SCOPE))
    .sort();
}

/** Every module specifier a `from` clause names, as a set. */
export function importedSpecifiers(text) {
  const found = new Set();
  for (const match of text.matchAll(FROM_CLAUSE)) found.add(match[1]);
  return found;
}

/** Every source file under `dir`, recursively, in a stable order. */
export function sourceFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(full));
    else if (entry.isFile() && SOURCE_FILE.test(entry.name)) found.push(full);
  }
  return found;
}

/** The concatenated text of every source file under `dirs`, for the import scan. */
export function sourceText(dirs) {
  return dirs
    .flatMap((dir) => sourceFiles(dir))
    .map((file) => fs.readFileSync(file, 'utf8'))
    .join('\n');
}

/**
 * The root manifest's `@ucad/*` section, as `{ name: version }`.
 *
 * The shell's manifest is the input; the root manifest is the copy
 * `electron-builder` walks. Pinned to the root version because every `@ucad/*`
 * package is this repository at this version — a pin that says anything else
 * resolves to something that is not the tree being packaged.
 */
export function deriveRootUcadSection({ desktop, version }) {
  const section = {};
  for (const name of ucadNames(desktop.dependencies)) section[name] = version;
  return section;
}

/**
 * The `ignoreDependencies` list knip needs, derived from the two source trees.
 *
 * Two rules, one list — see the header. Both are "declared in a manifest, never
 * named by a `from` clause in that workspace's project files", which is what
 * knip reports as an unused dependency.
 */
export function deriveKnipIgnores({ desktop, rootSourceText, desktopSourceText }) {
  const rootImports = importedSpecifiers(rootSourceText);
  const desktopImports = importedSpecifiers(desktopSourceText);
  const ignores = new Set();
  for (const name of ucadNames(desktop.dependencies)) {
    // knip analyses `apps/desktop` and reports the package there.
    if (!desktopImports.has(name)) ignores.add(name);
    // knip analyses the root workspace and reports the same package again.
    if (!rootImports.has(name)) ignores.add(name);
  }
  return [...ignores].sort();
}

/** The package directories under `packages/`, by package name. */
export function packageDirectories(repoRoot = REPO_ROOT) {
  const dir = path.join(repoRoot, 'packages');
  if (!fs.existsSync(dir)) return new Map();
  const found = new Map();
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = path.join(dir, entry.name, 'package.json');
    if (!fs.existsSync(manifest)) continue;
    const parsed = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    if (typeof parsed.name === 'string') found.set(parsed.name, entry.name);
  }
  return found;
}

/**
 * Everything the three files disagree about, as lines a reader can act on.
 *
 * Pure in its inputs, so every red direction is driven with a mutated copy
 * instead of argued about — the same shape the other gates in this repository
 * use, and the reason `tests/contract/manifest-single-source.test.ts` can show
 * each failure without editing the repository.
 */
export function manifestDrift({
  root,
  desktop,
  knip,
  rootSourceText,
  desktopSourceText,
  packageDirs,
}) {
  const problems = [];
  const derived = deriveRootUcadSection({ desktop, version: root.version });
  const declared = ucadNames(root.dependencies);

  for (const name of Object.keys(derived)) {
    if (!declared.includes(name)) {
      problems.push(
        `${ROOT_MANIFEST_PATH}: \`${name}\` is declared by ${DESKTOP_MANIFEST_PATH} but missing ` +
          'from the root manifest — electron-builder copies the root manifest’s dependency graph ' +
          'into app.asar, so the packaged app cannot require it (the `db9b379` failure)',
      );
    }
  }
  for (const name of declared) {
    if (!(name in derived)) {
      problems.push(
        `${ROOT_MANIFEST_PATH}: \`${name}\` is declared at the root but ${DESKTOP_MANIFEST_PATH} ` +
          'does not declare it — the root manifest is a copy of the shell’s runtime graph, and an ' +
          'entry the shell does not require ships a package nothing in the archive asks for',
      );
    }
  }
  for (const [name, version] of Object.entries(root.dependencies ?? {})) {
    if (!name.startsWith(UCAD_SCOPE)) continue;
    if (version !== root.version) {
      problems.push(
        `${ROOT_MANIFEST_PATH}: \`${name}\` is pinned to \`${version}\` but the app is ` +
          `\`${root.version}\` — every \`${UCAD_SCOPE}*\` package is this repository at this ` +
          'version, and a different pin resolves to something that is not the tree being packaged',
      );
    }
  }
  for (const name of Object.keys(derived)) {
    if (!packageDirs.has(name)) {
      problems.push(
        `${DESKTOP_MANIFEST_PATH}: \`${name}\` names no directory under \`packages/\` — a phantom ` +
          'dependency makes every check above pass for the wrong reason, and `npm ci` cannot ' +
          'resolve it',
      );
    }
  }

  const expectedIgnores = deriveKnipIgnores({ desktop, rootSourceText, desktopSourceText });
  const actualIgnores = [...(knip.ignoreDependencies ?? [])].sort();
  for (const name of expectedIgnores) {
    if (!actualIgnores.includes(name)) {
      problems.push(
        `${KNIP_CONFIG_PATH}: \`${name}\` is missing from \`ignoreDependencies\` — no \`from\` ` +
          'clause in the workspace that declares it names it, so `npm run knip` reports it as an ' +
          'unused dependency and CI goes red',
      );
    }
  }
  for (const name of actualIgnores) {
    if (!expectedIgnores.includes(name)) {
      problems.push(
        `${KNIP_CONFIG_PATH}: \`${name}\` is ignored but the derivation does not produce it — an ` +
          'ignore entry is a claim that the packaged app resolves the package at run time, and ' +
          'this one silences a finding nothing backs',
      );
    }
  }
  return problems;
}

/** Everything the derivation reads, so a caller can print or mutate one snapshot. */
export function readSnapshot(repoRoot = REPO_ROOT) {
  const readJson = (relative) => JSON.parse(fs.readFileSync(path.join(repoRoot, relative), 'utf8'));
  return {
    root: readJson(ROOT_MANIFEST_PATH),
    desktop: readJson(DESKTOP_MANIFEST_PATH),
    knip: readJson(KNIP_CONFIG_PATH),
    rootSourceText: sourceText(ROOT_SOURCE_DIRS.map((dir) => path.join(repoRoot, dir))),
    desktopSourceText: sourceText([path.join(repoRoot, DESKTOP_SOURCE_DIR)]),
    packageDirs: packageDirectories(repoRoot),
  };
}

/**
 * The root manifest with its `@ucad/*` section replaced by the derived one.
 *
 * The section keeps the position of the first `@ucad/*` key it replaces, so the
 * diff of a regeneration is the entries that changed and nothing else. The rest
 * of the file is re-serialised with the indentation it already uses, which is
 * what makes `--write` a no-op on a tree that is already consistent.
 */
export function renderRootManifest(root, section) {
  const dependencies = {};
  let placed = false;
  for (const [name, version] of Object.entries(root.dependencies ?? {})) {
    if (name.startsWith(UCAD_SCOPE)) {
      if (!placed) {
        Object.assign(dependencies, section);
        placed = true;
      }
      continue;
    }
    dependencies[name] = version;
  }
  if (!placed) Object.assign(dependencies, section);
  return `${JSON.stringify({ ...root, dependencies }, null, 2)}\n`;
}

/** `knip.json` with its `ignoreDependencies` replaced by the derived list. */
export function renderKnipConfig(knip, ignores) {
  return `${JSON.stringify({ ...knip, ignoreDependencies: ignores }, null, 2)}\n`;
}

/** The two files `--write` regenerates, as `{ path, text }`. */
export function derivedFiles(snapshot) {
  const section = deriveRootUcadSection({ desktop: snapshot.desktop, version: snapshot.root.version });
  const ignores = deriveKnipIgnores({
    desktop: snapshot.desktop,
    rootSourceText: snapshot.rootSourceText,
    desktopSourceText: snapshot.desktopSourceText,
  });
  return [
    { path: ROOT_MANIFEST_PATH, text: renderRootManifest(snapshot.root, section) },
    { path: KNIP_CONFIG_PATH, text: renderKnipConfig(snapshot.knip, ignores) },
  ];
}

const USAGE = 'usage: node scripts/package-manifests.mjs [--check | --print | --write]';

/** The flags this script understands; anything else is an error. */
export function parseArgv(argv) {
  const parsed = { mode: 'check', unknown: [] };
  for (const arg of argv) {
    if (arg === '--check') parsed.mode = 'check';
    else if (arg === '--print') parsed.mode = 'print';
    else if (arg === '--write') parsed.mode = 'write';
    else parsed.unknown.push(arg);
  }
  return parsed;
}

function main(argv) {
  const args = parseArgv(argv);
  if (args.unknown.length > 0) {
    console.error(`unknown option(s): ${args.unknown.join(', ')}`);
    console.error(USAGE);
    return 1;
  }

  const snapshot = readSnapshot();
  const section = deriveRootUcadSection({ desktop: snapshot.desktop, version: snapshot.root.version });
  const ignores = deriveKnipIgnores({
    desktop: snapshot.desktop,
    rootSourceText: snapshot.rootSourceText,
    desktopSourceText: snapshot.desktopSourceText,
  });

  if (args.mode === 'print') {
    console.log(`[derived] ${ROOT_MANIFEST_PATH} dependencies (${Object.keys(section).length}):`);
    for (const [name, version] of Object.entries(section)) console.log(`  ${name}: ${version}`);
    console.log(`[derived] ${KNIP_CONFIG_PATH} ignoreDependencies (${ignores.length}):`);
    for (const name of ignores) console.log(`  ${name}`);
    console.log('PASS — printed the derivation; nothing was written');
    return 0;
  }

  if (args.mode === 'write') {
    let changed = 0;
    for (const file of derivedFiles(snapshot)) {
      const full = path.join(REPO_ROOT, file.path);
      const before = fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : '';
      if (before === file.text) {
        console.log(`[same] ${file.path}`);
        continue;
      }
      fs.writeFileSync(full, file.text, 'utf8');
      changed += 1;
      console.log(`[wrote] ${file.path}`);
    }
    console.log(
      changed === 0
        ? 'PASS — both files already are what the derivation produces; nothing was written'
        : `PASS — rewrote ${changed} file(s) from ${DESKTOP_MANIFEST_PATH}`,
    );
    return 0;
  }

  const problems = manifestDrift(snapshot);
  if (problems.length > 0) {
    for (const problem of problems) console.error(`[FAIL] ${problem}`);
    console.error(
      `FAIL — ${problems.length} disagreement(s) between ${DESKTOP_MANIFEST_PATH}, ` +
        `${ROOT_MANIFEST_PATH} and ${KNIP_CONFIG_PATH}; run \`npm run manifests:write\` to ` +
        'regenerate the two derived files',
    );
    return 1;
  }
  console.log(
    `PASS — ${ROOT_MANIFEST_PATH} carries the ${Object.keys(section).length} \`${UCAD_SCOPE}*\` ` +
      `dependencies ${DESKTOP_MANIFEST_PATH} declares, and ${KNIP_CONFIG_PATH} ignores exactly the ` +
      `${ignores.length} of them no \`from\` clause names`,
  );
  return 0;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
