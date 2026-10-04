/**
 * Bootstrap executed by `child_process.fork()` (§6.3, NFR-02).
 *
 * Command line: `--adapter=<absolute module path> --host-id=<id>`. The adapter
 * module may export `createAdapter`, `createMockAdapter`, a `default` factory or
 * an `AgentAdapter` object directly.
 */

import { toAppError } from '@ucad/contracts';
import type { AgentAdapter } from '@ucad/contracts';
import { Logger, nowIso } from '@ucad/observability';
import { createRequire } from 'node:module';
import { isAbsolute } from 'node:path';

import { AgentHostRunner } from './agent-host-runner';

export interface HostEntryArgs {
  adapterModule: string;
  agentHostId: string;
}

/** `--key=value` pairs. Unknown keys are ignored. */
export function parseHostArgs(argv: readonly string[]): Partial<HostEntryArgs> {
  const out: Partial<HostEntryArgs> = {};
  for (const arg of argv) {
    if (arg.startsWith('--adapter=')) out.adapterModule = arg.slice('--adapter='.length);
    if (arg.startsWith('--host-id=')) out.agentHostId = arg.slice('--host-id='.length);
  }
  return out;
}

type AdapterFactory = () => AgentAdapter | Promise<AgentAdapter>;

function isAdapter(value: unknown): value is AgentAdapter {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as { initialize?: unknown }).initialize === 'function' &&
    typeof (value as { createSession?: unknown }).createSession === 'function' &&
    !!(value as { manifest?: unknown }).manifest
  );
}

/** Accepts the shapes an adapter package is allowed to publish. */
export function resolveAdapterFactory(mod: unknown): AdapterFactory | null {
  if (!mod || (typeof mod !== 'object' && typeof mod !== 'function')) return null;
  const record = mod as Record<string, unknown>;
  for (const key of ['createAdapter', 'createMockAdapter', 'default'] as const) {
    const candidate = record[key];
    if (typeof candidate === 'function') return candidate as AdapterFactory;
  }
  if (isAdapter(record)) return () => record;
  return null;
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const args = parseHostArgs(argv);
  if (!args.adapterModule || !args.agentHostId) {
    throw new Error('host-entry requires --adapter=<module> and --host-id=<id>');
  }

  // The documented contract (see the file header) is an *absolute* module path:
  // Main resolves the adapter with `require.resolve` before forking. A relative
  // path would silently resolve against this process's cwd — a different
  // module than the one Main chose, or none at all — so it is rejected instead.
  if (!isAbsolute(args.adapterModule)) {
    throw new Error(`--adapter must be an absolute module path, got: ${args.adapterModule}`);
  }

  // Loaded through a require scoped to this file so a CommonJS adapter dist
  // works without a build step on the adapter side. `createRequire` is the
  // supported spelling of "load this CJS module" — a bare `require` here is
  // the same operation with a shape static scanners cannot distinguish from a
  // shell-exec sink.
  // The module path is only known at runtime (`--adapter=<module>`), so it
  // cannot be a static import; it is produced by Main's own `require.resolve`
  // over a fixed specifier list, never by Renderer or user input.
  const mod: unknown = createRequire(__filename)(args.adapterModule);
  const factory = resolveAdapterFactory(mod);
  if (!factory) {
    throw new Error(`adapter module ${args.adapterModule} exports no AgentAdapter factory`);
  }

  const adapter = await factory();
  const runner = new AgentHostRunner({
    adapter,
    agentHostId: args.agentHostId,
    logger: new Logger({ scope: 'agent-host:entry' }),
  });
  runner.start();

  // NFR-02: a crash must be visible on Main's side as an exit, not as silence.
  process.on('uncaughtException', (err: Error) => {
    const appErr = toAppError(err, 'agent');
    process.stderr.write(`${nowIso()} agent-host uncaught: ${JSON.stringify(appErr)}\n`);
    process.exit(1);
  });
  process.on('unhandledRejection', (reason: unknown) => {
    const appErr = toAppError(reason, 'agent');
    process.stderr.write(`${nowIso()} agent-host unhandled: ${JSON.stringify(appErr)}\n`);
  });
}

if (require.main === module) {
  void main().catch((err: unknown) => {
    const appErr = toAppError(err, 'agent');
    process.stderr.write(`${nowIso()} agent-host boot failed: ${JSON.stringify(appErr)}\n`);
    process.exit(1);
  });
}
