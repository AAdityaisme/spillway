import { describe, it, expect, vi, afterEach } from 'vitest';
import { resolveSpendCapUsd } from './certifier-smoke.js';
import { DEFAULT_SPEND_CAP_USD, planWithinBudget } from '@spillway/certifier';

describe('certifier spend cap', () => {
  afterEach(() => vi.restoreAllMocks());

  it('accepts the value nightly.yml actually sets, silently', () => {
    // Regression: '0.10' is valid and parses to 0.1, but String(0.1) === '0.1', so a round-trip
    // string comparison flagged every real nightly run as malformed (Greptile, PR #11). A warning
    // that fires on the ONLY value ever configured is a warning everyone learns to ignore.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveSpendCapUsd('0.10')).toBe(0.1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('falls back to the default when unset, silently', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveSpendCapUsd(undefined)).toBe(DEFAULT_SPEND_CAP_USD);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(['abc', '', '0.1.2', '-1', '1e3', ' 0.1', '0.1 ', 'NaN'])(
    'rejects %o loudly rather than yielding NaN',
    (raw) => {
      // The failure mode this guards: Number('abc') is NaN, and `spent > NaN` is ALWAYS false, so
      // a typo'd cap would silently disable the runaway-spend guard entirely.
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const cap = resolveSpendCapUsd(raw);
      expect(cap).toBe(DEFAULT_SPEND_CAP_USD);
      expect(Number.isNaN(cap)).toBe(false);
      expect(warn).toHaveBeenCalledOnce();
    },
  );

  it('logs nothing derived from the env value — not the value, not its length', () => {
    // "Log the bad input so the operator can see it" is a standard route for a secret into a log
    // file. This reads an arbitrary env var, so the day someone pastes a key where a number
    // belongs, an echoing warning persists it. A length is not safe either: it leaks how long the
    // secret is, and CodeQL's taint analysis correctly still flags it. The var NAME and the
    // expected FORMAT are all an operator needs.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const secretish = 'sk-live-DEADBEEFnotarealkey';
    resolveSpendCapUsd(secretish);
    const logged = warn.mock.calls.flat().join(' ');
    expect(logged).not.toContain(secretish);
    expect(logged).not.toContain(String(secretish.length));
    expect(logged).toContain('CERTIFIER_SPEND_CAP_USD'); // still actionable
  });

  it('a malformed cap can never widen the budget', () => {
    // End-to-end: whatever resolveSpendCapUsd returns for garbage must still stop the planner.
    const calls = Array.from({ length: 5 }, (_, i) => ({
      capability: `c${i}`,
      model: 'm',
      estimatedCostUsd: 0.05,
    })) as never[];
    const plan = planWithinBudget(calls, resolveSpendCapUsd('not-a-number'));
    expect(plan.filter((p) => p.run)).toHaveLength(2); // 0.05 + 0.05 fits in $0.10; the third does not
  });

  it('sums in integer micro-USD so repeated addition cannot drift', () => {
    // 0.1 + 0.2 !== 0.3 in float. Three calls at $0.1 against a $0.3 cap must all run; float
    // accumulation makes the third exceed the cap and get skipped.
    const calls = Array.from({ length: 3 }, (_, i) => ({
      capability: `c${i}`,
      model: 'm',
      estimatedCostUsd: 0.1,
    })) as never[];
    expect(planWithinBudget(calls, 0.3).filter((p) => p.run)).toHaveLength(3);
  });
});
