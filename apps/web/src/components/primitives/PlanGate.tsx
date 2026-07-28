import { Lock } from 'lucide-react';
import type { ReactNode } from 'react';
import { useOrg } from '../../lib/org.js';
import type { Entitlement } from '../../lib/entitlements.js';
import { Card } from './Card.js';

export interface PlanGateProps {
  /** Entitlement required to use (not view) this surface. */
  feature: Entitlement;
  /** What the gated surface is called in the upgrade copy. */
  label: string;
  children: ReactNode;
}

/**
 * Plan gate per 09-frontend §3.1: gated features render blurred behind an upgrade CTA —
 * surfaced to drive upgrades, never a 404. Reads-are-free doctrine means lists still load;
 * this gate wraps surfaces whose primary interaction is a gated WRITE.
 */
export function PlanGate({ feature, label, children }: PlanGateProps) {
  const { entitlements } = useOrg();
  if (entitlements.has(feature)) return <>{children}</>;
  return (
    <div className="relative">
      <div aria-hidden className="pointer-events-none select-none blur-[6px]">
        {children}
      </div>
      <div className="absolute inset-0 flex items-center justify-center">
        <Card padding="lg" className="max-w-sm text-center">
          <div
            aria-hidden
            className="mx-auto mb-3 flex size-10 items-center justify-center rounded-full bg-[var(--blue-soft)] text-[var(--blue)]"
          >
            <Lock size={18} />
          </div>
          <div className="text-[15px] font-semibold tracking-[-0.01em]">
            {label} is a Governance feature
          </div>
          <p className="mt-1.5 text-sm text-[var(--ink-mut)]">
            Upgrade to the Governance plan to unlock {label.toLowerCase()} for this org.
          </p>
          <a
            href="/#pricing"
            className="focus-ring mt-4 inline-flex h-10 items-center justify-center rounded-[var(--radius-btn)] bg-[var(--blue)] px-4 text-sm font-semibold text-white transition-colors hover:bg-[var(--blue-hover)]"
          >
            View plans
          </a>
        </Card>
      </div>
    </div>
  );
}
