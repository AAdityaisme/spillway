import { describe, it, expect } from 'vitest';
import { planWithinBudget, runCapability, isTransient, type PlannedCall } from './smoke.js';

/**
 * part-3/06 smoke-runner orchestration — the runaway-spend guard + transient-flake handling, verified
 * without network. A loop bug or an expensive model must never blow the per-run cap; a provider overload
 * must never forge a capability regression.
 */
describe('planWithinBudget', () => {
  const call = (capability: string, estimatedCostUsd: number): PlannedCall =>
    ({ capability, model: 'm', estimatedCostUsd }) as PlannedCall;

  it('runs calls until the accumulated estimate would exceed the cap, then skips the rest', () => {
    const plan = planWithinBudget([call('A', 0.04), call('B', 0.04), call('C', 0.04)], 0.1);
    expect(plan.map((p) => p.run)).toEqual([true, true, false]); // 0.04+0.04=0.08 ok; +0.04=0.12 > 0.10
  });

  it('skips a single call whose estimate alone exceeds the whole cap (never fired)', () => {
    const plan = planWithinBudget([call('big', 0.26), call('small', 0.01)], 0.1);
    expect(plan[0]!.run).toBe(false); // 0.26 > 0.10 → skip, never spend
    expect(plan[1]!.run).toBe(true); // budget untouched → the cheap one still runs
  });
});

describe('runCapability', () => {
  const planned = {
    call: { capability: 'CHAT_NONSTREAM', model: 'm', estimatedCostUsd: 0.01 } as PlannedCall,
    run: true,
  };

  it('SKIPPED_BUDGET when the planner marked the call not-to-run (never calls the provider)', async () => {
    let called = false;
    const r = await runCapability({ ...planned, run: false }, 'openai', async () => {
      called = true;
      return { ok: true, status: 200, costUsd: 0 };
    });
    expect(r.status).toBe('SKIPPED_BUDGET');
    expect(called).toBe(false);
  });

  it('PASS on a successful call', async () => {
    const r = await runCapability(planned, 'openai', async () => ({
      ok: true,
      status: 200,
      costUsd: 0.008,
    }));
    expect(r.status).toBe('PASS');
    expect(r.costUsd).toBe(0.008);
  });

  it('FAIL on a non-transient error (a real regression)', async () => {
    const r = await runCapability(planned, 'openai', async () => ({
      ok: false,
      status: 400,
      error: 'bad',
    }));
    expect(r.status).toBe('FAIL');
    expect(r.errorDetail).toBe('bad');
  });

  it('SKIPPED_TRANSIENT after a retried 429 (overload ≠ regression)', async () => {
    let attempts = 0;
    const r = await runCapability(planned, 'openai', async () => {
      attempts++;
      return { ok: false, status: 429 };
    });
    expect(r.status).toBe('SKIPPED_TRANSIENT');
    expect(attempts).toBe(2); // one retry
  });

  it('isTransient classifies 429 + 5xx, not 4xx', () => {
    expect(isTransient(429)).toBe(true);
    expect(isTransient(503)).toBe(true);
    expect(isTransient(400)).toBe(false);
  });
});
