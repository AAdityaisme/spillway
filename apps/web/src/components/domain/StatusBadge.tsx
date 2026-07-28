import { Badge } from '../primitives/Badge.js';

/** Semantic mapping: blue=allowed/action, amber=caught (blocked/paused/rate-limited), pass=ok, danger=hard error. */
const REQUEST_STATUS: Record<
  string,
  { variant: 'pass' | 'amber' | 'danger' | 'neutral'; label: string }
> = {
  ok: { variant: 'pass', label: 'ok' },
  blocked: { variant: 'amber', label: 'blocked' },
  rate_limited: { variant: 'amber', label: 'rate limited' },
  error: { variant: 'danger', label: 'error' },
};

const KEY_STATUS: Record<
  string,
  { variant: 'pass' | 'amber' | 'danger' | 'neutral'; label: string }
> = {
  active: { variant: 'pass', label: 'active' },
  paused: { variant: 'amber', label: 'paused' },
  revoked: { variant: 'neutral', label: 'revoked' },
};

const APPROVAL_STATUS: Record<
  string,
  { variant: 'pass' | 'amber' | 'danger' | 'neutral' | 'blue'; label: string }
> = {
  pending: { variant: 'amber', label: 'pending' },
  approved: { variant: 'pass', label: 'approved' },
  denied: { variant: 'danger', label: 'denied' },
  cancelled: { variant: 'neutral', label: 'cancelled' },
  expired: { variant: 'neutral', label: 'expired' },
};

export function RequestStatusBadge({ status, testId }: { status: string; testId?: string }) {
  const s = REQUEST_STATUS[status] ?? { variant: 'neutral' as const, label: status };
  return (
    <span data-testid={testId}>
      <Badge variant={s.variant} dot>
        {s.label}
      </Badge>
    </span>
  );
}

export function KeyStatusBadge({ status }: { status: string }) {
  const s = KEY_STATUS[status] ?? { variant: 'neutral' as const, label: status };
  return (
    <Badge variant={s.variant} dot>
      {s.label}
    </Badge>
  );
}

export function ApprovalStatusBadge({ status }: { status: string }) {
  const s = APPROVAL_STATUS[status] ?? { variant: 'neutral' as const, label: status };
  return (
    <Badge variant={s.variant} dot>
      {s.label}
    </Badge>
  );
}
