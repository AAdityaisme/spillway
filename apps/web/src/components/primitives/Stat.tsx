import type { ReactNode } from 'react';
import { Card } from './Card.js';
import { Skeleton } from './Skeleton.js';

export interface StatProps {
  label: string;
  value: ReactNode;
  delta?: { value: string; positive: boolean };
  hint?: string;
  loading?: boolean;
  testId?: string;
  tone?: 'default' | 'amber' | 'danger';
}

/** KPI tile: mono eyebrow label, big tabular-mono value — the numbers ARE the brand. */
export function Stat({ label, value, delta, hint, loading, testId, tone = 'default' }: StatProps) {
  const valueColor =
    tone === 'amber'
      ? 'text-[var(--amber)]'
      : tone === 'danger'
        ? 'text-[var(--danger)]'
        : 'text-[var(--ink)]';
  return (
    <Card padding="md">
      <div className="eyebrow">{label}</div>
      {loading ? (
        <Skeleton className="mt-2 h-8 w-28" />
      ) : (
        <div
          className={`num mt-1.5 text-[26px] font-medium leading-tight tracking-[-0.02em] ${valueColor}`}
          data-testid={testId}
        >
          {value}
        </div>
      )}
      {!loading ? (
        // Always reserve the caption row so numerals baseline-align across sibling tiles.
        <div className="mt-1.5 flex min-h-4 items-center gap-2 text-xs">
          {delta ? (
            <span
              className={`num font-medium ${delta.positive ? 'text-[var(--pass)]' : 'text-[var(--amber)]'}`}
            >
              {delta.value}
            </span>
          ) : null}
          {hint ? <span className="text-[var(--ink-mut)]">{hint}</span> : null}
        </div>
      ) : null}
    </Card>
  );
}
