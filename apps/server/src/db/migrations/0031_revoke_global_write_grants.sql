-- Least-privilege (red-team money/isolation audit). model_registry, model_registry_params,
-- price_catalog_versions, price_catalog_snapshots, and certifier_results are GLOBAL, un-RLS'd
-- reference/ledger tables. Their creating migrations (0027/0029/0030) GRANT the online request-path
-- role (spillway_app) only SELECT, but 0001's `ALTER DEFAULT PRIVILEGES ... GRANT SELECT,INSERT,UPDATE,
-- DELETE ... TO spillway_app` had already auto-granted blanket DML on every future table (the exact leak
-- 0007 closed for model_prices/price_overrides). Because these tables have no org_id there is no RLS to
-- catch it, so the SELECT-only grant is the ONLY boundary — and it silently didn't hold.
--
-- Revoke the inherited writes so a request-path bug/injection on the app connection cannot: forge
-- model_registry rows (which drive routing candidate selection, the residency/compliance gate, and
-- pricing), tamper the immutable price-catalog ledger (breaking reproducible historical billing), or
-- forge a PASS certifier_results row (making /v1/models advertise + route to a non-certified model).
-- Writes stay with spillway_jobs (registry-sync / pricing-sync / nightly certify), unchanged.
REVOKE INSERT, UPDATE, DELETE ON
  model_registry,
  model_registry_params,
  price_catalog_versions,
  price_catalog_snapshots,
  certifier_results
FROM spillway_app;
