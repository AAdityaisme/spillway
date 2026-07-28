-- Durable claim for alert delivery. SELECT ... FOR UPDATE SKIP LOCKED only
-- protects the selecting transaction; the HTTP send happens after it commits.
-- These columns retain the claim across that boundary and automatically recover
-- alerts from a crashed worker after five minutes.
ALTER TABLE alert_events ADD COLUMN delivery_lease_id uuid;
ALTER TABLE alert_events ADD COLUMN delivery_lease_until timestamp with time zone;
CREATE INDEX alert_events_delivery_due_idx
  ON alert_events (fired_at)
  WHERE delivered_at IS NULL;
