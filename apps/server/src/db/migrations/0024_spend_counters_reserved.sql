-- Atomic budget reservation (expanded-audit HIGH H2). Budget enforcement was a read-once-compare
-- over a stale snapshot, so N concurrent requests all read spent < limit, all passed a HARD block,
-- then all reconciled past the cap. `reserved_usd` is an in-flight HOLD: the BUDGET stage atomically
-- increments it by a conservative cost estimate inside the enforcement tx and compares
-- spent_usd + reserved_usd against the limit, so concurrent requests SEE each other's holds. The
-- hold is released at reconcile (settled to actual spent_usd) or on any pre-dispatch failure. It is
-- SEPARATE from spent_usd so the money invariant (spent_usd == SUM(request_attempts)) is preserved
-- exactly, and a crashed request that never releases only inflates reserved_usd → the budget blocks
-- slightly early (fail-safe: never overspends, never corrupts the ledger).
ALTER TABLE spend_counters ADD COLUMN reserved_usd numeric(14, 6) NOT NULL DEFAULT 0;
