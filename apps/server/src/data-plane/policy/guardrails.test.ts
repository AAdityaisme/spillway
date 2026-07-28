import { describe, it, expect } from 'vitest';
import { evaluateGuardrails, structuredMatch, type ConditionRunner } from './guardrails.js';
import type { CompiledPolicy } from './guardrail-types.js';
import type { AttributeActivation } from './condition-evaluator.js';

const attrs: AttributeActivation = {
  identity: { org_id: 'o', virtual_key_id: 'vk', key_tags: [], team_id: 't1' },
  request: {
    model_requested: 'gpt-4o',
    model_resolved: 'gpt-4o',
    provider: 'openai',
    endpoint: 'chat_completions',
  },
  spend: {},
  time: {},
};

const alwaysRun: ConditionRunner = { evalCondition: () => true };

const pol = (
  o: Partial<CompiledPolicy> & Pick<CompiledPolicy, 'id' | 'effect'>,
): CompiledPolicy => ({
  name: o.id,
  reason: `reason-${o.id}`,
  enforcement: 'enforce',
  match: {},
  effectConfig: {},
  ...o,
});

describe('evaluateGuardrails deny-overrides (16 §3, B4)', () => {
  it('an enforcing deny wins over a flag — the F1 shadowing fix (order-independent)', () => {
    const out = evaluateGuardrails(
      [pol({ id: 'b-flag', effect: 'flag' }), pol({ id: 'a-deny', effect: 'deny' })],
      attrs,
      alwaysRun,
    );
    expect(out.action).toBe('deny');
    expect(out.policyId).toBe('a-deny');
    expect(out.reason).toBe('reason-a-deny');
  });

  it('deny beats require_approval', () => {
    const out = evaluateGuardrails(
      [
        pol({ id: 'z-approval', effect: 'require_approval' }),
        pol({ id: 'y-deny', effect: 'deny' }),
      ],
      attrs,
      alwaysRun,
    );
    expect(out.action).toBe('deny');
  });

  it('a shadow deny does NOT act (recorded in matched, but allow)', () => {
    const out = evaluateGuardrails(
      [pol({ id: 'shadow-deny', effect: 'deny', enforcement: 'shadow' })],
      attrs,
      alwaysRun,
    );
    expect(out.action).toBe('allow');
    expect(out.matched.map((m) => m.policyId)).toContain('shadow-deny');
  });

  it('ties break on the lexicographically smallest id', () => {
    const out = evaluateGuardrails(
      [pol({ id: 'deny-2', effect: 'deny' }), pol({ id: 'deny-1', effect: 'deny' })],
      attrs,
      alwaysRun,
    );
    expect(out.policyId).toBe('deny-1');
  });

  it('flag effects annotate but allow; no match → allow', () => {
    const flagged = evaluateGuardrails([pol({ id: 'f', effect: 'flag' })], attrs, alwaysRun);
    expect(flagged.action).toBe('allow');
    expect(flagged.flags.map((f) => f.policyId)).toEqual(['f']);
    const noMatch = evaluateGuardrails(
      [pol({ id: 'x', effect: 'deny', match: { team_ids: ['other-team'] } })],
      attrs,
      alwaysRun,
    );
    expect(noMatch.action).toBe('allow');
  });

  it('structuredMatch: team filter never matches a team-less request', () => {
    const teamless: AttributeActivation = {
      ...attrs,
      identity: { ...attrs.identity, team_id: null },
    };
    expect(structuredMatch({ team_ids: ['t1'] }, teamless)).toBe(false);
    expect(structuredMatch({ team_ids: ['t1'] }, attrs)).toBe(true);
  });

  // expanded-audit L5: the metadata evasion (send metadata.route as a NUMBER so `42 === '42'` is
  // false and a deny/route policy is skipped) is closed at the boundary — the data-plane schema types
  // metadata as record(string, string), so req.metadata values are always strings by the time they
  // reach structuredMatch. These pin the intended string-equality semantics + no-match on absence.
  it('structuredMatch: metadata is OR-across-entries, AND-within-an-entry (string equality)', () => {
    const withMeta: AttributeActivation = {
      ...attrs,
      request: { ...attrs.request, metadata: { env: 'prod', tier: 'gold' } },
    };
    expect(structuredMatch({ metadata: [{ env: 'prod' }] }, withMeta)).toBe(true);
    expect(structuredMatch({ metadata: [{ env: 'prod', tier: 'gold' }] }, withMeta)).toBe(true);
    // AND-within-entry: one mismatch fails the whole entry.
    expect(structuredMatch({ metadata: [{ env: 'prod', tier: 'silver' }] }, withMeta)).toBe(false);
    // OR-across-entries: any satisfied entry matches.
    expect(structuredMatch({ metadata: [{ env: 'dev' }, { tier: 'gold' }] }, withMeta)).toBe(true);
    // absent key never matches.
    expect(structuredMatch({ metadata: [{ region: 'us' }] }, withMeta)).toBe(false);
  });

  it('structuredMatch: a numeric-coerced metadata value never equals the string filter (evasion closed at boundary)', () => {
    // Simulate a non-string activation value (only reachable if the schema boundary were bypassed):
    // strict `===` must NOT match `42 === '42'`, so the filter is never silently satisfied.
    const numericMeta = {
      ...attrs,
      request: { ...attrs.request, metadata: { route: 42 } },
    } as unknown as AttributeActivation;
    expect(structuredMatch({ metadata: [{ route: '42' }] }, numericMeta)).toBe(false);
  });
});
