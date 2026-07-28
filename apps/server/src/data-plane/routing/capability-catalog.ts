import { isNotNull } from 'drizzle-orm';
import type { DatabaseClient } from '../../db/client.js';
import { modelPrices } from '../../db/schema.js';

/**
 * Runtime read of the §5.1 model-capability catalog: `provider:model → capability[]` for every row
 * whose capabilities column is populated. Drives resolve.ts's `filterCapabilities` — only loaded at
 * ROUTE when a request actually sets `require_capabilities` (the common no-filter path never queries
 * this). model_prices is a GLOBAL reference table, so this runs outside any org-scoped tx (like
 * getModelPrice). Rows with NULL capabilities are excluded (unknown ⇒ not advertised).
 */
export async function loadCapabilityCatalog(
  db: DatabaseClient,
): Promise<ReadonlyMap<string, readonly string[]>> {
  const rows = await db
    .select({
      provider: modelPrices.provider,
      model: modelPrices.model,
      capabilities: modelPrices.capabilities,
    })
    .from(modelPrices)
    .where(isNotNull(modelPrices.capabilities));

  const catalog = new Map<string, readonly string[]>();
  for (const r of rows) {
    if (r.capabilities && r.capabilities.length > 0) {
      catalog.set(`${r.provider}:${r.model}`, r.capabilities);
    }
  }
  return catalog;
}
