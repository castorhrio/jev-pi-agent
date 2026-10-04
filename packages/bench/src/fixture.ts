/**
 * A deterministic synthetic workspace for the token-accounting benchmark.
 *
 * Determinism is the whole point: a benchmark whose fixture changes between
 * runs cannot be argued with, and a benchmark tuned until the product wins is
 * worse than no benchmark. Everything here is derived from an integer seed with
 * a small integer PRNG — `Math.random()` and the clock are never touched, so
 * `generateFixtureWorkspace({ seed: 7 })` returns byte-identical files on every
 * machine and every run.
 *
 * The shape is deliberately the shape of a real repository: a nested directory
 * tree, a handful of files that genuinely define the symbols a task needs, and
 * many large filler files that a naive "paste the top-N files" strategy pays
 * for whether it needs them or not.
 */

/** mulberry32: 32-bit integer PRNG. Same seed, same stream, forever. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface FixtureFile {
  /** repo-relative, forward slashes — the same shape a provider reports. */
  path: string;
  /**
   * The symbol this file defines. A needle file must have one: it is what the
   * benchmark greps the injected text for, so "the agent saw the file" is
   * replaced by "the agent saw the definition".
   */
  definingSymbol: string | null;
  lines: string[];
}

export interface FixtureWorkspace {
  id: string;
  seed: number;
  files: FixtureFile[];
}

export interface FixtureNeedle {
  path: string;
  symbol: string;
}

export interface FixtureSpec {
  seed: number;
  /** how many large filler files to generate. */
  fillerFiles: number;
  /** inclusive line-count range for a filler file. */
  fillerLines: [number, number];
  /** the files a real task genuinely needs. */
  needles: FixtureNeedle[];
  /** inclusive line-count range for a needle file. */
  needleLines: [number, number];
}

const MODULES: ReadonlyArray<string> = [
  'auth', 'billing', 'ingest', 'render', 'scheduler', 'telemetry', 'search', 'sync',
  'export', 'notify', 'catalog', 'session', 'permission', 'migration', 'gateway', 'storage',
];

const NOUNS: ReadonlyArray<string> = [
  'payload', 'record', 'budget', 'token', 'cursor', 'handle', 'registry', 'snapshot', 'policy',
  'descriptor', 'envelope', 'manifest', 'channel', 'segment', 'threshold', 'workspace', 'revision',
];

const VERBS: ReadonlyArray<string> = [
  'resolve', 'normalize', 'collect', 'flush', 'merge', 'validate', 'project', 'encode', 'dispatch',
  'reconcile', 'compact', 'annotate', 'hydrate', 'seal', 'probe',
];

/** Line templates with a realistic length spread (5..110 chars). */
const LINE_TEMPLATES: ReadonlyArray<(ids: { n: string; v: string; p: string }) => string> = [
  (i) => `  // ${i.v} the ${i.n} before the ${i.p} is written`,
  (i) => `const ${i.n} = ${i.v}(${i.p});`,
  (i) => `  if (${i.n} === undefined) return null;`,
  (i) => `export function ${i.v}${capitalize(i.n)}(${i.p}: ${i.p}State): number {`,
  (i) => `  const ${i.p} = await ${i.v}${capitalize(i.n)}(${i.n}, { retries: 3, timeoutMs: 2500 });`,
  (i) => `  logger.debug('${i.v} ${i.n}', { ${i.p}: ${i.n}.length, revision: this.revision });`,
  (i) => `  return ${i.n}.map((entry) => ${i.v}${capitalize(i.n)}(entry)).filter(Boolean);`,
  (i) => `  // NOTE(perf): ${i.n} is rebuilt per call; see the ${i.p} cache below`,
  (i) => `  for (const ${i.p} of queue) { await this.${i.v}(${i.p}); }`,
  (i) => `    throw new Error('${i.n} ${i.p} failed after 3 attempts: ' + cause.message);`,
  (i) => `      ${i.p}: this.${i.n}.slice(0, ${10 + i.n.length}) },`,
  (i) => `  this.emit('${i.n}:changed', { source: '${i.p}', at: nowIso() });`,
  (_i) => `}`,
  (_i) => '',
  (i) => `  /** ${i.v} one ${i.p} without touching the ${i.n} store. */`,
];

function capitalize(value: string): string {
  return value.length === 0 ? value : `${value[0]?.toUpperCase() ?? ''}${value.slice(1)}`;
}

function pick<T>(rand: () => number, pool: ReadonlyArray<T>): T {
  const item = pool[Math.floor(rand() * pool.length)];
  // `noUncheckedIndexedAccess`: the pool is static and non-empty, but the
  // compiler cannot know that, so the fallback keeps this total.
  if (item === undefined) throw new Error('fixture vocabulary pool is empty');
  return item;
}

function identifier(rand: () => number): { n: string; v: string; p: string } {
  return { n: pick(rand, NOUNS), v: pick(rand, VERBS), p: pick(rand, MODULES) };
}

function bodyLines(rand: () => number, count: number): string[] {
  const lines: string[] = [];
  for (let i = 0; i < count; i += 1) lines.push(pick(rand, LINE_TEMPLATES)(identifier(rand)));
  return lines;
}

function inRange(rand: () => number, range: [number, number]): number {
  const [min, max] = range;
  return min + Math.floor(rand() * (max - min + 1));
}

/** Builds the fixture. Pure: same spec in, same bytes out. */
export function generateFixtureWorkspace(spec: FixtureSpec): FixtureWorkspace {
  const rand = mulberry32(spec.seed);
  const files: FixtureFile[] = [];

  for (const needle of spec.needles) {
    const count = inRange(rand, spec.needleLines);
    const lines = bodyLines(rand, count);
    // The defining symbol is a real declaration in a real body, not a comment,
    // so a search that finds the text has genuinely seen the definition.
    const at = Math.floor(rand() * Math.max(1, lines.length));
    const signature = `export function ${needle.symbol}(input: ${pick(rand, NOUNS)}Input, options: ${pick(rand, NOUNS)}Options): ${pick(rand, NOUNS)}Result {`;
    lines.splice(at, 0, signature, `  const ${pick(rand, NOUNS)} = ${pick(rand, VERBS)}${capitalize(needle.symbol)}(input, options);`, '  return result;', '}');
    files.push({ path: needle.path, definingSymbol: needle.symbol, lines });
  }

  const used = new Set(files.map((f) => f.path));
  for (let i = 0; i < spec.fillerFiles; i += 1) {
    // A nested tree, the way a real repository is organised.
    const moduleName = pick(rand, MODULES);
    const sub = pick(rand, ['internal', 'service', 'model', 'util', 'adapters', 'domain']);
    let path = `src/${moduleName}/${sub}/${moduleName}-${String(i).padStart(3, '0')}.ts`;
    while (used.has(path)) path = `src/${moduleName}/${sub}/${moduleName}-${String(i + 1000).padStart(4, '0')}.ts`;
    used.add(path);
    files.push({ path, definingSymbol: null, lines: bodyLines(rand, inRange(rand, spec.fillerLines)) });
  }

  return { id: `fixture_seed_${spec.seed}`, seed: spec.seed, files };
}
