import { parseUsd } from './money.js';

/**
 * Cost computation (Appendix D §7; ADR-010 never-guess; ADR-019(a) token semantics).
 *
 * Money flows as integer micro-USD (bigint): prices are numeric(12,6) USD-per-1M
 * strings from model_prices → parseUsd → micro-USD per 1M, then
 * cost_micro = tokens × price_micro_per_m / 1_000_000 (bigint, truncated). The
 * caller renders with formatUsd at the edge.
 *
 * CRITICAL per-provider input semantics (06-providers §6 field mapping):
 *  - openai / anthropic / openai_compat: `inputTokens` is ALREADY the full-rate
 *    portion (cache read/write live in their own fields). Bill inputTokens as-is.
 *  - gemini: `inputTokens` is the TOTAL prompt_tokens (includes cached). Bill
 *    (inputTokens − cachedReadTokens) at the input rate, and the cached portion at
 *    the cache-read rate. The long-context tier keys off the TOTAL (inputTokens).
 * reasoning_tokens are INSIDE output_tokens — never billed as a separate line.
 */

/**
 * M44: numeric(14,6) max is 99_999_999.999999 USD = 99_999_999_999_999 µUSD.
 * A computed cost that overflows this causes the DB insert to fail, losing the
 * attempt row and under-metering spend. Clamp here so the DB write always lands;
 * callers should surface this as an anomaly (audit finding M44).
 */
export const MAX_COST_MICRO_USD = 99_999_999_999_999n;
export interface CanonicalUsage {
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  reasoningTokens: number; // recorded only; already inside outputTokens
  serviceTier?: string | null; // e.g. openai 'flex' | 'priority' → a rate multiplier (20 §3)
  // Part III multi-modal dimensions (part-3/04). SEPARATE from the text token lines (a provider bills
  // audio tokens + image units on top of text), so double-counting is impossible. Absent = 0 / text-only.
  audioInputTokens?: number;
  audioOutputTokens?: number;
  imageInputCount?: number; // per-UNIT, not tokens (ADR-P3-1: image_input_units)
  imageOutputCount?: number;
  toolSessions?: number;
  webSearchCount?: number;
  webSearchContextSize?: string | null; // 'low' | 'medium' | 'high' → picks the per-query rate
  region?: string | null; // scales ALL lines by regionalMultipliers[region]
}

/** A total-input-tokens pricing tier (20 §3 step function). Highest minInputTokens ≤ total wins. */
export interface PriceTier {
  minInputTokens: number;
  inputUsdPerM: string;
  outputUsdPerM: string;
}

export interface ModelPriceRow {
  provider: string;
  inputUsdPerM: string | null;
  outputUsdPerM: string | null;
  cacheReadUsdPerM: string | null;
  cacheWrite5mUsdPerM: string | null;
  cacheWrite1hUsdPerM: string | null;
  inputUsdPerMLong: string | null; // Gemini >threshold tier
  longContextThreshold: number | null;
  tiers?: PriceTier[] | null; // total-input step function (overrides base + long tier when present)
  serviceTierMultipliers?: Record<string, number> | null; // service-tier → in/out rate multiplier
  // Part III multi-modal rates (part-3/04). All optional/nullable — NULL = the dimension is not priced.
  inputCostPerAudioUsdPerM?: string | null;
  outputCostPerAudioUsdPerM?: string | null;
  inputCostPerImageUsdPerUnit?: string | null; // per image UNIT (not per token)
  outputCostPerImageUsdPerUnit?: string | null;
  toolCostPerSessionUsd?: string | null;
  webSearchCostPerQueryUsd?: Record<string, string> | null; // { low, medium, high } USD per query
  regionalMultipliers?: Record<string, number> | null; // { region_code: multiplier } — scales ALL lines
}

export interface CostResult {
  /** Integer micro-USD, or null when price is unknown (ADR-010 — flagged, never guessed). */
  costMicroUsd: bigint | null;
  /** Per-1M unit prices actually applied, snapshotted onto the request row. */
  unitPrices: Record<string, string> | null;
}

const MICRO_PER_M = 1_000_000n;

/** tokens × (USD-per-1M as micro-USD) / 1M → micro-USD, truncated. Zero for ≤0 tokens or no price. */
function lineCost(tokens: number, priceUsdPerM: string | null): bigint {
  if (priceUsdPerM === null || tokens <= 0) return 0n;
  return (BigInt(Math.trunc(tokens)) * parseUsd(priceUsdPerM)) / MICRO_PER_M;
}

/** count × (USD-per-UNIT as micro-USD) → micro-USD, truncated. For per-image/session/query lines (NOT
 *  per-1M-tokens): the price IS the full per-unit rate, so no /1M. Zero for ≤0 count or no price. */
function unitCost(count: number, priceUsdPerUnit: string | null): bigint {
  if (priceUsdPerUnit === null || count <= 0) return 0n;
  return BigInt(Math.trunc(count)) * parseUsd(priceUsdPerUnit);
}

/** Per-query web-search rate for the request's context size ('low'|'medium'|'high'), medium-default. */
function webSearchRate(
  dict: Record<string, string> | null | undefined,
  ctxSize: string | null | undefined,
): string | null {
  if (!dict) return null;
  return dict[ctxSize ?? 'medium'] ?? dict.medium ?? null;
}

/** Highest tier whose minInputTokens ≤ total input (20 §3 step function). null → no tier applies. */
function selectTier(tiers: PriceTier[] | null | undefined, totalInput: number): PriceTier | null {
  if (!tiers || tiers.length === 0) return null;
  let best: PriceTier | null = null;
  for (const t of tiers) {
    if (
      t.minInputTokens <= totalInput &&
      (best === null || t.minInputTokens > best.minInputTokens)
    ) {
      best = t;
    }
  }
  return best;
}

/**
 * M43/L45: Validate and clamp a raw service-tier multiplier from the DB.
 * Returns a well-formed finite multiplier in [0, 100], defaulting to 1 on bad input.
 * Uses fixed 6-dp quantization so the stored snapshot and the applied math are identical
 * (L45: avoids audit-recompute drift from un-quantized float).
 */
export function sanitizeMultiplier(raw: number | null | undefined): number {
  if (raw == null || !Number.isFinite(raw) || raw < 0) return 1; // M43: reject negative/NaN/non-finite
  const clamped = Math.min(raw, 100); // M43: clamp to sane max
  // Quantize to 6 dp so applyMultiplier's BigInt math matches any later recompute (L45).
  return Math.round(clamped * 1_000_000) / 1_000_000;
}

/** Apply a service-tier float multiplier to a micro-USD line (input/output only; 20 §3). */
function applyMultiplier(micro: bigint, mult: number): bigint {
  if (mult === 1) return micro;
  // mult is already 6-dp quantized by sanitizeMultiplier; BigInt round is exact.
  return (micro * BigInt(Math.round(mult * 1_000_000))) / MICRO_PER_M;
}

export function computeCost(usage: CanonicalUsage, price: ModelPriceRow | null): CostResult {
  // Base in/out prices are mandatory; without them we record null + flag, never guess.
  if (price === null || price.inputUsdPerM === null || price.outputUsdPerM === null) {
    return { costMicroUsd: null, unitPrices: null };
  }

  // Fail-closed multi-modal guard (part-3/04): a request that USED a dimension the model doesn't price
  // must be flagged unpriced (null), NEVER billed as if the dimension were free — silently $0 on a real
  // image/audio/tool/search line under-meters spend + corrupts budgets. Keys off POPULATED usage (a
  // non-zero unit count), not a mere NULL column, so text-only traffic is unaffected. Reconcile records
  // the usage with a null cost so the request can be re-priced once the rate is added (ADR-010).
  const dimensionUnpriced =
    ((usage.audioInputTokens ?? 0) > 0 && (price.inputCostPerAudioUsdPerM ?? null) === null) ||
    ((usage.audioOutputTokens ?? 0) > 0 && (price.outputCostPerAudioUsdPerM ?? null) === null) ||
    ((usage.imageInputCount ?? 0) > 0 && (price.inputCostPerImageUsdPerUnit ?? null) === null) ||
    ((usage.imageOutputCount ?? 0) > 0 && (price.outputCostPerImageUsdPerUnit ?? null) === null) ||
    ((usage.toolSessions ?? 0) > 0 && (price.toolCostPerSessionUsd ?? null) === null) ||
    // Cache dimensions (red-team audit F3): the adapter SUBTRACTS cached tokens off the full-rate input
    // line (Gemini's subtracted below) to bill them separately at the cache rate — so a model that used
    // cache but has a NULL cache rate (28 dispatched models incl. gpt-3.5-turbo/gpt-4-turbo/chatgpt-4o-
    // latest advertise caching without a snapshot cache_read cost) would bill those tokens NOTHING, silently
    // under-metering real spend. Same fail-closed rule as every other dimension: populated-but-unpriced →
    // null cost (record usage, re-price once the rate is added), NEVER $0. Modern models (gpt-4o/4.1/5,
    // o3/o4, gemini-2.5) DO carry cache rates, so this only flags the older/niche unpriced ones.
    (usage.cachedReadTokens > 0 && (price.cacheReadUsdPerM ?? null) === null) ||
    (usage.cacheWrite5mTokens > 0 && (price.cacheWrite5mUsdPerM ?? null) === null) ||
    (usage.cacheWrite1hTokens > 0 && (price.cacheWrite1hUsdPerM ?? null) === null) ||
    ((usage.webSearchCount ?? 0) > 0 &&
      webSearchRate(price.webSearchCostPerQueryUsd, usage.webSearchContextSize) === null);
  if (dimensionUnpriced) return { costMicroUsd: null, unitPrices: null };

  const isGemini = price.provider === 'gemini';
  // Gemini: inputTokens is TOTAL (includes cached AND audio); bill only the non-cached, non-audio portion
  // at the text rate (cached bills at the cache rate, audio at the audio line below). Other providers:
  // inputTokens is already the full-rate text portion (the adapter subtracted cached + audio).
  const fullRateInput = isGemini
    ? Math.max(0, usage.inputTokens - usage.cachedReadTokens - (usage.audioInputTokens ?? 0))
    : usage.inputTokens;

  // Rate selection (20 §3): a total-input step-function tier overrides the base + long tier;
  // otherwise a long-context threshold applies when set (M45: honored for ALL providers, not just
  // Gemini — openai/anthropic models with inputUsdPerMLong must bill the stepped rate too).
  const tier = selectTier(price.tiers, usage.inputTokens);
  const useLongTier =
    tier === null &&
    price.inputUsdPerMLong !== null &&
    price.longContextThreshold !== null &&
    usage.inputTokens > price.longContextThreshold;
  const inputPrice = tier
    ? tier.inputUsdPerM
    : useLongTier
      ? price.inputUsdPerMLong
      : price.inputUsdPerM;
  const outputPrice = tier ? tier.outputUsdPerM : price.outputUsdPerM;

  // M43: sanitize multiplier (reject negative/NaN/huge, quantize to 6dp for L45 snapshot parity).
  const rawMult = usage.serviceTier
    ? (price.serviceTierMultipliers?.[usage.serviceTier] ?? null)
    : null;
  const mult = sanitizeMultiplier(rawMult ?? undefined);

  let costMicroUsd =
    applyMultiplier(lineCost(fullRateInput, inputPrice), mult) +
    lineCost(usage.cachedReadTokens, price.cacheReadUsdPerM) +
    lineCost(usage.cacheWrite5mTokens, price.cacheWrite5mUsdPerM) +
    lineCost(usage.cacheWrite1hTokens, price.cacheWrite1hUsdPerM) +
    applyMultiplier(lineCost(usage.outputTokens, outputPrice), mult);

  // Part III multi-modal lines (part-3/04) — ADDITIVE + guarded (0 when the rate is NULL). Audio bills
  // per-1M-tokens; images/tools/web-search per unit/session/query. Not service-tier-multiplied (that is
  // input+output text only); the regional multiplier below scales the whole total instead.
  costMicroUsd +=
    lineCost(usage.audioInputTokens ?? 0, price.inputCostPerAudioUsdPerM ?? null) +
    lineCost(usage.audioOutputTokens ?? 0, price.outputCostPerAudioUsdPerM ?? null) +
    unitCost(usage.imageInputCount ?? 0, price.inputCostPerImageUsdPerUnit ?? null) +
    unitCost(usage.imageOutputCount ?? 0, price.outputCostPerImageUsdPerUnit ?? null) +
    unitCost(usage.toolSessions ?? 0, price.toolCostPerSessionUsd ?? null) +
    unitCost(
      usage.webSearchCount ?? 0,
      webSearchRate(price.webSearchCostPerQueryUsd, usage.webSearchContextSize),
    );

  // Regional multiplier (part-3/04): scales ALL lines (unlike service tier, which is input+output only).
  const regionMult = usage.region
    ? sanitizeMultiplier(price.regionalMultipliers?.[usage.region])
    : 1;
  costMicroUsd = applyMultiplier(costMicroUsd, regionMult);

  // M44: clamp to numeric(14,6) max to prevent DB insert failure (overflow → lost attempt row).
  // Log-level signal is the caller's responsibility (e.g. increment a 'cost_overflow' metric).
  if (costMicroUsd > MAX_COST_MICRO_USD) {
    costMicroUsd = MAX_COST_MICRO_USD;
  }

  const unitPrices: Record<string, string> = {
    in: inputPrice ?? price.inputUsdPerM,
    out: outputPrice,
  };
  if (price.cacheReadUsdPerM !== null) unitPrices.cache_read = price.cacheReadUsdPerM;
  if (price.cacheWrite5mUsdPerM !== null) unitPrices.cache_write_5m = price.cacheWrite5mUsdPerM;
  if (price.cacheWrite1hUsdPerM !== null) unitPrices.cache_write_1h = price.cacheWrite1hUsdPerM;
  // L45: snapshot the quantized multiplier (6dp), matching what applyMultiplier actually computed.
  if (mult !== 1) unitPrices.service_tier_multiplier = mult.toFixed(6);
  // Part III: snapshot each multi-modal rate that was actually billed (a non-zero usage line), so the
  // reconcile row reproduces the exact cost. Guarded on both a populated usage dimension AND a rate.
  const snapModal = (
    key: string,
    count: number | undefined,
    rate: string | null | undefined,
  ): void => {
    if ((count ?? 0) > 0 && rate != null) unitPrices[key] = rate;
  };
  snapModal('audio_in', usage.audioInputTokens, price.inputCostPerAudioUsdPerM);
  snapModal('audio_out', usage.audioOutputTokens, price.outputCostPerAudioUsdPerM);
  snapModal('image_in', usage.imageInputCount, price.inputCostPerImageUsdPerUnit);
  snapModal('image_out', usage.imageOutputCount, price.outputCostPerImageUsdPerUnit);
  snapModal('tool_session', usage.toolSessions, price.toolCostPerSessionUsd);
  snapModal(
    'web_search',
    usage.webSearchCount,
    webSearchRate(price.webSearchCostPerQueryUsd, usage.webSearchContextSize),
  );
  if (regionMult !== 1) unitPrices.regional_multiplier = regionMult.toFixed(6);

  return { costMicroUsd, unitPrices };
}
