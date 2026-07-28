/**
 * Policy-cache singleton startup guard (17 §3.6). The per-key policy cache lives in-process
 * (ADR-016 LRU, 30s TTL). With more than one app instance behind the LB, a narrowing write only
 * evicts the instance that served it — other instances keep serving the stale bundle up to the TTL.
 * That's acceptable for the TTL window but must be VISIBLE, so ops knows the invariant is violated
 * until the shared-Redis cache swap lands. Guard = a boot-time warn + a gauge.
 */

import { policyCacheSingletonViolated } from '../observability/metrics.js';

/** Gauge surface: `spillway_policy_cache_singleton_violated` (0 = single instance, 1 = >1). */
export const policyCacheSingletonGauge = { violated: 0 };

interface GuardLogger {
  warn(obj: unknown, msg?: string): void;
}

/** Returns true when the guard fired (instanceCount > 1). Idempotent — safe to call at every boot. */
export function checkPolicyCacheSingleton(instanceCount: number, log: GuardLogger): boolean {
  if (instanceCount > 1) {
    policyCacheSingletonGauge.violated = 1;
    policyCacheSingletonViolated.set(1);
    log.warn(
      { instanceCount, metric: 'spillway_policy_cache_singleton_violated' },
      'policy cache is per-instance (ADR-016); running >1 instance risks stale-bundle skew up to the ' +
        'cache TTL until the shared-Redis swap (17 §3.6)',
    );
    return true;
  }
  policyCacheSingletonGauge.violated = 0;
  policyCacheSingletonViolated.set(0);
  return false;
}
