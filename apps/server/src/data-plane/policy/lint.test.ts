import { describe, it, expect } from 'vitest';
import { lintConfig, type RoutingRuleLint, type PolicyLint, type Target } from './lint.js';
import type { MatchSpec } from './guardrail-types.js';

const rule = (id: string, priority: number, match: MatchSpec): RoutingRuleLint => ({
  id,
  priority,
  match,
  enabled: true,
});
const policy = (id: string, conditionCost: number | null): PolicyLint => ({
  id,
  conditionCost,
  enabled: true,
});
/** An enabled, enforcing, unconditional deny scoped to `match`. */
const deny = (id: string, match: MatchSpec): PolicyLint => ({
  id,
  conditionCost: null,
  enabled: true,
  effect: 'deny',
  enforcement: 'enforce',
  match,
  conditionCel: null,
});
const routesTo = (id: string, targets: Target[]): RoutingRuleLint => ({
  id,
  priority: 100,
  match: {},
  enabled: true,
  targets,
});

describe('policy lint (16 §9.1)', () => {
  it('L1: a wildcard higher-priority rule makes a later specific rule unreachable', () => {
    const findings = lintConfig(
      [rule('r-wild', 1, {}), rule('r-narrow', 2, { models: ['gpt-4o'] })],
      [],
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ rule: 'L1', severity: 'warn', subjectIds: ['r-narrow'] });
  });

  it('L2: two rules with equal match scope → the lower-priority one is a shadowed priority', () => {
    const findings = lintConfig(
      [rule('r-a', 1, { models: ['gpt-4o'] }), rule('r-b', 2, { models: ['gpt-4o'] })],
      [],
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ rule: 'L2', severity: 'warn', subjectIds: ['r-b'] });
  });

  it('does not flag genuinely disjoint rules', () => {
    expect(
      lintConfig(
        [rule('r-a', 1, { models: ['gpt-4o'] }), rule('r-b', 2, { models: ['claude-3'] })],
        [],
      ),
    ).toEqual([]);
  });

  it('L5: a CEL cost over the 200 budget is an error', () => {
    const findings = lintConfig(
      [],
      [policy('p-hot', 250), policy('p-ok', 50), policy('p-null', null)],
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ rule: 'L5', severity: 'error', subjectIds: ['p-hot'] });
  });

  it('flags each shadowed rule at most once (its first container) and skips disabled rules', () => {
    const findings = lintConfig(
      [
        rule('r-wild', 1, {}),
        rule('r-mid', 2, {}),
        { ...rule('r-off', 3, { models: ['x'] }), enabled: false },
      ],
      [],
    );
    // r-mid shadowed by r-wild (one finding); r-off disabled → skipped.
    expect(findings.map((f) => f.subjectIds[0])).toEqual(['r-mid']);
  });

  describe('L3 — guardrail-vs-routing conflict', () => {
    it('flags a rewrite target an enforcing model-scoped deny always blocks', () => {
      const findings = lintConfig(
        [routesTo('rr-1', [{ provider: 'openai', model: 'gpt-4o' }])],
        [deny('d-1', { models: ['gpt-4o'] })],
      );
      const l3 = findings.filter((f) => f.rule === 'L3');
      expect(l3).toHaveLength(1);
      expect(l3[0]).toMatchObject({ severity: 'error', subjectIds: ['rr-1', 'd-1'] });
    });

    it('flags a target under a provider-scoped deny', () => {
      const findings = lintConfig(
        [routesTo('rr-1', [{ provider: 'openai', model: 'gpt-4o' }])],
        [deny('d-1', { providers: ['openai'] })],
      );
      expect(findings.some((f) => f.rule === 'L3')).toBe(true);
    });

    it('does NOT flag when the deny is a different model/provider', () => {
      const findings = lintConfig(
        [routesTo('rr-1', [{ provider: 'openai', model: 'gpt-4o' }])],
        [deny('d-1', { models: ['claude-3'] }), deny('d-2', { providers: ['anthropic'] })],
      );
      expect(findings.some((f) => f.rule === 'L3')).toBe(false);
    });

    it('does NOT flag a CEL-conditional or shadow deny (not always-firing)', () => {
      const conditional: PolicyLint = {
        ...deny('d-cel', { models: ['gpt-4o'] }),
        conditionCel: 'x > 1',
      };
      const shadow: PolicyLint = {
        ...deny('d-shadow', { models: ['gpt-4o'] }),
        enforcement: 'shadow',
      };
      const findings = lintConfig(
        [routesTo('rr-1', [{ provider: 'openai', model: 'gpt-4o' }])],
        [conditional, shadow],
      );
      expect(findings.some((f) => f.rule === 'L3')).toBe(false);
    });
  });

  describe('L4 — alias-target-not-allowed', () => {
    it('flags an alias target on a provider with no active key', () => {
      const findings = lintConfig([], [], {
        aliases: [{ alias: 'cheap', targets: [{ provider: 'gemini', model: 'gemini-2.5-flash' }] }],
        activeProviders: ['openai', 'anthropic'],
      });
      const l4 = findings.filter((f) => f.rule === 'L4');
      expect(l4).toHaveLength(1);
      expect(l4[0]).toMatchObject({ severity: 'error', subjectIds: ['cheap'] });
    });

    it('flags an alias target an enforcing deny blocks', () => {
      const findings = lintConfig([], [deny('d-1', { models: ['gpt-4o'] })], {
        aliases: [{ alias: 'a', targets: [{ provider: 'openai', model: 'gpt-4o' }] }],
        activeProviders: ['openai'],
      });
      expect(findings.some((f) => f.rule === 'L4' && f.subjectIds.includes('d-1'))).toBe(true);
    });

    it('does NOT flag a servable, non-denied alias target', () => {
      const findings = lintConfig([], [], {
        aliases: [{ alias: 'a', targets: [{ provider: 'openai', model: 'gpt-4o' }] }],
        activeProviders: ['openai'],
      });
      expect(findings).toEqual([]);
    });
  });

  describe('L6 — spend attribute on a non-cached scope/period', () => {
    it('flags a rolling_30d spend reference (budget period, not a v1 policy attribute)', () => {
      const p: PolicyLint = {
        id: 'p-roll',
        conditionCost: 10,
        enabled: true,
        conditionCel: 'spend.org.rolling_30d.used_usd > 100.0',
      };
      const findings = lintConfig([], [p]);
      const l6 = findings.filter((f) => f.rule === 'L6');
      expect(l6).toHaveLength(1);
      expect(l6[0]).toMatchObject({ severity: 'warn', subjectIds: ['p-roll'] });
    });

    it('does NOT flag valid spend.<scope>.<period> references', () => {
      const p: PolicyLint = {
        id: 'p-ok',
        conditionCost: 10,
        enabled: true,
        conditionCel: 'spend.org.month.used_usd > 100.0 && spend.team.day.remaining_usd < 5.0',
      };
      expect(lintConfig([], [p]).some((f) => f.rule === 'L6')).toBe(false);
    });
  });
});
