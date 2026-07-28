import * as RadixSwitch from '@radix-ui/react-switch';

export interface SwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  id?: string;
  disabled?: boolean;
  testId?: string;
}

/** Radix switch — blue when on, per the one-blue rule. */
export function Switch({ checked, onCheckedChange, id, disabled, testId }: SwitchProps) {
  return (
    <RadixSwitch.Root
      id={id}
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      data-testid={testId}
      className="focus-ring relative h-5 w-9 shrink-0 rounded-full bg-[rgba(11,18,32,0.16)] transition-colors duration-150 disabled:opacity-50 data-[state=checked]:bg-[var(--blue)]"
    >
      <RadixSwitch.Thumb className="block size-4 translate-x-0.5 rounded-full bg-white shadow-sm transition-transform duration-150 data-[state=checked]:translate-x-[18px]" />
    </RadixSwitch.Root>
  );
}
