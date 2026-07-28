import { readFileSync } from 'node:fs';
import type { ModelPriceRow } from './cost.js';

/**
 * Parses the vendored LiteLLM `model_prices_and_context_window.json` snapshot into
 * model_prices rows (ADR-010 pricing-sync). LiteLLM stores cost PER TOKEN; we store
 * USD-per-1M as numeric(12,6) strings (×1e6, fixed to 6 dp). The sync runner upserts
 * these (source='litellm') then re-applies price_overrides. Refreshed manually
 * (vendored snapshot → deterministic builds, no network at boot — M2 decision §10).
 */
const PROVIDER_MAP: Record<string, string> = {
  openai: 'openai',
  anthropic: 'anthropic',
  gemini: 'gemini',
};

/** cost-per-token (float) → USD-per-1M as a numeric(12,6) string; null if absent/non-numeric. */
function perM(costPerToken: unknown): string | null {
  if (typeof costPerToken !== 'number' || !Number.isFinite(costPerToken)) return null;
  return (costPerToken * 1_000_000).toFixed(6);
}
function int(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : null;
}

export interface SyncedPrice extends ModelPriceRow {
  model: string;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  source: 'litellm';
}

/** Reads the vendored snapshot shipped with this package (data/litellm-prices.json). */
export function loadVendoredSnapshot(): Record<string, Record<string, unknown>> {
  const raw = readFileSync(new URL('../data/litellm-prices.json', import.meta.url), 'utf8');
  return JSON.parse(raw) as Record<string, Record<string, unknown>>;
}

export function parseLitellmPrices(data: Record<string, Record<string, unknown>>): SyncedPrice[] {
  const rows: SyncedPrice[] = [];
  for (const [key, v] of Object.entries(data)) {
    if (v.mode !== 'chat' && v.mode !== 'embedding') continue;
    const provider = PROVIDER_MAP[v.litellm_provider as string];
    if (!provider) continue;
    const inputUsdPerM = perM(v.input_cost_per_token);
    // Embedding rows usually omit output_cost_per_token — they HAVE no output tokens. Store 0, not
    // null: computeCost/runPricing treat a null output price as "unpriceable" and would 503 every
    // /v1/embeddings request for a synced model (task #9).
    const outputUsdPerM =
      perM(v.output_cost_per_token) ?? (v.mode === 'embedding' ? '0.000000' : null);
    if (inputUsdPerM === null || outputUsdPerM === null) continue; // base prices mandatory

    // Long-context tier: input_cost_per_token_above_<N>k_tokens (e.g. 200k / 128k).
    // M45: captured for ALL providers (openai, anthropic, gemini) — computeCost now honors the
    // threshold for any provider, so storing these fields is never a no-op.
    let inputUsdPerMLong: string | null = null;
    let longContextThreshold: number | null = null;
    for (const [field, val] of Object.entries(v)) {
      const m = /^input_cost_per_token_above_(\d+)k_tokens$/.exec(field);
      if (m) {
        inputUsdPerMLong = perM(val);
        longContextThreshold = Number(m[1]) * 1000;
        break;
      }
    }

    rows.push({
      provider,
      model: key.replace(/^[^/]+\//, ''), // strip a leading 'provider/' prefix → bare model id
      inputUsdPerM,
      outputUsdPerM,
      cacheReadUsdPerM: perM(v.cache_read_input_token_cost),
      cacheWrite5mUsdPerM: perM(v.cache_creation_input_token_cost),
      cacheWrite1hUsdPerM: perM(v.cache_creation_input_token_cost_above_1hr),
      inputUsdPerMLong,
      longContextThreshold,
      contextWindow: int(v.max_input_tokens) ?? int(v.max_tokens),
      maxOutputTokens: int(v.max_output_tokens),
      source: 'litellm',
    });
  }
  return rows;
}
