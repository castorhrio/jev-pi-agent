/**
 * NFR-06: a single Terminal / Tool event must have a size ceiling. Anything
 * above it goes to the blob directory and the event keeps a truncated preview.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ulid } from './ulid';
import { MAX_EVENT_PAYLOAD_BYTES } from '@ucad/contracts';

export interface PutOrPreviewResult {
  ref?: string;
  preview: string;
  truncated: boolean;
  bytes: number;
}

export class BlobStore {
  private readonly root: string;
  private readonly maxInlineBytes: number;

  constructor(opts: { root: string; maxInlineBytes?: number }) {
    this.root = opts.root;
    this.maxInlineBytes = opts.maxInlineBytes ?? MAX_EVENT_PAYLOAD_BYTES;
    fs.mkdirSync(this.root, { recursive: true });
  }

  get directory(): string {
    return this.root;
  }

  put(text: string, meta?: Record<string, unknown>): string {
    const ref = ulid('blob_');
    const file = path.join(this.root, `${ref}.txt`);
    const header = meta
      ? `${JSON.stringify({ ref, ...meta })}\n\n`
      : '';
    fs.writeFileSync(file, header + text, 'utf8');
    return ref;
  }

  get(ref: string): string {
    const file = this.pathFor(ref);
    const raw = fs.readFileSync(file, 'utf8');
    // strip the optional metadata header written by put()
    const nl = raw.indexOf('\n\n');
    return raw.startsWith('{') && nl >= 0 ? raw.slice(nl + 2) : raw;
  }

  exists(ref: string): boolean {
    return fs.existsSync(this.pathFor(ref));
  }

  /** Keeps a bounded prefix; the rest is retrievable via the ref. */
  putOrPreview(text: string): PutOrPreviewResult {
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes <= this.maxInlineBytes) {
      return { preview: text, truncated: false, bytes };
    }
    const ref = this.put(text);
    const preview = text.slice(0, Math.floor(this.maxInlineBytes / 4));
    return {
      ref,
      preview: `${preview}\n… [truncated: ${bytes} bytes, full content in ${ref}]`,
      truncated: true,
      bytes,
    };
  }

  clear(): void {
    fs.rmSync(this.root, { recursive: true, force: true });
    fs.mkdirSync(this.root, { recursive: true });
  }

  /**
   * §8.4 — "清理必须同时清理 blob 目录". Deleting the SQLite rows that name a blob
   * is not enough: the file on disk is what actually holds the transcript bytes,
   * and until this existed a deleted session left its oversized tool output
   * sitting in the blob directory forever.
   *
   * Returns the refs that were actually removed, so a caller can report a real
   * count rather than an assumed one.
   */
  delete(ref: string): boolean {
    const file = this.pathFor(ref);
    if (!fs.existsSync(file)) return false;
    fs.rmSync(file, { force: true });
    return true;
  }

  deleteMany(refs: readonly string[]): { removed: number; alreadyGone: number } {
    let removed = 0;
    let alreadyGone = 0;
    for (const ref of refs) {
      if (this.delete(ref)) removed += 1;
      else alreadyGone += 1;
    }
    return { removed, alreadyGone };
  }

  /** Total bytes on disk, for the storage panel. */
  totalBytes(): number {
    let total = 0;
    let entries: string[];
    try {
      entries = fs.readdirSync(this.root);
    } catch {
      return 0;
    }
    for (const name of entries) {
      try {
        total += fs.statSync(path.join(this.root, name)).size;
      } catch {
        // A file that vanished mid-scan was never ours to count.
      }
    }
    return total;
  }

  /** Refs present on disk with no row in `blobs` — the §8.4 leak detector. */
  listOrphans(referenced: ReadonlySet<string>): string[] {
    let entries: string[];
    try {
      entries = fs.readdirSync(this.root);
    } catch {
      return [];
    }
    const orphans: string[] = [];
    for (const name of entries) {
      if (!name.endsWith('.txt')) continue;
      const ref = name.slice(0, -'.txt'.length);
      if (!referenced.has(ref)) orphans.push(ref);
    }
    return orphans;
  }

  private pathFor(ref: string): string {
    // ref is generated internally, but a traversal here would be a real
    // filesystem read primitive, so the name is validated anyway
    if (!/^[A-Za-z0-9_.-]+$/.test(ref)) {
      throw new Error(`invalid blob ref: ${ref}`);
    }
    return path.join(this.root, `${ref}.txt`);
  }
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}
