import type { CapabilityId } from './matrix.js';

/**
 * Fixture-based contract tests (part-3/06 §layer-1) — the per-PR certification layer that runs in the
 * `unit` vitest project (no network, no DB). A fixture is a self-contained JSON envelope; the adapter is
 * driven against it and its normalized output asserted to exact equality. This module holds the ENVELOPE
 * types + pure comparators; the adapter call lives with the adapters (apps/server), keeping this package
 * adapter-agnostic. Fixtures are hand-authored (synthetic, deterministic) OR record-only re-generated
 * against a live provider — never in CI, and never containing raw HTTP headers/secrets.
 */

/** The canonical usage fields a USAGE_EXTRACTION fixture pins (exact integer equality). */
export interface ExpectedUsage {
  input_tokens: number;
  output_tokens: number;
  cached_read_tokens: number;
  cache_write_5m_tokens?: number;
  cache_write_1h_tokens?: number;
  audio_input_tokens?: number;
  audio_output_tokens?: number;
}

/**
 * A USAGE_EXTRACTION fixture: a provider response + the exact ParsedUsage the adapter must extract + the
 * cost that response must reconcile to under `mockPrices`. `expectedCostUsd` is derived from `mockPrices`
 * (NOT the live model_prices table), so a provider repricing never breaks a contract test (part-3/06).
 */
export interface UsageFixture {
  capability: 'USAGE_EXTRACTION';
  provider: string;
  model: string;
  /** The raw upstream response body the adapter's parseBody consumes. */
  mockResponse: unknown;
  expectedUsage: ExpectedUsage;
  /** The ModelPriceRow used to reconcile — the source of truth for expectedCostUsd. */
  mockPrices: unknown;
  /** formatUsd(computeCost(...).costMicroUsd) — the exact cost this fixture must reconcile to. */
  expectedCostUsd: string;
}

/** A single field mismatch between actual and expected usage. Empty array = conformant. */
export interface UsageMismatch {
  field: string;
  expected: number;
  actual: number;
}

/** Compare an adapter's actual ParsedUsage against a fixture's expected usage (exact integer equality). */
export function compareUsage(
  actual: Record<string, number | undefined>,
  expected: ExpectedUsage,
): UsageMismatch[] {
  const out: UsageMismatch[] = [];
  for (const [field, exp] of Object.entries(expected)) {
    const act = actual[field] ?? 0;
    if (act !== (exp ?? 0)) out.push({ field, expected: exp ?? 0, actual: act });
  }
  return out;
}

/** The suite → capability mapping so the fixture-check can assert every declared cap has a suite. */
export const CAPABILITY_SUITES: Partial<Record<CapabilityId, string>> = {
  USAGE_EXTRACTION: 'usage-extraction',
};
