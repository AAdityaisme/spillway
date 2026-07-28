-- Retention sweeper (12-operations; 03 §grants): the jobs role deletes expired request
-- metadata cross-org. request_bodies/decision_logs/routing_config_snapshots DELETE were
-- granted in 0005/0010; requests was SELECT-only until the sweeper shipped.
GRANT DELETE ON requests TO spillway_jobs;
