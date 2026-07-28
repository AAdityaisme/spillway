import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Download, FileText } from 'lucide-react';
import { useMemo, useState } from 'react';
import { SectionError } from '../components/domain/SectionError.js';
import { PageHeader } from '../components/layout/PageHeader.js';
import { Badge } from '../components/primitives/Badge.js';
import { Button } from '../components/primitives/Button.js';
import { Callout } from '../components/primitives/Callout.js';
import { Card } from '../components/primitives/Card.js';
import { EmptyState } from '../components/primitives/EmptyState.js';
import { MonthPicker } from '../components/primitives/MonthPicker.js';
import { PlanGate } from '../components/primitives/PlanGate.js';
import { Stat } from '../components/primitives/Stat.js';
import { Table, type Column } from '../components/primitives/Table.js';
import { Tooltip } from '../components/primitives/Tooltip.js';
import { api, ApiError, type ChargebackLine, type ChargebackStatement } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';
import { formatCount, recentMonths, usd } from '../lib/format.js';

type GroupBy = 'team' | 'virtual_key' | 'model';

const GROUPS: Array<{ value: GroupBy; label: string }> = [
  { value: 'team', label: 'Team' },
  { value: 'virtual_key', label: 'Key' },
  { value: 'model', label: 'Model' },
];

/** "YYYY-MM" -> the statement window: start inclusive, end exclusive (next month's 1st — 04-api §20). */
function monthRange(period: string): { start: string; end: string } {
  const [y, m] = period.split('-').map(Number);
  return {
    start: `${period}-01`,
    end: new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10),
  };
}

/**
 * Reconciliation strip: pass badge when the request-row total and the attempt-ledger total agree
 * to the cent; amber + the raw warning text otherwise — this is the finance-grade proof surface,
 * so a mismatch is never swallowed (CONTEXT directive, bible §3.13).
 */
function ReconciliationStrip({
  reconciliation,
}: {
  reconciliation: ChargebackStatement['reconciliation'];
}) {
  const reconciled = reconciliation.consistent && reconciliation.counterConsistent !== false;

  if (reconciled) {
    return (
      <Card padding="sm" className="mt-4 flex items-center">
        <Tooltip
          content={`Σ(request rows) = Σ(attempt ledger): ${usd(reconciliation.requestsUsd)} = ${usd(reconciliation.attemptsUsd)}`}
        >
          <span>
            <Badge variant="pass" dot>
              Reconciled to the cent
            </Badge>
          </span>
        </Tooltip>
      </Card>
    );
  }

  const warnings = [reconciliation.warning, reconciliation.counterWarning].filter(
    (w): w is string => !!w,
  );
  return (
    <div className="mt-4">
      <Callout title="Reconciliation warning">
        {warnings.length > 0 ? (
          warnings.map((w, i) => <p key={i}>{w}</p>)
        ) : (
          <p>Totals do not reconcile — investigate before sending this statement.</p>
        )}
      </Callout>
    </div>
  );
}

/**
 * Chargeback report (bible §3.13, admin+ + `chargeback` entitlement). Adaptation vs bible: the
 * CSV download has no separate token/status endpoint — it's a plain GET with format=csv, so the
 * button is a useMutation wrapping apiDownload purely for the loading flag; the global
 * mutationCache toast already covers failures, no manual try/catch needed.
 */
export function ReportsPage() {
  const { session, activeOrgId } = useAuth();
  const enabled = !!session && !!activeOrgId;

  // Default to the current month-to-date: the reconciliation strip already distinguishes
  // an accruing month from a complete one, and an empty prior month demos nothing.
  const [period, setPeriod] = useState(() => recentMonths(1)[0] ?? '');
  const [groupBy, setGroupBy] = useState<GroupBy>('virtual_key');
  const { start, end } = monthRange(period);

  const teamsQ = useQuery({
    queryKey: [activeOrgId, 'teams'],
    queryFn: api.listTeams,
    enabled: enabled && groupBy === 'team',
  });
  const keysQ = useQuery({
    queryKey: [activeOrgId, 'virtual-keys'],
    queryFn: api.listVirtualKeys,
    enabled: enabled && groupBy === 'virtual_key',
  });
  const chargebackQ = useQuery({
    queryKey: [activeOrgId, 'chargeback', { start, end, groupBy }],
    queryFn: () => api.getChargeback({ start, end, group_by: groupBy }),
    enabled,
  });
  // Free plans 402 here — that's expected, not an error state, so no retry storm and no toast.
  const insightsQ = useQuery({
    queryKey: [activeOrgId, 'insights'],
    queryFn: api.getInsights,
    enabled,
    retry: false,
  });

  const downloadMutation = useMutation({
    mutationFn: () => api.downloadChargebackCsv({ start, end, group_by: groupBy }),
  });

  const teamNames = useMemo(
    () => new Map((teamsQ.data?.teams ?? []).map((t) => [t.id, t.name])),
    [teamsQ.data],
  );
  const keyNames = useMemo(
    () => new Map((keysQ.data?.virtualKeys ?? []).map((k) => [k.id, k.name])),
    [keysQ.data],
  );
  const scopeName = (line: ChargebackLine): string => {
    if (line.scopeId === null) return '(unattributed)';
    if (groupBy === 'model') return line.scopeId;
    if (groupBy === 'team') return teamNames.get(line.scopeId) ?? line.scopeId;
    return keyNames.get(line.scopeId) ?? line.scopeId;
  };

  const statement = chargebackQ.data?.statement;
  const lines = useMemo(
    () => [...(statement?.lines ?? [])].sort((a, b) => Number(b.costUsd) - Number(a.costUsd)),
    [statement],
  );
  const totals = useMemo(
    () =>
      lines.reduce(
        (acc, l) => ({
          requests: acc.requests + l.requestCount,
          blocked: acc.blocked + l.blockedCount,
        }),
        { requests: 0, blocked: 0 },
      ),
    [lines],
  );

  const rawInsight = insightsQ.data?.insight ?? null;
  // Zero-coverage analyses aren't findings — same suppression rule as the Insights page.
  const insight =
    rawInsight && Number(rawInsight.summary?.['requests_analyzed'] ?? 1) === 0 ? null : rawInsight;
  const insightGated = insightsQ.error instanceof ApiError && insightsQ.error.status === 402;

  const columns: Column<ChargebackLine>[] = [
    { key: 'scope', header: 'Scope', render: (l) => scopeName(l) },
    {
      key: 'requests',
      header: 'Requests',
      align: 'right',
      render: (l) => <span className="num">{formatCount(l.requestCount)}</span>,
    },
    {
      key: 'success',
      header: 'Success',
      align: 'right',
      render: (l) => <span className="num">{formatCount(l.successCount)}</span>,
    },
    {
      key: 'blocked',
      header: 'Blocked',
      align: 'right',
      render: (l) => (
        <span className={`num ${l.blockedCount > 0 ? 'text-[var(--amber)]' : ''}`}>
          {formatCount(l.blockedCount)}
        </span>
      ),
    },
    {
      key: 'cost',
      header: 'Cost',
      align: 'right',
      render: (l) => <span className="num">{usd(l.costUsd)}</span>,
    },
  ];

  return (
    <PlanGate feature="chargeback" label="Chargeback reports">
      <div>
        <PageHeader
          title="Reports"
          sub="Finance-grade chargeback, reconciled to the cent."
          actions={
            <>
              <div className="flex gap-1">
                {GROUPS.map((g) => (
                  <button
                    key={g.value}
                    type="button"
                    data-testid={`reports-groupby-${g.value}`}
                    onClick={() => setGroupBy(g.value)}
                    className={`focus-ring rounded-full px-3 py-1 font-mono text-[11px] font-medium transition-colors ${
                      groupBy === g.value
                        ? 'bg-[var(--blue)] text-white'
                        : 'bg-[var(--card)] text-[var(--ink-mut)] shadow-[inset_0_0_0_1px_var(--line)] hover:text-[var(--ink)]'
                    }`}
                  >
                    {g.label}
                  </button>
                ))}
              </div>
              <MonthPicker value={period} onChange={setPeriod} />
              <Button
                variant="ghost"
                size="sm"
                icon={<Download size={14} aria-hidden />}
                loading={downloadMutation.isPending}
                data-testid="reports-download-csv-btn"
                onClick={() => downloadMutation.mutate()}
              >
                Download CSV
              </Button>
            </>
          }
        />

        {chargebackQ.error ? (
          <SectionError error={chargebackQ.error} onRetry={() => void chargebackQ.refetch()} />
        ) : (
          <>
            <div className="grid grid-cols-3 gap-4">
              <Stat
                label="Total spend"
                value={statement ? usd(statement.totalCostUsd) : '—'}
                loading={chargebackQ.isLoading}
                testId="reports-stat-total"
              />
              <Stat
                label="Requests"
                value={statement ? formatCount(totals.requests) : '—'}
                loading={chargebackQ.isLoading}
                testId="reports-stat-requests"
              />
              <Stat
                label="Blocked"
                value={statement ? formatCount(totals.blocked) : '—'}
                tone={totals.blocked > 0 ? 'amber' : 'default'}
                loading={chargebackQ.isLoading}
                testId="reports-stat-blocked"
              />
            </div>

            {statement ? <ReconciliationStrip reconciliation={statement.reconciliation} /> : null}

            {insight && !insightGated ? (
              <div className="mt-4 rounded-[var(--radius-card)] bg-[var(--blue-soft)] px-4 py-3 text-sm text-[var(--blue)]">
                Spillway's weekly analysis found downgradable spend for {insight.period}.{' '}
                <Link
                  to="/insights"
                  className="focus-ring font-semibold underline underline-offset-2"
                >
                  View details →
                </Link>
              </div>
            ) : null}

            <div className="mt-4">
              <Table
                columns={columns}
                data={lines}
                rowKey={(l) => `${l.scopeType}:${l.scopeId ?? 'null'}`}
                loading={chargebackQ.isLoading}
                testId="reports-lines-table"
                empty={
                  <EmptyState
                    icon={<FileText size={20} />}
                    headline="No requests in this period."
                    body="The chargeback statement covers completed requests in the selected month, attributed to the team, key, and model that served them."
                  />
                }
              />
            </div>
          </>
        )}
      </div>
    </PlanGate>
  );
}
