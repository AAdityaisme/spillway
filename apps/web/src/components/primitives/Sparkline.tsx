/**
 * Chrome-free 7-day trend line, plain SVG — recharts is heavyweight for a 120×32 path
 * and is lazy-loaded only on chart pages (09-frontend §7.3 bundle budget).
 */
export interface SparklineProps {
  data: number[];
  width?: number;
  height?: number;
  color?: string;
}

export function Sparkline({
  data,
  width = 96,
  height = 28,
  color = 'var(--blue)',
}: SparklineProps) {
  if (data.length < 2) {
    return <span className="text-xs text-[var(--ink-mut)]">—</span>;
  }
  const max = Math.max(...data, 1e-9);
  const min = Math.min(...data, 0);
  const range = max - min || 1;
  const pad = 2;
  const points = data
    .map((v, i) => {
      const x = pad + (i / (data.length - 1)) * (width - pad * 2);
      const y = height - pad - ((v - min) / range) * (height - pad * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  return (
    <svg width={width} height={height} aria-hidden className="block">
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}
