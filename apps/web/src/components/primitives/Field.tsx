import type { InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from 'react';

export interface FieldProps {
  label: string;
  htmlFor: string;
  hint?: string;
  error?: string | null;
  children: ReactNode;
}

/** Label + control + hint/error stack. Every input gets a real <label> (09-frontend §7.1). */
export function Field({ label, htmlFor, hint, error, children }: FieldProps) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-[13px] font-medium text-[var(--ink)]">
        {label}
      </label>
      {children}
      {error ? (
        <p className="text-xs text-[var(--danger)]">{error}</p>
      ) : hint ? (
        <p className="text-xs text-[var(--ink-mut)]">{hint}</p>
      ) : null}
    </div>
  );
}

const CONTROL =
  'focus-ring w-full rounded-[var(--radius-btn)] bg-[var(--card)] px-3 py-2 text-sm text-[var(--ink)] shadow-[inset_0_0_0_1px_var(--line)] placeholder:text-[var(--ink-mut)] disabled:opacity-50';

export function Input({ className = '', ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`${CONTROL} ${className}`} {...rest} />;
}

export function TextArea({ className = '', ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={`${CONTROL} min-h-20 ${className}`} {...rest} />;
}
