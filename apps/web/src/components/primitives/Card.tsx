import type { ReactNode } from 'react';

export interface CardProps {
  children: ReactNode;
  className?: string;
  padding?: 'none' | 'sm' | 'md' | 'lg';
}

const PAD: Record<NonNullable<CardProps['padding']>, string> = {
  none: '',
  sm: 'p-4',
  md: 'p-5',
  lg: 'p-6',
};

/** White card on paper: 14px radius + the triple-layer ink-tinted shadow (its first layer is the hairline — no border). */
export function Card({ children, className = '', padding = 'md' }: CardProps) {
  return (
    <div
      className={`rounded-[var(--radius-card)] bg-[var(--card)] shadow-[var(--shadow-card)] ${PAD[padding]} ${className}`}
    >
      {children}
    </div>
  );
}
