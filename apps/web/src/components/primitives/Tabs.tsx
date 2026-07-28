import * as RadixTabs from '@radix-ui/react-tabs';
import type { ReactNode } from 'react';

export interface TabsProps {
  value: string;
  onValueChange: (value: string) => void;
  tabs: Array<{ value: string; label: string }>;
  children: ReactNode;
}

export const TabPanel = RadixTabs.Content;

/** Underline tabs in the mono-label grammar. Wrap panels in <TabPanel value=…>. */
export function Tabs({ value, onValueChange, tabs, children }: TabsProps) {
  return (
    <RadixTabs.Root value={value} onValueChange={onValueChange}>
      <RadixTabs.List className="flex gap-1 border-b border-[var(--line)]">
        {tabs.map((t) => (
          <RadixTabs.Trigger
            key={t.value}
            value={t.value}
            className="focus-ring -mb-px border-b-2 border-transparent px-3 py-2 font-mono text-[11px] font-medium uppercase tracking-[0.12em] text-[var(--ink-mut)] transition-colors data-[state=active]:border-[var(--blue)] data-[state=active]:text-[var(--blue)]"
          >
            {t.label}
          </RadixTabs.Trigger>
        ))}
      </RadixTabs.List>
      {children}
    </RadixTabs.Root>
  );
}
