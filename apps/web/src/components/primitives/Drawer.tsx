import * as RadixDialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  width?: 'sm' | 'md' | 'lg';
  footer?: ReactNode;
}

const WIDTH: Record<NonNullable<DrawerProps['width']>, string> = {
  sm: 'max-w-[400px]',
  md: 'max-w-[560px]',
  lg: 'max-w-[720px]',
};

/** Right-side sheet on Radix Dialog — focus-trapped, Escape/backdrop closes, focus restored on close. */
export function Drawer({ open, onClose, title, children, width = 'md', footer }: DrawerProps) {
  return (
    <RadixDialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-40 bg-[rgba(11,18,32,0.32)] data-[state=open]:animate-[fade-in_200ms_var(--ease-big)]" />
        <RadixDialog.Content
          className={`fixed inset-y-0 right-0 z-50 flex w-full flex-col bg-[var(--card)] shadow-[var(--shadow-pop)] outline-none data-[state=open]:animate-[drawer-in_260ms_var(--ease-big)] ${WIDTH[width]}`}
          aria-describedby={undefined}
        >
          <div className="flex items-center justify-between border-b border-[var(--line)] px-6 py-4">
            <RadixDialog.Title className="text-[15px] font-semibold tracking-[-0.01em]">
              {title}
            </RadixDialog.Title>
            <RadixDialog.Close
              aria-label="Close"
              className="focus-ring rounded-md p-1.5 text-[var(--ink-mut)] transition-colors hover:bg-[var(--paper)] hover:text-[var(--ink)]"
            >
              <X size={16} aria-hidden />
            </RadixDialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">{children}</div>
          {footer ? (
            <div className="flex items-center justify-end gap-2 border-t border-[var(--line)] px-6 py-4">
              {footer}
            </div>
          ) : null}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
