import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BadgeCheck, ChevronDown } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { ApprovalStatusBadge } from '../components/domain/StatusBadge.js';
import { SectionError } from '../components/domain/SectionError.js';
import { PageHeader } from '../components/layout/PageHeader.js';
import { Badge } from '../components/primitives/Badge.js';
import { Button } from '../components/primitives/Button.js';
import { Card } from '../components/primitives/Card.js';
import { EmptyState } from '../components/primitives/EmptyState.js';
import { Skeleton } from '../components/primitives/Skeleton.js';
import { TextArea } from '../components/primitives/Field.js';
import { api, ApiError, type ApprovalRow } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';
import { roleAtLeast, useOrg } from '../lib/org.js';
import { relTime, usd } from '../lib/format.js';

const KIND_LABEL: Record<string, string> = {
  budget_increase: 'Budget increase',
  key_unpause: 'Key unpause',
  request_approval: 'Request approval',
};

/** Inline decide form — slides open under the card; fewer clicks than a dialog for the common case. */
function DecideForm({
  id,
  decision,
  onDone,
}: {
  id: string;
  decision: 'approve' | 'deny';
  onDone: () => void;
}) {
  const { activeOrgId } = useAuth();
  const queryClient = useQueryClient();
  const [comment, setComment] = useState('');

  const decide = useMutation({
    mutationFn: () => api.decideApproval(id, decision, comment.trim() || undefined),
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: [activeOrgId, 'approvals'] });
      toast.success(
        res.status === 'approved'
          ? 'Approved — the effect was applied.'
          : res.status === 'pending'
            ? 'Vote recorded — waiting on the remaining approvers for this step.'
            : 'Request denied.',
      );
      onDone();
    },
  });

  return (
    <div className="mt-3 flex flex-col gap-2 border-t border-[var(--line)] pt-3">
      <label htmlFor={`comment-${id}`} className="text-xs text-[var(--ink-mut)]">
        {decision === 'approve' ? 'Optional comment' : 'Reason (optional)'}
      </label>
      <TextArea
        id={`comment-${id}`}
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        className="min-h-14 text-[13px]"
      />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onDone}>
          Cancel
        </Button>
        <Button
          size="sm"
          variant={decision === 'deny' ? 'danger' : 'primary'}
          loading={decide.isPending}
          onClick={() => decide.mutate()}
          data-testid={
            decision === 'approve' ? 'approval-approve-confirm-btn' : 'approval-deny-confirm-btn'
          }
        >
          {decision === 'approve' ? 'Confirm approve' : 'Confirm deny'}
        </Button>
      </div>
    </div>
  );
}

function ApprovalCard({ row, canDecide }: { row: ApprovalRow; canDecide: boolean }) {
  const { activeOrgId } = useAuth();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<'approve' | 'deny' | null>(null);
  const [expanded, setExpanded] = useState(false);

  const detailQ = useQuery({
    queryKey: [activeOrgId, 'approval', row.id],
    queryFn: () => api.getApproval(row.id),
    enabled: expanded,
  });

  const cancel = useMutation({
    mutationFn: () => api.cancelApproval(row.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [activeOrgId, 'approvals'] });
      toast.success('Request cancelled.');
    },
  });

  const pending = row.status === 'pending';

  return (
    <Card data-testid={`approval-card-${row.id}`} className="transition-shadow">
      <div className="flex flex-wrap items-center gap-2.5">
        <Badge variant="blue">{KIND_LABEL[row.kind] ?? row.kind}</Badge>
        <ApprovalStatusBadge status={row.status} />
        {row.amount_usd ? (
          <span className="num text-[15px] font-medium">{usd(row.amount_usd)}</span>
        ) : null}
        <span className="text-xs text-[var(--ink-mut)]">
          {row.scope_type ? `${row.scope_type}` : 'org'} · requested by{' '}
          <span className="font-mono text-[11px]">{row.requested_by.slice(0, 18)}…</span>
        </span>
        <span className="num ml-auto text-xs text-[var(--ink-mut)]">{relTime(row.created_at)}</span>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="focus-ring inline-flex items-center gap-1 font-mono text-[11px] uppercase tracking-[0.1em] text-[var(--ink-mut)] hover:text-[var(--ink)]"
        >
          <ChevronDown
            size={12}
            aria-hidden
            className={`transition-transform ${expanded ? 'rotate-180' : ''}`}
          />
          steps
        </button>
        {pending && canDecide ? (
          <span className="ml-auto flex gap-2">
            <Button size="sm" onClick={() => setForm('approve')} data-testid="approval-approve-btn">
              Approve
            </Button>
            <Button
              size="sm"
              variant="danger-ghost"
              onClick={() => setForm('deny')}
              data-testid="approval-deny-btn"
            >
              Deny
            </Button>
          </span>
        ) : pending ? (
          <span className="ml-auto">
            <Button
              size="sm"
              variant="ghost"
              loading={cancel.isPending}
              onClick={() => cancel.mutate()}
            >
              Cancel request
            </Button>
          </span>
        ) : null}
      </div>

      {expanded ? (
        <div className="mt-3 rounded-[var(--radius-btn)] bg-[var(--paper)] p-3">
          {detailQ.isLoading ? (
            <Skeleton className="h-12 w-full" />
          ) : detailQ.error ? (
            <p className="text-xs text-[var(--danger)]">
              {detailQ.error instanceof ApiError ? detailQ.error.message : 'Failed to load steps.'}
            </p>
          ) : detailQ.data ? (
            <ol className="flex flex-col gap-1.5">
              {detailQ.data.steps.map((s) => (
                <li key={s.step_index} className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="num text-[var(--ink-mut)]">step {s.step_index + 1}</span>
                  <Badge
                    variant={
                      s.status === 'approved'
                        ? 'pass'
                        : s.status === 'pending'
                          ? 'amber'
                          : 'neutral'
                    }
                  >
                    {s.status}
                  </Badge>
                  <span className="text-[var(--ink-mut)]">
                    quorum <span className="num">{String(s.quorum)}</span> ·{' '}
                    {s.required_approver_ids.length} approver
                    {s.required_approver_ids.length === 1 ? '' : 's'}
                    {s.notify_only ? ' · notify-only' : ''}
                  </span>
                </li>
              ))}
              {detailQ.data.approval.decided_by ? (
                <li className="mt-1 text-xs text-[var(--ink-mut)]">
                  decided by{' '}
                  <span className="font-mono text-[11px]">
                    {detailQ.data.approval.decided_by.slice(0, 18)}…
                  </span>
                  {detailQ.data.approval.decided_at
                    ? ` · ${relTime(detailQ.data.approval.decided_at)}`
                    : ''}
                </li>
              ) : null}
              {detailQ.data.approval.expires_at && detailQ.data.approval.status === 'pending' ? (
                <li className="text-xs text-[var(--amber)]">
                  expires {relTime(detailQ.data.approval.expires_at).replace(' ago', '')}
                </li>
              ) : null}
            </ol>
          ) : null}
        </div>
      ) : null}

      {form ? <DecideForm id={row.id} decision={form} onDone={() => setForm(null)} /> : null}
    </Card>
  );
}

/**
 * Approval queue (bible §3.10) — the workflow no competitor ships. Approvals are
 * materialized by the governance engine (require_approval policies, budget flows);
 * this surface decides them. Deny is terminal; approve advances the step chain and
 * applies the effect atomically on the final vote.
 */
export function ApprovalsPage() {
  const { session, activeOrgId } = useAuth();
  const { role } = useOrg();
  const [showPast, setShowPast] = useState(false);
  const canDecide = roleAtLeast(role, 'member'); // viewers can never vote; server enforces the approver set

  const pendingQ = useQuery({
    queryKey: [activeOrgId, 'approvals', 'pending'],
    queryFn: () => api.listApprovals('pending'),
    enabled: !!session && !!activeOrgId,
    refetchInterval: 15_000,
  });
  const allQ = useQuery({
    queryKey: [activeOrgId, 'approvals', 'all'],
    queryFn: () => api.listApprovals(),
    enabled: !!session && !!activeOrgId && showPast,
  });

  const pending = pendingQ.data?.approvals ?? [];
  const past = (allQ.data?.approvals ?? []).filter((a) => a.status !== 'pending');

  return (
    <div>
      <PageHeader
        title="Approvals"
        sub="Spend decisions with a quorum and an audit trail — approved here, applied atomically."
      />

      {pendingQ.isLoading ? (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : pendingQ.error ? (
        <SectionError error={pendingQ.error} onRetry={() => void pendingQ.refetch()} />
      ) : pending.length === 0 ? (
        <Card padding="none">
          <EmptyState
            icon={<BadgeCheck size={20} />}
            headline="No pending requests."
            body="When a policy requires approval or a member requests a budget increase, it lands here for a decision."
          />
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {pending.map((a) => (
            <ApprovalCard key={a.id} row={a} canDecide={canDecide} />
          ))}
        </div>
      )}

      <div className="mt-6">
        <button
          type="button"
          onClick={() => setShowPast((v) => !v)}
          className="focus-ring inline-flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.12em] text-[var(--ink-mut)] hover:text-[var(--ink)]"
        >
          <ChevronDown
            size={12}
            aria-hidden
            className={`transition-transform ${showPast ? 'rotate-180' : ''}`}
          />
          Past decisions
        </button>
        {showPast ? (
          allQ.isLoading ? (
            <Skeleton className="mt-3 h-20 w-full" />
          ) : past.length === 0 ? (
            <p className="mt-3 text-sm text-[var(--ink-mut)]">No past decisions yet.</p>
          ) : (
            <div className="mt-3 flex flex-col gap-3">
              {past.map((a) => (
                <ApprovalCard key={a.id} row={a} canDecide={false} />
              ))}
            </div>
          )
        ) : null}
      </div>
    </div>
  );
}
