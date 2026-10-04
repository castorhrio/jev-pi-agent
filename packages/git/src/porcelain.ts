/**
 * `git status --porcelain=v1 -b --untracked-files=all` parsing.
 *
 * v1 format (§9 "Git 解析"):
 *   `XY <path>`        X = index status, Y = worktree status, ' ' = unchanged
 *   `?? <path>`        untracked
 *   `R  <old> -> <new>`  rename (the v1 in-band arrow form)
 * plus a leading `## <branch>` header when `-b` is passed.
 *
 * The parser is a pure function of the text: no clock, no fs, no locale.
 */

import type { GitStatusDto } from '@ucad/contracts';

export interface PorcelainStatusEntry {
  path: string;
  status: string;
}

export interface PorcelainParseResult {
  branch: string;
  /** `## ` header exactly as git printed it, for diagnostics. */
  header: string;
  staged: PorcelainStatusEntry[];
  unstaged: PorcelainStatusEntry[];
  untracked: string[];
}

/** A repository without commits: HEAD does not resolve, so the UI gets zeros. */
export const EMPTY_HEAD = '0'.repeat(40);

const DETACHED_BRANCH = 'HEAD';

/**
 * Git C-quotes a path when it contains a quote, a backslash, a control
 * character or (with `core.quotePath`, the default) a non-ASCII byte. On
 * Windows that means every ordinary path comes back as
 * `"src\\index.ts"`, so this decoding is mandatory, not an edge case.
 */
export function unquotePorcelainPath(value: string): string {
  if (!value.startsWith('"')) {
    return value;
  }
  const bytes: number[] = [];
  for (let i = 1; i < value.length; i += 1) {
    const ch = value[i];
    if (ch === undefined) {
      break;
    }
    if (ch === '"') {
      break;
    }
    if (ch !== '\\') {
      for (const byte of Buffer.from(ch, 'utf8')) {
        bytes.push(byte);
      }
      continue;
    }
    const next = value[i + 1];
    i += 1;
    if (next === undefined) {
      break;
    }
    const simple: Record<string, number> = {
      a: 0x07, b: 0x08, t: 0x09, n: 0x0a, v: 0x0b, f: 0x0c, r: 0x0d,
      '"': 0x22, '\\': 0x5c,
    };
    const mapped = simple[next];
    if (mapped !== undefined) {
      bytes.push(mapped);
      continue;
    }
    if (next >= '0' && next <= '7') {
      let octal = next;
      for (let extra = 0; extra < 2; extra += 1) {
        const digit = value[i + 1];
        if (digit === undefined || digit < '0' || digit > '7') {
          break;
        }
        octal += digit;
        i += 1;
      }
      bytes.push(parseInt(octal, 8) & 0xff);
      continue;
    }
    // An unknown escape keeps the character itself rather than losing bytes.
    for (const byte of Buffer.from(next, 'utf8')) {
      bytes.push(byte);
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/**
 * `R  old.ts -> new.ts` — the arrow is only a rename marker when it sits
 * outside a quoted segment, otherwise a file literally named `a -> b` would be
 * torn in half.
 */
function splitRenamePath(value: string): { oldPath: string; newPath: string } | null {
  let inQuotes = false;
  for (let i = 0; i < value.length - 3; i += 1) {
    const ch = value[i];
    if (ch === '\\' && inQuotes) {
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && value.startsWith(' -> ', i)) {
      return {
        oldPath: unquotePorcelainPath(value.slice(0, i)),
        newPath: unquotePorcelainPath(value.slice(i + 4)),
      };
    }
  }
  return null;
}

/** `## main...origin/main [ahead 1]` / `## No commits yet on main` / `## HEAD (no branch)` */
export function parseBranchHeader(header: string): string {
  const body = header.startsWith('## ') ? header.slice(3) : header;
  if (body.startsWith('No commits yet on ')) {
    return body.slice('No commits yet on '.length).split('...')[0]?.trim() || 'main';
  }
  if (body.startsWith('Initial commit on ')) {
    return body.slice('Initial commit on '.length).split('...')[0]?.trim() || 'main';
  }
  if (body === DETACHED_BRANCH || body.startsWith(`${DETACHED_BRANCH} `)) {
    return DETACHED_BRANCH;
  }
  const name = body.split('...')[0]?.split(' [')[0]?.trim() ?? '';
  return name.length > 0 ? name : DETACHED_BRANCH;
}

export function parsePorcelainStatus(stdout: string): PorcelainParseResult {
  const result: PorcelainParseResult = {
    branch: DETACHED_BRANCH,
    header: '',
    staged: [],
    unstaged: [],
    untracked: [],
  };

  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (line.length === 0) {
      continue;
    }
    if (line.startsWith('## ')) {
      result.header = line;
      result.branch = parseBranchHeader(line);
      continue;
    }
    if (line.length < 4) {
      continue;
    }

    const x = line[0] ?? ' ';
    const y = line[1] ?? ' ';
    const rawPath = line.slice(3);
    if (rawPath.length === 0) {
      continue;
    }

    if (x === '?' && y === '?') {
      result.untracked.push(unquotePorcelainPath(rawPath));
      continue;
    }

    // R / C in either position means a rename or a copy; the v1 line carries
    // both sides and the index side is the one that changed.
    const rename = (x === 'R' || x === 'C' || y === 'R' || y === 'C') ? splitRenamePath(rawPath) : null;
    const displayPath = rename?.newPath ?? unquotePorcelainPath(rawPath);
    if (x !== ' ' && x !== '?') {
      result.staged.push({ path: displayPath, status: x });
    }
    if (y !== ' ' && y !== '?') {
      result.unstaged.push({ path: displayPath, status: y });
    }
  }

  return result;
}

export function toGitStatusDto(
  parsed: PorcelainParseResult,
  head: string,
): GitStatusDto {
  return {
    branch: parsed.branch,
    head,
    dirty: parsed.staged.length > 0 || parsed.unstaged.length > 0 || parsed.untracked.length > 0,
    staged: parsed.staged,
    unstaged: parsed.unstaged,
    untracked: parsed.untracked,
  };
}
