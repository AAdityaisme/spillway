import { v5 as uuidv5 } from 'uuid';
import type { ProviderName } from '../routing/compile.js';

/**
 * Budget resolver v2 (17 §1.3/§1.7/§1.8/§1.13, ADR-036/038). Ported verbatim from the red-teamed
 * lab — pure, no DB read (budget definitions travel in the bundle; only counter VALUES are read
 * fresh, snapshot.ts).
 *
 * resolveBudgetBundle is the SINGLE cascade shared by BUDGET (§2), threshold alerting (§5), and the
 * guardrail spend.* read layer (16) — never two parallel cascades (the LiteLLM drift bug). It emits
 * the applicable budgets in deterministic order (inner→outer scope, day→month→rolling_30d, provider
 * last), each paired with its period key + counter key, so every consumer sees the same list.
 */

export type BudgetScopeType = 'org' | 'team' | 'virtual_key' | 'provider';
export type BudgetPeriod = 'day' | 'month' | 'rolling_30d';
export type BudgetMode = 'enforce' | 'alert' | 'monitor';
export type OnExceed = 'block' | 'fallback';

/** One budgets row, money pre-parsed to bigint µUSD (never parseFloat; §2.2). */
export interface BudgetRow {
  id: string;
  scopeType: BudgetScopeType;
  scopeId: string;
  period: BudgetPeriod;
  limitMicroUsd: bigint;
  mode: BudgetMode;
  onExceed: OnExceed;
  fallbackAlias: string | null;
  createdAt: Date; // rolling_30d anchor (§1.7); immutable for the life of the row
}

/** The budget-side slice of the bundle (17 owns this; 15's PolicyBundle is routing). */
export interface BudgetBundle {
  orgId: string;
  teamId: string | null;
  virtualKeyId: string;
  budgets: BudgetRow[];
}

export interface ResolvedBudget {
  budget: BudgetRow;
  counterKey: string; // `${scopeType}:${scopeId}:${periodKey}`
  periodKey: string; // '2026-07' | '2026-07-04' | 'r30:2026-06-14'
}

/** A spend_counters PK tuple for the hoisted snapshot read (§3.1). */
export interface CounterTuple {
  scopeType: string;
  scopeId: string;
  periodKey: string;
}

/** 17 §1.8 — deterministic provider scope id: uuidv5(provider, orgId). Stable, collision-free. */
export function providerScopeId(orgId: string, provider: ProviderName): string {
  return uuidv5(provider, orgId);
}

/**
 * 17 §1.7 — current rolling_30d block-start key: a fixed 30-day window anchored to the budget's
 * creation date, advancing in 30-day steps (NOT a trailing sum — forbidden on the hot path, ADR-007).
 */
export function rolling30Key(anchor: Date, now: Date): string {
  const a = Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), anchor.getUTCDate());
  const n = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const blockIdx = Math.floor((n - a) / (30 * 86_400_000)); // >= 0
  const startMs = a + blockIdx * 30 * 86_400_000;
  return 'r30:' + new Date(startMs).toISOString().slice(0, 10);
}

/** 17 §1.13 — UTC calendar keys. Rolling keys are per-budget (need the anchor). */
export function currentPeriodKeys(now: Date): { day: string; month: string } {
  const iso = now.toISOString(); // always UTC
  return { month: iso.slice(0, 7), day: iso.slice(0, 10) };
}

/**
 * Total rank over scope types — two uses, one order:
 *  1. §2.2 specificity — the most-specific scope (virtual_key) is the one reported to the caller.
 *  2. spend_counters LOCK-ACQUISITION ORDER (red-team money-core #1) — EVERY writer of the shared
 *     spend_counters tuples (reconcile's spend upsert, reserveBudget, releaseBudgetReservation,
 *     logBlockedRequest, writeGuardrailBlock) MUST order its (scope × period) rows by this rank, as a
 *     SINGLE multi-row statement whose VALUES follow the rank. Two writers touching the same
 *     org+team tuples in OPPOSITE order deadlock (ABBA, 40P01); the reconcile victim then loses the spend
 *     row after retry exhaustion. Sorting by a total rank makes lock order independent of how each writer
 *     ASSEMBLES its scope list, so a future insertion in the wrong position can't reintroduce the inversion.
 */
export const SCOPE_RANK: Record<BudgetScopeType, number> = {
  virtual_key: 0,
  team: 1,
  org: 2,
  provider: 3,
};
const PERIOD_RANK: Record<BudgetPeriod, number> = { day: 0, month: 1, rolling_30d: 2 };

/**
 * 17 §4.2/§2.5 — the counter period-key set every spend_counters writer bumps: month + day + any
 * active rolling_30d key. ONE impl on purpose: reconcile, reserve/release, the budget blocked-writer,
 * and the guardrail blocked-writer all derive their multi-row VALUES order from this list — divergent
 * copies would fork the canonical lock order and reopen the ABBA deadlock (red-team B3-3 class).
 */
export function counterPeriodKeys(
  budgets: ReadonlyArray<{ period: string; createdAt: string | Date }>,
  now: Date,
): string[] {
  const { month, day } = currentPeriodKeys(now);
  const keys = new Set<string>([month, day]);
  for (const b of budgets) {
    if (b.period === 'rolling_30d') keys.add(rolling30Key(new Date(b.createdAt), now));
  }
  return [...keys];
}

/** Is `b` in scope? Provider budgets are always collected (BUDGET filters to the served head
 *  provider, §2.2); `customer` is reserved and never resolved in v1 (§1.9). */
function applies(b: BudgetRow, bundle: BudgetBundle): boolean {
  switch (b.scopeType) {
    case 'virtual_key':
      return b.scopeId === bundle.virtualKeyId;
    case 'team':
      return bundle.teamId !== null && b.scopeId === bundle.teamId;
    case 'org':
      return b.scopeId === bundle.orgId;
    case 'provider':
      return true;
  }
}

function periodKeyFor(b: BudgetRow, now: Date): string {
  if (b.period === 'rolling_30d') return rolling30Key(b.createdAt, now);
  const keys = currentPeriodKeys(now);
  return b.period === 'day' ? keys.day : keys.month;
}

/**
 * 17 §1.3 — collect + order the applicable budgets. Deterministic: inner→outer scope, day→month→
 * rolling_30d within a scope, provider last. Ties broken by input order (stable) so the list is
 * identical across BUDGET, alerting, and chargeback.
 */
export function resolveBudgetBundle(bundle: BudgetBundle, now: Date): ResolvedBudget[] {
  const applicable = bundle.budgets.filter((b) => applies(b, bundle));
  const indexed = applicable.map((budget, i) => ({ budget, i }));
  indexed.sort((x, y) => {
    const s = SCOPE_RANK[x.budget.scopeType] - SCOPE_RANK[y.budget.scopeType];
    if (s !== 0) return s;
    const p = PERIOD_RANK[x.budget.period] - PERIOD_RANK[y.budget.period];
    if (p !== 0) return p;
    return x.i - y.i;
  });
  return indexed.map(({ budget }) => {
    const periodKey = periodKeyFor(budget, now);
    return { budget, periodKey, counterKey: `${budget.scopeType}:${budget.scopeId}:${periodKey}` };
  });
}

/** The unique spend_counters PK tuples to hoist-read for a resolved bundle (§3.1). */
export function budgetCounterTuples(resolved: ResolvedBudget[]): CounterTuple[] {
  const seen = new Set<string>();
  const out: CounterTuple[] = [];
  for (const r of resolved) {
    if (seen.has(r.counterKey)) continue;
    seen.add(r.counterKey);
    out.push({ scopeType: r.budget.scopeType, scopeId: r.budget.scopeId, periodKey: r.periodKey });
  }
  return out;
}
