import { describe, it, expect } from 'vitest';
import {
  resolveBudgetBundle,
  budgetCounterTuples,
  providerScopeId,
  rolling30Key,
  currentPeriodKeys,
  SCOPE_RANK,
  type BudgetRow,
  type BudgetBundle,
  type BudgetScopeType,
} from './resolver.js';

const row = (
  o: Partial<BudgetRow> & Pick<BudgetRow, 'scopeType' | 'scopeId' | 'period'>,
): BudgetRow => ({
  id: `${o.scopeType}-${o.period}`,
  limitMicroUsd: 1_000_000n,
  mode: 'enforce',
  onExceed: 'block',
  fallbackAlias: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  ...o,
});

describe('resolveBudgetBundle (17 §1.3, B2.3)', () => {
  const bundle: BudgetBundle = {
    orgId: 'org-1',
    teamId: 'team-1',
    virtualKeyId: 'vk-1',
    budgets: [
      row({ scopeType: 'org', scopeId: 'org-1', period: 'month' }),
      row({ scopeType: 'provider', scopeId: 'prov-1', period: 'day' }),
      row({ scopeType: 'virtual_key', scopeId: 'vk-1', period: 'day' }),
      row({ scopeType: 'team', scopeId: 'team-1', period: 'day' }),
      row({ scopeType: 'virtual_key', scopeId: 'vk-1', period: 'month' }),
    ],
  };
  const now = new Date('2026-07-04T12:00:00Z');

  it('orders inner→outer scope, day→month within scope, provider last', () => {
    const resolved = resolveBudgetBundle(bundle, now);
    expect(resolved.map((r) => `${r.budget.scopeType}:${r.budget.period}`)).toEqual([
      'virtual_key:day',
      'virtual_key:month',
      'team:day',
      'org:month',
      'provider:day',
    ]);
  });

  it('excludes budgets whose scope does not apply (team null)', () => {
    const noTeam = resolveBudgetBundle({ ...bundle, teamId: null }, now);
    expect(noTeam.some((r) => r.budget.scopeType === 'team')).toBe(false);
  });

  it('computes UTC calendar period keys', () => {
    const resolved = resolveBudgetBundle(bundle, now);
    const vkDay = resolved.find(
      (r) => r.budget.scopeType === 'virtual_key' && r.budget.period === 'day',
    )!;
    expect(vkDay.periodKey).toBe('2026-07-04');
    const orgMonth = resolved.find((r) => r.budget.scopeType === 'org')!;
    expect(orgMonth.periodKey).toBe('2026-07');
    expect(vkDay.counterKey).toBe('virtual_key:vk-1:2026-07-04');
  });

  it('rolling_30d anchors to createdAt, advances in 30-day blocks', () => {
    const anchor = new Date('2026-06-14T00:00:00Z');
    expect(rolling30Key(anchor, new Date('2026-06-20T00:00:00Z'))).toBe('r30:2026-06-14');
    expect(rolling30Key(anchor, new Date('2026-07-20T00:00:00Z'))).toBe('r30:2026-07-14'); // next block
  });

  it('budgetCounterTuples dedupes identical counter keys', () => {
    const dup: BudgetBundle = {
      orgId: 'o',
      teamId: null,
      virtualKeyId: 'vk-1',
      budgets: [
        row({ scopeType: 'virtual_key', scopeId: 'vk-1', period: 'day', mode: 'enforce' }),
        row({ scopeType: 'virtual_key', scopeId: 'vk-1', period: 'day', mode: 'alert' }), // same counter
      ],
    };
    expect(budgetCounterTuples(resolveBudgetBundle(dup, now))).toHaveLength(1);
  });

  it('providerScopeId is deterministic + org-scoped (orgId is the uuid namespace)', () => {
    const orgA = '11111111-1111-4111-8111-111111111111'; // valid v4-shaped (version=4, variant=8)
    const orgB = '22222222-2222-4222-8222-222222222222';
    expect(providerScopeId(orgA, 'openai')).toBe(providerScopeId(orgA, 'openai'));
    expect(providerScopeId(orgA, 'openai')).not.toBe(providerScopeId(orgB, 'openai'));
    expect(providerScopeId(orgA, 'openai')).not.toBe(providerScopeId(orgA, 'anthropic'));
    expect(providerScopeId(orgA, 'openai')).toMatch(/^[0-9a-f-]{36}$/); // valid uuid
  });

  it('currentPeriodKeys returns UTC month + day', () => {
    expect(currentPeriodKeys(now)).toEqual({ month: '2026-07', day: '2026-07-04' });
  });

  // red-team money-core #1: every spend_counters writer (reconcile upsert, reserveBudget,
  // logBlockedRequest) must acquire the shared tuples in ONE canonical order or two concurrent writers
  // on the same org+team deadlock (ABBA) and the reconcile victim loses the spend row. A live deadlock
  // isn't deterministically testable, but the mechanism is: sorting by SCOPE_RANK converges every
  // assembly order to the same canonical sequence.
  describe('SCOPE_RANK — the shared spend_counters lock order', () => {
    const sortByRank = <T extends { t: BudgetScopeType }>(xs: T[]): BudgetScopeType[] =>
      [...xs].sort((a, b) => SCOPE_RANK[a.t] - SCOPE_RANK[b.t]).map((x) => x.t);
    const CANONICAL: BudgetScopeType[] = ['virtual_key', 'team', 'org', 'provider'];

    it('is a total, distinct rank over every BudgetScopeType', () => {
      const ranks = Object.values(SCOPE_RANK);
      expect(new Set(ranks).size).toBe(ranks.length); // no ties → deterministic sort
      expect(Object.keys(SCOPE_RANK).sort()).toEqual(['org', 'provider', 'team', 'virtual_key']);
    });

    it('converges reconcile’s old [vk, org, team] order and budget’s [vk, team, org] to one sequence', () => {
      // reconcile historically assembled [vk, org, team, provider]; budget assembles [vk, team, org,
      // provider]. Before the fix these transposed org/team tuples deadlocked. Sorted by rank, both land
      // on the same canonical order — which is what makes the two writers lock-compatible.
      const reconcileAssembly = [
        { t: 'virtual_key' },
        { t: 'org' },
        { t: 'team' },
        { t: 'provider' },
      ] as const;
      const budgetAssembly = [
        { t: 'virtual_key' },
        { t: 'team' },
        { t: 'org' },
        { t: 'provider' },
      ] as const;
      expect(sortByRank([...reconcileAssembly])).toEqual(CANONICAL);
      expect(sortByRank([...budgetAssembly])).toEqual(CANONICAL);
      expect(sortByRank([...reconcileAssembly])).toEqual(sortByRank([...budgetAssembly]));
    });
  });
});
