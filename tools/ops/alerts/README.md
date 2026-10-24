# Operator alerts — config as data

The 8 operator alerts from the ops spec (12-operations §6.4), split by the tool that owns each.
Everything here is committable config; nothing contains a secret.

## Tool map

| #   | Alert                                                 | Tool                                                                                  | Where it lives                                                               |
| --- | ----------------------------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 1   | Liveness (`/healthz` down >10 min)                    | UptimeRobot                                                                           | manual, see below                                                            |
| 2   | Readiness degraded (`/readyz` pricing_age_hours > 48) | UptimeRobot keyword check                                                             | manual, see below                                                            |
| 3   | Error-rate spike (>10 error lines / 5 min)            | Axiom monitor                                                                         | `axiom-monitors.json`                                                        |
| 4   | Job failure (any `job.error`)                         | Axiom monitor                                                                         | `axiom-monitors.json`                                                        |
| 5   | pricing-sync stale >36h                               | Axiom monitor                                                                         | `axiom-monitors.json`                                                        |
| 6   | Memory >450MB (90% of 512MB VM)                       | Fly machine-metrics alert                                                             | manual, see below                                                            |
| 7   | **Spend write lost (money not metered) — CRITICAL**   | prom scrape on `spillway_spend_write_lost_total` (primary) + Axiom log match (backup) | backup in `axiom-monitors.json`; primary needs a metrics scraper (open item) |
| 8   | Circuit breaker open >60s                             | prom scrape on `spillway_circuit_breaker_open`                                        | needs a metrics scraper (open item)                                          |

## Apply

```bash
./apply-axiom.sh            # dry-run: prints the monitor bodies
AXIOM_TOKEN=... AXIOM_NOTIFIER_SLACK=... AXIOM_NOTIFIER_EMAIL=... ./apply-axiom.sh --apply
```

Prereqs (provisioning, one-time):

1. Axiom org + dataset `spillway-prod`.
2. Fly log drain: `fly logs drain create https://api.axiom.co/v1/datasets/spillway-prod/ingest --header "Authorization=Bearer xaat-..."`.
3. Two notifiers created in the Axiom UI (Slack webhook + email) — pass their ids via env when applying.

## Manual setups

**UptimeRobot (alerts 1, 2)** — free tier, 5-min interval:

- Monitor 1: HTTP GET `https://<prod-domain>/healthz`, alert after 2 consecutive failures.
- Monitor 2: HTTP keyword check on `https://<prod-domain>/readyz` — alert when the response stops containing `"status":"ok"`.

**Fly (alert 6)** — dashboard → Metrics → Alerts: `process_resident_memory_bytes > 450MB` on the `spillway` app.

## Open item — prom scrape for alerts 7 (primary) and 8

`GET /metrics` is bearer-token-protected in prod (`METRICS_TOKEN`, 12-operations §3.2), and Fly's
built-in Prometheus scraper cannot send auth headers. Until a scraper that can (Grafana Cloud free
tier, or an internal-port split) is provisioned, alert 7 runs on its Axiom log-match backup channel
— which fires on the first occurrence regardless. Do not consider alert 7 "done" until the metric
channel also pages: the backup depends on the log drain being healthy.
