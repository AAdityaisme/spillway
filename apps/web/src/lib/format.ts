/**
 * Display formatters (09-frontend §1.2 lib/format.ts). Money arrives as exact decimal
 * strings from the API — Number() here is display-only, never comparison logic.
 */

/** "1234.567890" → "$1,234.57" (or more precision for sub-cent values). */
export function usd(value: string | null | undefined, opts?: { precise?: boolean }): string {
  if (value === null || value === undefined || value === '') return '—';
  const n = Number(value);
  if (Number.isNaN(n)) return '—';
  if (opts?.precise || (n !== 0 && Math.abs(n) < 0.01)) {
    return `$${n.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 6 })}`;
  }
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Compact dollar figure for tight cells: "$12.4k", "$1.2M". */
export function compactUsd(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  const n = Number(value);
  if (Number.isNaN(n)) return '—';
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 10_000) return `$${(n / 1_000).toFixed(1)}k`;
  return usd(value);
}

/** 1234 → "1.2k"; token counts and request counts. */
export function formatCount(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** ISO timestamp → "2s ago" / "5m ago" / "3h ago" / "2d ago". */
export function relTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const delta = Date.now() - new Date(iso).getTime();
  if (delta < 5_000) return 'just now';
  if (delta < 60_000) return `${Math.floor(delta / 1_000)}s ago`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return `${Math.floor(delta / 86_400_000)}d ago`;
}

/** ISO timestamp → "Jul 16, 14:32:05" (local). */
export function absTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

/** ISO timestamp → "Jul 16, 2026". */
export function dateLabel(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/** 12.345 → "12.35%" (API percentages are already-computed numbers). */
export function pct(n: number | null | undefined, dp = 1): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return `${n.toFixed(dp)}%`;
}

/** "2026-07" → "July 2026". */
export function monthLabel(period: string): string {
  const [y, m] = period.split('-').map(Number);
  if (!y || !m) return period;
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** Current UTC month as "YYYY-MM" (the KPI default period). */
export function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

/** Today as "YYYY-MM-DD" (UTC — matches the server's day bucketing). */
export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** N days before today as "YYYY-MM-DD" (UTC). */
export function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

/** Previous N months as "YYYY-MM" options for month pickers, newest first. */
export function recentMonths(count: number): string[] {
  const out: string[] = [];
  const d = new Date();
  for (let i = 0; i < count; i++) {
    out.push(
      new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1)).toISOString().slice(0, 7),
    );
  }
  return out;
}

/** Key prefix display: "mk-live-Ab3d" → "mk-live-Ab3d…". */
export function keyPrefix(prefix: string | null | undefined): string {
  return prefix ? `${prefix}…` : '—';
}
