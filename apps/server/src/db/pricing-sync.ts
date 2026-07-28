import { sql } from 'drizzle-orm';
import { parseLitellmPrices, loadVendoredSnapshot, capabilitiesFor } from '@spillway/pricing';
import { makeDb } from './client.js';
import type { DatabaseClient } from './client.js';
import { modelPrices } from './schema.js';

/**
 * part-3/04 reproducibility ledger: record an immutable snapshot of the ENTIRE live model_prices table
 * as a new catalog version, so any request stamped with this version id re-derives its exact cost later.
 * Snapshots via SELECT FROM model_prices (post-upsert) — no field re-mapping, always in lock-step with
 * the live rate set. Returns the new version id. Exported for the sync + tests.
 */
export async function writeCatalogVersion(
  db: DatabaseClient,
  meta: { sourceName: string; sourceUrl?: string; sourceCommitSha?: string; syncedAt: Date },
): Promise<string> {
  const iso = meta.syncedAt.toISOString();
  const inserted = (await db.execute(sql`
    INSERT INTO price_catalog_versions (source_name, source_url, source_commit_sha, synced_at, effective_from, approval_state)
    VALUES (${meta.sourceName}, ${meta.sourceUrl ?? null}, ${meta.sourceCommitSha ?? null}, ${iso}, ${iso}, 'auto_approved')
    RETURNING id`)) as unknown as { id: string }[];
  const versionId = inserted[0]!.id;
  await db.execute(sql`
    INSERT INTO price_catalog_snapshots
      (catalog_version_id, provider, model, input_usd_per_m, output_usd_per_m, cache_read_usd_per_m,
       cache_write_5m_usd_per_m, cache_write_1h_usd_per_m, input_usd_per_m_long, long_context_threshold,
       tiers, service_tier_multipliers, output_cost_per_reasoning_usd_per_m, input_cost_per_audio_usd_per_m,
       output_cost_per_audio_usd_per_m, input_cost_per_image_usd_per_unit, output_cost_per_image_usd_per_unit,
       tool_cost_per_session_usd, web_search_cost_per_query_usd, regional_multipliers)
    SELECT ${versionId}::uuid, provider, model, input_usd_per_m, output_usd_per_m, cache_read_usd_per_m,
       cache_write_5m_usd_per_m, cache_write_1h_usd_per_m, input_usd_per_m_long, long_context_threshold,
       tiers, service_tier_multipliers, output_cost_per_reasoning_usd_per_m, input_cost_per_audio_usd_per_m,
       output_cost_per_audio_usd_per_m, input_cost_per_image_usd_per_unit, output_cost_per_image_usd_per_unit,
       tool_cost_per_session_usd, web_search_cost_per_query_usd, regional_multipliers
    FROM model_prices`);
  return versionId;
}

/**
 * pricing-sync job (ADR-010): vendored LiteLLM snapshot → model_prices upsert,
 * then price_overrides are re-applied (none yet at Phase A). Run manually:
 * `pnpm pricing:sync`. Connects as the migration superuser locally; in prod this
 * runs as spillway_jobs (which holds INSERT/UPDATE on the global price tables).
 */
async function main(): Promise<void> {
  const url =
    process.env.MIGRATION_DATABASE_URL ??
    'postgres://spillway:spillway@localhost:5432/spillway_dev';
  const { db, close } = makeDb(url, 4);

  const parsed = parseLitellmPrices(loadVendoredSnapshot());
  // (provider/model) prefix-stripping can collide (e.g. 'gemini/x' + 'x') — dedupe, last wins,
  // so a single batch upsert never hits the same conflict row twice.
  const rows = [...new Map(parsed.map((r) => [`${r.provider}:${r.model}`, r])).values()];
  const syncedAt = new Date();

  await db
    .insert(modelPrices)
    // §5.1 capability catalog: stamp each row's advertised capabilities from the static family map
    // (capabilitiesFor → null for unknown families, leaving the column NULL / out of the catalog).
    .values(
      rows.map((r) => ({ ...r, capabilities: capabilitiesFor(r.provider, r.model), syncedAt })),
    )
    .onConflictDoUpdate({
      target: [modelPrices.provider, modelPrices.model],
      set: {
        inputUsdPerM: sql`excluded.input_usd_per_m`,
        outputUsdPerM: sql`excluded.output_usd_per_m`,
        cacheReadUsdPerM: sql`excluded.cache_read_usd_per_m`,
        cacheWrite5mUsdPerM: sql`excluded.cache_write_5m_usd_per_m`,
        cacheWrite1hUsdPerM: sql`excluded.cache_write_1h_usd_per_m`,
        inputUsdPerMLong: sql`excluded.input_usd_per_m_long`,
        longContextThreshold: sql`excluded.long_context_threshold`,
        contextWindow: sql`excluded.context_window`,
        maxOutputTokens: sql`excluded.max_output_tokens`,
        capabilities: sql`excluded.capabilities`,
        source: sql`excluded.source`,
        syncedAt: sql`excluded.synced_at`,
      },
    });

  // part-3/04: freeze this sync run as an immutable, reproducible catalog version + snapshot.
  const versionId = await writeCatalogVersion(db, { sourceName: 'litellm_vendored', syncedAt });
  console.log(`pricing-sync: upserted ${rows.length} model prices (catalog version ${versionId})`);
  await close();
}

// CLI-entry guard (matches registry-sync.ts / migrate.ts). WITHOUT this, importing `writeCatalogVersion`
// (e.g. from reconcile's catalog-version stamping or the ledger tests) ran the FULL pricing sync as an
// import side-effect and called process.exit(1) on any failure — an unhandled rejection that killed the
// whole test runner despite every test passing. main() must run ONLY when invoked directly as the CLI.
const isCliEntry =
  process.argv[1]?.endsWith('pricing-sync.ts') === true ||
  process.argv[1]?.endsWith('pricing-sync.js') === true;
if (isCliEntry) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
