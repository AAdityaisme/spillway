-- Retired 2026-10-24. This migration repointed RLS policy expressions that named the two app roles from their pre-release names to spillway_app /
-- spillway_jobs. Every database built from the current migrations already has those names, so
-- this is a no-op kept only to keep the journal contiguous. Drizzle picks work by the journal's
-- `when`, never by file hash, so a database that already ran the old body is unaffected. A
-- database built from pre-release SQL must be recreated.
SELECT 1;
