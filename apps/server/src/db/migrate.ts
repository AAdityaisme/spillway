import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import path from 'node:path';

interface RoleCredentials {
  role: string;
  password: string;
}

function credentialsFromUrl(raw: string, name: string): RoleCredentials {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} is not a valid database URL`);
  }
  const role = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  if (!role || !password) {
    throw new Error(`${name} must include the application role username and password`);
  }
  if (!/^[A-Za-z_][A-Za-z0-9_$]{0,62}$/.test(role)) {
    throw new Error(`${name} contains an unsupported PostgreSQL role name`);
  }
  return { role, password };
}

const quoteIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;
const quoteLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`;

/** Creates missing least-privilege roles before migration 0001 grants them access. */
async function bootstrapApplicationRoles(
  sql: ReturnType<typeof postgres>,
  appUrl: string,
  jobsUrl: string,
): Promise<void> {
  const roles = [
    { expected: 'spillway_app', credentials: credentialsFromUrl(appUrl, 'DATABASE_URL') },
    { expected: 'spillway_jobs', credentials: credentialsFromUrl(jobsUrl, 'DATABASE_URL_JOBS') },
  ];
  for (const { expected, credentials } of roles) {
    const { role, password } = credentials;
    // The grant/RLS migrations name these roles explicitly. Failing loudly here
    // prevents a successful-looking bootstrap followed by an opaque 0001 failure.
    if (role !== expected) {
      throw new Error(
        `expected ${expected} in the corresponding runtime database URL, got ${role}`,
      );
    }
    const existing = await sql<{ exists: boolean }[]>`
      select exists(select 1 from pg_roles where rolname = ${role}) as exists`;
    if (existing[0]?.exists) {
      // Role already provisioned: don't silently skip. Reconcile it to the runtime URL credential
      // (idempotent ALTER) so a rotated password or a NOLOGIN drift is HEALED at migrate time instead
      // of surfacing as an opaque auth failure at first live request (expanded-audit LOW). The
      // migration runs as the superuser/owner URL, which can alter these roles.
      await sql.unsafe(
        `ALTER ROLE ${quoteIdentifier(role)} LOGIN PASSWORD ${quoteLiteral(password)}`,
      );
      continue;
    }
    await sql.unsafe(
      `CREATE ROLE ${quoteIdentifier(role)} LOGIN PASSWORD ${quoteLiteral(password)}`,
    );
  }
}

export async function runMigrations(): Promise<void> {
  const appUrl = process.env.DATABASE_URL;
  const jobsUrl = process.env.DATABASE_URL_JOBS;
  const url = process.env.MIGRATION_DATABASE_URL ?? appUrl;
  if (!url || !appUrl || !jobsUrl) {
    console.error(
      'FATAL: DATABASE_URL, DATABASE_URL_JOBS, and MIGRATION_DATABASE_URL (or DATABASE_URL fallback) are required to run migrations',
    );
    process.exit(1);
  }
  const sql = postgres(url, { max: 1 });
  const db = drizzle(sql);
  try {
    await bootstrapApplicationRoles(sql, appUrl, jobsUrl);
    await migrate(db, {
      migrationsFolder: path.resolve(process.cwd(), 'apps/server/src/db/migrations'),
    });
    console.log('Migrations complete.');
  } finally {
    await sql.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runMigrations().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
