import { sql } from 'drizzle-orm';
import {
  pgTable,
  text,
  uuid,
  boolean,
  integer,
  smallint,
  bigint,
  jsonb,
  numeric,
  timestamp,
  primaryKey,
  unique,
  uniqueIndex,
  index,
  check,
  customType,
} from 'drizzle-orm/pg-core';

/**
 * Authoritative Drizzle schema (03-data-model §1–§2 + §7 — the M1 scope).
 * Conventions: uuid PKs via gen_random_uuid(); timestamptz everywhere; snake_case
 * columns; every tenant-scoped table carries `org_id` (+ an RLS policy, applied in
 * a hand-authored migration). Money (numeric(14,6)) lands with §3 tables in M3.
 *
 * Re-platform (ADR-022/023): `users.id` is a WorkOS user-id STRING, not a uuid
 * (supersedes 03 §1's "= Supabase auth.users.id"); every FK to it is `text`.
 * `audit_log` carries the ADR-024 denormalized actor columns + field_diff.
 */

// drizzle-orm/pg-core has no native bytea/inet — declare them.
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
});
const inet = customType<{ data: string }>({
  dataType() {
    return 'inet';
  },
});

const tstz = (name: string) => timestamp(name, { withTimezone: true });

// ── §1 Identity & tenancy ──────────────────────────────────────────────────
export const users = pgTable('users', {
  id: text('id').primaryKey(), // WorkOS user id (user_…), NOT uuid (ADR-023)
  email: text('email').notNull().unique(),
  name: text('name'),
  avatarUrl: text('avatar_url'),
  createdAt: tstz('created_at').notNull().defaultNow(),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
});

export const orgs = pgTable('orgs', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(), // lowercase [a-z0-9-]
  plan: text('plan').notNull().default('free'), // free|pro|governance|enterprise
  // Part III residency default (part-3/02) — a virtual_key with NULL compliance_class inherits this.
  defaultComplianceClass: text('default_compliance_class').notNull().default('none'), // none|us_only|eu_only|fedramp|hipaa
  bodyLoggingEnabled: boolean('body_logging_enabled').notNull().default(false), // ADR-013
  bodyRetentionDays: integer('body_retention_days').notNull().default(30),
  metadataRetentionDays: integer('metadata_retention_days').notNull().default(90),
  createdAt: tstz('created_at').notNull().defaultNow(),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
});

export const orgMembers = pgTable(
  'org_members',
  {
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').notNull(), // owner|admin|member|viewer (≥1 owner invariant, app-enforced)
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.userId] })],
);

export const teams = pgTable(
  'teams',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    createdAt: tstz('created_at').notNull().defaultNow(),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  (t) => [unique('teams_org_slug_uq').on(t.orgId, t.slug)],
);

// ── §2 Keys ────────────────────────────────────────────────────────────────
export const providerKeys = pgTable('provider_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id')
    .notNull()
    .references(() => orgs.id, { onDelete: 'cascade' }),
  provider: text('provider').notNull(), // openai|anthropic|gemini|openai_compat
  label: text('label').notNull(),
  baseUrl: text('base_url'), // REQUIRED for openai_compat; SSRF-validated (10-security §4)
  keyPrefix: text('key_prefix').notNull(),
  keyCiphertext: bytea('key_ciphertext').notNull(), // AES-256-GCM (ADR-014)
  keyIv: bytea('key_iv').notNull(),
  keyTag: bytea('key_tag').notNull(),
  encVersion: smallint('enc_version').notNull().default(1),
  status: text('status').notNull().default('active'), // active|disabled
  createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: tstz('created_at').notNull().defaultNow(),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
});

export const virtualKeys = pgTable('virtual_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id')
    .notNull()
    .references(() => orgs.id, { onDelete: 'cascade' }),
  teamId: uuid('team_id').references(() => teams.id, { onDelete: 'set null' }),
  name: text('name').notNull(),
  keyHash: bytea('key_hash').notNull().unique(), // sha256(plaintext) (ADR-006)
  keyPrefix: text('key_prefix').notNull(), // "mk-live-…" first 12 chars
  status: text('status').notNull().default('active'), // active|paused|revoked
  allowedProviders: text('allowed_providers').array(), // NULL = all org providers
  allowedModels: text('allowed_models').array(), // NULL = all
  // Part III residency (part-3/02): the enforcement INPUT for the model_registry.residency_class gate.
  // NULL = inherit the org default; the routing gate is fail-CLOSED (none/unknown → global models only).
  complianceClass: text('compliance_class'), // none|us_only|eu_only|fedramp|hipaa
  rpmLimit: integer('rpm_limit'),
  tpmLimit: integer('tpm_limit'),
  maxParallel: integer('max_parallel').notNull().default(32),
  maxInputTokens: integer('max_input_tokens'),
  maxOutputTokens: integer('max_output_tokens'),
  bodyLoggingOverride: boolean('body_logging_override'), // NULL = inherit org
  expiresAt: tstz('expires_at'),
  lastUsedAt: tstz('last_used_at'),
  metadata: jsonb('metadata').notNull().default({}), // ≤20 entries (API-enforced)
  createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: tstz('created_at').notNull().defaultNow(),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
});

export const adminApiKeys = pgTable('admin_api_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id')
    .notNull()
    .references(() => orgs.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  keyHash: bytea('key_hash').notNull().unique(),
  keyPrefix: text('key_prefix').notNull(),
  role: text('role').notNull().default('admin'),
  status: text('status').notNull().default('active'),
  createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: tstz('created_at').notNull().defaultNow(),
  lastUsedAt: tstz('last_used_at'),
});

// ── §7 Audit & ops ─────────────────────────────────────────────────────────
export const auditLog = pgTable(
  'audit_log',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    orgId: uuid('org_id').notNull(),
    actorType: text('actor_type').notNull(), // user|admin_api_key|system
    actorId: text('actor_id'), // WorkOS user id or admin-key id (text)
    actorName: text('actor_name'), // ADR-024 denormalized (survives entity deletion)
    actorEmail: text('actor_email'),
    actorRole: text('actor_role'),
    action: text('action').notNull(), // 'virtual_key.create', 'budget.update', …
    target: jsonb('target').notNull(), // {"type":"virtual_key","id":"…"}
    meta: jsonb('meta').notNull().default({}), // PII/secret-sanitized
    fieldDiff: jsonb('field_diff'), // ADR-024 before/after on UPDATE events
    ip: inet('ip'),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('audit_org_created_idx').on(t.orgId, t.createdAt),
    index('audit_org_action_idx').on(t.orgId, t.action),
  ],
);

export const jobRuns = pgTable('job_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  job: text('job').notNull(),
  startedAt: tstz('started_at').notNull().defaultNow(),
  finishedAt: tstz('finished_at'),
  ok: boolean('ok'),
  detail: jsonb('detail'),
});

// ── §5 Traffic facts (M2) ──────────────────────────────────────────────────
// High-volume facts table: org_id has NO FK (write-path perf, like audit_log);
// RLS still isolates by org_id. virtual_key_id NULL only on blocked-at-auth rows.
export const requests = pgTable(
  'requests',
  {
    id: uuid('id').primaryKey().defaultRandom(), // returned as x-spillway-request-id
    orgId: uuid('org_id').notNull(),
    virtualKeyId: uuid('virtual_key_id'),
    teamId: uuid('team_id'),
    provider: text('provider'),
    model: text('model'), // what actually served it
    requestedModel: text('requested_model'), // alias or id the client asked for
    endpoint: text('endpoint').notNull(), // chat_completions | messages
    status: text('status').notNull(), // ok | error | blocked | rate_limited
    blockReason: text('block_reason'), // budget_exceeded | rule_deny | model_not_allowed | rate_limited | key_paused | approval_required (M3, 16 §3.4)
    blockScopeType: text('block_scope_type'),
    blockScopeId: uuid('block_scope_id'),
    blockPeriod: text('block_period'),
    errorCode: text('error_code'),
    httpStatus: integer('http_status'),
    stream: boolean('stream').notNull().default(false),
    inputTokens: integer('input_tokens'), // non-cached, non-write — full-rate billed
    outputTokens: integer('output_tokens'),
    cachedReadTokens: integer('cached_read_tokens'),
    cacheWriteTokens: integer('cache_write_tokens'),
    reasoningTokens: integer('reasoning_tokens'),
    usageEstimated: boolean('usage_estimated').notNull().default(false), // ADR-008
    costUsd: numeric('cost_usd', { precision: 14, scale: 6 }), // NULL when price unknown (ADR-010)
    unitPrices: jsonb('unit_prices'), // snapshot {in,out,cache_read,cache_write_5m,…} per 1M
    // Part III (part-3/04): the price_catalog_versions row whose rates priced this request — lets an
    // invoice dispute re-derive cost from the immutable snapshot, not the mutable live table. NULL=legacy.
    catalogVersionId: uuid('catalog_version_id'),
    latencyMs: integer('latency_ms'),
    ttftMs: integer('ttft_ms'),
    fallbackFrom: jsonb('fallback_from'), // [{provider,model,error}] when chain advanced
    routingRuleId: uuid('routing_rule_id'),
    // Part II (M3) additions — populated in B1 (bundle fill) / B3 (reconcile); nullable until then.
    configSnapshotHash: text('config_snapshot_hash'), // ADR-041 §7.4 — config that served this row
    requestFeatures: jsonb('request_features'), // ADR-043 §6 — compact structural features (shadow/train)
    metadata: jsonb('metadata').notNull().default({}),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('requests_org_created_idx').on(t.orgId, t.createdAt),
    index('requests_org_vk_created_idx').on(t.orgId, t.virtualKeyId, t.createdAt),
    index('requests_org_team_created_idx').on(t.orgId, t.teamId, t.createdAt),
    index('requests_org_model_created_idx').on(t.orgId, t.model, t.createdAt),
  ],
);

// Opt-in body capture (ADR-013); retention-sweeper deletes past expires_at.
export const requestBodies = pgTable('request_bodies', {
  requestId: uuid('request_id')
    .primaryKey()
    .references(() => requests.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id').notNull(),
  prompt: jsonb('prompt').notNull(),
  response: jsonb('response'),
  expiresAt: tstz('expires_at').notNull(),
});

// ── §3 Spend enforcement ledger (M2; ADR-007) ──────────────────────────────
// org_id is NOT in the PK (scope ids are globally unique) — it exists for RLS +
// reporting. All writes are INSERT … ON CONFLICT (scope_type,scope_id,period_key) DO UPDATE.
export const spendCounters = pgTable(
  'spend_counters',
  {
    orgId: uuid('org_id').notNull(),
    scopeType: text('scope_type').notNull(), // org | team | virtual_key
    scopeId: uuid('scope_id').notNull(),
    periodKey: text('period_key').notNull(), // '2026-06' | '2026-06-10' (UTC)
    spentUsd: numeric('spent_usd', { precision: 14, scale: 6 }).notNull().default('0'),
    // In-flight budget HOLD (ADR — expanded-audit H2). Reserved by BUDGET before dispatch, released at
    // reconcile. Separate from spent_usd so the money invariant (spent == SUM(attempts)) is untouched.
    reservedUsd: numeric('reserved_usd', { precision: 14, scale: 6 }).notNull().default('0'),
    requestCount: bigint('request_count', { mode: 'number' }).notNull().default(0),
    blockedCount: bigint('blocked_count', { mode: 'number' }).notNull().default(0),
    // Reserved (ADR-036.4): NULL = all traffic. NOT in the PK yet — cost-source-subset budgets
    // (v-next) extend the PK to include it as NULLS NOT DISTINCT so NULL rows keep working.
    costSourceFilter: text('cost_source_filter'),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.scopeType, t.scopeId, t.periodKey] })],
);

// ── §4 Routing (M2) ────────────────────────────────────────────────────────
export const modelAliases = pgTable(
  'model_aliases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    alias: text('alias').notNull(), // 'spillway/cheap'
    targets: jsonb('targets').notNull(), // ordered [{provider,model}, …] 1–10 (API-bounded)
    createdAt: tstz('created_at').notNull().defaultNow(),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  (t) => [unique('model_aliases_org_alias_uq').on(t.orgId, t.alias)],
);

// NOTE (Phase E): bible specifies UNIQUE(org_id, priority) DEFERRABLE INITIALLY
// DEFERRED so the reorder endpoint can swap priorities in one tx. drizzle-kit
// won't emit DEFERRABLE — the routing-step hand migration drops + re-adds it deferrable.
export const routingRules = pgTable(
  'routing_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    priority: integer('priority').notNull(), // ascending; first match wins
    description: text('description'),
    match: jsonb('match').notNull(), // AND of present fields
    action: jsonb('action').notNull(), // rewrite_model | deny | set_fallbacks
    enabled: boolean('enabled').notNull().default(true),
    createdAt: tstz('created_at').notNull().defaultNow(),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  (t) => [unique('routing_rules_org_priority_uq').on(t.orgId, t.priority)],
);

// ── §6 Pricing (M2; GLOBAL reference data — no org_id, no RLS) ──────────────
const priceColumns = {
  inputUsdPerM: numeric('input_usd_per_m', { precision: 12, scale: 6 }),
  outputUsdPerM: numeric('output_usd_per_m', { precision: 12, scale: 6 }),
  cacheReadUsdPerM: numeric('cache_read_usd_per_m', { precision: 12, scale: 6 }),
  cacheWrite5mUsdPerM: numeric('cache_write_5m_usd_per_m', { precision: 12, scale: 6 }),
  cacheWrite1hUsdPerM: numeric('cache_write_1h_usd_per_m', { precision: 12, scale: 6 }),
  inputUsdPerMLong: numeric('input_usd_per_m_long', { precision: 12, scale: 6 }), // Gemini >200K tier
  longContextThreshold: integer('long_context_threshold'), // e.g. 200000; NULL = no tier
  // M3 §20 pricing depth (ADR-043): NULL = flat/legacy. tiers = ordered multi-threshold rates;
  // service_tier_multipliers = decimal-string multiplier per service tier (standard/priority/flex/batch).
  tiers: jsonb('tiers'),
  serviceTierMultipliers: jsonb('service_tier_multipliers'),
  // Part III multi-modal pricing (part-3/04). All nullable — NULL = the dimension is not priced (a
  // populated usage dimension with a NULL price fails closed at runPricing, never $0). Audio bills
  // per-1M-tokens; images per-UNIT; tools per session; web-search per query (dict by context size);
  // regional_multipliers scales ALL lines (unlike service tier, which is input+output only).
  outputCostPerReasoningUsdPerM: numeric('output_cost_per_reasoning_usd_per_m', {
    precision: 12,
    scale: 6,
  }),
  inputCostPerAudioUsdPerM: numeric('input_cost_per_audio_usd_per_m', { precision: 12, scale: 6 }),
  outputCostPerAudioUsdPerM: numeric('output_cost_per_audio_usd_per_m', {
    precision: 12,
    scale: 6,
  }),
  inputCostPerImageUsdPerUnit: numeric('input_cost_per_image_usd_per_unit', {
    precision: 12,
    scale: 6,
  }),
  outputCostPerImageUsdPerUnit: numeric('output_cost_per_image_usd_per_unit', {
    precision: 12,
    scale: 6,
  }),
  toolCostPerSessionUsd: numeric('tool_cost_per_session_usd', { precision: 12, scale: 6 }),
  webSearchCostPerQueryUsd: jsonb('web_search_cost_per_query_usd'), // {low,medium,high} USD/query
  regionalMultipliers: jsonb('regional_multipliers'), // { region_code: multiplier }
};

export const modelPrices = pgTable(
  'model_prices',
  {
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    ...priceColumns,
    contextWindow: integer('context_window'),
    maxOutputTokens: integer('max_output_tokens'),
    // §5.1 capability catalog: capability tokens this model advertises (tools/response_format/
    // json_schema/seed/reasoning/vision/stream). NULL = unknown (excluded from the loaded catalog).
    capabilities: text('capabilities').array(),
    source: text('source').notNull(), // litellm | override
    syncedAt: tstz('synced_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.provider, t.model] })],
);

export const priceOverrides = pgTable(
  'price_overrides',
  {
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    ...priceColumns,
    note: text('note'),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.provider, t.model] })],
);

// ── Part III model certification (part-3/06) — nightly smoke results. Global (no org_id, no RLS). ──
export const certifierResults = pgTable(
  'certifier_results',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id').notNull(),
    provider: text('provider').notNull(),
    capability: text('capability').notNull(),
    model: text('model').notNull(),
    status: text('status').notNull(), // PASS|FAIL|SKIPPED_BUDGET|SKIPPED_TRANSIENT
    durationMs: integer('duration_ms'),
    costUsd: numeric('cost_usd', { precision: 12, scale: 6 }),
    errorDetail: text('error_detail'),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('certifier_results_lookup_idx').on(t.provider, t.capability, t.createdAt.desc()),
    check(
      'certifier_results_status_chk',
      sql`${t.status} IN ('PASS','FAIL','SKIPPED_BUDGET','SKIPPED_TRANSIENT')`,
    ),
  ],
);

// ── Part III pricing reproducibility ledger (part-3/04) — append-only, immutable. Global (no RLS). ──
export const priceCatalogVersions = pgTable(
  'price_catalog_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceName: text('source_name').notNull(), // 'litellm_vendored' | 'manual'
    sourceUrl: text('source_url'),
    sourceCommitSha: text('source_commit_sha'),
    syncedAt: tstz('synced_at').notNull().defaultNow(),
    effectiveFrom: tstz('effective_from').notNull().defaultNow(),
    approvalState: text('approval_state').notNull().default('auto_approved'),
    approvedBy: text('approved_by').references(() => users.id, { onDelete: 'set null' }),
    notes: text('notes'),
  },
  (t) => [
    index('price_catalog_versions_synced_at_idx').on(t.syncedAt.desc()),
    check(
      'price_catalog_versions_approval_chk',
      sql`${t.approvalState} IN ('auto_approved','pending_review','approved','rejected')`,
    ),
  ],
);

export const priceCatalogSnapshots = pgTable(
  'price_catalog_snapshots',
  {
    catalogVersionId: uuid('catalog_version_id')
      .notNull()
      .references(() => priceCatalogVersions.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    ...priceColumns, // identical rate set to model_prices (incl. the multi-modal columns)
  },
  (t) => [primaryKey({ columns: [t.catalogVersionId, t.provider, t.model] })],
);

// ── Part III model registry (part-3/02) — data-driven identity/capability/lifecycle/residency. ──────
// GLOBAL reference tables (no org_id, no RLS — like model_prices). Per the synthesis-memo Conflict-1
// resolution, the registry owns "what exists + what it can do"; PRICING stays on the live model_prices
// table (model_pricing_profiles is intentionally NOT built). Adding/retiring a model is a migration —
// no deploy. The runtime capability source of truth (Overlap-3): DB registry when a row exists, else the
// adapter's in-code catalog (the seed/fallback).
export const modelRegistry = pgTable(
  'model_registry',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    canonicalId: text('canonical_id').notNull().unique(), // 'openai/gpt-4o' — the public-facing id
    providerModelId: text('provider_model_id').notNull(), // 'gpt-4o' — sent upstream; joins model_prices.model
    provider: text('provider').notNull(),
    deploymentVariant: text('deployment_variant'), // 'thinking' | 'nitro' | null
    region: text('region').notNull().default('global'),
    lifecycle: text('lifecycle').notNull().default('experimental'), // experimental|beta|production|disabled
    contextWindow: integer('context_window'),
    maxOutputTokens: integer('max_output_tokens'),
    // Capability matrix — NULL = unknown, false = confirmed absent. Production rows must be fully filled.
    capStreaming: boolean('cap_streaming'),
    capTools: boolean('cap_tools'),
    capStructuredOutput: boolean('cap_structured_output'), // pinned name (FEATURE_CAP_COLUMN, memo §2.1)
    capVision: boolean('cap_vision'),
    capAudioInput: boolean('cap_audio_input'),
    capAudioOutput: boolean('cap_audio_output'),
    capEmbeddings: boolean('cap_embeddings'),
    capBatch: boolean('cap_batch'),
    capReasoning: boolean('cap_reasoning'),
    capPromptCache: boolean('cap_prompt_cache'),
    routingEligible: boolean('routing_eligible').notNull().default(false),
    fallbackEligible: boolean('fallback_eligible').notNull().default(false),
    // Residency: routing MUST NOT serve a model whose residency_class is incompatible with the key's
    // compliance_class (fail-CLOSED — a NULL/unknown compliance accepts ONLY residency_class='global').
    residencyClass: text('residency_class').notNull().default('global'),
    deprecationDate: text('deprecation_date'),
    source: text('source').notNull().default('manual'), // litellm|openrouter_sync|manual (manual never synced over)
    syncedAt: tstz('synced_at'),
    createdAt: tstz('created_at').notNull().defaultNow(),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('model_registry_provider_idx').on(t.provider),
    index('model_registry_routing_idx')
      .on(t.routingEligible)
      .where(sql`${t.routingEligible} = true`),
    check(
      'model_registry_lifecycle_chk',
      sql`${t.lifecycle} IN ('experimental','beta','production','disabled')`,
    ),
    check(
      'model_registry_residency_chk',
      sql`${t.residencyClass} IN ('global','us_only','eu_only','fedramp','hipaa_eligible')`,
    ),
    check('model_registry_source_chk', sql`${t.source} IN ('litellm','openrouter_sync','manual')`),
    check(
      'model_registry_production_caps_chk',
      sql`${t.lifecycle} != 'production' OR (
        ${t.capStreaming} IS NOT NULL AND ${t.capTools} IS NOT NULL AND
        ${t.capStructuredOutput} IS NOT NULL AND ${t.capVision} IS NOT NULL AND
        ${t.capAudioInput} IS NOT NULL AND ${t.capAudioOutput} IS NOT NULL AND
        ${t.capEmbeddings} IS NOT NULL AND ${t.capBatch} IS NOT NULL AND
        ${t.capReasoning} IS NOT NULL AND ${t.capPromptCache} IS NOT NULL AND
        ${t.contextWindow} IS NOT NULL AND ${t.maxOutputTokens} IS NOT NULL
      )`,
    ),
  ],
);

export const modelRegistryParams = pgTable(
  'model_registry_params',
  {
    registryId: uuid('registry_id')
      .notNull()
      .references(() => modelRegistry.id, { onDelete: 'cascade' }),
    paramName: text('param_name').notNull(), // OpenAI-canonical param the model accepts
    translationKey: text('translation_key'), // provider-side name if different; NULL = pass through
    translationValue: jsonb('translation_value'), // static override injected when the param is absent
    dropOnUnsupported: boolean('drop_on_unsupported').notNull().default(true),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.registryId, t.paramName] })],
);

// ── Part II §16 Governance / policy (M3; ADR-034/041) ───────────────────────
// Guardrail layer: deny-only, order-independent, deny-overrides (separate from the
// priority-ordered routing_rules — no `priority` column here by design).
export const governancePolicies = pgTable(
  'governance_policies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    name: text('name').notNull(), // stable handle, addressable in lint/logs
    description: text('description'),
    effect: text('effect').notNull(), // deny | require_approval | flag
    reason: text('reason').notNull(), // caller-facing message on deny/require_approval
    match: jsonb('match').notNull().default({}), // AND of present fields; absent = wildcard
    conditionCel: text('condition_cel'), // CEL source; NULL = structured-match-only
    conditionProgram: bytea('condition_program'), // compiled program (authoring-time output)
    conditionCost: integer('condition_cost'), // static CEL cost estimate
    enforcement: text('enforcement').notNull().default('enforce'), // shadow | enforce
    enabled: boolean('enabled').notNull().default(true),
    effectConfig: jsonb('effect_config').notNull().default({}), // effect-specific params (seam)
    revision: integer('revision').notNull().default(1), // bumped on every UPDATE
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }), // text FK (ADR-023)
    createdAt: tstz('created_at').notNull().defaultNow(),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique('governance_policies_org_name_uq').on(t.orgId, t.name),
    index('governance_policies_org_enabled_idx')
      .on(t.orgId)
      .where(sql`${t.enabled} = true`), // the bundle-load fetch
    check('governance_policies_effect_chk', sql`${t.effect} IN ('deny','require_approval','flag')`),
    check('governance_policies_enforcement_chk', sql`${t.enforcement} IN ('shadow','enforce')`),
    // CEL source and its compiled program are set together or not at all.
    check(
      'governance_policies_condition_pair_chk',
      sql`(${t.conditionCel} IS NULL) = (${t.conditionProgram} IS NULL)`,
    ),
  ],
);

// Per-request policy-evaluation record (§6). NOT the request fact table, NOT the audit log.
// Written only when a policy acted or would have (shadow) — decision_id = requests.id.
export const decisionLogs = pgTable(
  'decision_logs',
  {
    decisionId: uuid('decision_id').primaryKey(), // = requests.id (live) / generated (replay)
    orgId: uuid('org_id').notNull(),
    requestId: uuid('request_id'), // NULL for replay / offline-shadow rows
    createdAt: tstz('created_at').notNull().defaultNow(),
    effect: text('effect').notNull(), // deny|require_approval|flag|rewrite|budget_block|allow_shadow|allow
    enforcement: text('enforcement').notNull(), // enforce | shadow
    wouldHave: boolean('would_have').notNull().default(false), // shadow policy that WOULD have acted
    evaluatedPolicyIds: uuid('evaluated_policy_ids')
      .array()
      .notNull()
      .default(sql`'{}'`),
    matchedPolicyIds: uuid('matched_policy_ids')
      .array()
      .notNull()
      .default(sql`'{}'`),
    decidingPolicyId: uuid('deciding_policy_id'),
    routingRuleId: uuid('routing_rule_id'), // for effect='rewrite' (from ch15)
    reason: text('reason'),
    configSnapshotHash: text('config_snapshot_hash').notNull(), // composite → routing_config_snapshots
    inputSnapshot: jsonb('input_snapshot').notNull(), // masked attribute snapshot (ADR-013)
    celError: boolean('cel_error').notNull().default(false),
  },
  (t) => [
    index('decision_logs_org_created_idx').on(t.orgId, t.createdAt.desc()),
    index('decision_logs_org_deciding_created_idx').on(
      t.orgId,
      t.decidingPolicyId,
      t.createdAt.desc(),
    ),
    index('decision_logs_org_effect_created_idx').on(t.orgId, t.effect, t.createdAt.desc()),
    check(
      'decision_logs_effect_chk',
      sql`${t.effect} IN ('deny','require_approval','flag','rewrite','budget_block','allow_shadow','allow')`,
    ),
    check('decision_logs_enforcement_chk', sql`${t.enforcement} IN ('enforce','shadow')`),
  ],
);

// Content-addressed effective-config snapshot (§7). Immutable; PK is (org_id, hash) — two orgs'
// identical configs hash the same but are two distinct rows (never collide cross-tenant).
export const routingConfigSnapshots = pgTable(
  'routing_config_snapshots',
  {
    hash: text('hash').notNull(), // structural hash — content address WITHIN an org
    orgId: uuid('org_id').notNull(),
    config: jsonb('config').notNull(), // canonicalized effective config (pre-image)
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.orgId, t.hash] }),
    index('routing_config_snapshots_org_created_idx').on(t.orgId, t.createdAt.desc()),
  ],
);

// ── Part II §17 Budgets + attempts ledger (M3; ADR-035/036) ─────────────────
// CREATE fresh (03 §3 base never built) + the ch17 additions. on_exceed default 'block' is the
// MVP hard-block wedge; 'fallback' is per-budget opt-in (data, so freely changeable).
export const budgets = pgTable(
  'budgets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    scopeType: text('scope_type').notNull(), // org|team|virtual_key|provider|customer(reserved)
    scopeId: uuid('scope_id').notNull(),
    period: text('period').notNull(), // day|month|rolling_30d
    limitUsd: numeric('limit_usd', { precision: 14, scale: 6 }).notNull(),
    mode: text('mode').notNull().default('enforce'), // enforce|alert|monitor
    onExceed: text('on_exceed').notNull().default('block'), // block|fallback (MVP default: block)
    fallbackAlias: text('fallback_alias'), // required iff on_exceed='fallback'
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }), // text FK (ADR-023)
    createdAt: tstz('created_at').notNull().defaultNow(),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique('budgets_org_scope_period_uq').on(t.orgId, t.scopeType, t.scopeId, t.period),
    check(
      'budgets_scope_type_ck',
      sql`${t.scopeType} IN ('org','team','virtual_key','provider','customer')`,
    ),
    check('budgets_period_ck', sql`${t.period} IN ('day','month','rolling_30d')`),
    check('budgets_limit_positive_ck', sql`${t.limitUsd} > 0`),
    check('budgets_on_exceed_ck', sql`${t.onExceed} IN ('block','fallback')`),
    check(
      'budgets_fallback_alias_ck',
      sql`(${t.onExceed} = 'fallback') = (${t.fallbackAlias} IS NOT NULL)`,
    ),
  ],
);

// Per-attempt billing ledger (ADR-035): idempotency key = (request_id, attempt_number), written
// ON CONFLICT DO NOTHING in the same tx as the counter bump. request_id is a LOGICAL ref (no FK).
export const requestAttempts = pgTable(
  'request_attempts',
  {
    requestId: uuid('request_id').notNull(),
    attemptNumber: smallint('attempt_number').notNull(), // 0 = primary; +1 per chain advance
    orgId: uuid('org_id').notNull(),
    provider: text('provider'),
    model: text('model'),
    outcome: text('outcome').notNull(), // ok | error | client_closed
    errorCode: text('error_code'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    cachedReadTokens: integer('cached_read_tokens'),
    cacheWriteTokens: integer('cache_write_tokens'),
    reasoningTokens: integer('reasoning_tokens'),
    costUsd: numeric('cost_usd', { precision: 14, scale: 6 }),
    unitPrices: jsonb('unit_prices'),
    usageEstimated: boolean('usage_estimated').notNull().default(false),
    servedUnderBudgetFallback: boolean('served_under_budget_fallback').notNull().default(false),
    elapsedMs: integer('elapsed_ms'),
    ttftMs: integer('ttft_ms'),
    settledAt: tstz('settled_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.requestId, t.attemptNumber] })],
);

// ── Part II §18 Approvals + automation + timers (M3; ADR-039) ───────────────
// approval_requests is the aggregate root; single-step is the degenerate case. CREATE fresh
// (03 §3 base + the five 18 §2.1.1 column adds). All user refs are text (ADR-023).
export const approvalRequests = pgTable(
  'approval_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(), // budget_increase | key_unpause
    requestedBy: text('requested_by'), // NULL ⇔ automation/system-created (text WorkOS id)
    scopeType: text('scope_type').notNull(),
    scopeId: uuid('scope_id').notNull(),
    currentValue: jsonb('current_value').notNull(),
    requestedValue: jsonb('requested_value').notNull(),
    justification: text('justification'),
    status: text('status').notNull().default('pending'), // pending|approved|denied|cancelled
    decidedBy: text('decided_by'),
    decidedAt: tstz('decided_at'),
    decisionComment: text('decision_comment'),
    policyId: uuid('policy_id'), // 18 §2.1.1 adds
    policyVersion: integer('policy_version'),
    currentStepIndex: integer('current_step_index').notNull().default(0),
    amountUsd: numeric('amount_usd', { precision: 14, scale: 6 }),
    expiresAt: tstz('expires_at'),
    originEventId: uuid('origin_event_id'),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('approval_requests_origin_uk')
      .on(t.originEventId)
      .where(sql`${t.originEventId} IS NOT NULL`),
  ],
);

// Versioned approval chain-as-data (frozen at request creation into approval_steps).
export const approvalPolicies = pgTable(
  'approval_policies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    kind: text('kind').notNull(), // budget_increase | key_unpause | '*'
    scopeType: text('scope_type'),
    scopeId: uuid('scope_id'),
    definition: jsonb('definition').notNull(),
    version: integer('version').notNull().default(1),
    enabled: boolean('enabled').notNull().default(true),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: tstz('created_at').notNull().defaultNow(),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique('approval_policies_org_kind_scope_uq').on(t.orgId, t.kind, t.scopeType, t.scopeId),
    uniqueIndex('approval_policies_org_default_uk')
      .on(t.orgId, t.kind)
      .where(sql`${t.scopeType} IS NULL`),
  ],
);

// Per-request materialized steps (frozen — policy edits never mutate pending requests).
export const approvalSteps = pgTable(
  'approval_steps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    approvalId: uuid('approval_id').notNull(),
    stepIndex: integer('step_index').notNull(),
    quorum: text('quorum').notNull(), // 'all' | 'any' | 'N'
    requiredApproverIds: text('required_approver_ids').array().notNull(), // text WorkOS ids
    notifyOnly: boolean('notify_only').notNull().default(false),
    status: text('status').notNull().default('pending'), // pending|satisfied|skipped
    satisfiedAt: tstz('satisfied_at'),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [unique('approval_steps_approval_step_uq').on(t.approvalId, t.stepIndex)],
);

// Append-only vote log (REVOKE UPDATE,DELETE from app in 0014). Self-approval ban per step.
export const approvalDecisions = pgTable(
  'approval_decisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    approvalId: uuid('approval_id').notNull(),
    stepIndex: integer('step_index').notNull(),
    decidedBy: text('decided_by').notNull(), // text WorkOS id
    decision: text('decision').notNull(), // approve | deny
    comment: text('comment'),
    source: text('source').notNull().default('human'), // human | dedup
    decidedAt: tstz('decided_at').notNull().defaultNow(),
  },
  (t) => [
    unique('approval_decisions_approval_step_by_uq').on(t.approvalId, t.stepIndex, t.decidedBy),
  ],
);

// Brex-style time-bounded out-of-office delegation.
export const approverDelegations = pgTable(
  'approver_delegations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    fromUser: text('from_user').notNull(),
    toUser: text('to_user').notNull(),
    startsAt: tstz('starts_at').notNull(),
    endsAt: tstz('ends_at').notNull(),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [
    check('approver_delegations_window_ck', sql`${t.endsAt} > ${t.startsAt}`),
    check('approver_delegations_distinct_ck', sql`${t.fromUser} <> ${t.toUser}`),
  ],
);

// routing_rules pattern mirrored off-hot-path over alert_events. DEFERRABLE priority in 0015.
export const automationRules = pgTable(
  'automation_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    priority: integer('priority').notNull(),
    name: text('name').notNull(),
    triggerType: text('trigger_type').notNull(), // alert_fired|approval_decided|key_created|budget_crossed|schedule_cron
    condition: jsonb('condition').notNull(),
    action: jsonb('action').notNull(),
    state: text('state').notNull().default('notify_only'), // active|notify_only|disabled
    notifyOnlyUntil: tstz('notify_only_until'),
    stopOnMatch: boolean('stop_on_match').notNull().default(true),
    rateCapPerHour: integer('rate_cap_per_hour').notNull().default(10),
    scheduleCron: text('schedule_cron'),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: tstz('created_at').notNull().defaultNow(),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  // NOTE: UNIQUE(org_id,priority) is added DEFERRABLE in 0015 (drizzle-kit can't emit DEFERRABLE).
  (t) => [unique('automation_rules_org_priority_uq').on(t.orgId, t.priority)],
);

// At-least-once idempotent effect inbox. rule_id NULL = no-match sentinel (partial unique).
export const automationRuns = pgTable(
  'automation_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    ruleId: uuid('rule_id'), // NULL = no-match sentinel
    triggerEventId: uuid('trigger_event_id').notNull(),
    status: text('status').notNull(), // applied|skipped|rate_capped|notify_only|failed
    effect: jsonb('effect').notNull().default({}),
    error: text('error'),
    ranAt: tstz('ran_at').notNull().defaultNow(),
  },
  (t) => [
    unique('automation_runs_rule_event_uq').on(t.ruleId, t.triggerEventId),
    uniqueIndex('automation_runs_nomatch_uk')
      .on(t.triggerEventId)
      .where(sql`${t.ruleId} IS NULL`),
  ],
);

// Durable timers (expiry / reminder / escalation / schedule) — never setTimeout.
export const workflowTimers = pgTable(
  'workflow_timers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(), // approval_expiry|approval_reminder|approval_escalation|rule_schedule|automation_suspend
    refId: uuid('ref_id').notNull(),
    fireAt: tstz('fire_at').notNull(),
    payload: jsonb('payload').notNull().default({}),
    firedAt: tstz('fired_at'), // NULL = pending
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [
    unique('workflow_timers_ref_kind_fire_uq').on(t.refId, t.kind, t.fireAt),
    index('workflow_timers_due_idx')
      .on(t.fireAt)
      .where(sql`${t.firedAt} IS NULL`),
  ],
);

// ── Part II §19 Alerts + insights (M3; ADR-040/009) ─────────────────────────
// alerts.kind is a plain-text registry (validated at the API layer, no enum/migration to add a kind).
export const alerts = pgTable('alerts', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id')
    .notNull()
    .references(() => orgs.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  kind: text('kind').notNull(), // budget_threshold|anomaly|error_rate|key_expiry|budget_forecast|… (registry)
  scopeType: text('scope_type'), // NULL scope = org-wide
  scopeId: uuid('scope_id'),
  config: jsonb('config').notNull(),
  channels: jsonb('channels').notNull(), // [{type:slack|email|webhook, …}]
  enabled: boolean('enabled').notNull().default(true),
  createdAt: tstz('created_at').notNull().defaultNow(),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
});

// Exactly-once alert/notification inbox. alert_id is NULL for synthetic (automation/schedule/
// approval-notification) events; NULLS NOT DISTINCT is MANDATORY so ON CONFLICT DO NOTHING fires
// on NULL alert_id (COMPAT N-1 — else duplicate automation effects + notifications on every poll).
export const alertEvents = pgTable(
  'alert_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    alertId: uuid('alert_id'), // NULL for synthetic events; logical ref (no FK — matches lab)
    firedAt: tstz('fired_at').notNull(),
    dedupeKey: text('dedupe_key').notNull(),
    payload: jsonb('payload').notNull(),
    deliveredAt: tstz('delivered_at'),
    deliveryAttempts: integer('delivery_attempts').notNull().default(0),
    lastError: text('last_error'),
    // A short durable lease prevents concurrent pollers from delivering the
    // same alert after SELECT ... FOR UPDATE locks are released.
    deliveryLeaseId: uuid('delivery_lease_id'),
    deliveryLeaseUntil: tstz('delivery_lease_until'),
  },
  (t) => [unique('alert_events_alert_dedupe_uk').on(t.alertId, t.dedupeKey).nullsNotDistinct()],
);

// Offline insights job output (ADR-009); one row per (org, period), upserted ON CONFLICT.
export const savingsInsights = pgTable(
  'savings_insights',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    period: text('period').notNull(), // '2026-06'
    generatedAt: tstz('generated_at'),
    summary: jsonb('summary').notNull(), // money values are numeric STRINGS (precision)
    detail: jsonb('detail').notNull(), // sampled request ids + suggested tier; never bodies
  },
  (t) => [unique('savings_insights_org_period_uq').on(t.orgId, t.period)],
);

/**
 * Tables that have an `org_id` column but are intentionally exempt from the
 * org_isolation RLS policy. Empty at M1 — every org_id table gets RLS. The
 * rls-lint test (db/rls-lint.test.ts) fails CI if an org_id table is neither
 * covered by RLS nor listed here. (users/orgs/job_runs have no org_id → not flagged.)
 */
export const RLS_EXEMPT_TABLES = new Set<string>([]);

/**
 * Org-scoped tables that MUST carry an org_isolation RLS policy (authored across
 * 0002/0006/0010/0012/0014/0017). Single source of truth consumed by BOTH:
 *  - the static rls-lint (db/rls-lint.test.ts): every org_id table is here or exempt; and
 *  - the runtime rls-coverage integration test (db/rls-coverage.integration.test.ts): each of these
 *    is PROVEN at runtime to have relforcerowsecurity + a canonical `app.current_org_id` policy AND
 *    to actually isolate cross-org (insert under org A → invisible to org B). A name in this Set is
 *    NOT evidence a policy was authored — the integration test is (expanded-audit HIGH #1/#2).
 */
export const RLS_COVERED_TABLES = new Set<string>([
  // M1 (0002_rls_policies.sql)
  'org_members',
  'teams',
  'provider_keys',
  'virtual_keys',
  'admin_api_keys',
  'audit_log',
  // M2 (0006_rls_m2.sql). model_prices/price_overrides are global (no org_id) → not listed.
  'requests',
  'request_bodies',
  'spend_counters',
  'model_aliases',
  'routing_rules',
  // M3 Part II §16 governance (0010_rls_governance.sql). decision_logs / routing_config_snapshots
  // additionally carry a _jobs SELECT/DELETE policy (retention sweeper / snapshot GC).
  'governance_policies',
  'decision_logs',
  'routing_config_snapshots',
  // M3 Part II §17 budgets/ledger (0012_rls_budgets_ledger.sql). request_attempts also carries a
  // _jobs SELECT policy (chargeback/reporting). budgets is app-only.
  'budgets',
  'request_attempts',
  // M3 Part II §18 approvals/automation/timers (0014_rls_workflows.sql). approval_decisions is
  // append-only (REVOKE app UPDATE/DELETE); automation_runs _jobs SELECT; workflow_timers _jobs SELECT/UPDATE.
  'approval_requests',
  'approval_policies',
  'approval_steps',
  'approval_decisions',
  'approver_delegations',
  'automation_rules',
  'automation_runs',
  'workflow_timers',
  // M3 Part II §19 alerts/insights (0017_rls_alerts_insights.sql). alert_events + savings_insights
  // carry _jobs INSERT/UPDATE policies (anomaly-scan / delivery / insights jobs). alerts app-only.
  'alerts',
  'alert_events',
  'savings_insights',
]);
