import { sql, type SQL } from 'drizzle-orm';
import { formatUsd, parseUsd } from '@spillway/pricing';
import type { DatabaseClient } from '../db/client.js';
import { withOrg, type Tx } from '../db/tenancy.js';

/**
 * Chargeback statement (Part II §20 §2) — spend attributed per scope over a period, with a ledger
 * reconciliation invariant: Σ(grouped requests.cost) == Σ(request_attempts.cost) to 6dp (the money
 * path guarantees this via the attempts ledger; a mismatch → reconciliation_warning, never a silent
 * wrong total). Read-only, RLS-scoped. `group_by=metadata.<key>` and FOCUS schema are reserve seams.
 *
 * Third arm (expanded-audit MED): also cross-check the ENFORCEMENT counter (spend_counters.spent_usd)
 * against the ledger, so an enforcement/audit drift (the counter that gates budgets silently diverging
 * from what was actually billed) is detectable, not invisible. The counter is written per calendar
 * window, so this arm is only sound when the statement period is exactly whole UTC months — otherwise
 * a sub-month window would over-count the month/day rows. When the period isn't month-aligned the arm
 * is reported as null (skipped), never a false drift warning.
 */

export type ChargebackGroupBy = 'virtual_key' | 'team' | 'model' | 'none';

/**
 * Month keys ('YYYY-MM') covered by [start,end) IFF both bounds are exact UTC month boundaries; else
 * null. spend_counters is keyed per calendar month (+ day + rolling), so the org monthly rows sum to
 * the true org spend for a month only when the window is whole months — a sub-month range can't be
 * cross-checked against the counter without over-counting.
 */
export function wholeMonthKeys(start: Date, end: Date): string[] | null {
  const onMonthBoundary = (d: Date): boolean =>
    d.getUTCDate() === 1 &&
    d.getUTCHours() === 0 &&
    d.getUTCMinutes() === 0 &&
    d.getUTCSeconds() === 0 &&
    d.getUTCMilliseconds() === 0;
  if (!onMonthBoundary(start) || !onMonthBoundary(end) || end <= start) return null;
  const keys: string[] = [];
  const cur = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  while (cur < end) {
    keys.push(`${cur.getUTCFullYear()}-${String(cur.getUTCMonth() + 1).padStart(2, '0')}`);
    cur.setUTCMonth(cur.getUTCMonth() + 1);
  }
  return keys;
}

export interface ChargebackLine {
  scopeType: ChargebackGroupBy;
  scopeId: string | null;
  requestCount: number;
  successCount: number;
  // Budget-blocked requests (status='blocked') carry no spend; surfaced as their own column so a
  // finance consumer can see that requestCount includes non-billable volume rather than silently
  // over-attributing request volume to a scope whose cost is $0 (audit M40).
  blockedCount: number;
  costUsd: string; // 6dp
}

export interface ChargebackStatement {
  orgId: string;
  periodStart: string;
  periodEnd: string;
  groupBy: ChargebackGroupBy;
  lines: ChargebackLine[];
  totalCostUsd: string;
  reconciliation: {
    requestsUsd: string;
    attemptsUsd: string;
    consistent: boolean;
    warning?: string;
    // Enforcement-counter arm. null = period not whole-UTC-months, cross-check skipped (not a drift).
    countersUsd: string | null;
    counterConsistent: boolean | null;
    counterWarning?: string;
  };
}

function groupExpr(groupBy: ChargebackGroupBy): SQL {
  switch (groupBy) {
    case 'virtual_key':
      return sql`virtual_key_id::text`;
    case 'team':
      return sql`team_id::text`;
    case 'model':
      return sql`requested_model`;
    case 'none':
      return sql`null::text`;
  }
}

export async function buildChargebackStatement(
  db: DatabaseClient,
  orgId: string,
  opts: { start: Date; end: Date; groupBy: ChargebackGroupBy },
): Promise<ChargebackStatement> {
  const startIso = opts.start.toISOString();
  const endIso = opts.end.toISOString();
  const g = groupExpr(opts.groupBy);

  return withOrg(db, orgId, async (tx) => {
    const rows = (await tx.execute(sql`
      SELECT ${g} AS scope_id,
             count(*)::int AS request_count,
             count(*) FILTER (WHERE status = 'ok')::int AS success_count,
             count(*) FILTER (WHERE status = 'blocked')::int AS blocked_count,
             coalesce(sum(cost_usd), 0)::text AS cost_usd,
             count(*) FILTER (WHERE cost_usd IS NULL AND status = 'ok')::int AS null_cost_count
        FROM requests
       WHERE created_at >= ${startIso} AND created_at < ${endIso}
       GROUP BY ${g}
       -- sort by the NUMERIC sum, not the ::text cost_usd output alias (which sorts lexicographically,
       -- '9.5' after '10.0') so the biggest-spender-first contract holds in JSON + CSV (red-team round4 F7).
       ORDER BY coalesce(sum(cost_usd), 0) DESC NULLS LAST`)) as unknown as {
      scope_id: string | null;
      request_count: number;
      success_count: number;
      blocked_count: number;
      cost_usd: string;
      null_cost_count: number;
    }[];

    let requestsMicro = 0n;
    let nullCosts = 0;
    const lines: ChargebackLine[] = rows.map((r) => {
      requestsMicro += parseUsd(r.cost_usd);
      nullCosts += r.null_cost_count;
      return {
        scopeType: opts.groupBy,
        scopeId: r.scope_id,
        requestCount: r.request_count,
        successCount: r.success_count,
        blockedCount: r.blocked_count,
        costUsd: formatUsd(parseUsd(r.cost_usd)),
      };
    });

    // Ledger cross-check: Σ attempts.cost over the period (the source-of-truth the reconcile path sums).
    const [att] = (await tx.execute(sql`
      SELECT coalesce(sum(ra.cost_usd), 0)::text AS attempts_usd
        FROM request_attempts ra
        JOIN requests r ON r.id = ra.request_id
       WHERE r.created_at >= ${startIso} AND r.created_at < ${endIso}`)) as unknown as {
      attempts_usd: string;
    }[];
    const attemptsMicro = parseUsd(att?.attempts_usd ?? '0');

    const consistent = requestsMicro === attemptsMicro && nullCosts === 0;
    const warning = !consistent
      ? nullCosts > 0
        ? `${nullCosts} request(s) have an unknown price`
        : 'requests total does not match the attempts ledger'
      : undefined;

    // Third arm — enforcement counter. Only sound over whole UTC months (see wholeMonthKeys); sum the
    // org-scope MONTHLY rows for the months in range (day/rolling rows would double-count) and require
    // it to equal the request ledger. Distinct 'counter ledger drift' signal, kept separate from the
    // requests==attempts invariant so a sub-month window (arm skipped) never trips a false warning.
    const monthKeys = wholeMonthKeys(opts.start, opts.end);
    let countersMicro: bigint | null = null;
    if (monthKeys && monthKeys.length > 0) {
      const inList = sql.join(
        monthKeys.map((k) => sql`${k}`),
        sql`, `,
      );
      const [cnt] = (await tx.execute(sql`
        SELECT coalesce(sum(spent_usd), 0)::text AS counters_usd
          FROM spend_counters
         WHERE scope_type = 'org' AND scope_id = ${orgId}::uuid
           AND period_key IN (${inList})`)) as unknown as { counters_usd: string }[];
      countersMicro = parseUsd(cnt?.counters_usd ?? '0');
    }
    const counterConsistent = countersMicro === null ? null : countersMicro === requestsMicro;
    const counterWarning =
      counterConsistent === false
        ? 'counter ledger drift: the enforcement counter disagrees with the request ledger'
        : undefined;

    return {
      orgId,
      periodStart: startIso,
      periodEnd: endIso,
      groupBy: opts.groupBy,
      lines,
      totalCostUsd: formatUsd(requestsMicro),
      reconciliation: {
        requestsUsd: formatUsd(requestsMicro),
        attemptsUsd: formatUsd(attemptsMicro),
        consistent,
        ...(warning ? { warning } : {}),
        countersUsd: countersMicro === null ? null : formatUsd(countersMicro),
        counterConsistent,
        ...(counterWarning ? { counterWarning } : {}),
      },
    };
  });
}

/**
 * One CSV field, RFC-4180 quoted + formula-injection neutralized. scope_id can be a client-controlled
 * model name (group_by=model), so an unescaped `=HYPERLINK(...)` / `+cmd` / a value with commas or
 * CRLF would execute or corrupt columns when an admin opens the export in Excel/Sheets, and could
 * break the golden column contract (expanded-audit HIGH). Neutralize a leading formula trigger with a
 * single quote FIRST, then RFC-4180-quote if the value carries a comma/quote/newline.
 */
function csvField(value: string): string {
  let s = value ?? '';
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // Excel/Sheets treat a leading ' as literal text
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

/**
 * Deterministic CSV (stable column order — golden contract, §2). Every text field is escaped. The
 * total row now carries successCount + blockedCount subtotals (not just requestCount) so an automated
 * finance reconciliation can sum any numeric column and match — previously Σ(successCount)/Σ(blocked)
 * had no total and requestCount silently mixed billable + blocked volume (audit L42 / M40).
 */
export function statementToCsv(s: ChargebackStatement): string {
  const header = 'scope_type,scope_id,request_count,success_count,blocked_count,cost_usd';
  const rows = s.lines.map(
    (l) =>
      `${csvField(l.scopeType)},${csvField(l.scopeId ?? '')},${l.requestCount},${l.successCount},${l.blockedCount},${csvField(l.costUsd)}`,
  );
  const totals = s.lines.reduce(
    (acc, l) => ({
      req: acc.req + l.requestCount,
      ok: acc.ok + l.successCount,
      blocked: acc.blocked + l.blockedCount,
    }),
    { req: 0, ok: 0, blocked: 0 },
  );
  const total = `total,,${totals.req},${totals.ok},${totals.blocked},${csvField(s.totalCostUsd)}`;
  return [header, ...rows, total].join('\n') + '\n';
}

// ── Hierarchical statement (20 §2.1) — the finance-grade org → team → key → model view ─────────────

export interface ChargebackModelNode {
  model: string | null;
  totalUsd: string;
  fallbackServedUsd: string;
  estimatedUsageUsd: string;
  requestCount: number;
  inputTokens: number;
  outputTokens: number;
  blockedCount: number;
  rateLimitedCount: number;
  errorCount: number;
  unknownCostCount: number;
}
export interface ChargebackKeyNode {
  virtualKeyId: string | null;
  keyName: string;
  keyPrefix: string | null;
  totalUsd: string;
  estimatedUsageUsd: string;
  models: ChargebackModelNode[];
}
export interface ChargebackTeamNode {
  teamId: string | null;
  teamName: string; // 'Unassigned' when team_id is NULL
  totalUsd: string;
  estimatedUsageUsd: string;
  keys: ChargebackKeyNode[];
}
export interface HierarchicalStatement {
  orgId: string;
  month: string; // 'YYYY-MM'
  totalUsd: string;
  estimatedUsageUsd: string;
  warnings: BillingWarning[]; // §2.7 billing-error detectors; empty when clean
  teams: ChargebackTeamNode[];
  reconciliation: {
    statementUsd: string;
    attemptsUsd: string;
    counterUsd: string;
    deltaAttemptsUsd: string;
    deltaCounterUsd: string;
    consistent: boolean;
  };
}

interface GroupRow {
  team_id: string | null;
  virtual_key_id: string | null;
  model: string | null;
  total_usd: string | null;
  request_count: number;
  input_tokens: string | number; // ::bigint → string from pg (a heavy month exceeds int4)
  output_tokens: string | number;
  blocked_count: number;
  rate_limited_count: number;
  error_count: number;
  estimated_count: number;
  unknown_cost_count: number;
}

/**
 * 20 §2.1 — the hierarchical monthly statement: one grouped scan (team → key → model), name-enriched,
 * nested with per-level totals, plus the ADR-035 dual reconciliation at org scope (statement ↔ attempts
 * ledger AND statement ↔ enforcement counter). `month` is 'YYYY-MM' (UTC). A NULL team is the
 * "Unassigned" bucket. Money is bigint µUSD internally, formatted 6dp at the boundary.
 */
export async function generateHierarchicalStatement(
  db: DatabaseClient,
  orgId: string,
  month: string,
): Promise<HierarchicalStatement> {
  return withOrg(db, orgId, async (tx) => {
    const rows = (await tx.execute(sql`
      SELECT team_id, virtual_key_id, model,
             sum(cost_usd) FILTER (WHERE status IN ('ok','error'))::text AS total_usd,
             coalesce(sum(input_tokens)  FILTER (WHERE status IN ('ok','error')),0)::bigint AS input_tokens,
             coalesce(sum(output_tokens) FILTER (WHERE status IN ('ok','error')),0)::bigint AS output_tokens,
             count(*)::int AS request_count,
             count(*) FILTER (WHERE status='blocked')::int AS blocked_count,
             count(*) FILTER (WHERE status='rate_limited')::int AS rate_limited_count,
             count(*) FILTER (WHERE status='error')::int AS error_count,
             count(*) FILTER (WHERE usage_estimated = true)::int AS estimated_count,
             count(*) FILTER (WHERE cost_usd IS NULL AND status IN ('ok','error'))::int AS unknown_cost_count
        FROM requests
       WHERE date_trunc('month', created_at AT TIME ZONE 'UTC')
           = date_trunc('month', (${month} || '-01')::timestamptz AT TIME ZONE 'UTC')
       GROUP BY team_id, virtual_key_id, model
       ORDER BY team_id NULLS LAST, virtual_key_id, model`)) as unknown as GroupRow[];

    const teamRows = (await tx.execute(sql`SELECT id, name FROM teams`)) as unknown as {
      id: string;
      name: string;
    }[];
    const vkRows = (await tx.execute(
      sql`SELECT id, name, key_prefix FROM virtual_keys`,
    )) as unknown as { id: string; name: string; key_prefix: string | null }[];
    const teamName = new Map(teamRows.map((t) => [t.id, t.name]));
    const vkInfo = new Map(vkRows.map((v) => [v.id, { name: v.name, prefix: v.key_prefix }]));

    // Nest team → key → model, accumulating totals + estimated-usage (§2.4) as bigint µUSD.
    interface TAcc {
      teamId: string | null;
      total: bigint;
      est: bigint;
      keys: Map<string, KAcc>;
    }
    interface KAcc {
      virtualKeyId: string | null;
      total: bigint;
      est: bigint;
      models: ChargebackModelNode[];
    }
    const teams = new Map<string, TAcc>();
    let orgTotal = 0n;
    let orgEst = 0n;

    for (const r of rows) {
      const micro = parseUsd(r.total_usd ?? '0');
      // §2.4: a (team,key,model) row is estimated iff every one of its billed requests was estimated.
      const estMicro = r.estimated_count === r.request_count ? micro : 0n;
      orgTotal += micro;
      orgEst += estMicro;

      const tKey = r.team_id ?? '∅';
      let t = teams.get(tKey);
      if (!t) {
        t = { teamId: r.team_id, total: 0n, est: 0n, keys: new Map() };
        teams.set(tKey, t);
      }
      t.total += micro;
      t.est += estMicro;

      const kKey = r.virtual_key_id ?? '∅';
      let k = t.keys.get(kKey);
      if (!k) {
        k = { virtualKeyId: r.virtual_key_id, total: 0n, est: 0n, models: [] };
        t.keys.set(kKey, k);
      }
      k.total += micro;
      k.est += estMicro;
      k.models.push({
        model: r.model,
        totalUsd: formatUsd(micro),
        // §2.3 fallback-served breakout needs a request-level served_under_budget_fallback column,
        // which only exists on request_attempts today — reserved (0) until it's lifted to requests.
        fallbackServedUsd: formatUsd(0n),
        estimatedUsageUsd: formatUsd(estMicro),
        requestCount: r.request_count,
        inputTokens: Number(r.input_tokens), // ::bigint arrives as a string; a month's tokens are < 2^53
        outputTokens: Number(r.output_tokens),
        blockedCount: r.blocked_count,
        rateLimitedCount: r.rate_limited_count,
        errorCount: r.error_count,
        unknownCostCount: r.unknown_cost_count,
      });
    }

    const teamNodes: ChargebackTeamNode[] = [...teams.values()].map((t) => ({
      teamId: t.teamId,
      teamName: t.teamId ? (teamName.get(t.teamId) ?? t.teamId) : 'Unassigned',
      totalUsd: formatUsd(t.total),
      estimatedUsageUsd: formatUsd(t.est),
      keys: [...t.keys.values()].map((k) => {
        const info = k.virtualKeyId ? vkInfo.get(k.virtualKeyId) : undefined;
        return {
          virtualKeyId: k.virtualKeyId,
          keyName: info?.name ?? k.virtualKeyId ?? 'Unassigned',
          keyPrefix: info?.prefix ?? null,
          totalUsd: formatUsd(k.total),
          estimatedUsageUsd: formatUsd(k.est),
          models: k.models,
        };
      }),
    }));

    // §2.5 dual reconciliation at ORG scope: statement ↔ attempts ledger AND statement ↔ counter.
    const [att] = (await tx.execute(sql`
      SELECT coalesce(sum(a.cost_usd),0)::text AS attempts_usd
        FROM request_attempts a JOIN requests r ON r.id = a.request_id
       WHERE date_trunc('month', r.created_at AT TIME ZONE 'UTC')
           = date_trunc('month', (${month} || '-01')::timestamptz AT TIME ZONE 'UTC')`)) as unknown as {
      attempts_usd: string;
    }[];
    const [cnt] = (await tx.execute(sql`
      SELECT coalesce(sum(spent_usd),0)::text AS counter_usd FROM spend_counters
       WHERE scope_type='org' AND scope_id=${orgId}::uuid AND period_key=${month}`)) as unknown as {
      counter_usd: string;
    }[];
    const attemptsMicro = parseUsd(att?.attempts_usd ?? '0');
    const counterMicro = parseUsd(cnt?.counter_usd ?? '0');
    const dAtt = orgTotal > attemptsMicro ? orgTotal - attemptsMicro : attemptsMicro - orgTotal;
    const dCnt = orgTotal > counterMicro ? orgTotal - counterMicro : counterMicro - orgTotal;

    // §2.7 billing-error detectors, run over the same period in the same tx (read-only).
    const warnings = await runBillingDetectors(tx, month);

    return {
      orgId,
      month,
      totalUsd: formatUsd(orgTotal),
      estimatedUsageUsd: formatUsd(orgEst),
      warnings,
      teams: teamNodes,
      reconciliation: {
        statementUsd: formatUsd(orgTotal),
        attemptsUsd: formatUsd(attemptsMicro),
        counterUsd: formatUsd(counterMicro),
        deltaAttemptsUsd: formatUsd(dAtt),
        deltaCounterUsd: formatUsd(dCnt),
        consistent: dAtt === 0n && dCnt === 0n,
      },
    };
  });
}

// ── Billing-error detectors (20 §2.7, Vaudit-class) → statement.warnings ────────────────────────────

export interface BillingWarning {
  detector: 'wrong_model_rate' | 'zero_output_billed' | 'retry_storm_dup';
  affectedRequests: number;
  suspectUsd: string;
  detail: Record<string, string | number>;
}

/**
 * 20 §2.7 — read-only billing-error detectors run over a month, attached to the statement's warnings.
 * D1 wrong-model-rate (billed input rate ≠ catalog, non-tiered), D2 zero-output-billed (paid for a
 * generation that produced nothing), D3 retry-storm-dup (≥N billed attempts to one candidate in one
 * request). D4 dual-dispatch needs a per-attempt started_at column (only elapsed_ms/created_at exist
 * today) — deferred. Never mutates the ledger; empty array = clean.
 */
export async function runBillingDetectors(
  tx: Tx,
  month: string,
  retryStormThreshold = 4,
): Promise<BillingWarning[]> {
  {
    const monthMatch = (col: string): SQL =>
      sql`date_trunc('month', ${sql.raw(col)} AT TIME ZONE 'UTC') = date_trunc('month', (${month} || '-01')::timestamptz AT TIME ZONE 'UTC')`;
    const warnings: BillingWarning[] = [];

    // D1 — billed input rate ≠ current catalog rate for (provider, model), excluding tiered rows.
    const [d1] = (await tx.execute(sql`
      SELECT count(*)::int AS n,
             coalesce(round(sum(greatest(
               ((r.unit_prices->>'in')::numeric - mp.input_usd_per_m) * r.input_tokens / 1000000.0, 0)), 6), 0)::text AS overbill_usd
        FROM requests r
        JOIN model_prices mp ON mp.provider = r.provider AND mp.model = r.model
       WHERE ${monthMatch('r.created_at')}
         AND r.status IN ('ok','error') AND r.cost_usd IS NOT NULL AND r.unit_prices IS NOT NULL
         AND (r.unit_prices->>'in') IS NOT NULL
         AND (r.unit_prices->>'in')::numeric <> mp.input_usd_per_m
         AND mp.tiers IS NULL`)) as unknown as { n: number; overbill_usd: string }[];
    if (d1 && d1.n > 0)
      warnings.push({
        detector: 'wrong_model_rate',
        affectedRequests: d1.n,
        suspectUsd: formatUsd(parseUsd(d1.overbill_usd)),
        detail: { mismatched_requests: d1.n },
      });

    // D2 — zero output tokens but non-zero cost on a generation endpoint.
    const [d2] = (await tx.execute(sql`
      SELECT count(*)::int AS n, coalesce(sum(cost_usd), 0)::text AS billed_usd
        FROM requests r
       WHERE ${monthMatch('r.created_at')}
         AND r.status = 'ok' AND r.endpoint IN ('chat_completions','messages')
         AND r.output_tokens = 0 AND r.input_tokens > 0 AND r.cost_usd > 0`)) as unknown as {
      n: number;
      billed_usd: string;
    }[];
    if (d2 && d2.n > 0)
      warnings.push({
        detector: 'zero_output_billed',
        affectedRequests: d2.n,
        suspectUsd: formatUsd(parseUsd(d2.billed_usd)),
        detail: { total_zero_output_requests: d2.n },
      });

    // D3 — ≥threshold billed attempts to the SAME (provider, model) within one request (retry storm).
    // suspect_usd ≈ cost beyond the first attempt per group (sum − min, an ordering-free approximation).
    const [d3] = (await tx.execute(sql`
      SELECT count(*)::int AS groups,
             coalesce(sum(dup_usd), 0)::text AS suspect_usd,
             coalesce(max(billed_attempts), 0)::int AS max_attempts
        FROM (
          SELECT a.request_id, count(*)::int AS billed_attempts,
                 (sum(a.cost_usd) - min(a.cost_usd)) AS dup_usd
            FROM request_attempts a
            JOIN requests r ON r.id = a.request_id
           WHERE ${monthMatch('r.created_at')} AND a.cost_usd > 0
           GROUP BY a.request_id, a.provider, a.model
          HAVING count(*) >= ${retryStormThreshold}
        ) g`)) as unknown as { groups: number; suspect_usd: string; max_attempts: number }[];
    if (d3 && d3.groups > 0)
      warnings.push({
        detector: 'retry_storm_dup',
        affectedRequests: d3.groups,
        suspectUsd: formatUsd(parseUsd(d3.suspect_usd)),
        detail: { max_attempts_on_one_candidate: d3.max_attempts, distinct_requests: d3.groups },
      });

    return warnings;
  }
}
