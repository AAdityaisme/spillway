import type { ReactNode } from 'react';
import { Button } from './Button.js';

export interface EmptyStateProps {
  icon: ReactNode;
  headline: string;
  body: string;
  action?: { label: string; onClick: () => void; testId?: string };
}

/**
 * Empty states explain the product, not just the absence of data (09-frontend §5) —
 * and carry the brand voice: serif headline over the engineering dot grid.
 */
export function EmptyState({ icon, headline, body, action }: EmptyStateProps) {
  return (
    <div className="dot-grid flex flex-col items-center justify-center px-6 py-14 text-center">
      <div
        aria-hidden
        className="mb-4 flex size-11 items-center justify-center rounded-full bg-[var(--blue-soft)] text-[var(--blue)]"
      >
        {icon}
      </div>
      <div className="brand-serif text-[24px] text-[var(--ink)]">{headline}</div>
      <p className="mt-2 max-w-sm text-sm text-[var(--ink-mut)]">{body}</p>
      {action ? (
        <Button className="mt-5" onClick={action.onClick} data-testid={action.testId}>
          {action.label}
        </Button>
      ) : null}
    </div>
  );
}
