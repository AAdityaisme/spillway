import { getAdapter } from '../data-plane/providers/registry.js';
import { FEATURE_CAP_COLUMN, type RequestFeature } from '../data-plane/providers/types.js';

/**
 * Registry ↔ adapter anti-drift lock (synthesis-memo Overlap-3). The DB registry is the RUNTIME source
 * of truth, the adapter's in-code catalog is the seed — but the registry must never claim a capability
 * the adapter code cannot actually deliver (a manual over-claim, or an adapter that dropped a feature
 * without a re-sync). This is the CI invariant: every `cap_* = true` MUST be backed by adapter.supports.
 */

export interface RegistryCapRow {
  canonical_id: string;
  provider: string;
  provider_model_id: string;
  [capColumn: string]: unknown; // the cap_* booleans (snake_case, as read from the DB)
}

export interface CapabilityDrift {
  canonicalId: string;
  feature: RequestFeature;
  capColumn: string;
}

/** Every capability the REGISTRY claims true that the adapter does NOT declare — empty = no drift. */
export function findCapabilityDrift(rows: RegistryCapRow[]): CapabilityDrift[] {
  const drift: CapabilityDrift[] = [];
  const featureColumns = Object.entries(FEATURE_CAP_COLUMN) as [RequestFeature, string][];
  for (const row of rows) {
    let adapter;
    try {
      adapter = getAdapter(row.provider);
    } catch {
      continue; // no adapter for this provider → not a claim we can (or should) verify here
    }
    for (const [feature, capColumn] of featureColumns) {
      if (row[capColumn] === true && !adapter.supports(row.provider_model_id, feature)) {
        drift.push({ canonicalId: row.canonical_id, feature, capColumn });
      }
    }
  }
  return drift;
}
