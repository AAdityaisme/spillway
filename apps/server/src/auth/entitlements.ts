/**
 * Entitlements resolver (ADR-018/039, operator directive #2). Tier gates are DATA, never an ordinal
 * `plan` compare: one place maps an org's plan → its entitlement set, and handlers check
 * `entitlements.has('x')`. Moving a feature between tiers = editing this mapping (+ the billing page),
 * nothing else. ADR-018 tiers: free (gateway core only) → Pro $49 (budgets + alerts) → Governance $299
 * (guardrails, budget hierarchy, approvals, automation, anomaly, chargeback, audit API) → Enterprise
 * (+ SSO/SCIM/residency).
 */

export type Entitlement =
  | 'budgets' // single-scope budgets + spend tracking (Pro+)
  | 'alerts' // alert channels (Pro+)
  | 'guardrails' // governance_policies deny/approval/flag (Governance+)
  | 'hierarchical_budgets' // team/virtual_key-scoped budgets above the org budget (Governance+)
  | 'budget_fallback' // on_exceed:fallback (serve-under-cheaper-alias) (Governance+)
  | 'provider_caps' // provider-scope budgets (Governance+)
  | 'approval_chains' // multi-tier approval policies (Governance+)
  | 'automation' // automation rules (Governance+)
  | 'anomaly' // anomaly detection (Governance+)
  | 'chargeback' // chargeback exports (Governance+)
  | 'audit_api' // audit log API (Governance+)
  | 'sso'
  | 'scim'
  | 'residency';

const PRO: Entitlement[] = ['budgets', 'alerts'];
const GOVERNANCE: Entitlement[] = [
  ...PRO,
  'guardrails',
  'hierarchical_budgets',
  'budget_fallback',
  'provider_caps',
  'approval_chains',
  'automation',
  'anomaly',
  'chargeback',
  'audit_api',
];
const ENTERPRISE: Entitlement[] = [...GOVERNANCE, 'sso', 'scim', 'residency'];

const BY_PLAN: Record<string, readonly Entitlement[]> = {
  free: [],
  pro: PRO,
  governance: GOVERNANCE,
  enterprise: ENTERPRISE,
};

/** Resolve an org plan → its entitlement set. Unknown plan → empty set (fail closed). */
export function resolveEntitlements(plan: string): ReadonlySet<Entitlement> {
  return new Set(BY_PLAN[plan] ?? []);
}
