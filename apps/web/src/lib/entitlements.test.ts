import { describe, expect, it } from 'vitest';
import { entitlementsForPlan } from './entitlements.js';

/** Mirrors apps/server/src/auth/entitlements.ts — if these fail, the two resolvers drifted. */
describe('entitlementsForPlan', () => {
  it('free has nothing', () => {
    expect(entitlementsForPlan('free').size).toBe(0);
    expect(entitlementsForPlan(undefined).size).toBe(0);
  });
  it('pro has budgets + alerts only', () => {
    const pro = entitlementsForPlan('pro');
    expect(pro.has('budgets')).toBe(true);
    expect(pro.has('alerts')).toBe(true);
    expect(pro.has('guardrails')).toBe(false);
    expect(pro.has('chargeback')).toBe(false);
  });
  it('governance includes pro plus the governance set', () => {
    const gov = entitlementsForPlan('governance');
    for (const e of [
      'budgets',
      'alerts',
      'guardrails',
      'hierarchical_budgets',
      'budget_fallback',
      'provider_caps',
      'approval_chains',
      'automation',
      'anomaly',
      'chargeback',
      'audit_api',
    ] as const) {
      expect(gov.has(e)).toBe(true);
    }
    expect(gov.has('sso')).toBe(false);
  });
  it('enterprise includes governance plus sso/scim/residency', () => {
    const ent = entitlementsForPlan('enterprise');
    expect(ent.has('audit_api')).toBe(true);
    expect(ent.has('sso')).toBe(true);
    expect(ent.has('scim')).toBe(true);
    expect(ent.has('residency')).toBe(true);
  });
});
