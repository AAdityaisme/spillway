/**
 * In-process rate limiter (05-gateway-core §4). Per-instance token buckets for RPM/TPM + a live
 * parallel-in-flight gauge, keyed by virtual key. Per-instance is acceptable at v1 (matches the
 * per-instance policy cache, ADR-016); a shared-Redis limiter is the same seam as the cache swap.
 *
 * Built directly in V2 (not ported): a token bucket is simple + standard, not novel. `now` is passed
 * in so tests drive the clock deterministically without faking timers.
 */

const REFILL_WINDOW_MS = 60_000; // buckets refill one full `limit` per minute

interface Bucket {
  tokens: number;
  last: number;
}

export interface ConsumeResult {
  ok: boolean;
  retryAfterSec: number;
}

export interface RateLimiter {
  /** Consume `cost` tokens from the (key) bucket sized `limit`/min. limit<=0 → always ok. */
  consume(key: string, limit: number, cost: number, now: number): ConsumeResult;
  /** Increment the in-flight gauge if below `max`; false = at cap (no increment). */
  acquireParallel(key: string, max: number): boolean;
  releaseParallel(key: string): void;
  parallelInFlight(key: string): number;
}

class InProcessRateLimiter implements RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly parallel = new Map<string, number>();

  consume(key: string, limit: number, cost: number, now: number): ConsumeResult {
    if (limit <= 0) return { ok: true, retryAfterSec: 0 };
    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: limit, last: now };
      this.buckets.set(key, b);
    }
    // Refill proportional to elapsed time, capped at the bucket size.
    const refill = ((now - b.last) / REFILL_WINDOW_MS) * limit;
    b.tokens = Math.min(limit, b.tokens + Math.max(0, refill));
    b.last = now;

    if (b.tokens >= cost) {
      b.tokens -= cost;
      return { ok: true, retryAfterSec: 0 };
    }
    const deficit = cost - b.tokens;
    const retryAfterSec = Math.max(1, Math.ceil((deficit / limit) * (REFILL_WINDOW_MS / 1000)));
    return { ok: false, retryAfterSec };
  }

  acquireParallel(key: string, max: number): boolean {
    const cur = this.parallel.get(key) ?? 0;
    if (cur >= max) return false; // at cap — do NOT increment (no overshoot)
    this.parallel.set(key, cur + 1);
    return true;
  }

  releaseParallel(key: string): void {
    const cur = this.parallel.get(key) ?? 0;
    if (cur > 0) this.parallel.set(key, cur - 1); // never go negative on a double-release
  }

  parallelInFlight(key: string): number {
    return this.parallel.get(key) ?? 0;
  }
}

let limiter: RateLimiter = new InProcessRateLimiter();

export const getRateLimiter = (): RateLimiter => limiter;

/** Test hook (05 §11): swap the limiter (e.g. a deterministic fake). */
export function setRateLimiter(l: RateLimiter): void {
  limiter = l;
}

/** Reset to a fresh in-process limiter (test isolation). */
export function resetRateLimiter(): void {
  limiter = new InProcessRateLimiter();
}
