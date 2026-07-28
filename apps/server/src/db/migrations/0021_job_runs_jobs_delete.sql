-- finishJobRun prunes finished lease rows older than 7 days (the 15s cadence writes ~5.8k
-- rows/day and the retention sweeper is not built yet); the jobs role needs DELETE for it.
GRANT DELETE ON job_runs TO spillway_jobs;
