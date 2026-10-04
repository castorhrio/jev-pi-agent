/**
 * §4.8 filesystem scanning for the Basic provider.
 *
 * This is the ONLY place in the package that touches the disk, and it touches
 * it with `node:fs` / `node:path` alone: no network, no child process, no
 * Docker (the manifest says `transport: 'in_process'`, `requires: []`).
 *
 * Every walk is bounded and abortable (NFR-05): the caller checks `signal` in
 * its own loop and the generator stops yielding as soon as the signal fires.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** §5 Basic Provider implementation constraints. */
export const BASIC_IGNORED_DIRECTORIES: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.ucad-data',
  'out',
  'release',
]);

/** The only extensions the Basic provider ever reads. */
export const BASIC_TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'json',
  'md',
  'py',
  'rs',
  'go',
  'java',
  'kt',
  'cs',
  'cpp',
  'c',
  'h',
  'hpp',
  'rb',
  'php',
  'sql',
  'yml',
  'yaml',
  'toml',
  'xml',
  'html',
  'css',
  'scss',
  'sh',
  'ps1',
]);

export const BASIC_MAX_FILE_BYTES = 1024 * 1024;

const BINARY_SNIFF_BYTES = 4096;

export interface ScannedFile {
  absPath: string;
  /** POSIX-style path relative to the workspace root */
  relPath: string;
  size: number;
  /** lower-case extension without the dot; '' when the file has none */
  extension: string;
}

export interface WalkOptions {
  maxFileBytes: number;
  limit?: number;
  signal?: AbortSignal;
  /** non-fatal IO problems (permissions, races) are reported, never thrown */
  onError?: (path: string, error: unknown) => void;
}

/** `.TS` -> `ts`; `Makefile` -> ''. */
export function extensionOf(filePath: string): string {
  const base = path.basename(filePath);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return '';
  return base.slice(dot + 1).toLowerCase();
}

export function isTextExtension(filePath: string): boolean {
  return BASIC_TEXT_EXTENSIONS.has(extensionOf(filePath));
}

/** NUL byte, or a high share of control characters => not text. */
export function looksBinary(buffer: Buffer): boolean {
  const slice = buffer.subarray(0, BINARY_SNIFF_BYTES);
  let control = 0;
  for (const byte of slice) {
    if (byte === 0) return true;
    if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13 && byte !== 12) control += 1;
  }
  return slice.length > 0 && control / slice.length > 0.1;
}

/**
 * Depth-first, alphabetically stable walk. Skips ignored directories, symbolic
 * links (they can escape the workspace and can form cycles) and files above
 * `maxFileBytes`. Binary files are not detected here — that costs a read, and
 * the caller only reads what it is about to match against.
 */
export function* walkFiles(root: string, opts: WalkOptions): Generator<ScannedFile> {
  const limit = opts.limit ?? Number.POSITIVE_INFINITY;
  let emitted = 0;
  const stack: string[] = [root];

  while (stack.length > 0) {
    if (opts.signal?.aborted) return;
    const dir = stack.pop();
    if (dir === undefined) return;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      opts.onError?.(dir, error);
      continue;
    }
    // sorted() keeps `overview` and every path list reproducible (D-6 replay).
    entries.sort((a, b) => a.name.localeCompare(b.name));

    // Directories are pushed in reverse so the traversal stays alphabetical.
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const entry = entries[i];
      if (entry === undefined) continue;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (BASIC_IGNORED_DIRECTORIES.has(entry.name)) continue;
        stack.push(path.join(dir, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;

      const absPath = path.join(dir, entry.name);
      let size: number;
      try {
        size = fs.statSync(absPath).size;
      } catch (error) {
        opts.onError?.(absPath, error);
        continue;
      }
      if (size > opts.maxFileBytes) continue;
      if (emitted >= limit) return;
      emitted += 1;
      yield {
        absPath,
        relPath: path.relative(root, absPath).split(path.sep).join('/'),
        size,
        extension: extensionOf(entry.name),
      };
    }
  }
}

/** Walk restricted to the text extensions the provider can actually read. */
export function* walkTextFiles(root: string, opts: WalkOptions): Generator<ScannedFile> {
  for (const file of walkFiles(root, opts)) {
    if (!isTextExtension(file.relPath)) continue;
    yield file;
  }
}

/** Reads a text file, or returns null when it is binary / unreadable. */
export function readTextFile(file: ScannedFile): string | null {
  if (!isTextExtension(file.relPath)) return null;
  let buffer: Buffer;
  try {
    buffer = fs.readFileSync(file.absPath);
  } catch {
    return null;
  }
  if (buffer.length === 0) return '';
  if (looksBinary(buffer)) return null;
  return buffer.toString('utf8');
}
