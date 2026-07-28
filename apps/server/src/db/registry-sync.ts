import { sql } from 'drizzle-orm';
import { makeDb } from './client.js';
import type { DatabaseClient } from './client.js';
import { getAdapter } from '../data-plane/providers/registry.js';

/**
 * Registry sync (part-3/02 / synthesis-memo Overlap-3). Seeds/refreshes model_registry from the LIVE
 * model_prices table (the set of priced, dispatchable models) + the adapters' in-code capability
 * catalogs (the DECLARE-don't-discover seed). The DB registry then becomes the runtime source of truth;
 * the adapter catalog is the fallback. Manual rows (source='manual') are NEVER overwritten. Run:
 * `pnpm registry:sync`. Runs as the migration superuser locally; spillway_jobs in prod.
 */

export interface PricedModel {
  provider: string;
  model: string;
}

export interface RegistryRow {
  canonicalId: string;
  providerModelId: string;
  provider: string;
  lifecycle: string;
  routingEligible: boolean;
  fallbackEligible: boolean;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  capStreaming: boolean;
  capTools: boolean;
  capStructuredOutput: boolean;
  capVision: boolean;
  capAudioInput: boolean;
  capAudioOutput: boolean;
  capEmbeddings: boolean;
  capBatch: boolean;
  capReasoning: boolean;
  capPromptCache: boolean;
}

/**
 * Map each priced model to a registry row using its adapter's declared capabilities. A model whose
 * provider has no adapter is skipped (returned in `skipped`). lifecycle is 'production' only when the
 * full capability matrix + limits are known (satisfies the production_caps CHECK), else 'beta'.
 */
export function buildRegistryRows(priced: PricedModel[]): {
  rows: RegistryRow[];
  skipped: PricedModel[];
} {
  const rows: RegistryRow[] = [];
  const skipped: PricedModel[] = [];
  for (const m of priced) {
    let caps;
    try {
      caps = getAdapter(m.provider).capabilitiesFor(m.model);
    } catch {
      skipped.push(m); // no adapter for this provider → can't declare capabilities
      continue;
    }
    const has = (f: Parameters<typeof caps.features.has>[0]): boolean => caps.features.has(f);
    const contextWindow = caps.maxContextTokens ?? null;
    const maxOutputTokens = caps.maxOutputTokens ?? null;
    // A model with fully-known limits + caps is production-ready; otherwise stage it as beta.
    const lifecycle = contextWindow !== null && maxOutputTokens !== null ? 'production' : 'beta';
    rows.push({
      canonicalId: `${m.provider}/${m.model}`,
      providerModelId: m.model,
      provider: m.provider,
      lifecycle,
      routingEligible: true,
      fallbackEligible: true,
      contextWindow,
      maxOutputTokens,
      capStreaming: has('streaming'),
      capTools: has('tools'),
      capStructuredOutput: has('structured_output'),
      capVision: has('vision'),
      capAudioInput: has('audio_input'),
      capAudioOutput: has('audio_output'),
      capEmbeddings: has('embeddings'),
      capBatch: has('batch'),
      capReasoning: has('reasoning_effort'),
      capPromptCache: has('prompt_caching'),
    });
  }
  return { rows, skipped };
}

/** Upsert the derived rows into model_registry, keyed by canonical_id; NEVER overwrite a manual row. */
export async function syncRegistry(
  db: DatabaseClient,
): Promise<{ upserted: number; skipped: number }> {
  const priced = (await db.execute(sql`
    SELECT provider, model FROM model_prices`)) as unknown as PricedModel[];
  const { rows, skipped } = buildRegistryRows(priced);
  for (const r of rows) {
    await db.execute(sql`
      INSERT INTO model_registry
        (canonical_id, provider_model_id, provider, lifecycle, routing_eligible, fallback_eligible,
         context_window, max_output_tokens, cap_streaming, cap_tools, cap_structured_output, cap_vision,
         cap_audio_input, cap_audio_output, cap_embeddings, cap_batch, cap_reasoning, cap_prompt_cache,
         source, synced_at)
      VALUES (${r.canonicalId}, ${r.providerModelId}, ${r.provider}, ${r.lifecycle}, ${r.routingEligible},
              ${r.fallbackEligible}, ${r.contextWindow}, ${r.maxOutputTokens}, ${r.capStreaming},
              ${r.capTools}, ${r.capStructuredOutput}, ${r.capVision}, ${r.capAudioInput},
              ${r.capAudioOutput}, ${r.capEmbeddings}, ${r.capBatch}, ${r.capReasoning},
              ${r.capPromptCache}, 'litellm', now())
      ON CONFLICT (canonical_id) DO UPDATE SET
        provider_model_id = excluded.provider_model_id, provider = excluded.provider,
        lifecycle = excluded.lifecycle, routing_eligible = excluded.routing_eligible,
        fallback_eligible = excluded.fallback_eligible, context_window = excluded.context_window,
        max_output_tokens = excluded.max_output_tokens, cap_streaming = excluded.cap_streaming,
        cap_tools = excluded.cap_tools, cap_structured_output = excluded.cap_structured_output,
        cap_vision = excluded.cap_vision, cap_audio_input = excluded.cap_audio_input,
        cap_audio_output = excluded.cap_audio_output, cap_embeddings = excluded.cap_embeddings,
        cap_batch = excluded.cap_batch, cap_reasoning = excluded.cap_reasoning,
        cap_prompt_cache = excluded.cap_prompt_cache, synced_at = now()
      WHERE model_registry.source != 'manual'`); // a manually-curated row is authoritative — never synced over
  }
  return { upserted: rows.length, skipped: skipped.length };
}

async function main(): Promise<void> {
  const url =
    process.env.MIGRATION_DATABASE_URL ??
    'postgres://spillway:spillway@localhost:5432/spillway_dev';
  const { db, close } = makeDb(url, 4);
  const { upserted, skipped } = await syncRegistry(db);
  if (upserted === 0 && skipped === 0) {
    // Empty model_prices means pricing:sync never ran — and an empty registry makes EVERY gateway
    // request 403 (`model_not_allowed`: zero candidates), which reads like a routing bug.
    console.error(
      'registry-sync: model_prices is EMPTY — run `pnpm pricing:sync` first (or `pnpm catalog:sync` for both in order).',
    );
    await close();
    process.exit(1);
  }
  console.log(`registry-sync: upserted ${upserted} models (${skipped} skipped — no adapter)`);
  await close();
}

// Run only as a script, not on import (the test imports syncRegistry/buildRegistryRows directly).
if (
  process.argv[1]?.endsWith('registry-sync.ts') ||
  process.argv[1]?.endsWith('registry-sync.js')
) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
