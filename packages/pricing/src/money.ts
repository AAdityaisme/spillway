/**
 * Decimal-safe USD arithmetic (ADR-019e).
 *
 * Money is `numeric(14,6)` in the DB. In JS we NEVER use `parseFloat` for
 * comparisons or accumulation — float drift corrupts budget enforcement and
 * chargeback reconciliation. Instead we carry money as **integer micro-USD**
 * (1 USD = 1_000_000 µUSD, matching the 6 decimal places of numeric(14,6)) in
 * a `bigint`, and only render to a fixed-precision decimal string at the edges.
 */

/** Decimal places of precision (matches numeric(14,6)). */
export const USD_DECIMALS = 6;
const SCALE = 1_000_000n; // 10 ** USD_DECIMALS

/**
 * Parse a USD amount into integer micro-USD (bigint), exactly.
 * Accepts a decimal string (preferred — DB returns numeric as string) or a
 * number (rounded to 6 dp via string conversion). Rejects non-finite numbers.
 */
export function parseUsd(value: string | number): bigint {
  const str = typeof value === 'number' ? numberToDecimalString(value) : value.trim();
  const match = /^(-)?(\d+)(?:\.(\d+))?$/.exec(str);
  if (!match) throw new RangeError(`invalid USD amount: ${JSON.stringify(value)}`);
  const sign = match[1] ? -1n : 1n;
  const whole = BigInt(match[2] ?? '0');
  const fracRaw = match[3] ?? '';
  // Pad/truncate the fractional part to exactly USD_DECIMALS digits.
  const fracPadded = (fracRaw + '0'.repeat(USD_DECIMALS)).slice(0, USD_DECIMALS);
  const frac = BigInt(fracPadded);
  return sign * (whole * SCALE + frac);
}

/**
 * L44: Parse a non-negative price USD string (model prices, price overrides).
 * Negative prices are a typo/attack — a negative input price turns every token into a
 * credit, making budgets never trip. Reject them at the parse boundary.
 */
export function parseNonNegativeUsd(value: string | number): bigint {
  const micro = parseUsd(value);
  if (micro < 0n) throw new RangeError(`price must be non-negative: ${JSON.stringify(value)}`);
  return micro;
}

/** Render integer micro-USD as a fixed 6-decimal-place USD string. */
export function formatUsd(micro: bigint): string {
  const neg = micro < 0n;
  const abs = neg ? -micro : micro;
  const whole = abs / SCALE;
  const frac = (abs % SCALE).toString().padStart(USD_DECIMALS, '0');
  return `${neg ? '-' : ''}${whole.toString()}.${frac}`;
}

export function addUsd(a: bigint, b: bigint): bigint {
  return a + b;
}

export function subUsd(a: bigint, b: bigint): bigint {
  return a - b;
}

/** -1 if a<b, 0 if equal, 1 if a>b. Exact — the budget-enforcement comparator. */
export function compareUsd(a: bigint, b: bigint): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0;
}

function numberToDecimalString(n: number): string {
  if (!Number.isFinite(n)) throw new RangeError(`invalid USD amount: ${n}`);
  // toFixed avoids exponential notation and bounds precision to 6 dp.
  return n.toFixed(USD_DECIMALS);
}
