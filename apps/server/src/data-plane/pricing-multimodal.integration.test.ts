import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { computeCost } from '@spillway/pricing';
import { makeTestApp, type TestHarness } from '../../test/helpers/app.js';
import { getModelPrice } from './pricing.js';

/**
 * part-3/04 multi-modal pricing — the DB→getModelPrice→computeCost chain. Proves the new rate columns
 * (0028) are selected + normalized, and that a vision request bills the image line (no silent under-bill).
 */
describe('multi-modal getModelPrice → computeCost', () => {
  let h: TestHarness;

  beforeAll(async () => {
    h = await makeTestApp();
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    await h.adminSql`TRUNCATE model_prices, price_overrides CASCADE`;
  });

  it('surfaces the audio + image rates and a vision request bills the image line', async () => {
    await h.adminSql`INSERT INTO model_prices
      (provider, model, input_usd_per_m, output_usd_per_m, cache_read_usd_per_m,
       input_cost_per_audio_usd_per_m, input_cost_per_image_usd_per_unit,
       web_search_cost_per_query_usd, source, synced_at)
      VALUES ('openai', 'gpt-4o', 2.5, 10, 1.25, 30, 0.001, ${h.adminSql.json({ low: '0.01', medium: '0.02', high: '0.03' })}, 'litellm', now())`;

    const price = await getModelPrice(h.db, 'openai', 'gpt-4o');
    expect(price).not.toBeNull();
    expect(price!.inputCostPerImageUsdPerUnit).toBe('0.001000');
    expect(price!.webSearchCostPerQueryUsd).toEqual({ low: '0.01', medium: '0.02', high: '0.03' });

    // A vision request: 1000 text-in + 500 out + 3 image units → the image line must be non-zero.
    const cost = computeCost(
      {
        inputTokens: 1000,
        outputTokens: 500,
        cachedReadTokens: 0,
        cacheWrite5mTokens: 0,
        cacheWrite1hTokens: 0,
        reasoningTokens: 0,
        imageInputCount: 3,
      },
      price,
    );
    // text 2500+5000=7500 · image 3×1000µ=3000 → 10500
    expect(cost.costMicroUsd).toBe(10_500n);
    expect(cost.unitPrices?.image_in).toBe('0.001000');
  });

  it('a text-only request against the same priced model is unaffected (image line = 0)', async () => {
    await h.adminSql`INSERT INTO model_prices
      (provider, model, input_usd_per_m, output_usd_per_m, cache_read_usd_per_m, input_cost_per_image_usd_per_unit, source, synced_at)
      VALUES ('openai', 'gpt-4o', 2.5, 10, 1.25, 0.001, 'litellm', now())`;
    const price = await getModelPrice(h.db, 'openai', 'gpt-4o');
    const cost = computeCost(
      {
        inputTokens: 1000,
        outputTokens: 500,
        cachedReadTokens: 0,
        cacheWrite5mTokens: 0,
        cacheWrite1hTokens: 0,
        reasoningTokens: 0,
      },
      price,
    );
    expect(cost.costMicroUsd).toBe(7_500n); // no image units → no image cost
  });
});
