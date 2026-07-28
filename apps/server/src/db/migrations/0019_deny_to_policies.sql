-- ADR-034 removes `deny` from the routing action set: migrate routing_rules deny rows into
-- governance_policies (16 §10). Behavior-preserving (enforce + carried enabled/reason). Runs in the
-- migration tx. On a fresh DB this is a 0-row no-op; existing deploys carry their deny rules over.
INSERT INTO governance_policies
  (id, org_id, name, description, effect, reason, match,
   condition_cel, condition_program, condition_cost,
   enforcement, enabled, effect_config, revision, created_by, created_at, updated_at)
SELECT
  gen_random_uuid(),
  rr.org_id,
  'migrated-deny-p' || rr.priority,
  'Migrated from routing_rules deny (priority ' || rr.priority || ')',
  'deny',
  COALESCE(rr.action->>'reason', 'model_blocked_by_policy'),
  rr.match,
  NULL, NULL, NULL,
  'enforce',
  rr.enabled,
  '{}', 1, NULL, now(), now()
FROM routing_rules rr
WHERE rr.action->>'type' = 'deny';

DELETE FROM routing_rules WHERE action->>'type' = 'deny';
