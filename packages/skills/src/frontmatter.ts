/**
 * A minimal, hand-rolled front matter parser for `SKILL.md`.
 *
 * The format is the one `agentskills.io` / Claude Code already use — a `---`
 * fenced block of `key: value` at the top of a markdown file — and this parser
 * reads exactly the four keys UCAD needs:
 *
 *     ---
 *     name: pdf
 *     description: Extract, split and merge PDF files.
 *     agents: [pi, codex]
 *     tools: [read_file, "deny:rm -rf*"]
 *     ---
 *
 * `name` and `description` are the standard keys; `agents` and `tools` are
 * additive keys in the same block. A consumer that does not know them ignores
 * them, and a consumer that does reads the same file — that is the whole
 * compatibility story, and it is why this is not a competing format.
 *
 * No YAML dependency on purpose: the grammar is four lines wide, and a
 * 60-line parser that is read in one sitting is cheaper than a dependency whose
 * behaviour on a hostile file this repo would then have to audit.
 *
 * Two rules the callers depend on (NFR-05, "never throw on a foreign file"):
 *   - a file with **no** front matter is still a skill; the name falls back to
 *     the directory name;
 *   - a file with **malformed** front matter is refused, with a reason, rather
 *     than half-parsed. Silently dropping half a front matter block would bind
 *     a skill to the wrong agents.
 */

import type { SkillFrontmatter } from './types';

/** A front matter block larger than this is a data file, not a skill. */
export const MAX_FRONTMATTER_CHARS = 8_000;

const OPEN_FENCE = /^---\s*$/;
const CLOSE_FENCE = /^(?:---|\.\.\.)\s*$/;
const KEY_LINE = /^([A-Za-z0-9_.-]+)[ \t]*:[ \t]*(.*)$/;
const LIST_ITEM = /^-[ \t]+(.*)$/;
const COMMENT_LINE = /^[ \t]*#/;

export type FrontmatterResult =
  | { ok: true; frontmatter: SkillFrontmatter; body: string; hadFrontmatter: boolean }
  | { ok: false; reason: string };

/** Strips a matching pair of quotes; single or double, nothing else. */
function unquote(raw: string): string {
  const value = raw.trim();
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

/**
 * `key: [a, b]` and `key: [a, "b, c"]`. Commas inside quotes do not split,
 * because a tool pattern like `"deny:rm -rf*, --force"` is a real shape.
 */
function parseInlineList(raw: string): string[] {
  const inner = raw.trim().slice(1, -1);
  const out: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (const char of inner) {
    if (quote) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === ',') {
      out.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  out.push(current);
  return out.map((entry) => unquote(entry)).filter((entry) => entry.length > 0);
}

/** Lower-cased, de-blanked, de-duplicated: the shape every consumer compares. */
function normalizeList(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed.length === 0) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

function readList(values: Map<string, string[]> | undefined, key: string): string[] {
  return normalizeList(values?.get(key) ?? []);
}

/**
 * Parses one `SKILL.md`.
 *
 * `fallbackName` is the directory name: it is what a front-matter-free file is
 * called, and it is also what an *empty* `name:` falls back to, because a
 * skill with no name still has to be addressable as `ucad://skill/<name>`.
 */
export function parseSkillFile(text: string, fallbackName: string): FrontmatterResult {
  // A UTF-8 BOM survives a round trip through some editors, and `\uFEFF---`
  // would otherwise read as "no front matter".
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = source.split(/\r\n|\n|\r/);

  const firstMeaningful = lines.findIndex((line) => line.trim().length > 0);
  if (firstMeaningful === -1) {
    return { ok: false, reason: 'the file is empty' };
  }
  const opening = lines[firstMeaningful] ?? '';
  if (!OPEN_FENCE.test(opening)) {
    // No front matter at all: still a skill, named after its directory.
    return {
      ok: true,
      frontmatter: { name: fallbackName, agents: [], tools: [] },
      body: source,
      hadFrontmatter: false,
    };
  }

  let close = -1;
  for (let i = firstMeaningful + 1; i < lines.length; i++) {
    if (CLOSE_FENCE.test(lines[i] ?? '')) {
      close = i;
      break;
    }
  }
  if (close === -1) {
    return { ok: false, reason: 'the front matter block is never closed with a `---` line' };
  }

  const block = lines.slice(firstMeaningful + 1, close);
  const blockChars = block.reduce((sum, line) => sum + line.length + 1, 0);
  if (blockChars > MAX_FRONTMATTER_CHARS) {
    return {
      ok: false,
      reason: `the front matter block is ${blockChars} chars, over the ${MAX_FRONTMATTER_CHARS} char limit`,
    };
  }

  const scalars = new Map<string, string>();
  const lists = new Map<string, string[]>();
  let pendingListKey: string | null = null;

  for (let i = 0; i < block.length; i++) {
    const line = block[i] ?? '';
    if (line.trim().length === 0 || COMMENT_LINE.test(line)) continue;

    const item = LIST_ITEM.exec(line);
    if (item) {
      if (pendingListKey === null) {
        return { ok: false, reason: `line ${firstMeaningful + 2 + i} is a list item that belongs to no key` };
      }
      const bucket = lists.get(pendingListKey) ?? [];
      const value = unquote(item[1] ?? '');
      if (value.length > 0) bucket.push(value);
      lists.set(pendingListKey, bucket);
      continue;
    }

    const key = KEY_LINE.exec(line);
    if (!key) {
      return { ok: false, reason: `line ${firstMeaningful + 2 + i} is not a \`key: value\` pair: "${line.trim()}"` };
    }

    const name = (key[1] ?? '').toLowerCase();
    const raw = (key[2] ?? '').trim();
    pendingListKey = null;

    if (raw.startsWith('[') && raw.endsWith(']')) {
      lists.set(name, parseInlineList(raw));
      continue;
    }
    if (raw.length === 0) {
      // Either `agents:` followed by `- id` lines, or a key with no value.
      pendingListKey = name;
      lists.set(name, []);
      continue;
    }
    scalars.set(name, unquote(raw));
  }

  const declared = (scalars.get('name') ?? '').trim();
  const description = (scalars.get('description') ?? '').trim();
  const frontmatter: SkillFrontmatter = {
    name: declared.length > 0 ? declared : fallbackName,
    ...(description.length > 0 ? { description } : {}),
    agents: readList(lists, 'agents'),
    tools: readList(lists, 'tools'),
  };

  return {
    ok: true,
    frontmatter,
    body: lines.slice(close + 1).join('\n').replace(/^\n+/, ''),
    hadFrontmatter: true,
  };
}
