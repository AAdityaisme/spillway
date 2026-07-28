import { useQuery } from '@tanstack/react-query';
import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import { api, ApiError } from '../../lib/api.js';
import { useAuth } from '../../lib/auth.js';
import { useOrg, roleAtLeast } from '../../lib/org.js';
import { absTime, formatCount, usd } from '../../lib/format.js';
import { Badge } from '../primitives/Badge.js';
import { Drawer } from '../primitives/Drawer.js';
import { Skeleton } from '../primitives/Skeleton.js';
import { BlockChip } from './BlockChip.js';
import { RequestStatusBadge } from './StatusBadge.js';

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <span className="shrink-0 text-xs text-[var(--ink-mut)]">{label}</span>
      <span className="num min-w-0 text-right text-[12.5px]">{children}</span>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <div className="eyebrow mb-1 mt-5 first:mt-0">{children}</div>;
}

function CopyId({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label="Copy request id"
      onClick={() => {
        void navigator.clipboard.writeText(id).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      className="focus-ring inline-flex items-center gap-1.5 rounded-md bg-[var(--paper)] px-2 py-1 font-mono text-[11px] text-[var(--ink-mut)] transition-colors hover:text-[var(--ink)]"
    >
      {id.slice(0, 8)}…
      {copied ? (
        <Check size={11} aria-hidden className="text-[var(--pass)]" />
      ) : (
        <Copy size={11} aria-hidden />
      )}
    </button>
  );
}

const TOKEN_ROWS: Array<{
  label: string;
  key: 'inputTokens' | 'outputTokens' | 'cachedReadTokens' | 'cacheWriteTokens' | 'reasoningTokens';
  price: string;
}> = [
  { label: 'Input', key: 'inputTokens', price: 'input' },
  { label: 'Output', key: 'outputTokens', price: 'output' },
  { label: 'Cached read', key: 'cachedReadTokens', price: 'cached_read' },
  { label: 'Cache write', key: 'cacheWriteTokens', price: 'cache_write' },
  { label: 'Reasoning', key: 'reasoningTokens', price: 'reasoning' },
];

/** Trace outcome → semantic badge. */
function outcomeVariant(outcome: string): 'pass' | 'amber' | 'danger' | 'neutral' {
  if (outcome === 'ok' || outcome === 'success') return 'pass';
  if (outcome === 'error' || outcome === 'failed') return 'danger';
  return 'amber';
}

/**
 * Request detail drawer (bible §3.6) + the per-request routing trace (Governance
 * audit_api) — decisions and attempts proving what the gateway did and why. No
 * prompt/response bodies exist by default (ADR-013); the trace IS the "why" surface.
 */
export function RequestDrawer({
  requestId,
  onClose,
}: {
  requestId: string | null;
  onClose: () => void;
}) {
  const { session, activeOrgId } = useAuth();
  const { role, entitlements } = useOrg();
  const canTrace = roleAtLeast(role, 'admin') && entitlements.has('audit_api');

  const q = useQuery({
    queryKey: [activeOrgId, 'request', requestId],
    queryFn: () => api.getRequest(requestId as string),
    enabled: !!session && !!activeOrgId && requestId !== null,
  });
  const traceQ = useQuery({
    queryKey: [activeOrgId, 'trace', requestId],
    queryFn: () => api.getTrace(requestId as string),
    enabled: !!session && !!activeOrgId && requestId !== null && canTrace,
    retry: false,
  });

  const r = q.data?.request;
  const trace = traceQ.data?.trace;
  const rewritten =
    r && r.model !== null && r.requestedModel !== null && r.model !== r.requestedModel;

  return (
    <Drawer open={requestId !== null} onClose={onClose} title="Request detail" width="lg">
      {q.isLoading ? (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : q.error || !r ? (
        <p className="text-sm text-[var(--danger)]">
          {q.error instanceof ApiError
            ? `${q.error.code}: ${q.error.message}`
            : 'Failed to load request.'}
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <RequestStatusBadge status={r.status} />
            {r.stream ? <Badge variant="neutral">stream</Badge> : null}
            {r.usageEstimated ? <Badge variant="amber">usage estimated</Badge> : null}
            <CopyId id={r.id} />
            <span className="num ml-auto text-xs text-[var(--ink-mut)]">
              {absTime(r.createdAt)}
            </span>
          </div>

          {r.status === 'blocked' && r.blockReason ? (
            <div className="mt-4 rounded-[var(--radius-btn)] bg-[var(--amber-soft)] p-3.5">
              <BlockChip
                reason={r.blockReason}
                scopeType={r.blockScopeType}
                period={r.blockPeriod}
              />
              <p className="mt-2 text-[13px] text-[var(--ink-read)]">
                Blocked before dispatch — no tokens were sent, nothing was charged. Budget increases
                are decided in the approval queue; admins can adjust the limit under Budgets.
              </p>
            </div>
          ) : null}

          <SectionTitle>Summary</SectionTitle>
          <div className="divide-y divide-[var(--line)]">
            <Row label="Endpoint">{r.endpoint}</Row>
            <Row label="Requested model">{r.requestedModel ?? '—'}</Row>
            <Row label="Served model">
              {rewritten ? (
                <span>
                  <span className="text-[var(--ink-mut)] line-through">{r.requestedModel}</span>
                  <span className="mx-1 text-[var(--ink-mut)]">→</span>
                  {r.model}
                </span>
              ) : (
                (r.model ?? '—')
              )}
            </Row>
            <Row label="Provider">{r.provider ?? '—'}</Row>
            {r.routingRuleName ? <Row label="Routing rule">{r.routingRuleName}</Row> : null}
            <Row label="Latency">{r.latencyMs !== null ? `${r.latencyMs}ms` : '—'}</Row>
            {r.ttftMs !== null ? <Row label="TTFT">{r.ttftMs}ms</Row> : null}
            {r.httpStatus !== null ? <Row label="HTTP status">{r.httpStatus}</Row> : null}
            {r.errorCode ? <Row label="Error code">{r.errorCode}</Row> : null}
          </div>

          {r.fallbackFrom && r.fallbackFrom.length > 0 ? (
            <>
              <SectionTitle>Fallback chain</SectionTitle>
              <div className="flex flex-col gap-1.5">
                {r.fallbackFrom.map((f, i) => (
                  <div key={i} className="flex items-center gap-2 text-[12.5px]">
                    <Badge variant="amber">failed</Badge>
                    <span className="num">
                      {f.provider}/{f.model}
                    </span>
                    <span className="truncate text-xs text-[var(--ink-mut)]">{f.error}</span>
                  </div>
                ))}
              </div>
            </>
          ) : null}

          <SectionTitle>Tokens &amp; cost</SectionTitle>
          <div className="divide-y divide-[var(--line)]">
            {TOKEN_ROWS.map((t) => {
              const count = r[t.key];
              if (count === null || count === undefined || count === 0) return null;
              const unit = r.unitPrices?.[t.price];
              return (
                <Row key={t.key} label={t.label}>
                  {formatCount(count)}
                  {unit ? (
                    <span className="ml-2 text-xs text-[var(--ink-mut)]">
                      @ {usd(unit, { precise: true })}/M
                    </span>
                  ) : null}
                </Row>
              );
            })}
            <Row label="Total cost">
              <span className="font-medium">
                {r.costUsd ? usd(r.costUsd, { precise: true }) : '$0.00'}
              </span>
            </Row>
          </div>

          {canTrace ? (
            <>
              <SectionTitle>Routing trace</SectionTitle>
              {traceQ.isLoading ? (
                <Skeleton className="h-24 w-full" />
              ) : traceQ.error instanceof ApiError && traceQ.error.status === 402 ? (
                <p className="text-xs text-[var(--ink-mut)]">
                  Routing-trace audit is a Governance feature.
                </p>
              ) : trace ? (
                <div className="rounded-[var(--radius-btn)] bg-[var(--paper)] p-3.5">
                  {trace.decisions.length === 0 && trace.attempts.length === 0 ? (
                    <p className="text-xs text-[var(--ink-mut)]">
                      No decisions or attempts recorded for this request.
                    </p>
                  ) : (
                    <ol className="flex flex-col gap-2">
                      {trace.decisions.map((d, i) => (
                        <li
                          key={`d${i}`}
                          className="flex flex-wrap items-center gap-2 text-[12.5px]"
                        >
                          <Badge
                            variant={
                              d.effect === 'deny'
                                ? 'amber'
                                : d.effect === 'flag'
                                  ? 'blue'
                                  : 'neutral'
                            }
                          >
                            {d.effect}
                          </Badge>
                          <span className="font-mono text-[11px] text-[var(--ink-mut)]">
                            {d.enforcement}
                          </span>
                          {d.reason ? (
                            <span className="text-[var(--ink-read)]">{d.reason}</span>
                          ) : null}
                        </li>
                      ))}
                      {trace.attempts.map((a) => (
                        <li
                          key={`a${a.attemptNumber}`}
                          className="flex flex-wrap items-center gap-2 text-[12.5px]"
                        >
                          <span className="num text-[11px] text-[var(--ink-mut)]">
                            #{a.attemptNumber}
                          </span>
                          <Badge variant={outcomeVariant(a.outcome)}>{a.outcome}</Badge>
                          <span className="num">
                            {a.provider}/{a.model}
                          </span>
                          {a.errorCode ? (
                            <span className="font-mono text-[11px] text-[var(--danger)]">
                              {a.errorCode}
                            </span>
                          ) : null}
                          {a.costUsd ? (
                            <span className="num ml-auto text-xs">
                              {usd(a.costUsd, { precise: true })}
                            </span>
                          ) : null}
                        </li>
                      ))}
                    </ol>
                  )}
                  {trace.configSnapshotHash ? (
                    <p className="num mt-2.5 border-t border-[var(--line)] pt-2 text-[10.5px] text-[var(--ink-mut)]">
                      config snapshot {trace.configSnapshotHash.slice(0, 12)} — every decision above
                      is replayable against this exact policy set.
                    </p>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : null}

          {r.metadata && Object.keys(r.metadata).length > 0 ? (
            <>
              <SectionTitle>Metadata</SectionTitle>
              <div className="divide-y divide-[var(--line)]">
                {Object.entries(r.metadata).map(([k, v]) => (
                  <Row key={k} label={k}>
                    {v}
                  </Row>
                ))}
              </div>
            </>
          ) : null}
        </>
      )}
    </Drawer>
  );
}
