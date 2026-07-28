import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import postgres, { type Sql } from 'postgres';
import { runMigrations } from './migrate.js';

const POSTGRES_IMAGE = 'postgres:16.3-alpine';
const ENV_KEYS = ['DATABASE_URL', 'DATABASE_URL_JOBS', 'MIGRATION_DATABASE_URL'] as const;
const previous = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

function withCredentials(raw: string, user: string, password: string): string {
  const url = new URL(raw);
  url.username = user;
  url.password = password;
  return url.toString();
}

let container: StartedPostgreSqlContainer;
let admin: Sql;

describe('release migrator', () => {
  beforeAll(async () => {
    container = await new PostgreSqlContainer(POSTGRES_IMAGE)
      .withDatabase('spillway_release_test')
      .withUsername('spillway')
      .withPassword('spillway')
      .start();
    const superUrl = container.getConnectionUri();
    process.env.DATABASE_URL = withCredentials(superUrl, 'spillway_app', 'spillway_app');
    process.env.DATABASE_URL_JOBS = withCredentials(superUrl, 'spillway_jobs', 'spillway_jobs');
    process.env.MIGRATION_DATABASE_URL = superUrl;
    await runMigrations();
    admin = postgres(superUrl);
  }, 30_000);

  afterAll(async () => {
    await admin?.end();
    await container?.stop();
    for (const key of ENV_KEYS) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('uses the privileged URL and bootstraps both least-privilege roles', async () => {
    const roles = await admin<{ rolname: string }[]>`
      select rolname from pg_roles where rolname in ('spillway_app', 'spillway_jobs') order by rolname`;
    expect(roles.map((r) => r.rolname)).toEqual(['spillway_app', 'spillway_jobs']);
    const tables = await admin<{ count: string }[]>`
      select count(*)::text as count from information_schema.tables
       where table_schema = 'public' and table_name = 'virtual_keys'`;
    expect(tables[0]?.count).toBe('1');
  });
});
