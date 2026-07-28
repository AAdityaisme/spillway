import { usd } from '../../lib/format.js';

export interface BudgetBarProps {
  spentUsd: string;
  limitUsd: string;
  /** Server-computed utilization percent — never re-derive from the money strings. */
  pct: number;
  compact?: boolean;
  testId?: string;
}

/** Spend bar: blue <70%, amber 70–90%, danger ≥90% (09-frontend §3.9). */
export function BudgetBar({ spentUsd, limitUsd, pct, compact = false, testId }: BudgetBarProps) {
  const color = pct >= 90 ? 'var(--danger)' : pct >= 70 ? 'var(--amber)' : 'var(--blue)';
  return (
    <div data-testid={testId} className={compact ? 'w-28' : 'w-full'}>
      <div className="h-1.5 overflow-hidden rounded-full bg-[rgba(11,18,32,0.07)]">
        <div
          role="progressbar"
          aria-valuenow={Math.round(pct)}
          aria-valuemin={0}
          aria-valuemax={100}
          className="h-full rounded-full transition-[width] duration-300"
          style={{ width: `${Math.min(pct, 100)}%`, background: color }}
        />
      </div>
      {!compact ? (
        <div className="num mt-1.5 flex justify-between text-xs">
          <span style={{ color: pct >= 70 ? color : 'var(--ink)' }}>{usd(spentUsd)}</span>
          <span className="text-[var(--ink-mut)]">
            of {usd(limitUsd)} · {pct.toFixed(0)}%
          </span>
        </div>
      ) : null}
    </div>
  );
}
