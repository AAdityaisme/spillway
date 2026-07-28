/**
 * Delegation resolution & cycle guard (Part II §18 §2.5).
 *
 * Out-of-office delegations can chain (A→B, B→C). Resolution follows the chain to its terminus,
 * guarded against cycles (A→B→A) and runaway depth. PURE — a cycle is a config error that must NOT
 * throw or block chain creation.
 */

/** A delegation active at the resolution instant (starts_at <= now <= ends_at). */
export interface ActiveDelegation {
  from_user: string;
  to_user: string;
  starts_at: Date;
  ends_at: Date;
}

/** Max hops before we stop following the chain (§2.5 step 2). */
const MAX_HOPS = 8;

/**
 * The active delegation whose `from_user === cur`. At most one is expected; if several overlap, the
 * one with the latest `starts_at` wins (deterministic).
 */
function activeDelegationFrom(
  cur: string,
  now: Date,
  delegations: readonly ActiveDelegation[],
): ActiveDelegation | undefined {
  let best: ActiveDelegation | undefined;
  for (const d of delegations) {
    if (d.from_user !== cur) continue;
    if (d.starts_at.getTime() > now.getTime() || now.getTime() > d.ends_at.getTime()) continue;
    if (best === undefined || d.starts_at.getTime() > best.starts_at.getTime()) best = d;
  }
  return best;
}

/**
 * Resolve `u` to the effective approver by walking active delegations. Returns the terminus, the last
 * non-cyclic user on a cycle, or the last user at the depth cap. Never throws.
 */
export function resolveDelegate(
  u: string,
  now: Date,
  delegations: readonly ActiveDelegation[],
): string {
  const visited = new Set<string>([u]);
  let cur = u;
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const d = activeDelegationFrom(cur, now, delegations);
    if (!d) return cur; // terminus
    if (visited.has(d.to_user)) return cur; // cycle — stop at last non-cyclic user
    visited.add(d.to_user);
    cur = d.to_user;
  }
  return cur; // depth cap reached
}
