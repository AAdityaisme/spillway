import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { randomUUID } from 'node:crypto';
import type { DatabaseClient } from '../../src/db/client.js';
import * as schema from '../../src/db/schema.js';

/** Single pinned image — shared by testcontainers (local) and CI service container. */
export const POSTGRES_IMAGE = 'postgres:18.4-alpine';

/** Cluster-wide, idempotent. Run once per cluster by global-setup.ts; also by the fallback below. */
export const APP_ROLE_SQL = `
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'spillway_app') THEN
    CREATE ROLE spillway_app LOGIN PASSWORD 'spillway_app';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'spillway_jobs') THEN
    CREATE ROLE spillway_jobs LOGIN PASSWORD 'spillway_jobs';
  END IF;
END $$;`;

/** Non-null ONLY on the non-vitest fallback path (see ensureTemplate). */
let templateContainer: StartedPostgreSqlContainer | null = null;
let templateConnString: string | undefined;

/** Swap user:password in a postgres URL (keeps host/port/db). */
function withCredentials(connString: string, user: string, password: string): string {
  return connString.replace(/\/\/[^@/]+@/, `//${user}:${password}@`);
}

/**
 * Points this worker at the cluster the run is using, starting one only if nothing else has.
 *
 * `TEST_DATABASE_URL` is normally already set — by global-setup.ts for a vitest run, or by the CI
 * workflow's service container — and in that case the roles and the migrated template are already
 * in place. The container branch exists for callers OUTSIDE vitest (the stress harness drives
 * `makeTestApp()` directly and never triggers globalSetup); it owns its container's teardown.
 *
 * Do NOT reintroduce a container start on the vitest path: this variable is module-level and vitest
 * gives each test file a fresh module graph, so "start it once" silently becomes once per file.
 */
async function ensureTemplate(): Promise<string> {
  if (templateConnString) return templateConnString;

  if (process.env.TEST_DATABASE_URL) {
    templateConnString = process.env.TEST_DATABASE_URL;
    return templateConnString;
  }

  templateContainer = await new PostgreSqlContainer(POSTGRES_IMAGE)
    .withDatabase('spillway_template')
    .withUsername('spillway_test')
    .withPassword('spillway_test')
    .start();
  templateConnString = templateContainer.getConnectionUri();

  const tmplClient = postgres(templateConnString);
  await tmplClient.unsafe(APP_ROLE_SQL); // roles must exist before grants migration
  await migrate(drizzle(tmplClient), { migrationsFolder: './apps/server/src/db/migrations' });
  await tmplClient.end();
  return templateConnString;
}

/**
 * Provisions an isolated test database on the run's shared cluster by cloning the migrated
 * template (CREATE DATABASE ... TEMPLATE, ~5ms). Returns:
 *   - `db`      Drizzle connected as the NON-superuser spillway_app role, so RLS is
 *               actually enforced (production-like — what buildApp uses).
 *   - `adminSql` raw superuser connection for seeding + cross-org assertions that
 *               must BYPASS RLS in test setup.
 */
export async function createTestDb(): Promise<{
  db: DatabaseClient;
  jobsDb: DatabaseClient;
  adminSql: Sql;
  containerId: string | undefined;
  cleanup: () => Promise<void>;
}> {
  const templateUrl = await ensureTemplate();

  const testDbName = `spillway_test_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  // Template = whatever DB was migrated: 'spillway_template' locally, the CI
  // service DB (e.g. 'spillway_test') in CI. Derive it, don't hardcode.
  const templateDbName = new URL(templateUrl).pathname.slice(1);

  const adminClient = postgres(templateUrl.replace(/\/\w+$/, '/postgres'));
  // `CREATE DATABASE … TEMPLATE` briefly locks the source; a concurrent clone of the same template (many
  // integration files run in parallel) fails with 55006 "source database is being accessed by other
  // users". The lock is momentary — retry with a short backoff instead of flaking the whole file.
  for (let attempt = 0; ; attempt++) {
    try {
      await adminClient`CREATE DATABASE ${adminClient(testDbName)} TEMPLATE ${adminClient(templateDbName)}`;
      break;
    } catch (err) {
      if ((err as { code?: string }).code === '55006' && attempt < 20) {
        await new Promise((r) => setTimeout(r, 100 + attempt * 50));
        continue;
      }
      throw err;
    }
  }
  await adminClient.end();

  const superConnString = templateUrl.replace(/\/\w+$/, `/${testDbName}`);
  const appConnString = withCredentials(superConnString, 'spillway_app', 'spillway_app');

  const appClient = postgres(appConnString);
  const db = drizzle(appClient, { schema });
  const jobsClient = postgres(withCredentials(superConnString, 'spillway_jobs', 'spillway_jobs'));
  const jobsDb = drizzle(jobsClient, { schema });
  const adminSql = postgres(superConnString);

  return {
    db,
    jobsDb,
    adminSql,
    // The testcontainer's real docker id (undefined in CI, where TEST_DATABASE_URL is an external
    // Postgres and no container is started). Callers that manage the container directly — the stress
    // harness pauses it and, with ryuk disabled, must remove it — capture this at creation instead of
    // re-deriving it by mapped port (a lookup that silently misfires once orphaned testcontainers pile up).
    containerId: templateContainer?.getId(),
    cleanup: async () => {
      await appClient.end();
      await jobsClient.end();
      await adminSql.end();
      const dropper = postgres(templateUrl.replace(/\/\w+$/, '/postgres'));
      // WITH (FORCE) terminates any session still attached (Postgres 13+). Without it this drop
      // races: `.end()` resolves when the pool stops issuing queries, not when every backend has
      // actually gone away, so a plain DROP hits 55006 "is being accessed by other users" and fails
      // the whole FILE from afterAll — where `retry` cannot save it. Seen on CI 2026-08-07 with 8
      // sessions still attached. We are dropping a throwaway clone; there is nothing to protect.
      await dropper`DROP DATABASE IF EXISTS ${dropper(testDbName)} WITH (FORCE)`;
      await dropper.end();
    },
  };
}
