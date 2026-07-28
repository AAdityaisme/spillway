/** Block-reason chip (09-frontend §3.5): bare code → label, with scope + period context. */
const REASON_LABEL: Record<string, string> = {
  budget_exceeded: 'Budget exceeded',
  rate_limited: 'Rate limited',
  model_not_allowed: 'Model not allowed',
  key_paused: 'Key paused',
  rule_deny: 'Denied by rule',
  policy_deny: 'Denied by policy',
  approval_required: 'Approval required',
};

export interface BlockChipProps {
  reason: string;
  scopeType?: string | null;
  period?: string | null;
}

export function BlockChip({ reason, scopeType, period }: BlockChipProps) {
  const parts = [REASON_LABEL[reason] ?? reason, scopeType, period].filter(Boolean);
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-[var(--amber-soft)] px-2 py-0.5 font-mono text-[11px] font-medium text-[var(--amber)]">
      {parts.join(' · ')}
    </span>
  );
}
