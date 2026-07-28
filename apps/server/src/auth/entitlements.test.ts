import { describe, it, expect } from 'vitest';
import { resolveEntitlements } from './entitlements.js';

describe('resolveEntitlements (ADR-018/039, B6.0)', () => {
  it('free has no paid entitlements', () => {
    const e = resolveEntitlements('free');
    expect(e.has('budgets')).toBe(false);
    expect(e.has('guardrails')).toBe(false);
    expect(e.size).toBe(0);
  });

  it('pro has budgets + alerts, NOT governance features', () => {
    const e = resolveEntitlements('pro');
    expect(e.has('budgets')).toBe(true);
    expect(e.has('alerts')).toBe(true);
    expect(e.has('guardrails')).toBe(false);
    expect(e.has('approval_chains')).toBe(false);
    expect(e.has('automation')).toBe(false);
  });

  it('governance has the full governance set (⊇ pro)', () => {
    const e = resolveEntitlements('governance');
    for (const x of ['budgets', 'alerts'] as const) expect(e.has(x)).toBe(true); // ⊇ pro
    for (const x of [
      'guardrails',
      'hierarchical_budgets',
      'budget_fallback',
      'provider_caps',
      'approval_chains',
      'automation',
      'anomaly',
      'chargeback',
      'audit_api',
    ] as const)
      expect(e.has(x)).toBe(true);
    expect(e.has('sso')).toBe(false); // enterprise-only
  });

  it('enterprise ⊇ governance + SSO/SCIM/residency', () => {
    const e = resolveEntitlements('enterprise');
    expect(e.has('guardrails')).toBe(true);
    expect(e.has('sso')).toBe(true);
    expect(e.has('scim')).toBe(true);
    expect(e.has('residency')).toBe(true);
  });

  it('an unknown plan fails closed (empty set)', () => {
    expect(resolveEntitlements('bogus').size).toBe(0);
  });
});
