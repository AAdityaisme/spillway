import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { registry } from './metrics.js';
import { runRateLimit } from '../data-plane/pipeline/ratelimit.js';
import { resetRateLimiter } from '../data-plane/ratelimit/limiter.js';
import { runAuth, policyCache, type PolicyBundle } from '../data-plane/pipeline/auth.js';
import type { PipelineContext } from '../data-plane/pipeline/context.js';

/**
 * End-to-end producer coverage: drives the REAL pipeline seams (not the helpers directly) and
 * asserts the catalog metric moved with the right labels. Covers the two request-path families whose
 * producers sit in pure/sync stages reachable without Postgres or a provider socket: RATELIMIT
 * (blocks_total + requests_total) and AUTH (policy_cache hits/misses). The DB/stream-bound producers
 * (reconcile, sse-tee, dispatch) are covered through their helper seams in metrics.test.ts.
 */

interface Sample {
  value: number;
  labels: Record<string, string | number>;
  metricName?: string;
}

async function counter(name: string, labels: Record<string, string> = {}): Promise<number> {
  const all = await registry.getMetricsAsJSON();
  const m = all.find((x) => x.name === name) as { values?: Sample[] } | undefined;
  return (m?.values ?? [])
    .filter((s) => s.metricName === undefined || s.metricName === name)
    .filter((s) => Object.entries(labels).every(([k, v]) => String(s.labels[k]) === v))
    .reduce((sum, s) => sum + s.value, 0);
}

describe('RATELIMIT seam → blocks_total + requests_total', () => {
  it('records a rate_limited block when the RPM bucket is exhausted', async () => {
    resetRateLimiter();
    const ctx = {
      policy: { rpmLimit: 1, tpmLimit: null, maxParallel: 32, virtualKeyId: 'vk-prod-rl' },
      estimatedInputTokens: 1,
      endpoint: 'chat_completions',
      parallelAcquired: false,
    } as unknown as PipelineContext;

    // First request consumes the single RPM token (no block).
    runRateLimit(ctx, 1000);

    const blocks0 = await counter('spillway_blocks_total', {
      reason: 'rate_limited',
      scope_type: 'virtual_key',
    });
    const reqs0 = await counter('spillway_requests_total', {
      status: 'rate_limited',
      provider: 'unknown',
      model: 'unknown',
      endpoint: 'chat_completions',
    });

    // Second request at the same clock finds the bucket empty → 429.
    expect(() => runRateLimit(ctx, 1000)).toThrow(/rate limit/i);

    expect(
      await counter('spillway_blocks_total', {
        reason: 'rate_limited',
        scope_type: 'virtual_key',
      }),
    ).toBe(blocks0 + 1);
    expect(
      await counter('spillway_requests_total', {
        status: 'rate_limited',
        provider: 'unknown',
        model: 'unknown',
        endpoint: 'chat_completions',
      }),
    ).toBe(reqs0 + 1);
  });
});

describe('AUTH seam → policy_cache hits/misses', () => {
  const hashHex = (raw: string): string => createHash('sha256').update(raw, 'utf8').digest('hex');

  it('increments the miss counter when the key is not cached', async () => {
    const misses0 = await counter('spillway_policy_cache_misses_total');
    const ctx = {
      req: { headers: { authorization: 'Bearer mk-unit-miss' }, log: { error() {} } },
      deps: { db: undefined, conditionEvaluator: {} },
    } as unknown as PipelineContext;

    // No DB behind the miss → the bundle load fails and runAuth throws 503, but the MISS is counted
    // first (the producer sits before the load), which is exactly what this asserts.
    await expect(runAuth(ctx)).rejects.toBeTruthy();
    expect(await counter('spillway_policy_cache_misses_total')).toBe(misses0 + 1);
  });

  it('increments the hit counter when the bundle is already cached', async () => {
    const raw = 'mk-unit-hit';
    policyCache.set(hashHex(raw), {
      keyStatus: 'active',
      expiresAt: null,
      orgId: 'org-hit',
      virtualKeyId: 'vk-hit',
    } as unknown as PolicyBundle);

    const hits0 = await counter('spillway_policy_cache_hits_total');
    const ctx = {
      req: { headers: { authorization: `Bearer ${raw}` } },
      deps: {},
    } as unknown as PipelineContext;

    await runAuth(ctx);

    expect(await counter('spillway_policy_cache_hits_total')).toBe(hits0 + 1);
    expect(ctx.policy).toBeDefined();
  });
});
