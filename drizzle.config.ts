import { defineConfig } from 'drizzle-kit';

/**
 * Drizzle Kit configuration (03-data-model, 12-operations §4).
 * Schema lives in apps/server/src/db/schema.ts; migrations are generated into
 * apps/server/src/db/migrations and applied via `pnpm db:migrate`.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './apps/server/src/db/schema.ts',
  out: './apps/server/src/db/migrations',
  dbCredentials: {
    // Migrations run as a SUPERUSER (grants + RLS need owner privileges the app
    // role lacks). MIGRATION_DATABASE_URL overrides for Neon; local default is the
    // Docker 'spillway' superuser.
    url:
      process.env.MIGRATION_DATABASE_URL ??
      'postgres://spillway:spillway@localhost:5432/spillway_dev',
  },
  strict: true,
  verbose: true,
});
