import { Check, Copy } from 'lucide-react';
import { useState } from 'react';

export interface CodeBlockProps {
  code: string;
  copyable?: boolean;
  testId?: string;
}

/** Ink-dark mono block with copy-to-clipboard — key reveals, quickstarts, JSON detail. */
export function CodeBlock({ code, copyable = true, testId }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);

  const copy = (): void => {
    void navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className="relative rounded-[var(--radius-btn)] bg-[var(--ink)]">
      <pre className="overflow-x-auto px-4 py-3.5 font-mono text-[12.5px] leading-relaxed text-[#e8ecf4]">
        <code>{code}</code>
      </pre>
      {copyable ? (
        <button
          type="button"
          onClick={copy}
          data-testid={testId}
          aria-label={copied ? 'Copied' : 'Copy to clipboard'}
          className="focus-ring absolute right-2.5 top-2.5 rounded-md p-1.5 text-[#8a93a6] transition-colors hover:bg-[rgba(255,255,255,0.08)] hover:text-white"
        >
          {copied ? (
            <Check size={14} aria-hidden className="text-[var(--pass)]" />
          ) : (
            <Copy size={14} aria-hidden />
          )}
        </button>
      ) : null}
    </div>
  );
}
