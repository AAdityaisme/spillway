import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { APP_ROLE_SQL, POSTGRES_IMAGE } from './helpers/db.js';

/**
 * ONE Postgres container per integration RUN, torn down when the run ends.
 *
 * WHY THIS EXISTS: `createTestDb()` memoises the container in a module-level variable, which reads
 * like "start it once". It isn't — vitest gives every test FILE a fresh module graph, so that
 * variable reset 65 times and started 65 containers, each one paying a full boot plus a full
 * `drizzle migrate`. The suite took ~30 minutes, and because ryuk was not reaping on this machine,
 * every run left its containers running: 196 idle Postgres instances had accumulated by 2026-08-07.
 *
 * globalSetup runs once in the MAIN process before any worker forks, and its returned teardown runs
 * after the last file — so the container's lifetime finally matches the run's. Workers inherit
 * `TEST_DATABASE_URL` through the fork's env, which is the same channel CI already used, so both
 * paths now converge on one shared cluster (the topology CI has always run green).
 *
 * Not a vitest run (the stress harness calls `makeTestApp()` directly)? `createTestDb()` still
 * falls back to starting its own container — that path owns its own teardown.
 */
export async function setup(): Promise<(() => Promise<void>) | undefined> {
  // CI supplies an external service container. Create the roles once; the schema is migrated by a
  // separate CI step, so do NOT migrate here.
  if (process.env.TEST_DATABASE_URL) {
    const ciClient = postgres(process.env.TEST_DATABASE_URL);
    await ciClient.unsafe(APP_ROLE_SQL);
    await ciClient.end();
    return undefined;
  }

  const container = await new PostgreSqlContainer(POSTGRES_IMAGE)
    .withDatabase('spillway_template')
    .withUsername('spillway_test')
    .withPassword('spillway_test')
    .start();

  const uri = container.getConnectionUri();
  const client = postgres(uri);
  await client.unsafe(APP_ROLE_SQL); // roles must exist before the grants migration
  await migrate(drizzle(client), { migrationsFolder: './apps/server/src/db/migrations' });
  await client.end();

  process.env.TEST_DATABASE_URL = uri;

  return async () => {
    await container.stop();
  };
}
