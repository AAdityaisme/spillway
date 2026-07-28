-- Model-certification results (part-3/06). One row per nightly smoke run × capability × provider. The
-- /v1/models catalog reads the last passing run (within 72h) intersected with DECLARED_CAPS. Global
-- reference data (no org_id, no RLS — like model_prices). Role boundary is the security control: ONLY
-- the jobs role writes (INSERT); the app role reads (SELECT). Without this a compromised app-plane
-- connection could forge certification results and enable routing to non-certified capabilities.

CREATE TABLE certifier_results (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id       uuid NOT NULL,
  provider     text NOT NULL,
  capability   text NOT NULL,
  model        text NOT NULL,
  status       text NOT NULL CHECK (status IN ('PASS','FAIL','SKIPPED_BUDGET','SKIPPED_TRANSIENT')),
  duration_ms  integer,
  cost_usd     numeric(12, 6),
  error_detail text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX certifier_results_lookup_idx ON certifier_results (provider, capability, created_at DESC);

GRANT SELECT ON certifier_results TO spillway_app;
GRANT SELECT, INSERT ON certifier_results TO spillway_jobs;
