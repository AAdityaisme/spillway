-- Part III model registry (part-3/02) — data-driven model identity / capability / lifecycle / residency.
-- Two GLOBAL reference tables (no org_id, no RLS — the model_prices precedent). Per the synthesis-memo
-- Conflict-1 resolution, the registry owns "what exists + what it can do"; PRICING stays on the live
-- model_prices table (the chapter's model_pricing_profiles is intentionally NOT built — the versioned
-- price ledger is the separate pricing-platform chapter). Adding/retiring a model becomes a migration.

CREATE TABLE model_registry (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_id          text NOT NULL UNIQUE,            -- 'openai/gpt-4o' (public-facing id)
  provider_model_id     text NOT NULL,                   -- 'gpt-4o' (sent upstream; joins model_prices.model)
  provider              text NOT NULL,
  deployment_variant    text,
  region                text NOT NULL DEFAULT 'global',
  lifecycle             text NOT NULL DEFAULT 'experimental',
  context_window        integer,
  max_output_tokens     integer,
  cap_streaming         boolean,
  cap_tools             boolean,
  cap_structured_output       boolean,
  cap_vision            boolean,
  cap_audio_input       boolean,
  cap_audio_output      boolean,
  cap_embeddings        boolean,
  cap_batch             boolean,
  cap_reasoning         boolean,
  cap_prompt_cache      boolean,
  routing_eligible      boolean NOT NULL DEFAULT false,
  fallback_eligible     boolean NOT NULL DEFAULT false,
  residency_class       text NOT NULL DEFAULT 'global',
  deprecation_date      text,
  source                text NOT NULL DEFAULT 'manual',
  synced_at             timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT model_registry_lifecycle_chk CHECK (lifecycle IN ('experimental','beta','production','disabled')),
  CONSTRAINT model_registry_residency_chk CHECK (residency_class IN ('global','us_only','eu_only','fedramp','hipaa_eligible')),
  CONSTRAINT model_registry_source_chk CHECK (source IN ('litellm','openrouter_sync','manual')),
  -- A production model MUST have its full capability matrix + limits filled (no NULL "unknowns" in the pool).
  CONSTRAINT model_registry_production_caps_chk CHECK (
    lifecycle != 'production' OR (
      cap_streaming IS NOT NULL AND cap_tools IS NOT NULL AND cap_structured_output IS NOT NULL AND
      cap_vision IS NOT NULL AND cap_audio_input IS NOT NULL AND cap_audio_output IS NOT NULL AND
      cap_embeddings IS NOT NULL AND cap_batch IS NOT NULL AND cap_reasoning IS NOT NULL AND
      cap_prompt_cache IS NOT NULL AND context_window IS NOT NULL AND max_output_tokens IS NOT NULL
    )
  )
);
CREATE INDEX model_registry_provider_idx ON model_registry (provider);
CREATE INDEX model_registry_routing_idx ON model_registry (routing_eligible) WHERE routing_eligible = true;

CREATE TABLE model_registry_params (
  registry_id           uuid NOT NULL REFERENCES model_registry (id) ON DELETE CASCADE,
  param_name            text NOT NULL,
  translation_key       text,                            -- provider-side name if different; NULL = pass through
  translation_value     jsonb,                           -- static override injected when absent
  drop_on_unsupported   boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (registry_id, param_name)
);

-- The routing-facing view: registry joined to its live model_prices row, active models only. Routing
-- reads routing_eligible/cap_*/residency_class here; pricing columns come from the live model_prices.
CREATE VIEW v_model_registry_active AS
SELECT r.*,
       p.input_usd_per_m,
       p.output_usd_per_m,
       p.cache_read_usd_per_m
  FROM model_registry r
  LEFT JOIN model_prices p
    ON p.provider = r.provider AND p.model = r.provider_model_id
 WHERE r.lifecycle != 'disabled';

-- Residency ENFORCEMENT INPUT — ships in the SAME window as residency_class (part-3/02: without the input
-- the residency spec is inert). NULL on a key inherits the org default; the routing gate is fail-CLOSED.
ALTER TABLE virtual_keys ADD COLUMN compliance_class text;
ALTER TABLE orgs ADD COLUMN default_compliance_class text NOT NULL DEFAULT 'none';

-- Grants: app reads (routing), the sync job owns writes. Global tables → no RLS (model_prices precedent).
GRANT SELECT ON model_registry, model_registry_params, v_model_registry_active TO spillway_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON model_registry, model_registry_params TO spillway_jobs;
GRANT SELECT ON v_model_registry_active TO spillway_jobs;
