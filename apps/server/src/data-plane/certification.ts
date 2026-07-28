import { sql } from 'drizzle-orm';
import { getDeclaredCaps, type CapabilityId } from '@spillway/certifier';
import type { DatabaseClient } from '../db/client.js';

/**
 * Certified-capability resolver for the /v1/models catalog (part-3/06). A capability is "available" iff
 * it is BOTH declared (DECLARED_CAPS — the fixture-certified contract) AND has a passing nightly smoke
 * result within 72h. A provider with no recent smoke result falls back to DECLARED_CAPS (fixture-
 * certified but not smoke-certified). Global reference read (no org tx). Never advertises a capability
 * the fixtures don't declare — the matrix is the ceiling.
 */
export async function getCatalogCapabilities(
  db: DatabaseClient,
  provider: string,
): Promise<ReadonlySet<CapabilityId>> {
  const declared = getDeclaredCaps(provider);
  const rows = (await db.execute(sql`
    SELECT DISTINCT capability FROM certifier_results
     WHERE provider = ${provider} AND status = 'PASS' AND created_at > now() - interval '72 hours'`)) as unknown as {
    capability: string;
  }[];
  if (rows.length === 0) return declared; // no recent smoke → fixture-certified fallback
  const smoke = new Set(rows.map((r) => r.capability));
  // Intersection: declared AND smoke-passed. A smoke pass for an UNdeclared cap is ignored (the matrix
  // is the source of truth); a declared cap with no recent smoke pass is demoted from the catalog.
  return new Set([...declared].filter((c) => smoke.has(c)));
}
