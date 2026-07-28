import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { formatCount, usd } from '../../lib/format.js';

/**
 * The Overview chart, isolated so Recharts stays out of the initial bundle
 * (React.lazy at the call site — bible 09 §7.3). Weave-style: a dashed
 * daily-average benchmark line gives every day a comparison point.
 */

export type ChartMetric = 'spend' | 'requests';

function ChartTooltip({
  active,
  payload,
  label,
  metric,
}: {
  active?: boolean;
  payload?: { value: number }[];
  label?: string;
  metric: ChartMetric;
}) {
  if (!active || !payload?.length) return null;
  const v = payload[0]!.value;
  return (
    <div className="rounded-[var(--radius-btn)] bg-[var(--card)] px-3 py-2 shadow-[var(--shadow-pop)]">
      <div className="font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--ink-mut)]">
        {label}
      </div>
      <div className="num text-sm font-medium">
        {metric === 'spend' ? usd(String(v)) : `${formatCount(v)} requests`}
      </div>
    </div>
  );
}

export interface SpendChartPoint {
  date: string;
  spend: number;
  requests: number;
}

export default function SpendChart({
  points,
  metric,
}: {
  points: SpendChartPoint[];
  metric: ChartMetric;
}) {
  const values = points.map((p) => p[metric]);
  const avg = values.length ? values.reduce((s, v) => s + v, 0) / values.length : 0;
  const fmtTick =
    metric === 'spend'
      ? (v: number) =>
          v >= 10 ? `$${v.toFixed(0)}` : v >= 1 ? `$${v.toFixed(1)}` : `$${v.toFixed(2)}`
      : (v: number) => formatCount(v);

  return (
    <ResponsiveContainer width="100%" height={220}>
      <AreaChart data={points} margin={{ top: 4, right: 8, left: -8, bottom: 0 }}>
        <defs>
          <linearGradient id="spendFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--blue)" stopOpacity={0.16} />
            <stop offset="100%" stopColor="var(--blue)" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke="var(--line)" strokeDasharray="0" vertical={false} />
        <XAxis
          dataKey="date"
          tick={{ fontSize: 10.5, fill: 'var(--ink-mut)', fontFamily: 'var(--mono)' }}
          tickLine={false}
          axisLine={{ stroke: 'var(--line)' }}
          minTickGap={24}
        />
        <YAxis
          tick={{ fontSize: 10.5, fill: 'var(--ink-mut)', fontFamily: 'var(--mono)' }}
          tickLine={false}
          axisLine={false}
          width={52}
          tickFormatter={fmtTick}
        />
        <RechartsTooltip
          content={<ChartTooltip metric={metric} />}
          cursor={{ stroke: 'var(--line-strong)' }}
        />
        {avg > 0 ? (
          <ReferenceLine
            y={avg}
            stroke="var(--ink-mut)"
            strokeDasharray="4 4"
            strokeOpacity={0.6}
            label={{
              value: `avg ${metric === 'spend' ? usd(String(avg)) : formatCount(Math.round(avg))}/day`,
              position: 'insideTopRight',
              fill: 'var(--ink-mut)',
              fontSize: 10.5,
              fontFamily: 'var(--mono)',
            }}
          />
        ) : null}
        <Area
          type="monotone"
          dataKey={metric}
          stroke="var(--blue)"
          strokeWidth={1.75}
          fill="url(#spendFill)"
          dot={false}
          activeDot={{ r: 3.5, fill: 'var(--blue)' }}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
