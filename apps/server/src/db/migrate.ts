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

/**
 * Advisory-lock key serializing the entire migration path (roles + schema) across processes.
 * Arbitrary but FIXED — every migrator must use this same value or the lock does nothing.
 */
// Plain number, not bigint: pg_advisory_lock takes int64, and this value is far below 2^53 so it
// survives the JS number round-trip exactly. postgres.js's param types reject a bigint here.
const MIGRATION_LOCK_KEY = 8_150_119_477_001;

function roleCredentials(appUrl: string, jobsUrl: string): RoleCredentials[] {
  const roles = [
    { expected: 'spillway_app', credentials: credentialsFromUrl(appUrl, 'DATABASE_URL') },
    { expected: 'spillway_jobs', credentials: credentialsFromUrl(jobsUrl, 'DATABASE_URL_JOBS') },
  ];
  return roles.map(({ expected, credentials }) => {
    // The grant/RLS migrations name these roles explicitly. Failing loudly here
    // prevents a successful-looking bootstrap followed by an opaque 0001 failure.
    if (credentials.role !== expected) {
      throw new Error(
        `expected ${expected} in the corresponding runtime database URL, got ${credentials.role}`,
      );
    }
    return credentials;
  });
}

/**
 * Ensures the least-privilege roles exist before migration 0001 grants them access. Roles are
 * CLUSTER-level while the migration journal is PER-DATABASE, so role lifecycle lives here, not in
 * a migration. Password reconciliation happens post-migrate, when the role is guaranteed to
 * exist on every path.
 */
async function bootstrapApplicationRoles(
  sql: ReturnType<typeof postgres>,
  roles: RoleCredentials[],
): Promise<void> {
  for (const { role, password } of roles) {
    const [row] = await sql<{ current: boolean }[]>`
      select exists(select 1 from pg_roles where rolname = ${role}) as current`;
    if (row?.current) continue; // reconciled post-migrate
    await sql.unsafe(
      `CREATE ROLE ${quoteIdentifier(role)} LOGIN PASSWORD ${quoteLiteral(password)}`,
    );
  }
}

/**
 * Reconcile each role to the runtime URL credential (idempotent ALTER) so a rotated password or a
 * NOLOGIN drift is HEALED at migrate time instead of surfacing as an opaque auth failure at first
 * live request (expanded-audit LOW). Runs AFTER migrations, when the role exists on every path.
 * The migration runs as the superuser/owner URL, which can alter these roles.
 */
async function reconcileRoleCredentials(
  sql: ReturnType<typeof postgres>,
  roles: RoleCredentials[],
): Promise<void> {
  for (const { role, password } of roles) {
    await sql.unsafe(
      `ALTER ROLE ${quoteIdentifier(role)} LOGIN PASSWORD ${quoteLiteral(password)}`,
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
    // Bound the wait for the advisory lock below. Without this a contended lock blocks FOREVER,
    // and fly.toml runs this as a `release_command` — so the symptom is a rollout that never
    // completes, with a blank log and no error. 5 minutes is far longer than any real migration
    // needs to finish, and failing loudly after it beats hanging silently.
    await sql`set lock_timeout = '5min'`;
    // SERIALIZE THE WHOLE PATH. fly.toml runs this as a `release_command` on every deploy, so two
    // overlapping deploys (a re-deploy, or CI push racing a manual one) run it twice at once.
    //
    // fly.toml used to claim "concurrent deploys are safe because drizzle-kit uses advisory locks
    // on the migrations table". That is false for the code that actually runs — drizzle's pg-core
    // dialect takes no advisory lock — and it would not have helped anyway, because
    // bootstrapApplicationRoles does role DDL BEFORE migrate() is ever called. Observed on two
    // simultaneous migrators: `duplicate key value violates unique constraint
    // "pg_authid_rolname_index"` on a fresh cluster (check-then-CREATE loses at the btree, so it
    // is 23505 rather than the 42710 you would guess), and `tuple concurrently updated` on a
    // legacy one. Neither is caught, so a racing deploy exits 1 mid-mutation.
    //
    // Session-level lock on the single migration connection, released explicitly below and by the
    // session ending regardless. The key is an arbitrary fixed int64 — any other migrator uses the
    // same one, which is the point. A second migrator BLOCKS here and then finds every migration
    // already applied, which is the correct outcome.
    await sql`select pg_advisory_lock(${MIGRATION_LOCK_KEY})`;
    try {
      const roles = roleCredentials(appUrl, jobsUrl);
      await bootstrapApplicationRoles(sql, roles);
      await migrate(db, {
        migrationsFolder: path.resolve(process.cwd(), 'apps/server/src/db/migrations'),
      });
      await reconcileRoleCredentials(sql, roles);
      console.log('Migrations complete.');
    } finally {
      // Check the boolean. pg_advisory_unlock returns false (with a WARNING) when this backend
      // does not own the lock — which would mean the lock is held somewhere we cannot release it
      // and the next deploy will block. Silently discarding that turns a stuck rollout into a
      // mystery. Warn rather than throw: we are in a finally, and masking the real migration
      // error with an unlock failure would be worse.
      const [unlocked] = await sql<
        { pg_advisory_unlock: boolean }[]
      >`select pg_advisory_unlock(${MIGRATION_LOCK_KEY})`;
      if (unlocked?.pg_advisory_unlock !== true) {
        console.warn(
          `WARNING: migration advisory lock ${MIGRATION_LOCK_KEY} was not held by this session on release; a concurrent migrator may block`,
        );
      }
    }
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
