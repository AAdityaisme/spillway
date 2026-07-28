import { sql } from 'drizzle-orm';
import type { DatabaseClient } from '../db/client.js';
import { users } from '../db/schema.js';
import type { AuthenticatedUser } from './workos-jwt.js';

/**
 * Mirrors a verified WorkOS user into the local users table (id = WorkOS `sub`).
 * First login inserts; later logins refresh email. users has no org_id (global
 * identity), so this runs OUTSIDE withOrg — there is no RLS to arm.
 */
export async function mirrorUser(db: DatabaseClient, user: AuthenticatedUser): Promise<void> {
  await db
    .insert(users)
    .values({
      id: user.sub,
      email: user.email ?? `${user.sub}@users.workos`,
      name: user.name ?? null,
    })
    .onConflictDoUpdate({
      target: users.id,
      set: { email: sql`excluded.email`, name: sql`excluded.name`, updatedAt: sql`now()` },
    });
}
