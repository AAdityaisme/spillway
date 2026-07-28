-- The scheduler's crash-safe lease (jobs/scheduler.ts) reads job_runs under the jobs role to
-- decide whether a run is already live; 0001 granted only INSERT/UPDATE.
GRANT SELECT ON job_runs TO spillway_jobs;
