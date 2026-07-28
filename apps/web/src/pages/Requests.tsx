import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { ListTree, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { RequestDrawer } from '../components/domain/RequestDrawer.js';
import { SectionError } from '../components/domain/SectionError.js';
import { RequestStatusBadge } from '../components/domain/StatusBadge.js';
import { PageHeader } from '../components/layout/PageHeader.js';
import { Button } from '../components/primitives/Button.js';
import { EmptyState } from '../components/primitives/EmptyState.js';
import { Select } from '../components/primitives/Select.js';
import { Skeleton } from '../components/primitives/Skeleton.js';
import { Table, type Column } from '../components/primitives/Table.js';
import { Tooltip } from '../components/primitives/Tooltip.js';
import { api, type RequestListParams, type RequestLogRow } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';
import { absTime, formatCount, isoDaysAgo, relTime, usd } from '../lib/format.js';

const RANGES = [
  { value: '1', label: 'Last 24 hours' },
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 90 days' },
];

const STATUSES = [
  { value: 'all', label: 'Any status' },
  { value: 'ok', label: 'OK' },
  { value: 'blocked', label: 'Blocked' },
  { value: 'error', label: 'Error' },
  { value: 'rate_limited', label: 'Rate limited' },
];

interface Filters {
  days: string;
  status: string;
  virtualKeyId: string;
  teamId: string;
  model: string;
}

const DEFAULT_FILTERS: Filters = {
  days: '7',
  status: 'all',
  virtualKeyId: 'all',
  teamId: 'all',
  model: '',
};

/**
 * Request log (bible §3.6): retrospective, filter-heavy — the investigation surface.
 * Cursor pagination via useInfiniteQuery; row click opens the shared detail drawer
 * (which carries the routing trace — the audit differentiator).
 */
export function RequestsPage() {
  const { session, activeOrgId } = useAuth();
  const navigate = useNavigate();
  const search = useSearch({ from: '/requests' });
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [modelDraft, setModelDraft] = useState('');
  const openId = search.drawer ?? null;

  const setOpenId = (id: string | null): void => {
    void navigate({ to: '/requests', search: id ? { drawer: id } : {}, replace: true });
  };

  const keysQ = useQuery({
    queryKey: [activeOrgId, 'virtual-keys'],
    queryFn: api.listVirtualKeys,
    enabled: !!session && !!activeOrgId,
  });
  const teamsQ = useQuery({
    queryKey: [activeOrgId, 'teams'],
    queryFn: api.listTeams,
    enabled: !!session && !!activeOrgId,
  });

  const params = useMemo<RequestListParams>(() => {
    const p: RequestListParams = {
      limit: 50,
      start: new Date(`${isoDaysAgo(Number(filters.days))}T00:00:00Z`).toISOString(),
    };
    if (filters.status !== 'all') p.status = filters.status;
    if (filters.virtualKeyId !== 'all') p.virtual_key_id = filters.virtualKeyId;
    if (filters.teamId !== 'all') p.team_id = filters.teamId;
    if (filters.model.trim()) p.model = filters.model.trim();
    return p;
  }, [filters]);

  const q = useInfiniteQuery({
    queryKey: [activeOrgId, 'requests', params],
    queryFn: ({ pageParam }) =>
      api.listRequests({ ...params, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: '',
    getNextPageParam: (last) => last.pagination.next_cursor ?? undefined,
    enabled: !!session && !!activeOrgId,
  });

  const rows = q.data?.pages.flatMap((p) => p.data) ?? [];
  const keyName = (id: string | null): string =>
    id ? (keysQ.data?.virtualKeys.find((k) => k.id === id)?.name ?? '—') : '—';
  const teamName = (id: string | null): string =>
    id ? (teamsQ.data?.teams.find((t) => t.id === id)?.name ?? '—') : '—';

  const activeChips = [
    filters.status !== 'all' ? { k: 'status' as const, label: `status: ${filters.status}` } : null,
    filters.virtualKeyId !== 'all'
      ? { k: 'virtualKeyId' as const, label: `key: ${keyName(filters.virtualKeyId)}` }
      : null,
    filters.teamId !== 'all'
      ? { k: 'teamId' as const, label: `team: ${teamName(filters.teamId)}` }
      : null,
    filters.model ? { k: 'model' as const, label: `model: ${filters.model}` } : null,
  ].filter((c): c is NonNullable<typeof c> => c !== null);

  const columns: Column<RequestLogRow>[] = [
    {
      key: 'time',
      header: 'Time',
      width: '110px',
      render: (r) => (
        <Tooltip content={absTime(r.createdAt)}>
          <span className="num text-xs text-[var(--ink-mut)]">{relTime(r.createdAt)}</span>
        </Tooltip>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      width: '110px',
      render: (r) => <RequestStatusBadge status={r.status} />,
    },
    {
      key: 'key',
      header: 'Key',
      render: (r) => <span className="text-[12.5px]">{keyName(r.virtualKeyId)}</span>,
    },
    {
      key: 'team',
      header: 'Team',
      render: (r) => (
        <span className="text-[12.5px] text-[var(--ink-mut)]">{teamName(r.teamId)}</span>
      ),
    },
    {
      key: 'model',
      header: 'Model',
      render: (r) => {
        const rewritten =
          r.model !== null && r.requestedModel !== null && r.model !== r.requestedModel;
        return (
          <span className="num text-[12.5px]">
            {rewritten ? (
              <>
                <span className="text-[var(--ink-mut)] line-through">{r.requestedModel}</span>
                <span className="mx-1 text-[var(--ink-mut)]">→</span>
                {r.model}
              </>
            ) : (
              (r.model ?? r.requestedModel ?? '—')
            )}
          </span>
        );
      },
    },
    {
      key: 'tokens',
      header: 'Tokens',
      align: 'right',
      render: (r) => (
        <Tooltip
          content={`in ${formatCount(r.inputTokens)} · out ${formatCount(r.outputTokens)} · cached ${formatCount(r.cachedReadTokens)}`}
        >
          <span className="num text-xs text-[var(--ink-mut)]">
            {r.inputTokens !== null || r.outputTokens !== null
              ? `${formatCount(r.inputTokens ?? 0)}→${formatCount(r.outputTokens ?? 0)}`
              : '—'}
          </span>
        </Tooltip>
      ),
    },
    {
      key: 'cost',
      header: 'Cost',
      align: 'right',
      render: (r) => <span className="num text-[12.5px]">{r.costUsd ? usd(r.costUsd) : '—'}</span>,
    },
    {
      key: 'latency',
      header: 'Latency',
      align: 'right',
      render: (r) => (
        <span className="num text-xs text-[var(--ink-mut)]">
          {r.latencyMs !== null ? `${r.latencyMs}ms` : '—'}
        </span>
      ),
    },
  ];

  return (
    <div>
      <PageHeader title="Requests" sub="Filterable log for investigation and charge attribution." />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="w-40">
          <Select
            value={filters.days}
            onValueChange={(v) => setFilters((f) => ({ ...f, days: v }))}
            options={RANGES}
          />
        </div>
        <div className="w-36">
          <Select
            value={filters.status}
            onValueChange={(v) => setFilters((f) => ({ ...f, status: v }))}
            options={STATUSES}
          />
        </div>
        <div className="w-44">
          <Select
            value={filters.virtualKeyId}
            onValueChange={(v) => setFilters((f) => ({ ...f, virtualKeyId: v }))}
            options={[
              { value: 'all', label: 'Any key' },
              ...(keysQ.data?.virtualKeys.map((k) => ({ value: k.id, label: k.name })) ?? []),
            ]}
          />
        </div>
        <div className="w-40">
          <Select
            value={filters.teamId}
            onValueChange={(v) => setFilters((f) => ({ ...f, teamId: v }))}
            options={[
              { value: 'all', label: 'Any team' },
              ...(teamsQ.data?.teams.map((t) => ({ value: t.id, label: t.name })) ?? []),
            ]}
          />
        </div>
        <form
          className="flex items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            setFilters((f) => ({ ...f, model: modelDraft }));
          }}
        >
          <input
            aria-label="Filter by model (exact match)"
            placeholder="model (exact)"
            value={modelDraft}
            onChange={(e) => setModelDraft(e.target.value)}
            className="focus-ring w-40 rounded-[var(--radius-btn)] bg-[var(--card)] px-3 py-2 font-mono text-xs shadow-[inset_0_0_0_1px_var(--line)] placeholder:text-[var(--ink-mut)]"
          />
          <Button type="submit" variant="ghost" size="sm">
            Apply
          </Button>
        </form>
      </div>

      {activeChips.length > 0 ? (
        <div className="mb-3 flex flex-wrap gap-1.5">
          {activeChips.map((c) => (
            <button
              key={c.k}
              type="button"
              onClick={() => {
                setFilters((f) => ({ ...f, [c.k]: DEFAULT_FILTERS[c.k] }));
                if (c.k === 'model') setModelDraft('');
              }}
              className="focus-ring inline-flex items-center gap-1 rounded-full bg-[var(--blue-soft)] px-2.5 py-1 font-mono text-[11px] text-[var(--blue)] hover:opacity-80"
            >
              {c.label}
              <X size={11} aria-hidden />
            </button>
          ))}
          <button
            type="button"
            onClick={() => {
              setFilters(DEFAULT_FILTERS);
              setModelDraft('');
            }}
            className="focus-ring self-center font-mono text-[11px] text-[var(--ink-mut)] underline hover:text-[var(--ink)]"
          >
            Clear all
          </button>
        </div>
      ) : null}

      {q.error ? (
        <SectionError error={q.error} onRetry={() => void q.refetch()} />
      ) : (
        <>
          <Table
            columns={columns}
            data={rows}
            rowKey={(r) => r.id}
            loading={q.isLoading}
            onRowClick={(r) => setOpenId(r.id)}
            rowTestId={(r) => `requests-row-${r.id}`}
            testId="requests-table"
            empty={
              <EmptyState
                icon={<ListTree size={20} />}
                headline={activeChips.length > 0 ? 'No matching requests.' : 'No requests yet.'}
                body={
                  activeChips.length > 0
                    ? 'Try adjusting your filters or expanding the date range.'
                    : 'Requests appear here after traffic flows through your virtual keys.'
                }
                action={
                  activeChips.length > 0
                    ? {
                        label: 'Clear filters',
                        onClick: () => {
                          setFilters(DEFAULT_FILTERS);
                          setModelDraft('');
                        },
                      }
                    : undefined
                }
              />
            }
          />
          {q.hasNextPage ? (
            <div className="mt-4 flex justify-center">
              <Button
                variant="ghost"
                loading={q.isFetchingNextPage}
                onClick={() => void q.fetchNextPage()}
              >
                Load more
              </Button>
            </div>
          ) : null}
          {q.isFetching && !q.isLoading && !q.isFetchingNextPage ? (
            <div className="mt-2">
              <Skeleton className="h-1 w-full" />
            </div>
          ) : null}
        </>
      )}

      <RequestDrawer requestId={openId} onClose={() => setOpenId(null)} />
    </div>
  );
}
