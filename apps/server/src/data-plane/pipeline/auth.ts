import { createHash } from 'node:crypto';
import { LRUCache } from 'lru-cache';
import { sql } from 'drizzle-orm';
import { SpillwayError, internalBus } from '@spillway/shared';
import type { DatabaseClient } from '../../db/client.js';
import { withOrg } from '../../db/tenancy.js';
import {
  compileAlias,
  compileRules,
  type CompiledAlias,
  type CompiledRule,
} from '../routing/compile.js';
import { buildConfigSnapshot, type SnapshotBundle } from '../policy/config-snapshot.js';
import type { ConditionEvaluator } from '../policy/condition-evaluator.js';
import type { CompiledPolicy } from '../policy/guardrail-types.js';
import type { PipelineContext } from './context.js';

export interface ProviderKeyRow {
  id: string;
  provider: string;
  baseUrl: string | null;
  status: string;
  keyCiphertext: Buffer;
  keyIv: Buffer;
  keyTag: Buffer;
  encVersion: number;
}

/** A governance_policies row in the bundle (raw; CEL is compiled in B4). */
export interface GovernancePolicyRow {
  id: string;
  name: string;
  effect: string; // deny | require_approval | flag
  reason: string;
  match: unknown;
  conditionCel: string | null;
  enforcement: string; // shadow | enforce
  enabled: boolean;
}

/** A budgets row in the bundle (limit is a numeric string — bigint µUSD math at use site). */
export interface BudgetRow {
  id: string;
  scopeType: string;
  scopeId: string;
  period: string;
  limitUsd: string;
  mode: string; // enforce | alert | monitor
  onExceed: string; // block | fallback
  fallbackAlias: string | null;
  createdAt: string; // rolling_30d anchor (17 §1.7)
}

/** Cached per-key policy — v2 (M3): now carries the compiled routing config, guardrail policies,
 *  budgets, and the config-snapshot hash, all loaded in ONE withOrg round-trip at cache-fill. */
export interface PolicyBundle {
  virtualKeyId: string;
  orgId: string;
  teamId: string | null;
  keyStatus: 'active' | 'paused' | 'revoked';
  allowedProviders: string[] | null;
  allowedModels: string[] | null;
  complianceClass: string; // Part III residency (part-3/02): effective key/org compliance class

  maxInputTokens: number | null;
  maxOutputTokens: number | null;
  rpmLimit: number | null;
  tpmLimit: number | null;
  maxParallel: number;
  expiresAt: Date | null;
  keyTags: string[]; // vk.metadata keys → CEL identity.key_tags (16 §4.1)
  providerKeys: ProviderKeyRow[]; // encrypted blobs; decryption deferred to DISPATCH
  aliases: CompiledAlias[]; // compiled at fill (never on the hot path)
  routingRules: CompiledRule[]; // enabled only, pre-sorted by priority
  governancePolicies: GovernancePolicyRow[]; // enabled only; raw (drives the config-snapshot hash)
  compiledPolicies: CompiledPolicy[]; // enabled only, CEL compiled at fill (16 §3.1) — evaluateGuardrails input
  budgets: BudgetRow[];
  configSnapshotHash: string; // ADR-041 §7.4 — stamped on every request row
  cachedAt: number;
}

const TTL_MS = 30_000;
/** key = sha256(rawKey) hex. 30s TTL caps cross-process staleness on a single node (ADR-016). */
export const policyCache = new LRUCache<string, PolicyBundle>({ max: 10_000, ttl: TTL_MS });

// Monotonic invalidation epoch (red-team B8): a cache-fill captures the epoch before its first read
// and only stores if the epoch is unchanged after load — so a mutation that lands DURING a slow
// loadBundle can't be lost to a set-after-sweep race (which would degrade freshness to the 30s TTL).
export const invalidation = { epoch: 0 };

// Precise eviction on control-plane mutations (emits wired in Phase E; harmless until then).
internalBus.on('virtual-key:mutated', ({ virtualKeyId }: { virtualKeyId: string }) => {
  invalidation.epoch += 1;
  for (const [hex, b] of policyCache.entries())
    if (b.virtualKeyId === virtualKeyId) policyCache.delete(hex);
});
const orgTimers = new Map<string, ReturnType<typeof setTimeout>>();
internalBus.on('org:mutated', ({ orgId }: { orgId: string }) => {
  invalidation.epoch += 1; // bump immediately (before the debounced sweep) so a concurrent fill sees it
  if (orgTimers.has(orgId)) return; // debounce org-wide sweeps
  orgTimers.set(
    orgId,
    setTimeout(() => {
      orgTimers.delete(orgId);
      for (const [hex, b] of policyCache.entries()) if (b.orgId === orgId) policyCache.delete(hex);
    }, 100),
  );
});

function extractRawKey(req: PipelineContext['req']): string | null {
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    const tok = auth.slice('Bearer '.length).trim();
    if (tok.startsWith('mk-')) return tok;
  }
  const xk = req.headers['x-api-key'];
  if (typeof xk === 'string') {
    const tok = xk.trim(); // trim like the Bearer path — the same key must auth either way
    if (tok.startsWith('mk-')) return tok;
  }
  return null;
}

const hashKey = (raw: string): Buffer => createHash('sha256').update(raw, 'utf8').digest();

/**
 * Bundle load (v2). Query 1 reads virtual_keys by key_hash with NO org GUC (org unknown yet)
 * — it runs in a tx that arms `app.lookup_key_hash` so the 0008 bootstrap policy exposes ONLY
 * this one row (never a table-scan). Then ONE withOrg tx reads provider_keys + the four config
 * tables (aliases/rules/policies/budgets), compiles the routing config (authoring-time, never on
 * the hot path), computes the content-addressed config-snapshot hash, and upserts the snapshot
 * row. orgs has no RLS. Returns null when the key hash matches nothing.
 */
/** postgres-js returns jsonb columns as STRINGS through drizzle's raw `tx.execute` — so
 *  match.models / targets / action would be undefined (a char-spread of the string), silently making
 *  every guardrail + routing rule match as a WILDCARD. Coerce to the parsed value at the row boundary
 *  (B4 red-team of the wiring). Objects pass through untouched. */
export function asJson<T = unknown>(v: unknown): T {
  // STRICT on purpose (expanded-audit M4): a malformed stored jsonb throws → loadBundle throws →
  // runAuth 503s (fail-closed). We deliberately do NOT swallow to `{}`, because an empty match object
  // is a WILDCARD in structuredMatch — silently turning a scoped deny into deny-everything (or a
  // scoped guardrail into a match-all) is worse than a 503 on a corrupt config. A valid jsonb string
  // is parsed to its object (never char-spread); objects pass through untouched.
  return (typeof v === 'string' ? JSON.parse(v) : v) as T;
}

/** Compile the raw governance rows into evaluateGuardrails input (16 §3.1). CEL is compiled here at
 *  cache-fill (not the hot path); a malformed stored condition → structural match only (CRUD validates
 *  at authoring, so this is a defensive fail-safe, not the normal path). */
function compilePolicies(
  rows: GovernancePolicyRow[],
  evaluator: ConditionEvaluator,
): CompiledPolicy[] {
  return rows.map((p) => {
    let condition: CompiledPolicy['condition'] = null;
    if (p.conditionCel) {
      try {
        condition = evaluator.compile(p.conditionCel);
      } catch {
        condition = null;
      }
    }
    return {
      id: p.id,
      name: p.name,
      effect: p.effect as CompiledPolicy['effect'],
      reason: p.reason,
      enforcement: p.enforcement as CompiledPolicy['enforcement'],
      match: (p.match as CompiledPolicy['match']) ?? {},
      condition,
      effectConfig: {},
    };
  });
}

export async function loadBundle(
  keyHash: Buffer,
  db: DatabaseClient,
  evaluator: ConditionEvaluator,
): Promise<PolicyBundle | null> {
  const hashHex = keyHash.toString('hex');
  const vk = await db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.lookup_key_hash', ${hashHex}, true)`);
    const rows = await tx.execute(sql`
      SELECT vk.id, vk.org_id, vk.team_id, vk.status AS key_status,
             vk.allowed_providers, vk.allowed_models, vk.compliance_class,
             vk.max_input_tokens, vk.max_output_tokens,
             vk.rpm_limit, vk.tpm_limit, vk.max_parallel, vk.expires_at, vk.metadata
      FROM virtual_keys vk
      WHERE vk.key_hash = ${keyHash}
      LIMIT 1`);
    return rows[0] as Record<string, unknown> | undefined;
  });
  if (!vk) return null;

  const orgId = vk.org_id as string;
  const loaded = await withOrg(db, orgId, async (tx) => {
    // Part III residency: the org's default compliance class (a key with NULL compliance_class inherits
    // it). Effective class drives the fail-closed residency routing gate (part-3/02).
    const orgRow = (await tx.execute(sql`
      SELECT default_compliance_class FROM orgs WHERE id = ${orgId} LIMIT 1`)) as unknown as {
      default_compliance_class: string;
    }[];
    const pks = await tx.execute(sql`
      SELECT id, provider, base_url AS "baseUrl", status,
             key_ciphertext AS "keyCiphertext", key_iv AS "keyIv",
             key_tag AS "keyTag", enc_version AS "encVersion"
      FROM provider_keys WHERE org_id = ${orgId} AND status = 'active'`);
    // jsonb columns (targets/match/action) are coerced via asJson — see the helper (raw execute
    // hands them back as strings; an un-coerced match silently becomes a wildcard).
    const aliasRows = (
      (await tx.execute(sql`
      SELECT alias, targets FROM model_aliases WHERE org_id = ${orgId}`)) as unknown as Array<{
        alias: string;
        targets: unknown;
      }>
    ).map((a) => ({ alias: a.alias, targets: asJson(a.targets) }));
    const ruleRows = (
      (await tx.execute(sql`
      SELECT id, priority, match, action, enabled FROM routing_rules
      WHERE org_id = ${orgId} ORDER BY priority`)) as unknown as Array<{
        id: string;
        priority: number;
        match: unknown;
        action: unknown;
        enabled: boolean;
      }>
    ).map((r) => ({ ...r, match: asJson(r.match), action: asJson(r.action) }));
    const policyRows = (
      (await tx.execute(sql`
      SELECT id, name, effect, reason, match, condition_cel AS "conditionCel", enforcement, enabled
      FROM governance_policies WHERE org_id = ${orgId} AND enabled = true`)) as unknown as GovernancePolicyRow[]
    ).map((p) => ({ ...p, match: asJson(p.match) }));
    const budgetRows = (await tx.execute(sql`
      SELECT id, scope_type AS "scopeType", scope_id AS "scopeId", period,
             limit_usd AS "limitUsd", mode, on_exceed AS "onExceed", fallback_alias AS "fallbackAlias",
             created_at AS "createdAt"
      FROM budgets WHERE org_id = ${orgId}`)) as unknown as BudgetRow[];

    // Compile routing config once (authoring-time). Enabled rules only for the runtime chain.
    const aliases = aliasRows.map((a) =>
      compileAlias({ alias: a.alias, targets: a.targets } as Parameters<typeof compileAlias>[0]),
    );
    const routingRules = compileRules(
      ruleRows
        .filter((r) => r.enabled)
        .map((r) => ({
          id: r.id,
          priority: r.priority,
          match: r.match,
          action: r.action,
        })) as Parameters<typeof compileRules>[0],
    );

    // Config snapshot — hashed over ALL rules (incl. enabled flag) + policies + budget MODES (§7.2).
    const snapshotInput: SnapshotBundle = {
      aliases: aliasRows.map((a) => ({ alias: a.alias, targets: a.targets })),
      routingRules: ruleRows.map((r) => ({
        priority: r.priority,
        match: r.match,
        action: r.action,
        enabled: r.enabled,
      })),
      governancePolicies: policyRows.map((p) => ({
        id: p.id,
        name: p.name,
        effect: p.effect,
        reason: p.reason,
        match: p.match,
        condition: p.conditionCel ? { source: p.conditionCel } : null,
        enforcement: p.enforcement,
        enabled: p.enabled,
      })),
      budgets: budgetRows.map((b) => ({
        scope_type: b.scopeType,
        scope_id: b.scopeId,
        period: b.period,
        mode: b.mode,
        on_exceed: b.onExceed,
      })),
    };
    const snapshot = buildConfigSnapshot(orgId, snapshotInput);
    await tx.execute(sql`
      INSERT INTO routing_config_snapshots (hash, org_id, config)
      VALUES (${snapshot.hash}, ${orgId}, ${JSON.stringify(snapshot.config)}::jsonb)
      ON CONFLICT (org_id, hash) DO UPDATE SET created_at = now()`); // last-use → retention age floor (red-team)

    return {
      pks,
      aliases,
      routingRules,
      policyRows,
      budgetRows,
      configSnapshotHash: snapshot.hash,
      defaultComplianceClass: orgRow[0]?.default_compliance_class ?? 'none',
    };
  });

  return {
    virtualKeyId: vk.id as string,
    orgId,
    teamId: (vk.team_id as string | null) ?? null,
    keyStatus: vk.key_status as PolicyBundle['keyStatus'],
    allowedProviders: (vk.allowed_providers as string[] | null) ?? null,
    allowedModels: (vk.allowed_models as string[] | null) ?? null,
    // Effective residency class: the key's own, else the org default (part-3/02 fail-closed gate input).
    complianceClass:
      (vk.compliance_class as string | null) ?? loaded.defaultComplianceClass ?? 'none',
    maxInputTokens: (vk.max_input_tokens as number | null) ?? null,
    maxOutputTokens: (vk.max_output_tokens as number | null) ?? null,
    rpmLimit: (vk.rpm_limit as number | null) ?? null,
    tpmLimit: (vk.tpm_limit as number | null) ?? null,
    maxParallel: (vk.max_parallel as number | null) ?? 32,
    expiresAt: vk.expires_at ? new Date(vk.expires_at as string) : null,
    keyTags: Object.keys(asJson<Record<string, unknown>>(vk.metadata) ?? {}), // → CEL identity.key_tags
    providerKeys: loaded.pks as unknown as ProviderKeyRow[],
    aliases: loaded.aliases,
    routingRules: loaded.routingRules,
    governancePolicies: loaded.policyRows,
    compiledPolicies: compilePolicies(loaded.policyRows, evaluator),
    budgets: loaded.budgetRows,
    configSnapshotHash: loaded.configSnapshotHash,
    cachedAt: Date.now(),
  };
}

export async function runAuth(ctx: PipelineContext): Promise<void> {
  const raw = extractRawKey(ctx.req);
  if (!raw) throw new SpillwayError('key_not_found', 'missing API key', { httpStatus: 401 });

  const keyHash = hashKey(raw);
  const cacheKey = keyHash.toString('hex');

  let bundle = policyCache.get(cacheKey);
  if (!bundle) {
    const epoch = invalidation.epoch; // capture BEFORE the first read (B8 set-after-sweep guard)
    try {
      bundle = (await loadBundle(keyHash, ctx.deps.db, ctx.deps.conditionEvaluator)) ?? undefined;
    } catch (dbErr) {
      ctx.req.log.error({ err: dbErr }, 'policy load failed');
      // Fail CLOSED but distinguishable: a DB outage is 503, NOT a 401 (don't tell an
      // attacker their key is invalid when we simply couldn't check it).
      throw new SpillwayError('service_unavailable', 'policy load failed', { httpStatus: 503 });
    }
    if (!bundle) throw new SpillwayError('key_not_found', 'invalid API key', { httpStatus: 401 });
    // Only cache if no invalidation landed during the load — else this fill could re-introduce a
    // stale bundle a concurrent mutation just swept (would degrade freshness to the 30s TTL).
    if (invalidation.epoch === epoch) policyCache.set(cacheKey, bundle);
  }

  // 401 conflation (04 §2.1, oracle resistance): not-found / revoked / expired all return
  // the SAME 401 so an attacker can't distinguish "no such key" from "key was revoked".
  if (bundle.keyStatus === 'revoked')
    throw new SpillwayError('key_not_found', 'invalid API key', { httpStatus: 401 });
  if (bundle.expiresAt && bundle.expiresAt < new Date())
    throw new SpillwayError('key_not_found', 'invalid API key', { httpStatus: 401 });
  if (bundle.keyStatus === 'paused')
    throw new SpillwayError('key_paused', 'API key is paused', { httpStatus: 403 });
  // Fail CLOSED on any status the branches above didn't recognize (out-of-band DB edit, a partial
  // migration, or a new lifecycle state like 'suspended') — an unknown status must never be treated
  // as usable and keep authorizing billable requests (expanded-audit L3). Conflated 401 (oracle).
  if (bundle.keyStatus !== 'active')
    throw new SpillwayError('key_not_found', 'invalid API key', { httpStatus: 401 });

  ctx.policy = bundle;
}
