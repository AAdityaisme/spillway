import { SpillwayError } from '@spillway/shared';
import { getRateLimiter } from '../ratelimit/limiter.js';
import type { PipelineContext } from './context.js';

/**
 * RATELIMIT stage (05-gateway-core §4). Order: RPM → TPM → parallel gauge. RPM/TPM are skipped when
 * their limit is null. The parallel slot is acquired LAST (so an RPM/TPM 429 never leaks a slot) and
 * set on ctx.parallelAcquired; the route's `finally` releases it (v2-code-seams §1). A 429 carries
 * retry_after in the error details → the route attaches the retry-after header (B2.4).
 */
function rateLimited(retryAfterSec: number, dimension: string): SpillwayError {
  return new SpillwayError('rate_limited', `rate limit exceeded (${dimension})`, {
    httpStatus: 429,
    details: { retry_after: retryAfterSec, dimension },
  });
}

export function runRateLimit(ctx: PipelineContext, now: number = Date.now()): void {
  const { rpmLimit, tpmLimit, maxParallel, virtualKeyId } = ctx.policy;
  const rl = getRateLimiter();

  if (rpmLimit !== null) {
    const r = rl.consume(`rpm:${virtualKeyId}`, rpmLimit, 1, now);
    if (!r.ok) throw rateLimited(r.retryAfterSec, 'rpm');
  }
  if (tpmLimit !== null) {
    const cost = Math.max(1, ctx.estimatedInputTokens);
    const r = rl.consume(`tpm:${virtualKeyId}`, tpmLimit, cost, now);
    if (!r.ok) throw rateLimited(r.retryAfterSec, 'tpm');
  }
  // Parallel gauge last — bounded, no overshoot; released in the route finally.
  if (!rl.acquireParallel(`par:${virtualKeyId}`, maxParallel)) {
    throw rateLimited(1, 'parallel');
  }
  ctx.parallelAcquired = true;
}

/** Release the in-flight slot (idempotent via ctx.parallelAcquired). Called from the route finally. */
export function releaseParallel(ctx: PipelineContext): void {
  if (!ctx.parallelAcquired) return;
  ctx.parallelAcquired = false;
  getRateLimiter().releaseParallel(`par:${ctx.policy.virtualKeyId}`);
}
