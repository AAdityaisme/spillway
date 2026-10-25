import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      'apps/landing/**', // founder creative direction — not linted (ADR-019j)
      'docs/**',
      '_archive/**',
      'coverage/**',
      'apps/web/dist/**',
      'ops/k6/**', // k6 load scripts run in the k6 runtime (its own globals: __ENV) — not node/TS
      // Agent git worktrees land at .claude/worktrees/<id>/ — a full second copy of the tree INSIDE
      // the repo. eslint has no reason to know that path is not source, so it lints every copy and
      // buries the handful of real findings under thousands of duplicates (measured: 6160 errors
      // from 4 worktrees vs 1 warning from apps/). `.claude/` is already gitignored; this is the
      // same exclusion, stated where the linter can see it.
      '.claude/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser },
    },
  },
);
