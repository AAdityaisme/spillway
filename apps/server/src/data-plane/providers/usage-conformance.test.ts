import { describe, it, expect } from 'vitest';
import { computeCost, formatUsd, type CanonicalUsage, type ModelPriceRow } from '@spillway/pricing';
import { compareUsage, type UsageFixture } from '@spillway/certifier';
import { getAdapter } from './registry.js';
import type { ParsedUsage } from './types.js';

/**
 * part-3/06 layer-1 — USAGE_EXTRACTION certification. Drives each adapter's parseBody + the pricing
 * oracle against deterministic, hand-authored fixtures: the exact ParsedUsage AND the exact reconciled
 * cost. This is the billing-correctness lock — a change that mis-extracts tokens or mis-reconciles cost
 * for any provider fails here (no network, no DB). Costs derive from each fixture's mockPrices, so a
 * live repricing never breaks a contract test.
 */

/** ParsedUsage (snake, provider wire) → CanonicalUsage (camel) — mirrors reconcile.ts toCanonical. */
function toCanonical(u: ParsedUsage): CanonicalUsage {
  return {
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    cachedReadTokens: u.cached_read_tokens,
    cacheWrite5mTokens: u.cache_write_5m_tokens,
    cacheWrite1hTokens: u.cache_write_1h_tokens,
    reasoningTokens: u.reasoning_tokens,
    audioInputTokens: u.audio_input_tokens,
    audioOutputTokens: u.audio_output_tokens,
    imageInputCount: u.image_input_units,
  };
}

const base = {
  cacheWrite5mUsdPerM: null,
  cacheWrite1hUsdPerM: null,
  inputUsdPerMLong: null,
  longContextThreshold: null,
} as const;

const FIXTURES: UsageFixture[] = [
  {
    capability: 'USAGE_EXTRACTION',
    provider: 'openai',
    model: 'gpt-4o',
    // prompt_tokens INCLUDES cached → parseBody subtracts it; 800 full-rate + 200 cached.
    mockResponse: {
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 500,
        prompt_tokens_details: { cached_tokens: 200 },
      },
    },
    expectedUsage: { input_tokens: 800, output_tokens: 500, cached_read_tokens: 200 },
    mockPrices: {
      provider: 'openai',
      inputUsdPerM: '2.500000',
      outputUsdPerM: '10.000000',
      cacheReadUsdPerM: '0.250000',
      ...base,
    } as ModelPriceRow,
    expectedCostUsd: '0.007050', // 800*2.5 + 200*0.25 + 500*10, /1M
  },
  {
    capability: 'USAGE_EXTRACTION',
    provider: 'anthropic',
    model: 'claude-sonnet-4',
    // input_tokens is the post-cache full-rate portion — NEVER summed with cache tokens.
    mockResponse: {
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 900,
        cache_creation: { ephemeral_5m_input_tokens: 500, ephemeral_1h_input_tokens: 0 },
      },
    },
    expectedUsage: {
      input_tokens: 100,
      output_tokens: 50,
      cached_read_tokens: 900,
      cache_write_5m_tokens: 500,
      cache_write_1h_tokens: 0,
    },
    mockPrices: {
      provider: 'anthropic',
      inputUsdPerM: '3.000000',
      outputUsdPerM: '15.000000',
      cacheReadUsdPerM: '0.300000',
      cacheWrite5mUsdPerM: '3.750000',
      cacheWrite1hUsdPerM: '6.000000',
      inputUsdPerMLong: null,
      longContextThreshold: null,
    } as ModelPriceRow,
    expectedCostUsd: '0.003195', // 100*3 + 50*15 + 900*0.3 + 500*3.75, /1M
  },
  {
    capability: 'USAGE_EXTRACTION',
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    // Gemini prompt_tokens is the RAW TOTAL (cached INCLUDED); cost.ts subtracts cached for the text line.
    mockResponse: {
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 200,
        prompt_tokens_details: { cached_tokens: 400 },
      },
    },
    expectedUsage: { input_tokens: 1000, output_tokens: 200, cached_read_tokens: 400 },
    mockPrices: {
      provider: 'gemini',
      inputUsdPerM: '1.250000',
      outputUsdPerM: '5.000000',
      cacheReadUsdPerM: '0.312500',
      ...base,
    } as ModelPriceRow,
    expectedCostUsd: '0.001875', // (1000−400)*1.25 + 400*0.3125 + 200*5, /1M
  },
];

describe('USAGE_EXTRACTION conformance (part-3/06 layer-1)', () => {
  for (const fx of FIXTURES) {
    it(`${fx.provider}/${fx.model}: parseBody extracts the exact usage`, () => {
      const usage = getAdapter(fx.provider).parseBody(fx.mockResponse);
      expect(usage, 'parseBody returned null').not.toBeNull();
      const mismatches = compareUsage(usage as unknown as Record<string, number>, fx.expectedUsage);
      expect(mismatches, JSON.stringify(mismatches)).toEqual([]);
    });

    it(`${fx.provider}/${fx.model}: reconciles to the exact cost`, () => {
      const usage = getAdapter(fx.provider).parseBody(fx.mockResponse)!;
      const cost = computeCost(toCanonical(usage), fx.mockPrices as ModelPriceRow);
      expect(cost.costMicroUsd).not.toBeNull();
      expect(formatUsd(cost.costMicroUsd!)).toBe(fx.expectedCostUsd);
    });
  }
});
