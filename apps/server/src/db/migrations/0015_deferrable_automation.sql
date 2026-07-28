-- automation_rules UNIQUE(org_id, priority) must be DEFERRABLE INITIALLY DEFERRED so the reorder
-- endpoint can swap priorities within one tx without a mid-swap 23505 (mirrors routing_rules,
-- schema.ts note + 0018). drizzle-kit emits only a plain UNIQUE (can't express DEFERRABLE), so
-- 0013 created the non-deferrable constraint; here we drop + re-add it deferrable. drizzle's
-- snapshot still records the plain unique (it can't see DEFERRABLE) → no future generate churn.

ALTER TABLE automation_rules DROP CONSTRAINT automation_rules_org_priority_uq;
ALTER TABLE automation_rules
  ADD CONSTRAINT automation_rules_org_priority_uq
  UNIQUE (org_id, priority) DEFERRABLE INITIALLY DEFERRED;
