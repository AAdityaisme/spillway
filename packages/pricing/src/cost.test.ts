import { describe, it, expect } from 'vitest';
import {
  computeCost,
  sanitizeMultiplier,
  MAX_COST_MICRO_USD,
  type CanonicalUsage,
  type ModelPriceRow,
} from './cost.js';
import { formatUsd } from './money.js';

const usage = (o: Partial<CanonicalUsage> = {}): CanonicalUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cachedReadTokens: 0,
  cacheWrite5mTokens: 0,
  cacheWrite1hTokens: 0,
  reasoningTokens: 0,
  ...o,
});

const price = (o: Partial<ModelPriceRow> = {}): ModelPriceRow => ({
  provider: 'openai',
  inputUsdPerM: '2.500000',
  outputUsdPerM: '10.000000',
  cacheReadUsdPerM: null,
  cacheWrite5mUsdPerM: null,
  cacheWrite1hUsdPerM: null,
  inputUsdPerMLong: null,
  longContextThreshold: null,
  ...o,
});

describe('computeCost', () => {
  it('openai: basic input + output', () => {
    const r = computeCost(usage({ inputTokens: 1000, outputTokens: 500 }), price());
    expect(r.costMicroUsd).toBe(7500n); // 1000*2.5/1M + 500*10/1M = $0.0075
    expect(formatUsd(r.costMicroUsd!)).toBe('0.007500');
    expect(r.unitPrices).toEqual({ in: '2.500000', out: '10.000000' });
  });

  it('openai: cached-read billed at the discounted rate, input already excludes cached', () => {
    const r = computeCost(
      usage({ inputTokens: 800, cachedReadTokens: 200, outputTokens: 500 }),
      price({ cacheReadUsdPerM: '0.250000' }),
    );
    expect(r.costMicroUsd).toBe(7050n); // 800*2.5 + 200*0.25 + 500*10, /1M
    expect(r.unitPrices?.cache_read).toBe('0.250000');
  });

  it('cache read tokens with a NULL cache rate → null cost (fail-closed, not silent $0) — F3', () => {
    // The adapter subtracted the 5000 cached tokens off the input line to bill them at the cache rate; a
    // null cache rate must NOT bill them $0 (silent under-metering). Fail closed like every other
    // dimension: populated-but-unpriced → null cost so reconcile records usage and re-prices later.
    const r = computeCost(
      usage({ inputTokens: 1000, cachedReadTokens: 5000, outputTokens: 500 }),
      price({ cacheReadUsdPerM: null }),
    );
    expect(r.costMicroUsd).toBeNull();
    expect(r.unitPrices).toBeNull();
  });

  it('cache WRITE tokens with a NULL write rate → null cost (fail-closed) — F3', () => {
    const r = computeCost(
      usage({ inputTokens: 1000, cacheWrite5mTokens: 400, outputTokens: 500 }),
      price({ cacheWrite5mUsdPerM: null }),
    );
    expect(r.costMicroUsd).toBeNull();
  });

  it('cache tokens WITH their rate still bill (guard only fires on a populated-but-unpriced dimension)', () => {
    const r = computeCost(
      usage({ inputTokens: 1000, cachedReadTokens: 5000, outputTokens: 500 }),
      price({ cacheReadUsdPerM: '1.250000' }),
    );
    expect(r.costMicroUsd).not.toBeNull(); // 1000*2.5 + 5000*1.25 + 500*10 = 13750µ
    expect(r.costMicroUsd).toBe(13750n);
  });

  it('anthropic: cache-write split (5m billed, 1h zero) + cache-read + raw input', () => {
    const r = computeCost(
      usage({
        inputTokens: 1000,
        cacheWrite5mTokens: 500,
        cacheWrite1hTokens: 0,
        cachedReadTokens: 300,
        outputTokens: 200,
      }),
      price({
        provider: 'anthropic',
        inputUsdPerM: '3.000000',
        outputUsdPerM: '15.000000',
        cacheReadUsdPerM: '0.300000',
        cacheWrite5mUsdPerM: '3.750000',
        cacheWrite1hUsdPerM: '6.000000',
      }),
    );
    // 1000*3 + 500*3.75 + 0 + 300*0.3 + 200*15, /1M = 3000+1875+0+90+3000 µ
    expect(r.costMicroUsd).toBe(7965n);
  });

  it('gemini: long-context tier keys off TOTAL input (not the non-cached portion)', () => {
    // input 250k total, 100k cached → full-rate 150k. Tier must use 250k (>200k) → long price.
    const r = computeCost(
      usage({ inputTokens: 250_000, cachedReadTokens: 100_000, outputTokens: 500 }),
      price({
        provider: 'gemini',
        inputUsdPerM: '1.250000',
        inputUsdPerMLong: '2.500000',
        longContextThreshold: 200_000,
        cacheReadUsdPerM: '0.312500',
        outputUsdPerM: '10.000000',
      }),
    );
    // 150000*2.5 (long) + 100000*0.3125 + 500*10, /1M = 375000+31250+5000 µ
    expect(r.costMicroUsd).toBe(411_250n);
    expect(r.unitPrices?.in).toBe('2.500000'); // long tier price snapshotted
  });

  it('gemini: below threshold uses the standard input price', () => {
    const r = computeCost(
      usage({ inputTokens: 100_000, cachedReadTokens: 40_000, outputTokens: 500 }),
      price({
        provider: 'gemini',
        inputUsdPerM: '1.250000',
        inputUsdPerMLong: '2.500000',
        longContextThreshold: 200_000,
        cacheReadUsdPerM: '0.312500',
      }),
    );
    // 60000*1.25 + 40000*0.3125 + 500*10, /1M = 75000+12500+5000 µ
    expect(r.costMicroUsd).toBe(92_500n);
    expect(r.unitPrices?.in).toBe('1.250000');
  });

  it('reasoning_tokens are NOT billed separately (already inside output)', () => {
    const base = usage({ inputTokens: 500, outputTokens: 1000 });
    const withReasoning = computeCost({ ...base, reasoningTokens: 400 }, price());
    const without = computeCost(base, price());
    expect(withReasoning.costMicroUsd).toBe(without.costMicroUsd);
    expect(without.costMicroUsd).toBe(11_250n); // 500*2.5 + 1000*10, /1M
  });

  it('unknown price → null cost + null unitPrices (ADR-010, never guessed)', () => {
    expect(computeCost(usage({ inputTokens: 1000 }), null)).toEqual({
      costMicroUsd: null,
      unitPrices: null,
    });
    expect(
      computeCost(usage({ inputTokens: 1000 }), price({ inputUsdPerM: null })).costMicroUsd,
    ).toBeNull();
  });

  it('zero usage → zero cost, unit prices still recorded', () => {
    const r = computeCost(usage(), price());
    expect(r.costMicroUsd).toBe(0n);
    expect(r.unitPrices).toEqual({ in: '2.500000', out: '10.000000' });
  });

  it('B8.2: total-input tier step function overrides base in/out rates', () => {
    const tiers = [
      { minInputTokens: 0, inputUsdPerM: '1.000000', outputUsdPerM: '2.000000' },
      { minInputTokens: 200_000, inputUsdPerM: '2.000000', outputUsdPerM: '4.000000' },
    ];
    const low = computeCost(usage({ inputTokens: 100_000, outputTokens: 1000 }), price({ tiers }));
    expect(low.unitPrices).toMatchObject({ in: '1.000000', out: '2.000000' });
    expect(low.costMicroUsd).toBe(102_000n); // 100000*1/1M + 1000*2/1M
    const high = computeCost(usage({ inputTokens: 300_000, outputTokens: 1000 }), price({ tiers }));
    expect(high.unitPrices).toMatchObject({ in: '2.000000', out: '4.000000' }); // higher tier
  });

  it('B8.2: service-tier multiplier scales input+output only, not cache lines', () => {
    const r = computeCost(
      usage({
        inputTokens: 1000,
        outputTokens: 500,
        cachedReadTokens: 200,
        serviceTier: 'priority',
      }),
      price({ cacheReadUsdPerM: '0.250000', serviceTierMultipliers: { priority: 2 } }),
    );
    // base in 2500 + out 5000 + cache 50; ×2 on in+out only → 5000 + 10000 + 50 (cache unchanged)
    expect(r.costMicroUsd).toBe(15_050n);
    // L45: multiplier snapshot is 6dp so audit recompute cannot drift from the recorded value.
    expect(r.unitPrices?.service_tier_multiplier).toBe('2.000000');
    // an unknown/absent service tier → no multiplier
    const plain = computeCost(usage({ inputTokens: 1000, serviceTier: 'nope' }), price());
    expect(plain.unitPrices?.service_tier_multiplier).toBeUndefined();
  });

  // ── M43: service-tier multiplier validation ───────────────────────────────────
  describe('sanitizeMultiplier (M43)', () => {
    it('accepts normal positive multipliers', () => {
      expect(sanitizeMultiplier(1.5)).toBe(1.5);
      expect(sanitizeMultiplier(1)).toBe(1);
      expect(sanitizeMultiplier(0)).toBe(0);
    });

    it('rejects negative values → default 1', () => {
      expect(sanitizeMultiplier(-1)).toBe(1);
      expect(sanitizeMultiplier(-0.5)).toBe(1);
    });

    it('rejects NaN/Infinity → default 1', () => {
      expect(sanitizeMultiplier(NaN)).toBe(1);
      expect(sanitizeMultiplier(Infinity)).toBe(1); // clamped would be 100, but Infinity is non-finite
      expect(sanitizeMultiplier(null)).toBe(1);
      expect(sanitizeMultiplier(undefined)).toBe(1);
    });

    it('clamps extreme values to 100', () => {
      expect(sanitizeMultiplier(200)).toBe(100);
      expect(sanitizeMultiplier(999)).toBe(100);
    });

    it('quantizes to 6dp (L45: snapshot matches applyMultiplier input)', () => {
      // A float like 1.5000001 should round to exactly 1.500000 at 6dp.
      expect(sanitizeMultiplier(1.5000001)).toBeCloseTo(1.5, 5);
      // Ensure the returned value has at most 6dp of precision (BigInt math is exact at 6dp).
      const v = sanitizeMultiplier(1.333333333);
      expect(v).toBe(Math.round(v * 1_000_000) / 1_000_000);
    });
  });

  it('M43: negative/invalid multiplier in serviceTierMultipliers defaults to 1 (no negative billing)', () => {
    // A bad sync write {flex: -1} must NOT produce negative cost (budget bypass / credit).
    const r = computeCost(
      usage({ inputTokens: 1000, outputTokens: 500, serviceTier: 'flex' }),
      price({ serviceTierMultipliers: { flex: -1 } }),
    );
    // sanitizeMultiplier(-1) → 1, so cost == base cost (no negative)
    expect(r.costMicroUsd).toBe(7500n);
    expect(r.unitPrices?.service_tier_multiplier).toBeUndefined(); // mult==1 → not snapshotted
  });

  it('M43: NaN multiplier from bad sync write defaults to 1', () => {
    const r = computeCost(
      usage({ inputTokens: 1000, outputTokens: 500, serviceTier: 'flex' }),
      price({ serviceTierMultipliers: { flex: NaN } }),
    );
    expect(r.costMicroUsd).toBe(7500n);
  });

  // ── M44: cost overflow clamped to numeric(14,6) max ──────────────────────────
  it('M44: computed cost is clamped to numeric(14,6) max — no DB overflow', () => {
    // $9999/M × 20 billion input tokens = 9999 * 20e9 / 1e6 = 199_980_000_000 µ > MAX (99_999_999_999_999).
    // MAX_COST_MICRO_USD = 99_999_999_999_999 µ (numeric(14,6) ceiling of $99,999,999.999999).
    const r = computeCost(
      usage({ inputTokens: 20_000_000_000, outputTokens: 0 }),
      price({ inputUsdPerM: '9999.000000' }),
    );
    expect(r.costMicroUsd).toBe(MAX_COST_MICRO_USD);
    // Just under the cap should pass through unchanged.
    const under = computeCost(
      usage({ inputTokens: 1, outputTokens: 0 }),
      price({ inputUsdPerM: '0.000001' }),
    );
    expect(under.costMicroUsd).toBe(0n); // 1 * 0.000001 / 1M < 1µ → truncated to 0
  });

  // ── M45: long-context tier honored for non-Gemini providers ──────────────────
  it('M45: openai long-context tier applies when total input exceeds threshold', () => {
    const r = computeCost(
      usage({ inputTokens: 300_000, outputTokens: 1000 }),
      price({
        provider: 'openai',
        inputUsdPerM: '2.500000',
        inputUsdPerMLong: '5.000000',
        longContextThreshold: 200_000,
        outputUsdPerM: '10.000000',
      }),
    );
    // 300000 * 5 / 1M + 1000 * 10 / 1M = 1_500_000 + 10_000 = 1_510_000 µ
    expect(r.costMicroUsd).toBe(1_510_000n);
    expect(r.unitPrices?.in).toBe('5.000000'); // long tier price snapshotted
  });

  it('M45: openai below threshold uses base price (not long)', () => {
    const r = computeCost(
      usage({ inputTokens: 100_000, outputTokens: 1000 }),
      price({
        provider: 'openai',
        inputUsdPerM: '2.500000',
        inputUsdPerMLong: '5.000000',
        longContextThreshold: 200_000,
        outputUsdPerM: '10.000000',
      }),
    );
    // 100000 * 2.5 / 1M + 1000 * 10 / 1M = 250_000 + 10_000 = 260_000 µ
    expect(r.costMicroUsd).toBe(260_000n);
    expect(r.unitPrices?.in).toBe('2.500000');
  });

  // ── L43: tier boundary and gemini-long suppression ───────────────────────────
  it('L43: tier at minInputTokens boundary (equality) selects that tier', () => {
    const tiers = [
      { minInputTokens: 0, inputUsdPerM: '1.000000', outputUsdPerM: '2.000000' },
      { minInputTokens: 200_000, inputUsdPerM: '3.000000', outputUsdPerM: '6.000000' },
    ];
    // Exactly at 200k boundary must pick the higher tier.
    const atBoundary = computeCost(
      usage({ inputTokens: 200_000, outputTokens: 0 }),
      price({ tiers }),
    );
    expect(atBoundary.unitPrices?.in).toBe('3.000000');
    // One below boundary must pick the lower tier.
    const justBelow = computeCost(
      usage({ inputTokens: 199_999, outputTokens: 0 }),
      price({ tiers }),
    );
    expect(justBelow.unitPrices?.in).toBe('1.000000');
  });

  it('L43: empty/null tiers falls through to base pricing', () => {
    const r = computeCost(usage({ inputTokens: 500_000, outputTokens: 0 }), price({ tiers: [] }));
    expect(r.unitPrices?.in).toBe('2.500000');
  });

  it('L43: a tiers match suppresses the Gemini long-context branch (tiers take precedence)', () => {
    // Gemini price with both tiers and a long-context field — tiers must win.
    const tiers = [{ minInputTokens: 0, inputUsdPerM: '1.000000', outputUsdPerM: '2.000000' }];
    const r = computeCost(
      usage({ inputTokens: 300_000, cachedReadTokens: 0, outputTokens: 0 }),
      price({
        provider: 'gemini',
        tiers,
        inputUsdPerMLong: '9.000000',
        longContextThreshold: 200_000,
      }),
    );
    expect(r.unitPrices?.in).toBe('1.000000'); // tier wins, NOT long-context
  });

  // ── L45: service_tier_multiplier snapshot is quantized ───────────────────────
  it('L45: fractional multiplier snapshot matches applyMultiplier precision', () => {
    // mult=1.5 → applied as 1_500_000/1_000_000 in BigInt; snapshot should be '1.500000'.
    const r = computeCost(
      usage({ inputTokens: 1000, outputTokens: 0, serviceTier: 'flex' }),
      price({ serviceTierMultipliers: { flex: 1.5 } }),
    );
    expect(r.unitPrices?.service_tier_multiplier).toBe('1.500000');
    // Recomputing cost from snapshot: parseUsd('1.500000') == 1_500_000µ / 1_000_000 == 1.5.
    // Assert cost matches manual computation (no drift).
    // 1000 * 2.5 / 1M = 2500 µ; ×1.5 = 3750 µ
    expect(r.costMicroUsd).toBe(3_750n);
  });
});

describe('computeCost — Part III multi-modal dimensions (part-3/04)', () => {
  it('bills audio (per-1M-token) + image (per-unit) lines ON TOP of text', () => {
    const r = computeCost(
      usage({
        inputTokens: 1000,
        outputTokens: 500,
        audioInputTokens: 1000,
        audioOutputTokens: 200,
        imageInputCount: 2,
      }),
      price({
        inputCostPerAudioUsdPerM: '30.000000',
        outputCostPerAudioUsdPerM: '60.000000',
        inputCostPerImageUsdPerUnit: '0.001000',
      }),
    );
    // text 2500+5000=7500 · audio 30000+12000=42000 · image 2×1000=2000 → 51500
    expect(r.costMicroUsd).toBe(51_500n);
    expect(r.unitPrices).toMatchObject({
      audio_in: '30.000000',
      audio_out: '60.000000',
      image_in: '0.001000',
    });
  });

  it('a POPULATED image usage with a NULL rate FAILS CLOSED (null cost, never silently $0)', () => {
    const r = computeCost(
      usage({ inputTokens: 1000, imageInputCount: 5 }), // image used, but no image rate on the model
      price(),
    );
    // Fail-closed: the whole cost is flagged unpriced (null), not under-billed to the text-only amount.
    expect(r.costMicroUsd).toBeNull();
    expect(r.unitPrices).toBeNull();
  });

  it('web-search bills per query at the request context-size rate (medium default)', () => {
    const p = price({
      webSearchCostPerQueryUsd: { low: '0.010000', medium: '0.020000', high: '0.030000' },
    });
    const high = computeCost(usage({ webSearchCount: 1, webSearchContextSize: 'high' }), p);
    expect(high.costMicroUsd).toBe(30_000n);
    const dflt = computeCost(usage({ webSearchCount: 2 }), p); // no size → medium
    expect(dflt.costMicroUsd).toBe(40_000n);
  });

  it('tool sessions bill per session', () => {
    const r = computeCost(usage({ toolSessions: 3 }), price({ toolCostPerSessionUsd: '0.030000' }));
    expect(r.costMicroUsd).toBe(90_000n); // 3 × 30000µ
  });

  it('the regional multiplier scales the WHOLE total (text + multi-modal)', () => {
    const r = computeCost(
      usage({ inputTokens: 1000, outputTokens: 500, imageInputCount: 2, region: 'eu' }),
      price({ inputCostPerImageUsdPerUnit: '0.001000', regionalMultipliers: { eu: 1.1 } }),
    );
    // (7500 + 2000) × 1.1 = 10450
    expect(r.costMicroUsd).toBe(10_450n);
    expect(r.unitPrices?.regional_multiplier).toBe('1.100000');
  });

  it('is fully backward-compatible: a text-only request is unchanged', () => {
    const r = computeCost(usage({ inputTokens: 1000, outputTokens: 500 }), price());
    expect(r.costMicroUsd).toBe(7_500n);
    expect(r.unitPrices).toEqual({ in: '2.500000', out: '10.000000' });
  });

  it('gemini: audio is subtracted from the TOTAL input text line (no double-bill)', () => {
    // Gemini inputTokens is TOTAL: 1000 = 200 cached + 300 audio + 500 text. Text bills at input rate,
    // audio at the audio rate — the 300 audio tokens must NOT also bill at the text rate.
    const r = computeCost(
      usage({ inputTokens: 1000, cachedReadTokens: 200, audioInputTokens: 300, outputTokens: 500 }),
      price({
        provider: 'gemini',
        cacheReadUsdPerM: '0.500000',
        inputCostPerAudioUsdPerM: '20.000000',
      }),
    );
    // text 500×2.5=1250 · cached 200×0.5=100 · audio 300×20=6000 · output 500×10=5000 → 12350
    expect(r.costMicroUsd).toBe(12_350n);
  });
});
