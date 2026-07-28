-- Row-level security policies for all org-scoped tables (03-data-model §8, ADR-004).
-- Deny-by-default: the app.current_org_id GUC is unset outside withOrg() → NULL
-- → policy expression is false → zero rows visible/mutable.
--
-- Two roles covered by policies:
--   spillway_app  — the main online request path (withOrg sets app.current_org_id)
--   spillway_jobs — background workers (cross-tenant access via targeted policies)
--
-- org_members also gets a supplemental policy on app.current_user_id so the auth
-- bootstrap can look up the member row BEFORE an org is resolved (ADR-025).
--
-- Tables without org_id (users, orgs, job_runs) are NOT covered here — they are
-- accessed by the superuser migration connection or via explicit app-layer queries.

-- ── Enable + force RLS on every org-scoped table ──────────────────────────────
ALTER TABLE org_members   ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_members   FORCE  ROW LEVEL SECURITY;

ALTER TABLE teams         ENABLE ROW LEVEL SECURITY;
ALTER TABLE teams         FORCE  ROW LEVEL SECURITY;

ALTER TABLE provider_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_keys FORCE  ROW LEVEL SECURITY;

ALTER TABLE virtual_keys  ENABLE ROW LEVEL SECURITY;
ALTER TABLE virtual_keys  FORCE  ROW LEVEL SECURITY;

ALTER TABLE admin_api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_api_keys FORCE  ROW LEVEL SECURITY;

ALTER TABLE audit_log     ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log     FORCE  ROW LEVEL SECURITY;

-- ── org_members ────────────────────────────────────────────────────────────────
-- Policy 1: standard org-isolation for the app role (withOrg path)
CREATE POLICY org_members_org_isolation ON org_members
  AS PERMISSIVE FOR ALL TO spillway_app
  USING (
    org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
    OR current_user = 'spillway_jobs'
  );

-- Policy 2: supplemental — allows the auth hook to read THIS user's own org_members
-- row before app.current_org_id is set (the bootstrap lookup that resolves which org
-- to enter). Only readable, not writable, via this path. (ADR-025)
CREATE POLICY org_members_user_bootstrap ON org_members
  AS PERMISSIVE FOR SELECT TO spillway_app
  USING (
    user_id = nullif(current_setting('app.current_user_id', true), '')
  );

-- spillway_jobs: cross-tenant read for background workers
CREATE POLICY org_members_jobs ON org_members
  AS PERMISSIVE FOR ALL TO spillway_jobs
  USING (current_user = 'spillway_jobs');

-- ── teams ──────────────────────────────────────────────────────────────────────
CREATE POLICY teams_org_isolation ON teams
  AS PERMISSIVE FOR ALL TO spillway_app
  USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

CREATE POLICY teams_jobs ON teams
  AS PERMISSIVE FOR ALL TO spillway_jobs
  USING (current_user = 'spillway_jobs');

-- ── provider_keys ──────────────────────────────────────────────────────────────
CREATE POLICY provider_keys_org_isolation ON provider_keys
  AS PERMISSIVE FOR ALL TO spillway_app
  USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

CREATE POLICY provider_keys_jobs ON provider_keys
  AS PERMISSIVE FOR ALL TO spillway_jobs
  USING (current_user = 'spillway_jobs');

-- ── virtual_keys ───────────────────────────────────────────────────────────────
CREATE POLICY virtual_keys_org_isolation ON virtual_keys
  AS PERMISSIVE FOR ALL TO spillway_app
  USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

CREATE POLICY virtual_keys_jobs ON virtual_keys
  AS PERMISSIVE FOR ALL TO spillway_jobs
  USING (current_user = 'spillway_jobs');

-- ── admin_api_keys ─────────────────────────────────────────────────────────────
CREATE POLICY admin_api_keys_org_isolation ON admin_api_keys
  AS PERMISSIVE FOR ALL TO spillway_app
  USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

CREATE POLICY admin_api_keys_jobs ON admin_api_keys
  AS PERMISSIVE FOR ALL TO spillway_jobs
  USING (current_user = 'spillway_jobs');

-- ── audit_log ──────────────────────────────────────────────────────────────────
-- audit_log is append-only (REVOKE UPDATE/DELETE in the grants migration).
-- RLS still covers SELECT so app role can only read its own org's log.
CREATE POLICY audit_log_org_isolation ON audit_log
  AS PERMISSIVE FOR ALL TO spillway_app
  USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

CREATE POLICY audit_log_jobs ON audit_log
  AS PERMISSIVE FOR ALL TO spillway_jobs
  USING (current_user = 'spillway_jobs');
