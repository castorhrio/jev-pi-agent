/**
 * §4.5 / skills plane — discovery.
 *
 * A skill is a directory containing one markdown file, discovered on disk:
 *
 *     <root>/<name>/SKILL.md
 *
 * where a root is `<workspace>/.ucad/skills` or `~/.ucad/skills`. The layout is
 * the `agentskills.io` convention; UCAD does not invent a second one.
 *
 * The two properties that matter to the rest of the package:
 *   - **Deterministic**: the result is ordered by name, and nothing in it
 *     (except the honest `fingerprint`) depends on directory iteration order.
 *   - **Total**: an unreadable, oversized, empty or malformed file is reported
 *     through `onSkip` and skipped. One bad file in a user's skill directory
 *     must not be able to take a turn down (NFR-05).
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';


import { sha256Hex } from '@ucad/observability';

import { parseSkillFile } from './frontmatter';
import type { Skill, SkillRoot, SkillScope, SkillSkip } from './types';

/** The file name a skill directory must contain. */
export const SKILL_FILE_NAME = 'SKILL.md';

/**
 * A SKILL.md larger than this is not a skill body, it is a data file someone
 * pointed the loader at. Refused with a reason instead of read into a prompt.
 */
export const MAX_SKILL_FILE_BYTES = 256 * 1024;

/** Never walked: the two directories that turn a scan into an outage. */
const IGNORED_DIRECTORIES: ReadonlySet<string> = new Set(['node_modules', '.git']);

/** Defends the scan against a symlink loop. */
const MAX_SCAN_DEPTH = 4;

/** `<workspace>/.ucad/skills` and `~/.ucad/skills`, the two places to look. */
export function defaultSkillRoots(workspaceRoot?: string): SkillRoot[] {
  const roots: SkillRoot[] = [];
  if (workspaceRoot) {
    roots.push({ path: join(resolve(workspaceRoot), '.ucad', 'skills'), scope: 'workspace' });
  }
  roots.push({ path: join(homedir(), '.ucad', 'skills'), scope: 'user' });
  return roots;
}

export interface DiscoverOptions {
  /**
   * Which scope a root belongs to. The default is the honest reading of the
   * two documented locations: a root inside the user's home directory is the
   * user's, anything else belongs to a workspace. Pass an explicit function
   * when a caller knows better than the path shape.
   */
  scopeOf?: (root: string) => SkillScope;
  /** called once per file that looked like a skill and was not usable */
  onSkip?: (skip: SkillSkip) => void;
  maxFileBytes?: number;
}

/** Stable, path-derived, and identical across runs on the same machine. */
function skillIdFor(absolutePath: string): string {
  const normalized = absolutePath.split(sep).join('/').toLowerCase();
  return `sk_${sha256Hex(normalized).slice(0, 16)}`;
}

/** `true` for a directory name that must never be entered. */
function isIgnored(name: string): boolean {
  return IGNORED_DIRECTORIES.has(name) || name.startsWith('.');
}

function scopeOfDefault(root: string): SkillScope {
  const home = homedir();
  const normalizedRoot = resolve(root);
  return normalizedRoot === home || normalizedRoot.startsWith(home + sep) ? 'user' : 'workspace';
}

/**
 * Lists the candidate skill directories under one root.
 *
 * Returns an empty list for a root that does not exist — a user with no
 * `~/.ucad/skills` is the normal case, not an error.
 */
function scanRoot(root: string, depth = 0): Array<{ directory: string; name: string }> {
  let entries: Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const found: Array<{ directory: string; name: string }> = [];
  // Sorted, because the filesystem does not promise an order and the pack must
  // be reproducible from the same tree.
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (isIgnored(entry.name)) continue;

    const directory = join(root, entry.name);
    if (entry.isSymbolicLink()) {
      // Only follow a link that resolves to a directory, and only this far
      // down: a link cycle would otherwise read forever.
      try {
        if (!statSync(directory).isDirectory()) continue;
      } catch {
        continue;
      }
    }
    found.push({ directory, name: entry.name });
    if (depth + 1 < MAX_SCAN_DEPTH) {
      // One level of nesting is the convention; deeper is still a skill tree
      // to some users, so it is walked, but never past MAX_SCAN_DEPTH.
      found.push(...scanRoot(directory, depth + 1));
    }
  }
  return found;
}

/**
 * Discovers every skill under `roots`.
 *
 * Collision rule: a workspace skill shadows a user skill of the same **name**,
 * which is how a project overrides a personal default. Within one scope the
 * earlier root in `roots` wins, so the caller controls precedence by ordering.
 * The result is sorted by name.
 */
export function discoverSkills(roots: readonly string[], options: DiscoverOptions = {}): Skill[] {
  const maxFileBytes = options.maxFileBytes ?? MAX_SKILL_FILE_BYTES;
  const onSkip = options.onSkip;
  const scopeOf = options.scopeOf ?? scopeOfDefault;
  const byName = new Map<string, Skill>();

  for (const root of roots) {
    const absoluteRoot = resolve(root);
    const scope = scopeOf(absoluteRoot);
    for (const candidate of scanRoot(absoluteRoot)) {
      const sourcePath = join(candidate.directory, SKILL_FILE_NAME);
      let text: string;
      let bytes: number;
      let mtimeMs: number;
      try {
        const stat = statSync(sourcePath);
        if (!stat.isFile()) continue;
        bytes = stat.size;
        mtimeMs = stat.mtimeMs;
        if (bytes > maxFileBytes) {
          onSkip?.({ sourcePath, reason: `the file is ${bytes} bytes, over the ${maxFileBytes} byte limit` });
          continue;
        }
        text = readFileSync(sourcePath, 'utf8');
      } catch (error) {
        onSkip?.({ sourcePath, reason: `the file could not be read: ${String(error)}` });
        continue;
      }

      const parsed = parseSkillFile(text, candidate.name);
      if (!parsed.ok) {
        onSkip?.({ sourcePath, reason: parsed.reason });
        continue;
      }

      const name = parsed.frontmatter.name.trim();
      if (name.length === 0) {
        onSkip?.({ sourcePath, reason: 'the skill has no usable name' });
        continue;
      }
      // A file with no front matter at all is still a valid skill: the parser
      // has already fallen back to the directory name, and `agents: []` is the
      // honest encoding of "applies to every agent".
      const existing = byName.get(name);
      // Workspace beats user. Same scope: the earlier root wins, because the
      // caller ordered the roots and that ordering is the only precedence
      // signal it has.
      if (existing && (existing.scope === 'workspace' || scope === 'user')) continue;

      const skill: Skill = {
        id: skillIdFor(sourcePath),
        name,
        ...(parsed.frontmatter.description ? { description: parsed.frontmatter.description } : {}),
        agents: parsed.frontmatter.agents,
        tools: parsed.frontmatter.tools,
        body: parsed.body,
        sourcePath,
        scope,
        fingerprint: `${Math.round(mtimeMs)}-${bytes}`,
        bytes,
      };
      byName.set(name, skill);
    }
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
