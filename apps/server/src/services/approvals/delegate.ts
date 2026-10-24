/**
 * Delegation resolution & cycle guard (Part II §18 §2.5).
 *
 * Out-of-office delegations can chain (A→B, B→C). Resolution follows the chain to its terminus,
 * guarded against cycles (A→B→A) and runaway depth. PURE — a cycle is a config error that must NOT
 * throw or block chain creation.
 */

/**
 * A delegation active at the resolution instant (starts_at <= now <= ends_at).
 *
 * The timestamps are `Date | string` because that is the truth, not a convenience: the only
 * production caller (materialize.ts) reads these rows through a raw `tx.execute`, and postgres-js
 * hands raw results back UNPARSED — a `timestamptz` arrives as `'2026-08-09 01:32:59.471707+00'`,
 * not a Date. Declaring `Date` here made the cast at the call site a lie that TypeScript then
 * certified, and `.getTime()` below threw a TypeError on every approval creation once any
 * delegation row existed. Same shape as `AutomationRule.notify_only_until` in automation/safety.ts,
 * which types the union honestly for the same reason.
 */
export interface ActiveDelegation {
  from_user: string;
  to_user: string;
  starts_at: Date | string;
  ends_at: Date | string;
}

/** Max hops before we stop following the chain (§2.5 step 2). */
const MAX_HOPS = 8;

/** Epoch ms from either driver shape. Normalising here keeps every caller safe, not just today's. */
const epochMs = (t: Date | string): number => (t instanceof Date ? t : new Date(t)).getTime();

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
    if (epochMs(d.starts_at) > now.getTime() || now.getTime() > epochMs(d.ends_at)) continue;
    if (best === undefined || epochMs(d.starts_at) > epochMs(best.starts_at)) best = d;
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
