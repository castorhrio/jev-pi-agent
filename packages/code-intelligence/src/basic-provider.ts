/**
 * §4.8 / §5 — the Basic `CodeIntelligenceProvider`.
 *
 * C-1 / C-2 are the load-bearing part of this class: `callers`, `callees`,
 * `trace` and `impact` are NOT defined anywhere — not as a method, not as
 * `undefined`, not on the prototype. `typeof provider.callers === 'undefined'`
 * is the honest signal, because an empty `[]` return would be misread as
 * "there are no callers" when the truth is "this provider cannot know".
 * C-4: `manifest.optionalMethods` is `[]` and every graph capability is false.
 *
 * NFR-11 freshness honesty: there is no persistent index, so every result is
 * `stale: true` with `stalenessReason: 'unknown_revision'` and `getStatus()`
 * reports `not_indexed` — never `ready`.
 */

import { nowIso, ulid } from '@ucad/observability';
import type { BlobStore, Logger } from '@ucad/observability';
import { appError, describeError } from '@ucad/contracts';
import type {
  CodeIntelligenceManifest,
  CodeIntelligenceProvider,
  CodeLocation,
  CodeOverview,
  CodeSearchInput,
  CodeSearchResult,
  FreshnessState,
  IndexWorkspaceInput,
  IntelligenceInitializeContext,
  IntelligenceOperationHandle,
  IntelligenceStatus,
  LocateSymbolInput,
  OverviewInput,
  RefreshWorkspaceInput,
} from '@ucad/contracts';
import {
  BASIC_MAX_FILE_BYTES,
  isTextExtension,
  readTextFile,
  walkFiles,
  walkTextFiles,
} from './fs-scan';

export const BASIC_PROVIDER_ID = 'basic';
export const BASIC_STATUS_REASON = 'basic provider has no persistent index (every query reads the working tree directly)';

/** NFR-11: the provider can never claim to be fresh. */
const ALWAYS_STALE: FreshnessState = { stale: true, stalenessReason: 'unknown_revision' };

const DEFAULT_SEARCH_LIMIT = 200;
const DEFAULT_LOCATE_LIMIT = 200;
/** `overview` only reads this many text files when counting declarations. */
const OVERVIEW_SYMBOL_SCAN_LIMIT = 400;

const ENTRY_POINT_NAMES: ReadonlySet<string> = new Set([
  'index',
  'main',
  'cli',
  'app',
  'server',
  'bootstrap',
  'package.json',
  'readme.md',
  'tsconfig.json',
]);

/** Heuristic declaration patterns; group 1 is always the declared name. */
const DECLARATION_PATTERNS: ReadonlyArray<{ kind: string; source: string }> = [
  { kind: 'function', source: String.raw`\b(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)` },
  { kind: 'class', source: String.raw`\bclass\s+([A-Za-z_$][\w$]*)` },
  { kind: 'interface', source: String.raw`\binterface\s+([A-Za-z_$][\w$]*)` },
  { kind: 'type', source: String.raw`\btype\s+([A-Za-z_$][\w$]*)\s*[=<]` },
  { kind: 'enum', source: String.raw`\b(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)` },
  { kind: 'constant', source: String.raw`\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)` },
  { kind: 'function', source: String.raw`\bdef\s+([A-Za-z_][\w]*)` },
  { kind: 'function', source: String.raw`\bfn\s+([A-Za-z_][\w]*)` },
  { kind: 'function', source: String.raw`\bfunc\s+([A-Za-z_][\w]*)` },
  { kind: 'method', source: String.raw`^\s*(?:(?:public|private|protected|static|async|override)\s+)*([A-Za-z_$][\w$]*)\s*\([^;{]*\)\s*(?::[^{;]+)?\s*\{` },
];

interface Declaration {
  name: string;
  kind: string;
}

function declarationsIn(line: string): Declaration[] {
  const found: Declaration[] = [];
  for (const pattern of DECLARATION_PATTERNS) {
    // matchAll() requires the global flag; group 1 is always the declared name.
    const re = new RegExp(pattern.source, 'g');
    for (const match of line.matchAll(re)) {
      const name = match[1];
      if (name !== undefined) found.push({ name, kind: pattern.kind });
    }
  }
  return found;
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface BasicIntelligenceProviderOptions {
  logger: Logger;
  /**
   * NFR-06 blob offload handle. The Basic provider currently returns line ranges
   * only, so nothing is written; it is kept because §5 fixes the constructor
   * shape and a future `search` snippet mode needs it.
   */
  blobs: BlobStore;
  maxFileBytes?: number;
}

export class BasicIntelligenceProvider implements CodeIntelligenceProvider {
  readonly manifest: CodeIntelligenceManifest;

  private readonly logger: Logger;
  private readonly blobs: BlobStore;
  private readonly maxFileBytes: number;
  /** workspaceId -> root. Registered by `initialize`; there is no other source. */
  private readonly roots = new Map<string, string>();
  private disposed = false;

  constructor(opts: BasicIntelligenceProviderOptions) {
    this.logger = opts.logger;
    this.blobs = opts.blobs;
    this.maxFileBytes = opts.maxFileBytes ?? BASIC_MAX_FILE_BYTES;

    this.manifest = {
      id: BASIC_PROVIDER_ID,
      displayName: 'Basic Filesystem Intelligence',
      tier: 'basic',
      version: '1.0.0',
      pinned: [],
      transport: 'in_process',
      // Zero extra infrastructure: no Docker, no external service, no network.
      requires: [],
      capabilities: {
        symbolSearch: true,
        definitions: true,
        callers: false,
        callees: false,
        dependencyGraph: false,
        trace: false,
        impact: false,
        persistentIndex: false,
        incrementalRefresh: false,
        machineReadableOutput: true,
        // NFR-12: declared honestly — there is no provider tokenizer here.
        tokenizer: 'heuristic_chars_div_4',
      },
      // C-4: the single source of truth for what is NOT implemented.
      optionalMethods: [],
    };
  }

  /** NFR-06 offload handle, exposed for Main's snippet rendering. */
  get blobStore(): BlobStore {
    return this.blobs;
  }

  async initialize(ctx: IntelligenceInitializeContext): Promise<void> {
    this.roots.set(ctx.workspaceId, ctx.workspaceRoot);
    this.logger.debug('basic intelligence initialized', {
      workspaceId: ctx.workspaceId,
      maxFileBytes: this.maxFileBytes,
    });
  }

  /** NFR-11: never `ready` — there is nothing to be ready. */
  async getStatus(workspaceId: string): Promise<IntelligenceStatus> {
    this.logger.debug('basic intelligence status', { workspaceId, state: 'not_indexed' });
    return {
      providerId: BASIC_PROVIDER_ID,
      state: 'not_indexed',
      reason: BASIC_STATUS_REASON,
      providerVersion: this.manifest.version,
      stale: true,
      features: this.manifest.capabilities,
    };
  }

  /**
   * §5: a handle, then done. The Basic provider has no index to build, so it
   * must not pretend to stage one — the manager records `not_indexed`.
   */
  async index(_input: IndexWorkspaceInput, signal?: AbortSignal): Promise<IntelligenceOperationHandle> {
    return this.handle('index', signal);
  }

  async refresh(_input: RefreshWorkspaceInput, signal?: AbortSignal): Promise<IntelligenceOperationHandle> {
    return this.handle('refresh', signal);
  }

  async cancel(input: { operationId: string }): Promise<{ cancelled: boolean; reason?: string }> {
    return {
      cancelled: false,
      reason: `basic provider runs no background operation (operationId=${input.operationId}); every query is bounded by its own signal`,
    };
  }

  /** Case-insensitive literal substring match over the supported text files. */
  async search(input: CodeSearchInput, signal?: AbortSignal): Promise<CodeSearchResult> {
    const root = this.rootFor(input.workspaceId);
    const needle = input.query.toLowerCase();
    const limit = input.limit ?? DEFAULT_SEARCH_LIMIT;
    const items: CodeLocation[] = [];
    let truncated = false;

    if (needle.length === 0) {
      return { items: [], truncated: false, freshness: { ...ALWAYS_STALE } };
    }

    for (const file of walkTextFiles(root, {
      maxFileBytes: this.maxFileBytes,
      signal,
      onError: (p, error) => this.scanError(p, error),
    })) {
      if (signal?.aborted || items.length >= limit) {
        truncated = truncated || items.length >= limit;
        break;
      }
      const text = readTextFile(file);
      if (text === null) continue;
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        if (items.length >= limit) {
          truncated = true;
          break;
        }
        const line = lines[i] ?? '';
        if (!line.toLowerCase().includes(needle)) continue;
        items.push(
          this.withSnippet(
            {
              path: file.relPath,
              // 1-based, inclusive; a match is a single line.
              startLine: i + 1,
              endLine: i + 1,
              kind: 'match',
            },
            lines,
          ),
        );
      }
    }

    return { items, truncated, freshness: { ...ALWAYS_STALE } };
  }

  /**
   * Materialises a location into actual source text.
   *
   * A `CodeLocation` is only a pointer. Without this, every consumer receives
   * `{path, startLine, endLine}` — metadata, not code — and the Context Broker
   * has nothing to inject, so it "saves" tokens by injecting nothing. That is
   * the failure mode the token benchmark caught.
   *
   * The slice is written to the blob store and referenced by `snippetRef`, per
   * §4.8 / the `CodeLocation.snippetRef` contract. A failure to write the blob
   * degrades to a pointer-only location rather than losing the hit.
   */
  private withSnippet(location: CodeLocation, lines: string[]): CodeLocation {
    const start = Math.max(1, location.startLine);
    const end = Math.min(lines.length, Math.max(start, location.endLine));
    const text = lines.slice(start - 1, end).join('\n');
    if (text.trim().length === 0) return location;
    try {
      return {
        ...location,
        snippetRef: this.blobs.put(text, {
          path: location.path,
          startLine: start,
          endLine: end,
          providerId: BASIC_PROVIDER_ID,
        }),
      };
    } catch {
      // a blob-store miss must not drop the match itself
      return location;
    }
  }

  /** Declarations first, then references, by literal symbol name. */
  async locate(input: LocateSymbolInput, signal?: AbortSignal): Promise<CodeLocation[]> {
    const root = this.rootFor(input.workspaceId);
    const symbol = input.symbol.trim();
    if (symbol.length === 0) return [];

    const wordRe = new RegExp(`(?<![\\w$])${escapeRegExp(symbol)}(?![\\w$])`);
    const declarations: CodeLocation[] = [];
    const references: CodeLocation[] = [];
    const limit = DEFAULT_LOCATE_LIMIT;

    for (const file of walkTextFiles(root, {
      maxFileBytes: this.maxFileBytes,
      signal,
      onError: (p, error) => this.scanError(p, error),
    })) {
      if (signal?.aborted) break;

      // A file named after the symbol is a hit in its own right.
      const base = file.relPath.slice(file.relPath.lastIndexOf('/') + 1);
      const stem = base.includes('.') ? base.slice(0, base.indexOf('.')) : base;
      if (stem === symbol && declarations.length < limit) {
        declarations.push({ path: file.relPath, startLine: 1, endLine: 1, symbol, kind: 'file' });
      }

      const text = readTextFile(file);
      if (text === null) continue;
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        if (declarations.length + references.length >= limit) break;
        const line = lines[i] ?? '';
        if (!wordRe.test(line)) continue;
        const isDeclaration = declarationsIn(line).some((d) => d.name === symbol);
        const location: CodeLocation = {
          path: file.relPath,
          startLine: i + 1,
          endLine: i + 1,
          symbol,
          kind: isDeclaration ? 'declaration' : 'reference',
        };
        if (isDeclaration) declarations.push(location);
        else references.push(location);
      }
    }

    return [...declarations, ...references].slice(0, limit);
  }

  /**
   * A real summary: file count, extension histogram, top-level directories,
   * entry points and a human readable sentence. The declaration count is read
   * from at most `OVERVIEW_SYMBOL_SCAN_LIMIT` text files and the summary says so
   * rather than presenting a partial count as a total.
   */
  async overview(input: OverviewInput, signal?: AbortSignal): Promise<CodeOverview> {
    const root = this.rootFor(input.workspaceId);
    const byExtension = new Map<string, number>();
    const modules = new Map<string, { name: string; path: string; symbols: number }>();
    const entryPoints: CodeLocation[] = [];
    let fileCount = 0;
    let scannedForSymbols = 0;
    let declarationCount = 0;
    let symbolScanTruncated = false;

    for (const file of walkFiles(root, {
      maxFileBytes: this.maxFileBytes,
      signal,
      onError: (p, error) => this.scanError(p, error),
    })) {
      if (signal?.aborted) break;
      fileCount += 1;
      const key = file.extension.length > 0 ? `.${file.extension}` : '<none>';
      byExtension.set(key, (byExtension.get(key) ?? 0) + 1);

      const topLevel = file.relPath.includes('/') ? (file.relPath.split('/')[0] ?? '') : '';
      if (topLevel.length > 0 && !modules.has(topLevel)) {
        modules.set(topLevel, { name: topLevel, path: topLevel, symbols: 0 });
      }

      const base = file.relPath.slice(file.relPath.lastIndexOf('/') + 1);
      if (entryPoints.length < 20 && (ENTRY_POINT_NAMES.has(base) || /^(index|main|cli|app|server)\.[a-z]+$/.test(base))) {
        entryPoints.push({ path: file.relPath, startLine: 1, endLine: 1, kind: 'entry_point' });
      }

      if (isTextExtension(file.relPath)) {
        if (scannedForSymbols < OVERVIEW_SYMBOL_SCAN_LIMIT) {
          const text = readTextFile(file);
          if (text !== null) {
            scannedForSymbols += 1;
            const count = countDeclarations(text);
            declarationCount += count;
            if (topLevel.length > 0) {
              const mod = modules.get(topLevel);
              if (mod) mod.symbols += count;
            }
          }
        } else {
          symbolScanTruncated = true;
        }
      }
    }

    const topExtensions = [...byExtension.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 5)
      .map(([ext, count]) => `${ext} (${count})`)
      .join(', ');
    const topModules = [...modules.values()]
      .sort((a, b) => b.symbols - a.symbols || a.name.localeCompare(b.name))
      .slice(0, 5)
      .map((m) => `${m.name} (${m.symbols} declarations)`)
      .join(', ');

    const summary =
      `${fileCount} file(s) in ${modules.size} top-level director${modules.size === 1 ? 'y' : 'ies'}. ` +
      `Top extensions: ${topExtensions || 'none'}. ` +
      `Top modules: ${topModules || 'none'}. ` +
      `${declarationCount} declaration(s) matched by the heuristic pattern set` +
      (symbolScanTruncated ? ` (only the first ${OVERVIEW_SYMBOL_SCAN_LIMIT} text files were scanned for declarations)` : '') +
      `. Freshness is unknown_revision: the basic provider keeps no persistent index (NFR-11).`;

    return {
      summary,
      entryPoints,
      modules: [...modules.values()].sort((a, b) => a.name.localeCompare(b.name)),
      freshness: { ...ALWAYS_STALE },
    };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.roots.clear();
  }

  // -------------------------------------------------------------------------

  private handle(kind: 'index' | 'refresh', signal?: AbortSignal): IntelligenceOperationHandle {
    // An already-aborted signal still yields a handle: the manager owns the
    // operation registry and reports the cancellation, not the provider.
    if (signal?.aborted) {
      this.logger.debug('basic intelligence operation requested while cancelled', { kind });
    }
    return {
      operationId: ulid('iop_'),
      providerId: BASIC_PROVIDER_ID,
      kind,
      startedAt: nowIso(),
    };
  }

  private rootFor(workspaceId: string): string {
    if (this.disposed) {
      throw appError('INTELLIGENCE_UNAVAILABLE', 'basic intelligence provider has been disposed', 'intelligence');
    }
    const root = this.roots.get(workspaceId);
    if (root === undefined) {
      throw appError(
        'INTELLIGENCE_UNAVAILABLE',
        `workspace ${workspaceId} was never initialized on the basic provider`,
        'intelligence',
      );
    }
    return root;
  }

  private scanError(target: string, error: unknown): void {
    this.logger.debug('scan skipped a path', {
      path: target,
      error: describeError(error).slice(0, 200),
    });
  }
}

function countDeclarations(text: string): number {
  let count = 0;
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    count += declarationsIn(line).length;
  }
  return count;
}
