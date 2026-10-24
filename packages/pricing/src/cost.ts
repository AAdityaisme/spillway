import { parseUsd, formatUsd } from './money.js';

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
  // The model's real per-completion output ceiling (model_prices.max_output_tokens). Not a cost
  // input to computeCost — reconcile always bills actual usage — but the budget reservation estimator
  // (apps/server/src/data-plane/budget/reservation.ts) uses it as a tighter pre-flight hold than its
  // hardcoded guess when a request sets no max_tokens. NULL = not populated for this row.
  maxOutputTokens?: number | null;
}

export interface CostResult {
  /** Integer micro-USD, or null when price is unknown (ADR-010 — flagged, never guessed). */
  costMicroUsd: bigint | null;
  /** Per-1M unit prices actually applied, snapshotted onto the request row. */
  unitPrices: Record<string, string> | null;
  /**
   * Dimensions the model does not price but the request populated. Non-null means this cost is
   * NOT a clean catalog computation:
   *  - with a non-null costMicroUsd, the listed cache lines were billed at a derived BOUND rather
   *    than their own real rate — cache_read at the input-rate ceiling (a discount, so input never
   *    under-states it), cache_write_5m/cache_write_1h at the input rate scaled UP by the derived
   *    premium multiple for that TTL class (a premium, so input alone would under-bill it; see the
   *    CACHE_WRITE_*_CEILING_* constants and the WHY comment in computeCost for the derivation);
   *  - with a null costMicroUsd, the whole request is unpriced and awaits a re-price.
   * Reconcile snapshots this onto unit_prices so the row is self-describing and re-priceable.
   */
  unpricedDimensions: string[] | null;
}

const MICRO_PER_M = 1_000_000n;

/**
 * Derived ceilings for an unpriced cache-WRITE (creation) line (F3b, 2026-08-24). Cache write is a
 * PREMIUM over input, never a discount, so the bare input rate is a FLOOR for it, not a ceiling — see
 * the WHY comment above the cache block for the full argument. These multiples are read off the
 * model's own sibling rows in packages/pricing/data/litellm-prices.json, not invented:
 *
 *   query: every row with litellm_provider === 'anthropic' AND a `cache_creation_input_token_cost`
 *   field, comparing that field (5m TTL, the field name notwithstanding — Anthropic's default) and
 *   `cache_creation_input_token_cost_above_1hr` (1h TTL) against the row's own `input_cost_per_token`.
 *
 *   - 1h creation = 2.00x input on all 17 rows that price it: claude-haiku-4-5(-20251001),
 *     claude-3-7-sonnet-20250219, claude-sonnet-4-5(-20250929), claude-sonnet-4-6,
 *     claude-sonnet-4-20250514, claude-opus-4-1(-20250805), claude-opus-4-20250514,
 *     claude-opus-4-5(-20251101), claude-opus-4-6(-20260205), claude-opus-4-7(-20260416),
 *     claude-opus-4-8, claude-fable-5. (claude-3-haiku-20240307 at 24x and claude-3-opus-20240229 at
 *     0.4x are excluded as stale legacy-catalog outliers, not current-generation rate design.)
 *   - 5m creation = 1.25x input on every row (mod float noise, e.g. 1.2499999999999998), again except
 *     the claude-3-haiku outlier (1.2x).
 *   - claude-4-opus-20250514 and claude-4-sonnet-20250514 — the two live rows this fix targets — price
 *     5m creation at 1.25x but carry NO `cache_creation_input_token_cost_above_1hr` field at all, so a
 *     1h cache-write on either currently falls through to the F3 ceiling (1.0x, i.e. the read-side
 *     discount ceiling) and bills at exactly half of what every sibling row would charge for the same
 *     tokens.
 *
 * Applied as an exact bigint scale (num/den, rounded UP — mulDivCeil below) so the derived rate is
 * never itself the source of an under-bill, matching the "never guess, always bound, err high" rule
 * ADR-010 sets for every other unpriced dimension here.
 */
export const CACHE_WRITE_5M_CEILING_NUM = 5n;
export const CACHE_WRITE_5M_CEILING_DEN = 4n; // 1.25x input
export const CACHE_WRITE_1H_CEILING_NUM = 2n;
export const CACHE_WRITE_1H_CEILING_DEN = 1n; // 2.00x input

/** a × num/den, rounded UP (ceiling division) — so a scaled price/rate never rounds itself below the
 *  true multiple it's approximating. Exact bigint math, no float. */
function mulDivCeil(a: bigint, num: bigint, den: bigint): bigint {
  return (a * num + den - 1n) / den;
}

/** Scale a USD-per-1M price string by num/den, rounded up, rendered back to a 6dp price string. */
function scalePriceCeil(priceUsdPerM: string, num: bigint, den: bigint): string {
  return formatUsd(mulDivCeil(parseUsd(priceUsdPerM), num, den));
}

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
  // runPricing() rejects this pre-dispatch (503), so reaching here means that gate was bypassed.
  if (price === null || price.inputUsdPerM === null || price.outputUsdPerM === null) {
    return { costMicroUsd: null, unitPrices: null, unpricedDimensions: null };
  }

  // Fail-closed multi-modal guard (part-3/04): a request that USED a dimension the model doesn't price
  // must NEVER be billed as if that dimension were free — silently $0 on a real image/audio/tool/search
  // line under-meters spend + corrupts budgets. Keys off POPULATED usage (a non-zero unit count), not a
  // mere NULL column, so text-only traffic is unaffected.
  //
  // These dimensions have NO defensible upper bound derivable from the row (audio and image rates bear
  // no fixed relation to the text rates — audio is routinely dearer), so the only honest answer is
  // "unknown": null cost, usage still recorded, re-priced once the rate is added (ADR-010).
  const unbounded: string[] = [];
  if ((usage.audioInputTokens ?? 0) > 0 && (price.inputCostPerAudioUsdPerM ?? null) === null)
    unbounded.push('audio_in');
  if ((usage.audioOutputTokens ?? 0) > 0 && (price.outputCostPerAudioUsdPerM ?? null) === null)
    unbounded.push('audio_out');
  if ((usage.imageInputCount ?? 0) > 0 && (price.inputCostPerImageUsdPerUnit ?? null) === null)
    unbounded.push('image_in');
  if ((usage.imageOutputCount ?? 0) > 0 && (price.outputCostPerImageUsdPerUnit ?? null) === null)
    unbounded.push('image_out');
  if ((usage.toolSessions ?? 0) > 0 && (price.toolCostPerSessionUsd ?? null) === null)
    unbounded.push('tool_session');
  if (
    (usage.webSearchCount ?? 0) > 0 &&
    webSearchRate(price.webSearchCostPerQueryUsd, usage.webSearchContextSize) === null
  )
    unbounded.push('web_search');
  if (unbounded.length > 0) {
    return { costMicroUsd: null, unitPrices: null, unpricedDimensions: unbounded };
  }

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

  // Cache dimensions (red-team F3, re-opened 2026-08-17; corrected 2026-08-24 — F3b). 82 catalog models
  // advertise prompt caching with a NULL cache rate — xai/grok-4, chatgpt-4o-latest, the whole
  // gpt-3.5/gpt-4-turbo family — and OpenAI applies prompt caching server-side automatically at ≥1024
  // tokens with no opt-in. So cachedReadTokens > 0 arrives on ORDINARY traffic for those models; this
  // is not a crafted attack.
  //
  // The adapter has already subtracted those tokens off the full-rate input line (Gemini's above) so
  // they can bill at their own rate. Leaving the rate NULL bills them NOTHING. Returning null instead
  // — an earlier fix — did not help either: reconcile coalesced that null to '0', so real spend still
  // metered as $0 and an `enforce` budget never approached its cap.
  //
  // READ and WRITE are NOT the same direction, and F3b is what happens when they're treated as one:
  //  - Cache READ (a hit) is a DISCOUNT on input — no provider charges more for a cache hit than for
  //    the same tokens uncached. So the effective input rate is a true CEILING for an unpriced read
  //    line: bill it there, and the substitution can only ever over-meter.
  //  - Cache WRITE (creation) is the opposite: a PREMIUM over input for the privilege of populating the
  //    cache. Every Anthropic catalog row that prices it charges MORE than input — 1.25x for a 5m TTL,
  //    2.00x for a 1h TTL (CACHE_WRITE_*_CEILING_* above; derivation and catalog evidence there). So the
  //    input rate is a FLOOR for a write line, not a ceiling — substituting it under-bills, in exactly
  //    the direction this whole fail-closed design exists to prevent. Two live catalog rows
  //    (claude-4-opus-20250514, claude-4-sonnet-20250514) price 5m creation but not 1h creation, so an
  //    unpriced 1h write on either of them is real, current traffic, not a hypothetical.
  // An unpriced write line therefore bills at the input rate scaled UP by its TTL class's derived
  // multiple, not at the bare input rate. Both directions are DERIVED from the row (ADR-010 forbids
  // guessing a price, not bounding one) and both err toward OVER-metering, the safe direction for a
  // hard cap. The substitution is reported in unpricedDimensions so a statement can say the line is a
  // bound rather than a quote, and re-price it when the real rate lands.
  const ceilingRate = inputPrice ?? price.inputUsdPerM;
  const cacheCeilinged: string[] = [];
  const cacheReadPrice = ((): string | null => {
    if (usage.cachedReadTokens <= 0 || price.cacheReadUsdPerM !== null)
      return price.cacheReadUsdPerM;
    cacheCeilinged.push('cache_read');
    return ceilingRate; // discount ⇒ input rate is a true ceiling, no scaling
  })();
  const cacheWritePrice = (
    rate: string | null,
    tokens: number,
    key: string,
    ceilNum: bigint,
    ceilDen: bigint,
  ): string | null => {
    if (tokens <= 0 || rate !== null) return rate;
    cacheCeilinged.push(key);
    return scalePriceCeil(ceilingRate, ceilNum, ceilDen); // premium ⇒ scale the ceiling up
  };
  const cacheWrite5mPrice = cacheWritePrice(
    price.cacheWrite5mUsdPerM,
    usage.cacheWrite5mTokens,
    'cache_write_5m',
    CACHE_WRITE_5M_CEILING_NUM,
    CACHE_WRITE_5M_CEILING_DEN,
  );
  const cacheWrite1hPrice = cacheWritePrice(
    price.cacheWrite1hUsdPerM,
    usage.cacheWrite1hTokens,
    'cache_write_1h',
    CACHE_WRITE_1H_CEILING_NUM,
    CACHE_WRITE_1H_CEILING_DEN,
  );

  let costMicroUsd =
    applyMultiplier(lineCost(fullRateInput, inputPrice), mult) +
    lineCost(usage.cachedReadTokens, cacheReadPrice) +
    lineCost(usage.cacheWrite5mTokens, cacheWrite5mPrice) +
    lineCost(usage.cacheWrite1hTokens, cacheWrite1hPrice) +
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
  // Snapshot the EFFECTIVE cache rates — i.e. the ceiling substitution when one was applied — so the
  // stored row reproduces the exact cost it was billed. `unpriced_dimensions` below is what marks
  // which of these are a bound rather than a catalog rate.
  if (cacheReadPrice !== null) unitPrices.cache_read = cacheReadPrice;
  if (cacheWrite5mPrice !== null) unitPrices.cache_write_5m = cacheWrite5mPrice;
  if (cacheWrite1hPrice !== null) unitPrices.cache_write_1h = cacheWrite1hPrice;
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
  if (cacheCeilinged.length > 0) unitPrices.unpriced_dimensions = cacheCeilinged.join(',');

  return {
    costMicroUsd,
    unitPrices,
    unpricedDimensions: cacheCeilinged.length > 0 ? cacheCeilinged : null,
  };
}
