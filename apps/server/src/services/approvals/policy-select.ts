import type { ApprovalPolicyRow } from './materialize.js';

/**
 * Most-specific-wins approval-policy selection (Part II §18 §2.1.2), run on request creation.
 *
 * Given the request's `(kind, scope_type, scope_id)`, pick the enabled policy by this precedence,
 * FIRST match wins:
 *   1. exact (kind, scope_type, scope_id)
 *   2. exact kind, org-wide (scope_type IS NULL)
 *   3. wildcard kind '*', exact (scope_type, scope_id)
 *   4. wildcard kind '*', org-wide
 * The seeded org-default (§2.10) always satisfies level 4, so in production selection never returns
 * undefined; returning undefined when no candidate matches is a seed bug, surfaced to the caller.
 */
export interface PolicyQuery {
  kind: string;
  scopeType: string | null;
  scopeId: string | null;
}

type Predicate = (p: ApprovalPolicyRow, q: PolicyQuery) => boolean;

const PRECEDENCE: readonly Predicate[] = [
  (p, q) => p.kind === q.kind && p.scope_type === q.scopeType && p.scope_id === q.scopeId,
  (p, q) => p.kind === q.kind && p.scope_type === null,
  (p, q) => p.kind === '*' && p.scope_type === q.scopeType && p.scope_id === q.scopeId,
  (p) => p.kind === '*' && p.scope_type === null,
];

export function selectPolicy(
  policies: readonly ApprovalPolicyRow[],
  query: PolicyQuery,
): ApprovalPolicyRow | undefined {
  const enabled = policies.filter((p) => p.enabled);
  for (const match of PRECEDENCE) {
    const hit = enabled.find((p) => match(p, query));
    if (hit) return hit;
  }
  return undefined;
}
