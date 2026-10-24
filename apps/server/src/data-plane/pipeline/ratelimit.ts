import { SpillwayError } from '@spillway/shared';
import { getRateLimiter } from '../ratelimit/limiter.js';
import { recordBlock, recordRequestCompletion } from '../../observability/metrics.js';
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

  // blocks_total{rate_limited} + requests_total{rate_limited} (§6.3), recorded on the block decision.
  // Rate limits are per-virtual-key (§4) → scope_type is always 'virtual_key'; no candidate was
  // served → provider/model 'unknown'. One funnel for all three dimensions (rpm/tpm/parallel).
  const blockRateLimited = (retryAfterSec: number, dimension: string): SpillwayError => {
    recordBlock('rate_limited', 'virtual_key');
    recordRequestCompletion('rate_limited', null, null, ctx.endpoint);
    return rateLimited(retryAfterSec, dimension);
  };

  if (rpmLimit !== null) {
    const r = rl.consume(`rpm:${virtualKeyId}`, rpmLimit, 1, now);
    if (!r.ok) throw blockRateLimited(r.retryAfterSec, 'rpm');
  }
  if (tpmLimit !== null) {
    const cost = Math.max(1, ctx.estimatedInputTokens);
    const r = rl.consume(`tpm:${virtualKeyId}`, tpmLimit, cost, now);
    if (!r.ok) throw blockRateLimited(r.retryAfterSec, 'tpm');
  }
  // Parallel gauge last — bounded, no overshoot; released in the route finally.
  if (!rl.acquireParallel(`par:${virtualKeyId}`, maxParallel)) {
    throw blockRateLimited(1, 'parallel');
  }
  ctx.parallelAcquired = true;
}

/** Release the in-flight slot (idempotent via ctx.parallelAcquired). Called from the route finally. */
export function releaseParallel(ctx: PipelineContext): void {
  if (!ctx.parallelAcquired) return;
  ctx.parallelAcquired = false;
  getRateLimiter().releaseParallel(`par:${ctx.policy.virtualKeyId}`);
}
