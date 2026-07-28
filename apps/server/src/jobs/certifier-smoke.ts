import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { computeCost, formatUsd } from '@spillway/pricing';
import {
  getDeclaredCaps,
  planWithinBudget,
  runCapability,
  DEFAULT_SPEND_CAP_USD,
  type CapabilityId,
  type PlannedCall,
} from '@spillway/certifier';
import { makeDb, type DatabaseClient } from '../db/client.js';
import { getAdapter } from '../data-plane/providers/registry.js';
import { getModelPrice } from '../data-plane/pricing.js';

/**
 * Model-certification LAYER 2 — nightly LIVE smoke (part-3/06). For each provider whose API key is in
 * the environment, probes each declared capability against the REAL API, spend-capped per provider
 * (CERTIFIER_SPEND_CAP_USD, default $0.10), and writes one certifier_results row per capability. The
 * /v1/models catalog reads these (last passing within 72h ∩ DECLARED_CAPS). ENV-GATED: a provider with
 * no key is skipped entirely, so this exits 0 without keys (nightly cron uses `continue-on-error`).
 *
 * Layer 1 (deterministic fixtures, no network) runs on every PR in the unit project; THIS is the live
 * layer, run only on the nightly schedule with CI secrets — never in the PR gate.
 */

interface ProviderProbe {
  provider: string;
  apiKeyEnv: string;
  model: string; // a cheap, small model for the smoke call
}

// One cheap model per provider — the smoke calls are minimal (a 10-token completion), well under the cap.
const PROBES: ProviderProbe[] = [
  { provider: 'openai', apiKeyEnv: 'OPENAI_API_KEY', model: 'gpt-4o-mini' },
  { provider: 'anthropic', apiKeyEnv: 'ANTHROPIC_API_KEY', model: 'claude-haiku-4-5' },
  { provider: 'gemini', apiKeyEnv: 'GEMINI_API_KEY', model: 'gemini-2.5-flash' },
];

/** Capabilities this v1 smoke actually exercises with a live call. Others are recorded SKIPPED. */
const PROBED: CapabilityId[] = ['CHAT_NONSTREAM', 'USAGE_EXTRACTION'];

/**
 * A single live CHAT_NONSTREAM/USAGE_EXTRACTION probe: send a minimal request through the adapter to the
 * real provider, parse usage, reconcile cost. PASS iff the response carried real usage; the classifier
 * (runCapability) handles transient 429/5xx with one retry before SKIPPED_TRANSIENT.
 */
async function probe(
  db: DatabaseClient,
  p: ProviderProbe,
  apiKey: string,
): Promise<{ ok: boolean; status: number; costUsd?: number; error?: string }> {
  try {
    const adapter = getAdapter(p.provider);
    const transformed = adapter.transform(
      { model: p.model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 8 },
      { provider: p.provider as never, model: p.model, providerKeyId: 'smoke' },
      apiKey,
      { injectUsage: false },
    );
    const res = await fetch(transformed.url, {
      method: 'POST',
      headers: transformed.headers,
      body: JSON.stringify(transformed.body),
    });
    if (!res.ok) {
      // Keep the upstream body — "upstream 400" alone turns a 5-second diagnosis (e.g. "credit
      // balance is too low") into a re-run with curl. Truncate: error_detail is an audit column,
      // not a payload store.
      const body = await res.text().catch(() => '');
      return {
        ok: false,
        status: res.status,
        error: `upstream ${res.status}${body ? `: ${body.slice(0, 500)}` : ''}`,
      };
    }
    const body: unknown = await res.json();
    const usage = adapter.parseBody(body);
    if (!usage) return { ok: false, status: 200, error: 'no usage in response' };
    const price = await getModelPrice(db, p.provider, p.model);
    // Map the wire-shaped ParsedUsage → canonical (mirrors reconcile toCanonical) — a partial object
    // would leave cachedReadTokens undefined and make computeCost throw BigInt(NaN) on every probe.
    const cost = computeCost(
      {
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        cachedReadTokens: usage.cached_read_tokens,
        cacheWrite5mTokens: usage.cache_write_5m_tokens,
        cacheWrite1hTokens: usage.cache_write_1h_tokens,
        reasoningTokens: usage.reasoning_tokens,
        audioInputTokens: usage.audio_input_tokens,
        audioOutputTokens: usage.audio_output_tokens,
        imageInputCount: usage.image_input_units,
      },
      price,
    );
    return {
      ok: true,
      status: 200,
      costUsd: cost.costMicroUsd ? Number(formatUsd(cost.costMicroUsd)) : 0,
    };
  } catch (err) {
    return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function runSmoke(db: DatabaseClient): Promise<{ runId: string; written: number }> {
  const runId = randomUUID();
  const capUsd = Number(process.env.CERTIFIER_SPEND_CAP_USD ?? DEFAULT_SPEND_CAP_USD);
  let written = 0;

  for (const p of PROBES) {
    const apiKey = process.env[p.apiKeyEnv];
    if (!apiKey) {
      console.log(`certifier-smoke: ${p.provider} skipped — ${p.apiKeyEnv} not set`);
      continue;
    }
    const declared = getDeclaredCaps(p.provider);
    // Each probed capability costs ~one minimal call; estimate conservatively for the budget planner.
    const calls: PlannedCall[] = PROBED.filter((c) => declared.has(c)).map((capability) => ({
      capability,
      model: p.model,
      estimatedCostUsd: 0.001,
    }));
    for (const { call, run } of planWithinBudget(calls, capUsd)) {
      const result = await runCapability({ call, run }, p.provider, () => probe(db, p, apiKey));
      await db.execute(sql`
        INSERT INTO certifier_results (run_id, provider, capability, model, status, cost_usd, error_detail)
        VALUES (${runId}::uuid, ${p.provider}, ${result.capability}, ${result.model}, ${result.status},
                ${result.costUsd}, ${result.errorDetail})`);
      written++;
    }
  }
  return { runId, written };
}

async function main(): Promise<void> {
  const url =
    process.env.DATABASE_URL_JOBS ??
    process.env.MIGRATION_DATABASE_URL ??
    'postgres://spillway:spillway@localhost:5432/spillway_dev';
  const { db, close } = makeDb(url, 2);
  const { runId, written } = await runSmoke(db);
  console.log(`certifier-smoke: run ${runId} wrote ${written} results`);
  await close();
}

if (process.argv[1]?.includes('certifier-smoke')) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
