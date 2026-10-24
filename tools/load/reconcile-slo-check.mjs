#!/usr/bin/env node
/**
 * Reconcile-SLO staging gate (17 §4.6: settle-tx p50 <= 5ms / p99 <= 15ms).
 *
 * Reads the spillway_reconcile_duration_ms histogram from a /metrics endpoint (or a saved
 * scrape) and estimates p50/p99 by linear interpolation within the violated bucket — the
 * standard prometheus histogram_quantile method, so the numbers match what a Grafana alert
 * would compute. Exits non-zero when either quantile violates the SLO.
 *
 * The histogram only has samples once staging serves real data-plane traffic (pilot keys).
 * Until then the gate SKIPs (exit 0) unless --require-samples is passed — pass it in the
 * deploy pipeline as soon as the staging pilot cohort is live, so an idle histogram can no
 * longer masquerade as a passing gate.
 *
 * Usage:
 *   node tools/load/reconcile-slo-check.mjs --url https://spillway-staging.fly.dev/metrics [--token $METRICS_TOKEN] [--require-samples]
 *   node tools/load/reconcile-slo-check.mjs --from-file scrape.txt
 */
const SLO = { p50: 5, p99: 15 };
const METRIC = 'spillway_reconcile_duration_ms';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : (args[i + 1] ?? true);
};
const url = flag('--url');
const fromFile = flag('--from-file');
const token = flag('--token') ?? process.env.METRICS_TOKEN ?? null;
const requireSamples = args.includes('--require-samples');

let text;
if (fromFile) {
  const { readFileSync } = await import('node:fs');
  text = readFileSync(fromFile, 'utf8');
} else if (url) {
  const res = await fetch(url, token ? { headers: { authorization: `Bearer ${token}` } } : {});
  if (!res.ok) {
    console.error(`FATAL: ${url} returned ${res.status}`);
    process.exit(2);
  }
  text = await res.text();
} else {
  console.error('Usage: reconcile-slo-check.mjs --url <metrics-url> | --from-file <scrape>');
  process.exit(2);
}

// Parse cumulative buckets: spillway_reconcile_duration_ms_bucket{le="5"} 123
const buckets = [];
let count = 0;
for (const line of text.split('\n')) {
  if (line.startsWith(`${METRIC}_bucket`)) {
    const le = /le="([^"]+)"/.exec(line)?.[1];
    const val = Number(line.trim().split(/\s+/).at(-1));
    if (le != null && Number.isFinite(val))
      buckets.push({ le: le === '+Inf' ? Infinity : Number(le), n: val });
  } else if (line.startsWith(`${METRIC}_count`)) {
    count = Number(line.trim().split(/\s+/).at(-1));
  }
}
buckets.sort((a, b) => a.le - b.le);

if (count === 0) {
  if (requireSamples) {
    console.error(
      `FAIL: ${METRIC} has zero samples but --require-samples is set (staging pilot should be generating reconcile traffic)`,
    );
    process.exit(1);
  }
  console.log(`SKIP: ${METRIC} has zero samples — no data-plane traffic on this environment yet`);
  process.exit(0);
}

/** histogram_quantile: find the bucket where cumulative count crosses q*total, interpolate. */
function quantile(q) {
  const target = q * count;
  let prevLe = 0;
  let prevN = 0;
  for (const b of buckets) {
    if (b.n >= target) {
      if (b.le === Infinity) return prevLe; // over the last finite bucket — report its bound
      const span = b.n - prevN;
      return span === 0 ? b.le : prevLe + ((target - prevN) / span) * (b.le - prevLe);
    }
    prevLe = b.le;
    prevN = b.n;
  }
  return buckets.at(-1)?.le ?? NaN;
}

const p50 = quantile(0.5);
const p99 = quantile(0.99);
const p50ok = p50 <= SLO.p50;
const p99ok = p99 <= SLO.p99;
console.log(
  `${METRIC}: samples=${count} p50=${p50.toFixed(2)}ms (SLO ${SLO.p50}) p99=${p99.toFixed(2)}ms (SLO ${SLO.p99})`,
);
if (!p50ok || !p99ok) {
  console.error(
    `FAIL: reconcile SLO violated — ${!p50ok ? `p50 ${p50.toFixed(2)}>${SLO.p50}` : ''} ${!p99ok ? `p99 ${p99.toFixed(2)}>${SLO.p99}` : ''}`.trim(),
  );
  process.exit(1);
}
console.log('PASS');
