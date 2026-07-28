import { describe, it, expect } from 'vitest';
import { resolveDelegate, type ActiveDelegation } from './delegate.js';
import { quorumCount, encodeQuorum, decodeQuorum, type ApprovalPolicyRow } from './materialize.js';
import { selectPolicy } from './policy-select.js';

const now = new Date('2026-07-07T00:00:00Z');
const deleg = (from: string, to: string): ActiveDelegation => ({
  from_user: from,
  to_user: to,
  starts_at: new Date('2026-07-01T00:00:00Z'),
  ends_at: new Date('2026-07-31T00:00:00Z'),
});

describe('approvals — delegation resolution (§2.5)', () => {
  it('returns the terminus of a chain A→B→C', () => {
    expect(resolveDelegate('A', now, [deleg('A', 'B'), deleg('B', 'C')])).toBe('C');
  });
  it('stops at the last non-cyclic user on a cycle A→B→A (never throws)', () => {
    expect(resolveDelegate('A', now, [deleg('A', 'B'), deleg('B', 'A')])).toBe('B');
  });
  it('ignores a delegation outside its active window', () => {
    const past: ActiveDelegation = {
      from_user: 'A',
      to_user: 'B',
      starts_at: new Date('2026-01-01T00:00:00Z'),
      ends_at: new Date('2026-01-31T00:00:00Z'),
    };
    expect(resolveDelegate('A', now, [past])).toBe('A');
  });
  it('caps runaway depth (>8 hops) without throwing', () => {
    const chain = Array.from({ length: 12 }, (_, i) => deleg(`u${i}`, `u${i + 1}`));
    expect(resolveDelegate('u0', now, chain)).toBe('u8'); // MAX_HOPS
  });
});

describe('approvals — quorum encoding (§2.4)', () => {
  it('all = set size, any = 1, N = max(1,N)', () => {
    expect(quorumCount('all', 3)).toBe(3);
    expect(quorumCount('any', 3)).toBe(1);
    expect(quorumCount(2, 3)).toBe(2);
    expect(quorumCount(0, 3)).toBe(1);
  });
  it('round-trips through the text column', () => {
    expect(decodeQuorum(encodeQuorum('all'))).toBe('all');
    expect(decodeQuorum(encodeQuorum('any'))).toBe('any');
    expect(decodeQuorum(encodeQuorum(3))).toBe(3);
  });
});

describe('approvals — most-specific policy selection (§2.1.2)', () => {
  const mk = (o: Partial<ApprovalPolicyRow>): ApprovalPolicyRow => ({
    id: o.id ?? 'x',
    org_id: 'o',
    name: 'n',
    kind: o.kind ?? '*',
    scope_type: o.scope_type ?? null,
    scope_id: o.scope_id ?? null,
    definition: { tiers: [] },
    version: 1,
    enabled: o.enabled ?? true,
  });

  it('exact (kind,scope) beats kind-org-wide beats wildcard-org-default', () => {
    const exact = mk({ id: 'exact', kind: 'budget_increase', scope_type: 'team', scope_id: 't1' });
    const kindOrg = mk({ id: 'kindOrg', kind: 'budget_increase' });
    const def = mk({ id: 'def', kind: '*' });
    const pols = [def, kindOrg, exact];
    expect(
      selectPolicy(pols, { kind: 'budget_increase', scopeType: 'team', scopeId: 't1' })?.id,
    ).toBe('exact');
    expect(
      selectPolicy(pols, { kind: 'budget_increase', scopeType: 'team', scopeId: 't2' })?.id,
    ).toBe('kindOrg');
    expect(selectPolicy(pols, { kind: 'key_unpause', scopeType: 'org', scopeId: 'o' })?.id).toBe(
      'def',
    );
  });
  it('skips disabled policies', () => {
    const disabled = mk({ id: 'd', kind: 'budget_increase', enabled: false });
    expect(
      selectPolicy([disabled], { kind: 'budget_increase', scopeType: null, scopeId: null }),
    ).toBeUndefined();
  });
});
