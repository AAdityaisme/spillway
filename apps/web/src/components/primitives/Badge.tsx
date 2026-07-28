import type { ReactNode } from 'react';

type BadgeVariant = 'pass' | 'amber' | 'danger' | 'neutral' | 'blue';

export interface BadgeProps {
  variant: BadgeVariant;
  children: ReactNode;
  dot?: boolean;
}

const VARIANT: Record<BadgeVariant, { pill: string; dot: string }> = {
  pass: { pill: 'bg-[var(--pass-soft)] text-[var(--pass)]', dot: 'bg-[var(--pass)]' },
  amber: { pill: 'bg-[var(--amber-soft)] text-[var(--amber)]', dot: 'bg-[var(--amber)]' },
  danger: { pill: 'bg-[var(--danger-soft)] text-[var(--danger)]', dot: 'bg-[var(--danger)]' },
  neutral: { pill: 'bg-[rgba(11,18,32,0.06)] text-[var(--ink-mut)]', dot: 'bg-[var(--ink-mut)]' },
  blue: { pill: 'bg-[var(--blue-soft)] text-[var(--blue)]', dot: 'bg-[var(--blue)]' },
};

/** Pill label in the semantic palette: pass=ok, amber=caught/pending, danger=destructive/error. */
export function Badge({ variant, children, dot = false }: BadgeProps) {
  const v = VARIANT[variant];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 font-mono text-[11px] font-medium lowercase ${v.pill}`}
    >
      {dot ? <span aria-hidden className={`size-1.5 rounded-full ${v.dot}`} /> : null}
      {children}
    </span>
  );
}
