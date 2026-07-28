import type { FastifyPluginAsync } from 'fastify';
import { buildPipelineContext, type DataPlaneDeps } from '../pipeline/context.js';
import { runAuth } from '../pipeline/auth.js';
import { modelPrices } from '../../db/schema.js';
import type { ProviderName } from '../routing/compile.js';

/**
 * GET /v1/models (04-api-contracts §2.3, 08-routing step 11) — the merged model catalog available to
 * this virtual key's org, in OpenAI list-models shape with Spillway extensions. Requires only AUTH
 * (no request body). The list is filtered to what the key can actually use (`allowed_providers` /
 * `allowed_models`); a model whose provider has no active provider key is still listed with
 * `available: false` so the dashboard can prompt "add a provider key to use."
 *
 * Ordering: aliases first (by name), then concrete models grouped by provider
 * (openai → anthropic → gemini → openai_compat), sorted by model name within each group.
 */

const OWNED_BY: Record<ProviderName, string> = {
  openai: 'openai',
  anthropic: 'anthropic',
  gemini: 'google',
  openai_compat: 'custom',
};
const PROVIDER_ORDER: ProviderName[] = ['openai', 'anthropic', 'gemini', 'openai_compat'];
const KNOWN_PROVIDERS = new Set<string>(PROVIDER_ORDER);

interface ModelEntry {
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
  spillway: {
    provider: string;
    context_window: number | null;
    max_output_tokens: number | null;
    is_alias: boolean;
    alias_targets: Array<{ provider: string; model: string }> | null;
    available: boolean;
  };
}

export const modelsRoute: FastifyPluginAsync<{ deps: DataPlaneDeps }> = async (
  fastify,
  { deps },
) => {
  fastify.get('/models', async (req, reply) => {
    const ctx = buildPipelineContext(req, reply, deps);
    await runAuth(ctx); // 401/403 on missing/paused/revoked key — same as the dispatch endpoints
    const policy = ctx.policy;

    const allowedProviders = policy.allowedProviders; // null = all
    const allowedModels = policy.allowedModels; // null = all (matches alias names OR concrete ids)
    const providerAllowed = (p: string): boolean =>
      allowedProviders === null || allowedProviders.includes(p);
    const modelAllowed = (id: string): boolean =>
      allowedModels === null || allowedModels.includes(id);
    const activeProviders = new Set(
      policy.providerKeys.filter((k) => k.status === 'active').map((k) => k.provider),
    );
    const now = Math.floor(Date.now() / 1000);

    // 1. aliases (from the compiled policy bundle) — sorted by name.
    const aliasEntries: ModelEntry[] = [];
    for (const a of [...policy.aliases].sort((x, y) => x.alias.localeCompare(y.alias))) {
      if (!modelAllowed(a.alias)) continue;
      const targets = a.targets.default.map((t) => ({ provider: t.provider, model: t.model }));
      const available = targets.some(
        (t) => providerAllowed(t.provider) && activeProviders.has(t.provider),
      );
      aliasEntries.push({
        id: a.alias,
        object: 'model',
        created: now,
        owned_by: 'spillway',
        spillway: {
          provider: 'alias',
          context_window: null,
          max_output_tokens: null,
          is_alias: true,
          alias_targets: targets,
          available,
        },
      });
    }

    // 2. concrete priced models (global model_prices reference table; no org scope) — grouped by
    //    provider order, sorted by model name within each group.
    const priceRows = await deps.db
      .select({
        provider: modelPrices.provider,
        model: modelPrices.model,
        contextWindow: modelPrices.contextWindow,
        maxOutputTokens: modelPrices.maxOutputTokens,
        syncedAt: modelPrices.syncedAt,
      })
      .from(modelPrices);

    const byProvider = new Map<ProviderName, ModelEntry[]>();
    for (const row of priceRows) {
      if (!KNOWN_PROVIDERS.has(row.provider)) continue;
      const provider = row.provider as ProviderName;
      if (!providerAllowed(provider) || !modelAllowed(row.model)) continue;
      const list = byProvider.get(provider) ?? [];
      list.push({
        id: row.model,
        object: 'model',
        created: row.syncedAt ? Math.floor(new Date(row.syncedAt).getTime() / 1000) : now,
        owned_by: OWNED_BY[provider],
        spillway: {
          provider,
          context_window: row.contextWindow,
          max_output_tokens: row.maxOutputTokens,
          is_alias: false,
          alias_targets: null,
          available: activeProviders.has(provider),
        },
      });
      byProvider.set(provider, list);
    }

    const concrete: ModelEntry[] = [];
    for (const provider of PROVIDER_ORDER) {
      const list = byProvider.get(provider);
      if (list) concrete.push(...list.sort((x, y) => x.id.localeCompare(y.id)));
    }

    reply
      .header('x-spillway-request-id', ctx.requestId)
      .send({ object: 'list', data: [...aliasEntries, ...concrete] });
  });
};
