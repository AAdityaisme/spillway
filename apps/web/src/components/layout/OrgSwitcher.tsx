import * as Dropdown from '@radix-ui/react-dropdown-menu';
import { Check, ChevronsUpDown } from 'lucide-react';
import { useOrg } from '../../lib/org.js';
import { Badge } from '../primitives/Badge.js';

/** Org switcher (09-frontend §1.3): dropdown when the user belongs to >1 org, static label otherwise. */
export function OrgSwitcher() {
  const { orgs, activeOrg, switchOrg } = useOrg();

  if (!activeOrg) return null;
  if (orgs.length < 2) {
    return (
      <div className="flex items-center justify-between gap-2 px-2 py-1.5">
        <span className="truncate text-[13px] font-medium">{activeOrg.name}</span>
        <Badge variant="blue">{activeOrg.plan}</Badge>
      </div>
    );
  }

  return (
    <Dropdown.Root>
      <Dropdown.Trigger
        data-testid="org-switcher-trigger"
        className="focus-ring flex w-full items-center justify-between gap-2 rounded-[var(--radius-btn)] px-2 py-1.5 text-left transition-colors hover:bg-[var(--card)]"
      >
        <span className="truncate text-[13px] font-medium">{activeOrg.name}</span>
        <ChevronsUpDown size={13} aria-hidden className="shrink-0 text-[var(--ink-mut)]" />
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content
          align="start"
          sideOffset={4}
          className="z-50 w-56 rounded-[var(--radius-btn)] bg-[var(--card)] p-1 shadow-[var(--shadow-pop)]"
        >
          {orgs.map((o) => (
            <Dropdown.Item
              key={o.id}
              onSelect={() => switchOrg(o.id)}
              className="flex cursor-pointer items-center justify-between gap-2 rounded-md px-2.5 py-2 text-sm outline-none data-[highlighted]:bg-[var(--blue-soft)]"
            >
              <span className="flex min-w-0 items-center gap-2">
                {o.id === activeOrg.id ? (
                  <Check size={13} aria-hidden className="shrink-0 text-[var(--blue)]" />
                ) : (
                  <span className="w-[13px] shrink-0" />
                )}
                <span className="truncate">{o.name}</span>
              </span>
              <Badge variant="blue">{o.plan}</Badge>
            </Dropdown.Item>
          ))}
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}
