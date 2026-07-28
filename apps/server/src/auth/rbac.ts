import { and, eq } from 'drizzle-orm';
import { SpillwayError } from '@spillway/shared';
import { orgContext } from '../org-context.js';
import { orgMembers } from '../db/schema.js';
import type { Tx } from '../db/tenancy.js';

export type Role = 'owner' | 'admin' | 'member' | 'viewer';

export const ROLE_RANK: Record<Role, number> = { owner: 3, admin: 2, member: 1, viewer: 0 };

export function isRole(value: string): value is Role {
  return value in ROLE_RANK;
}

/** True when `role` is at least as privileged as `min`. Unknown roles fail closed. */
export function hasRole(role: string, min: Role): boolean {
  return isRole(role) && ROLE_RANK[role] >= ROLE_RANK[min];
}

/** Throws 403 unless the current request's org role meets `min`. */
export function requireRole(min: Role): void {
  const { role } = orgContext.require();
  if (!hasRole(role, min)) {
    throw new SpillwayError('forbidden', `requires ${min} role`, {
      httpStatus: 403,
      details: { required: min, actual: role },
    });
  }
}

/**
 * Whether an actor with `actorRole` may grant/modify/remove a member at
 * `affectedRole`. Owners manage anyone; admins manage only member/viewer and
 * cannot touch owners or admins (04-api-contracts §3, members).
 */
export function canManageMemberRole(actorRole: string, affectedRole: Role): boolean {
  if (actorRole === 'owner') return true;
  if (actorRole === 'admin') return affectedRole === 'member' || affectedRole === 'viewer';
  return false;
}

/**
 * Guards the ≥1-owner invariant: throws `last_owner` (409) if, after excluding
 * `affectedUserId`, the org would have zero owners. Must run inside the SAME
 * transaction as the demotion/removal for atomicity.
 */
export async function assertOwnerRemains(
  tx: Tx,
  orgId: string,
  affectedUserId: string,
): Promise<void> {
  // Lock ALL owner rows FOR UPDATE so concurrent demotions/removals serialize. A
  // non-locking count under READ COMMITTED lets two transactions each still see
  // the other's owner, both pass, and the org ends with zero owners (TOCTOU).
  const owners = await tx
    .select({ userId: orgMembers.userId })
    .from(orgMembers)
    .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.role, 'owner')))
    .for('update');
  const remaining = owners.filter((o) => o.userId !== affectedUserId).length;
  if (remaining === 0) {
    throw new SpillwayError('last_owner', 'cannot remove or demote the last owner', {
      httpStatus: 409,
    });
  }
}
