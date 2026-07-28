import { sql } from 'drizzle-orm';
import type { DatabaseClient } from '../../db/client.js';

/**
 * Data-residency routing gate (part-3/02). A request MUST NOT be served by a model whose
 * `residency_class` the virtual key's effective `compliance_class` may not reach. FAIL-CLOSED: an
 * unknown/`none` compliance reaches ONLY `global` models; you must OPT IN to a residency class to use
 * models tagged with it. A model absent from the registry defaults to `global` at the call site.
 */

const ALLOWED: Record<string, ReadonlySet<string>> = {
  none: new Set(['global']),
  us_only: new Set(['global', 'us_only']),
  eu_only: new Set(['global', 'eu_only']),
  fedramp: new Set(['fedramp']), // strict — no global fallback
  hipaa: new Set(['hipaa_eligible']),
};

/** May a key of `complianceClass` be served by a model of `residencyClass`? Fail-closed on an unknown class. */
export function residencyAllows(complianceClass: string, residencyClass: string): boolean {
  return (ALLOWED[complianceClass] ?? ALLOWED.none!).has(residencyClass);
}

const TTL_MS = 60_000;
let cache: { map: ReadonlyMap<string, string>; at: number } | null = null;

/** Test seam — drop the process cache so a freshly-seeded registry is read on the next call. */
export function resetResidencyCache(): void {
  cache = null;
}

/**
 * `provider:model → residency_class` from `v_model_registry_active`, process-cached (60 s TTL — the
 * registry is a small GLOBAL reference table, so one read amortizes across all requests in the window).
 * A model not present here is treated as `global` by the caller.
 */
export async function getResidencyMap(
  db: DatabaseClient,
  now: number,
): Promise<ReadonlyMap<string, string>> {
  if (cache && now - cache.at < TTL_MS) return cache.map;
  const rows = (await db.execute(sql`
    SELECT provider, provider_model_id, residency_class FROM v_model_registry_active`)) as unknown as {
    provider: string;
    provider_model_id: string;
    residency_class: string;
  }[];
  const map = new Map<string, string>();
  for (const r of rows) map.set(`${r.provider}:${r.provider_model_id}`, r.residency_class);
  cache = { map, at: now };
  return map;
}
