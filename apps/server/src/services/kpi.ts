import { sql } from 'drizzle-orm';
import { formatUsd, parseUsd } from '@spillway/pricing';
import type { DatabaseClient } from '../db/client.js';
import { withOrg } from '../db/tenancy.js';

/**
 * Dashboard KPI aggregates (04-api-contracts §3.15; 09-frontend §3.4). All SQL-aggregate-backed —
 * never row-fetch-then-reduce (the `limit:100000` anti-pattern the bible bans). Read-only, RLS-scoped
 * via withOrg. Money is exact micro-USD (`parseUsd`/`formatUsd`); percentages are 2dp derived from the
 * same integers so they never drift. Responses are camelCase (the control-plane convention — see
 * `routes/requests.ts`), not the bible prose's snake_case.
 */

// Month/day components are bounded so an out-of-range value (2026-00, 2026-13) is a 400, not a window
// silently rolled into an adjacent month by Date arithmetic.
export const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/; // YYYY-MM
export const DAY_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/; // YYYY-MM-DD

/** UTC [start, end) instants for a 'YYYY-MM' period + the previous month's period key. */
function monthWindow(period: string): { start: string; end: string; prevKey: string } {
  const [y, m] = period.split('-').map(Number) as [number, number];
  const start = new Date(Date.UTC(y, m - 1, 1));
  const end = new Date(Date.UTC(y, m, 1)); // exclusive upper bound
  const prev = new Date(Date.UTC(y, m - 2, 1));
  const prevKey = `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, '0')}`;
  return { start: start.toISOString(), end: end.toISOString(), prevKey };
}

/** Percent (2dp) from two exact integers (micro-USD or counts) — no float division drift. */
function pct2dp(numer: bigint, denom: bigint): number {
  if (denom === 0n) return 0;
  return Number((numer * 10_000n) / denom) / 100;
}

export interface BudgetUtilizationRow {
  scopeType: string;
  scopeId: string;
  scopeName: string;
  period: string; // month | day
  limitUsd: string;
  spentUsd: string;
  pct: number;
  mode: string;
}

export interface TopModelRow {
  provider: string;
  model: string;
  spendUsd: string;
  requestCount: number;
  pctOfTotal: number;
}

export interface OverviewKpis {
  period: string;
  spendUsd: string;
  spendUsdPrevPeriod: string;
  requestCount: number;
  blockedCount: number;
  budgetUtilization: BudgetUtilizationRow[];
  topModels: TopModelRow[];
  errorRatePct: number;
}

/**
 * Org-level KPI summary for `period` (YYYY-MM). spend / requestCount / blockedCount are read O(1) from
 * the org-scope `spend_counters` row (the enforcement counter reconcile bumps per request); errorRate,
 * topModels and budgetUtilization are aggregates over `requests` / `budgets`.
 */
export async function overviewKpis(
  db: DatabaseClient,
  orgId: string,
  period: string,
): Promise<OverviewKpis> {
  const { start, end, prevKey } = monthWindow(period);
  const dayKey = new Date().toISOString().slice(0, 10); // for day-period budgets: today (UTC)

  return withOrg(db, orgId, async (tx) => {
    // (1) org-scope counters — this period + previous (for the delta). O(1) per row.
    const counters = (await tx.execute(sql`
      SELECT period_key, spent_usd::text AS spent, request_count, blocked_count
        FROM spend_counters
       WHERE scope_type = 'org' AND scope_id = ${orgId}::uuid
         AND period_key IN (${period}, ${prevKey})`)) as unknown as {
      period_key: string;
      spent: string;
      // bigint columns come back as strings from the raw driver — coerce with Number() below.
      request_count: string | number;
      blocked_count: string | number;
    }[];
    const cur = counters.find((c) => c.period_key === period);
    const prev = counters.find((c) => c.period_key === prevKey);

    // (2) error rate + period total cost from requests. errorRate numerator = status='error',
    // denominator = status IN ('ok','error') (blocked/rate_limited excluded, per §3.15).
    const [agg] = (await tx.execute(sql`
      SELECT count(*) FILTER (WHERE status = 'error')::int AS err,
             count(*) FILTER (WHERE status IN ('ok','error'))::int AS denom,
             coalesce(sum(cost_usd), 0)::text AS total_cost
        FROM requests
       WHERE created_at >= ${start} AND created_at < ${end}`)) as unknown as {
      err: number;
      denom: number;
      total_cost: string;
    }[];
    const totalMicro = parseUsd(agg?.total_cost ?? '0');

    // (3) top 5 models by spend.
    const models = (await tx.execute(sql`
      SELECT provider, model,
             coalesce(sum(cost_usd), 0)::text AS spend,
             count(*)::int AS request_count
        FROM requests
       WHERE created_at >= ${start} AND created_at < ${end} AND model IS NOT NULL
       GROUP BY provider, model
       ORDER BY sum(cost_usd) DESC NULLS LAST
       LIMIT 5`)) as unknown as {
      provider: string | null;
      model: string;
      spend: string;
      request_count: number;
    }[];

    // (4) budget utilization — enforce/alert budgets on month|day periods, joined to their counter row
    // (period_key differs by budget.period) and to the name table for the scope. rolling_30d budgets
    // are omitted (no O(1) counter key; §3.15 types period as month|day only).
    const budgets = (await tx.execute(sql`
      SELECT b.scope_type,
             b.scope_id::text AS scope_id,
             b.period,
             b.limit_usd::text AS limit_usd,
             b.mode,
             coalesce(sc.spent_usd, 0)::text AS spent_usd,
             coalesce(o.name, t.name, vk.name, b.scope_id::text) AS scope_name
        FROM budgets b
        LEFT JOIN spend_counters sc
          ON sc.scope_type = b.scope_type AND sc.scope_id = b.scope_id
         AND sc.period_key = CASE b.period WHEN 'month' THEN ${period} WHEN 'day' THEN ${dayKey} END
        LEFT JOIN orgs o ON b.scope_type = 'org' AND o.id = b.scope_id
        LEFT JOIN teams t ON b.scope_type = 'team' AND t.id = b.scope_id
        LEFT JOIN virtual_keys vk ON b.scope_type = 'virtual_key' AND vk.id = b.scope_id
       WHERE b.mode IN ('enforce', 'alert') AND b.period IN ('month', 'day')
       ORDER BY (coalesce(sc.spent_usd, 0) / NULLIF(b.limit_usd, 0)) DESC NULLS LAST`)) as unknown as {
      scope_type: string;
      scope_id: string;
      period: string;
      limit_usd: string;
      mode: string;
      spent_usd: string;
      scope_name: string;
    }[];

    return {
      period,
      spendUsd: formatUsd(parseUsd(cur?.spent ?? '0')),
      spendUsdPrevPeriod: formatUsd(parseUsd(prev?.spent ?? '0')),
      requestCount: Number(cur?.request_count ?? 0),
      blockedCount: Number(cur?.blocked_count ?? 0),
      errorRatePct: pct2dp(BigInt(agg?.err ?? 0), BigInt(agg?.denom ?? 0)),
      topModels: models.map((m) => {
        const spendMicro = parseUsd(m.spend);
        return {
          provider: m.provider ?? '',
          model: m.model,
          spendUsd: formatUsd(spendMicro),
          requestCount: m.request_count,
          pctOfTotal: pct2dp(spendMicro, totalMicro),
        };
      }),
      budgetUtilization: budgets.map((b) => {
        const spentMicro = parseUsd(b.spent_usd);
        const limitMicro = parseUsd(b.limit_usd);
        return {
          scopeType: b.scope_type,
          scopeId: b.scope_id,
          scopeName: b.scope_name,
          period: b.period,
          limitUsd: formatUsd(limitMicro),
          spentUsd: formatUsd(spentMicro),
          pct: pct2dp(spentMicro, limitMicro),
          mode: b.mode,
        };
      }),
    };
  });
}

export type TimeseriesGroupBy = 'none' | 'team' | 'model' | 'provider' | 'virtual_key';
export const TIMESERIES_GROUP_BYS: TimeseriesGroupBy[] = [
  'none',
  'team',
  'model',
  'provider',
  'virtual_key',
];

export interface TimeseriesPoint {
  date: string;
  spendUsd: string;
  requestCount: number;
}
export interface TimeseriesSeries {
  groupKey: string | null;
  groupName: string | null;
  points: TimeseriesPoint[];
}
export interface SpendTimeseries {
  start: string;
  end: string;
  groupBy: TimeseriesGroupBy;
  points?: TimeseriesPoint[]; // group_by=none
  series?: TimeseriesSeries[]; // grouped
}

/** SQL expr for the group key + its display-name join, per group_by. */
function groupSelect(groupBy: TimeseriesGroupBy): {
  key: ReturnType<typeof sql>;
  name: ReturnType<typeof sql>;
} {
  switch (groupBy) {
    case 'team':
      return { key: sql`r.team_id::text`, name: sql`t.name` };
    case 'virtual_key':
      return { key: sql`r.virtual_key_id::text`, name: sql`vk.name` };
    case 'model':
      return { key: sql`r.model`, name: sql`r.model` };
    case 'provider':
      return { key: sql`r.provider`, name: sql`r.provider` };
    case 'none':
      return { key: sql`null::text`, name: sql`null::text` };
  }
}

/**
 * Daily spend/request totals over [start, end] (inclusive days), optionally grouped. `group_by=none`
 * returns a flat `points[]`; any other returns `series[]` (uniform `{groupKey, groupName, points}` —
 * cleaner than the bible's per-type field names, since the dashboard renders them uniformly). Uses the
 * `(org_id, created_at)` index. Range is capped at 90 days by the caller.
 */
export async function spendTimeseries(
  db: DatabaseClient,
  orgId: string,
  opts: { start: string; end: string; groupBy: TimeseriesGroupBy; teamId?: string },
): Promise<SpendTimeseries> {
  const startIso = new Date(`${opts.start}T00:00:00Z`).toISOString();
  // Inclusive end DAY → exclusive next-day midnight so the whole end date is covered.
  const endIso = new Date(new Date(`${opts.end}T00:00:00Z`).getTime() + 86_400_000).toISOString();
  const teamFilter = opts.teamId ? sql`AND r.team_id = ${opts.teamId}::uuid` : sql``;

  return withOrg(db, orgId, async (tx) => {
    if (opts.groupBy === 'none') {
      const rows = (await tx.execute(sql`
        SELECT to_char(date_trunc('day', r.created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS date,
               coalesce(sum(r.cost_usd), 0)::text AS spend,
               count(*)::int AS request_count
          FROM requests r
         WHERE r.created_at >= ${startIso} AND r.created_at < ${endIso} ${teamFilter}
         GROUP BY 1
         ORDER BY 1`)) as unknown as { date: string; spend: string; request_count: number }[];
      return {
        start: opts.start,
        end: opts.end,
        groupBy: opts.groupBy,
        points: rows.map((r) => ({
          date: r.date,
          spendUsd: formatUsd(parseUsd(r.spend)),
          requestCount: r.request_count,
        })),
      };
    }

    const g = groupSelect(opts.groupBy);
    const joins =
      opts.groupBy === 'team'
        ? sql`LEFT JOIN teams t ON t.id = r.team_id`
        : opts.groupBy === 'virtual_key'
          ? sql`LEFT JOIN virtual_keys vk ON vk.id = r.virtual_key_id`
          : sql``;
    const rows = (await tx.execute(sql`
      SELECT ${g.key} AS group_key,
             ${g.name} AS group_name,
             to_char(date_trunc('day', r.created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS date,
             coalesce(sum(r.cost_usd), 0)::text AS spend,
             count(*)::int AS request_count
        FROM requests r
        ${joins}
       WHERE r.created_at >= ${startIso} AND r.created_at < ${endIso} ${teamFilter}
       GROUP BY 1, 2, 3
       ORDER BY 1, 3`)) as unknown as {
      group_key: string | null;
      group_name: string | null;
      date: string;
      spend: string;
      request_count: number;
    }[];

    // Pivot the flat (group, day) rows into one series per group, preserving date order.
    const byKey = new Map<string, TimeseriesSeries>();
    for (const r of rows) {
      const k = r.group_key ?? '∅';
      let s = byKey.get(k);
      if (!s) {
        s = { groupKey: r.group_key, groupName: r.group_name, points: [] };
        byKey.set(k, s);
      }
      s.points.push({
        date: r.date,
        spendUsd: formatUsd(parseUsd(r.spend)),
        requestCount: r.request_count,
      });
    }
    return { start: opts.start, end: opts.end, groupBy: opts.groupBy, series: [...byKey.values()] };
  });
}

export interface ModelMixRow {
  provider: string;
  model: string;
  spendUsd: string;
  requestCount: number;
  inputTokens: number;
  outputTokens: number;
  pctOfSpend: number;
}
export interface ModelMix {
  period: string;
  totalSpendUsd: string;
  models: ModelMixRow[];
}

/** Model usage breakdown for a period (top `limit` by spend). */
export async function modelMix(
  db: DatabaseClient,
  orgId: string,
  period: string,
  limit: number,
): Promise<ModelMix> {
  const { start, end } = monthWindow(period);
  return withOrg(db, orgId, async (tx) => {
    const rows = (await tx.execute(sql`
      SELECT provider, model,
             coalesce(sum(cost_usd), 0)::text AS spend,
             count(*)::int AS request_count,
             coalesce(sum(input_tokens), 0)::bigint AS input_tokens,
             coalesce(sum(output_tokens), 0)::bigint AS output_tokens,
             -- grand total across ALL model groups (window runs before LIMIT), so totalSpendUsd + every
             -- pctOfSpend use the true period total, not just the top-N shown here (red-team round4 F6).
             sum(coalesce(sum(cost_usd), 0)) OVER ()::text AS grand_total
        FROM requests
       WHERE created_at >= ${start} AND created_at < ${end} AND model IS NOT NULL
       GROUP BY provider, model
       ORDER BY sum(cost_usd) DESC NULLS LAST
       LIMIT ${limit}`)) as unknown as {
      provider: string | null;
      model: string;
      grand_total: string;
      spend: string;
      request_count: number;
      input_tokens: string | number;
      output_tokens: string | number;
    }[];
    // The TRUE period total (all groups, from the window column) — NOT a sum of the LIMIT-ed rows, which
    // would understate spend and inflate every pctOfSpend when there are more models than `limit` (F6).
    const totalMicro = rows.length ? parseUsd(rows[0]!.grand_total) : 0n;
    return {
      period,
      totalSpendUsd: formatUsd(totalMicro),
      models: rows.map((r) => {
        const spendMicro = parseUsd(r.spend);
        return {
          provider: r.provider ?? '',
          model: r.model,
          spendUsd: formatUsd(spendMicro),
          requestCount: r.request_count,
          inputTokens: Number(r.input_tokens),
          outputTokens: Number(r.output_tokens),
          pctOfSpend: pct2dp(spendMicro, totalMicro),
        };
      }),
    };
  });
}
