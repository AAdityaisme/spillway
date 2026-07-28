import { and, eq } from 'drizzle-orm';
import type { ModelPriceRow, PriceTier } from '@spillway/pricing';
import type { DatabaseClient } from '../db/client.js';
import { modelPrices, priceOverrides } from '../db/schema.js';

type PriceRowWithJson = Omit<
  ModelPriceRow,
  'tiers' | 'serviceTierMultipliers' | 'webSearchCostPerQueryUsd' | 'regionalMultipliers'
> & {
  tiers: unknown;
  serviceTierMultipliers: unknown;
  webSearchCostPerQueryUsd: unknown;
  regionalMultipliers: unknown;
};

function asJson<T>(value: unknown): T | null {
  if (value == null) return null;
  return (typeof value === 'string' ? JSON.parse(value) : value) as T;
}

function normalize(row: PriceRowWithJson): ModelPriceRow {
  return {
    ...row,
    tiers: asJson<PriceTier[]>(row.tiers),
    serviceTierMultipliers: asJson<Record<string, number>>(row.serviceTierMultipliers),
    webSearchCostPerQueryUsd: asJson<Record<string, string>>(row.webSearchCostPerQueryUsd),
    regionalMultipliers: asJson<Record<string, number>>(row.regionalMultipliers),
  };
}

/** The full price-row column selection for either price table (both spread the same priceColumns). */
function priceCols(t: typeof modelPrices | typeof priceOverrides) {
  return {
    provider: t.provider,
    inputUsdPerM: t.inputUsdPerM,
    outputUsdPerM: t.outputUsdPerM,
    cacheReadUsdPerM: t.cacheReadUsdPerM,
    cacheWrite5mUsdPerM: t.cacheWrite5mUsdPerM,
    cacheWrite1hUsdPerM: t.cacheWrite1hUsdPerM,
    inputUsdPerMLong: t.inputUsdPerMLong,
    longContextThreshold: t.longContextThreshold,
    tiers: t.tiers,
    serviceTierMultipliers: t.serviceTierMultipliers,
    // Part III multi-modal rates (part-3/04).
    inputCostPerAudioUsdPerM: t.inputCostPerAudioUsdPerM,
    outputCostPerAudioUsdPerM: t.outputCostPerAudioUsdPerM,
    inputCostPerImageUsdPerUnit: t.inputCostPerImageUsdPerUnit,
    outputCostPerImageUsdPerUnit: t.outputCostPerImageUsdPerUnit,
    toolCostPerSessionUsd: t.toolCostPerSessionUsd,
    webSearchCostPerQueryUsd: t.webSearchCostPerQueryUsd,
    regionalMultipliers: t.regionalMultipliers,
  };
}

/**
 * Resolve the unit-price snapshot for one dispatchable model. Overrides win over
 * the vendored model-price table. These global reference tables are deliberately
 * queried outside an org-scoped transaction.
 */
export async function getModelPrice(
  db: DatabaseClient,
  provider: string,
  model: string,
): Promise<ModelPriceRow | null> {
  const override = await db
    .select(priceCols(priceOverrides))
    .from(priceOverrides)
    .where(and(eq(priceOverrides.provider, provider), eq(priceOverrides.model, model)))
    .limit(1);
  if (override[0]) return normalize(override[0] as PriceRowWithJson);

  const price = await db
    .select(priceCols(modelPrices))
    .from(modelPrices)
    .where(and(eq(modelPrices.provider, provider), eq(modelPrices.model, model)))
    .limit(1);
  return price[0] ? normalize(price[0] as PriceRowWithJson) : null;
}
