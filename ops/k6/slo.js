import http from 'k6/http';
import { check } from 'k6';

/**
 * Ring 4 SLO load gate (part-3/05). Drives the staging gateway's cheap read paths and ENFORCES the
 * latency SLO as k6 thresholds — the run exits non-zero (fails the CI gate) if p50 > 5ms or p99 > 15ms,
 * or if the error rate exceeds 1%. Aimed at /healthz + /readyz (no upstream provider spend); point
 * BASE_URL at the staging app. Tune vus/duration for the staging instance size.
 */
const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';

export const options = {
  scenarios: {
    steady: { executor: 'constant-vus', vus: 20, duration: '30s' },
  },
  thresholds: {
    http_req_duration: ['p(50)<5', 'p(99)<15'], // milliseconds — the enforced SLO
    http_req_failed: ['rate<0.01'], // < 1% errors
  },
};

export default function () {
  const res = http.get(`${BASE_URL}/healthz`);
  check(res, { 'healthz 200': (r) => r.status === 200 });
}
