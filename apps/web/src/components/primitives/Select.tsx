import * as RadixSelect from '@radix-ui/react-select';
import { Check, ChevronDown } from 'lucide-react';

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectProps {
  value: string | undefined;
  onValueChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  id?: string;
  disabled?: boolean;
  testId?: string;
}

/** Radix select styled to the input grammar. */
export function Select({
  value,
  onValueChange,
  options,
  placeholder,
  id,
  disabled,
  testId,
}: SelectProps) {
  return (
    <RadixSelect.Root value={value} onValueChange={onValueChange} disabled={disabled}>
      <RadixSelect.Trigger
        id={id}
        data-testid={testId}
        className="focus-ring flex w-full items-center justify-between gap-2 rounded-[var(--radius-btn)] bg-[var(--card)] px-3 py-2 text-sm shadow-[inset_0_0_0_1px_var(--line)] disabled:opacity-50 data-[placeholder]:text-[var(--ink-mut)]"
      >
        <RadixSelect.Value placeholder={placeholder ?? 'Select…'} />
        <RadixSelect.Icon>
          <ChevronDown size={14} aria-hidden className="text-[var(--ink-mut)]" />
        </RadixSelect.Icon>
      </RadixSelect.Trigger>
      <RadixSelect.Portal>
        <RadixSelect.Content
          position="popper"
          sideOffset={4}
          className="z-50 min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-[var(--radius-btn)] bg-[var(--card)] shadow-[var(--shadow-pop)]"
        >
          <RadixSelect.Viewport className="max-h-72 p-1">
            {options.map((o) => (
              <RadixSelect.Item
                key={o.value}
                value={o.value}
                className="flex cursor-pointer items-center justify-between gap-3 rounded-md px-2.5 py-1.5 text-sm outline-none data-[highlighted]:bg-[var(--blue-soft)] data-[highlighted]:text-[var(--blue)]"
              >
                <RadixSelect.ItemText>{o.label}</RadixSelect.ItemText>
                <RadixSelect.ItemIndicator>
                  <Check size={13} aria-hidden />
                </RadixSelect.ItemIndicator>
              </RadixSelect.Item>
            ))}
          </RadixSelect.Viewport>
        </RadixSelect.Content>
      </RadixSelect.Portal>
    </RadixSelect.Root>
  );
}
