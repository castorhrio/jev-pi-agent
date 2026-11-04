import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // The feed contract tests judge a published feed with the rules the shipped
    // app runs, which live in `apps/desktop`'s build output. Building them here —
    // once, in the parent process, before any file loads — is what lets those
    // tests require the rules instead of proving nothing when they are absent.
    // Why not in a test file's `beforeAll`: `pool: 'forks'` starts files in
    // parallel, so four of them would rebuild the same output at once while the
    // others import it. See `tests/contract/app-rules-build.ts`.
    globalSetup: ['./tests/global-setup.ts'],
    // Contract tests boot real child processes and real SQLite files; give
    // them room but never let a hung test wedge the whole run.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
    reporters: ['default'],
  },
});
