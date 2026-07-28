import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, KeyRound, Users, Wallet } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { BudgetBar } from '../components/domain/BudgetBar.js';
import { SectionError } from '../components/domain/SectionError.js';
import { PageHeader } from '../components/layout/PageHeader.js';
import { Badge } from '../components/primitives/Badge.js';
import { Button } from '../components/primitives/Button.js';
import { Card } from '../components/primitives/Card.js';
import { Field, Input } from '../components/primitives/Field.js';
import { Select } from '../components/primitives/Select.js';
import { Skeleton } from '../components/primitives/Skeleton.js';
import {
  api,
  type Budget,
  type BudgetPeriod,
  type BudgetScopeType,
  type CreateBudgetInput,
} from '../lib/api.js';
import { useAuth } from '../lib/auth.js';
import { useOrg } from '../lib/org.js';
import { usd } from '../lib/format.js';

interface ScopeNode {
  scopeType: BudgetScopeType;
  scopeId: string;
  name: string;
  depth: 0 | 1 | 2;
}

const PERIODS: Array<{ value: BudgetPeriod; label: string }> = [
  { value: 'month', label: 'Monthly' },
  { value: 'day', label: 'Daily' },
  { value: 'rolling_30d', label: 'Rolling 30d' },
];

const MODES = [
  {
    value: 'enforce',
    label: 'Enforce',
    desc: 'Blocks requests when exceeded — the caller gets HTTP 402 before a token is spent.',
  },
  { value: 'alert', label: 'Alert', desc: 'Fires alerts at the threshold but never blocks.' },
  { value: 'monitor', label: 'Monitor', desc: 'Tracks spend silently. No alerts, no blocks.' },
] as const;

const MODE_BADGE: Record<string, 'blue' | 'amber' | 'neutral'> = {
  enforce: 'blue',
  alert: 'amber',
  monitor: 'neutral',
};

function ScopeIcon({ type }: { type: BudgetScopeType }) {
  if (type === 'org') return <Building2 size={14} aria-hidden />;
  if (type === 'team') return <Users size={14} aria-hidden />;
  return <KeyRound size={14} aria-hidden />;
}

/**
 * Budget tree (bible §3.9) — THE differentiator: the org→team→key cascade with live
 * utilization. Spend comes exclusively from the KPI aggregate (budgetUtilization);
 * limits/modes from /budgets. Selecting any node opens the editor pane.
 */
export function BudgetsPage() {
  const { session, activeOrgId } = useAuth();
  const { entitlements } = useOrg();
  const queryClient = useQueryClient();
  const enabled = !!session && !!activeOrgId;

  const budgetsQ = useQuery({
    queryKey: [activeOrgId, 'budgets'],
    queryFn: api.listBudgets,
    enabled,
  });
  const teamsQ = useQuery({ queryKey: [activeOrgId, 'teams'], queryFn: api.listTeams, enabled });
  const keysQ = useQuery({
    queryKey: [activeOrgId, 'virtual-keys'],
    queryFn: api.listVirtualKeys,
    enabled,
  });
  const overviewQ = useQuery({
    queryKey: [activeOrgId, 'kpi-overview', undefined],
    queryFn: () => api.getOverview(),
    enabled,
  });

  const [selected, setSelected] = useState<ScopeNode | null>(null);
  const [period, setPeriod] = useState<BudgetPeriod>('month');
  const [limit, setLimit] = useState('');
  const [mode, setMode] = useState<'enforce' | 'alert' | 'monitor'>('enforce');
  const [onExceed, setOnExceed] = useState<'block' | 'fallback'>('block');
  const [fallbackAlias, setFallbackAlias] = useState('');

  const budgets = budgetsQ.data?.budgets ?? [];
  const utilization = overviewQ.data?.budgetUtilization ?? [];

  const nodes = useMemo<ScopeNode[]>(() => {
    if (!activeOrgId) return [];
    const teams = teamsQ.data?.teams ?? [];
    const keys = keysQ.data?.virtualKeys.filter((k) => k.status !== 'revoked') ?? [];
    const out: ScopeNode[] = [
      { scopeType: 'org', scopeId: activeOrgId, name: 'Organization', depth: 0 },
    ];
    for (const t of teams) {
      out.push({ scopeType: 'team', scopeId: t.id, name: t.name, depth: 1 });
      for (const k of keys.filter((k) => k.teamId === t.id)) {
        out.push({ scopeType: 'virtual_key', scopeId: k.id, name: k.name, depth: 2 });
      }
    }
    const orphanDepth = teams.length > 0 ? 2 : 1;
    for (const k of keys.filter((k) => !k.teamId || !teams.some((t) => t.id === k.teamId))) {
      out.push({
        scopeType: 'virtual_key',
        scopeId: k.id,
        name: k.name,
        depth: orphanDepth as 1 | 2,
      });
    }
    return out;
  }, [activeOrgId, teamsQ.data, keysQ.data]);

  const budgetFor = (n: ScopeNode, p: BudgetPeriod): Budget | undefined =>
    budgets.find((b) => b.scopeType === n.scopeType && b.scopeId === n.scopeId && b.period === p);
  const utilFor = (n: ScopeNode, p: BudgetPeriod) =>
    utilization.find(
      (u) => u.scopeType === n.scopeType && u.scopeId === n.scopeId && u.period === p,
    );

  const select = (n: ScopeNode): void => {
    setSelected(n);
    // Prefill from the node's existing budget, preferring the monthly row.
    const existing = budgetFor(n, 'month') ?? budgetFor(n, 'day') ?? budgetFor(n, 'rolling_30d');
    if (existing) {
      setPeriod(existing.period);
      setLimit(existing.limitUsd.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, ''));
      setMode(existing.mode);
      setOnExceed(existing.onExceed);
      setFallbackAlias(existing.fallbackAlias ?? '');
    } else {
      setPeriod('month');
      setLimit('');
      setMode('enforce');
      setOnExceed('block');
      setFallbackAlias('');
    }
  };

  const save = useMutation({
    mutationFn: async () => {
      if (!selected) throw new Error('no scope selected');
      const existing = budgetFor(selected, period);
      if (existing) {
        return api.updateBudget(existing.id, {
          limitUsd: limit,
          mode,
          onExceed,
          fallbackAlias: onExceed === 'fallback' ? fallbackAlias : null,
        });
      }
      const body: CreateBudgetInput = {
        scopeType: selected.scopeType,
        scopeId: selected.scopeId,
        period,
        limitUsd: limit,
        mode,
        onExceed,
      };
      if (onExceed === 'fallback') body.fallbackAlias = fallbackAlias;
      return api.createBudget(body);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [activeOrgId, 'budgets'] });
      void queryClient.invalidateQueries({ queryKey: [activeOrgId, 'kpi-overview'] });
      toast.success('Budget saved.');
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteBudget(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [activeOrgId, 'budgets'] });
      void queryClient.invalidateQueries({ queryKey: [activeOrgId, 'kpi-overview'] });
      toast.success('Budget removed.');
      setSelected(null);
    },
  });

  const loading = budgetsQ.isLoading || teamsQ.isLoading || keysQ.isLoading;
  const existingForSelection = selected ? budgetFor(selected, period) : undefined;
  const validLimit = /^\d{1,8}(\.\d{1,6})?$/.test(limit) && Number(limit) > 0;
  const hierarchyGated =
    selected !== null && selected.scopeType !== 'org' && !entitlements.has('hierarchical_budgets');

  return (
    <div>
      <PageHeader
        title="Budgets"
        sub="Hard limits that cascade org → team → key. A blocked request costs nothing."
      />

      {budgetsQ.error ? (
        <SectionError error={budgetsQ.error} onRetry={() => void budgetsQ.refetch()} />
      ) : (
        <div className="grid gap-5 lg:grid-cols-[1fr_340px]">
          <div className="flex flex-col gap-2.5">
            {loading
              ? Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-20 w-full" />)
              : nodes.map((n) => {
                  const b =
                    budgetFor(n, 'month') ?? budgetFor(n, 'day') ?? budgetFor(n, 'rolling_30d');
                  const u = b ? utilFor(n, b.period) : undefined;
                  const isSelected =
                    selected?.scopeType === n.scopeType && selected.scopeId === n.scopeId;
                  return (
                    <div key={`${n.scopeType}:${n.scopeId}`} style={{ marginLeft: n.depth * 28 }}>
                      <button
                        type="button"
                        onClick={() => select(n)}
                        data-testid={
                          n.scopeType === 'org'
                            ? 'budgets-tree-org-node'
                            : `budgets-node-${n.scopeId}`
                        }
                        className={`focus-ring card-lift w-full rounded-[var(--radius-card)] bg-[var(--card)] p-4 text-left shadow-[var(--shadow-card)] ${
                          isSelected
                            ? 'shadow-[var(--shadow-card),inset_0_0_0_1.5px_var(--blue)]'
                            : ''
                        }`}
                      >
                        <div className="flex items-center gap-2.5">
                          <span className="text-[var(--ink-mut)]">
                            <ScopeIcon type={n.scopeType} />
                          </span>
                          <span className="text-[13px] font-medium">{n.name}</span>
                          {b ? (
                            <>
                              <Badge variant={MODE_BADGE[b.mode] ?? 'neutral'}>{b.mode}</Badge>
                              <span className="num text-[11px] text-[var(--ink-mut)]">
                                {PERIODS.find((p) => p.value === b.period)?.label.toLowerCase()}
                              </span>
                              {b.onExceed === 'fallback' ? (
                                <Badge variant="neutral">fallback</Badge>
                              ) : null}
                            </>
                          ) : (
                            <span className="text-[11px] text-[var(--ink-mut)]">No budget set</span>
                          )}
                          <span className="ml-auto font-mono text-[11px] text-[var(--blue)]">
                            {b ? 'Edit' : 'Add budget'}
                          </span>
                        </div>
                        {b ? (
                          <div className="mt-3" data-testid={`budget-bar-${n.scopeId}`}>
                            {u ? (
                              <BudgetBar spentUsd={u.spentUsd} limitUsd={u.limitUsd} pct={u.pct} />
                            ) : (
                              <div className="num flex justify-between text-xs text-[var(--ink-mut)]">
                                <span>limit {usd(b.limitUsd)}</span>
                                <span>no spend recorded this period</span>
                              </div>
                            )}
                          </div>
                        ) : null}
                      </button>
                    </div>
                  );
                })}
            {!loading && nodes.length <= 1 && (keysQ.data?.virtualKeys.length ?? 0) === 0 ? (
              <Card>
                <p className="text-sm text-[var(--ink-mut)]">
                  Create teams and virtual keys to build out the cascade — budgets attach to any
                  level.
                </p>
              </Card>
            ) : null}
          </div>

          <div>
            {selected ? (
              <Card className="sticky top-4">
                <div className="eyebrow">{existingForSelection ? 'Edit budget' : 'New budget'}</div>
                <div className="mt-1.5 flex items-center gap-2 text-[13px] font-medium">
                  <ScopeIcon type={selected.scopeType} />
                  {selected.name}
                </div>

                {hierarchyGated ? (
                  <p className="mt-3 rounded-[var(--radius-btn)] bg-[var(--blue-soft)] p-3 text-xs text-[var(--blue)]">
                    Team and key budgets — the cascade — are a Governance-plan feature. Org-level
                    budgets are available on every paid plan.
                  </p>
                ) : null}

                <div className="mt-4 flex flex-col gap-4">
                  <Field label="Period" htmlFor="budget-period">
                    <Select
                      id="budget-period"
                      value={period}
                      onValueChange={(v) => {
                        const p = v as BudgetPeriod;
                        setPeriod(p);
                        const existing = selected ? budgetFor(selected, p) : undefined;
                        if (existing) {
                          setLimit(
                            existing.limitUsd.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, ''),
                          );
                          setMode(existing.mode);
                          setOnExceed(existing.onExceed);
                          setFallbackAlias(existing.fallbackAlias ?? '');
                        }
                      }}
                      options={PERIODS.map((p) => ({ value: p.value, label: p.label }))}
                    />
                  </Field>
                  <Field
                    label="Limit (USD)"
                    htmlFor="budget-limit"
                    error={
                      limit && !validLimit
                        ? 'Enter a positive dollar amount, e.g. 250 or 99.50'
                        : null
                    }
                  >
                    <Input
                      id="budget-limit"
                      data-testid="budgets-limit-input"
                      value={limit}
                      onChange={(e) => setLimit(e.target.value)}
                      placeholder="250"
                      className="num"
                      inputMode="decimal"
                    />
                  </Field>
                  <fieldset>
                    <legend className="text-[13px] font-medium">Mode</legend>
                    <div className="mt-1.5 flex flex-col gap-2">
                      {MODES.map((m) => (
                        <label key={m.value} className="flex cursor-pointer items-start gap-2.5">
                          <input
                            type="radio"
                            name="budget-mode"
                            value={m.value}
                            checked={mode === m.value}
                            onChange={() => setMode(m.value)}
                            className="mt-1 accent-[var(--blue)]"
                          />
                          <span>
                            <span className="text-[13px] font-medium">{m.label}</span>
                            <span className="block text-xs text-[var(--ink-mut)]">{m.desc}</span>
                          </span>
                        </label>
                      ))}
                    </div>
                  </fieldset>
                  {mode === 'enforce' ? (
                    <Field
                      label="When exceeded"
                      htmlFor="budget-onexceed"
                      hint={
                        onExceed === 'fallback'
                          ? 'Serve-under-fallback routes overflow traffic to a cheaper alias instead of blocking (Governance).'
                          : undefined
                      }
                    >
                      <Select
                        id="budget-onexceed"
                        value={onExceed}
                        onValueChange={(v) => setOnExceed(v as 'block' | 'fallback')}
                        options={[
                          { value: 'block', label: 'Block (HTTP 402)' },
                          { value: 'fallback', label: 'Serve via fallback alias' },
                        ]}
                      />
                    </Field>
                  ) : null}
                  {mode === 'enforce' && onExceed === 'fallback' ? (
                    <Field label="Fallback alias" htmlFor="budget-fallback">
                      <Input
                        id="budget-fallback"
                        value={fallbackAlias}
                        onChange={(e) => setFallbackAlias(e.target.value)}
                        placeholder="spillway/cheap"
                        className="font-mono text-xs"
                      />
                    </Field>
                  ) : null}
                  <div className="flex items-center justify-between gap-2 border-t border-[var(--line)] pt-4">
                    {existingForSelection ? (
                      <Button
                        variant="danger-ghost"
                        size="sm"
                        loading={remove.isPending}
                        onClick={() => remove.mutate(existingForSelection.id)}
                      >
                        Remove
                      </Button>
                    ) : (
                      <span />
                    )}
                    <Button
                      onClick={() => save.mutate()}
                      loading={save.isPending}
                      disabled={!validLimit || (onExceed === 'fallback' && !fallbackAlias.trim())}
                      data-testid="budgets-save-btn"
                    >
                      Save budget
                    </Button>
                  </div>
                </div>
              </Card>
            ) : (
              <Card className="sticky top-4">
                <div className="eyebrow">Budget editor</div>
                <p className="mt-2 text-sm text-[var(--ink-mut)]">
                  Select any node in the tree to add or edit its budget. Monthly, daily, and
                  rolling-30-day budgets are independent — a key can carry all three.
                </p>
                <p className="mt-3 flex items-center gap-2 text-xs text-[var(--ink-mut)]">
                  <Wallet size={13} aria-hidden />
                  Enforce mode returns 402 before a single token reaches the provider.
                </p>
              </Card>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
