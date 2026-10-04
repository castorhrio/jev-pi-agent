import { defineConfig } from 'vite';
import * as path from 'node:path';

/**
 * The preload bundle.
 *
 * With `sandbox: true` the preload runs in a context that has no Node module
 * resolution, so `require('@ucad/contracts')` fails at runtime even though
 * TypeScript is perfectly happy with it. Bundling the preload collapses its
 * imports into one self-contained file, which is what lets us keep
 * `sandbox: true` — a strictly stronger posture than the `contextIsolation` +
 * `nodeIntegration: false` pair that NFR-01 requires.
 *
 * The compiled output lands at `dist/preload/preload.js`, which is what
 * `bootstrap.ts` points `webPreferences.preload` at.
 */
export default defineConfig({
  configFile: false,
  resolve: {
    alias: {
      // Rollup cannot statically analyse the CommonJS `__exportStar` re-exports
      // in the built package, so the bundle points at the TypeScript source and
      // lets esbuild transpile it. Same code, statically analysable shape.
      '@ucad/contracts': path.resolve(__dirname, '../../packages/contracts/src/index.ts'),
    },
  },
  build: {
    outDir: path.resolve(__dirname, 'dist/preload'),
    emptyOutDir: true,
    target: 'node20',
    minify: false,
    sourcemap: true,
    lib: {
      entry: path.resolve(__dirname, 'src/preload/preload.ts'),
      formats: ['cjs'],
      fileName: () => 'preload.js',
    },
    rollupOptions: {
      // `electron` is provided by the runtime, not bundled.
      external: ['electron'],
    },
  },
});
