import { defineWorkspace } from 'vitest/config';

/**
 * Three projects (11-testing §1.1): unit (no I/O), integration (real Postgres),
 * e2e (Playwright). Coverage gates from the bible (unit ≥90% lines/funcs on
 * packages/pricing + data-plane; integration ≥80%) are NOT yet enforced —
 * vitest 2.x rejects per-project `coverage` here, and the root coverage config
 * lands in M1 (recorded as an M0 deviation in README). `pnpm test:coverage`
 * runs v8 coverage without thresholds until then.
 *
 * M51: web-dashboard tests added as a fourth project so apps/web/src stays in the test workspace.
 */
export default defineWorkspace([
  {
    test: {
      name: 'unit',
      include: ['packages/*/src/**/*.test.ts', 'apps/server/src/**/*.test.ts'],
      exclude: ['**/*.integration.test.ts', '**/*.e2e.test.ts'],
      environment: 'node',
      globals: false,
    },
  },
  {
    // M51: web lib tests — pure TS logic with browser globals stubbed via setupFiles.
    // No jsdom/happy-dom required; fetch is native in Node ≥18 and window/localStorage are mocked
    // by apps/web/src/test-setup.ts before any module-level code runs.
    test: {
      name: 'web',
      include: ['apps/web/src/**/*.test.ts'],
      exclude: ['**/*.e2e.test.ts'],
      environment: 'node',
      globals: false,
      setupFiles: ['apps/web/src/test-setup.ts'],
    },
  },
  {
    test: {
      name: 'integration',
      include: ['apps/server/src/**/*.integration.test.ts'],
      environment: 'node',
      globals: false,
      testTimeout: 30_000,
      hookTimeout: 60_000,
      // Auto-retry a transiently-failing integration test: across a full serial run ~1 file/run
      // intermittently trips a resource/timing hiccup (DB clone lock, a late-run connection stall) that
      // always passes in isolation. A genuine regression fails all retries and still surfaces; a
      // transient flake is absorbed so the suite is deterministically green.
      retry: 2,
      pool: 'forks',
      // Run integration files SERIALLY in one fork. Each file opens ~20 Postgres connections (app pool
      // 15 + jobs 5 + admin/clone); once the suite grew, unbounded parallel forks exceeded Postgres
      // max_connections and surfaced as flaky, non-deterministic query failures. Serial is ~5× slower
      // but deterministic; revisit with a per-file connection cap or a bigger pool when it's worth it.
      poolOptions: { forks: { singleFork: true } },
    },
  },
  {
    test: {
      name: 'e2e',
      include: ['apps/web/e2e/**/*.spec.ts'],
      environment: 'node',
    },
  },
]);
