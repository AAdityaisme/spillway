import * as RadixTooltip from '@radix-ui/react-tooltip';
import type { ReactNode } from 'react';

export interface TooltipProps {
  content: ReactNode;
  children: ReactNode;
}

/** Ink tooltip. Mount <TooltipProvider> once at the app root. */
export function Tooltip({ content, children }: TooltipProps) {
  return (
    <RadixTooltip.Root delayDuration={300}>
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content
          sideOffset={6}
          className="z-50 max-w-xs rounded-lg bg-[var(--ink)] px-2.5 py-1.5 text-xs text-[#e8ecf4] shadow-[var(--shadow-pop)]"
        >
          {content}
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
}

export const TooltipProvider = RadixTooltip.Provider;
