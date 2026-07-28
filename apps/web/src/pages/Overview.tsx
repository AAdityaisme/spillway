import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { LayoutDashboard } from 'lucide-react';
import { Suspense, lazy, useState } from 'react';
import { OdometerUsd } from '../components/domain/OdometerUsd.js';
import { SectionError } from '../components/domain/SectionError.js';
import { PageHeader } from '../components/layout/PageHeader.js';
import { Badge } from '../components/primitives/Badge.js';
import { Card } from '../components/primitives/Card.js';
import { EmptyState } from '../components/primitives/EmptyState.js';
import { MonthPicker } from '../components/primitives/MonthPicker.js';
import { Skeleton } from '../components/primitives/Skeleton.js';
import { Stat } from '../components/primitives/Stat.js';
import { api, type BudgetUtilization, type TopModel } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';
import { currentMonth, formatCount, pct, usd } from '../lib/format.js';

// Recharts stays out of the initial bundle (09-frontend §7.3).
const SpendChart = lazy(() => import('../components/charts/SpendChart.js'));

/** Chart window for a selected period: first of month → today (current) or month end (past). */
function periodWindow(period: string): { start: string; end: string } {
  const start = `${period}-01`;
  if (period === currentMonth()) return { start, end: new Date().toISOString().slice(0, 10) };
  const [y, m] = period.split('-').map(Number);
  const lastDay = new Date(Date.UTC(y as number, m as number, 0)).getUTCDate();
  return { start, end: `${period}-${String(lastDay).padStart(2, '0')}` };
}

/** Signed % change of two numeric-string money values; null when the base is zero. */
function deltaPct(cur: string, prev: string): { value: string; positive: boolean } | undefined {
  const p = Number(prev);
  if (p === 0) return undefined;
  const d = ((Number(cur) - p) / p) * 100;
  return { value: `${d >= 0 ? '+' : ''}${d.toFixed(1)}% vs prev`, positive: d <= 0 };
}

function budgetColor(p: number): string {
  if (p >= 90) return 'var(--danger)';
  if (p >= 70) return 'var(--amber)';
  return 'var(--blue)';
}

function BudgetRow({ b }: { b: BudgetUtilization }) {
  return (
    <Link
      to="/budgets"
      className="focus-ring -mx-2 flex flex-col gap-1.5 rounded-[var(--radius-btn)] px-2 py-3 transition-colors hover:bg-[var(--paper)]"
    >
      <div className="flex items-baseline justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-[13px] font-medium">{b.scopeName}</span>
          <Badge variant={b.mode === 'enforce' ? 'blue' : b.mode === 'alert' ? 'amber' : 'neutral'}>
            {b.mode}
          </Badge>
          <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--ink-mut)]">
            {b.scopeType} · {b.period}
          </span>
        </div>
        <span className="num shrink-0 text-xs text-[var(--ink-mut)]">
          {usd(b.spentUsd)} / {usd(b.limitUsd)}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[rgba(11,18,32,0.07)]">
          <div
            className="h-full rounded-full"
            style={{ width: `${Math.min(100, b.pct)}%`, background: budgetColor(b.pct) }}
          />
        </div>
        <span
          className="num w-10 shrink-0 text-right text-xs font-medium"
          style={{ color: budgetColor(b.pct) }}
        >
          {b.pct.toFixed(0)}%
        </span>
      </div>
    </Link>
  );
}

function ModelRow({ m, max }: { m: TopModel; max: number }) {
  const width = max > 0 ? (Number(m.spendUsd) / max) * 100 : 0;
  return (
    <div className="flex items-center gap-3 py-2.5">
      <div className="w-44 shrink-0 truncate">
        <div className="num truncate text-[12.5px] font-medium">{m.model}</div>
        <div className="font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--ink-mut)]">
          {m.provider}
        </div>
      </div>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[rgba(11,18,32,0.07)]">
        <div
          className="h-full rounded-full bg-[var(--blue)]"
          style={{ width: `${Math.max(2, width)}%` }}
        />
      </div>
      <div className="w-24 shrink-0 text-right">
        <div className="num text-[12.5px]">{usd(m.spendUsd)}</div>
        <div className="num text-[11px] text-[var(--ink-mut)]">
          {m.pctOfTotal.toFixed(0)}% · {formatCount(m.requestCount)}
        </div>
      </div>
    </div>
  );
}

/**
 * Overview (bible §3.4): how much am I spending, is anything wrong, where is it going.
 * All figures from the KPI aggregates — never row-fetch-and-reduce client-side.
 */
export function OverviewPage() {
  const { session, activeOrgId } = useAuth();
  const enabled = !!session && !!activeOrgId;
  const [period, setPeriod] = useState(currentMonth());
  const win = periodWindow(period);

  const overview = useQuery({
    queryKey: [activeOrgId, 'kpi-overview', period === currentMonth() ? undefined : period],
    queryFn: () => api.getOverview(period === currentMonth() ? undefined : period),
    enabled,
  });
  const timeseries = useQuery({
    queryKey: [activeOrgId, 'spend-ts', win.start, win.end],
    queryFn: () => api.getSpendTimeseries({ start: win.start, end: win.end }),
    enabled,
  });

  const o = overview.data;
  const [metric, setMetric] = useState<'spend' | 'requests'>('spend');
  const points = (timeseries.data?.points ?? []).map((p) => ({
    date: p.date.slice(5),
    spend: Number(p.spendUsd),
    requests: p.requestCount,
  }));
  const maxModel = o ? Math.max(0, ...o.topModels.map((m) => Number(m.spendUsd))) : 0;
  const isEmpty = !!o && o.requestCount === 0 && o.topModels.length === 0;

  return (
    <div>
      <PageHeader
        title="Overview"
        sub="Spend, blocks, and where the money goes."
        actions={<MonthPicker value={period} onChange={setPeriod} />}
      />

      {overview.error ? (
        <SectionError error={overview.error} onRetry={() => void overview.refetch()} />
      ) : isEmpty ? (
        <Card padding="none">
          <EmptyState
            icon={<LayoutDashboard size={20} />}
            headline="Your gateway is ready."
            body="Requests will appear here once traffic flows through Spillway. Point your SDK at the gateway to get started."
            action={{
              label: 'Copy quickstart',
              onClick: () => {
                void navigator.clipboard.writeText(
                  `export OPENAI_BASE_URL=${window.location.origin}/v1\nexport OPENAI_API_KEY=<your-virtual-key>`,
                );
              },
              testId: 'overview-quickstart-btn',
            }}
          />
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Stat
              label="Spend"
              value={o ? <OdometerUsd value={o.spendUsd} /> : '—'}
              loading={overview.isLoading}
              delta={o ? deltaPct(o.spendUsd, o.spendUsdPrevPeriod) : undefined}
              testId="overview-stat-spend"
            />
            <Stat
              label="Requests"
              value={o ? formatCount(o.requestCount) : '—'}
              loading={overview.isLoading}
              hint="billable this period"
            />
            <Stat
              label="Blocked"
              value={o ? formatCount(o.blockedCount) : '—'}
              loading={overview.isLoading}
              tone={o && o.blockedCount > 0 ? 'amber' : 'default'}
              hint={o && o.blockedCount > 0 ? 'caught before spend' : undefined}
              testId="overview-stat-blocked"
            />
            <Stat
              label="Error rate"
              value={o ? pct(o.errorRatePct) : '—'}
              loading={overview.isLoading}
              tone={o && o.errorRatePct >= 5 ? 'amber' : 'default'}
              hint="of completed requests"
            />
          </div>

          <Card className="mt-4">
            <div className="mb-4 flex items-center justify-between gap-3">
              <div className="eyebrow">
                {metric === 'spend' ? 'Spend' : 'Requests'} · {period}
              </div>
              <div className="flex gap-1">
                {(['spend', 'requests'] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setMetric(m)}
                    className={`focus-ring rounded-full px-2.5 py-0.5 font-mono text-[10.5px] font-medium uppercase tracking-[0.08em] transition-colors ${
                      metric === m
                        ? 'bg-[var(--blue-soft)] text-[var(--blue)]'
                        : 'text-[var(--ink-mut)] hover:text-[var(--ink)]'
                    }`}
                  >
                    {m}
                  </button>
                ))}
              </div>
            </div>
            {timeseries.isLoading ? (
              <Skeleton className="h-52 w-full" />
            ) : points.length === 0 ? (
              <div className="flex h-52 items-center justify-center text-sm text-[var(--ink-mut)]">
                No spend recorded in this period.
              </div>
            ) : (
              <Suspense fallback={<Skeleton className="h-52 w-full" />}>
                <SpendChart points={points} metric={metric} />
              </Suspense>
            )}
          </Card>

          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <Card>
              <div className="eyebrow mb-1">Budget utilization</div>
              {overview.isLoading ? (
                <Skeleton className="h-24 w-full" />
              ) : o && o.budgetUtilization.length > 0 ? (
                <div className="divide-y divide-[var(--line)]">
                  {o.budgetUtilization.map((b) => (
                    <BudgetRow key={`${b.scopeType}:${b.scopeId}:${b.period}`} b={b} />
                  ))}
                </div>
              ) : (
                <div className="py-6 text-sm text-[var(--ink-mut)]">
                  No enforcing budgets configured —{' '}
                  <Link to="/budgets" className="text-[var(--blue)] underline">
                    set one
                  </Link>{' '}
                  to make limits real.
                </div>
              )}
            </Card>

            <Card>
              <div className="eyebrow mb-1">Top models by spend</div>
              {overview.isLoading ? (
                <Skeleton className="h-24 w-full" />
              ) : o && o.topModels.length > 0 ? (
                <div className="divide-y divide-[var(--line)]">
                  {o.topModels.map((m) => (
                    <ModelRow key={`${m.provider}:${m.model}`} m={m} max={maxModel} />
                  ))}
                </div>
              ) : (
                <div className="py-6 text-sm text-[var(--ink-mut)]">No traffic in this period.</div>
              )}
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
