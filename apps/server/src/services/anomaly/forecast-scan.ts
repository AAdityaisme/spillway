import { sql } from 'drizzle-orm';
import { formatUsd, parseUsd } from '@spillway/pricing';
import type { Tx } from '../../db/tenancy.js';
import {
  hasSufficientRunRateHistory,
  dailyRunRateMicro,
  daysRemainingUtc,
  daysInMonthUtc,
  projectedEomMicro,
  forecastFires,
  overshootDay,
  monthPeriodKey,
} from './forecast.js';

/**
 * Budget-forecast producer (19 §4). Runs in the hourly scan (step 4, including utc_hour=0): for each
 * of an org's month budgets it projects end-of-month spend from the 3-day trailing run rate and fires a
 * deduped `budget_forecast` alert_event when on pace to exceed the limit — the forward-looking signal
 * (§4). The math lives in `forecast.ts` (pure); this reads the counters + budgets and writes the event.
 *
 * Runs per-org under `withOrg` (app role) so it needs no cross-org jobs grant on `budgets`: the caller
 * enumerates orgs (jobs role on `orgs`) and calls this once per org. Fire-once-per-scope-per-month via
 * the `budget_forecast:<type>:<id>:<month>` dedupe key.
 */

/** Buffer multiplier from the org's budget_forecast alert config (§4.2/§5.2), default 1.0, bounded. */
async function bufferFor(tx: Tx): Promise<number> {
  const rows = (await tx.execute(
    sql`select config from alerts where kind = 'budget_forecast' and enabled = true limit 1`,
  )) as unknown as { config: { buffer?: unknown } | null }[];
  const raw = rows[0]?.config?.buffer;
  const n = typeof raw === 'number' && Number.isFinite(raw) ? raw : 1.0;
  return Math.min(10, Math.max(1, n)); // never below 1.0 (would fire before the limit is even in reach)
}

async function scopeNameOf(
  tx: Tx,
  scopeType: string,
  scopeId: string,
  orgName: string,
): Promise<string> {
  if (scopeType === 'org') return orgName;
  if (scopeType === 'provider') return scopeId; // provider label is the scope id (uuidv5)
  const table = scopeType === 'team' ? 'teams' : 'virtual_keys';
  const rows = (await tx.execute(
    sql`select name from ${sql.raw(table)} where id = ${scopeId}::uuid`,
  )) as unknown as { name: string }[];
  return rows[0]?.name ?? scopeId;
}

interface BudgetRowLite {
  id: string;
  scope_type: string;
  scope_id: string;
  limit_usd: string;
}

/**
 * Evaluate + fire budget forecasts for ONE org (call under `withOrg(db, orgId, …)`). Returns the number
 * of NEW `budget_forecast` events fired (deduped repeats within the month return 0).
 */
export async function evaluateAndFireBudgetForecast(
  tx: Tx,
  args: { orgId: string; now: Date },
): Promise<number> {
  const { orgId, now } = args;
  const monthKey = monthPeriodKey(now);
  const today = now.toISOString().slice(0, 10);

  const budgets = (await tx.execute(sql`
    select id, scope_type, scope_id, limit_usd from budgets
    where period = 'month' and mode in ('enforce', 'alert')`)) as unknown as BudgetRowLite[];
  if (budgets.length === 0) return 0;

  const buffer = await bufferFor(tx);
  const orgRows = (await tx.execute(
    sql`select name from orgs where id = ${orgId}::uuid`,
  )) as unknown as { name: string }[];
  const orgName = orgRows[0]?.name ?? '';
  const daysInPeriod = daysInMonthUtc(now);
  const daysRem = daysRemainingUtc(now);
  const daysElapsed = now.getUTCDate();

  let fired = 0;
  for (const b of budgets) {
    const limitMicro = parseUsd(b.limit_usd);

    const mtdRow = (await tx.execute(sql`
      select spent_usd from spend_counters
      where scope_type = ${b.scope_type} and scope_id = ${b.scope_id}::uuid
        and period_key = ${monthKey}`)) as unknown as { spent_usd: string }[];
    const mtdMicro = mtdRow[0] ? parseUsd(mtdRow[0].spent_usd) : 0n;

    // 3 most-recent COMPLETED day-rows (period_key strictly before today) — the trailing run rate.
    const sampleRows = (await tx.execute(sql`
      select spent_usd from spend_counters
      where scope_type = ${b.scope_type} and scope_id = ${b.scope_id}::uuid
        and period_key ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' and period_key < ${today}
      order by period_key desc limit 3`)) as unknown as { spent_usd: string }[];
    const samples = sampleRows.map((r) => parseUsd(r.spent_usd));
    if (!hasSufficientRunRateHistory(samples)) continue; // cold-start: no reliable rate

    const rate = dailyRunRateMicro(samples);
    if (rate <= 0n) continue; // a flat-zero trailing window never projects an overshoot
    const projected = projectedEomMicro(mtdMicro, rate, daysRem);
    if (!forecastFires(mtdMicro, projected, limitMicro, buffer)) continue;

    const osDay = overshootDay(now, limitMicro - mtdMicro, rate, daysInPeriod);
    const scopeName = await scopeNameOf(tx, b.scope_type, b.scope_id, orgName);
    const payload = {
      event_type: 'budget_forecast',
      scope_type: b.scope_type,
      scope_id: b.scope_id,
      scope_name: scopeName,
      org_id: orgId,
      org_name: orgName,
      period: 'month',
      period_key: monthKey,
      limit_usd: b.limit_usd,
      buffer,
      mtd_usd: formatUsd(mtdMicro),
      daily_run_rate_usd: formatUsd(rate),
      days_elapsed: daysElapsed,
      days_in_period: daysInPeriod,
      days_remaining: daysRem,
      projected_eom_usd: formatUsd(projected),
      overshoot_day: osDay,
      fired_at: now.toISOString(),
      severity: 'warning' as const, // forward-looking advisory; not a hard block (delivery tiering)
    };
    const dedupeKey = `budget_forecast:${b.scope_type}:${b.scope_id}:${monthKey}`;
    const ins = (await tx.execute(sql`
      insert into alert_events (org_id, alert_id, fired_at, dedupe_key, payload)
      values (${orgId}::uuid, null, ${now.toISOString()}, ${dedupeKey},
              ${JSON.stringify(payload)}::jsonb)
      on conflict (alert_id, dedupe_key) do nothing
      returning id`)) as unknown as { id: string }[];
    fired += ins.length;
  }
  return fired;
}
