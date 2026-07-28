import type { CompiledPolicy } from '../policy/guardrail-types.js';
import type { CompiledRule } from './compile.js';

/**
 * Scope-typed policy merge: org → team → virtual key (15 §3). Ported from the lab. The caller can
 * never LOOSEN server policy. Deny-shaped fields (allow-lists, guardrails) INTERSECT/UNION (a child
 * can only restrict); preference-shaped fields (routing-rule sets) take the most-specific scope that
 * sets them. Runs at bundle-compile time, producing the single effectivePolicy ROUTE reads.
 *
 * v1 note: routing config (aliases/rules/policies/allow-lists) is org+vk scoped in the schema; these
 * merge helpers are the general form the compile step uses (and the reserve seam for team scoping).
 */

/** §3.1 deny-shaped allow-list merge. null = "all"; a list restricts. Empty [] = fully closed. */
export function mergeAllowList(...lists: Array<readonly string[] | null>): string[] | null {
  let result: Set<string> | null = null; // null = ALL
  for (const list of lists) {
    if (list === null) continue;
    if (result === null) {
      result = new Set(list);
    } else {
      const restricted = new Set<string>();
      for (const v of list) if (result.has(v)) restricted.add(v);
      result = restricted;
    }
  }
  return result === null ? null : [...result];
}

/** §3.2 preference-shaped merge: vk ?? team ?? org ?? default. */
export function mergePreference<T>(
  orgVal: T | null | undefined,
  teamVal: T | null | undefined,
  vkVal: T | null | undefined,
  dflt: T,
): T {
  return vkVal ?? teamVal ?? orgVal ?? dflt;
}

/** §3.2 routing-rule sets are preference-shaped — most-specific scope replaces the ancestor's. */
export function mergeRoutingRules(
  orgRules: CompiledRule[] | null | undefined,
  teamRules: CompiledRule[] | null | undefined,
  vkRules: CompiledRule[] | null | undefined,
): CompiledRule[] {
  return mergePreference<CompiledRule[]>(orgRules, teamRules, vkRules, []);
}

/** deny > require_approval > flag; within an effect, enforce > shadow. Higher wins on id collision. */
function policyStrictness(p: CompiledPolicy): number {
  const effectRank: Record<CompiledPolicy['effect'], number> = {
    deny: 3,
    require_approval: 2,
    flag: 1,
  };
  return effectRank[p.effect] * 2 + (p.enforcement === 'enforce' ? 1 : 0);
}

/**
 * §3.2 governance policies are DENY-SHAPED — unioned across all scopes, de-duped by id keeping the
 * STRICTEST colliding policy (order-independent; a child reusing a parent id can only tighten).
 */
export function mergeGovernancePolicies(
  ...scopes: Array<readonly CompiledPolicy[]>
): CompiledPolicy[] {
  const byId = new Map<string, number>();
  const out: CompiledPolicy[] = [];
  for (const scope of scopes) {
    for (const p of scope) {
      const idx = byId.get(p.id);
      if (idx === undefined) {
        byId.set(p.id, out.length);
        out.push(p);
      } else if (policyStrictness(p) > policyStrictness(out[idx]!)) {
        out[idx] = p;
      }
    }
  }
  return out;
}
