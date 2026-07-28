import { ApiError } from '../../lib/api.js';
import { Button } from '../primitives/Button.js';
import { Card } from '../primitives/Card.js';

export interface SectionErrorProps {
  error: unknown;
  onRetry: () => void;
}

/** Inline per-section error card with Retry — a failed query never kills the whole page (09-frontend §3.4). */
export function SectionError({ error, onRetry }: SectionErrorProps) {
  const message =
    error instanceof ApiError
      ? `${error.code}: ${error.message}`
      : 'Something went wrong loading this section.';
  return (
    <Card className="flex items-center justify-between gap-4">
      <p className="text-sm text-[var(--danger)]">{message}</p>
      <Button variant="ghost" size="sm" onClick={onRetry}>
        Retry
      </Button>
    </Card>
  );
}
