import type { KeyboardEvent, ReactNode } from 'react';
import { Card } from './Card.js';
import { Skeleton } from './Skeleton.js';

export interface Column<T> {
  key: string;
  header: ReactNode;
  render: (row: T) => ReactNode;
  width?: string;
  align?: 'left' | 'right';
}

export interface TableProps<T> {
  columns: Column<T>[];
  data: T[];
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  loading?: boolean;
  skeletonRows?: number;
  empty?: ReactNode;
  testId?: string;
  rowTestId?: (row: T) => string;
}

/**
 * Data table in a card shell. Clickable rows are keyboard-navigable (tabIndex + Enter/Space,
 * 09-frontend §7.1). Loading shows skeleton rows — never a spinner on first paint.
 */
export function Table<T>({
  columns,
  data,
  rowKey,
  onRowClick,
  loading = false,
  skeletonRows = 5,
  empty,
  testId,
  rowTestId,
}: TableProps<T>) {
  const handleKey = (e: KeyboardEvent<HTMLTableRowElement>, row: T): void => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onRowClick?.(row);
    }
  };

  return (
    <Card padding="none" className="overflow-x-auto">
      <table className="w-full text-sm" data-testid={testId} role={onRowClick ? 'grid' : undefined}>
        {/* Empty states own the card — table chrome above "nothing here" reads unfinished. */}
        <thead className={!loading && data.length === 0 ? 'hidden' : undefined}>
          <tr className="border-b border-[var(--line)]">
            {columns.map((c) => (
              <th
                key={c.key}
                style={c.width ? { width: c.width } : undefined}
                className={`eyebrow px-4 py-3 font-medium ${c.align === 'right' ? 'text-right' : 'text-left'}`}
              >
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {loading ? (
            Array.from({ length: skeletonRows }, (_, i) => (
              <tr key={i} className="border-b border-[var(--line)] last:border-0">
                {columns.map((c) => (
                  <td key={c.key} className="px-4 py-3">
                    <Skeleton className="h-4 w-full max-w-32" />
                  </td>
                ))}
              </tr>
            ))
          ) : data.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="px-4 py-10">
                {empty ?? (
                  <div className="text-center text-sm text-[var(--ink-mut)]">Nothing here yet.</div>
                )}
              </td>
            </tr>
          ) : (
            data.map((row) => (
              <tr
                key={rowKey(row)}
                data-testid={rowTestId?.(row)}
                tabIndex={onRowClick ? 0 : undefined}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                onKeyDown={onRowClick ? (e) => handleKey(e, row) : undefined}
                className={`border-b border-[var(--line)] last:border-0 ${
                  onRowClick
                    ? 'focus-ring cursor-pointer transition-colors duration-100 hover:bg-[var(--paper)]'
                    : ''
                }`}
              >
                {columns.map((c) => (
                  <td
                    key={c.key}
                    className={`px-4 py-3 ${c.align === 'right' ? 'text-right' : 'text-left'}`}
                  >
                    {c.render(row)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </Card>
  );
}
