import { sql, and, eq } from 'drizzle-orm';
import type { DatabaseClient } from './client.js';
import { orgMembers } from './schema.js';

/**
 * Tenancy primitive (ADR-004, 03-data-model §8). `withOrg` opens a Drizzle
 * transaction and arms the RLS policies by setting the transaction-scoped GUC
 * `app.current_org_id` as the first statement — transaction-scoped (`true`) is
 * mandatory for Neon's transaction-mode pooling (a session GUC would bleed
 * across pooled connections). The callback only ever receives the transaction
 * client `tx`; the bare `db` is never re-exposed, so every query inside is armed.
 *
 * Org-scoped DML/SELECT on the app role MUST go through `withOrg` — outside it,
 * RLS denies by default (the GUC is unset → policy is false → zero rows).
 */
export type Tx = Parameters<Parameters<DatabaseClient['transaction']>[0]>[0];

export async function withOrg<T>(
  db: DatabaseClient,
  orgId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.current_org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

/**
 * Resolves a user's membership (role) in an org for the tenancy bootstrap, BEFORE
 * any org is entered. Sets the `app.current_user_id` GUC so the supplemental
 * org_members RLS policy (ADR-025) makes the caller's own row visible; returns
 * null when the user is not a member (→ 403).
 */
export async function lookupMembership(
  db: DatabaseClient,
  orgId: string,
  userId: string,
): Promise<{ role: string } | null> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.current_user_id', ${userId}, true)`);
    const rows = await tx
      .select({ role: orgMembers.role })
      .from(orgMembers)
      .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId)));
    return rows[0] ?? null;
  });
}

/** UTC period key for spend_counters (ADR-007): 'YYYY-MM' (month) or 'YYYY-MM-DD' (day). */
export function periodKey(period: 'month' | 'day', at: Date): string {
  const iso = at.toISOString(); // always UTC
  return period === 'month' ? iso.slice(0, 7) : iso.slice(0, 10);
}

/** Both period keys for an instant (defaults to now). */
export function currentPeriodKeys(at: Date = new Date()): { month: string; day: string } {
  return { month: periodKey('month', at), day: periodKey('day', at) };
}
