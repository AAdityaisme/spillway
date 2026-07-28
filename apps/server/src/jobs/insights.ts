import { sql } from 'drizzle-orm';
import { parseUsd, formatUsd } from '@spillway/pricing';
import type { DatabaseClient } from '../db/client.js';
import { asJobs } from '../db/jobs.js';
import { withOrg, type Tx } from '../db/tenancy.js';
import type { RequestFeatures } from '../data-plane/pipeline/context.js';
import {
  newDowngradeAccumulator,
  accumulateDowngrades,
  finalizeDowngrades,
  type InsightRequestRow,
  type RateLookup,
} from '../services/insights/classifier.js';

/**
 * Savings-insights job (Part II §19 §8). Weekly (+ manual trigger). Per org: read the period's completed
 * requests + their `request_features`, run the HEURISTIC classifier for model-downgrade savings, annotate
 * forecast-flagged scopes (prioritized — a scope already projected to overspend is where savings matter
 * most), and write ONE `savings_insights` row per (org_id, period) ON CONFLICT DO UPDATE (idempotent
 * regenerate). Cross-org scan on the jobs role; per-org read+write under withOrg. The MLP secondary
 * classifier is a documented seam (heuristicOnly:true) — see classifier.ts.
 */

function asJson<T>(v: unknown): T {
  return (typeof v === 'string' ? JSON.parse(v) : v) as T;
}

/** 'YYYY-MM' for an instant (UTC). */
export function periodOf(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

export interface InsightsRunResult {
  period: string;
  requestsAnalyzed: number;
  suggestions: number;
  estSavingsUsd: string;
}

async function buildRateLookup(tx: Tx): Promise<RateLookup> {
  const rows = (await tx.execute(sql`
    SELECT model, input_usd_per_m::text AS rate FROM model_prices`)) as unknown as {
    model: string;
    rate: string;
  }[];
  const map = new Map<string, number>();
  for (const r of rows) map.set(r.model, Number(r.rate));
  return (model) => map.get(model) ?? null;
}

export async function runInsightsForOrg(
  db: DatabaseClient,
  orgId: string,
  now: Date,
): Promise<InsightsRunResult> {
  const period = periodOf(now);
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();

  return withOrg(db, orgId, async (tx) => {
    const rateFor = await buildRateLookup(tx);

    // Stream the month's requests in keyset-paginated batches into a bounded accumulator — the `requests`
    // traffic log is the highest-volume per-tenant table (retention anticipates 50M rows/pass), so the old
    // single unbounded SELECT into one array OOM-killed the shared scheduler+API process for a heavy org
    // (red-team round4 F1). Matches the sibling jobs' pattern (retention deleteInBatches, scheduler
    // SCOPE_PAGE_SIZE keyset pagination). (created_at, id) is a stable total order for the keyset cursor.
    const BATCH = 5000;
    const acc = newDowngradeAccumulator();
    let cursor: { createdAt: Date; id: string } | null = null;
    for (;;) {
      const raw = (await tx.execute(sql`
        SELECT id, created_at, model, cost_usd::text AS cost_usd, request_features
          FROM requests
         WHERE created_at >= ${monthStart} AND status = 'ok'
           AND cost_usd IS NOT NULL AND model IS NOT NULL AND request_features IS NOT NULL
           ${cursor ? sql`AND (created_at, id) > (${cursor.createdAt}, ${cursor.id})` : sql``}
         ORDER BY created_at, id
         LIMIT ${BATCH}`)) as unknown as {
        id: string;
        created_at: Date;
        model: string | null;
        cost_usd: string;
        request_features: unknown;
      }[];
      if (raw.length === 0) break;
      const batch: InsightRequestRow[] = raw.map((r) => ({
        id: r.id,
        model: r.model,
        costMicroUsd: parseUsd(r.cost_usd),
        features: asJson<Partial<RequestFeatures>>(r.request_features),
      }));
      accumulateDowngrades(acc, batch);
      const last = raw[raw.length - 1]!;
      cursor = { createdAt: last.created_at, id: last.id };
      if (raw.length < BATCH) break;
    }
    const result = finalizeDowngrades(acc, rateFor);

    // Forecast-flagged scopes this period → prioritized (surfaced first in detail).
    const flagged = (await tx.execute(sql`
      SELECT DISTINCT payload->>'scope_id' AS scope_id FROM alert_events
       WHERE payload->>'event_type' = 'budget_forecast' AND payload->>'period_key' = ${period}
         AND payload->>'scope_id' IS NOT NULL`)) as unknown as { scope_id: string }[];

    const summary = {
      requests_analyzed: result.requestsAnalyzed,
      downgrade_candidates: result.suggestions.length,
      estimated_savings_usd: formatUsd(result.estSavingsMicroUsd),
      method: result.method,
      heuristic_only: result.heuristicOnly,
      method_warning: 'heuristic mode — the MLP classifier is not enabled (§8 secondary is a seam)',
    };
    const detail = {
      forecast_flagged_scope_ids: flagged.map((f) => f.scope_id), // prioritized scopes
      suggestions: result.suggestions.map((s) => ({
        from_model: s.fromModel,
        to_model: s.toModel,
        request_count: s.requestCount,
        est_savings_usd: formatUsd(s.estSavingsMicroUsd),
        sample_request_ids: s.sampleRequestIds,
      })),
    };

    await tx.execute(sql`
      INSERT INTO savings_insights (org_id, period, generated_at, summary, detail)
      VALUES (${orgId}, ${period}, now(), ${JSON.stringify(summary)}::jsonb, ${JSON.stringify(detail)}::jsonb)
      ON CONFLICT (org_id, period)
        DO UPDATE SET generated_at = now(), summary = excluded.summary, detail = excluded.detail`);

    return {
      period,
      requestsAnalyzed: result.requestsAnalyzed,
      suggestions: result.suggestions.length,
      estSavingsUsd: summary.estimated_savings_usd,
    };
  });
}

/** Cross-org weekly scan (scheduler): every org with requests this period gets a regenerated insight. */
export async function runInsightsScan(
  jobsDb: DatabaseClient,
  db: DatabaseClient,
  now: Date,
  log?: { error: (obj: Record<string, unknown>, msg: string) => void },
): Promise<{ orgs: number; failed: number }> {
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const orgs = (await asJobs(jobsDb, (tx) =>
    tx.execute(sql`
      SELECT DISTINCT org_id FROM requests WHERE created_at >= ${monthStart} AND status = 'ok'`),
  )) as unknown as { org_id: string }[];
  // Per-org isolation (audit M28): one org whose request_features breaks the classifier must not
  // abort the weekly run for every other org. Settle each org independently; count failures so the
  // job's bookkeeping reflects partial success instead of an all-or-nothing abort.
  let failed = 0;
  for (const o of orgs) {
    try {
      await runInsightsForOrg(db, o.org_id, now);
    } catch (err) {
      failed += 1;
      log?.error({ orgId: o.org_id, err: String(err) }, 'insights scan failed for org');
    }
  }
  return { orgs: orgs.length, failed };
}
