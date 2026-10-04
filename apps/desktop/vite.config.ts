import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import * as path from 'node:path';

const root = path.resolve(__dirname, 'src/renderer');

export default defineConfig({
  root,
  // Electron loads the built renderer from the filesystem, so assets must be
  // referenced relatively rather than from the server root.
  base: './',
  plugins: [react()],
  build: {
    outDir: path.resolve(__dirname, 'dist/renderer'),
    emptyOutDir: true,
    target: 'chrome128',
    sourcemap: true,
  },
  server: {
    port: 5273,
    strictPort: true,
  },
  resolve: {
    alias: {
      '@ucad/contracts': path.resolve(__dirname, '../../packages/contracts/src/index.ts'),
      '@renderer': path.resolve(root, 'src'),
    },
  },
});
