import { describe, it, expect, beforeEach } from 'vitest';
import { rateLimitHeaders, type SpillwayError } from '@spillway/shared';
import { runRateLimit, releaseParallel } from './ratelimit.js';
import { resetRateLimiter, getRateLimiter } from '../ratelimit/limiter.js';
import type { PipelineContext } from './context.js';

const ctx = (
  o: Partial<{
    rpmLimit: number | null;
    tpmLimit: number | null;
    maxParallel: number;
    est: number;
  }> = {},
): PipelineContext =>
  ({
    policy: {
      virtualKeyId: 'vk1',
      rpmLimit: o.rpmLimit ?? null,
      tpmLimit: o.tpmLimit ?? null,
      maxParallel: o.maxParallel ?? 32,
    },
    estimatedInputTokens: o.est ?? 0,
    parallelAcquired: false,
  }) as unknown as PipelineContext;

describe('runRateLimit (05 §4, B2.2)', () => {
  beforeEach(() => resetRateLimiter());

  it('skips RPM/TPM when null; still acquires a parallel slot', () => {
    const c = ctx();
    runRateLimit(c, 1_000);
    expect(c.parallelAcquired).toBe(true);
    expect(getRateLimiter().parallelInFlight('par:vk1')).toBe(1);
  });

  it('rpm_limit=2 → third request 429s with retry-after', () => {
    const now = 1_000_000;
    runRateLimit(ctx({ rpmLimit: 2 }), now);
    runRateLimit(ctx({ rpmLimit: 2 }), now);
    let err: SpillwayError | undefined;
    try {
      runRateLimit(ctx({ rpmLimit: 2 }), now);
    } catch (e) {
      err = e as SpillwayError;
    }
    expect(err?.code).toBe('rate_limited');
    expect(err?.httpStatus).toBe(429);
    expect(Number(rateLimitHeaders(err!)['retry-after'])).toBeGreaterThanOrEqual(1);
  });

  it('parallel overshoot bounded + no increment on reject', () => {
    runRateLimit(ctx({ maxParallel: 2 }), 1);
    runRateLimit(ctx({ maxParallel: 2 }), 1);
    expect(getRateLimiter().parallelInFlight('par:vk1')).toBe(2);
    expect(() => runRateLimit(ctx({ maxParallel: 2 }), 1)).toThrow(/rate limit/i);
    expect(getRateLimiter().parallelInFlight('par:vk1')).toBe(2); // rejected acquire did not increment
  });

  it('releaseParallel decrements + is idempotent via ctx flag', () => {
    const c = ctx({ maxParallel: 1 });
    runRateLimit(c, 1);
    expect(getRateLimiter().parallelInFlight('par:vk1')).toBe(1);
    releaseParallel(c);
    expect(getRateLimiter().parallelInFlight('par:vk1')).toBe(0);
    releaseParallel(c); // idempotent — ctx.parallelAcquired already false
    expect(getRateLimiter().parallelInFlight('par:vk1')).toBe(0);
  });

  it('enforces TPM using estimated input tokens', () => {
    const now = 5_000_000;
    runRateLimit(ctx({ tpmLimit: 10, est: 6 }), now); // 10 → 4 left
    expect(() => runRateLimit(ctx({ tpmLimit: 10, est: 6 }), now)).toThrow(/rate limit/i); // needs 6 > 4
  });
});
