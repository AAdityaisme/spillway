import { SpillwayError } from '@spillway/shared';
import type { ModelPriceRow } from '@spillway/pricing';
import type { Candidate } from '../routing/compile.js';
import { candidateKeyOf } from '../routing/resolve.js';
import { getModelPrice } from '../pricing.js';
import type { PipelineContext } from './context.js';

/**
 * Fail closed before an upstream call when any reachable candidate cannot be
 * priced. A gateway that serves an unpriced model cannot enforce spend limits;
 * a post-response warning is not an adequate control.
 */
export async function runPricing(ctx: PipelineContext): Promise<void> {
  const candidates = new Map<string, Candidate>();
  const add = (candidate: Candidate): void => {
    candidates.set(candidateKeyOf(candidate), candidate);
  };
  for (const candidate of ctx.candidateChain) add(candidate);
  for (const candidate of ctx.routeResult.typedFallbacks.context_window) add(candidate);
  for (const candidate of ctx.routeResult.typedFallbacks.content_policy) add(candidate);

  // Every provider now has a registered adapter (registry.ts) + per-provider cost semantics
  // (packages/pricing). The gateway is no longer OpenAI-only, so the only fail-closed condition
  // here is an UNPRICED model — not a non-openai provider.
  const prices = new Map<string, ModelPriceRow>();
  for (const [key, candidate] of candidates) {
    let price;
    try {
      price = await getModelPrice(ctx.deps.db, candidate.provider, candidate.model);
    } catch (cause) {
      throw new SpillwayError('service_unavailable', 'model pricing is unavailable', {
        httpStatus: 503,
        details: { provider: candidate.provider, model: candidate.model },
        cause,
      });
    }
    if (!price || price.inputUsdPerM === null || price.outputUsdPerM === null) {
      throw new SpillwayError('service_unavailable', 'model pricing is unavailable', {
        httpStatus: 503,
        details: { provider: candidate.provider, model: candidate.model },
      });
    }
    prices.set(key, price);
  }
  ctx.priceByCandidate = prices;
}
