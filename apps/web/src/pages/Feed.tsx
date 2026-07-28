import { useQuery } from '@tanstack/react-query';
import { Activity, Pause, Play, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { BlockChip } from '../components/domain/BlockChip.js';
import { RequestDrawer } from '../components/domain/RequestDrawer.js';
import { SectionError } from '../components/domain/SectionError.js';
import { RequestStatusBadge } from '../components/domain/StatusBadge.js';
import { PageHeader } from '../components/layout/PageHeader.js';
import { Badge } from '../components/primitives/Badge.js';
import { Card } from '../components/primitives/Card.js';
import { EmptyState } from '../components/primitives/EmptyState.js';
import { Skeleton } from '../components/primitives/Skeleton.js';
import { api, type RequestLogRow } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';
import { formatCount, relTime, usd } from '../lib/format.js';

type StatusFilter = 'all' | 'ok' | 'blocked' | 'error' | 'rate_limited';

const FILTERS: Array<{ value: StatusFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'ok', label: 'OK' },
  { value: 'blocked', label: 'Blocked' },
  { value: 'error', label: 'Error' },
  { value: 'rate_limited', label: 'Rate limited' },
];

/** One feed line: status · model(s) · block chip · tokens · cost · latency · age. */
function FeedRow({
  row,
  keyName,
  onClick,
}: {
  row: RequestLogRow;
  keyName: string | null;
  onClick: () => void;
}) {
  const rewritten =
    row.model !== null && row.requestedModel !== null && row.model !== row.requestedModel;
  const tokens =
    row.inputTokens !== null || row.outputTokens !== null
      ? `${formatCount(row.inputTokens ?? 0)}→${formatCount(row.outputTokens ?? 0)}`
      : null;
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={`feed-row-${row.id}`}
      className="focus-ring row-in flex w-full flex-wrap items-center gap-x-3 gap-y-1 border-b border-[var(--line)] px-4 py-2 text-left transition-colors duration-100 last:border-0 hover:bg-[var(--paper)]"
    >
      <RequestStatusBadge status={row.status} testId="feed-row-status-badge" />
      <span className="num text-[12.5px]">
        {rewritten ? (
          <>
            <span className="text-[var(--ink-mut)] line-through">{row.requestedModel}</span>
            <span className="mx-1 text-[var(--ink-mut)]">→</span>
            <span>{row.model}</span>
          </>
        ) : (
          (row.model ?? row.requestedModel ?? '—')
        )}
      </span>
      {keyName ? <span className="text-xs text-[var(--ink-mut)]">{keyName}</span> : null}
      {row.status === 'blocked' && row.blockReason ? (
        <BlockChip
          reason={row.blockReason}
          scopeType={row.blockScopeType}
          period={row.blockPeriod}
        />
      ) : null}
      <span className="ml-auto flex items-center gap-3">
        <span className="num w-32 whitespace-nowrap text-right text-xs text-[var(--ink-mut)]">
          {tokens ? `${tokens} tok` : ''}
        </span>
        <span className="num w-20 text-right text-[12.5px]">
          {row.costUsd ? usd(row.costUsd) : '—'}
        </span>
        <span className="num w-14 text-right text-xs text-[var(--ink-mut)]">
          {row.latencyMs !== null ? `${row.latencyMs}ms` : '—'}
        </span>
        <span className="num w-16 text-right text-xs text-[var(--ink-mut)]">
          {relTime(row.createdAt)}
        </span>
      </span>
    </button>
  );
}

/**
 * Live request feed (bible §3.5): 2s polling — indistinguishable from push at demo cadence,
 * one SQL query per tick. Block-reason chips read the persisted block_* fields, never headers.
 */
export function FeedPage() {
  const { session, activeOrgId } = useAuth();
  const [live, setLive] = useState(true);
  const [status, setStatus] = useState<StatusFilter>('all');
  const [openId, setOpenId] = useState<string | null>(null);

  const keysQ = useQuery({
    queryKey: [activeOrgId, 'virtual-keys'],
    queryFn: api.listVirtualKeys,
    enabled: !!session && !!activeOrgId,
    staleTime: 60_000,
  });
  const q = useQuery({
    queryKey: [activeOrgId, 'requests', { feed: true, status }],
    queryFn: () => api.listRequests({ limit: 50, ...(status !== 'all' ? { status } : {}) }),
    enabled: !!session && !!activeOrgId,
    refetchInterval: live ? 2000 : false,
  });

  const rows = q.data?.data ?? [];
  const iconBtn =
    'focus-ring rounded-[var(--radius-btn)] bg-[var(--card)] p-2 text-[var(--ink-mut)] shadow-[inset_0_0_0_1px_var(--line)] transition-colors hover:text-[var(--ink)]';

  return (
    <div>
      <PageHeader
        title="Live feed"
        sub="Every request through the gateway, as it happens."
        actions={
          <>
            <Badge variant={live ? 'pass' : 'neutral'} dot>
              {live ? 'live · 2s' : 'paused'}
            </Badge>
            <button
              type="button"
              aria-label={live ? 'Pause auto-refresh' : 'Resume auto-refresh'}
              data-testid="feed-live-toggle"
              onClick={() => setLive((v) => !v)}
              className={iconBtn}
            >
              {live ? <Pause size={14} aria-hidden /> : <Play size={14} aria-hidden />}
            </button>
            <button
              type="button"
              aria-label="Refresh now"
              onClick={() => void q.refetch()}
              className={iconBtn}
            >
              <RefreshCw size={14} aria-hidden className={q.isFetching ? 'animate-spin' : ''} />
            </button>
          </>
        }
      />

      <div className="mb-4 flex gap-1.5 overflow-x-auto whitespace-nowrap">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            onClick={() => setStatus(f.value)}
            className={`focus-ring rounded-full px-3 py-1 font-mono text-[11px] font-medium transition-colors ${
              status === f.value
                ? 'bg-[var(--blue)] text-white'
                : 'bg-[var(--card)] text-[var(--ink-mut)] shadow-[inset_0_0_0_1px_var(--line)] hover:text-[var(--ink)]'
            }`}
          >
            {f.label}
          </button>
        ))}
        <span className="num ml-auto self-center text-xs text-[var(--ink-mut)]">
          {rows.length} request{rows.length === 1 ? '' : 's'}
        </span>
      </div>

      {q.isLoading ? (
        <Card padding="none">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="border-b border-[var(--line)] px-4 py-3 last:border-0">
              <Skeleton className="h-5 w-full" />
            </div>
          ))}
        </Card>
      ) : q.error ? (
        <SectionError error={q.error} onRetry={() => void q.refetch()} />
      ) : rows.length === 0 ? (
        <Card padding="none">
          <EmptyState
            icon={<Activity size={20} />}
            headline={status === 'all' ? 'Waiting for requests.' : 'No matching requests.'}
            body={
              status === 'all'
                ? 'This feed shows every request through your gateway in real time. Send your first request to see it appear.'
                : 'No requests with this status in the latest window.'
            }
          />
        </Card>
      ) : (
        <Card padding="none">
          {rows.map((r) => (
            <FeedRow
              key={r.id}
              row={r}
              keyName={keysQ.data?.virtualKeys.find((k) => k.id === r.virtualKeyId)?.name ?? null}
              onClick={() => setOpenId(r.id)}
            />
          ))}
        </Card>
      )}

      <RequestDrawer requestId={openId} onClose={() => setOpenId(null)} />
    </div>
  );
}
