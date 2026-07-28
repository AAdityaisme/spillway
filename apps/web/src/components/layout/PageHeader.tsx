import { useRouterState } from '@tanstack/react-router';
import type { ReactNode } from 'react';

export interface PageHeaderProps {
  title: string;
  /** One-line purpose statement under the title. */
  sub?: string;
  actions?: ReactNode;
}

/** Route → mono waymark eyebrow (the homepage's waymark grammar, mapped to nav groups). */
const GROUP: Array<[RegExp, string]> = [
  [/^\/(feed|requests)?$/, 'console'],
  [/^\/(budgets|approvals|policies|alerts)/, 'govern'],
  [/^\/(keys|providers|routing)/, 'route'],
  [/^\/(reports|insights)/, 'finance'],
  [/^\/(team|settings)/, 'org'],
];

/** Page header: waymark eyebrow + title + purpose line left, actions right. */
export function PageHeader({ title, sub, actions }: PageHeaderProps) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const group = GROUP.find(([re]) => re.test(pathname))?.[1];
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div>
        {group ? <div className="eyebrow mb-1">{group}</div> : null}
        <h1 className="text-[22px] font-semibold leading-tight tracking-[-0.02em]">{title}</h1>
        {sub ? <p className="mt-1 text-sm text-[var(--ink-mut)]">{sub}</p> : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}
