# tools/insights

Offline **Savings Insights** batch job (ADR-009, 13-build-order §M5.1).

Python job that ports the classification heuristics from the reference repo's
`manual-router.js` plus the trained MLP as an _offline scorer_. It consumes
request **metadata only** (never bodies), estimates which traffic a cheaper tier
could have served, and writes `savings_insights` rows. Wired to a weekly
scheduler with a manual trigger (`POST /api/v1/orgs/:org_id/insights/trigger`).

Implemented at M5. Not in the request hot path — ever (ADR-009).
