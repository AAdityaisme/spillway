import type { Plan } from './api.js';

/**
 * Client mirror of the server's entitlements resolver (apps/server/src/auth/entitlements.ts).
 * Tier gating is DATA (org.plan), not hardcoded plan comparisons — the UI reads entitlements
 * so packaging stays movable (standing directive #2). Keep in sync with the server resolver;
 * the server enforces regardless, this only decides what to surface vs plan-gate.
 */

const PRO = ['budgets', 'alerts'] as const;
const GOVERNANCE = [
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
] as const;
const ENTERPRISE = [...GOVERNANCE, 'sso', 'scim', 'residency'] as const;

export type Entitlement = (typeof ENTERPRISE)[number];

export function entitlementsForPlan(plan: Plan | undefined): Set<Entitlement> {
  switch (plan) {
    case 'pro':
      return new Set(PRO);
    case 'governance':
      return new Set(GOVERNANCE);
    case 'enterprise':
      return new Set(ENTERPRISE);
    default:
      return new Set();
  }
}
