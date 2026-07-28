import { sql } from 'drizzle-orm';
import type { Tx } from '../../db/tenancy.js';

/**
 * Burst heuristic (19 §3.1) — a short-window RPM spike detector evaluated INLINE in reconcile's
 * alert-eval hook (per-minute granularity the hourly anomaly job can't provide). An in-process,
 * per-virtual_key_id rolling 60-minute-bucket counter (NOT persisted — resets on restart; spend_counters'
 * daily grain is too coarse for RPM). Fires a deduped `burst` alert_event when the current minute's rpm
 * exceeds max(5× the trailing-hour average, 30) and is over 30. Standalone signal AND gate-A of the
 * anomaly_confirmed AND-gate (§3.2).
 */

const WINDOW_MINUTES = 60;
const minuteIndex = (now: Date): number => Math.floor(now.getTime() / 60_000);

export interface BurstEval {
  fire: boolean;
  currentRpm: number;
  trailingHourAvgRpm: number;
  thresholdRpm: number;
}

/**
 * In-process per-key minute-bucket RPM tracker. `record` bumps the current minute for a key, prunes
 * buckets older than the 60-minute window, and returns the burst evaluation. Memory is bounded by the
 * keys active in the last hour: a once-per-minute global sweep drops keys whose buckets have all aged
 * out (a per-record prune alone would leak idle keys forever, since nothing revisits them to evict).
 */
export class BurstTracker {
  readonly #keys = new Map<string, Map<number, number>>();
  #lastSweepIdx = -1;

  record(virtualKeyId: string, now: Date): BurstEval {
    const idx = minuteIndex(now);
    // Once-per-minute GLOBAL sweep: prune every key's stale buckets and drop keys with none left. This
    // is what actually bounds memory — a per-record prune only touches the key being recorded, so a key
    // that goes idle would otherwise keep its Map entry forever (its last bucket never ages out because
    // nothing revisits it). O(keys) but only on the first record of each UTC minute.
    if (idx !== this.#lastSweepIdx) {
      this.#lastSweepIdx = idx;
      for (const [key, b] of this.#keys) {
        for (const m of b.keys()) if (m < idx - WINDOW_MINUTES) b.delete(m);
        if (b.size === 0) this.#keys.delete(key);
      }
    }

    let buckets = this.#keys.get(virtualKeyId);
    if (!buckets) {
      buckets = new Map();
      this.#keys.set(virtualKeyId, buckets);
    }
    buckets.set(idx, (buckets.get(idx) ?? 0) + 1);
    // Prune this key's buckets strictly older than the trailing window. Keep bucket idx-WINDOW_MINUTES:
    // the trailing-hour average below sums [idx-WINDOW_MINUTES, idx-1], so deleting it would count its
    // minute as 0 and shrink the effective baseline to 59 real minutes (off-by-one).
    for (const b of buckets.keys()) if (b < idx - WINDOW_MINUTES) buckets.delete(b);

    const currentRpm = buckets.get(idx) ?? 0;
    // Trailing-hour average = the 60 minutes PRIOR to the current one, over the full 60-slot window
    // (missing minutes count as 0 — a cold-start key has a low average, so threshold falls back to 30).
    let priorSum = 0;
    for (let b = idx - WINDOW_MINUTES; b < idx; b++) priorSum += buckets.get(b) ?? 0;
    const trailingHourAvgRpm = priorSum / WINDOW_MINUTES;
    const thresholdRpm = Math.max(5 * trailingHourAvgRpm, 30);
    return {
      fire: currentRpm > thresholdRpm && currentRpm > 30,
      currentRpm,
      trailingHourAvgRpm,
      thresholdRpm,
    };
  }

  /** Number of keys currently tracked (post-sweep). Exposed for the memory-bound invariant + a gauge. */
  activeKeyCount(): number {
    return this.#keys.size;
  }
}

/** §3.1 dedupe key — once per key per UTC minute. */
export function burstDedupeKey(virtualKeyId: string, now: Date): string {
  return `burst:${virtualKeyId}:${now.toISOString().slice(0, 16)}`; // 'YYYY-MM-DDTHH:MM'
}

/**
 * Write the deduped `burst` alert_event (synthetic, alert_id NULL) under the org's RLS tx. Routes to the
 * org's `anomaly` alert channels via `payload.channels` (the delivery job reads them for alert_id-NULL
 * rows). Returns true iff a NEW event fired.
 */
export async function fireBurstEvent(
  tx: Tx,
  args: { orgId: string; virtualKeyId: string; ev: BurstEval; now: Date },
): Promise<boolean> {
  const { orgId, virtualKeyId, ev, now } = args;
  const info = (await tx.execute(sql`
    select name, key_prefix from virtual_keys where id = ${virtualKeyId}::uuid`)) as unknown as {
    name: string;
    key_prefix: string;
  }[];
  // Route to the org's anomaly-alert channels (§3.1) so the burst reaches the same destinations.
  const chans = (await tx.execute(sql`
    select channels from alerts where kind = 'anomaly' and enabled = true limit 1`)) as unknown as {
    channels: unknown;
  }[];
  const payload = {
    event_type: 'burst',
    virtual_key_id: virtualKeyId,
    virtual_key_name: info[0]?.name ?? virtualKeyId,
    key_prefix: info[0]?.key_prefix ?? '',
    current_rpm: ev.currentRpm,
    trailing_hour_avg_rpm: Math.round(ev.trailingHourAvgRpm * 100) / 100,
    threshold_rpm: Math.round(ev.thresholdRpm * 100) / 100,
    severity: 'warning' as const,
    org_id: orgId,
    fired_at: now.toISOString(),
    channels: chans[0]?.channels ?? [],
  };
  const inserted = (await tx.execute(sql`
    insert into alert_events (org_id, alert_id, fired_at, dedupe_key, payload)
    values (${orgId}::uuid, null, ${now.toISOString()}, ${burstDedupeKey(virtualKeyId, now)},
            ${JSON.stringify(payload)}::jsonb)
    on conflict (alert_id, dedupe_key) do nothing
    returning id`)) as unknown as { id: string }[];
  return inserted.length > 0;
}
