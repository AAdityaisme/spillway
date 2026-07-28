import * as RadixDialog from '@radix-ui/react-dialog';
import type { ReactNode } from 'react';

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children?: ReactNode;
  actions: ReactNode;
  /** Destructive dialogs cannot be dismissed via Escape/backdrop — explicit button only (09-frontend §3.7). */
  destructive?: boolean;
}

/** Centered modal on Radix Dialog. */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  actions,
  destructive = false,
}: DialogProps) {
  return (
    <RadixDialog.Root open={open} onOpenChange={(o) => !o && !destructive && onClose()}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-40 bg-[rgba(11,18,32,0.32)] data-[state=open]:animate-[fade-in_200ms_var(--ease-big)]" />
        <RadixDialog.Content
          onEscapeKeyDown={destructive ? (e) => e.preventDefault() : undefined}
          onPointerDownOutside={destructive ? (e) => e.preventDefault() : undefined}
          onInteractOutside={destructive ? (e) => e.preventDefault() : undefined}
          className="fixed left-1/2 top-1/2 z-50 w-[calc(100vw-32px)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-[var(--radius-card)] bg-[var(--card)] p-6 shadow-[var(--shadow-pop)] outline-none data-[state=open]:animate-[dialog-in_220ms_var(--ease-big)]"
          aria-describedby={description ? undefined : undefined}
        >
          <RadixDialog.Title
            className={`text-[15px] font-semibold tracking-[-0.01em] ${destructive ? 'text-[var(--danger)]' : ''}`}
          >
            {title}
          </RadixDialog.Title>
          {description ? (
            <RadixDialog.Description className="mt-1.5 text-sm text-[var(--ink-read)]">
              {description}
            </RadixDialog.Description>
          ) : null}
          {children ? <div className="mt-4">{children}</div> : null}
          <div className="mt-5 flex items-center justify-end gap-2">{actions}</div>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
