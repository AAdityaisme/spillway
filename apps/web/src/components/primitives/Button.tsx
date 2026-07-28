import type { ButtonHTMLAttributes, ReactNode } from 'react';

type ButtonVariant = 'primary' | 'ghost' | 'danger' | 'danger-ghost';
type ButtonSize = 'sm' | 'md';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: ReactNode;
}

const VARIANT: Record<ButtonVariant, string> = {
  primary:
    'bg-[var(--blue)] text-white hover:bg-[var(--blue-hover)] active:bg-[var(--blue-deep)] active:translate-y-px',
  ghost:
    'bg-[var(--card)] text-[var(--ink)] shadow-[inset_0_0_0_1px_var(--line)] hover:shadow-[inset_0_0_0_1px_rgba(0,102,204,0.45)]',
  danger: 'bg-[var(--danger)] text-white hover:opacity-90 active:translate-y-px',
  'danger-ghost':
    'bg-[var(--card)] text-[var(--danger)] shadow-[inset_0_0_0_1px_var(--line)] hover:shadow-[inset_0_0_0_1px_rgba(217,45,32,0.45)]',
};

const SIZE: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-[13px]',
  md: 'h-10 px-4 text-sm',
};

/** The homepage button grammar: 10px radius, 600 weight, one blue, inset-ring ghosts. */
export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  icon,
  className = '',
  children,
  disabled,
  ...rest
}: ButtonProps) {
  return (
    <button
      className={`focus-ring inline-flex items-center justify-center gap-2 rounded-[var(--radius-btn)] font-semibold tracking-[-0.01em] transition-[background,box-shadow,opacity] duration-150 disabled:cursor-not-allowed disabled:opacity-50 ${VARIANT[variant]} ${SIZE[size]} ${className}`}
      disabled={disabled || loading}
      {...rest}
    >
      {loading ? (
        <span
          aria-hidden
          className="size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent"
        />
      ) : (
        icon
      )}
      {children}
    </button>
  );
}
