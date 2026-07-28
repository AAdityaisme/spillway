/**
 * Postgres error introspection that survives driver-wrapper churn.
 *
 * drizzle ≥0.36 wraps every driver failure in a `DrizzleQueryError` whose OWN `.code` is unset — the
 * Postgres SQLSTATE lives on the `.cause` (the underlying postgres.js `PostgresError`). Reading
 * `error.code` at the top level therefore silently returns `undefined`, so a unique-violation looks
 * like an opaque error and maps to 500 instead of 409. Walk the cause chain instead. A SQLSTATE is
 * ALWAYS exactly five characters (e.g. `23505`, `22P02`), which cleanly disambiguates it from any
 * wrapper's own longer `.code`.
 */
export function pgErrorCode(err: unknown): string | undefined {
  for (let e: unknown = err, i = 0; e && i < 6; e = (e as { cause?: unknown }).cause, i++) {
    const c = (e as { code?: unknown }).code;
    if (typeof c === 'string' && c.length === 5) return c;
  }
  return undefined;
}

/** True when `err` (or a wrapped cause) is a Postgres unique-violation (SQLSTATE 23505). */
export function isUniqueViolation(err: unknown): boolean {
  return pgErrorCode(err) === '23505';
}
