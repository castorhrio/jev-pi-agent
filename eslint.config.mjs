// ESLint flat config.
//
// Scope is deliberately narrow: this gate exists to catch the two classes of
// defect that actually reach users in this repo —
//   1. React state bugs (stale closures, missing/incorrect deps)  → react-hooks
//   2. Type errors that tsc's project layout misses              → typescript-eslint
//
// It is NOT a style gate. There is no stylistic formatting rule here on purpose:
// a style gate that fires hundreds of times gets ignored, and an ignored gate
// catches nothing.

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';

export default tseslint.config(
  {
    // Never lint build output or vendored dependencies.
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/release/**',
      '.run-logs/**',
      'packages/*/dist/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    rules: {
      // `no-undef` is OFF for TypeScript on purpose. ESLint has no type
      // information, so it reports TS type namespaces (`NodeJS.Timeout`) as
      // undefined globals — pure noise. `tsc` already resolves identifiers,
      // so it is the real undefined-identifier gate for these files.
      'no-undef': 'off',

      // An unused import/variable in this repo is usually a forgotten wiring
      // rather than dead code, so this stays an error — but unused *caught*
      // errors are normal (`catch { /* handled elsewhere */ }`) and stay quiet.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrors: 'none',
        },
      ],

      // An empty `catch {}` is how this repo silently swallowed failures and
      // shipped dead features. `catch (e) { /* reason */ }`
      // stays legal; a bare `catch {}` does not.
      'no-empty': ['error', { allowEmptyCatch: false }],

      // The renderer must never reach `process` — it has no Node access
      // (NFR-01). A `process` reference there is a boundary violation.
      'no-restricted-globals': [
        'error',
        {
          name: 'process',
          message: 'Renderer has no Node access (NFR-01). Use the preload bridge.',
        },
      ],
    },
  },

  {
    // Main + packages: Node. `scripts/` holds the gate drivers, which run in
    // Node or in the Electron main process — both are Node, so they are
    // declared here rather than tripping `no-undef` on `process`.
    files: [
      'apps/desktop/src/main/**/*.ts',
      'packages/*/src/**/*.ts',
      'scripts/**/*.{ts,mjs,js}',
      'tests/**/*.ts',
    ],
    languageOptions: { globals: { ...globals.node } },
    rules: { 'no-restricted-globals': 'off' },
  },

  {
    // Renderer: browser. React rules live here.
    files: ['apps/desktop/src/renderer/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // The reducer/streaming coalescing in `state/hooks.ts` legitimately
      // reaches into refs inside callbacks; `exhaustive-deps` stays on because
      // that is exactly the file where a stale closure would be invisible.
      'react-refresh/only-export-components': 'off',
    },
  },

  {
    files: ['**/*.cjs'],
    languageOptions: { globals: { ...globals.node }, sourceType: 'commonjs' },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
);
