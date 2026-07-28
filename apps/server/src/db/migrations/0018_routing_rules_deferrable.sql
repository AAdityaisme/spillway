-- routing_rules UNIQUE(org_id, priority) → DEFERRABLE INITIALLY DEFERRED so the reorder endpoint
-- can swap priorities within one tx without a mid-swap 23505 (03 §4 / schema.ts note). drizzle-kit
-- emits only a plain UNIQUE; 0004 created it non-deferrable — drop + re-add deferrable here.
ALTER TABLE routing_rules DROP CONSTRAINT routing_rules_org_priority_uq;
ALTER TABLE routing_rules
  ADD CONSTRAINT routing_rules_org_priority_uq
  UNIQUE (org_id, priority) DEFERRABLE INITIALLY DEFERRED;
