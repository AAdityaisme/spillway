import { z } from 'zod';
import { providerSchema, safeName } from './control-plane.js';

/**
 * Governance CRUD request contracts (M3 Part II). Inbound-body validation for budgets / aliases /
 * routing rules / guardrail policies / alerts. Money is a positive decimal STRING (≤6dp, never
 * parseFloat). `deny` is intentionally NOT a routing action (migrated to guardrail policies, ADR-034).
 */

const usdAmount = z
  .string()
  .regex(/^\d{1,8}(\.\d{1,6})?$/, 'must be a positive USD amount with ≤6 decimals');

const targetSpec = z.object({
  provider: providerSchema,
  model: z.string().min(1).max(200),
});
/** Flat array OR typed-object chain (15 §2.1). 1..10 targets per variant. */
const typedChain = z.union([
  z.array(targetSpec).min(1).max(10),
  z
    .object({
      default: z.array(targetSpec).min(1).max(10),
      context_window: z.array(targetSpec).min(1).max(10).optional(),
      content_policy: z.array(targetSpec).min(1).max(10).optional(),
    })
    .strict(),
]);

// ── budgets (17 §1) ──
const budgetScopeType = z.enum(['org', 'team', 'virtual_key', 'provider']); // 'customer' reserved
const budgetPeriod = z.enum(['day', 'month', 'rolling_30d']);
const budgetMode = z.enum(['enforce', 'alert', 'monitor']);
const onExceed = z.enum(['block', 'fallback']);

export const createBudgetSchema = z
  .object({
    scopeType: budgetScopeType,
    scopeId: z.string().uuid(),
    period: budgetPeriod,
    limitUsd: usdAmount,
    mode: budgetMode.default('enforce'),
    onExceed: onExceed.default('block'),
    fallbackAlias: z.string().min(1).max(120).nullable().optional(),
  })
  .refine((d) => (d.onExceed === 'fallback') === (d.fallbackAlias != null), {
    message: 'fallback_alias is required iff on_exceed=fallback',
    path: ['fallbackAlias'],
  });

export const updateBudgetSchema = z
  .object({
    limitUsd: usdAmount.optional(),
    mode: budgetMode.optional(),
    onExceed: onExceed.optional(),
    fallbackAlias: z.string().min(1).max(120).nullable().optional(),
  })
  .strict();

// ── model aliases (15 §2.1) ──
export const createAliasSchema = z.object({
  alias: safeName(120),
  targets: typedChain,
});
export const updateAliasSchema = z.object({ targets: typedChain }).strict();

// ── routing rules (15 §4.7) — deny is NOT a routing action (ADR-034) ──
const ruleMatch = z
  .object({
    // L50: cap count at 200 AND bound each string — without per-string limits a rule author can
    // store 200 × multi-MB strings that get persisted to jsonb and reloaded into every dispatch's
    // policy-cache bundle, inflating per-instance memory and hot-path match latency.
    virtual_key_ids: z.array(z.string().min(1).max(256)).max(200).optional(),
    team_ids: z.array(z.string().min(1).max(256)).max(200).optional(),
    models: z.array(z.string().min(1).max(128)).max(200).optional(),
    metadata: z
      .array(z.record(z.string().max(1024)))
      .max(50)
      .optional(),
  })
  .strict();
const ruleAction = z.discriminatedUnion('type', [
  z.object({ type: z.literal('rewrite_model'), to: targetSpec, fallbacks: typedChain.optional() }),
  z.object({ type: z.literal('set_fallbacks'), chain: typedChain }),
]);
export const createRoutingRuleSchema = z.object({
  priority: z.number().int(),
  description: z.string().max(500).optional(),
  match: ruleMatch,
  action: ruleAction,
  enabled: z.boolean().default(true),
});
export const updateRoutingRuleSchema = z
  .object({
    priority: z.number().int().optional(),
    description: z.string().max(500).optional(),
    match: ruleMatch.optional(),
    action: ruleAction.optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

// ── guardrail policies (16 §2) ──
const guardrailEffect = z.enum(['deny', 'require_approval', 'flag']);
const enforcement = z.enum(['shadow', 'enforce']);
const matchSpec = ruleMatch.extend({
  providers: z.array(z.string()).max(20).optional(),
  endpoints: z.array(z.string()).max(20).optional(),
});
export const createPolicySchema = z.object({
  name: safeName(120),
  description: z.string().max(500).optional(),
  effect: guardrailEffect,
  reason: z.string().min(1).max(500),
  match: matchSpec.default({}),
  conditionCel: z.string().max(2000).nullable().optional(), // compiled + bounds-checked at the handler
  enforcement: enforcement.default('enforce'),
  enabled: z.boolean().default(true),
  effectConfig: z.record(z.unknown()).default({}),
});
export const updatePolicySchema = z
  .object({
    name: safeName(120).optional(),
    description: z.string().max(500).optional(),
    effect: guardrailEffect.optional(),
    reason: z.string().min(1).max(500).optional(),
    match: matchSpec.optional(),
    conditionCel: z.string().max(2000).nullable().optional(),
    enforcement: enforcement.optional(),
    enabled: z.boolean().optional(),
    effectConfig: z.record(z.unknown()).optional(),
  })
  .strict();

// ── alerts (19 §5) — kind validated against the ALERT_KINDS registry at the handler ──
export const createAlertSchema = z.object({
  name: safeName(120),
  kind: z.string().min(1).max(60),
  scopeType: z.string().max(30).nullable().optional(),
  scopeId: z.string().uuid().nullable().optional(),
  config: z.record(z.unknown()).default({}),
  channels: z.array(z.record(z.unknown())).max(20).default([]),
});
export const updateAlertSchema = z
  .object({
    name: safeName(120).optional(),
    config: z.record(z.unknown()).optional(),
    channels: z.array(z.record(z.unknown())).max(20).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

// ── automation rules (18 §3.2) — condition threshold-isolation enforced at the handler ──
const RULE_TRIGGERS = [
  'alert_fired',
  'approval_decided',
  'key_created',
  'budget_crossed',
  'schedule_cron',
] as const;

// schedule_cron currently accepts ONLY `@every <n>[smh]` — the sole format the timer engine
// (apps/server/.../automation/timers.ts defaultNextCronFire) parses. Reject anything else at creation
// (fail-loud 400) instead of storing a scheduled rule whose first-fire timer is never armed and which
// therefore silently NEVER runs (red-team round4 F3). A full cron parser is a deliberate V2 seam.
const scheduleCronField = z
  .string()
  .max(120)
  .regex(
    /^\s*@every\s+\d+[smh]\s*$/,
    "schedule_cron supports only '@every <n>[smh]' (e.g. '@every 15m'); standard cron is not yet supported",
  )
  .nullable()
  .optional();

export const createAutomationRuleSchema = z.object({
  name: safeName(120),
  priority: z.number().int().min(0).max(100_000),
  triggerType: z.enum(RULE_TRIGGERS),
  condition: z.record(z.unknown()).default({}),
  action: z.record(z.unknown()),
  state: z.enum(['active', 'notify_only', 'disabled']).default('notify_only'),
  stopOnMatch: z.boolean().default(true),
  rateCapPerHour: z.number().int().min(1).max(100_000).default(10),
  scheduleCron: scheduleCronField,
  notifyOnlyUntil: z.string().datetime().nullable().optional(),
});
export const updateAutomationRuleSchema = z
  .object({
    name: safeName(120).optional(),
    priority: z.number().int().min(0).max(100_000).optional(),
    condition: z.record(z.unknown()).optional(),
    action: z.record(z.unknown()).optional(),
    state: z.enum(['active', 'notify_only', 'disabled']).optional(),
    stopOnMatch: z.boolean().optional(),
    rateCapPerHour: z.number().int().min(1).max(100_000).optional(),
    scheduleCron: scheduleCronField,
    notifyOnlyUntil: z.string().datetime().nullable().optional(),
  })
  .strict();

// ── approval policies (18 §2.1) — definition = amount tiers + chains ──
const stepDef = z.object({
  approvers: z.object({
    roles: z.array(z.string()).optional(),
    user_ids: z.array(z.string()).optional(),
  }),
  quorum: z.union([z.literal('all'), z.literal('any'), z.number().int().min(1)]),
  notify_only: z.boolean().optional(),
});
const policyDefinition = z.object({
  tiers: z
    .array(
      z.object({
        min_amount_usd: z.string().regex(/^\d+(\.\d{1,6})?$/),
        auto_approve: z.boolean().optional(),
        steps: z.array(stepDef).optional(),
      }),
    )
    .min(1),
  expiry_hours: z.number().int().positive().optional(),
});
export const createApprovalPolicySchema = z.object({
  name: safeName(120),
  kind: z.string().min(1).max(60),
  scopeType: z.string().max(30).nullable().optional(),
  scopeId: z.string().uuid().nullable().optional(),
  definition: policyDefinition,
  enabled: z.boolean().default(true),
});
export const updateApprovalPolicySchema = z
  .object({
    name: safeName(120).optional(),
    definition: policyDefinition.optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

// ── approver delegations (18 §2.5) ──
export const createDelegationSchema = z
  .object({
    fromUser: z.string().min(1).max(120),
    toUser: z.string().min(1).max(120),
    startsAt: z.string().datetime(),
    endsAt: z.string().datetime(),
  })
  .refine((d) => new Date(d.startsAt) < new Date(d.endsAt), {
    message: 'startsAt must be before endsAt',
    path: ['endsAt'],
  });
