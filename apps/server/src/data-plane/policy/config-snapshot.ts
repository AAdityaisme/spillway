import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { withOrg } from '../../db/tenancy.js';
import type { DatabaseClient } from '../../db/client.js';

/**
 * Content-addressed config snapshots (16 §7, ADR-041). buildConfigSnapshot canonicalizes the
 * org's effective routing+governance config and hashes it, so "what config produced this spend /
 * decision" is answerable per-row forever and identical config re-hashes to the same row.
 *
 * IN the hash (§7.2): aliases + routing_rules + governance_policies + budget MODES (scope_type,
 * scope_id, period, mode, on_exceed). OUT: budget dollar LIMITS + live spend (folding a limit in
 * would mint a new snapshot on every limit edit, defeating dedupe). Order-independent sets are
 * sorted before hashing so a re-fetch in a different order hashes identically.
 *
 * Ported verbatim from the red-teamed lab (policy/config-snapshot.ts); the upsert is re-fit to V2's
 * withOrg + drizzle. Pure functions have no I/O.
 */

export interface SnapshotAlias {
  alias: string;
  targets: unknown;
}
export interface SnapshotRule {
  priority: number;
  match: unknown;
  action: unknown;
  enabled: boolean;
}
export interface SnapshotPolicyEntry {
  id: string;
  name: string;
  effect: string;
  reason: string;
  match: unknown;
  condition?: { source: string } | null;
  enforcement: string;
  enabled: boolean;
}
export interface SnapshotBudget {
  scope_type: string;
  scope_id: string;
  period: string;
  mode: string;
  on_exceed?: string | null;
}
export interface SnapshotBundle {
  aliases: readonly SnapshotAlias[];
  routingRules: readonly SnapshotRule[];
  governancePolicies: readonly SnapshotPolicyEntry[];
  budgets: readonly SnapshotBudget[];
}
export interface ConfigSnapshot {
  hash: string; // 32-hex (128-bit) truncated sha256 of the canonical JSON
  config: Record<string, unknown>; // the canonicalized effective config (the pre-image)
}

/** UTF-16 code-unit order (JS default string comparison). */
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Structural hash over the canonicalized config (§7.2). orgId scopes the row on upsert but is
 *  NOT in the hash — the hash is pure config content (two orgs' identical configs hash the same). */
export function buildConfigSnapshot(orgId: string, bundle: SnapshotBundle): ConfigSnapshot {
  void orgId;
  const config: Record<string, unknown> = {
    aliases: [...bundle.aliases]
      .sort((a, b) => cmp(a.alias, b.alias))
      .map((a) => ({ alias: a.alias, targets: a.targets })),
    routing_rules: [...bundle.routingRules]
      .sort((a, b) => a.priority - b.priority)
      .map((r) => ({ priority: r.priority, match: r.match, action: r.action, enabled: r.enabled })),
    governance_policies: [...bundle.governancePolicies]
      .sort((a, b) => cmp(a.id, b.id)) // order-independent → sort for a stable hash
      .map((p) => ({
        name: p.name,
        effect: p.effect,
        reason: p.reason,
        match: p.match,
        condition_cel: p.condition?.source ?? null,
        enforcement: p.enforcement,
        enabled: p.enabled,
      })),
    budget_modes: [...bundle.budgets]
      .sort(
        (a, b) =>
          cmp(a.scope_type, b.scope_type) || cmp(a.scope_id, b.scope_id) || cmp(a.period, b.period),
      )
      .map((b) => ({
        scope_type: b.scope_type,
        scope_id: b.scope_id,
        period: b.period,
        mode: b.mode,
        on_exceed: b.on_exceed ?? 'block',
      })),
  };
  const json = canonicalJSON(config);
  const hash = createHash('sha256').update(json, 'utf8').digest('hex').slice(0, 32);
  return { hash, config };
}

/** Canonical JSON (§7.3): keys sorted at every level, array order preserved, numbers normalized. */
export function canonicalJSON(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      return canonNumber(value);
    case 'bigint':
      return value.toString();
    case 'object': {
      if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj).sort(cmp);
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJSON(obj[k])}`).join(',')}}`;
    }
    default:
      return 'null';
  }
}

function canonNumber(n: number): string {
  if (!Number.isFinite(n)) throw new RangeError(`non-finite number in config: ${n}`);
  if (Object.is(n, -0)) return '0';
  if (Number.isInteger(n)) return n.toString();
  let s = n.toString();
  if (/e/i.test(s)) s = n.toFixed(20).replace(/0+$/, '').replace(/\.$/, '');
  return s;
}

/** Upsert the snapshot row under the org GUC (§7.4). ON CONFLICT bumps created_at to now() so it
 *  tracks LAST-use, not first-write: the retention snapshot-GC age floor is then a real liveness proxy
 *  (a config filled within the floor window is never reaped out from under an in-flight/live request —
 *  red-team post-B9 retention-gc HIGH). created_at is read only by retention, so repurposing is safe. */
export async function upsertConfigSnapshot(
  db: DatabaseClient,
  orgId: string,
  snapshot: ConfigSnapshot,
): Promise<void> {
  await withOrg(db, orgId, (tx) =>
    tx.execute(
      sql`INSERT INTO routing_config_snapshots (hash, org_id, config)
          VALUES (${snapshot.hash}, ${orgId}, ${JSON.stringify(snapshot.config)}::jsonb)
          ON CONFLICT (org_id, hash) DO UPDATE SET created_at = now()`,
    ),
  );
}
