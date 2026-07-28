import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import postgres, { type Sql } from 'postgres';
import * as schema from './schema.js';

/**
 * The Drizzle database client (ADR-004): postgres-js driver, direct SQL, no
 * supabase-js/PostgREST. Host-agnostic — Neon in prod, Dockerized Postgres
 * locally (ADR-022). Connections are lazy — `makeDb` does not open a socket
 * until the first query, so boot succeeds even when Postgres is unreachable.
 */
export type DatabaseClient = PostgresJsDatabase<typeof schema>;

export interface Db {
  db: DatabaseClient;
  sql: Sql;
  close: () => Promise<void>;
}

export function makeDb(url: string, max = 15): Db {
  // prepare:false — a transaction-mode connection pooler (Supabase 6543, PgBouncer) hands each
  // query a different backend, so server-side prepared statements silently break. Disabling them
  // is safe on direct connections too (it only drops the prepared-statement optimization), so we
  // set it unconditionally rather than sniffing the URL. Neon's pooler is session-mode, but this
  // keeps us portable across poolers. See bible §3.2.
  const sqlClient = postgres(url, { max, prepare: false });
  const db = drizzle(sqlClient, { schema });
  return {
    db,
    sql: sqlClient,
    close: async () => {
      await sqlClient.end({ timeout: 5 });
    },
  };
}

/** Cheap reachability probe for /readyz. Never throws. */
export async function pingDb(db: DatabaseClient): Promise<boolean> {
  try {
    await db.execute(sql`select 1`);
    return true;
  } catch {
    return false;
  }
}
