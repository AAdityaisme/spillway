import { sql } from 'drizzle-orm';
import { formatUsd, parseUsd } from '@spillway/pricing';
import type { Tx } from '../../db/tenancy.js';
import { currentPeriodKeys, rolling30Key } from '../../data-plane/budget/resolver.js';

/**
 * The budget fields the threshold hook needs, in the bundle's string-money shape (matches the
 * `PolicyBundle.budgets` rows reconcile passes; `limit_usd` is a numeric string, µUSD-parsed at use).
 */
export interface ThresholdBudget {
  id: string;
  scopeType: string;
  scopeId: string;
  period: string;
  limitUsd: string;
  mode: string;
  onExceed: string;
  createdAt: string | Date;
}

/**
 * Budget-threshold crossing (Part II §17 §5) — a `budget_threshold` alert fires once per configured
 * percentage band (80%, 100%) as spend climbs past it, never re-firing a band already crossed this
 * period. Runs as a fire-and-forget hook inside reconcile (§5.1) after the counter upsert commits, on
 * the final attempt only: it never blocks the response path. Money stays bigint µUSD and the pct compare
 * cross-multiplies so there is no float division of money at the boundary.
 */

/** §5.3 dedupe key — `'b' + budget_id + ':' + pct + ':' + period_key`. */
export function budgetThresholdDedupeKey(budgetId: string, pct: number, periodKey: string): string {
  return `b${budgetId}:${pct}:${periodKey}`;
}

/** §5.3 fallback-served dedupe key — `'bf' + budget_id + ':' + period_key`. */
export function budgetFallbackDedupeKey(budgetId: string, periodKey: string): string {
  return `bf${budgetId}:${periodKey}`;
}

/**
 * §5.4 severity from the crossed band — 100% → critical, ≥80% → warning, else info. Stamped in the
 * payload so delivery's severity tiering pages vs suppresses correctly (never silently defaulting).
 */
export function thresholdSeverity(pct: number): 'info' | 'warning' | 'critical' {
  if (pct >= 100) return 'critical';
  if (pct >= 80) return 'warning';
  return 'info';
}

/**
 * §5.2 bands newly crossed by this request's increment: a band `p` fires iff `pre < p%·limit` AND
 * `post >= p%·limit` (cross-multiplied in µUSD; `spent*100 >= limit*pct`). Fire-on-crossing means a
 * single reconcile emits at most the two bands it jumped over — a subsequent request already ≥ the band
 * re-derives `pre >= p%·limit` and fires nothing. `limit <= 0` → no bands.
 */
export function bandsCrossed(preMicro: bigint, postMicro: bigint, limitMicro: bigint): number[] {
  if (limitMicro <= 0n) return [];
  const out: number[] = [];
  for (const pct of [80, 100]) {
    const target = limitMicro * BigInt(pct); // vs spent*100
    if (postMicro * 100n >= target && preMicro * 100n < target) out.push(pct);
  }
  return out;
}

/** The period_key a budget's counter uses right now (day | month | rolling-30d block). */
export function budgetPeriodKey(budget: ThresholdBudget, now: Date): string {
  if (budget.period === 'rolling_30d') return rolling30Key(new Date(budget.createdAt), now);
  const { month, day } = currentPeriodKeys(now);
  return budget.period === 'day' ? day : month;
}

/** Post-increment counter value for one scope×period (µUSD), captured from reconcile's upsert RETURNING. */
export interface PostCounter {
  scopeType: string;
  scopeId: string;
  periodKey: string;
  spentMicro: bigint;
}

/** §5.4 payload — carries the automation-matcher fields (`event_type`, `pct`) plus the delivery fields. */
export interface BudgetThresholdEventPayload {
  event_type: 'budget_threshold';
  pct: number;
  budget_id: string;
  scope_type: string;
  scope_id: string;
  scope_name: string;
  period: string;
  period_key: string;
  spent_usd: string;
  limit_usd: string;
  mode: string;
  on_exceed: string;
  severity: 'info' | 'warning' | 'critical';
  org_id: string;
  org_name: string;
  fired_at: string;
}

interface Crossing {
  budget: ThresholdBudget;
  pct: number;
  periodKey: string;
  spentMicro: bigint;
}

/** Resolve the human name for a budget's scope (org/team/virtual_key name; provider label = the id key). */
async function scopeNameOf(tx: Tx, budget: ThresholdBudget, orgName: string): Promise<string> {
  if (budget.scopeType === 'org') return orgName;
  if (budget.scopeType === 'provider') return budget.scopeId; // provider label is the scope id (uuidv5)
  const table = budget.scopeType === 'team' ? 'teams' : 'virtual_keys';
  const rows = (await tx.execute(
    sql`select name from ${sql.raw(table)} where id = ${budget.scopeId}::uuid`,
  )) as unknown as { name: string }[];
  return rows[0]?.name ?? budget.scopeId;
}

/**
 * §5.1/§5.2/§5.3 — evaluate budget-threshold crossings from this reconcile's pre/post counters and fire
 * a deduped `alert_events` row per (crossed budget × band × matching alert). Runs in its own per-org
 * `withOrg` tx OFF the response path (fire-and-forget). `deltaMicro` is the spend this reconcile added to
 * the counters (this attempt's cost); `pre = post - deltaMicro`. Returns the number of NEW events fired.
 */
export async function evaluateAndFireBudgetThresholds(
  tx: Tx,
  args: {
    orgId: string;
    budgets: ThresholdBudget[];
    postCounters: PostCounter[];
    deltaMicro: bigint;
    now: Date;
  },
): Promise<number> {
  const { orgId, budgets, postCounters, deltaMicro, now } = args;
  if (deltaMicro <= 0n) return 0; // no spend moved → nothing can cross

  const postByKey = new Map(
    postCounters.map((c) => [`${c.scopeType}:${c.scopeId}:${c.periodKey}`, c.spentMicro]),
  );

  const crossings: Crossing[] = [];
  for (const budget of budgets) {
    if (budget.mode === 'monitor') continue; // only enforce|alert fire (§5.2)
    const periodKey = budgetPeriodKey(budget, now);
    const post = postByKey.get(`${budget.scopeType}:${budget.scopeId}:${periodKey}`);
    if (post === undefined) continue; // this request didn't bump this budget's counter
    const pre = post - deltaMicro;
    for (const pct of bandsCrossed(pre, post, parseUsd(budget.limitUsd))) {
      crossings.push({ budget, pct, periodKey, spentMicro: post });
    }
  }
  if (crossings.length === 0) return 0;

  // Off the hot path: fetch org name + the org's enabled budget_threshold alerts once.
  const orgRows = (await tx.execute(
    sql`select name from orgs where id = ${orgId}::uuid`,
  )) as unknown as { name: string }[];
  const orgName = orgRows[0]?.name ?? '';
  const alertRows = (await tx.execute(sql`
    select id, scope_type, scope_id from alerts
    where kind = 'budget_threshold' and enabled = true`)) as unknown as {
    id: string;
    scope_type: string | null;
    scope_id: string | null;
  }[];
  if (alertRows.length === 0) return 0;

  let fired = 0;
  const nameCache = new Map<string, string>();
  for (const c of crossings) {
    // §5.3 alert matching: an alert catches a budget crossing when its scope is org-wide (NULL) or
    // matches the budget's (scope_type, scope_id).
    const matching = alertRows.filter(
      (a) =>
        (a.scope_type === null && a.scope_id === null) ||
        (a.scope_type === c.budget.scopeType && a.scope_id === c.budget.scopeId),
    );
    if (matching.length === 0) continue;

    const cacheKey = `${c.budget.scopeType}:${c.budget.scopeId}`;
    let scopeName = nameCache.get(cacheKey);
    if (scopeName === undefined) {
      scopeName = await scopeNameOf(tx, c.budget, orgName);
      nameCache.set(cacheKey, scopeName);
    }

    const payload: BudgetThresholdEventPayload = {
      event_type: 'budget_threshold',
      pct: c.pct,
      budget_id: c.budget.id,
      scope_type: c.budget.scopeType,
      scope_id: c.budget.scopeId,
      scope_name: scopeName,
      period: c.budget.period,
      period_key: c.periodKey,
      spent_usd: formatUsd(c.spentMicro),
      limit_usd: c.budget.limitUsd,
      mode: c.budget.mode,
      on_exceed: c.budget.onExceed,
      severity: thresholdSeverity(c.pct),
      org_id: orgId,
      org_name: orgName,
      fired_at: now.toISOString(),
    };
    const dedupeKey = budgetThresholdDedupeKey(c.budget.id, c.pct, c.periodKey);
    for (const a of matching) {
      const inserted = (await tx.execute(sql`
        insert into alert_events (org_id, alert_id, fired_at, dedupe_key, payload)
        values (${orgId}::uuid, ${a.id}::uuid, ${now.toISOString()}, ${dedupeKey},
                ${JSON.stringify(payload)}::jsonb)
        on conflict (alert_id, dedupe_key) do nothing
        returning id`)) as unknown as { id: string }[];
      fired += inserted.length;
    }
  }
  return fired;
}
