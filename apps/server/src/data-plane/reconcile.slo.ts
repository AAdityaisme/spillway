/**
 * Reconcile-tx latency histogram (17 §4.6 SLO: p50 ≤ 5 ms / p99 ≤ 15 ms). Records the commit-before-
 * ack reconcile tx duration so ops dashboards + B9's load run have data. A ring buffer (bounded);
 * the hard p50/p99 gate is B9's load test — this is the instrument, not the gate.
 */

import { reconcileDurationMs } from '../observability/metrics.js';

const MAX_SAMPLES = 10_000;
const samples: number[] = [];

export function recordReconcileLatency(ms: number): void {
  samples.push(ms);
  if (samples.length > MAX_SAMPLES) samples.shift();
  reconcileDurationMs.observe(ms); // prom mirror (12-ops §6.3)
}

export function reconcilePercentile(p: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

export function reconcileSampleCount(): number {
  return samples.length;
}

export function resetReconcileSlo(): void {
  samples.length = 0;
}
