import { describe, it, expect, vi, beforeEach } from 'vitest';
import { checkPolicyCacheSingleton, policyCacheSingletonGauge } from './singleton-guard.js';

describe('policy-cache singleton startup guard (17 §3.6, B1.3)', () => {
  beforeEach(() => {
    policyCacheSingletonGauge.violated = 0;
  });

  it('is silent + gauge 0 at a single instance', () => {
    const warn = vi.fn();
    const fired = checkPolicyCacheSingleton(1, { warn });
    expect(fired).toBe(false);
    expect(warn).not.toHaveBeenCalled();
    expect(policyCacheSingletonGauge.violated).toBe(0);
  });

  it('warns + sets gauge 1 when instance count > 1', () => {
    const warn = vi.fn();
    const fired = checkPolicyCacheSingleton(3, { warn });
    expect(fired).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatchObject({
      instanceCount: 3,
      metric: 'spillway_policy_cache_singleton_violated',
    });
    expect(policyCacheSingletonGauge.violated).toBe(1);
  });
});
