-- Data-plane AUTH bootstrap (ADR-025 sibling). The gateway resolves a virtual key by
-- sha256(key_hash) BEFORE any org is known, so it cannot arm app.current_org_id first —
-- virtual_keys' org_isolation policy would return zero rows and every key would 401.
--
-- GUC-armed form (tighter than USING(true) — red-team decision #1): the auth hook sets
-- `app.lookup_key_hash` (hex) inside a tx, and this SELECT-only policy exposes ONLY the
-- row whose key_hash matches that GUC. So spillway_app can read the single key it is
-- authenticating, but CANNOT table-scan all virtual_keys (a bare `SELECT * FROM
-- virtual_keys` with no GUC armed returns zero rows). Writes + cross-row reads still
-- require the org GUC via the existing org_isolation policy.
CREATE POLICY virtual_keys_dataplane_lookup ON virtual_keys
  AS PERMISSIVE FOR SELECT TO spillway_app
  USING (key_hash = decode(nullif(current_setting('app.lookup_key_hash', true), ''), 'hex'));
