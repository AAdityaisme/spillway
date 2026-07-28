-- Part III pricing reproducibility ledger (part-3/04). model_prices STAYS the live hot-path lookup
-- (synthesis-memo Conflict-1); this ADDITIVE append-only ledger records, per sync run, an immutable
-- snapshot of every rate so any invoice dispute re-derives cost from the exact version frozen on the
-- request row — never relying on the mutable live table. No request-row migration (catalog_version_id
-- is nullable; NULL on legacy rows). price_override_history is deferred (needs the override CRUD).

CREATE TABLE price_catalog_versions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_name       text NOT NULL,          -- 'litellm_vendored' | 'manual'
  source_url        text,
  source_commit_sha text,
  synced_at         timestamptz NOT NULL DEFAULT now(),
  effective_from    timestamptz NOT NULL DEFAULT now(),
  approval_state    text NOT NULL DEFAULT 'auto_approved'
                    CHECK (approval_state IN ('auto_approved','pending_review','approved','rejected')),
  approved_by       text REFERENCES users(id) ON DELETE SET NULL,
  notes             text
);
CREATE INDEX price_catalog_versions_synced_at_idx ON price_catalog_versions (synced_at DESC);

CREATE TABLE price_catalog_snapshots (
  catalog_version_id uuid NOT NULL REFERENCES price_catalog_versions (id) ON DELETE CASCADE,
  provider           text NOT NULL,
  model              text NOT NULL,
  input_usd_per_m    numeric(12, 6),
  output_usd_per_m   numeric(12, 6),
  cache_read_usd_per_m numeric(12, 6),
  cache_write_5m_usd_per_m numeric(12, 6),
  cache_write_1h_usd_per_m numeric(12, 6),
  input_usd_per_m_long numeric(12, 6),
  long_context_threshold integer,
  tiers jsonb,
  service_tier_multipliers jsonb,
  output_cost_per_reasoning_usd_per_m numeric(12, 6),
  input_cost_per_audio_usd_per_m      numeric(12, 6),
  output_cost_per_audio_usd_per_m     numeric(12, 6),
  input_cost_per_image_usd_per_unit   numeric(12, 6),
  output_cost_per_image_usd_per_unit  numeric(12, 6),
  tool_cost_per_session_usd           numeric(12, 6),
  web_search_cost_per_query_usd        jsonb,
  regional_multipliers                 jsonb,
  PRIMARY KEY (catalog_version_id, provider, model)
);

-- Reproducibility pointer: the catalog version whose rates priced this request (nullable/legacy-safe).
ALTER TABLE requests ADD COLUMN catalog_version_id uuid;

-- The ledger is written ONLY by the sync job; the app reads it for historical reproduction. Immutable →
-- no UPDATE/DELETE for anyone (append-only). Global reference data (no org_id, no RLS).
GRANT SELECT ON price_catalog_versions, price_catalog_snapshots TO spillway_app;
GRANT SELECT, INSERT ON price_catalog_versions, price_catalog_snapshots TO spillway_jobs;
