import { defineConfig } from '@playwright/test';

/**
 * E2E against a RUNNING local stack (db:up + db:migrate + seed:demo + dev + dev:web) —
 * see apps/web/README.md. Auth comes from env: SPILLWAY_DEV_JWT + SPILLWAY_DEV_ORG
 * (both printed by `pnpm dev:token`). Not part of `pnpm gate` — servers are a precondition.
 */
export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  retries: 0,
  use: {
    baseURL: process.env.SPILLWAY_WEB_URL ?? 'http://localhost:5173',
    viewport: { width: 1440, height: 900 },
  },
  reporter: [['list']],
});
