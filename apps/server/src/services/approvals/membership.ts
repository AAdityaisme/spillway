import { sql } from 'drizzle-orm';
import type { Tx } from '../../db/tenancy.js';
import type { Membership } from './materialize.js';

/**
 * Builds the org membership snapshot for chain materialization (Part II §18 §2.4 step 3.1). Runs on the
 * app role inside the request's org GUC, so the org_members SELECT is RLS-scoped to THIS org — a
 * role→user set that can't leak another tenant, and `isMember` is the cross-org FK re-check that drops
 * a borrowed user id (v2-code-seams F6).
 */
export async function buildMembership(tx: Tx, _orgId: string): Promise<Membership> {
  const rows = (await tx.execute(sql`
    select user_id, role from org_members`)) as unknown as { user_id: string; role: string }[];
  const byRole = new Map<string, string[]>();
  const ids = new Set<string>();
  for (const r of rows) {
    ids.add(r.user_id);
    (byRole.get(r.role) ?? byRole.set(r.role, []).get(r.role)!).push(r.user_id);
  }
  return {
    byRoles: (roles) => {
      const out = new Set<string>();
      for (const role of roles) for (const u of byRole.get(role) ?? []) out.add(u);
      return [...out];
    },
    isMember: (userId) => ids.has(userId),
  };
}
