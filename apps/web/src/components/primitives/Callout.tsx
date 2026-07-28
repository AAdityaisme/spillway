import type { ReactNode } from 'react';

const TONE = {
  amber: { rule: 'var(--amber)', bg: 'var(--amber-soft)', text: 'var(--ink-read)' },
  blue: { rule: 'var(--blue)', bg: 'var(--blue-soft)', text: 'var(--ink-read)' },
} as const;

export interface CalloutProps {
  tone?: keyof typeof TONE;
  title?: string;
  children: ReactNode;
}

/** The one caution voice: left rule + soft tint (finance-grade, no icon noise). */
export function Callout({ tone = 'amber', title, children }: CalloutProps) {
  const t = TONE[tone];
  return (
    <div
      className="rounded-r-[var(--radius-btn)] py-2.5 pl-3.5 pr-4 text-[13px]"
      style={{ background: t.bg, borderLeft: `3px solid ${t.rule}`, color: t.text }}
    >
      {title ? (
        <div
          className="mb-0.5 font-mono text-[11px] font-medium uppercase tracking-[0.1em]"
          style={{ color: t.rule }}
        >
          {title}
        </div>
      ) : null}
      {children}
    </div>
  );
}
