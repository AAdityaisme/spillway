-- Part III multi-modal pricing dimensions (part-3/04). Additive columns on BOTH live price tables (they
-- share priceColumns in schema.ts). All nullable — NULL = the dimension is not priced, so the existing
-- computeCost path is unaffected when NULL, and a POPULATED usage dimension with a NULL price fails
-- closed at runPricing (never silently $0). Audio bills per-1M-tokens; images per-UNIT; tools per
-- session; web-search per query (dict keyed by context size); regional_multipliers scales all lines.
-- The versioned price_catalog ledger (reproducibility layer) is a separate follow-up; model_prices
-- stays the live hot-path table (synthesis-memo Conflict-1).

ALTER TABLE model_prices
  ADD COLUMN output_cost_per_reasoning_usd_per_m numeric(12, 6),
  ADD COLUMN input_cost_per_audio_usd_per_m      numeric(12, 6),
  ADD COLUMN output_cost_per_audio_usd_per_m     numeric(12, 6),
  ADD COLUMN input_cost_per_image_usd_per_unit   numeric(12, 6),
  ADD COLUMN output_cost_per_image_usd_per_unit  numeric(12, 6),
  ADD COLUMN tool_cost_per_session_usd           numeric(12, 6),
  ADD COLUMN web_search_cost_per_query_usd        jsonb,
  ADD COLUMN regional_multipliers                 jsonb;

ALTER TABLE price_overrides
  ADD COLUMN output_cost_per_reasoning_usd_per_m numeric(12, 6),
  ADD COLUMN input_cost_per_audio_usd_per_m      numeric(12, 6),
  ADD COLUMN output_cost_per_audio_usd_per_m     numeric(12, 6),
  ADD COLUMN input_cost_per_image_usd_per_unit   numeric(12, 6),
  ADD COLUMN output_cost_per_image_usd_per_unit  numeric(12, 6),
  ADD COLUMN tool_cost_per_session_usd           numeric(12, 6),
  ADD COLUMN web_search_cost_per_query_usd        jsonb,
  ADD COLUMN regional_multipliers                 jsonb;
